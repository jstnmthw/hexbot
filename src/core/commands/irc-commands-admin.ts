// HexBot — IRC admin commands
// Registers .say, .join, .part, .invite, .status with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { isValidCommandTarget, parseTargetMessage } from '../../utils/parse-args';
import { sanitize } from '../../utils/sanitize';
import { stripFormatting } from '../../utils/strip-formatting';
import { tryAudit } from '../audit';
import { validateChannel } from '../command-helpers';
import type { ReconnectState } from '../reconnect-driver';

/**
 * Minimal IRC client interface for admin commands. Kept narrow on purpose —
 * each admin verb uses at most one method, so the surface here doubles as
 * the audit ceiling for what these commands can do to the live IRC client.
 */
export interface AdminIRCClient {
  say(target: string, message: string): void;
  join(channel: string): void;
  part(channel: string, message?: string): void;
  raw(line: string): void;
  connected: boolean;
  user?: { nick: string };
}

/**
 * Stability/observability metrics surfaced via `.status`. Every field
 * is optional because the getter is best-effort — a transient tracker
 * that hasn't been wired yet returns `undefined` rather than erroring,
 * which keeps `.status` usable on a partially-constructed bot (tests,
 * boot path before plugins are loaded).
 */
export interface StabilityMetrics {
  /** NickServ verify timeouts since startup (services provider degradation signal). */
  servicesTimeoutCount?: number;
  /** Pending verify count right now. */
  pendingVerifyCount?: number;
  /** Verify requests rejected because the pending cap was reached. */
  pendingCapRejections?: number;
  /** Number of loaded plugins. */
  loadedPluginCount?: number;
  /** Number of plugins that failed to load at startup. */
  failedPluginCount?: number;
  /** Names of plugins that failed to load — used by the startup banner. */
  failedPluginNames?: string[];
  /**
   * Whether the bot's own NickServ identity has been confirmed for the current
   * session. `undefined` when identify-state tracking is not wired up.
   * Operators rely on this in `.status` to spot a quiet identify failure
   * before granting auto-op flags that depend on services verification.
   */
  botIdentified?: boolean;
}

/** Minimal bot interface for status reporting. */
export interface AdminBotInfo {
  getUptime(): number;
  getChannels(): string[];
  getBindCount(): number;
  getUserCount(): number;
  /** Current reconnect-driver state, or null if the bot hasn't connected yet. */
  getReconnectState(): ReconnectState | null;
  /** Optional stability metrics surfaced via `.status`. */
  getStabilityMetrics?(): StabilityMetrics;
}

export interface IrcAdminCommandsDeps {
  handler: CommandHandler;
  client: AdminIRCClient;
  botInfo: AdminBotInfo;
  db: BotDatabase | null;
}

/**
 * Register IRC admin commands on the given command handler.
 *
 * `db` is used to write `say`/`msg`/`join`/`part`/`invite` audit rows so
 * arbitrary protocol injection through these commands is queryable in
 * `mod_log`. `say` and `msg` write the target in `target` and the message
 * in `metadata.message` so an audit reviewer can see both who did what
 * and what was said — this is the single biggest gap the review surfaced.
 */
