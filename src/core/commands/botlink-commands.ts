// HexBot — Bot link admin commands
// Registers .botlink, .bots, .bottree, .whom, .bot, .bsay, .bannounce with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotlinkConfig } from '../../types';
import { sanitize } from '../../utils/sanitize';
import type { BotLinkHub, BotLinkLeaf, PartyLineUser } from '../botlink';
import type { BotlinkDCCView } from '../dcc';

/**
 * Register bot-link admin commands.
 * Called regardless of whether botlink is enabled — commands respond
 * appropriately when the feature is disabled.
 */
export function registerBotlinkCommands(
  handler: CommandHandler,
  hub: BotLinkHub | null,
  leaf: BotLinkLeaf | null,
  config: BotlinkConfig | null,
  dccManager?: BotlinkDCCView | null,
  ircSay?: ((target: string, message: string) => void) | null,
): void {
  handler.registerCommand(
    'botlink',
    {
      flags: '+m',
      description: 'Bot link status and management',
      usage: '.botlink <status|disconnect|reconnect> [args]',
      category: 'botlink',
    },
    (args, ctx) => {
      const [sub, ...rest] = args.split(/\s+/);

      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

      switch (sub || 'status') {
        case 'status': {
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
          break;
        }

        case 'disconnect': {
          if (!hub) {
            ctx.reply('Only available on hub bots.');
            return;
          }
          const botname = rest[0];
          if (!botname) {
            ctx.reply('Usage: .botlink disconnect <botname>');
            return;
          }
          if (!hub.disconnectLeaf(botname)) {
            ctx.reply(`Leaf "${botname}" not found.`);
            return;
          }
          ctx.reply(`Disconnected "${botname}".`);
          break;
        }

        case 'reconnect': {
          if (!leaf) {
            ctx.reply('Only available on leaf bots.');
            return;
          }
          leaf.reconnect();
          ctx.reply('Reconnecting to hub...');
          break;
        }

        default:
          ctx.reply('Usage: .botlink <status|disconnect|reconnect>');
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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

      if (hub) {
        const leaves = hub.getLeaves();
        const lines = [`${config.botname} (hub, this bot)`];
        for (const name of leaves) {
          const info = hub.getLeafInfo(name)!;
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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

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

      // Determine which link to send through
      const link = hub ?? leaf;
      if (!link) {
        ctx.reply('Not connected to any bot link.');
        return;
      }

      const sendFrame = (frame: import('../botlink').LinkFrame) => {
        if (hub) hub.send(targetBot, frame);
        else if (leaf) leaf.send(frame);
      };

      // Send RELAY_REQUEST
      const requestFrame = hub
        ? {
            type: 'RELAY_REQUEST',
            handle: session.handle,
            fromBot: config.botname,
            toBot: targetBot,
          }
        : {
            type: 'RELAY_REQUEST',
            handle: session.handle,
            fromBot: config.botname,
            toBot: targetBot,
          };

      if (hub) {
        // Hub can route directly
        if (!hub.getLeaves().includes(targetBot)) {
          ctx.reply(`Bot "${targetBot}" is not connected.`);
          return;
        }
        hub.send(targetBot, requestFrame);
      } else if (leaf) {
        leaf.send(requestFrame);
      }

      // Enter relay mode — input goes to the remote bot
      session.enterRelay(targetBot, (line: string) => {
        sendFrame({ type: 'RELAY_INPUT', handle: session.handle, line });
      });

      ctx.reply(`*** Relaying to ${targetBot}. Type .relay end to return.`);
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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

      const parts = args.trim().split(/\s+/);
      const targetBot = parts[0];
      const command = parts.slice(1).join(' ');
      if (!targetBot || !command) {
        ctx.reply('Usage: .bot <botname> <command>');
        return;
      }

      // Strip leading dot if present (user may type `.bot leaf1 .status` or `.bot leaf1 status`)
      const cmdText = command.startsWith('.') ? command.slice(1) : command;
      const [cmdName, ...cmdArgs] = cmdText.split(/\s+/);

      // Execute on self — just run the command locally
      if (targetBot === config.botname) {
        await handler.execute(`.${cmdText}`, ctx);
        return;
      }

      const handle = ctx.nick;
      let output: string[];

      if (hub) {
        if (!hub.getLeaves().includes(targetBot)) {
          ctx.reply(`Bot "${targetBot}" is not connected.`);
          return;
        }
        output = await hub.sendCommandToBot(
          targetBot,
          cmdName,
          cmdArgs.join(' '),
          handle,
          ctx.channel,
        );
      } else if (leaf?.isConnected) {
        const captured: string[] = [];
        const relayCtx = { ...ctx, reply: (msg: string) => captured.push(msg) };
        await leaf.relayCommand(cmdName, cmdArgs.join(' '), handle, relayCtx, targetBot);
        output = captured;
      } else {
        ctx.reply('Not connected to any bot link.');
        return;
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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

      const match = _args.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        ctx.reply('Usage: .bsay <botname|*> <target> <message>');
        return;
      }
      const [, botname, target, message] = match;

      const sendLocal = () => {
        if (ircSay) ircSay(sanitize(target), sanitize(message));
        else ctx.reply('IRC client not available on this bot.');
      };

      const bsayFrame = { type: 'BSAY', target, message, toBot: botname };

      if (botname === config.botname) {
        sendLocal();
        ctx.reply(`Sent to ${target} (local).`);
        return;
      }

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
      if (hub) {
        if (!hub.getLeaves().includes(botname)) {
          ctx.reply(`Bot "${botname}" is not connected.`);
          return;
        }
        hub.send(botname, bsayFrame);
      } else if (leaf?.isConnected) {
        leaf.send(bsayFrame);
      } else {
        ctx.reply('Not connected to any bot link.');
        return;
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
      if (!config?.enabled) {
        ctx.reply('Bot link is not enabled.');
        return;
      }

      const message = _args.trim();
      if (!message) {
        ctx.reply('Usage: .bannounce <message>');
        return;
      }

      // Announce to local DCC sessions
      dccManager?.announce?.(`*** ${message}`);

      // Send ANNOUNCE frame to all linked bots
      const frame = { type: 'ANNOUNCE', message: `*** ${message}`, fromBot: config.botname };
      if (hub) {
        for (const leafName of hub.getLeaves()) hub.send(leafName, frame);
      } else if (leaf?.isConnected) {
        leaf.send(frame);
      }

      ctx.reply('Announcement sent to all linked bots.');
    },
  );
}
