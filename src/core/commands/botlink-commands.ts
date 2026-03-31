// HexBot — Bot link admin commands
// Registers .botlink, .bots, .bottree, .whom with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotlinkConfig } from '../../types';
import type { BotLinkHub, BotLinkLeaf, PartyLineUser } from '../botlink';
import type { DCCManager } from '../dcc';

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
  dccManager?: DCCManager | null,
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
                  /* v8 ignore next */
                  const ago = info ? Math.floor((Date.now() - info.connectedAt) / 1000) : 0;
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
          if (!hub.getLeaves().includes(botname)) {
            ctx.reply(`Leaf "${botname}" not found.`);
            return;
          }
          hub.send(botname, { type: 'ERROR', code: 'CLOSING', message: 'Disconnected by admin' });
          ctx.reply(`Disconnecting "${botname}".`);
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
          const info = hub.getLeafInfo(name);
          /* v8 ignore next */
          const ago = info ? Math.floor((Date.now() - info.connectedAt) / 1000) : 0;
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

      /* v8 ignore next 4 */
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
      /* v8 ignore next 3 */
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
      const localUsers: PartyLineUser[] = dccManager
        ? dccManager.getSessionList().map((s) => ({
            handle: s.handle,
            nick: s.nick,
            /* v8 ignore start */
            botname: config?.botname ?? 'local',
            /* v8 ignore stop */
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
}
