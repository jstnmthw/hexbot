// n0xb0t — Bot class
// Thin orchestrator that wires modules together. Creates and connects the
// pieces but delegates all real work to the individual modules.

import { readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { Client as IrcClient } from 'irc-framework';

import { BotDatabase } from './database.js';
import { EventDispatcher } from './dispatcher.js';
import { Permissions } from './core/permissions.js';
import { CommandHandler } from './command-handler.js';
import { BotEventBus } from './event-bus.js';
import { IRCBridge } from './irc-bridge.js';
import { ChannelState } from './core/channel-state.js';
import { IRCCommands } from './core/irc-commands.js';
import { Services } from './core/services.js';

import { PluginLoader } from './plugin-loader.js';

import { registerPermissionCommands } from './core/commands/permission-commands.js';
import { registerDispatcherCommands } from './core/commands/dispatcher-commands.js';
import { registerIRCAdminCommands } from './core/commands/irc-commands-admin.js';
import { registerPluginCommands } from './core/commands/plugin-commands.js';

import type { BotConfig } from './types.js';

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class Bot {
  readonly config: BotConfig;
  readonly db: BotDatabase;
  readonly permissions: Permissions;
  readonly dispatcher: EventDispatcher;
  readonly commandHandler: CommandHandler;
  readonly eventBus: BotEventBus;
  readonly client: InstanceType<typeof IrcClient>;

  readonly pluginLoader: PluginLoader;
  readonly channelState: ChannelState;
  readonly ircCommands: IRCCommands;
  readonly services: Services;

  private bridge: IRCBridge | null = null;
  private startTime: number = Date.now();
  private configuredChannels: string[] = [];

  constructor(configPath?: string) {
    const cfgPath = resolve(configPath ?? './config/bot.json');
    this.config = this.loadConfig(cfgPath);

    this.db = new BotDatabase(this.config.database);
    this.eventBus = new BotEventBus();
    this.permissions = new Permissions(this.db);
    this.dispatcher = new EventDispatcher(this.permissions);
    this.commandHandler = new CommandHandler();
    this.client = new IrcClient();
    this.configuredChannels = [...this.config.irc.channels];
    this.channelState = new ChannelState(this.client, this.eventBus);
    this.ircCommands = new IRCCommands(this.client, this.db);
    this.services = new Services({
      client: this.client,
      servicesConfig: this.config.services,
      identityConfig: this.config.identity,
      eventBus: this.eventBus,
    });
    this.pluginLoader = new PluginLoader({
      pluginDir: this.config.pluginDir,
      dispatcher: this.dispatcher,
      eventBus: this.eventBus,
      db: this.db,
      permissions: this.permissions,
      botConfig: this.config,
      ircClient: this.client,
      channelState: this.channelState,
      ircCommands: this.ircCommands,
      services: this.services,
    });
  }

  /** Start the bot: open DB, load permissions, connect to IRC, wire everything. */
  async start(): Promise<void> {
    // 1. Open database
    this.db.open();
    console.log('[bot] Database opened');

    // 2. Load permissions from DB
    this.permissions.loadFromDb();

    // 3. Ensure the configured owner exists
    this.ensureOwner();

    // 4. Register commands
    registerPermissionCommands(this.commandHandler, this.permissions);
    registerDispatcherCommands(this.commandHandler, this.dispatcher);
    registerIRCAdminCommands(this.commandHandler, this.client, {
      getUptime: () => Date.now() - this.startTime,
      getChannels: () => [...this.configuredChannels],
      getBindCount: () => this.dispatcher.listBinds().length,
      getUserCount: () => this.permissions.listUsers().length,
    });
    registerPluginCommands(this.commandHandler, this.pluginLoader, resolve(this.config.pluginDir));

    // 5. Connect to IRC
    await this.connect();

    // 6. Create and attach bridge + core modules
    this.bridge = new IRCBridge({
      client: this.client,
      dispatcher: this.dispatcher,
      eventBus: this.eventBus,
      botNick: this.config.irc.nick,
    });
    this.bridge.attach();
    this.channelState.attach();
    this.services.attach();

    // 7. Authenticate with NickServ (non-SASL fallback)
    this.services.identify();

    // 8. Load plugins
    await this.pluginLoader.loadAll();

    this.startTime = Date.now();
    console.log('[bot] Started');
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    console.log('[bot] Shutting down...');

    this.services.detach();
    this.channelState.detach();

    if (this.bridge) {
      this.bridge.detach();
      this.bridge = null;
    }

    if (this.client.connected) {
      this.client.quit('Shutting down');
      // Give the QUIT message a moment to send
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    this.db.close();
    console.log('[bot] Shutdown complete');
  }

  // -------------------------------------------------------------------------
  // IRC connection
  // -------------------------------------------------------------------------

  private connect(): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const cfg = this.config.irc;

      const connectOptions: Record<string, unknown> = {
        host: cfg.host,
        port: cfg.port,
        tls: cfg.tls,
        nick: cfg.nick,
        username: cfg.username,
        gecos: cfg.realname,
        auto_reconnect: true,
        auto_reconnect_max_wait: 30000,
        auto_reconnect_max_retries: 10,
      };

      // SASL config
      if (this.config.services.sasl && this.config.services.password) {
        connectOptions.account = {
          account: cfg.nick,
          password: this.config.services.password,
        };
      }

      let registered = false;

      this.client.on('registered', () => {
        registered = true;
        console.log(`[bot] Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);
        this.eventBus.emit('bot:connected');

        // Join configured channels
        for (const channel of this.configuredChannels) {
          this.client.join(channel);
          console.log(`[bot] Joining ${channel}`);
        }

        resolvePromise();
      });

      this.client.on('close', () => {
        console.log('[bot] Connection closed');
        this.eventBus.emit('bot:disconnected', 'connection closed');
      });

      this.client.on('reconnecting', () => {
        console.log('[bot] Reconnecting...');
      });

      this.client.on('socket error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[bot] Socket error:', error.message);
        this.eventBus.emit('bot:error', error);
        if (!registered) {
          reject(error);
        }
      });

      console.log(`[bot] Connecting to ${cfg.host}:${cfg.port}...`);
      this.client.connect(connectOptions);
    });
  }

  // -------------------------------------------------------------------------
  // Config loading
  // -------------------------------------------------------------------------

  private loadConfig(configPath: string): BotConfig {
    try {
      accessSync(configPath, fsConstants.R_OK);
    } catch {
      console.error(`[bot] Config file not found: ${configPath}`);
      console.error('[bot] Copy config/bot.example.json to config/bot.json and edit it.');
      process.exit(1);
    }

    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as BotConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[bot] Failed to parse config: ${message}`);
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Owner bootstrapping
  // -------------------------------------------------------------------------

  /** Ensure the configured owner exists in the permissions system. */
  private ensureOwner(): void {
    const ownerCfg = this.config.owner;
    if (!ownerCfg?.handle || !ownerCfg?.hostmask) return;

    const existing = this.permissions.getUser(ownerCfg.handle);
    if (!existing) {
      this.permissions.addUser(ownerCfg.handle, ownerCfg.hostmask, 'n', 'config');
      console.log(`[bot] Owner "${ownerCfg.handle}" added from config`);
    }
  }
}