export function registerIRCAdminCommands(deps: IrcAdminCommandsDeps): void {
  const { handler, client, botInfo, db } = deps;
  handler.registerCommand(
    'say',
    {
      flags: '+o',
      description: 'Send a message to a channel or user',
      usage: '.say <target> <message>',
      category: 'irc',
    },
    (_args, ctx) => {
      const parsed = parseTargetMessage(_args);
      if (!parsed) {
        ctx.reply('Usage: .say <target> <message>');
        return;
      }
      // `.say` is the channel/nick-shaped variant — `isValidCommandTarget`
      // rejects services-style targets like `NickServ@services.`. Use
      // `.msg` for those (looser target check). See docs/SECURITY.md on
      // hostmask shapes.
      if (!isValidCommandTarget(parsed.target)) {
        ctx.reply('Invalid target.');
        return;
      }
      // sanitize() strips CR/LF/NUL/U+2028/U+2029 — without it a crafted
      // `.say` message could smuggle a second IRC line through the wire.
      client.say(parsed.target, sanitize(parsed.message));
      ctx.reply(`Message sent to ${parsed.target}`);
      // mod_log copy uses stripFormatting so color bytes in the message
      // don't bleed into surrounding rows when an operator runs `.modlog`.
      tryAudit(db, ctx, {
        action: 'say',
        target: parsed.target,
        metadata: { message: stripFormatting(parsed.message) },
      });
    },
  );

  handler.registerCommand(
    'join',
    {
      flags: '+o',
      description: 'Join a channel',
      usage: '.join <#channel>',
      category: 'irc',
    },
    (_args, ctx) => {
      const channel = validateChannel(_args);
      if (!channel) {
        ctx.reply('Usage: .join <#channel>');
        return;
      }
      client.join(channel);
      ctx.reply(`Joining ${channel}`);
      tryAudit(db, ctx, { action: 'join', channel });
    },
  );

  handler.registerCommand(
    'part',
    {
      flags: '+o',
      description: 'Leave a channel',
      usage: '.part <#channel> [message]',
      category: 'irc',
    },
    (_args, ctx) => {
      const parts = _args.trim().split(/\s+/);
      const channel = validateChannel(parts[0] ?? '');
      if (!channel) {
        ctx.reply('Usage: .part <#channel> [message]');
        return;
      }
      const message = parts.slice(1).join(' ') || undefined;
      client.part(channel, message);
      ctx.reply(`Leaving ${channel}`);
      tryAudit(db, ctx, { action: 'part', channel, reason: message ?? null });
    },
  );

  handler.registerCommand(
    'msg',
    {
      flags: '+o',
      description: 'Send a PRIVMSG to any target (user, nick, or service)',
      usage: '.msg <target> <message>',
      category: 'irc',
    },
    (_args, ctx) => {
      const parsed = parseTargetMessage(_args);
      if (!parsed) {
        ctx.reply('Usage: .msg <target> <message>');
        return;
      }
      // .msg accepts any non-whitespace target (channel, nick, service)
      // — services targets like `NickServ@services.` are valid here
      // even though they fail `isValidCommandTarget`'s channel/nick
      // rules. The `\S+` check still rejects empty / whitespace-only
      // targets that would split into an extra wire token.
      if (!/^\S+$/.test(parsed.target)) {
        ctx.reply('Invalid target.');
        return;
      }
      // sanitize() strips CR/LF/NUL — a `\n` in the message would let
      // the caller inject a second IRC command (PRIVMSG-stuffing).
      client.say(parsed.target, sanitize(parsed.message));
      ctx.reply(`Message sent to ${parsed.target}`);
      tryAudit(db, ctx, {
        action: 'msg',
        target: parsed.target,
        metadata: { message: stripFormatting(parsed.message) },
      });
    },
  );

  handler.registerCommand(
    'invite',
    {
      flags: '+o',
      description: 'Invite a user to a channel',
      usage: '.invite <#channel> <nick>',
      category: 'irc',
    },
    (_args, ctx) => {
      // Reject raw args containing control characters (\r, \n) before
      // splitting — we pass `nick` and `channel` into a `raw()` INVITE
      // line, and CRLF in either one would let a caller inject arbitrary
      // IRC commands. See docs/SECURITY.md on raw-line construction.
      if (/[\r\n]/.test(_args)) {
        ctx.reply('Invalid nick.');
        return;
      }
      const parts = _args.trim().split(/\s+/);
      const channel = validateChannel(parts[0] ?? '');
      const nick = parts[1];
      if (!channel || !nick) {
        ctx.reply('Usage: .invite <#channel> <nick>');
        return;
      }
      client.raw(`INVITE ${sanitize(nick)} ${sanitize(channel)}`);
      ctx.reply(`Invited ${nick} to ${channel}`);
      tryAudit(db, ctx, { action: 'invite', channel, target: nick });
    },
  );

  handler.registerCommand(
    'uptime',
    {
      flags: '+o',
      description: 'Show bot uptime',
      usage: '.uptime',
      category: 'irc',
    },
    (_args, ctx) => {
      ctx.reply(`Uptime: ${formatUptimeColored(botInfo.getUptime())}`);
    },
  );

  handler.registerCommand(
    'status',
    {
      flags: '+o',
      description: 'Show bot status',
      usage: '.status',
      category: 'irc',
    },
    (_args, ctx) => {
      const connected = client.connected ? 'connected' : 'disconnected';
      const nick = client.user?.nick ?? 'unknown';
      const uptime = formatUptime(botInfo.getUptime());
      const channels = botInfo.getChannels();
      const binds = botInfo.getBindCount();
      const users = botInfo.getUserCount();
      const reconnectState = botInfo.getReconnectState();

      // `.status` stacks short labeled lines so a reader can scan
      // top-down — keep each line single-purpose and short enough to
      // survive a typical IRC line-length cap when piped via `.bot`.
      const lines = [
        `Status: ${connected} as ${nick}`,
        `Uptime: ${uptime}`,
        `Channels: ${channels.length > 0 ? channels.join(', ') : '(none)'}`,
        `Binds: ${binds} | Users: ${users}`,
      ];
      if (reconnectState) {
        lines.push(`Connection: ${formatReconnectState(reconnectState)}`);
      }
      // Stability metrics — emitted only when the bot has wired a
      // `getStabilityMetrics` provider (tests pass a minimal info
      // object that can omit it). One-line summary so `.status`
      // stays operator-readable across narrow DCC/REPL columns.
      if (botInfo.getStabilityMetrics) {
        const m = botInfo.getStabilityMetrics();
        const parts: string[] = [];
        if (m.servicesTimeoutCount !== undefined) {
          parts.push(`services-timeouts=${m.servicesTimeoutCount}`);
        }
        if (m.pendingVerifyCount !== undefined) {
          parts.push(`pending-verifies=${m.pendingVerifyCount}`);
        }
        if (m.pendingCapRejections !== undefined && m.pendingCapRejections > 0) {
          parts.push(`verify-cap-rejected=${m.pendingCapRejections}`);
        }
        if (m.botIdentified !== undefined) {
          parts.push(`bot-identified=${m.botIdentified ? 'yes' : 'NO'}`);
        }
        if (m.loadedPluginCount !== undefined) {
          parts.push(`plugins=${m.loadedPluginCount}`);
        }
        if (m.failedPluginCount !== undefined && m.failedPluginCount > 0) {
          parts.push(`failed-plugins=${m.failedPluginCount}`);
        }
        if (parts.length > 0) {
          lines.push(`Stability: ${parts.join(' | ')}`);
        }
      }
      ctx.reply(lines.join('\n'));
    },
  );
}

