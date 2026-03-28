// hexbot — Bot class
// Thin orchestrator that wires modules together. Creates and connects the
// pieces but delegates all real work to the individual modules.
import chalk from 'chalk';
import { Client as IrcClient } from 'irc-framework';
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandHandler } from './command-handler';
import { ChannelSettings } from './core/channel-settings';
import { ChannelState } from './core/channel-state';
import { registerChannelCommands } from './core/commands/channel-commands';
import { registerDispatcherCommands } from './core/commands/dispatcher-commands';
import { registerIRCAdminCommands } from './core/commands/irc-commands-admin';
import { registerPermissionCommands } from './core/commands/permission-commands';
import { registerPluginCommands } from './core/commands/plugin-commands';
import { DCCManager } from './core/dcc';
import { HelpRegistry } from './core/help-registry';
import { IRCCommands } from './core/irc-commands';
import { MessageQueue } from './core/message-queue';
import { Permissions } from './core/permissions';
import { Services } from './core/services';
import { BotDatabase } from './database';
import { EventDispatcher } from './dispatcher';
import type { VerificationProvider } from './dispatcher';
import { BotEventBus } from './event-bus';
import { IRCBridge } from './irc-bridge';
import { type Logger, createLogger } from './logger';
import { PluginLoader } from './plugin-loader';
import type { Casemapping } from './types';
import type { BotConfig, IdentityConfig, ProxyConfig } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flag hierarchy for require_acc_for checking. */
const FLAG_LEVEL: Record<string, number> = { n: 4, m: 3, o: 2, v: 1 };

/**
 * Determine whether the bind's required flags are at or above any threshold
 * in `config.identity.require_acc_for`. Used by the VerificationProvider.
 * Exported for unit testing.
 */
export function requiresVerificationForFlags(
  bindFlags: string,
  requireAccFor: IdentityConfig['require_acc_for'],
): boolean {
  if (bindFlags === '-' || bindFlags === '') return false;
  if (!requireAccFor || requireAccFor.length === 0) return false;

  // Find the minimum threshold flag level from require_acc_for (e.g. ["+o", "+n"] → 2)
  const thresholds = requireAccFor
    .map((f) => f.replace('+', ''))
    .map((f) => FLAG_LEVEL[f] ?? 0)
    .filter((l) => l > 0);
  if (thresholds.length === 0) return false;
  const minThreshold = Math.min(...thresholds);

  // Find the highest flag level among the bind's required flags
  const bindLevel = Math.max(...[...bindFlags].map((f) => FLAG_LEVEL[f] ?? 0));
  return bindLevel >= minThreshold;
}

/**
 * Build the `socks` options object expected by irc-framework from a ProxyConfig.
 * Exported for unit testing.
 */
