// HexBot — Bot class
// Thin orchestrator that wires modules together. Creates and connects the
// pieces but delegates all real work to the individual modules.
import chalk from 'chalk';
import { Client as IrcClient } from 'irc-framework';
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Bootstrap, loadBootstrap } from './bootstrap';
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
import { registerSettingsCommands } from './core/commands/settings-commands';
import {
  type ConnectionLifecycleHandle,
  registerConnectionEvents,
} from './core/connection-lifecycle';
import { DCCManager } from './core/dcc';
import { HelpRegistry } from './core/help-registry';
import { IRCCommands } from './core/irc-commands';
import { MemoManager } from './core/memo';
import { MessageQueue } from './core/message-queue';
import type { LogModActionOptions } from './core/mod-log';
import { ensureOwner } from './core/owner-bootstrap';
import { Permissions } from './core/permissions';
import {
  type ReconnectDriver,
  type ReconnectState,
  createReconnectDriver,
} from './core/reconnect-driver';
import { RelayOrchestrator } from './core/relay-orchestrator';
import { seedFromJson } from './core/seed-from-json';
import { Services } from './core/services';
import { SettingsRegistry } from './core/settings-registry';
import { STSStore, enforceSTS } from './core/sts';
import { BotDatabase } from './database';
import { EventDispatcher } from './dispatcher';
import type { VerificationProvider } from './dispatcher';
import { BotEventBus } from './event-bus';
import { IRCBridge } from './irc-bridge';
import { type LogLevel, type LoggerLike, createLogger } from './logger';
import { PluginLoader } from './plugin-loader';
import type { BotConfig, Casemapping, ChannelEntry } from './types';
import { buildSocksOptions } from './utils/socks';
import { requiresVerificationForFlags, validateRequireAccFor } from './utils/verify-flags';
import { ircLower } from './utils/wildcard';

// ---------------------------------------------------------------------------
// Secret file permission checks
// ---------------------------------------------------------------------------

/**
 * Enforce POSIX-mode permissions on a file that holds credentials. World-
 * readable is always fatal (other local users can cat the file); group-
 * readable is a warning unless `fatal` is true. Silent when the file is
 * unreadable — `accessSync` already handled "not found" at the config
 * path.
 */
function enforceSecretFilePermissions(path: string, opts: { fatal: boolean }): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    // stat failed — caller's readability check already ran or the file
    // simply doesn't exist. Not our job to report that here.
    return;
  }
  const octal = (mode & 0o777).toString(8);
  if (mode & 0o004) {
    console.error(`[bot] SECURITY: ${path} is world-readable (mode ${octal})`);
    console.error(`[bot] Run: chmod 600 ${path}`);
    if (opts.fatal) process.exit(1);
    return;
  }
  if (mode & 0o040) {
    console.error(
      `[security] ${path} is group-readable (mode ${octal}) — consider chmod 600 ${path}`,
    );
  }
}

/**
 * Check `.env`, `.env.local`, and `.env.<NODE_ENV>` in the project root for
 * overly permissive modes. These aren't consumed directly by hexbot (secrets
 * land in config via `_env` fields), but operators typically keep
 * credentials there and the shell that launched the bot has already
 * sourced them into the process env. A world-readable file on a shared
 * host is functionally a credential leak, so we abort; group-readable
 * earns a `[security]` warning.
 */
function checkDotenvPermissions(): void {
  const env = process.env.NODE_ENV;
  // Cover both root-level `.env` files and the `config/bot.env*` variants
  // operators commonly use for hexbot-specific secrets. The set mirrors the
  // resolution order documented in `config/bot.env.example`.
  const candidates = ['.env', '.env.local', 'config/bot.env', 'config/bot.env.local'];
  if (env) {
    candidates.push(`.env.${env}`);
    candidates.push(`config/bot.env.${env}`);
  }
  for (const name of candidates) {
    const path = resolve(name);
    enforceSecretFilePermissions(path, { fatal: true });
  }
}

// ---------------------------------------------------------------------------
// STS refusal error
// ---------------------------------------------------------------------------

/**
 * Thrown from `Bot.connect()` when a stored IRCv3 STS policy refuses the
 * current connection (typically plaintext-with-existing-TLS-policy or
 * downgrade detection). The thrower wants exit code 2 — a permanent-failure
 * tier the supervisor must not restart-loop on — but going through this
 * typed error rather than `process.exit(2)` lets `Bot.start()` run the
 * normal graceful shutdown chain first (db.close, plugin teardown, queue
 * drain) instead of leaking WAL files and dangling sockets.
 */