/**
 * Render the reconnect driver state for the `.status` command. Returns
 * a single human-readable line — never more — since `.status` stacks
 * short labeled lines.
 */
export function formatReconnectState(state: ReconnectState): string {
  if (state.status === 'connected') {
    return 'connected';
  }
  if (state.status === 'stopped') {
    return 'stopped';
  }
  // reconnecting or degraded — include tier, failure count, and next retry
  const errorPart = state.lastError ? `${state.lastError}, ` : '';
  const failurePart =
    state.consecutiveFailures > 1 ? `${state.consecutiveFailures} consecutive failures, ` : '';
  const nextPart = state.nextAttemptAt
    ? `next retry in ${formatDelay(state.nextAttemptAt - Date.now())}`
    : 'retry pending';
  return `${state.status} (${errorPart}${failurePart}${nextPart})`;
}

/** Format a millisecond delta as the shortest sensible "5s" / "3m" / "1h" string. */
function formatDelay(ms: number): string {
  if (ms < 0) return '0s';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

/**
 * Render a millisecond duration as `Nd Nh Nm Ns`, collapsing leading zero
 * components. When `colorize` is true, each numeric component is wrapped
 * in bold+red mIRC formatting (\x02\x0304N\x0F) so the digits pop while
 * the unit letters stay plain — used by `.uptime` for a more scannable
 * reply than `.status`, which wants an unstyled value it can paste into
 * a labeled status block.
 */
function formatUptime(ms: number, colorize = false): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const wrap = colorize ? (n: number) => `\x02\x0304${n}\x0F` : (n: number) => String(n);
  const parts: string[] = [];
  if (days > 0) parts.push(`${wrap(days)}d`);
  if (hours > 0) parts.push(`${wrap(hours)}h`);
  if (minutes > 0) parts.push(`${wrap(minutes)}m`);
  parts.push(`${wrap(secs)}s`);
  return parts.join(' ');
}

/**
 * Convenience alias for the colourised `.uptime` reply path. Kept
 * separate from {@link formatUptime} so callers don't need to thread
 * a boolean through their own code; `.status` calls `formatUptime`
 * directly to get the unstyled form.
 */
export function formatUptimeColored(ms: number): string {
  return formatUptime(ms, true);
}
