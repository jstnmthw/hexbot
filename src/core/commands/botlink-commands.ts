// HexBot — Bot link admin commands
// Registers .botlink, .bots, .bottree, .whom, .bot, .bsay, .bannounce with the command handler.
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import type { BotlinkConfig } from '../../types';
import { formatDuration, parseDuration } from '../../utils/duration';
import { sanitize } from '../../utils/sanitize';
import { stripFormatting } from '../../utils/strip-formatting';
import { tryAudit } from '../audit';
import {
  type BotLinkHub,
  type BotLinkLeaf,
  type LinkFrame,
  type PartyLineUser,
  isPrivateOrLoopback,
  isValidIP,
} from '../botlink';
import type { BotlinkDCCView } from '../dcc';

// Commands forbidden from traveling over `.bot` because their positional
// arguments are secrets. These never reach mod_log metadata and are refused
// at the dispatch point so a compromised operator account cannot proxy a
// password-rotation command through the bot link. Comparison is done on
// the lowercased subcommand name so case variants (`.CHPASS`) cannot
// bypass the gate.
//
// `bot` is also refused: `.bot <self> .bot <self> .<cmd>` would otherwise
// recurse without bound and lock the dispatcher under a hostile leaf.
const BOT_RELAY_FORBIDDEN_COMMANDS = new Set(['chpass', 'bot']);

// Subcommands whose args land in mod_log as `[redacted]` even when they are
// allowed to dispatch. Kept separate from the hard-refusal list so future
// secret-bearing admin verbs can be redacted without blocking them outright.
// Currently identical to the forbidden set, but the redaction list is
// consulted on the audit-write path while the forbidden list short-circuits
// the dispatch — keep them as distinct sets so the layered defense stays
// explicit.
const BOT_RELAY_REDACTED_COMMANDS = new Set(['chpass']);

// ---------------------------------------------------------------------------
// Helpers — guard and dispatch between hub/leaf
// ---------------------------------------------------------------------------

/**
 * Type guard that replies and returns false if bot link is not enabled.
 * Use at the top of every command handler so the rest of the body can assume
 * `config` is present.
 */
function requireEnabled(
  ctx: CommandContext,
  config: BotlinkConfig | null,
): config is BotlinkConfig {
  if (!config?.enabled) {
    ctx.reply('Bot link is not enabled.');
    return false;
  }
  return true;
}

/** Reply + return null if not running as hub. */
function requireHub(ctx: CommandContext, hub: BotLinkHub | null): BotLinkHub | null {
  if (!hub) {
    ctx.reply('Only available on hub bots.');
    return null;
  }
  return hub;
}

/** Reply + return null if not running as leaf. */
function requireLeaf(ctx: CommandContext, leaf: BotLinkLeaf | null): BotLinkLeaf | null {
  if (!leaf) {
    ctx.reply('Only available on leaf bots.');
    return null;
  }
  return leaf;
}

type BotLink = { kind: 'hub'; hub: BotLinkHub } | { kind: 'leaf'; leaf: BotLinkLeaf };

/**
 * Return the active bot link (hub or leaf), or null after replying "Not connected".
 * Call from commands that work on either role.
 */
function requireBotLink(
  ctx: CommandContext,
  hub: BotLinkHub | null,
  leaf: BotLinkLeaf | null,
): BotLink | null {
  if (hub) return { kind: 'hub', hub };
  if (leaf) return { kind: 'leaf', leaf };
  ctx.reply('Not connected to any bot link.');
  return null;
}

/**
 * Send a frame through whichever side of the link is active. When `link`
 * is a hub and `targetBot` is given, the frame is unicast to that leaf;
 * a hub call without `targetBot` fans out to every leaf. A leaf always
 * sends to its hub (the second arg is ignored on the leaf path).
 */
function sendFrame(link: BotLink, frame: LinkFrame, targetBot?: string): void {
  if (link.kind === 'hub' && targetBot) {
    link.hub.send(targetBot, frame);
  } else if (link.kind === 'hub') {
    link.hub.broadcast(frame);
  } else {
    link.leaf.send(frame);
  }
}

// ---------------------------------------------------------------------------
// .botlink sub-command handlers
// ---------------------------------------------------------------------------