export class STSRefusalError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'STSRefusalError';
  }
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
  readonly logger: LoggerLike;

  readonly pluginLoader: PluginLoader;
  readonly channelSettings: ChannelSettings;
  /** Core-scope settings registry — bot-wide live config. Owner: `'bot'`. */
  readonly coreSettings: SettingsRegistry;
  /** Per-plugin settings registries, keyed by pluginId. Created lazily by the loader. */
  readonly pluginSettings: Map<string, SettingsRegistry> = new Map();
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
  /**
   * Set on the first call to {@link shutdown}. Guards against a second
   * SIGINT/SIGTERM (or a direct test-harness invocation) racing the first
   * tear-down: every step is idempotent, but the 500ms QUIT-drain wait is
   * not — without this flag a double-shutdown would stack two waits and
   * double-close the db after one already ran.
   */
  private _isShuttingDown = false;
  /**
   * True after {@link start} has run to completion. Symmetric with
   * `_isShuttingDown` so a double-`start()` no-ops instead of restamping
   * `startTime` (which would reset visible uptime everywhere) and re-
   * running the connect/attach plumbing.
   */
  private _isStarted = false;

  /** Bot config path captured during construction so `.rehash` can re-read it on demand. */
  private readonly _botConfigPath: string;

  /** Snapshot of the reconnect driver state — used by the `.status` command. */
  getReconnectState(): ReconnectState | null {
    return this._reconnectDriver?.getState() ?? null;
  }

  getCasemapping(): Casemapping {
    return this._casemapping;
  }

  /**
   * Snapshot of audit rows that could not be persisted to SQLite. Returns
   * a defensive copy so callers can iterate without seeing concurrent
   * mutations. Used by `.status` and ops triage.
   */
  getAuditFallbackBuffer(): LogModActionOptions[] {
    return this.auditFallbackBuffer.slice();
  }

  /**
   * Number of audit rows currently held in the fallback ring buffer plus
   * how many were dropped due to overflow. `dropped` is monotonic for
   * the bot's lifetime — it does not reset when the buffer is read.
   */
  getAuditFallbackStats(): { held: number; dropped: number } {
    return { held: this.auditFallbackBuffer.length, dropped: this.auditFallbackOverflowCount };
  }

  /**
   * Append an audit-fallback entry. FIFO-evicts the oldest entry once
   * the buffer is full so memory cannot grow unbounded during a long
   * degraded period.
   */
  private pushAuditFallback(options: LogModActionOptions): void {
    if (this.auditFallbackBuffer.length >= Bot.AUDIT_FALLBACK_CAPACITY) {
      this.auditFallbackBuffer.shift();
      this.auditFallbackOverflowCount++;
    }
    this.auditFallbackBuffer.push(options);
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
   * grepping logs.
   */
  private failedPlugins: string[] = [];

  /**
   * In-memory ring buffer of audit-log writes that the SQLite layer
   * could not persist (SQLITE_BUSY/FULL/IOERR). Wired as the database's
   * `setAuditFallback` sink so disk-full or fatal-DB conditions don't
   * silently lose audit rows. The buffer is bounded — old entries are
   * dropped FIFO when the cap is reached so a long degraded period
   * doesn't bloat memory. Operators see the count via `.status`; the
   * raw entries can be retrieved by core commands for triage.
   */
  private static readonly AUDIT_FALLBACK_CAPACITY = 256;
  private auditFallbackBuffer: LogModActionOptions[] = [];
  private auditFallbackOverflowCount = 0;
  /**
   * Bootstrap settings captured in the constructor and consumed at start()
   * — only the env-only flags (e.g. `HEX_FAIL_ON_PLUGIN_LOAD_FAILURE`) live
   * here; the other fields are folded into BotConfig and accessed from there.
   */
  private bootstrap: Bootstrap;

  constructor(configPath?: string) {
    // Bootstrap MUST run before loadConfig: the database path, plugin
    // directory, and initial owner identity are env-sourced now (they
    // are needed before the SQLite KV is open) so we read them up-front
    // and fold them into the runtime BotConfig that loadConfig returns.
    let bootstrap: Bootstrap;
    try {
      bootstrap = loadBootstrap();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Prefix with `<3>` (systemd / journald priority for ERR) so
      // `journalctl -p err` surfaces this without a structured logger —
      // the logger needs config that we just failed to load.
      console.error(`<3>[bootstrap] ${message}`);
      process.exit(1);
    }
    this.bootstrap = bootstrap;

    const cfgPath = resolve(configPath ?? './config/bot.json');
    this._botConfigPath = cfgPath;
    this.config = this.loadConfig(cfgPath, bootstrap);

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

    this.coreSettings = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db: this.db,
      logger: this.logger.child('core-settings'),
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      helpRegistry: this.helpRegistry,
      scopeLabel: 'core',
      scopeSummary: 'Bot-wide singletons (logging, queue, flood, services, dcc, ...)',
      commandPrefix: this.config.command_prefix ?? '.',
    });
    this.registerCoreSettings();

    // SQLITE_CORRUPT / NOTADB / IOERR* used to call process.exit(2) directly
    // from inside runClassified, skipping every teardown step. Ask the DB to
    // poke us instead — we kick off a graceful shutdown on the next microtask
    // so the synchronous read/write that surfaced the error has unwound.
    this.db.setOnFatal(() => this.scheduleFatalShutdown());

    this.wireDispatcher();
    this.pluginLoader = this.createPluginLoader();
  }

  /**
   * Schedule an asynchronous `shutdown()` followed by `process.exit(2)`.
   * Fired from a fatal-DB observer; reentrancy is guarded by both the
   * `_fatalShutdownScheduled` flag here and `_isShuttingDown` inside
   * {@link shutdown}, so multiple fatal errors collapse into one exit.
   */
  private _fatalShutdownScheduled = false;
  private scheduleFatalShutdown(): void {
    if (this._fatalShutdownScheduled) return;
    this._fatalShutdownScheduled = true;
    queueMicrotask(() => {
      void this.shutdown()
        .catch((err) => this.botLogger.error('shutdown after fatal DB error threw:', err))
        .finally(() => process.exit(2));
    });
  }

  /**
   * Register every core-scope setting def + its onChange listener.
   * Mirrors the matrix in docs/plans/live-config-updates.md §4: live
   * keys apply on the spot, reload keys reattach a subsystem, restart
   * keys warn the operator that a process restart is needed.
   *
   * Defs are registered directly (rather than via Zod schema
   * reflection) so each onChange listener can close over the bot's
   * wired subsystems. Reload classes still match the Zod `.describe`
   * tokens in `src/config/schemas.ts` so introspection sees the same
   * contract.
   *
   * Skipped here (handled out-of-band): array-typed settings
   * (`irc.channels`, `channel_retry_schedule_ms`, `identity.require_acc_for`,
   * `botlink.auth_ip_whitelist`) and tuple-typed `dcc.port_range`. These
   * read from `this.config` directly until typed-array support lands.
   */
  private registerCoreSettings(): void {
    // Live keys — apply via onChange dispatch below.
    this.coreSettings.register('bot', [
      {
        key: 'logging.level',
        type: 'string',
        default: 'info',
        description: 'Minimum log level',
        allowedValues: ['debug', 'info', 'warn', 'error'],
        reloadClass: 'live',
      },
      {
        key: 'logging.mod_actions',
        type: 'flag',
        default: true,
        description: 'Persist privileged actions to mod_log',
        reloadClass: 'live',
      },
      {
        key: 'logging.mod_log_retention_days',
        type: 'int',
        default: 0,
        description: 'mod_log retention window in days (0 = unlimited)',
        reloadClass: 'live',
      },
      {
        key: 'queue.rate',
        type: 'int',
        default: 2,
        description: 'Outbound message rate (msgs/sec)',
        reloadClass: 'live',
      },
      {
        key: 'queue.burst',
        type: 'int',
        default: 4,
        description: 'Outbound message burst size',
        reloadClass: 'live',
      },
      {
        key: 'flood.pub.count',
        type: 'int',
        default: 0,
        description: 'Pub/pubm flood window count (0 = disabled)',
        reloadClass: 'live',
      },
      {
        key: 'flood.pub.window',
        type: 'int',
        default: 0,
        description: 'Pub/pubm flood window seconds',
        reloadClass: 'live',
      },
      {
        key: 'flood.msg.count',
        type: 'int',
        default: 0,
        description: 'Msg/msgm flood window count (0 = disabled)',
        reloadClass: 'live',
      },
      {
        key: 'flood.msg.window',
        type: 'int',
        default: 0,
        description: 'Msg/msgm flood window seconds',
        reloadClass: 'live',
      },
      {
        key: 'memo.memoserv_relay',
        type: 'flag',
        default: true,
        description: 'Relay MemoServ notices to console',
        reloadClass: 'live',
      },
      {
        key: 'memo.memoserv_nick',
        type: 'string',
        default: 'MemoServ',
        description: 'MemoServ service nick',
        reloadClass: 'live',
      },
      {
        key: 'memo.delivery_cooldown_seconds',
        type: 'int',
        default: 60,
        description: 'Per-user join-delivery cooldown (sec)',
        reloadClass: 'live',
      },
      {
        key: 'quit_message',
        type: 'string',
        default: '',
        description: 'Server-visible QUIT message',
        reloadClass: 'live',
      },
      {
        key: 'channel_rejoin_interval_ms',
        type: 'int',
        default: 30000,
        description: 'Periodic presence-check interval (ms)',
        reloadClass: 'live',
      },
      {
        key: 'services.identify_before_join',
        type: 'flag',
        default: false,
        description: 'Wait for bot:identified before JOIN',
        reloadClass: 'live',
      },
      {
        key: 'services.identify_before_join_timeout_ms',
        type: 'int',
        default: 10000,
        description: 'Identify-before-join timeout (ms)',
        reloadClass: 'live',
      },
      {
        key: 'services.services_host_pattern',
        type: 'string',
        default: '',
        description: 'NickServ services-host wildcard match',
        reloadClass: 'live',
      },
      {
        key: 'dcc.require_flags',
        type: 'string',
        default: 'm',
        description: 'Flags required to open a DCC session',
        reloadClass: 'live',
      },
      {
        key: 'dcc.max_sessions',
        type: 'int',
        default: 5,
        description: 'Max concurrent DCC sessions',
        reloadClass: 'live',
      },
      {
        key: 'dcc.idle_timeout_ms',
        type: 'int',
        default: 300000,
        description: 'DCC idle disconnect (ms)',
        reloadClass: 'live',
      },
      // Reload-class keys — onReload reattaches the relevant subsystem.
      {
        key: 'irc.nick',
        type: 'string',
        default: '',
        description: 'Primary nick (live: triggers NICK)',
        reloadClass: 'reload',
        onReload: (value) => {
          if (typeof value === 'string' && value.length > 0) {
            this.client.changeNick(value);
          }
        },
      },
      // Restart-class keys — read at boot only. The onRestartRequired
      // closures explain why so the operator-facing reply is specific.
      {
        key: 'irc.host',
        type: 'string',
        default: '',
        description: 'IRC server host (effective on next connect)',
        reloadClass: 'restart',
      },
      {
        key: 'irc.port',
        type: 'int',
        default: 0,
        description: 'IRC server port (effective on next connect)',
        reloadClass: 'restart',
      },
      {
        key: 'irc.tls',
        type: 'flag',
        default: true,
        description: 'TLS for the IRC connection (effective on next connect)',
        reloadClass: 'restart',
      },
      {
        key: 'irc.username',
        type: 'string',
        default: '',
        description: 'USER ident (sent at registration)',
        reloadClass: 'restart',
      },
      {
        key: 'irc.realname',
        type: 'string',
        default: '',
        description: 'GECOS / realname (sent at registration)',
        reloadClass: 'restart',
      },
      {
        key: 'identity.method',
        type: 'string',
        default: 'hostmask',
        description: 'Identity verification method',
        allowedValues: ['hostmask'],
        reloadClass: 'restart',
      },
      {
        key: 'services.type',
        type: 'string',
        default: 'none',
        description: 'Services flavor',
        allowedValues: ['atheme', 'anope', 'dalnet', 'none'],
        reloadClass: 'restart',
      },
      {
        key: 'services.nickserv',
        type: 'string',
        default: 'NickServ',
        description: 'NickServ target',
        reloadClass: 'restart',
      },
      {
        key: 'services.sasl',
        type: 'flag',
        default: false,
        description: 'SASL at registration',
        reloadClass: 'restart',
      },
      {
        key: 'services.sasl_mechanism',
        type: 'string',
        default: 'PLAIN',
        description: 'SASL mechanism',
        allowedValues: ['PLAIN', 'EXTERNAL'],
        reloadClass: 'restart',
      },
      {
        key: 'pluginsConfig',
        type: 'string',
        default: '',
        description: 'plugins.json path (read at loadAll)',
        reloadClass: 'restart',
      },
      {
        key: 'command_prefix',
        type: 'string',
        default: '.',
        description: 'Built-in admin command prefix',
        reloadClass: 'restart',
      },
    ]);

    // Single onChange dispatcher — the registry fans every change
    // here so subsystem reattach + state rebuilds live in one place.
    this.coreSettings.onChange('bot', (_instance, key, value) => {
      this.applyCoreSettingChange(key, value);
    });
  }

  /**
   * Dispatch a `core.<key>` change to the relevant subsystem. Restart-
   * class keys land here too but no-op (the `restart` reload class on
   * the def handles operator messaging via the registry's outcome).
   */
  private applyCoreSettingChange(key: string, value: unknown): void {
    switch (key) {
      case 'logging.level':
        if (typeof value === 'string') this.logger.setLevel(value as LogLevel);
        return;
      case 'logging.mod_actions':
        if (typeof value === 'boolean') this.db.setModLogEnabled(value);
        return;
      case 'logging.mod_log_retention_days':
        if (typeof value === 'number') this.db.setModLogRetentionDays(value);
        return;
      case 'queue.rate':
      case 'queue.burst': {
        const rate = this.coreSettings.getInt('', 'queue.rate') || this.config.queue?.rate || 2;
        const burst = this.coreSettings.getInt('', 'queue.burst') || this.config.queue?.burst || 4;
        this.messageQueue.setRate(rate, burst);
        return;
      }
      case 'flood.pub.count':
      case 'flood.pub.window':
      case 'flood.msg.count':
      case 'flood.msg.window': {
        const pubCount = this.coreSettings.getInt('', 'flood.pub.count');
        const pubWindow = this.coreSettings.getInt('', 'flood.pub.window');
        const msgCount = this.coreSettings.getInt('', 'flood.msg.count');
        const msgWindow = this.coreSettings.getInt('', 'flood.msg.window');
        const next: {
          pub?: { count: number; window: number };
          msg?: { count: number; window: number };
        } = {};
        if (pubCount > 0 && pubWindow > 0) next.pub = { count: pubCount, window: pubWindow };
        if (msgCount > 0 && msgWindow > 0) next.msg = { count: msgCount, window: msgWindow };
        this.dispatcher.setFloodConfig(next);
        return;
      }
      case 'memo.memoserv_relay':
      case 'memo.memoserv_nick':
      case 'memo.delivery_cooldown_seconds':
        this.memo.setConfig({
          memoserv_relay: this.coreSettings.getFlag('', 'memo.memoserv_relay'),
          memoserv_nick: this.coreSettings.getString('', 'memo.memoserv_nick') || 'MemoServ',
          delivery_cooldown_seconds: this.coreSettings.getInt('', 'memo.delivery_cooldown_seconds'),
        });
        return;
      case 'channel_rejoin_interval_ms':
        // The lifecycle handle isn't built until connect(); on next
        // reconnect it picks up this.config.channel_rejoin_interval_ms.
        // Update the in-memory config too so a mid-session reconnect
        // sees the new value.
        if (typeof value === 'number') this.config.channel_rejoin_interval_ms = value;
        return;
      case 'quit_message':
        if (typeof value === 'string') this.config.quit_message = value;
        return;
      case 'services.services_host_pattern':
        if (typeof value === 'string' && this.services) {
          // Services reads this on every NickServ NOTICE; mutating the
          // config record is enough — no rebuild needed.
          this.config.services.services_host_pattern = value;
        }
        return;
      case 'services.identify_before_join':
        if (typeof value === 'boolean') this.config.services.identify_before_join = value;
        return;
      case 'services.identify_before_join_timeout_ms':
        if (typeof value === 'number') this.config.services.identify_before_join_timeout_ms = value;
        return;
      case 'dcc.require_flags':
        if (typeof value === 'string' && this.config.dcc) this.config.dcc.require_flags = value;
        return;
      case 'dcc.max_sessions':
        if (typeof value === 'number' && this.config.dcc) this.config.dcc.max_sessions = value;
        return;
      case 'dcc.idle_timeout_ms':
        if (typeof value === 'number' && this.config.dcc) this.config.dcc.idle_timeout_ms = value;
        return;
      default:
        // Plugin lifecycle: `core.plugins.<id>.enabled` toggles the plugin
        // load state at runtime. `.set core plugins.<id>.enabled false`
        // stops and unloads the plugin; `true` loads it. The state
        // persists in KV, so a restart preserves the operator's choice.
        if (key.startsWith('plugins.') && key.endsWith('.enabled')) {
          const pluginId = key.slice('plugins.'.length, -'.enabled'.length);
          if (typeof value === 'boolean') {
            void this.applyPluginEnabled(pluginId, value);
          }
          return;
        }
        // Restart-class keys land here — no live action; the `restart`
        // reload class on the def is what surfaces the warning to the
        // operator via the registry's `applyReloadClass` outcome.
        return;
    }
  }

  /**
   * Apply a `core.plugins.<id>.enabled` change to the running loader.
   * `true` → load the plugin if not already loaded. `false` → unload
   * if currently loaded. Idempotent both ways so a redundant `.set`
   * never double-loads or double-unloads. Errors are logged loudly so
   * an operator who saw the change ack but not the load can investigate.
   */
  private async applyPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const isLoaded = this.pluginLoader.isLoaded(pluginId);
    if (enabled && !isLoaded) {
      const pluginPath = `${resolve(this.config.pluginDir)}/${pluginId}/dist/index.js`;
      const result = await this.pluginLoader.load(pluginPath);
      if (result.status !== 'ok') {
        this.botLogger.error(
          `Plugin "${pluginId}" enable via .set failed: ${result.error ?? 'unknown error'}`,
        );
      }
      return;
    }
    if (!enabled && isLoaded) {
      try {
        await this.pluginLoader.unload(pluginId);
      } catch (err) {
        this.botLogger.error(`Plugin "${pluginId}" disable via .set failed:`, err);
      }
      return;
    }
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
    // Construct the help corpus before CommandHandler so every
    // registerCommand call from boot-time mirrors into the shared registry.
    const helpRegistry = new HelpRegistry(this.logger.child('help-registry'));
    const commandHandler = new CommandHandler(
      permissions,
      this.config.command_prefix,
      helpRegistry,
    );
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
    // Route mutating verbs (KICK/MODE/TOPIC/INVITE/JOIN-with-key) through
    // the same per-target token bucket that paces say/notice. Without this
    // the helper layer bypasses the 2 msg/s steady-state cap and a chanmod
    // mass re-op or bulk .ban can trip Excess Flood.
    ircCommands.setMessageQueue(messageQueue);
    const services = new Services({
      client,
      servicesConfig: this.config.services,
      eventBus,
      logger: this.logger,
      db,
      botNick: this.config.irc.nick,
      channelState,
    });
    const channelSettings = new ChannelSettings(
      db,
      this.logger.child('channel-settings'),
      (s) => ircLower(s, this.getCasemapping()),
      {
        helpRegistry,
        scopeSummary: 'Per-channel overrides registered by plugins (chanmod, greeter, ...)',
        commandPrefix: this.config.command_prefix ?? '.',
      },
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
    // actually recognized.
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
    } else if (
      this.config.identity.require_acc_for.length > 0 &&
      this.config.services.type === 'none'
    ) {
      // The operator asked for an ACC gate but the network has no services to
      // verify against. Silently dropping the gate would leave privileged
      // dispatch passing on hostmask alone — exactly the thing `require_acc_for`
      // was configured to prevent. Warn loudly so the misconfig is visible in
      // the startup log rather than surfacing later as a mysterious bypass.
      this.botLogger?.warn(
        `[security] identity.require_acc_for=${JSON.stringify(this.config.identity.require_acc_for)} ` +
          `is set but services.type="none" — NO ACC verification will run on these flags. ` +
          `Either enable services or remove require_acc_for to clear this warning.`,
      );
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
    // Tracked under the 'bot' owner so shutdown's removeByOwner sweeps it;
    // bare `.on()` would survive the bus if a future refactor re-runs
    // wireDispatcher.
    this.eventBus.trackListener('bot', 'bot:disconnected', () => {
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
      botVersion: this.readPackageVersion(),
      ircClient: this.client,
      channelState: this.channelState,
      ircCommands: this.ircCommands,
      messageQueue: this.messageQueue,
      services: this.services,
      helpRegistry: this.helpRegistry,
      channelSettings: this.channelSettings,
      coreSettings: this.coreSettings,
      pluginSettings: this.pluginSettings,
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
    if (this._isStarted) {
      this.botLogger.warn('start() called twice — ignoring (uptime stays anchored to first start)');
      return;
    }
    this._isStarted = true;
    this.printBanner();

    this.db.open();
    this.botLogger.info('Database opened');
    // Wire audit fallback: when an audit row cannot be persisted to
    // SQLite (busy/full/fatal), spill it into a bounded in-memory ring
    // buffer instead of dropping it silently. Surfaced via `.status`
    // so operators see the count during a degraded period.
    this.db.setAuditFallback((options) => this.pushAuditFallback(options));
    this.permissions.loadFromDb();

    // Boot-time seed: any registered core-scope key that has no stored
    // value yet pulls its initial value from bot.json. KV is canonical
    // after first boot; an operator-set value never gets clobbered by
    // a routine restart. `.rehash` is the deliberate path to pull JSON
    // edits in — see docs/plans/live-config-updates.md §1.
    seedFromJson(this.coreSettings, this.config as unknown as Record<string, unknown>, {
      seedOnly: true,
    });
    // Re-apply log level from KV in case the operator set a different
    // level than bot.json carries — `setLevel` is idempotent and the
    // initial logger was constructed from the file value.
    const storedLevel = this.coreSettings.getString('', 'logging.level');
    if (storedLevel) this.logger.setLevel(storedLevel as LogLevel);

    await ensureOwner({
      config: this.config,
      permissions: this.permissions,
      logger: this.botLogger,
    });

    // One-shot sweep for weak hostmasks on privileged users — surfaces at
    // startup instead of only firing when a record is touched, so operators
    // see the full picture up front.
    this.permissions.auditWeakHostmasks();

    // Surface plaintext-NickServ risks at startup. The SASL-PLAIN-over-
    // plaintext path is fatal in validateResolvedSecrets, but the non-SASL
    // IDENTIFY and GHOST password paths are not — operators flipping
    // `sasl: false` to support a legacy network (or enabling
    // ghost_on_recover on a plaintext link) silently lose TLS protection of
    // the password. Warn loudly. See SECURITY.md §3.2.
    this.warnServicesPlaintextRisks();

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
    // until a user report landed.
    this.failedPlugins = pluginResults.filter((r) => r.status === 'error').map((r) => r.name);
    if (this.failedPlugins.length > 0) {
      this.botLogger.error(
        `===== STARTUP BANNER: ${this.failedPlugins.length} plugin(s) FAILED to load: ${this.failedPlugins.join(', ')} — the bot is running with degraded functionality. Check the error lines above for details. =====`,
      );
      // Fail-fast for CI/staging: when HEX_FAIL_ON_PLUGIN_LOAD_FAILURE is set
      // we'd rather take the bot down than ship a regression to production.
      // Default off so a single bad plugin doesn't take prod offline.
      if (this.bootstrap.failOnPluginLoadFailure) {
        throw new Error(
          `Plugin load failed (${this.failedPlugins.length}: ${this.failedPlugins.join(', ')}); ` +
            `HEX_FAIL_ON_PLUGIN_LOAD_FAILURE is set — exiting non-zero.`,
        );
      }
    }

    // Re-anchor uptime to the first `bot:connected` event so `.status`
    // reports the connected-window. `connect()` resolves before
    // registration succeeds; we defer the anchor to the actual event
    // so a long initial backoff doesn't make uptime show "negative"
    // values. The listener is one-shot — every subsequent reconnect leaves
    // `startTime` anchored to the original first-connect moment, which
    // matches operator expectations for "uptime since the bot started
    // serving."
    let startTimeAnchored = false;
    this.eventBus.trackListener('bot', 'bot:connected', () => {
      if (startTimeAnchored) return;
      startTimeAnchored = true;
      this.startTime = Date.now();
    });

    this.scheduleKvMaintenance();

    // Connect to IRC (all handlers are registered — safe to receive events).
    // NickServ IDENTIFY (non-SASL fallback) is triggered from the `registered`
    // handler in connection-lifecycle, BEFORE joinConfiguredChannels: this
    // ensures channels with mode +r (registered-nicks-only) accept us on the
    // first JOIN attempt rather than bouncing us with a 477 numeric.
    await this.connect();
  }

  /**
   * Long-uptime hygiene for the `kv` table. Two timers (both `unref`'d so
   * they never block shutdown):
   *
   *   - daily prune: walks a known-namespace retention table and drops
   *     rows older than the per-namespace TTL. Plugins with their own
   *     sweeps (seen, ai-chat) keep theirs; this is the safety net for
   *     long-running deployments where ad-hoc plugin state otherwise
   *     accumulates forever.
   *   - monthly VACUUM: reclaims pages freed by the prune. Holds an
   *     exclusive lock for the duration, so we run it 03:00-aligned to
   *     coincide with the typical low-traffic window.
   */
  private kvDailyTimer: ReturnType<typeof setInterval> | null = null;
  private kvMonthlyTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly KV_RETENTION_DAYS: ReadonlyArray<{ ns: string; days: number }> = [
    // ai-chat per-channel rate-limit / mood / token-budget rows: 30 days
    // is well past any active conversation window.
    { ns: 'plugin:ai-chat', days: 30 },
    // seen plugin: enforced cap is 10000 + size cap; this is the
    // belt-and-braces for ancient idle channels the cap never reaches.
    { ns: 'plugin:seen', days: 90 },
    // social-tracker / spotify-radio / topic / chanmod: each plugin
    // holds onto state by user / channel. 90d covers active operator
    // tenure without dropping a still-active record.
    { ns: 'plugin:social-tracker', days: 90 },
    { ns: 'plugin:spotify-radio', days: 90 },
    { ns: 'plugin:topic', days: 365 },
    { ns: 'plugin:chanmod', days: 90 },
    { ns: 'plugin:flood', days: 30 },
    { ns: 'plugin:greeter', days: 365 },
    { ns: 'plugin:rss', days: 7 },
  ];
  private scheduleKvMaintenance(): void {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const dailyPrune = (): void => {
      let totalPruned = 0;
      for (const { ns, days } of Bot.KV_RETENTION_DAYS) {
        try {
          totalPruned += this.db.pruneOlderThan(ns, days);
        } catch (err) {
          this.botLogger.warn(`kv prune failed for ${ns}:`, err);
        }
      }
      if (totalPruned > 0) {
        this.botLogger.info(`kv daily prune: removed ${totalPruned} stale row(s)`);
      }
    };
    this.kvDailyTimer = setInterval(dailyPrune, ONE_DAY);
    this.kvDailyTimer.unref?.();

    const monthlyVacuum = (): void => {
      try {
        this.db.vacuum();
        this.botLogger.info('kv VACUUM complete');
      } catch (err) {
        this.botLogger.warn('kv VACUUM failed:', err);
      }
    };
    this.kvMonthlyTimer = setInterval(monthlyVacuum, 30 * ONE_DAY);
    this.kvMonthlyTimer.unref?.();
  }

  /**
   * Surface plaintext-NickServ risks at startup. SASL PLAIN over plaintext is
   * fatal in `validateResolvedSecrets`, but two adjacent paths still ship the
   * password in cleartext when `irc.tls=false`:
   *   1. Non-SASL `IDENTIFY` — when `services.password` is set and
   *      `services.sasl` is false, `services.identify()` PRIVMSGs the
   *      password to NickServ on the unencrypted session.
   *   2. `ghost_on_recover` GHOST — `services.ghostAndReclaim()` ships the
   *      same password whenever the bot races a squatter, regardless of SASL.
   * Both are valid configurations on legacy networks; both deserve a loud
   * `[security]` warning so the operator knows.
   */
  private warnServicesPlaintextRisks(): void {
    const cfg = this.config;
    if (cfg.irc.tls) return;
    if (cfg.services.type === 'none') return;

    if (cfg.services.password && !cfg.services.sasl) {
      this.botLogger.warn(
        '[security] services.password is set with services.sasl=false and irc.tls=false — ' +
          'NickServ IDENTIFY will ship the password in cleartext on every (re)connect. ' +
          'Enable irc.tls or run the bot through an encrypted tunnel.',
      );
    }
    if (cfg.irc.ghost_on_recover && cfg.services.password) {
      this.botLogger.warn(
        '[security] irc.ghost_on_recover=true with irc.tls=false — ' +
          'NickServ GHOST will ship the password in cleartext whenever a nick collision triggers reclaim. ' +
          'Enable irc.tls or set ghost_on_recover=false.',
      );
    }

    // Empty `services_host_pattern` + a configured services password
    // disables the defense-in-depth check that drops NickServ-nick
    // notices from arbitrary hosts. On services-free networks this is
    // unavoidable, but most networks have a stable services hostname
    // (or hostmask) and operators who haven't set the pattern usually
    // just forgot. See SECURITY.md §3.2.
    const pattern = cfg.services.services_host_pattern;
    if (cfg.services.password && (!pattern || pattern.trim().length === 0)) {
      this.botLogger.warn(
        '[security] services.password is set with services.services_host_pattern empty — ' +
          'a NickServ-nick spoofer can craft fake "please identify" / ACC notices that ' +
          "the bot will accept. Pin services.services_host_pattern to your network's services " +
          'hostmask (e.g. "NickServ!*@services.libera.chat") to enable the defense-in-depth filter.',
      );
    }
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
        // Stability metrics. These give operators a .status-visible signal
        // about services degradation and plugin-load failures without
        // trawling logs.
        getStabilityMetrics: () => {
          const auditStats = this.getAuditFallbackStats();
          return {
            servicesTimeoutCount: this.services.getServicesTimeoutCount(),
            pendingVerifyCount: this.services.getPendingVerifyCount(),
            pendingCapRejections: this.services.getPendingCapRejectionCount(),
            botIdentified: this.services.isBotIdentified(),
            loadedPluginCount: this.pluginLoader.list().length,
            failedPluginCount: this.failedPlugins.length,
            failedPluginNames: this.failedPlugins,
            auditFallbackHeld: auditStats.held,
            auditFallbackDropped: auditStats.dropped,
          };
        },
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
    registerSettingsCommands({
      handler: this.commandHandler,
      coreSettings: this.coreSettings,
      channelSettings: this.channelSettings,
      pluginSettings: this.pluginSettings,
      db: this.db,
      readBotJson: () => this.readBotJsonAsRecord(),
      readPluginsJson: () => this.readPluginsJsonAsRecord(),
      // `.restart` raises SIGTERM at ourselves so the same graceful path the
      // signal handler in src/index.ts runs (heartbeat cleanup → shutdown
      // steps → process.exit) fires here too. A direct `process.exit(0)`
      // would skip `stopAllHealthSignals()` and leave a stale
      // `/tmp/.hexbot-alive` file on disk for the next instance to inherit.
      // Delegated through a hook so tests can stub it out.
      restartProcess: () => {
        process.kill(process.pid, 'SIGTERM');
      },
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

    // On nick collision, update channelState and bridge so channel-join
    // tracking uses the real nick, then attempt GHOST if configured.
    // The listener fires synchronously before joinConfiguredChannels runs.
    // Tracked under the 'bot' owner so shutdown's removeByOwner sweeps it
    // — keeps the closure (which captures `this`) from outliving the Bot.
    this.eventBus.trackListener('bot', 'bot:nick-collision', (actualNick: string) => {
      this.channelState.setBotNick(actualNick);
      this.bridge!.setBotNick(actualNick);
      this.botLogger.warn(
        `Nick collision: registered as ${actualNick} instead of ${this.config.irc.nick}. ` +
          (this.config.irc.ghost_on_recover
            ? 'Attempting GHOST to reclaim primary nick.'
            : 'Set irc.ghost_on_recover=true to enable automatic recovery.'),
      );
      if (this.config.irc.ghost_on_recover && this.config.services.password) {
        this.services
          .ghostAndReclaim(this.config.irc.nick, this.config.services.password)
          .catch((err: unknown) => {
            this.botLogger.error('GHOST/reclaim failed:', err);
          });
      }
    });
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
      // Surface the bot's reconnect-driver status to DCC sessions so an
      // operator on a still-open console sees `[reconnecting]` while
      // the bot is mid-reconnect, instead of issuing commands silently
      // into the void.
      getReconnectStatus: () => this.getReconnectState()?.status ?? null,
    });
    this._dccManager.attach();
    registerDccConsoleCommands({
      handler: this.commandHandler,
      dccManager: this._dccManager,
      db: this.db,
      permissions: this.permissions,
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
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;
    this.botLogger.info('Shutting down...');

    // Each step is independent of the others — a throw in one subsystem's
    // teardown must not block the ones after it. Previously, every step
    // ran sequentially without catches, so a single bad `close()` skipped
    // `db.close()` and leaked everything downstream.
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

    // Tear down every loaded plugin so each plugin's `teardown()` runs
    // on process exit. Without this, plugin-owned timers / DB cursors /
    // listeners would only get the dispatcher's auto-unbind step at
    // shutdown — never the plugin's own cleanup hook.
    try {
      await this.pluginLoader.unloadAll();
    } catch (err) {
      this.botLogger.error('Shutdown step "plugin-loader.unloadAll" threw:', err);
    }

    step('memo.detach', () => this.memo.detach());
    step('services.detach', () => this.services.detach());
    step('channel-state.detach', () => this.channelState.detach());

    // Drain core-scope listener stacks so a future module-level
    // re-init (test harnesses, or a mid-process restart hot-path) does
    // not double-fire `onChange` from the previous incarnation.
    step('core-settings.drain', () => {
      this.coreSettings.unregister('bot');
      this.coreSettings.offChange('bot');
    });

    step('bridge.detach', () => {
      if (this.bridge) {
        this.bridge.detach();
        this.bridge = null;
      }
    });

    step('kv-maintenance.cancel', () => {
      if (this.kvDailyTimer !== null) {
        clearInterval(this.kvDailyTimer);
        this.kvDailyTimer = null;
      }
      if (this.kvMonthlyTimer !== null) {
        clearInterval(this.kvMonthlyTimer);
        this.kvMonthlyTimer = null;
      }
    });

    // flushWithDeadline drains the pending-send buffer through the IRC client
    // one last time; stop() then halts the drain timer and rejects any new
    // enqueues. Order matters — stopping first would strand whatever was
    // queued, so a last-second `.say` from a teardown hook would silently
    // disappear. The 2s budget is generous for normal traffic but bounded so
    // a queue full of mode lines (200+ entries) doesn't burst at the server's
    // anti-flood threshold pre-QUIT and earn a K-line for the next reconnect.
    step('message-queue.flush', () => this.messageQueue.flushWithDeadline(2000));
    step('message-queue.stop', () => this.messageQueue.stop());

    if (this.client.connected) {
      try {
        const quitMsg = this.config.quit_message ?? `HexBot v${this.readPackageVersion()}`;
        // Defer the QUIT to the next tick so any in-flight irc-framework
        // writes from the queue flush above have time to land on the wire
        // before QUIT goes out. Without this, a flushWithDeadline() that
        // drained 80 mode lines could see QUIT race past the tail of the
        // batch and the server cuts the socket on QUIT before the trailing
        // sends are framed.
        await new Promise<void>((r) => setImmediate(r));
        this.client.quit(quitMsg);
        // Give the QUIT message a moment to send.
        await new Promise<void>((r) => setTimeout(r, 500));
      } catch (err) {
        this.botLogger.error('Shutdown step "client.quit" threw:', err);
      }
    }

    // Drop modlog pagers and audit-tail subscriptions — each tail
    // listener holds a closure over the REPL reply function so
    // leaving them attached leaks the full session context across
    // a reload.
    step('modlog-commands.shutdown', () => shutdownModLogCommands());

    // Drain every listener registered under the 'bot' owner — wireDispatcher,
    // attachBridge, and src/index.ts heartbeat all use trackListener('bot'),
    // so this is the single safety net that keeps closures over `this`
    // from outliving the Bot. Runs before db.close() so any final emit
    // (e.g. a late audit write) doesn't fan out to a torn-down listener.
    step('event-bus.removeByOwner-bot', () => this.eventBus.removeByOwner('bot'));

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
    // on an unreachable/misconfigured host. Throw `STSRefusalError`
    // rather than `process.exit(2)` so the caller (`Bot.start()`) can
    // run the normal `shutdown()` chain (db.close, plugin teardown,
    // queue drain) before the supervisor sees the failure — otherwise
    // the WAL files and DB just opened above leak across restart.
    try {
      this.applySTSPolicyToConfig();
    } catch (err) {
      const msg = (err as Error).message;
      this.botLogger.error(
        `FATAL: STS enforcement refused connection — will exit with code 2 after graceful shutdown: ${msg}`,
      );
      this.eventBus.emit('bot:disconnected', `fatal: sts-refused`);
      throw new STSRefusalError(msg);
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
    // Resolve as soon as `client.connect()` is invoked.
    // Previously we awaited the first `registered` event, which on a
    // K-line / DNSBL / Throttled rate-limited tier would park `Bot.start()`
    // for 5–30 minutes — main() blocks, the REPL never starts, and the
    // healthcheck never gets a chance to attach to `bot:connected`. The
    // in-process driver still owns retry/backoff; downstream code that
    // needs to observe connection state subscribes to `bot:connected`.
    return new Promise<void>((resolve, reject) => {
      this._lifecycleHandle = registerConnectionEvents(
        {
          client: this.client,
          config: this.config,
          configuredChannels: this.configuredChannels,
          eventBus: this.eventBus,
          reconnectDriver,
          // Lifecycle consults the store on ingestion so a plaintext session
          // can never mutate an existing policy — see sts.ts / connection-
          // lifecycle.ts for the short-circuit.
          stsStore: this.stsStore,
          applyCasemapping: (cm) => {
            this._casemapping = cm;
            this.channelState.setCasemapping(cm);
            this.permissions.setCasemapping(cm);
            this.dispatcher.setCasemapping(cm);
            this.services.setCasemapping(cm);
            if (this._dccManager) this._dccManager.setCasemapping(cm);
            this.memo.setCasemapping(cm);
          },
          getCasemapping: () => this._casemapping,
          applyServerCapabilities: (caps) => {
            this.channelState.setCapabilities(caps);
            this.ircCommands.setCapabilities(caps);
            this.bridge?.setCapabilities(caps);
            // Feed TARGMAX into the message queue. It's advisory (hexbot
            // never sends multi-target PRIVMSG lines) but surfaced so
            // plugins can inspect it via the queue for future multi-target
            // logic.
            this.messageQueue.setTargmax(caps.targmax);
          },
          onReconnecting: () => {
            // Drop cached services-account state so a user who took a
            // recognized nick between sessions can't inherit its flags on
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
            // audit row.
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
              // Drop the outbound queue BEFORE quit so the
              // onClose `flushWithDeadline(100)` doesn't drain queued
              // PRIVMSGs out over the cleartext socket between the
              // upgrade decision and the TLS reconnect. A queued
              // `.adduser nick *!*@host` (password material) or a
              // plugin reply containing token material could otherwise
              // hit a passive observer during the 100ms window.
              this.messageQueue.clear();
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
      // Catch a synchronous throw from `client.connect()` (TLS
      // factory rejecting a malformed cert path, irc-framework option
      // validation throwing on a bogus port). Without this guard, the
      // 'connecting' event never fires, the registration timer is
      // never started, and the lifecycle handle's `removeListeners()`
      // is the only path back — but the bot's `_lifecycleHandle` got
      // set above, so the throw escapes through the Promise reject
      // and main() exits. Surface it to the driver instead so the
      // configured backoff applies.
      try {
        this.client.connect(options);
      } catch (err) {
        this.botLogger.error('client.connect() threw synchronously:', err);
        // Fire `bot:disconnected` so the driver sees a failed attempt
        // and can schedule a retry. Use the error message as the close
        // reason so close-reason-classifier picks the right tier.
        const msg = err instanceof Error ? err.message : String(err);
        this.eventBus.emit('bot:disconnected', `connect threw: ${msg}`);
      }
      // Resolve immediately — see comment above. The lifecycle's
      // `_resolve`/`_reject` parameters are now vestigial.
      resolve();
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
      this.botLogger.warn(
        'WARNING: tls_verify is false — TLS certificate validation is DISABLED. ' +
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

    // Let irc-framework use the configured alt_nick on collision, rather
    // than appending `_` blindly. The bot still attempts GHOST on bot:nick-collision.
    if (cfg.alt_nick) {
      options.alt_nick = cfg.alt_nick;
    }

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

  private loadConfig(configPath: string, bootstrap: Bootstrap): BotConfig {
    // Probe readability separately from the open() so we can emit a
    // friendlier "did you copy the example?" hint before the JSON parser
    // even runs. The logger isn't constructed yet (the log level lives in
    // the config we're loading), so write to console directly.
    try {
      accessSync(configPath, fsConstants.R_OK);
    } catch {
      // `<3>` is the systemd / journald priority for ERR — journalctl -p err
      // surfaces this without needing a structured logger (we don't have one
      // yet; the log level lives in the config we just failed to read).
      console.error(`<3>[bootstrap] Config file not found: ${configPath}`);
      console.error('<3>[bootstrap] Copy config/bot.example.json to config/bot.json and edit it.');
      process.exit(1);
    }

    // Refuse to load if the config file is world-readable (mode & 0o004) —
    // fatal because config is the primary secrets source.
    enforceSecretFilePermissions(configPath, { fatal: true });

    // Also check any `.env*` files in the project root. These aren't consumed
    // directly by hexbot (the config uses `_env` fields that read from
    // process.env), but operators commonly keep credentials there and the
    // shell that launched the process has already read them. A world-readable
    // `.env*` file is fatal; group-readable (mode & 0o040) is a `[security]`
    // warning — matching the advice in SECURITY.md for POSIX-mode secrets.
    checkDotenvPermissions();

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
      // non-suffixed fields. The on-disk shape excludes the bootstrap-
      // sourced fields (database, pluginDir, owner.handle, owner.hostmask),
      // so the resolved object is BotConfig-shaped except for those keys —
      // we fold them in from the bootstrap layer below to satisfy the
      // runtime BotConfig type the rest of the bot consumes.
      const resolved = resolveSecrets(onDisk);
      const merged: BotConfig = {
        ...resolved,
        database: bootstrap.dbPath,
        pluginDir: bootstrap.pluginDir,
        owner: {
          handle: bootstrap.ownerHandle,
          hostmask: bootstrap.ownerHostmask,
          ...(resolved.owner?.password !== undefined ? { password: resolved.owner.password } : {}),
        },
      };
      validateResolvedSecrets(merged);
      // Channels keyed via key_env need their own post-resolution check —
      // the resolver drops unset env vars, so validateResolvedSecrets can't
      // tell the difference between "never had a key" and "env var unset".
      validateChannelKeys(onDisk.irc.channels, merged.irc.channels);
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // `<3>` priority prefix — see the readability check above for rationale.
      console.error(`<3>[bootstrap] ${message}`);
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

  /**
   * Re-read bot.json on demand for `.rehash`. Runs the same parse +
   * resolveSecrets pipeline as the boot path so both routes apply
   * identical coercions; bootstrap fields are folded back into the
   * resulting record so seed-from-json walkers see the same shape they
   * see at boot time.
   */
  private readBotJsonAsRecord(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this._botConfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const onDisk = parseBotConfigOnDisk(parsed);
      const resolved = resolveSecrets(onDisk) as unknown as Record<string, unknown>;
      return resolved;
    } catch (err) {
      this.botLogger.warn('Failed to re-read bot.json for .rehash:', err);
      return null;
    }
  }

  /**
   * Re-read plugins.json on demand for `.rehash`. Returns the bare
   * plugins map; `.rehash` reaches into each plugin's `config` block
   * to seed that plugin's settings registry.
   */
  private readPluginsJsonAsRecord(): Record<
    string,
    { config?: Record<string, unknown> } | undefined
  > | null {
    if (!this.config.pluginsConfig) return null;
    try {
      const raw = readFileSync(resolve(this.config.pluginsConfig), 'utf-8');
      return JSON.parse(raw) as Record<string, { config?: Record<string, unknown> } | undefined>;
    } catch (err) {
      this.botLogger.warn('Failed to re-read plugins.json for .rehash:', err);
      return null;
    }
  }

  /**
   * Read the version field from package.json. Resolves the path relative to
   * this file (via `import.meta.url`) so the lookup works under both
   * `tsx src/bot.ts` and the bundled `dist/bot.js` layout. Returns
   * `'0.0.0'` on any error rather than throwing — the version string is
   * only used for the banner / quit message, never for behavior, so a
   * silent fallback is preferable to crashing startup.
   */
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
