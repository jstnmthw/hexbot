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
import {
  BanListSyncer,
  BotLinkHub,
  BotLinkLeaf,
  ChannelStateSyncer,
  type LinkFrame,
  PermissionSyncer,
  type RelaySessionMap,
  SharedBanList,
  handleProtectFrame,
  handleRelayFrame,
} from './core/botlink';
import { ChannelSettings } from './core/channel-settings';
import { ChannelState } from './core/channel-state';
import { registerBanCommands } from './core/commands/ban-commands';
import { registerBotlinkCommands } from './core/commands/botlink-commands';
import { registerChannelCommands } from './core/commands/channel-commands';
import { registerDccConsoleCommands } from './core/commands/dcc-console-commands';
import { registerDispatcherCommands } from './core/commands/dispatcher-commands';
import { registerIRCAdminCommands } from './core/commands/irc-commands-admin';
import { registerModlogCommands } from './core/commands/modlog-commands';
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
import { toEventObject } from './utils/irc-event';
import { sanitize } from './utils/sanitize';
import { buildSocksOptions } from './utils/socks';
import { stripFormatting } from './utils/strip-formatting';
import { requiresVerificationForFlags } from './utils/verify-flags';
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
  private _botLinkHub: BotLinkHub | null = null;
  private _botLinkLeaf: BotLinkLeaf | null = null;
  private _sharedBanList: SharedBanList | null = null;
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
    return this._botLinkHub;
  }

  /** The active bot link leaf, if this bot is a leaf. */
  get botLinkLeaf(): BotLinkLeaf | null {
    return this._botLinkLeaf;
  }
  private startTime: number = Date.now();
  private configuredChannels: ChannelEntry[] = [];

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
      hasRelayConsole: (handle) => this._relayVirtualSessions.has(handle),
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
    await this.pluginLoader.loadAll(
      this.config.pluginsConfig ? resolve(this.config.pluginsConfig) : undefined,
    );

    // Connect to IRC (all handlers are registered — safe to receive events)
    await this.connect();

    // Authenticate with NickServ (non-SASL fallback, needs active connection)
    this.services.identify();

    this.startTime = Date.now();
  }

  /** Register the built-in core commands (permissions, dispatcher, admin, plugins, modlog). */
  private registerCoreCommands(): void {
    registerPermissionCommands(this.commandHandler, this.permissions);
    registerPasswordCommands({
      handler: this.commandHandler,
      permissions: this.permissions,
      db: this.db,
    });
    registerDispatcherCommands(this.commandHandler, this.dispatcher);
    registerIRCAdminCommands(
      this.commandHandler,
      this.client,
      {
        getUptime: () => Date.now() - this.startTime,
        getChannels: () => this.configuredChannels.map((c) => c.name),
        getBindCount: () => this.dispatcher.listBinds().length,
        getUserCount: () => this.permissions.listUsers().length,
        getReconnectState: () => this.getReconnectState(),
      },
      this.db,
    );
    registerPluginCommands(
      this.commandHandler,
      this.pluginLoader,
      resolve(this.config.pluginDir),
      this.db,
    );
    registerChannelCommands(this.commandHandler, this.channelSettings, this.db);
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
    });
    this._dccManager.attach();
    registerDccConsoleCommands(this.commandHandler, this._dccManager, this.db);
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

  /** Start the bot-link hub or leaf, depending on config. */
  private async startBotLink(): Promise<void> {
    if (this.config.botlink?.enabled) {
      const botlinkConfig = this.config.botlink;
      // Register the 'shared' per-channel setting for ban sync
      this.channelSettings.register('core:botlink', [
        {
          key: 'shared',
          type: 'flag',
          default: false,
          description: 'Sync ban/exempt lists with linked bots',
        },
      ]);
      this._sharedBanList = new SharedBanList();
      const isShared = (ch: string) => this.channelSettings.get(ch, 'shared') === true;

      const version = this.readPackageVersion();
      if (botlinkConfig.role === 'hub') {
        this._botLinkHub = new BotLinkHub(
          botlinkConfig,
          version,
          this.logger,
          this.eventBus,
          this.db,
        );
        this._botLinkHub.setCommandRelay(this.commandHandler, this.permissions, this.eventBus);
        this._botLinkHub.onSyncRequest = (_botname, send) => {
          for (const f of ChannelStateSyncer.buildSyncFrames(this.channelState)) send(f);
          for (const f of PermissionSyncer.buildSyncFrames(this.permissions)) send(f);
          if (this._sharedBanList) {
            for (const f of BanListSyncer.buildSyncFrames(this._sharedBanList, isShared)) send(f);
          }
        };
        this._botLinkHub.onLeafConnected = (botname) =>
          this.eventBus.emit('botlink:connected', botname);
        this._botLinkHub.onLeafDisconnected = (botname, reason) =>
          this.eventBus.emit('botlink:disconnected', botname, reason);
        this._botLinkHub.onLeafFrame = (_botname, frame) => {
          this.handleIncomingBotlinkFrame(frame, isShared);
        };
        // BSAY: when a linked bot asks the hub to send an IRC message
        this._botLinkHub.onBsay = (target, message) => this.client.say(target, message);
        // Party line: provide local DCC sessions for PARTY_WHOM
        this._botLinkHub.getLocalPartyUsers = () => {
          if (!this._dccManager) return [];
          return this._dccManager.getSessionList().map((s) => ({
            handle: s.handle,
            nick: s.nick,
            botname: botlinkConfig.botname,
            connectedAt: s.connectedAt,
            idle: 0,
          }));
        };
        // Party line: DCC outgoing → botlink frames
        this.wirePartyLine(this._botLinkHub);
        await this._botLinkHub.listen();
        this.botLogger.info('Bot link hub started');
      } else {
        this._botLinkLeaf = new BotLinkLeaf(botlinkConfig, version, this.logger);
        this._botLinkLeaf.setCommandRelay(this.commandHandler, this.permissions);
        this._botLinkLeaf.onFrame = (frame) => {
          // Leaf applies state sync (hub is authoritative, so hub doesn't need this)
          ChannelStateSyncer.applyFrame(frame, this.channelState);
          PermissionSyncer.applyFrame(frame, this.permissions);
          // Sync complete notification
          if (frame.type === 'SYNC_END') {
            this.eventBus.emit('botlink:syncComplete', botlinkConfig.botname);
          }
          // BSAY: hub asks this leaf to send an IRC message
          if (frame.type === 'BSAY') {
            this.client.say(String(frame.target ?? ''), String(frame.message ?? ''));
          }
          this.handleIncomingBotlinkFrame(frame, isShared);
        };
        this._botLinkLeaf.onConnected = (hubName) =>
          this.eventBus.emit('botlink:connected', hubName);
        this._botLinkLeaf.onDisconnected = (reason) =>
          this.eventBus.emit('botlink:disconnected', 'hub', reason);
        // Party line: DCC outgoing → botlink frames
        this.wirePartyLine(this._botLinkLeaf);
        this._botLinkLeaf.connect();
        this.botLogger.info('Bot link leaf connecting to hub');
      }
      // Forward service NOTICE/PRIVMSG replies (NickServ, ChanServ, MemoServ…)
      // into any active virtual relay sessions on this bot. Independent of DCC
      // so leaves with DCC disabled still surface async service replies back
      // to the relay origin.
      this.attachRelayServiceMirror();
    }
    // Clean up orphaned relay virtual sessions when a linked bot disconnects.
    // Hoisted to a named field so shutdown() can remove it — if any code path
    // ever re-creates a Bot in the same process, the previous Bot would be
    // pinned by this listener's closure over _relayVirtualSessions.
    this._onBotlinkDisconnectedCleanup = (botname: string, _reason: string) => {
      for (const [handle, session] of this._relayVirtualSessions) {
        if (session.fromBot === botname) {
          this._relayVirtualSessions.delete(handle);
        }
      }
    };
    this.eventBus.on('botlink:disconnected', this._onBotlinkDisconnectedCleanup);
  }

  /** Register commands that need to know whether botlink/DCC/ban-store are live. */
  private registerPostLinkCommands(): void {
    registerBotlinkCommands(
      this.commandHandler,
      this._botLinkHub,
      this._botLinkLeaf,
      this.config.botlink ?? null,
      this.db,
      this._dccManager,
      (target, message) => this.client.say(target, message),
    );
    registerBanCommands({
      commandHandler: this.commandHandler,
      banStore: this.banStore,
      ircCommands: this.ircCommands,
      db: this.db,
      hub: this._botLinkHub,
      sharedBanList: this._sharedBanList,
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

    // Cancel any pending reconnect BEFORE tearing down the client so a
    // stray timer cannot fire mid-shutdown and re-open a socket.
    if (this._reconnectDriver) {
      this._reconnectDriver.cancel();
      this._reconnectDriver = null;
    }

    if (this._lifecycleHandle) {
      this._lifecycleHandle.stopPresenceCheck();
      this._lifecycleHandle.removeListeners();
      this._lifecycleHandle = null;
    }

    if (this._onBotlinkDisconnectedCleanup) {
      this.eventBus.off('botlink:disconnected', this._onBotlinkDisconnectedCleanup);
      this._onBotlinkDisconnectedCleanup = null;
    }

    if (this._botLinkHub) {
      this._botLinkHub.close();
      this._botLinkHub = null;
    }
    if (this._botLinkLeaf) {
      this._botLinkLeaf.disconnect();
      this._botLinkLeaf = null;
    }

    for (const { event, fn } of this._relayMirrorListeners) {
      this.client.removeListener(event, fn);
    }
    this._relayMirrorListeners = [];

    if (this._dccManager) {
      this._dccManager.detach('Bot shutting down.');
      this._dccManager = null;
    }

    this.memo.detach();
    this.services.detach();
    this.channelState.detach();

    if (this.bridge) {
      this.bridge.detach();
      this.bridge = null;
    }

    this.messageQueue.flush();
    this.messageQueue.stop();

    if (this.client.connected) {
      const quitMsg = this.config.quit_message ?? `HexBot v${this.readPackageVersion()}`;
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
    // Enforce any stored IRCv3 STS policy BEFORE we touch the socket. If
    // the policy upgrades us, mutate the in-memory config so downstream
    // code (message-queue cost calcs, logging, Services) sees a
    // TLS-consistent view for the rest of the session.
    this.applySTSPolicyToConfig();

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

  /** Build the relay sender and deps, then delegate to the extracted handler. */
  private _relayDeps(): import('./core/botlink').RelayHandlerDeps {
    const hub = this._botLinkHub;
    const leaf = this._botLinkLeaf;
    // Only called when a botlink link is live, so botlink config must be set.
    if (!this.config.botlink) {
      throw new Error('[bot] _relayDeps() called without botlink configured');
    }
    return {
      permissions: this.permissions,
      commandHandler: this.commandHandler,
      dccManager: this._dccManager,
      botname: this.config.botlink.botname,
      sender: {
        sendTo: (botname, frame) => {
          if (hub) return hub.send(botname, frame);
          return leaf?.send(frame) ?? false;
        },
        send: (frame) => {
          if (hub) hub.broadcast(frame);
          else leaf?.send(frame);
        },
      },
      stripFormatting,
      logger: this._relayLogger,
    };
  }

  /** Lazy-initialized child logger for the relay handler. */
  private _relayLoggerCache: LoggerLike | null = null;
  private get _relayLogger(): LoggerLike {
    this._relayLoggerCache ??= this.logger.child('botlink:relay');
    return this._relayLoggerCache;
  }

  /** IRC listeners that fan service notices/privmsgs out to virtual relay sessions. */
  private _relayMirrorListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  /**
   * Install IRC-client listeners that mirror incoming private NOTICE / PRIVMSG
   * lines to every active virtual relay session. Runs whether or not DCC is
   * enabled so leaf bots without a local console still relay service replies.
   */
  private attachRelayServiceMirror(): void {
    const forward = (line: string): void => {
      for (const vs of this._relayVirtualSessions.values()) {
        vs.sendOutput(line);
      }
    };
    const onNotice = (...args: unknown[]): void => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      if (/^[#&]/.test(target)) return;
      if (this.services.isNickServVerificationReply(nick, message)) return;
      forward(`-${sanitize(nick)}- ${sanitize(message)}`);
    };
    const onPrivmsg = (...args: unknown[]): void => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      if (/^[#&]/.test(target)) return;
      forward(`<${sanitize(nick)}> ${sanitize(message)}`);
    };
    this.client.on('notice', onNotice);
    this.client.on('privmsg', onPrivmsg);
    this._relayMirrorListeners.push({ event: 'notice', fn: onNotice });
    this._relayMirrorListeners.push({ event: 'privmsg', fn: onPrivmsg });
  }

  /** Handle incoming PROTECT_* frames — delegates to extracted handler with permission guards. */
  private handleProtectFrame(frame: LinkFrame): void {
    handleProtectFrame(frame, {
      channelState: this.channelState,
      permissions: this.permissions,
      ircCommands: this.ircCommands,
      botNick: this.config.irc.nick,
      casemapping: this._casemapping,
      sendAck: (ack) => {
        if (this._botLinkHub) this._botLinkHub.broadcast(ack);
        else this._botLinkLeaf?.send(ack);
      },
    });
  }

  /** Process an incoming botlink frame — shared between hub and leaf roles. */
  private handleIncomingBotlinkFrame(frame: LinkFrame, isShared: (ch: string) => boolean): void {
    // Party line: deliver incoming PARTY_CHAT/JOIN/PART to local DCC.
    // Strip IRC formatting from all frame fields to prevent control character injection.
    if (frame.type === 'PARTY_CHAT' && this._dccManager) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      const msg = stripFormatting(String(frame.message ?? ''));
      this._dccManager.announce(`<${handle}@${bot}> ${msg}`);
    }
    if (frame.type === 'PARTY_JOIN' && this._dccManager) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      this._dccManager.announce(`*** ${handle} has joined the console (on ${bot})`);
    }
    if (frame.type === 'PARTY_PART' && this._dccManager) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      this._dccManager.announce(`*** ${handle} has left the console (on ${bot})`);
    }
    // System announcements from linked bots
    if (frame.type === 'ANNOUNCE' && this._dccManager) {
      this._dccManager.announce(String(frame.message ?? ''));
    }
    // Ban sharing: apply incoming ban frames
    if (frame.type.startsWith('CHAN_BAN') || frame.type.startsWith('CHAN_EXEMPT')) {
      if (this._sharedBanList) {
        BanListSyncer.applyFrame(frame, this._sharedBanList, isShared);
      }
    }
    handleRelayFrame(frame, this._relayDeps(), this._relayVirtualSessions);
    this.handleProtectFrame(frame);
  }

  /** Virtual relay sessions on this bot (as target). */
  private _relayVirtualSessions: RelaySessionMap = new Map();

  /** Handler attached to `botlink:disconnected` — held for removal in shutdown(). */
  private _onBotlinkDisconnectedCleanup: ((botname: string, reason: string) => void) | null = null;

  /** Wire local DCC party line events to a botlink hub or leaf. */
  private wirePartyLine(link: BotLinkHub | BotLinkLeaf): void {
    if (!this._dccManager) return;
    if (!this.config.botlink) return;
    const botname = this.config.botlink.botname;
    const sendFrame = (frame: LinkFrame) => {
      if (link instanceof BotLinkHub) {
        link.broadcast(frame);
      } else {
        link.send(frame);
      }
    };
    this._dccManager.onPartyChat = (handle, message) => {
      sendFrame({ type: 'PARTY_CHAT', handle, fromBot: botname, message });
    };
    this._dccManager.onPartyJoin = (handle) => {
      sendFrame({ type: 'PARTY_JOIN', handle, fromBot: botname });
    };
    this._dccManager.onPartyPart = (handle) => {
      sendFrame({ type: 'PARTY_PART', handle, fromBot: botname });
    };
    this._dccManager.onRelayEnd = (handle, targetBot) => {
      const endFrame: LinkFrame = { type: 'RELAY_END', handle, reason: 'User ended relay' };
      // Send only to the involved bot — no need to broadcast RELAY_END to unrelated leaves.
      if (link instanceof BotLinkHub) {
        link.send(targetBot, endFrame);
        link.unregisterRelay(handle);
      } else {
        link.send(endFrame);
      }
    };
  }
}
