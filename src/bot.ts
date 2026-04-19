// HexBot — Bot class
// Thin orchestrator that wires modules together. Creates and connects the
// pieces but delegates all real work to the individual modules.
import chalk from 'chalk';
import { Client as IrcClient } from 'irc-framework';
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandHandler } from './command-handler';
import {
  parseBotConfigOnDisk,
  resolveSecrets,
  validateChannelKeys,
  validateResolvedSecrets,
} from './config';
import { BanStore } from './core/ban-store';
import type { BotLinkHub, BotLinkLeaf } from './core/botlink';
import { ChannelSettings } from './core/channel-settings';
import { ChannelState } from './core/channel-state';
import { registerBanCommands } from './core/commands/ban-commands';
import { registerBotlinkCommands } from './core/commands/botlink-commands';
import { registerChannelCommands } from './core/commands/channel-commands';
import { registerDccConsoleCommands } from './core/commands/dcc-console-commands';
import { registerDispatcherCommands } from './core/commands/dispatcher-commands';
import { registerIRCAdminCommands } from './core/commands/irc-commands-admin';
import { registerModlogCommands, shutdownModLogCommands } from './core/commands/modlog-commands';
import { registerPasswordCommands } from './core/commands/password-commands';
import { registerPermissionCommands } from './core/commands/permission-commands';
import { registerPluginCommands } from './core/commands/plugin-commands';
import {
  type ConnectionLifecycleHandle,
  registerConnectionEvents,
} from './core/connection-lifecycle';
import { DCCManager } from './core/dcc';
import { HelpRegistry } from './core/help-registry';
import { IRCCommands } from './core/irc-commands';
import { MemoManager } from './core/memo';
import { MessageQueue } from './core/message-queue';
import { ensureOwner } from './core/owner-bootstrap';
import { Permissions } from './core/permissions';
import {
  type ReconnectDriver,
  type ReconnectState,
  createReconnectDriver,
} from './core/reconnect-driver';
import { RelayOrchestrator } from './core/relay-orchestrator';
import { Services } from './core/services';
import { STSStore, enforceSTS } from './core/sts';
import { BotDatabase } from './database';
import { EventDispatcher } from './dispatcher';
import type { VerificationProvider } from './dispatcher';
import { BotEventBus } from './event-bus';
import { IRCBridge } from './irc-bridge';
import { type LoggerLike, createLogger } from './logger';
import { PluginLoader } from './plugin-loader';
import type { BotConfig, Casemapping, ChannelEntry } from './types';
import { buildSocksOptions } from './utils/socks';
import { requiresVerificationForFlags, validateRequireAccFor } from './utils/verify-flags';
import { ircLower } from './utils/wildcard';

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
  readonly logger: LoggerLike;

  readonly pluginLoader: PluginLoader;
  readonly channelSettings: ChannelSettings;
  readonly channelState: ChannelState;
  readonly ircCommands: IRCCommands;
  readonly messageQueue: MessageQueue;
  readonly services: Services;
  readonly helpRegistry: HelpRegistry;
  readonly banStore: BanStore;
  readonly memo: MemoManager;
  readonly stsStore: STSStore;

  private bridge: IRCBridge | null = null;
  private _dccManager: DCCManager | null = null;
  private _relayOrchestrator: RelayOrchestrator | null = null;
  private _lifecycleHandle: ConnectionLifecycleHandle | null = null;
  private _reconnectDriver: ReconnectDriver | null = null;
  private botLogger: LoggerLike;
  private _casemapping: Casemapping = 'rfc1459';

  /** Snapshot of the reconnect driver state — used by the `.status` command. */
  getReconnectState(): ReconnectState | null {
    return this._reconnectDriver?.getState() ?? null;
  }

  getCasemapping(): Casemapping {
    return this._casemapping;
  }

  /** The active DCC manager, if DCC is enabled. Used by the REPL to announce activity. */
  get dccManager(): DCCManager | null {
    return this._dccManager;
  }

  /** The active bot link hub, if this bot is a hub. */
  get botLinkHub(): BotLinkHub | null {
    return this._relayOrchestrator?.hub ?? null;
  }

  /** The active bot link leaf, if this bot is a leaf. */
  get botLinkLeaf(): BotLinkLeaf | null {
    return this._relayOrchestrator?.leaf ?? null;
  }
  private startTime: number = Date.now();
  /**
   * Bot start time as a unix-epoch ms timestamp. Exposed so the REPL
   * startup summary and DCC login-summary banner can anchor "since bot
   * start" windows on the same value the stats banner already uses for
   * `uptime`.
   */
  get startedAt(): number {
    return this.startTime;
  }
  private configuredChannels: ChannelEntry[] = [];
  /**
   * Plugin names that failed to load at startup. Surfaced via
   * `.status` so operators can see degraded plugin state without
   * grepping logs. See stability audit 2026-04-14.
   */
  private failedPlugins: string[] = [];

  constructor(configPath?: string) {
    const cfgPath = resolve(configPath ?? './config/bot.json');
    this.config = this.loadConfig(cfgPath);

    // Create root logger from config level
    this.logger = createLogger(this.config.logging.level);
    this.botLogger = this.logger.child('bot');

    // Ensure the database directory exists (e.g. data/)
    const dbDir = dirname(resolve(this.config.database));
    mkdirSync(dbDir, { recursive: true });

    // The field assignments below are split across orchestration helpers
    // (createServices / wireDispatcher / createPluginLoader). Using
    // intermediate locals keeps TypeScript's "definitely assigned" analysis
    // happy for the class's `readonly` fields without weakening their types.
    const services = this.createServices();
    this.db = services.db;
    this.eventBus = services.eventBus;
    this.permissions = services.permissions;
    this.dispatcher = services.dispatcher;
    this.commandHandler = services.commandHandler;
    this.client = services.client;
    this.configuredChannels = services.configuredChannels;
    this.channelState = services.channelState;
    this.ircCommands = services.ircCommands;
    this.messageQueue = services.messageQueue;
    this.services = services.services;
    this.helpRegistry = services.helpRegistry;
    this.channelSettings = services.channelSettings;
    this.banStore = services.banStore;
    this.stsStore = services.stsStore;
    this.memo = services.memo;

    this.wireDispatcher();
    this.pluginLoader = this.createPluginLoader();
  }

  /**
   * Phase 1 of the constructor: instantiate the long-lived subsystems
   * (database, dispatcher, services, channel state, etc.) and return them
   * as a struct so the constructor can assign them to the class fields.
   * Kept as a single method because the subsystems have mutual references
   * (e.g. dispatcher needs permissions, memo needs dispatcher+commandHandler)
   * that would require threading locals through multiple helpers.
   */
  private createServices(): {
    db: BotDatabase;
    eventBus: BotEventBus;
    permissions: Permissions;
    dispatcher: EventDispatcher;
    commandHandler: CommandHandler;
    client: InstanceType<typeof IrcClient>;
    configuredChannels: ChannelEntry[];
    channelState: ChannelState;
    ircCommands: IRCCommands;
    messageQueue: MessageQueue;
    services: Services;
    helpRegistry: HelpRegistry;
    channelSettings: ChannelSettings;
    banStore: BanStore;
    stsStore: STSStore;
    memo: MemoManager;
  } {
    const db = new BotDatabase(this.config.database, this.logger, {
      modLogEnabled: this.config.logging.mod_actions,
      modLogRetentionDays: this.config.logging.mod_log_retention_days,
    });
    const eventBus = new BotEventBus();
    db.setEventBus(eventBus);
    const permissions = new Permissions(db, this.logger, eventBus);
    const dispatcher = new EventDispatcher(permissions, this.logger);
    const commandHandler = new CommandHandler(permissions, this.config.command_prefix);
    const client = new IrcClient();
    const configuredChannels = this.config.irc.channels.map((entry) =>
      typeof entry === 'string' ? { name: entry } : { name: entry.name, key: entry.key },
    );
    const channelState = new ChannelState(client, eventBus, this.logger);
    // Permissions can match account-based patterns (`$a:accountname`) once
    // we can ask channel-state for a nick's services account. Wire it now,
    // before any handler runs — plugins never call checkFlags before start().
    permissions.setAccountLookup((nick) => channelState.getAccountForNick(nick));
    const ircCommands = new IRCCommands(client, db, undefined, this.logger);
    const messageQueue = new MessageQueue({
      rate: this.config.queue?.rate,
      burst: this.config.queue?.burst,
      logger: this.logger,
    });
    const services = new Services({
      client,
      servicesConfig: this.config.services,
      eventBus,
      logger: this.logger,
      db,
    });
    const helpRegistry = new HelpRegistry();
    const channelSettings = new ChannelSettings(db, this.logger.child('channel-settings'), (s) =>
      ircLower(s, this.getCasemapping()),
    );
    const banStore = new BanStore(db, (s) => ircLower(s, this.getCasemapping()));
    const stsStore = new STSStore(db);
    const memo = new MemoManager({
      config: this.config.memo,
      dispatcher,
      commandHandler,
      permissions,
      channelState,
      client,
      logger: this.logger,
      eventBus,
      hasRelayConsole: (handle) => this._relayOrchestrator?.hasRelayConsole(handle) ?? false,
    });
    return {
      db,
      eventBus,
      permissions,
      dispatcher,
      commandHandler,
      client,
      configuredChannels,
      channelState,
      ircCommands,
      messageQueue,
      services,
      helpRegistry,
      channelSettings,
      banStore,
      stsStore,
      memo,
    };
  }

  /**
   * Phase 2: wire verification and flood-limiting policy onto the
   * dispatcher. Separate from service creation because it consults
   * `this.config` predicates (require_acc_for, flood) and installs
   * callbacks that close over the class instance.
   */
  private wireDispatcher(): void {
    // Validate `identity.require_acc_for` against the known flag set. A
    // typo like `["+O"]` silently defaults to level 0 (== disabled) —
    // exactly the footgun operators try to avoid. Warn and use the
    // filtered list so the dispatcher sees a consistent view of what was
    // actually recognised. See stability audit 2026-04-14.
    const validatedRequireAccFor = validateRequireAccFor(
      this.config.identity.require_acc_for,
      this.botLogger,
    );
    this.config.identity.require_acc_for = validatedRequireAccFor;

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

    if (this.config.flood) {
      this.dispatcher.setFloodConfig(this.config.flood);
    }
    this.dispatcher.setFloodNotice({
      sendNotice: (nick: string, msg: string) => {
        this.messageQueue.enqueue(nick, () => this.client.notice(nick, msg));
      },
    });

    // Reset per-user rate-limit buckets on disconnect so a stale old-
    // session flag doesn't leak into the first message after reconnect.
    // See stability audit 2026-04-14.
    this.eventBus.on('bot:disconnected', () => {
      this.dispatcher.clearFloodState();
    });
  }

  /** Phase 3: build the plugin loader with all injected core dependencies. */
  private createPluginLoader(): PluginLoader {
    return new PluginLoader({
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
      banStore: this.banStore,
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
          'CHANMODES',
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
    this.printBanner();

    this.db.open();
    this.botLogger.info('Database opened');
    this.permissions.loadFromDb();

    await ensureOwner({
      config: this.config,
      permissions: this.permissions,
      logger: this.botLogger,
    });

    this.registerCoreCommands();

    this.botLogger.info('Starting...');

    // Attach listeners BEFORE connect so handlers are ready when the server
    // starts sending events. DCC/memo slot in here because registerDccConsoleCommands
    // depends on an attached DCCManager.
    this.attachBridge();
    this.attachDcc();
    this.attachMemo();

    await this.startBotLink();

    this.registerPostLinkCommands();
    this.wireMemoDccNotify();

    // Load plugins (sets up binds before connection so all handlers are
    // ready when the server starts sending JOIN/MODE/etc responses)
    const pluginResults = await this.pluginLoader.loadAll(
      this.config.pluginsConfig ? resolve(this.config.pluginsConfig) : undefined,
    );
    // Track plugin-load failures for the startup banner and `.status`
    // observability surface. A silent "one plugin failed" was the
    // dominant reason operators didn't notice degraded functionality
    // until a user report landed. See stability audit 2026-04-14.
    this.failedPlugins = pluginResults.filter((r) => r.status === 'error').map((r) => r.name);
    if (this.failedPlugins.length > 0) {
      this.botLogger.error(
        `===== STARTUP BANNER: ${this.failedPlugins.length} plugin(s) FAILED to load: ${this.failedPlugins.join(', ')} — the bot is running with degraded functionality. Check the error lines above for details. =====`,
      );
    }

    // Connect to IRC (all handlers are registered — safe to receive events).
    // NickServ IDENTIFY (non-SASL fallback) is triggered from the `registered`
    // handler in connection-lifecycle, before joinConfiguredChannels — see
    // docs/services-identify-before-join.md.
    await this.connect();

    this.startTime = Date.now();
  }

  /** Register the built-in core commands (permissions, dispatcher, admin, plugins, modlog). */
  private registerCoreCommands(): void {
    registerPermissionCommands({
      handler: this.commandHandler,
      permissions: this.permissions,
    });
    registerPasswordCommands({
      handler: this.commandHandler,
      permissions: this.permissions,
      db: this.db,
    });
    registerDispatcherCommands({
      handler: this.commandHandler,
      dispatcher: this.dispatcher,
    });
    registerIRCAdminCommands({
      handler: this.commandHandler,
      client: this.client,
      botInfo: {
        getUptime: () => Date.now() - this.startTime,
        getChannels: () => this.configuredChannels.map((c) => c.name),
        getBindCount: () => this.dispatcher.listBinds().length,
        getUserCount: () => this.permissions.listUsers().length,
        getReconnectState: () => this.getReconnectState(),
        // Stability metrics — see stability audit 2026-04-14. These
        // give operators a .status-visible signal about services
        // degradation and plugin-load failures without trawling
        // logs.
        getStabilityMetrics: () => ({
          servicesTimeoutCount: this.services.getServicesTimeoutCount(),
          pendingVerifyCount: this.services.getPendingVerifyCount(),
          pendingCapRejections: this.services.getPendingCapRejectionCount(),
          loadedPluginCount: this.pluginLoader.list().length,
          failedPluginCount: this.failedPlugins.length,
          failedPluginNames: this.failedPlugins,
        }),
      },
      db: this.db,
    });
    registerPluginCommands({
      handler: this.commandHandler,
      pluginLoader: this.pluginLoader,
      pluginDir: resolve(this.config.pluginDir),
      db: this.db,
    });
    registerChannelCommands({
      handler: this.commandHandler,
      channelSettings: this.channelSettings,
      db: this.db,
    });
    registerModlogCommands({
      handler: this.commandHandler,
      db: this.db,
      permissions: this.permissions,
      eventBus: this.eventBus,
    });
  }

  /** Attach the IRC bridge, channel-state tracker, and services listener. */
  private attachBridge(): void {
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
    this.channelState.setBotNick(this.config.irc.nick);
    this.services.attach();
  }

  /** Start the DCC CHAT / botnet subsystem when enabled by config. */
  private attachDcc(): void {
    if (!this.config.dcc?.enabled) return;
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
      db: this.db,
      eventBus: this.eventBus,
      consoleFlagStore: {
        get: (handle) => this.db.get('dcc', `console_flags:${handle}`),
        set: (handle, flags) => this.db.set('dcc', `console_flags:${handle}`, flags),
        delete: (handle) => this.db.del('dcc', `console_flags:${handle}`),
      },
      getStats: () => ({
        channels: this.channelState.getAllChannels().map((ch) => ch.name),
        pluginCount: this.pluginLoader.list().length,
        bindCount: this.dispatcher.listBinds().length,
        userCount: this.permissions.listUsers().length,
        uptime: Date.now() - this.startTime,
      }),
      getBootTs: () => Math.floor(this.startTime / 1000),
    });
    this._dccManager.attach();
    registerDccConsoleCommands({
      handler: this.commandHandler,
      dccManager: this._dccManager,
      db: this.db,
    });
    this.eventBus.on('user:removed', (handle: string) => {
      this.db.del('dcc', `console_flags:${handle}`);
    });
    this.botLogger.info('DCC CHAT enabled');
  }

  /** Attach the memo system — must run after attachDcc() so it can deliver to console. */
  private attachMemo(): void {
    if (this._dccManager) {
      this.memo.setDCCManager(this._dccManager);
    }
    this.memo.attach();
  }

  /**
   * Construct and start the relay orchestrator, which owns the bot-link
   * hub/leaf, virtual relay sessions, party-line wiring, and frame dispatch.
   * Delegates all the actual wiring to src/core/relay-orchestrator.ts.
   */
  private async startBotLink(): Promise<void> {
    this._relayOrchestrator = new RelayOrchestrator({
      config: this.config,
      version: this.readPackageVersion(),
      logger: this.logger,
      eventBus: this.eventBus,
      db: this.db,
      client: this.client,
      commandHandler: this.commandHandler,
      permissions: this.permissions,
      channelState: this.channelState,
      channelSettings: this.channelSettings,
      ircCommands: this.ircCommands,
      services: this.services,
      getDccManager: () => this._dccManager,
      getCasemapping: () => this._casemapping,
    });
    await this._relayOrchestrator.start();
  }

  /** Register commands that need to know whether botlink/DCC/ban-store are live. */
  private registerPostLinkCommands(): void {
    registerBotlinkCommands({
      handler: this.commandHandler,
      hub: this._relayOrchestrator?.hub ?? null,
      leaf: this._relayOrchestrator?.leaf ?? null,
      config: this.config.botlink ?? null,
      db: this.db,
      dccManager: this._dccManager,
      ircSay: (target, message) => this.client.say(target, message),
    });
    registerBanCommands({
      commandHandler: this.commandHandler,
      banStore: this.banStore,
      ircCommands: this.ircCommands,
      db: this.db,
      hub: this._relayOrchestrator?.hub ?? null,
      sharedBanList: this._relayOrchestrator?.sharedBanList ?? null,
      ircLower: (s: string) => ircLower(s, this.getCasemapping()),
    });
  }

  /** Wire memo DCC-connect notification (must run after botlink may have set onPartyJoin). */
  private wireMemoDccNotify(): void {
    if (!this._dccManager) return;
    const prevOnPartyJoin = this._dccManager.onPartyJoin;
    this._dccManager.onPartyJoin = (handle, nick) => {
      prevOnPartyJoin?.(handle, nick);
      this.memo.notifyOnDCCConnect(handle, nick);
    };
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    this.botLogger.info('Shutting down...');

    // Each step is independent of the others — a throw in one subsystem's
    // teardown must not block the ones after it. Previously, every step
    // ran sequentially without catches, so a single bad `close()` skipped
    // `db.close()` and leaked everything downstream. See audit finding
    // W-BO2 (2026-04-14).
    const step = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        this.botLogger.error(`Shutdown step "${name}" threw:`, err);
      }
    };

    // Cancel any pending reconnect BEFORE tearing down the client so a
    // stray timer cannot fire mid-shutdown and re-open a socket.
    step('reconnect-driver.cancel', () => {
      if (this._reconnectDriver) {
        this._reconnectDriver.cancel();
        this._reconnectDriver = null;
      }
    });

    step('lifecycle-handle', () => {
      if (this._lifecycleHandle) {
        this._lifecycleHandle.stopPresenceCheck();
        this._lifecycleHandle.removeListeners();
        this._lifecycleHandle = null;
      }
    });

    // The relay orchestrator owns its own step-wise teardown (hub.close,
    // leaf.disconnect, mirror listeners, and the botlink:disconnected
    // cleanup). We still wrap the call in step() so a throw from inside the
    // orchestrator can't short-circuit the rest of bot shutdown.
    step('relay-orchestrator.stop', () => {
      if (this._relayOrchestrator) {
        this._relayOrchestrator.stop();
        this._relayOrchestrator = null;
      }
    });

    step('dcc.detach', () => {
      if (this._dccManager) {
        this._dccManager.detach('Bot shutting down.');
        this._dccManager = null;
      }
    });

    step('memo.detach', () => this.memo.detach());
    step('services.detach', () => this.services.detach());
    step('channel-state.detach', () => this.channelState.detach());

    step('bridge.detach', () => {
      if (this.bridge) {
        this.bridge.detach();
        this.bridge = null;
      }
    });

    step('message-queue.flush', () => this.messageQueue.flush());
    step('message-queue.stop', () => this.messageQueue.stop());

    if (this.client.connected) {
      try {
        const quitMsg = this.config.quit_message ?? `HexBot v${this.readPackageVersion()}`;
        this.client.quit(quitMsg);
        // Give the QUIT message a moment to send
        await new Promise<void>((r) => setTimeout(r, 500));
      } catch (err) {
        this.botLogger.error('Shutdown step "client.quit" threw:', err);
      }
    }

    // Drop modlog pagers and audit-tail subscriptions — each tail
    // listener holds a closure over the REPL reply function so
    // leaving them attached leaks the full session context across
    // a reload. See audit findings W-CMD1/W-CMD2 (2026-04-14).
    step('modlog-commands.shutdown', () => shutdownModLogCommands());

    step('db.close', () => this.db.close());
    this.botLogger.info('Shutdown complete');
  }

  // -------------------------------------------------------------------------
  // IRC connection
  // -------------------------------------------------------------------------

  private connect(): Promise<void> {
    // Enforce any stored IRCv3 STS policy BEFORE we touch the socket. If
    // the policy upgrades us, mutate the in-memory config so downstream
    // code (message-queue cost calcs, logging, Services) sees a
    // TLS-consistent view for the rest of the session.
    //
    // STS refusal is a fatal configuration condition — we must exit with
    // code 2 (permanent-failure tier) so supervisors do not restart-loop
    // on an unreachable/misconfigured host. A default `throw` would
    // propagate as code 1 (transient), spinning forever. See stability
    // audit 2026-04-14.
    try {
      this.applySTSPolicyToConfig();
    } catch (err) {
      this.botLogger.error(
        `FATAL: STS enforcement refused connection — exiting with code 2 so the supervisor does not restart-loop: ${(err as Error).message}`,
      );
      this.eventBus.emit('bot:disconnected', `fatal: sts-refused`);
      process.exit(2);
    }

    // Defensive idempotency: if connect() is ever called twice (future STS
    // path, manual .reconnect command), tear down the prior driver and
    // lifecycle handle so we don't stack listeners or leak a retry timer.
    if (this._reconnectDriver) {
      this._reconnectDriver.cancel();
      this._reconnectDriver = null;
    }
    if (this._lifecycleHandle) {
      this._lifecycleHandle.stopPresenceCheck();
      this._lifecycleHandle.removeListeners();
      this._lifecycleHandle = null;
    }

    const options = this.buildClientOptions();
    this.botLogger.info(`Connecting to ${this.config.irc.host}:${this.config.irc.port}...`);
    // Construct the reconnect driver lazily here so `.start()` owns its
    // lifecycle. The driver's connect callback re-opens the socket using
    // the latest options (STS upgrades mutate this.config between retries).
    const reconnectLogger = this.logger.child('reconnect');
    const reconnectDriver = createReconnectDriver({
      connect: () => {
        reconnectLogger.info(
          `Reconnect attempt to ${this.config.irc.host}:${this.config.irc.port}`,
        );
        this.client.connect(this.buildClientOptions());
      },
      logger: reconnectLogger,
      eventBus: this.eventBus,
      config: {
        transient_initial_ms: 1_000,
        transient_max_ms: 30_000,
        rate_limited_initial_ms: 300_000,
        rate_limited_max_ms: 1_800_000,
        jitter_ms: 5_000,
      },
      exit: (code) => process.exit(code),
    });
    this._reconnectDriver = reconnectDriver;
    return new Promise<void>((resolve, reject) => {
      this._lifecycleHandle = registerConnectionEvents(
        {
          client: this.client,
          config: this.config,
          configuredChannels: this.configuredChannels,
          eventBus: this.eventBus,
          reconnectDriver,
          applyCasemapping: (cm) => {
            this._casemapping = cm;
            this.channelState.setCasemapping(cm);
            this.permissions.setCasemapping(cm);
            this.dispatcher.setCasemapping(cm);
            this.services.setCasemapping(cm);
            if (this._dccManager) this._dccManager.setCasemapping(cm);
            this.memo.setCasemapping(cm);
          },
          applyServerCapabilities: (caps) => {
            this.channelState.setCapabilities(caps);
            this.ircCommands.setCapabilities(caps);
            this.bridge?.setCapabilities(caps);
            // Feed TARGMAX into the message queue. It's advisory (hexbot
            // never sends multi-target PRIVMSG lines) but surfaced so
            // plugins can inspect it via the queue for future multi-target
            // logic — see docs/audits/irc-logic-2026-04-11.md §10.
            this.messageQueue.setTargmax(caps.targmax);
          },
          onReconnecting: () => {
            // Drop cached services-account state so a user who took a
            // recognised nick between sessions can't inherit its flags on
            // the new connection. Fresh account data will arrive via
            // extended-join / account-notify / account-tag on rejoin.
            this.channelState.clearNetworkAccounts();
            // Drop every tracked channel — if the autojoin set shrinks
            // across reconnects, residual ChannelInfo/UserInfo graphs
            // would otherwise sit in memory forever. NAMES will repopulate
            // fresh state on the new session.
            this.channelState.clearAllChannels();
            // Fail any in-flight NickServ verifications fast rather than
            // letting them age out to a misleading `nickserv-verify-timeout`
            // audit row. See audit finding W-CL2 (2026-04-14).
            this.services.cancelPendingVerifies('disconnected');
          },
          onSTSDirective: (directive, currentTls) => {
            // Persist the directive so future startups inherit the policy.
            const record = this.stsStore.put(this.config.irc.host, directive);
            if (record) {
              this.botLogger.info(
                `STS policy for ${this.config.irc.host} stored until ` +
                  new Date(record.expiresAt).toISOString(),
              );
            }
            // If we're still on plaintext and the directive names a TLS
            // port, reconnect immediately via TLS. This matches the IRCv3
            // spec: clients SHOULD upgrade the current session on first
            // contact rather than waiting for the next run.
            if (!currentTls && directive.port !== undefined) {
              this.botLogger.warn(
                `STS upgrade: reconnecting ${this.config.irc.host} on port ${directive.port} via TLS`,
              );
              this.config.irc.tls = true;
              this.config.irc.port = directive.port;
              // Drop the current session; the reconnect lifecycle will kick
              // back in and the next connect picks up the mutated config.
              this.client.quit('STS upgrade to TLS');
            }
          },
          messageQueue: this.messageQueue,
          dispatcher: this.dispatcher,
          channelState: this.channelState,
          logger: this.logger.child('connection'),
          identifyWithServices: () => this.services.identify(),
        },
        resolve,
        reject,
      );
      this.client.connect(options);
    });
  }

  /**
   * Consult the STS store and, if there's an active policy for the
   * configured host, either upgrade the effective config to TLS (when a
   * port is recorded) or abort startup loudly (when we'd have to guess).
   * Must run before `buildClientOptions` so the upgraded values land in
   * the irc-framework options object.
   */
  private applySTSPolicyToConfig(): void {
    const outcome = enforceSTS(
      this.stsStore,
      this.config.irc.host,
      this.config.irc.tls,
      this.config.irc.port,
    );
    if (outcome.kind === 'allow') return;
    if (outcome.kind === 'upgrade') {
      this.botLogger.warn(
        `STS policy active for ${this.config.irc.host} until ` +
          `${new Date(outcome.expiresAt).toISOString()} — ` +
          `upgrading to TLS on port ${outcome.port}`,
      );
      this.config.irc.tls = true;
      this.config.irc.port = outcome.port;
      return;
    }
    // `refuse` — no safe path. Stop hard so an operator sees the reason
    // instead of hexbot silently reverting to plaintext.
    throw new Error(`[bot] STS enforcement refused connection: ${outcome.reason}`);
  }

  /** Build the irc-framework connection options from the bot config. Pure config read — no side effects. */
  private buildClientOptions(): Record<string, unknown> {
    const cfg = this.config.irc;

    if (cfg.tls && cfg.tls_verify === false) {
      console.warn(
        '[bot] WARNING: tls_verify is false — TLS certificate validation is DISABLED. ' +
          'This connection is vulnerable to MITM attacks.',
      );
    }

    const options: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      rejectUnauthorized: cfg.tls_verify ?? true,
      nick: cfg.nick,
      username: cfg.username,
      gecos: cfg.realname,
      // HexBot owns the reconnect loop via src/core/reconnect-driver.ts —
      // irc-framework's auto_reconnect gives up when a reconnect reaches
      // TCP-connected but fails to complete IRC registration, leaving the
      // process as a zombie (2026-04-13 incident).
      auto_reconnect: false,
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`[config] Failed to parse JSON in ${configPath}: ${m}`, { cause: err });
      }
      // Shape validation: rejects unknown keys, missing required fields, and
      // wrong primitive types. Catches typos that would otherwise silently
      // load as undefined and surface as confusing runtime errors later.
      const onDisk = parseBotConfigOnDisk(parsed);
      // Resolve `_env` suffix fields from process.env into their sibling
      // non-suffixed fields. After this, internal code reads the resolved
      // runtime BotConfig shape (services.password, botlink.password, etc.).
      const resolved = resolveSecrets(onDisk);
      validateResolvedSecrets(resolved);
      // Channels keyed via key_env need their own post-resolution check —
      // the resolver drops unset env vars, so validateResolvedSecrets can't
      // tell the difference between "never had a key" and "env var unset".
      validateChannelKeys(onDisk.irc.channels, resolved.irc.channels);
      return resolved;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
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
    const channels = this.configuredChannels.map((c) => c.name).join(', ') || 'none';

    console.log();
    console.log(`${lime('◆')} ${lime('HexBot')} ${lime(`v${version}`)}`);
    console.log(`${dim('-')} Server:      ${cfg.host}:${cfg.port}${tls}`);
    console.log(`${dim('-')} Nick:        ${cfg.nick}`);
    console.log(`${dim('-')} Channels:    ${channels}`);
    console.log(`${dim('-')} Plugins:     ${this.config.pluginDir}`);
    console.log();
  }

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
}