function handleBotlinkStatus(
  ctx: CommandContext,
  config: BotlinkConfig,
  hub: BotLinkHub | null,
  leaf: BotLinkLeaf | null,
): void {
  if (hub) {
    const leaves = hub.getLeaves();
    ctx.reply(`Bot link: hub (botname: "${config.botname}")`);
    if (leaves.length > 0) {
      const leafInfo = leaves
        .map((name) => {
          const info = hub.getLeafInfo(name);
          if (!info) return `  ${name} (disconnecting)`;
          const ago = Math.floor((Date.now() - info.connectedAt) / 1000);
          return `  ${name} (connected ${ago}s ago)`;
        })
        .join('\n');
      ctx.reply(`Connected leaves (${leaves.length}):\n${leafInfo}`);
    } else {
      ctx.reply('No leaves connected.');
    }
  } else if (leaf) {
    ctx.reply(`Bot link: leaf (botname: "${config.botname}")`);
    if (leaf.isConnected) {
      ctx.reply(`Connected to hub "${leaf.hubName}"`);
    } else {
      ctx.reply('Status: disconnected (reconnecting...)');
    }
  }
}

function handleBotlinkDisconnect(
  ctx: CommandContext,
  hub: BotLinkHub | null,
  botname: string | undefined,
  db: BotDatabase | null,
): void {
  const h = requireHub(ctx, hub);
  if (!h) return;
  if (!botname) {
    ctx.reply('Usage: .botlink disconnect <botname>');
    return;
  }
  if (!h.disconnectLeaf(botname)) {
    ctx.reply(`Leaf "${botname}" not found.`);
    tryAudit(db, ctx, {
      action: 'botlink-disconnect',
      target: botname,
      outcome: 'failure',
      reason: 'leaf not found',
    });
    return;
  }
  ctx.reply(`Disconnected "${botname}".`);
  tryAudit(db, ctx, { action: 'botlink-disconnect', target: botname });
}

function handleBotlinkReconnect(
  ctx: CommandContext,
  leaf: BotLinkLeaf | null,
  db: BotDatabase | null,
): void {
  const l = requireLeaf(ctx, leaf);
  if (!l) return;
  l.reconnect();
  ctx.reply('Reconnecting to hub...');
  tryAudit(db, ctx, { action: 'botlink-reconnect' });
}

function handleBotlinkBans(ctx: CommandContext, hub: BotLinkHub | null): void {
  const h = requireHub(ctx, hub);
  if (!h) return;
  const bans = h.getAuthBans();
  if (bans.length === 0) {
    ctx.reply('No active link bans.');
    return;
  }
  const lines = [`Link bans (${bans.length}):`];
  for (const ban of bans) {
    const type = ban.manual ? 'manual' : 'auto';
    const remaining =
      ban.bannedUntil === 0
        ? 'permanent'
        : `expires in ${formatDuration(ban.bannedUntil - Date.now())}`;
    const esc = ban.banCount > 0 ? ` (escalation: ${ban.banCount})` : '';
    lines.push(`  ${ban.ip.padEnd(20)} ${type.padEnd(7)} ${remaining}${esc}`);
  }
  ctx.reply(lines.join('\n'));
}

function handleBotlinkBan(
  ctx: CommandContext,
  hub: BotLinkHub | null,
  rest: string[],
  db: BotDatabase | null,
): void {
  const h = requireHub(ctx, hub);
  if (!h) return;
  const banIp = rest[0];
  if (!banIp) {
    ctx.reply('Usage: .botlink ban <ip|cidr> [duration] [reason...]');
    return;
  }
  // isValidIP gates the input before it reaches manualBan so a malformed
  // CIDR string never lands in the ban table. See docs/SECURITY.md on
  // input shape validation.
  if (!isValidIP(banIp)) {
    ctx.reply('Invalid IPv4 address or CIDR range.');
    return;
  }
  // 0 = permanent (BotLinkHub.manualBan sentinel).
  let durationMs = 0;
  let reasonParts = rest.slice(1);
  // Optional duration token: only consume rest[1] if parseDuration recognizes
  // the syntax (e.g. `30m`, `7d`). A bare reason word like "abuse" returns
  // null and is left in the reason text instead.
  if (reasonParts.length > 0) {
    const parsed = parseDuration(reasonParts[0]);
    if (parsed !== null) {
      durationMs = parsed;
      reasonParts = reasonParts.slice(1);
    }
  }
  const reason = reasonParts.join(' ') || 'manual ban';
  // Banning a loopback / RFC1918 address is almost always a typo — those
  // ranges are where leaves legitimately connect from. Surface a hint
  // alongside the success reply so operators notice if they meant to ban
  // a public IP. The base address (pre-CIDR) is what isPrivateOrLoopback
  // expects; strip a `/<prefix>` suffix if present.
  const baseAddr = banIp.includes('/') ? banIp.slice(0, banIp.indexOf('/')) : banIp;
  const localScope = isPrivateOrLoopback(baseAddr);
  h.manualBan(banIp, durationMs, reason, ctx.nick);
  const durStr = durationMs === 0 ? 'permanent' : formatDuration(durationMs);
  if (localScope) {
    ctx.reply(
      `Banned ${banIp} (${durStr}): ${reason} — ` +
        'note: this address is in a loopback / RFC1918 range, which is where leaves typically connect from. ' +
        'Use `.botlink unban <ip>` to undo.',
    );
  } else {
    ctx.reply(`Banned ${banIp} (${durStr}): ${reason}`);
  }
  tryAudit(db, ctx, {
    action: 'botlink-ban',
    target: banIp,
    reason,
    metadata: { duration_ms: durationMs },
  });
}

