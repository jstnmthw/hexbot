// HexBot — Bot class
// Thin orchestrator that wires modules together. Creates and connects the
// pieces but delegates all real work to the individual modules.
import chalk from 'chalk';
import { Client as IrcClient } from 'irc-framework';
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandHandler } from './command-handler';
import { BotLinkHub, BotLinkLeaf } from './core/botlink';
import { BanListSyncer, SharedBanList } from './core/botlink-sharing';
import { ChannelStateSyncer, PermissionSyncer } from './core/botlink-sync';
import { ChannelSettings } from './core/channel-settings';
import { ChannelState } from './core/channel-state';
import { registerBotlinkCommands } from './core/commands/botlink-commands';
import { registerChannelCommands } from './core/commands/channel-commands';
import { registerDispatcherCommands } from './core/commands/dispatcher-commands';
import { registerIRCAdminCommands } from './core/commands/irc-commands-admin';
import { registerPermissionCommands } from './core/commands/permission-commands';
import { registerPluginCommands } from './core/commands/plugin-commands';
import {
  type ConnectionLifecycleHandle,
  registerConnectionEvents,
} from './core/connection-lifecycle';
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
import type { BotConfig } from './types';
import { buildSocksOptions } from './utils/socks';
import { requiresVerificationForFlags } from './utils/verify-flags';

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
  private _botLinkHub: BotLinkHub | null = null;
  private _botLinkLeaf: BotLinkLeaf | null = null;
  private _sharedBanList: SharedBanList | null = null;
  private _lifecycleHandle: ConnectionLifecycleHandle | null = null;
  private botLogger: Logger;
  private _casemapping: Casemapping = 'rfc1459';

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
  private bootStart: number = Date.now();
  private configuredChannels: Array<{ name: string; key?: string }> = [];

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
    this.permissions = new Permissions(this.db, this.logger, this.eventBus);
    this.dispatcher = new EventDispatcher(this.permissions, this.logger);
    this.commandHandler = new CommandHandler(this.permissions);
    this.client = new IrcClient();
    this.configuredChannels = this.config.irc.channels.map((entry) =>
      typeof entry === 'string' ? { name: entry } : { name: entry.name, key: entry.key },
    );
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

    // Wire input flood limiter
    if (this.config.flood) {
      this.dispatcher.setFloodConfig(this.config.flood);
    }
    this.dispatcher.setFloodNotice({
      sendNotice: (nick: string, msg: string) => {
        this.messageQueue.enqueue(() => this.client.notice(nick, msg));
      },
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
      getChannels: () => this.configuredChannels.map((c) => c.name),
      getBindCount: () => this.dispatcher.listBinds().length,
      getUserCount: () => this.permissions.listUsers().length,
    });
    registerPluginCommands(this.commandHandler, this.pluginLoader, resolve(this.config.pluginDir));
    registerChannelCommands(this.commandHandler, this.channelSettings);

    this.botLogger.info('Starting...');

    // 5. Attach bridge + core modules (register event listeners before connect
    //    so handlers are ready when the server starts sending events)
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

    // 6. Start DCC CHAT / botnet (if configured)
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

    // 7. Start bot link (if configured)
    if (this.config.botlink?.enabled) {
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
      if (this.config.botlink.role === 'hub') {
        this._botLinkHub = new BotLinkHub(this.config.botlink, version, this.logger);
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
        // Party line: deliver incoming PARTY_CHAT/JOIN/PART to local DCC
        this._botLinkHub.onLeafFrame = (_botname, frame) => {
          if (frame.type === 'PARTY_CHAT' && this._dccManager) {
            this._dccManager.announce(`<${frame.handle}@${frame.fromBot}> ${frame.message}`);
          }
          if (frame.type === 'PARTY_JOIN' && this._dccManager) {
            this._dccManager.announce(
              `*** ${frame.handle} has joined the console (on ${frame.fromBot})`,
            );
          }
          if (frame.type === 'PARTY_PART' && this._dccManager) {
            this._dccManager.announce(
              `*** ${frame.handle} has left the console (on ${frame.fromBot})`,
            );
          }
          // Ban sharing: apply incoming ban frames
          if (frame.type.startsWith('CHAN_BAN') || frame.type.startsWith('CHAN_EXEMPT')) {
            if (this._sharedBanList) {
              BanListSyncer.applyFrame(frame, this._sharedBanList, isShared);
            }
          }
          // Relay: handle frames targeted at this bot
          this.handleRelayFrame(frame);
          // Protection: act on PROTECT_* if we have ops
          this.handleProtectFrame(frame);
        };
        // Party line: provide local DCC sessions for PARTY_WHOM
        this._botLinkHub.getLocalPartyUsers = () => {
          if (!this._dccManager) return [];
          return this._dccManager.getSessionList().map((s) => ({
            handle: s.handle,
            nick: s.nick,
            botname: this.config.botlink!.botname,
            connectedAt: s.connectedAt,
            idle: 0,
          }));
        };
        // Party line: DCC outgoing → botlink frames
        this.wirePartyLine(this._botLinkHub);
        await this._botLinkHub.listen();
        this.botLogger.info('Bot link hub started');
      } else {
        this._botLinkLeaf = new BotLinkLeaf(this.config.botlink, version, this.logger);
        this._botLinkLeaf.setCommandRelay(this.commandHandler, this.permissions);
        this._botLinkLeaf.onFrame = (frame) => {
          ChannelStateSyncer.applyFrame(frame, this.channelState);
          PermissionSyncer.applyFrame(frame, this.permissions);
          // Party line: deliver incoming to local DCC
          if (frame.type === 'PARTY_CHAT' && this._dccManager) {
            this._dccManager.announce(`<${frame.handle}@${frame.fromBot}> ${frame.message}`);
          }
          if (frame.type === 'PARTY_JOIN' && this._dccManager) {
            this._dccManager.announce(
              `*** ${frame.handle} has joined the console (on ${frame.fromBot})`,
            );
          }
          if (frame.type === 'PARTY_PART' && this._dccManager) {
            this._dccManager.announce(
              `*** ${frame.handle} has left the console (on ${frame.fromBot})`,
            );
          }
          // Ban sharing: apply incoming ban frames
          if (frame.type.startsWith('CHAN_BAN') || frame.type.startsWith('CHAN_EXEMPT')) {
            if (this._sharedBanList) {
              BanListSyncer.applyFrame(frame, this._sharedBanList, isShared);
            }
          }
          // Relay: handle frames targeted at this bot
          this.handleRelayFrame(frame);
          // Protection: act on PROTECT_* if we have ops
          this.handleProtectFrame(frame);
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
    }
    registerBotlinkCommands(
      this.commandHandler,
      this._botLinkHub,
      this._botLinkLeaf,
      this.config.botlink ?? null,
      this._dccManager,
    );

    // 8. Load plugins (sets up binds before connection so all handlers are
    //    ready when the server starts sending JOIN/MODE/etc responses)
    await this.pluginLoader.loadAll();

    // 8. Connect to IRC (all handlers are registered — safe to receive events)
    await this.connect();

    // 9. Authenticate with NickServ (non-SASL fallback, needs active connection)
    this.services.identify();

    this.startTime = Date.now();
    const elapsed = this.startTime - this.bootStart;
    this.botLogger.info(`Ready in ${elapsed}ms`);
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    this.botLogger.info('Shutting down...');

    if (this._lifecycleHandle) {
      this._lifecycleHandle.stopPresenceCheck();
      this._lifecycleHandle = null;
    }

    if (this._botLinkHub) {
      this._botLinkHub.close();
      this._botLinkHub = null;
    }
    if (this._botLinkLeaf) {
      this._botLinkLeaf.disconnect();
      this._botLinkLeaf = null;
    }

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
    const options = this.buildClientOptions();
    this.botLogger.info(`Connecting to ${this.config.irc.host}:${this.config.irc.port}...`);
    return new Promise<void>((resolve, reject) => {
      this._lifecycleHandle = registerConnectionEvents(
        {
          client: this.client,
          config: this.config,
          configuredChannels: this.configuredChannels,
          eventBus: this.eventBus,
          applyCasemapping: (cm) => {
            this._casemapping = cm;
            this.channelState.setCasemapping(cm);
            this.permissions.setCasemapping(cm);
            this.dispatcher.setCasemapping(cm);
            this.services.setCasemapping(cm);
            if (this._dccManager) this._dccManager.setCasemapping(cm);
          },
          messageQueue: this.messageQueue,
          dispatcher: this.dispatcher,
          channelState: this.channelState,
          logger: this.botLogger,
        },
        resolve,
        reject,
      );
      this.client.connect(options);
    });
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

  /** Handle incoming RELAY_* frames (as the target or origin bot). */
  private handleRelayFrame(frame: import('./core/botlink').LinkFrame): void {
    const handle = String(frame.handle ?? '');

    if (frame.type === 'RELAY_REQUEST' && this._dccManager) {
      // This bot is the target — create a virtual relay session
      const user = this.permissions.getUser(handle);
      if (!user) {
        const rejectFrame = { type: 'RELAY_END', handle, reason: 'User not found' };
        if (this._botLinkHub) this._botLinkHub.broadcast(rejectFrame);
        else this._botLinkLeaf?.send(rejectFrame);
        return;
      }
      // Send RELAY_ACCEPT
      const acceptFrame = { type: 'RELAY_ACCEPT', handle, toBot: this.config.botlink!.botname };
      if (this._botLinkHub) this._botLinkHub.send(String(frame.fromBot ?? ''), acceptFrame);
      else this._botLinkLeaf?.send(acceptFrame);

      // Process incoming RELAY_INPUT via a relay session map (tracked below)
      this._relayVirtualSessions.set(handle, {
        fromBot: String(frame.fromBot ?? ''),
        sendOutput: (line: string) => {
          const outputFrame = { type: 'RELAY_OUTPUT', handle, line };
          if (this._botLinkHub) this._botLinkHub.send(String(frame.fromBot ?? ''), outputFrame);
          else this._botLinkLeaf?.send(outputFrame);
        },
      });
    }

    if (frame.type === 'RELAY_INPUT') {
      const vs = this._relayVirtualSessions.get(handle);
      if (vs) {
        const line = String(frame.line ?? '');
        if (line.startsWith('.')) {
          const user = this.permissions.getUser(handle);
          this.commandHandler
            .execute(line, {
              source: 'dcc',
              nick: user?.hostmasks[0]?.split('!')[0] || handle,
              ident: 'relay',
              hostname: 'relay',
              channel: null,
              reply: (msg: string) => {
                for (const part of msg.split('\n')) vs.sendOutput(part);
              },
            })
            .catch(() => {});
        } else {
          // Party line chat from relayed user
          if (this._dccManager) {
            this._dccManager.announce(`<${handle}@relay> ${line}`);
          }
          vs.sendOutput(`<${handle}> ${line}`);
        }
      }
    }

    if (frame.type === 'RELAY_OUTPUT' && this._dccManager) {
      // This bot is the origin — display output to the DCC session
      for (const session of this._dccManager.getSessionList()) {
        if (session.handle === handle) {
          const dccSession = this._dccManager.getSession(session.nick);
          dccSession?.writeLine(String(frame.line ?? ''));
        }
      }
    }

    if (frame.type === 'RELAY_END') {
      // Clean up virtual session if we're the target
      this._relayVirtualSessions.delete(handle);
      // Exit relay mode if we're the origin
      if (this._dccManager) {
        for (const s of this._dccManager.getSessionList()) {
          if (s.handle === handle) {
            const session = this._dccManager.getSession(s.nick);
            if (session?.isRelaying) {
              session.exitRelay();
              session.writeLine(`*** Relay to ${frame.reason ?? 'remote bot'} lost.`);
            }
          }
        }
      }
    }
  }

  /** Handle incoming PROTECT_* frames — act if this bot has ops. */
  private handleProtectFrame(frame: import('./core/botlink').LinkFrame): void {
    if (!frame.type.startsWith('PROTECT_') || frame.type === 'PROTECT_ACK') return;

    const channel = String(frame.channel ?? '');
    const nick = String(frame.nick ?? '');
    const ref = String(frame.ref ?? '');
    const requestedBy = String(frame.requestedBy ?? '');

    if (!channel || !nick) return;

    // Check if this bot has ops in the channel
    const ch = this.channelState.getChannel(channel);
    if (!ch) return;
    const botUser = ch.users.get(this.config.irc.nick.toLowerCase());
    const hasOps = botUser?.modes.includes('o') ?? false;

    const sendAck = (success: boolean, message?: string) => {
      const ack = { type: 'PROTECT_ACK', ref, success, message };
      if (this._botLinkHub) this._botLinkHub.broadcast(ack);
      else this._botLinkLeaf?.send(ack);
    };

    switch (frame.type) {
      case 'PROTECT_OP': {
        if (!hasOps) return;
        // Guard: only op nicks in the permissions DB
        if (!this.permissions.findByNick(nick)) {
          sendAck(false, `Nick "${nick}" not in permissions DB`);
          return;
        }
        this.ircCommands.op(channel, nick);
        sendAck(true);
        break;
      }
      case 'PROTECT_DEOP': {
        if (!hasOps) return;
        this.ircCommands.deop(channel, nick);
        sendAck(true);
        break;
      }
      case 'PROTECT_UNBAN': {
        if (!hasOps) return;
        // Unban is best-effort — we can't know all matching bans without querying the server
        this.ircCommands.mode(channel, '-b', nick);
        sendAck(true);
        break;
      }
      case 'PROTECT_INVITE': {
        this.ircCommands.invite(channel, nick);
        sendAck(true);
        break;
      }
      case 'PROTECT_KICK': {
        if (!hasOps) return;
        const reason = String(frame.reason ?? `Requested by ${requestedBy}`);
        this.ircCommands.kick(channel, nick, reason);
        sendAck(true);
        break;
      }
    }
  }

  /** Virtual relay sessions on this bot (as target). */
  private _relayVirtualSessions: Map<
    string,
    { fromBot: string; sendOutput: (line: string) => void }
  > = new Map();

  /** Wire local DCC party line events to a botlink hub or leaf. */
  private wirePartyLine(link: BotLinkHub | BotLinkLeaf): void {
    if (!this._dccManager) return;
    const botname = this.config.botlink!.botname;
    const sendFrame = (frame: import('./core/botlink').LinkFrame) => {
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
    this._dccManager.onRelayEnd = (handle, _targetBot) => {
      sendFrame({ type: 'RELAY_END', handle, reason: 'User ended relay' });
    };
  }

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
