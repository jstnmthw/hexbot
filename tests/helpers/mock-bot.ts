// hexbot — Mock bot helper for testing
// Creates a Bot-like object with real modules but a mock IRC client.
import { CommandHandler } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { ChannelState } from '../../src/core/channel-state';
import { registerChannelCommands } from '../../src/core/commands/channel-commands';
import { registerDispatcherCommands } from '../../src/core/commands/dispatcher-commands';
import { registerIRCAdminCommands } from '../../src/core/commands/irc-commands-admin';
import { registerPermissionCommands } from '../../src/core/commands/permission-commands';
import { registerPluginCommands } from '../../src/core/commands/plugin-commands';
import { IRCCommands } from '../../src/core/irc-commands';
import { Permissions } from '../../src/core/permissions';
import { Services } from '../../src/core/services';
import { BotDatabase } from '../../src/database';
import { EventDispatcher } from '../../src/dispatcher';
import { BotEventBus } from '../../src/event-bus';
import { IRCBridge } from '../../src/irc-bridge';
import { type Logger, createLogger } from '../../src/logger';
import { PluginLoader } from '../../src/plugin-loader';
import type { BotConfig } from '../../src/types';
import { MockIRCClient } from './mock-irc';

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
  channelSettings: ChannelSettings;
  pluginLoader: PluginLoader;
  logger: Logger;
  cleanup(): void;
}

/**
 * Create a silent logger for tests (level set to 'error' to suppress most output).
 * Tests that need to assert on log calls can still use vi.spyOn().
 */
export function createSilentLogger(): Logger {
  return createLogger('error');
}

/**
 * Create a fully wired mock bot for testing.
 * Uses a real database (in-memory), real dispatcher, real permissions,
 * and a mock IRC client.
 */
export function createMockBot(options?: { botNick?: string; currentNick?: string }): MockBot {
  const botNick = options?.botNick ?? 'testbot';
  // currentNick is the bot's active IRC nick (defaults to botNick / config nick).
  // Set it differently from botNick to test nick-recovery scenarios.
  const currentNick = options?.currentNick ?? botNick;
  const logger = createSilentLogger();

  const db = new BotDatabase(':memory:', logger);
  db.open();

  const permissions = new Permissions(db, logger);
  const dispatcher = new EventDispatcher(permissions, logger);
  const commandHandler = new CommandHandler(permissions);
  const eventBus = new BotEventBus();
  const client = new MockIRCClient();
  client.user.nick = currentNick;

  // Wire up core modules (channelState must be created before IRCBridge so it can be passed in)
  const channelState = new ChannelState(client, eventBus, logger);
  channelState.attach();

  // Wire up bridge — pass channelState so kicked-user hostmask lookup works
  const bridge = new IRCBridge({
    client,
    dispatcher,
    botNick: currentNick,
    channelState,
    logger,
  });
  bridge.attach();

  const ircCommands = new IRCCommands(client, db, undefined, logger);

  const botConfig: BotConfig = {
    irc: {
      host: 'localhost',
      port: 6667,
      tls: false,
      nick: botNick,
      username: botNick,
      realname: botNick,
      channels: ['#test'],
    },
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
    eventBus,
    logger,
  });
  services.attach();

  const channelSettings = new ChannelSettings(db);

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
    channelSettings,
    logger,
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
  registerChannelCommands(commandHandler, channelSettings);

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
    channelSettings,
    pluginLoader,
    logger,
    cleanup() {
      services.detach();
      channelState.detach();
      bridge.detach();
      db.close();
    },
  };
}