function handleBotlinkUnban(
  ctx: CommandContext,
  hub: BotLinkHub | null,
  unbanIp: string | undefined,
  db: BotDatabase | null,
): void {
  const h = requireHub(ctx, hub);
  if (!h) return;
  if (!unbanIp) {
    ctx.reply('Usage: .botlink unban <ip|cidr>');
    return;
  }
  h.unban(unbanIp, ctx.nick);
  ctx.reply(`Unbanned ${unbanIp}.`);
  tryAudit(db, ctx, { action: 'botlink-unban', target: unbanIp });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface BotlinkCommandsDeps {
  handler: CommandHandler;
  /** Active hub instance, or null if this bot is not running as a hub. */
  hub: BotLinkHub | null;
  /** Active leaf instance, or null if this bot is not running as a leaf. */
  leaf: BotLinkLeaf | null;
  /** Bot link config; null when the feature is disabled. */
  config: BotlinkConfig | null;
  /** Audit DB; nullable so the bot can run without persistence in tests. */
  db: BotDatabase | null;
  /** DCC manager view used by `.relay`/`.whom` — null when DCC is disabled. */
  dccManager?: BotlinkDCCView | null;
  /** Local IRC `say` injector for `.bsay self`/`.bsay *` — null on bots without IRC wired. */
  ircSay?: ((target: string, message: string) => void) | null;
}

/**
 * Register bot-link admin commands.
 * Called regardless of whether botlink is enabled — commands respond
 * appropriately when the feature is disabled.
 */
export function registerBotlinkCommands(deps: BotlinkCommandsDeps): void {
  const { handler, hub, leaf, config, db, dccManager, ircSay } = deps;
  handler.registerCommand(
    'botlink',
    {
      flags: '+m',
      description: 'Bot link status and management',
      usage: '.botlink <status|disconnect|reconnect> [args]',
      category: 'botlink',
    },
    (args, ctx) => {
      if (!requireEnabled(ctx, config)) return;
      const [sub, ...rest] = args.split(/\s+/);

      switch (sub || 'status') {
        case 'status':
          return handleBotlinkStatus(ctx, config, hub, leaf);
        case 'disconnect':
          return handleBotlinkDisconnect(ctx, hub, rest[0], db);
        case 'reconnect':
          return handleBotlinkReconnect(ctx, leaf, db);
        case 'bans':
          return handleBotlinkBans(ctx, hub);
        case 'ban':
          return handleBotlinkBan(ctx, hub, rest, db);
        case 'unban':
          return handleBotlinkUnban(ctx, hub, rest[0], db);
        default:
          ctx.reply('Usage: .botlink <status|disconnect|reconnect|bans|ban|unban>');
      }
    },
  );

  handler.registerCommand(
    'bots',
    {
      flags: '+m',
      description: 'List all linked bots',
      usage: '.bots',
      category: 'botlink',
    },
    (_args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      if (hub) {
        const leaves = hub.getLeaves();
        const lines = [`${config.botname} (hub, this bot)`];
        for (const name of leaves) {
          const info = hub.getLeafInfo(name);
          if (!info) {
            lines.push(`${name} (leaf, disconnecting)`);
            continue;
          }
          const ago = Math.floor((Date.now() - info.connectedAt) / 1000);
          lines.push(`${name} (leaf, connected ${ago}s ago)`);
        }
        ctx.reply(`Linked bots (${lines.length}):\n${lines.join('\n')}`);
      } else if (leaf) {
        if (leaf.isConnected) {
          ctx.reply(`Linked bots (2):\n${leaf.hubName} (hub)\n${config.botname} (leaf, this bot)`);
        } else {
          ctx.reply(`${config.botname} (leaf, disconnected)`);
        }
      }
    },
  );

  handler.registerCommand(
    'bottree',
    {
      flags: '+m',
      description: 'Show botnet topology tree',
      usage: '.bottree',
      category: 'botlink',
    },
    (_args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      if (hub) {
        const leaves = hub.getLeaves();
        const lines = [`${config.botname} (hub)`];
        for (let i = 0; i < leaves.length; i++) {
          const prefix = i === leaves.length - 1 ? '└─ ' : '├─ ';
          lines.push(`${prefix}${leaves[i]} (leaf)`);
        }
        ctx.reply(lines.join('\n'));
      } else if (leaf) {
        if (leaf.isConnected) {
          ctx.reply(`${leaf.hubName} (hub)\n└─ ${config.botname} (leaf, this bot)`);
        } else {
          ctx.reply(`${config.botname} (leaf, disconnected)`);
        }
      }
    },
  );

  handler.registerCommand(
    'relay',
    {
      flags: '+m',
      description: 'Relay DCC session to a remote bot',
      usage: '.relay <botname> | .relay end',
      category: 'botlink',
    },
    (_args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      const targetBot = _args.trim();
      if (!targetBot) {
        ctx.reply('Usage: .relay <botname>');
        return;
      }

      if (ctx.source !== 'dcc') {
        ctx.reply('.relay is only available from DCC sessions.');
        return;
      }

      if (!dccManager) {
        ctx.reply('DCC is not enabled.');
        return;
      }

      const session = dccManager.getSession(ctx.nick);
      if (!session) {
        ctx.reply('Could not find your DCC session.');
        return;
      }

      if (session.isRelaying) {
        ctx.reply('Already relaying. Use .relay end first.');
        return;
      }

      const link = requireBotLink(ctx, hub, leaf);
      if (!link) return;

      // Hub route: verify the target leaf is actually connected before sending.
      if (link.kind === 'hub' && !link.hub.getLeaves().includes(targetBot)) {
        ctx.reply(`Bot "${targetBot}" is not connected.`);
        return;
      }

      const requestFrame: LinkFrame = {
        type: 'RELAY_REQUEST',
        handle: session.handle,
        fromBot: config.botname,
        toBot: targetBot,
      };

      // When the hub itself originates a relay, register it in the routing
      // table so RELAY_OUTPUT/END frames from the leaf are delivered locally.
      if (link.kind === 'hub') {
        if (!link.hub.registerRelay(session.handle, targetBot)) {
          ctx.reply('Hub relay table full — try again later.');
          return;
        }
      }

      sendFrame(link, requestFrame, targetBot);

      // Enter relay mode pending — input is forwarded, but the confirmation
      // message waits for RELAY_ACCEPT. Timeout rolls back on silent drop.
      session.enterRelay(
        targetBot,
        (line: string) => {
          sendFrame(link, { type: 'RELAY_INPUT', handle: session.handle, line }, targetBot);
        },
        {
          // 3s — interactive operator round-trip. Long enough to absorb a
          // typical hub→leaf hop + DCC accept on the remote side, short
          // enough that a silent drop snaps back to the local console
          // before the operator gives up and retypes the command.
          timeoutMs: 3000,
          onTimeout: () => {
            if (link.kind === 'hub') link.hub.unregisterRelay(session.handle);
          },
        },
      );

      ctx.reply(`*** Requesting relay to ${targetBot}...`);
      tryAudit(db, ctx, {
        action: 'relay',
        target: targetBot,
        metadata: { handle: session.handle },
      });
    },
  );

  handler.registerCommand(
    'whom',
    {
      flags: '-',
      description: 'Show all console users across linked bots',
      usage: '.whom',
      category: 'botlink',
    },
    async (_args, ctx) => {
      const myBotname = config?.botname ?? 'unknown';
      const localUsers: PartyLineUser[] = dccManager
        ? dccManager.getSessionList().map((s) => ({
            handle: s.handle,
            nick: s.nick,
            botname: myBotname,
            connectedAt: s.connectedAt,
            idle: 0,
          }))
        : [];

      let allUsers: PartyLineUser[] = [...localUsers];

      if (hub) {
        allUsers = [...allUsers, ...hub.getRemotePartyUsers()];
      } else if (leaf?.isConnected) {
        const remote = await leaf.requestWhom();
        allUsers = [...allUsers, ...remote];
      }

      if (allUsers.length === 0) {
        ctx.reply('No users on the console.');
        return;
      }

      const lines = [`Console (${allUsers.length} user${allUsers.length !== 1 ? 's' : ''}):`];
      for (const u of allUsers) {
        const ago = Math.floor((Date.now() - u.connectedAt) / 1000);
        const idle = u.idle > 0 ? ` (idle ${u.idle}s)` : '';
        lines.push(`  ${u.handle} (${u.nick}) on ${u.botname} — connected ${ago}s ago${idle}`);
      }
      ctx.reply(lines.join('\n'));
    },
  );

  handler.registerCommand(
    'bot',
    {
      flags: '+m',
      description: 'Execute a command on a remote bot',
      usage: '.bot <botname> <command>',
      category: 'botlink',
    },
    async (args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      const parts = args.trim().split(/\s+/);
      const targetBot = parts[0];
      const command = parts.slice(1).join(' ');
      if (!targetBot || !command) {
        ctx.reply('Usage: .bot <botname> <command>');
        return;
      }

      // Strip leading dot if present (user may type `.bot leaf1 .status` or
      // `.bot leaf1 status`). The remote handler re-prepends `.` when it
      // dispatches via `handler.execute`, so a single leading dot would
      // otherwise become `..status` on the leaf.
      const cmdText = command.startsWith('.') ? command.slice(1) : command;
      const [cmdNameRaw, ...cmdArgs] = cmdText.split(/\s+/);
      // Lowercase for set membership: BOT_RELAY_FORBIDDEN_COMMANDS and
      // BOT_RELAY_REDACTED_COMMANDS are stored lower-cased so a caller
      // typing `.bot leaf1 CHPASS ...` cannot bypass either gate.
      const cmdName = cmdNameRaw.toLowerCase();

      if (BOT_RELAY_FORBIDDEN_COMMANDS.has(cmdName)) {
        ctx.reply(`Command "${cmdName}" cannot be relayed via .bot for security reasons.`);
        tryAudit(db, ctx, {
          action: 'bot-remote-denied',
          target: targetBot,
          reason: `.${cmdName}`,
          metadata: { command: cmdName, denied: 'forbidden-relay' },
        });
        return;
      }

      // Audit the remote dispatch on the originating bot — remote command
      // execution across the hub must land in the origin's audit trail
      // before we hand off, so a deny on the leaf side still leaves a
      // record of who tried what. Redact positional args for any command
      // whose arguments carry secrets; mod_log retention is unbounded and
      // we do not trust it as a password store.
      const redactArgs = BOT_RELAY_REDACTED_COMMANDS.has(cmdName);
      tryAudit(db, ctx, {
        action: 'bot-remote',
        target: targetBot,
        reason: redactArgs ? `.${cmdName} [redacted]` : `.${cmdText}`,
        metadata: { command: cmdName, args: redactArgs ? '[redacted]' : cmdArgs.join(' ') },
      });

      // Self-targeted relay short-circuits the wire path and runs the
      // command locally with the original ctx — preserves transport,
      // permissions, and reply routing exactly as if the operator had
      // typed `.<cmdText>` directly.
      if (targetBot === config.botname) {
        await handler.execute(`.${cmdText}`, ctx);
        return;
      }

      const link = requireBotLink(ctx, hub, leaf);
      if (!link) return;

      const handle = ctx.nick;
      let output: string[];

      if (link.kind === 'hub') {
        if (!link.hub.getLeaves().includes(targetBot)) {
          ctx.reply(`Bot "${targetBot}" is not connected.`);
          return;
        }
        output = await link.hub.sendCommandToBot(
          targetBot,
          cmdName,
          cmdArgs.join(' '),
          handle,
          ctx.channel,
        );
      } else {
        if (!link.leaf.isConnected) {
          ctx.reply('Not connected to any bot link.');
          return;
        }
        const captured: string[] = [];
        const relayCtx = { ...ctx, reply: (msg: string) => captured.push(msg) };
        await link.leaf.relayCommand(cmdName, cmdArgs.join(' '), handle, relayCtx, targetBot);
        output = captured;
      }

      for (const line of output) ctx.reply(line);
    },
  );

  handler.registerCommand(
    'bsay',
    {
      flags: '+m',
      description: 'Send a message via another linked bot',
      usage: '.bsay <botname|*> <target> <message>',
      category: 'botlink',
    },
    (_args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      const match = _args.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        ctx.reply('Usage: .bsay <botname|*> <target> <message>');
        return;
      }
      const [, rawBotname, rawTarget, rawMessage] = match;
      // Sanitize once at the top so the local send path and the frame path
      // see identical, control-character-free strings. Before this, the
      // frame path shipped the raw target/message across the link without
      // stripping \r\n\0, letting a compromised +m caller inject CRLF into
      // the receiving bot's IRC output.
      const target = sanitize(rawTarget);
      const message = sanitize(rawMessage);
      const botname = sanitize(rawBotname);
      // mod_log rows are surfaced back into IRC via `.modlog` output, so strip
      // IRC color/format codes from user-controlled strings to keep the audit
      // view readable and prevent formatting bleed into surrounding rows.
      // Matches `.say`/`.msg` which already do the same.
      // `.bsay` is gated by `+m`, so the dispatcher either resolved the
      // caller's handle via findByHostmask (pub/msg transports) or the
      // caller is on a trusted transport (repl/dcc/botlink) that bypasses
      // the hostmask gate. Fall back to `ctx.nick` in the latter case —
      // matches the pattern `.bot` uses. The frame carries the handle
      // across the link so the hub can re-check `+m` on the target
      // channel before fanning out; a compromised leaf could otherwise
      // assemble a raw BSAY and bypass the originating-leaf check. See
      // docs/BOTLINK.md on cross-bot privilege checks.
      const fromHandle = ctx.handle ?? ctx.nick;
      tryAudit(db, ctx, {
        action: 'bsay',
        target,
        metadata: { botname, message: stripFormatting(message) },
      });

      const sendLocal = (): void => {
        if (ircSay) ircSay(target, message);
        else ctx.reply('IRC client not available on this bot.');
      };

      const bsayFrame: LinkFrame = {
        type: 'BSAY',
        target,
        message,
        toBot: botname,
        fromHandle,
      };

      if (botname === config.botname) {
        sendLocal();
        ctx.reply(`Sent to ${target} (local).`);
        return;
      }

      // `*` = fan out to every linked bot. On a hub, that means every
      // connected leaf; on a leaf, the leaf forwards the frame to its
      // hub which then re-fans to its other leaves (the hub-side
      // BSAY handler is responsible for not echoing back to origin).
      if (botname === '*') {
        sendLocal();
        if (hub) {
          for (const leafName of hub.getLeaves()) hub.send(leafName, bsayFrame);
        } else if (leaf?.isConnected) {
          leaf.send(bsayFrame);
        }
        ctx.reply(`Sent to ${target} on all linked bots.`);
        return;
      }

      // Specific remote bot
      const link = requireBotLink(ctx, hub, leaf);
      if (!link) return;
      if (link.kind === 'hub') {
        if (!link.hub.getLeaves().includes(botname)) {
          ctx.reply(`Bot "${botname}" is not connected.`);
          return;
        }
        link.hub.send(botname, bsayFrame);
      } else {
        if (!link.leaf.isConnected) {
          ctx.reply('Not connected to any bot link.');
          return;
        }
        link.leaf.send(bsayFrame);
      }
      ctx.reply(`Sent to ${target} via ${botname}.`);
    },
  );

  handler.registerCommand(
    'bannounce',
    {
      flags: '+m',
      description: 'Broadcast to all console sessions across linked bots',
      usage: '.bannounce <message>',
      category: 'botlink',
    },
    (_args, ctx) => {
      if (!requireEnabled(ctx, config)) return;

      const rawMessage = _args.trim();
      if (!rawMessage) {
        ctx.reply('Usage: .bannounce <message>');
        return;
      }
      // Sanitize for the wire path — the announcement fans out to every
      // linked bot's DCC consoles and those feeds must not carry CR/LF/NUL.
      // Strip IRC formatting for the mod_log copy so `.modlog` output doesn't
      // bleed color/bold into surrounding audit rows.
      const message = sanitize(rawMessage);
      if (!message) {
        ctx.reply('Usage: .bannounce <message>');
        return;
      }
      tryAudit(db, ctx, {
        action: 'bannounce',
        metadata: { message: stripFormatting(rawMessage) },
      });

      // Announce to local DCC sessions
      dccManager?.announce?.(`*** ${message}`);

      // Send ANNOUNCE frame to all linked bots
      const frame: LinkFrame = {
        type: 'ANNOUNCE',
        message: `*** ${message}`,
        fromBot: config.botname,
      };
      if (hub) {
        for (const leafName of hub.getLeaves()) hub.send(leafName, frame);
      } else if (leaf?.isConnected) {
        leaf.send(frame);
      }

      ctx.reply('Announcement sent to all linked bots.');
    },
  );
}
