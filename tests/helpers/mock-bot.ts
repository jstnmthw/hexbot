// n0xb0t — Mock bot helper for testing
// Creates a Bot-like object with real modules but a mock IRC client.

import { EventDispatcher } from '../../src/dispatcher.js';
import { Permissions } from '../../src/core/permissions.js';
import { BotDatabase } from '../../src/database.js';
import { CommandHandler } from '../../src/command-handler.js';
import { BotEventBus } from '../../src/event-bus.js';
import { IRCBridge } from '../../src/irc-bridge.js';
import { ChannelState } from '../../src/core/channel-state.js';
import { IRCCommands } from '../../src/core/irc-commands.js';
import { Services } from '../../src/core/services.js';
import { MockIRCClient } from './mock-irc.js';
import { PluginLoader } from '../../src/plugin-loader.js';

import { registerPermissionCommands } from '../../src/core/commands/permission-commands.js';
import { registerDispatcherCommands } from '../../src/core/commands/dispatcher-commands.js';
import { registerIRCAdminCommands } from '../../src/core/commands/irc-commands-admin.js';
import { registerPluginCommands } from '../../src/core/commands/plugin-commands.js';

import type { BotConfig } from '../../src/types.js';

export interface MockBot {
  client: MockIRCClient;
  db: BotDatabase;
  permissions: Permissions;
  dispatcher: EventDispatcher;
  commandHandler: CommandHandler;
  eventBus: BotEventBus;
  bridge: IRCBridge;
  channelState: ChannelState;
  ircCommands: IRCCommands;
  services: Services;
  pluginLoader: PluginLoader;
  cleanup(): void;
}

/**
 * Create a fully wired mock bot for testing.
 * Uses a real database (in-memory), real dispatcher, real permissions,
 * and a mock IRC client.
 */
export function createMockBot(options?: { botNick?: string }): MockBot {
  const botNick = options?.botNick ?? 'testbot';

  const db = new BotDatabase(':memory:');
  db.open();

  const permissions = new Permissions(db);
  const dispatcher = new EventDispatcher(permissions);
  const commandHandler = new CommandHandler();
  const eventBus = new BotEventBus();
  const client = new MockIRCClient();
  client.user.nick = botNick;

  // Wire up bridge
  const bridge = new IRCBridge({
    client,
    dispatcher,
    eventBus,
    botNick,
  });
  bridge.attach();

  // Wire up core modules
  const channelState = new ChannelState(client, eventBus);
  channelState.attach();

  const ircCommands = new IRCCommands(client, db);

  const botConfig: BotConfig = {
    irc: { host: 'localhost', port: 6667, tls: false, nick: botNick, username: botNick, realname: botNick, channels: ['#test'] },
    owner: { handle: 'admin', hostmask: '*!*@localhost' },
    identity: { method: 'hostmask', require_acc_for: [] },
    services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
    database: ':memory:',
    pluginDir: './plugins',
    logging: { level: 'info', mod_actions: false },
  };

  const services = new Services({
    client,
    servicesConfig: botConfig.services,
    identityConfig: botConfig.identity,
    eventBus,
  });
  services.attach();

  const pluginLoader = new PluginLoader({
    pluginDir: './plugins',
    dispatcher,
    eventBus,
    db,
    permissions,
    botConfig,
    ircClient: client,
    channelState,
    ircCommands,
    services,
  });

  // Register commands
  registerPermissionCommands(commandHandler, permissions);
  registerDispatcherCommands(commandHandler, dispatcher);
  registerIRCAdminCommands(commandHandler, client, {
    getUptime: () => 60_000,
    getChannels: () => ['#test'],
    getBindCount: () => dispatcher.listBinds().length,
    getUserCount: () => permissions.listUsers().length,
  });
  registerPluginCommands(commandHandler, pluginLoader, './plugins');

  return {
    client,
    db,
    permissions,
    dispatcher,
    commandHandler,
    eventBus,
    bridge,
    channelState,
    ircCommands,
    services,
    pluginLoader,
    cleanup() {
      services.detach();
      channelState.detach();
      bridge.detach();
      db.close();
    },
  };
}