export function buildSocksOptions(proxy: ProxyConfig): Record<string, unknown> {
  return {
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username ? { user: proxy.username } : {}),
    ...(proxy.password ? { pass: proxy.password } : {}),
  };
}

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
  readonly logger: Logger;

  readonly pluginLoader: PluginLoader;
  readonly channelSettings: ChannelSettings;
  readonly channelState: ChannelState;
  readonly ircCommands: IRCCommands;
  readonly messageQueue: MessageQueue;
  readonly services: Services;
  readonly helpRegistry: HelpRegistry;

  private bridge: IRCBridge | null = null;
  private _dccManager: DCCManager | null = null;
  private botLogger: Logger;
  private _casemapping: Casemapping = 'rfc1459';

  getCasemapping(): Casemapping {
    return this._casemapping;
  }

  /** The active DCC manager, if DCC is enabled. Used by the REPL to announce activity. */
  get dccManager(): DCCManager | null {
    return this._dccManager;
  }
  private startTime: number = Date.now();
  private bootStart: number = Date.now();
  private configuredChannels: string[] = [];

  constructor(configPath?: string) {
    const cfgPath = resolve(configPath ?? './config/bot.json');
    this.config = this.loadConfig(cfgPath);

    // Create root logger from config level
    this.logger = createLogger(this.config.logging.level);
    this.botLogger = this.logger.child('bot');

    // Ensure the database directory exists (e.g. data/)
    const dbDir = dirname(resolve(this.config.database));
    mkdirSync(dbDir, { recursive: true });

    this.db = new BotDatabase(this.config.database, this.logger);
    this.eventBus = new BotEventBus();
    this.permissions = new Permissions(this.db, this.logger);
    this.dispatcher = new EventDispatcher(this.permissions, this.logger);
    this.commandHandler = new CommandHandler(this.permissions);
    this.client = new IrcClient();
    this.configuredChannels = [...this.config.irc.channels];
    this.channelState = new ChannelState(this.client, this.eventBus, this.logger);
    this.ircCommands = new IRCCommands(this.client, this.db, undefined, this.logger);
    this.messageQueue = new MessageQueue({
      rate: this.config.queue?.rate,
      burst: this.config.queue?.burst,
      logger: this.logger,
    });
    this.services = new Services({
      client: this.client,
      servicesConfig: this.config.services,
      eventBus: this.eventBus,
      logger: this.logger,
    });
    this.helpRegistry = new HelpRegistry();
    this.channelSettings = new ChannelSettings(this.db);

    // Wire verification provider: gates privileged dispatch on NickServ identity.
    // Uses the live account map from account-notify/extended-join (fast path),
    // falling back to NickServ ACC queries when account state is unknown.
    const verificationProvider: VerificationProvider = {
      requiresVerificationForFlags: (flags: string) =>
        requiresVerificationForFlags(flags, this.config.identity.require_acc_for),
      getAccountForNick: (nick: string) => this.channelState.getAccountForNick(nick),
      verifyUser: (nick: string) => this.services.verifyUser(nick),
    };
    if (this.config.identity.require_acc_for.length > 0 && this.config.services.type !== 'none') {
      this.dispatcher.setVerification(verificationProvider);
    }

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
      messageQueue: this.messageQueue,
      services: this.services,
      helpRegistry: this.helpRegistry,
      channelSettings: this.channelSettings,
      logger: this.logger,
      getCasemapping: () => this.getCasemapping(),
      getServerSupports: () => {
        const known = [
          'CASEMAPPING',
          'MODES',
          'MAXCHANNELS',
          'CHANTYPES',
          'PREFIX',
          'CHANLIMIT',
          'NICKLEN',
          'TOPICLEN',
          'KICKLEN',
          'NETWORK',
        ];
        const result: Record<string, string> = {};
        for (const k of known) {
          const v = this.client.network.supports(k);
          if (v !== false) result[k] = String(v);
        }
        return result;
      },
    });
  }

  /** Start the bot: open DB, load permissions, connect to IRC, wire everything. */
  async start(): Promise<void> {
    this.bootStart = Date.now();

    // Print startup banner
    this.printBanner();

    // 1. Open database
    this.db.open();
    this.botLogger.info('Database opened');

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
    registerChannelCommands(this.commandHandler, this.channelSettings);

    this.botLogger.info('Starting...');

    // 5. Connect to IRC
    await this.connect();

    // 6. Create and attach bridge + core modules
    this.bridge = new IRCBridge({
      client: this.client,
      dispatcher: this.dispatcher,
      botNick: this.config.irc.nick,
      messageQueue: this.messageQueue,
      channelState: this.channelState,
      logger: this.logger,
    });
    this.bridge.attach();
    this.channelState.attach();
    this.services.attach();

    // 7. Authenticate with NickServ (non-SASL fallback)
    this.services.identify();

    // 8a. Start DCC CHAT / botnet (if configured)
    if (this.config.dcc?.enabled) {
      this._dccManager = new DCCManager({
        client: this.client,
        dispatcher: this.dispatcher,
        permissions: this.permissions,
        services: this.services,
        commandHandler: this.commandHandler,
        config: this.config.dcc,
        version: this.readPackageVersion(),
        botNick: this.config.irc.nick,
        logger: this.logger,
      });
      this._dccManager.attach();
      this.botLogger.info('DCC CHAT enabled');
    }

    // 8. Load plugins
    await this.pluginLoader.loadAll();

    this.startTime = Date.now();
    const elapsed = this.startTime - this.bootStart;
    this.botLogger.info(`Ready in ${elapsed}ms`);
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    this.botLogger.info('Shutting down...');

    if (this._dccManager) {
      this._dccManager.detach('Bot shutting down.');
      this._dccManager = null;
    }

    this.services.detach();
    this.channelState.detach();

    if (this.bridge) {
      this.bridge.detach();
      this.bridge = null;
    }

    this.messageQueue.flush();
    this.messageQueue.stop();

    if (this.client.connected) {
      const quitMsg = this.config.quit_message ?? `Hexbot v${this.readPackageVersion()}`;
      this.client.quit(quitMsg);
      // Give the QUIT message a moment to send
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    this.db.close();
    this.botLogger.info('Shutdown complete');
  }

  // -------------------------------------------------------------------------
  // IRC connection
  // -------------------------------------------------------------------------

  private connect(): Promise<void> {
    const options = this.buildClientOptions();
    this.botLogger.info(`Connecting to ${this.config.irc.host}:${this.config.irc.port}...`);
    return new Promise<void>((resolve, reject) => {
      this.registerConnectionEvents(resolve, reject);
      this.client.connect(options);
    });
  }

  /** Build the irc-framework connection options from the bot config. Pure config read — no side effects. */
  private buildClientOptions(): Record<string, unknown> {
    const cfg = this.config.irc;

    const options: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      nick: cfg.nick,
      username: cfg.username,
      gecos: cfg.realname,
      auto_reconnect: true,
      auto_reconnect_max_wait: 30000,
      auto_reconnect_max_retries: 10,
      // Disable irc-framework's built-in CTCP VERSION reply —
      // we handle it ourselves in irc-bridge.ts via the dispatcher
      version: null,
      // IRCv3: request chghost capability so channel-state receives real-time hostmask updates.
      // account-notify and extended-join are requested automatically by irc-framework.
      enable_chghost: true,
    };

    // SASL config
    const saslMechanism = this.config.services.sasl_mechanism ?? 'PLAIN';
    if (this.config.services.sasl) {
      if (saslMechanism === 'EXTERNAL') {
        // SASL EXTERNAL: authenticate via TLS client certificate (CertFP).
        // No password is needed — the server authenticates from the cert fingerprint.
        options.sasl_mechanism = 'EXTERNAL';
        if (cfg.tls_cert) options.tls_cert = cfg.tls_cert;
        if (cfg.tls_key) options.tls_key = cfg.tls_key;
        this.botLogger.info('SASL EXTERNAL (CertFP) authentication enabled');
      } else if (this.config.services.password) {
        // SASL PLAIN: username + password over TLS
        options.account = { account: cfg.nick, password: this.config.services.password };
      }
    }

    // Proxy config
    if (this.config.proxy?.enabled) {
      options.socks = buildSocksOptions(this.config.proxy);
      this.botLogger.info(
        `Using SOCKS5 proxy: ${this.config.proxy.host}:${this.config.proxy.port}`,
      );
    }

    return options;
  }

  /** Register all IRC connection lifecycle event listeners. */
  private registerConnectionEvents(resolve: () => void, reject: (err: Error) => void): void {
    const cfg = this.config.irc;
    let registered = false;

    this.client.on('registered', () => {
      registered = true;
      this.botLogger.info(`Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);
      this.eventBus.emit('bot:connected');

      // Read CASEMAPPING from ISUPPORT (available after 005)
      const cm = this.client.network.supports('CASEMAPPING');
      if (cm === 'ascii' || cm === 'strict-rfc1459' || cm === 'rfc1459') {
        this._casemapping = cm;
      } else {
        this._casemapping = 'rfc1459'; // safe fallback for unknown values
      }
      this.botLogger.info(`CASEMAPPING: ${this._casemapping}`);

      // Propagate to modules that use IRC nick/channel key comparison
      this.channelState.setCasemapping(this._casemapping);
      this.permissions.setCasemapping(this._casemapping);
      this.dispatcher.setCasemapping(this._casemapping);
      this.services.setCasemapping(this._casemapping);
      if (this._dccManager) this._dccManager.setCasemapping(this._casemapping);

      // Join configured channels
      for (const channel of this.configuredChannels) {
        this.client.join(channel);
        this.botLogger.info(`Joining ${channel}`);
      }

      resolve();
    });

    this.client.on('close', () => {
      this.botLogger.info('Connection closed');
      this.eventBus.emit('bot:disconnected', 'connection closed');
    });

    this.client.on('reconnecting', () => {
      this.messageQueue.clear();
      this.botLogger.info('Reconnecting...');
    });

    this.client.on('socket error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.botLogger.error('Socket error:', error.message);
      this.eventBus.emit('bot:error', error);
      if (!registered) {
        reject(error);
      }
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

    // Warn if the config file is world-readable
    try {
      const stat = statSync(configPath);
      if (stat.mode & 0o004) {
        console.error(
          `[bot] SECURITY: ${configPath} is world-readable (mode ${(stat.mode & 0o777).toString(8)})`,
        );
        console.error(`[bot] Run: chmod 600 ${configPath}`);
        process.exit(1);
      }
    } catch {
      // stat failed — file readable check already passed above, ignore
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
  // Startup banner
  // -------------------------------------------------------------------------

  /** Print the startup banner with connection details. */
  private printBanner(): void {
    const lime = chalk.greenBright;
    const dim = chalk.dim;
    const version = this.readPackageVersion();
    const cfg = this.config.irc;
    const tls = cfg.tls ? ' (TLS)' : '';
    const channels = this.configuredChannels.join(', ') || 'none';

    console.log();
    console.log(`${lime('◆')} ${lime('hexbot')} ${lime(`v${version}`)}`);
    console.log(`${dim('-')} Server:      ${cfg.host}:${cfg.port}${tls}`);
    console.log(`${dim('-')} Nick:        ${cfg.nick}`);
    console.log(`${dim('-')} Channels:    ${channels}`);
    console.log(`${dim('-')} Plugins:     ${this.config.pluginDir}`);
    console.log();
  }

  /** Print a status line with a lime green check mark. */
  /** Read the version field from package.json. */
  private readPackageVersion(): string {
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const pkgPath = join(thisDir, '..', 'package.json');
      const raw = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
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
      this.botLogger.info(`Owner "${ownerCfg.handle}" added from config`);
    } else if (!existing.hostmasks.includes(ownerCfg.hostmask)) {
      // Config hostmask not present — add it without removing existing ones
      this.permissions.addHostmask(ownerCfg.handle, ownerCfg.hostmask, 'config');
      this.botLogger.info(
        `Owner "${ownerCfg.handle}" hostmask updated from config: ${ownerCfg.hostmask}`,
      );
    }
  }
}
