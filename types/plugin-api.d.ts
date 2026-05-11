/**
 * HexBot — Plugin API types
 *
 * Defines every interface a plugin interacts with via the `api` object
 * received in `init()`. All objects on the API are frozen at runtime.
 *
 * Hand-mirrored from `src/types/plugin-api.ts` — keep in sync when the
 * scoped API surface changes.
 */
import type {
  ChanmodBotConfig,
  IdentityConfig,
  IrcConfig,
  LoggingConfig,
  ServicesConfig,
} from './config.d.ts';
import type {
  BindHandler,
  BindType,
  ChannelState,
  ChannelUser,
  HandlerContext,
} from './events.d.ts';

// ---------------------------------------------------------------------------
// Plugin-facing bot config
// ---------------------------------------------------------------------------

/**
 * `IrcConfig` as exposed to plugins — an explicit allowlist of public fields.
 * `tls_cert` / `tls_key` (CertFP key paths) and any other filesystem/secret
 * material are deliberately excluded. `channels` is narrowed to `readonly
 * string[]` — the factory flattens `{name, key}` entries so plugins never
 * see channel keys.
 */
export interface PluginIrcConfig {
  readonly host: IrcConfig['host'];
  readonly port: IrcConfig['port'];
  readonly tls: IrcConfig['tls'];
  readonly nick: IrcConfig['nick'];
  readonly username: IrcConfig['username'];
  readonly realname: IrcConfig['realname'];
  readonly channels: readonly string[];
}

/**
 * Read-only bot config exposed to plugins via `api.botConfig`.
 *
 * The NickServ/SASL password is always omitted. Filesystem paths
 * (`database`, `pluginDir`) and `owner` are also omitted.
 */
export interface PluginBotConfig {
  readonly irc: PluginIrcConfig;
  readonly identity: Readonly<IdentityConfig>;
  /** NickServ config with `password` omitted. */
  readonly services: Readonly<Pick<ServicesConfig, 'type' | 'nickserv' | 'sasl'>>;
  readonly logging: Readonly<LoggingConfig>;
  /** Chanmod plugin credentials from bot.json. Only exposed to the chanmod plugin — other plugins see this with `nick_recovery_password` stripped. */
  readonly chanmod?: Readonly<ChanmodBotConfig>;
  /**
   * Bot version string (semver), sourced from `package.json` at boot.
   * Use this for CTCP VERSION replies, banners, status output — anywhere
   * a plugin would otherwise reach for `node:fs` to crack open `package.json`.
   */
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Permission flags
// ---------------------------------------------------------------------------

/**
 * Single-character permission flags. Flags are hierarchical: `n` implies all
 * lower flags; `-` matches anyone regardless of registration.
 *
 * | Flag | Name        | Description                                       |
 * |------|-------------|---------------------------------------------------|
 * | `n`  | owner       | Full control — implies m, o, v                    |
 * | `m`  | master      | Elevated admin — implies o, v                     |
 * | `o`  | op          | Channel operator level                            |
 * | `v`  | voice       | Voiced user level                                 |
 * | `d`  | deop        | Suppress auto-op / halfop                         |
 * | `-`  | anyone      | No flag check — handler fires for everyone        |
 */
export type Flag = 'n' | 'm' | 'o' | 'v' | 'd' | '-';

// ---------------------------------------------------------------------------
// User record
// ---------------------------------------------------------------------------

/**
 * A registered user in the permissions database.
 *
 * Users are identified by hostmask patterns (`nick!ident@hostname`), which
 * support `*` and `?` wildcards. Multiple hostmasks may be registered for
 * the same user.
 */
export interface UserRecord {
  /** Unique identifier for this user. */
  handle: string;
  /** Hostmask patterns used to identify this user. Wildcards `*` and `?` are supported. */
  hostmasks: string[];
  /** Global flag string (e.g. `'nmov'`, `'o'`, `''`). An empty string means no global flags. */
  global: string;
  /** Per-channel flag overrides. Keys are lowercased channel names; values are flag strings. */
  channels: Record<string, string>;
  /**
   * Per-user scrypt password hash. Required to open a DCC CHAT session.
   * Stripped from every plugin-facing view — see {@link PublicUserRecord}.
   */
  password_hash?: string;
}

/**
 * Plugin-facing view of {@link UserRecord} with `password_hash` omitted.
 * Returned by {@link PluginPermissions.findByHostmask}.
 */
export type PublicUserRecord = Omit<UserRecord, 'password_hash'>;

// ---------------------------------------------------------------------------
// Mod-log actor
// ---------------------------------------------------------------------------

/**
 * `{by, source, plugin}` triple a plugin hands to mutating `api.*` methods
 * (op/ban/kick/mode/...) so the resulting `mod_log` row attributes the
 * action to the user who triggered the plugin handler rather than to the
 * plugin itself. Produced by {@link PluginAPI.auditActor}; the factory
 * forces `source='plugin'` and `plugin=<pluginId>`.
 */
export interface PluginModActor {
  readonly by: string;
  readonly source: 'plugin';
  readonly plugin: string;
}

// ---------------------------------------------------------------------------
// Database API
// ---------------------------------------------------------------------------

/**
 * Namespaced key-value database for a single plugin.
 *
 * All operations are scoped to the plugin's namespace automatically.
 * The underlying store is SQLite with WAL mode and synchronous reads.
 */
export interface PluginDB {
  /** Retrieve a value by key. Returns `undefined` if the key does not exist. */
  get(key: string): string | undefined;
  /** Store a value. Creates or overwrites the entry. */
  set(key: string, value: string): void;
  /** Delete a key. No-op if the key does not exist. */
  del(key: string): void;
  /** List all entries whose key starts with `prefix` (or all entries if `prefix` is omitted). */
  list(prefix?: string): Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Core ban store
// ---------------------------------------------------------------------------

/** Ban record stored in the core ban store. */
export interface BanRecord {
  mask: string;
  channel: string;
  by: string;
  ts: number;
  /** `0` = permanent; otherwise unix timestamp ms when the ban expires. */
  expires: number;
  sticky?: boolean;
}

/** Core-owned ban store API, shared across all plugins (namespace `_bans`). */
export interface PluginBanStore {
  storeBan(channel: string, mask: string, by: string, durationMs: number): void;
  removeBan(channel: string, mask: string): void;
  getBan(channel: string, mask: string): BanRecord | null;
  getChannelBans(channel: string): BanRecord[];
  getAllBans(): BanRecord[];
  setSticky(channel: string, mask: string, sticky: boolean): boolean;
  liftExpiredBans(
    hasOps: (channel: string) => boolean,
    mode: (channel: string, modes: string, param: string) => void,
    isTracked?: (channel: string) => boolean,
  ): number;
  /** Migrate ban records from a plugin's old namespace to the core `_bans` namespace. */
  migrateFromPluginNamespace(pluginDb: PluginDB): number;
}

// ---------------------------------------------------------------------------
// Permissions API
// ---------------------------------------------------------------------------

/**
 * Read-only view of the permissions system provided to plugins.
 * Mutations go through the `.adduser` / `.flags` / `.addhostmask` dot commands.
 */
export interface PluginPermissions {
  /**
   * Look up a user by `nick!ident@host`. The optional `account` argument lets
   * the caller pass an authoritative IRCv3 account name (from `account-tag`
   * or services verification) so `$a:account` patterns match without a
   * round-trip. Returns `null` when no registered user matches.
   */
  findByHostmask(hostmask: string, account?: string | null): PublicUserRecord | null;
  /**
   * Check whether the user described by `ctx` has the required flags.
   * Respects per-channel overrides and the flag hierarchy.
   */
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

// ---------------------------------------------------------------------------
// Services API
// ---------------------------------------------------------------------------

/** Result of a NickServ identity verification query. */
export interface VerifyResult {
  /** `true` if the nick is currently identified with NickServ (ACC level ≥ 3). */
  verified: boolean;
  /** Services account name, or `null` if not identified or query failed. */
  account: string | null;
}

/**
 * NickServ identity verification API provided to plugins.
 *
 * Prefer reading `ChannelUser.accountName` first (zero-latency, populated
 * via IRCv3 `account-notify` / `extended-join`). Fall back to `verifyUser()`
 * when `accountName` is `undefined`.
 */
export interface PluginServices {
  /** Query NickServ ACC/STATUS to verify a nick's identity. */
  verifyUser(nick: string): Promise<VerifyResult>;
  /** `true` if a services adapter is configured (`services.type` is not `'none'`). */
  isAvailable(): boolean;
  /**
   * `true` if the given IRC notice matches a NickServ ACC/STATUS reply shape
   * from the configured NickServ target. Used to filter internal verification
   * chatter from operator consoles.
   */
  isNickServVerificationReply(nick: string, message: string): boolean;
  /**
   * `true` if the bot's own NickServ identity has been confirmed for the
   * current session (SASL account-notify or "You are now identified" notice).
   */
  isBotIdentified(): boolean;
}

// ---------------------------------------------------------------------------
// Channel settings API
// ---------------------------------------------------------------------------

/** Supported value types for per-channel settings. */
export type ChannelSettingType = 'flag' | 'string' | 'int';

/** Runtime value type returned from `ChannelSettings.get()`. */
export type ChannelSettingValue = boolean | string | number;

/**
 * Definition of a per-channel setting registered by a plugin.
 */
export interface ChannelSettingDef {
  /** Globally unique key for this setting. Use your plugin ID as a prefix. */
  key: string;
  type: ChannelSettingType;
  /** Default value. Must match the declared `type`. */
  default: ChannelSettingValue;
  /** Human-readable description shown in `.chaninfo` output. */
  description: string;
  /** For `'string'` settings: reject values not present in this list. */
  allowedValues?: string[];
}

/** ChannelSettingDef with its owning plugin attached (internal + PluginAPI). */
export interface ChannelSettingEntry extends ChannelSettingDef {
  pluginId: string;
}

/** Callback signature for channel setting change notifications. */
export type ChannelSettingChangeCallback = (
  channel: string,
  key: string,
  value: ChannelSettingValue,
) => void;

/** Per-channel settings API for plugins. */
export interface PluginChannelSettings {
  /** Declare this plugin's per-channel settings. Call once in `init()`. */
  register(defs: ChannelSettingDef[]): void;
  /** Read a per-channel setting (untyped union). Returns `def.default` if not set. */
  get(channel: string, key: string): ChannelSettingValue;
  /** Read a flag (boolean) setting. Returns `false` for unknown keys. */
  getFlag(channel: string, key: string): boolean;
  /** Read a string setting. Returns `''` for unknown keys. */
  getString(channel: string, key: string): string;
  /** Read an int setting. Returns `0` for unknown keys. */
  getInt(channel: string, key: string): number;
  /** Write a per-channel setting (for plugin-managed state). Operator-set values go through `.chanset`. */
  set(channel: string, key: string, value: ChannelSettingValue): void;
  /** `true` if an operator has explicitly set this value (not relying on default). */
  isSet(channel: string, key: string): boolean;
  /** Register a callback that fires when any per-channel setting changes. Auto-cleaned on unload. */
  onChange(callback: ChannelSettingChangeCallback): void;
}

// ---------------------------------------------------------------------------
// Core/plugin scope settings
// ---------------------------------------------------------------------------

/** Reload class declared on each setting def. */
export type ReloadClass = 'live' | 'reload' | 'restart';

/**
 * Plugin-scope setting definition. Same shape as {@link ChannelSettingDef}
 * plus an optional reload class (defaults to `'live'`).
 */
export interface PluginSettingDef extends ChannelSettingDef {
  reloadClass?: ReloadClass;
  /**
   * Marks a plugin-scope key whose value is the bot-wide default for a
   * channel-scope key of the same name. Operators override per-channel via
   * `.chanset`.
   */
  channelOverridable?: boolean;
}

/** Callback signature for core/plugin scope setting changes. */
export type SettingsChangeCallback = (key: string, value: ChannelSettingValue) => void;

/**
 * Read-only view of the bot's core-scope settings. Mutation is reserved for
 * operator commands and the bot's own subsystems.
 */
export interface PluginCoreSettingsView {
  get(key: string): ChannelSettingValue;
  getFlag(key: string): boolean;
  getString(key: string): string;
  getInt(key: string): number;
  /** `true` if an operator has explicitly stored a value for this key. */
  isSet(key: string): boolean;
  /** Register a callback that fires when any core setting changes. Auto-cleaned on unload. */
  onChange(callback: SettingsChangeCallback): void;
  /** Remove the registered callback. No-op when not registered. */
  offChange(callback: SettingsChangeCallback): void;
}

/**
 * Plugin's own scoped settings registry. Reads/writes the per-plugin KV
 * namespace (`plugin:<pluginId>`) — operators see and mutate the same store
 * via `.set <plugin-id> <key> <value>`.
 */
export interface PluginSettings {
  /** Declare typed setting definitions for this plugin. Call once in `init()`. */
  register(defs: PluginSettingDef[]): void;
  get(key: string): ChannelSettingValue;
  getFlag(key: string): boolean;
  getString(key: string): string;
  getInt(key: string): number;
  /** Write a value to the plugin's scope (mirrors operator `.set <plugin> <key> <value>`). */
  set(key: string, value: ChannelSettingValue): void;
  /** Delete a value, reverting reads to the registered default. */
  unset(key: string): void;
  /** `true` if an explicit value is stored. */
  isSet(key: string): boolean;
  /** Register a callback that fires when any plugin-scope setting changes. Auto-cleaned on unload. */
  onChange(callback: SettingsChangeCallback): void;
  /** Remove the registered callback. No-op when not registered. */
  offChange(callback: SettingsChangeCallback): void;
  /**
   * Frozen snapshot of the merged `plugins.json` / `config.json` bag the
   * loader handed this plugin at load time. Escape hatch for deeply-nested
   * config that doesn't flatten cleanly to typed settings.
   */
  readonly bootConfig: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Audit + utility sub-APIs
// ---------------------------------------------------------------------------

/**
 * Options for {@link PluginAudit.log}. The factory injects `by`, `source`,
 * and `plugin` so a plugin cannot spoof another plugin's identity.
 */
export interface PluginAuditOptions {
  channel?: string | null;
  target?: string | null;
  outcome?: 'success' | 'failure';
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Scoped audit writer. `api.audit.log('action', ...)` writes a `mod_log` row
 * with `source='plugin'`, `plugin=<pluginId>`, and `by=<pluginId>`. Use for
 * plugin-specific events that don't map to an `api.*` IRC command (those
 * already auto-audit through the underlying wrappers).
 */
export interface PluginAudit {
  log(action: string, options?: PluginAuditOptions): void;
}

/**
 * Sliding-window rate counter obtained from
 * {@link PluginUtil.createSlidingWindowCounter}.
 */
export interface PluginSlidingWindowCounter {
  /** Record one event for `key` and return `true` if the count in the last `windowMs` exceeds `limit`. */
  check(key: string, windowMs: number, limit: number): boolean;
  /** Read the current count for `key` without recording. */
  peek(key: string, windowMs: number): number;
  /** Drop all history for a specific key. */
  clear(key: string): void;
  /** Drop history for all keys. */
  reset(): void;
  /** Prune keys whose timestamps have all expired outside `windowMs`. */
  sweep(windowMs: number): void;
  /** Number of tracked keys. */
  readonly size: number;
}

/** General-purpose helpers exposed on `api.util`. */
export interface PluginUtil {
  /**
   * Match `text` against a wildcard `pattern` — `*` matches any string,
   * `?` matches exactly one character. Defaults to IRC-aware case folding.
   */
  matchWildcard(pattern: string, text: string, opts?: { caseInsensitive?: boolean }): boolean;
  /**
   * Score a hostmask/account pattern's specificity. The "weak" threshold is
   * 100 — patterns below that are flagged by the startup sweep.
   */
  patternSpecificity(pattern: string): number;
  /** Create a fresh sliding-window rate counter. */
  createSlidingWindowCounter(): PluginSlidingWindowCounter;
}

// ---------------------------------------------------------------------------
// Help registry
// ---------------------------------------------------------------------------

/**
 * A single help entry registered by a plugin.
 */
export interface HelpEntry {
  /** Command trigger including `!` or `.` prefix (e.g. `'!op'`, `'.set'`). */
  command: string;
  /** Required flags. Same format as `bind()` flags (`'o'`, `'n|m'`, `'-'`). */
  flags: string;
  /** Concise usage line (e.g. `'!op [nick]'`). */
  usage: string;
  /** One-line description shown in `!help` listings. */
  description: string;
  /** Extended description lines shown in `!help <command>`. */
  detail?: string[];
  /** Grouping category. Defaults to the plugin ID if unset. */
  category?: string;
  /** Populated automatically by the help registry — do not set manually. */
  pluginId?: string;
}

/**
 * Read-only window onto the unified help corpus. Plugins register entries
 * through `api.registerHelp` so the factory can stamp `pluginId`.
 */
export interface HelpRegistryView {
  /** Look up an entry by command name with namespaced + strict + fuzzy fallback. */
  get(command: string): HelpEntry | undefined;
  /** All entries across every owner bucket. */
  getAll(): HelpEntry[];
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

/**
 * The scoped API object every plugin receives in `init()`.
 *
 * All properties are frozen at runtime. After the plugin is unloaded, every
 * method on the api (and its sub-API namespaces) becomes a no-op so stale
 * closures cannot fan out to the bot's core graph.
 *
 * @example
 * import type { PluginAPI } from '../../types/index.d.ts';
 *
 * export const name = 'my-plugin';
 * export const version = '1.0.0';
 * export const description = 'Example plugin';
 *
 * export function init(api: PluginAPI): void {
 *   api.bind('pub', '-', '!hello', (ctx) => {
 *     ctx.reply(`Hello, ${api.stripFormatting(ctx.nick)}!`);
 *   });
 * }
 */
export interface PluginAPI {
  /** This plugin's registered ID. Matches the `name` export. */
  readonly pluginId: string;

  // -------------------------------------------------------------------------
  // Bind system
  // -------------------------------------------------------------------------

  /**
   * Register a handler for an IRC event. `ctx` is narrowed at the call site
   * to the per-bind-type shape — e.g. `api.bind('pub', ...)` hands the
   * handler a context with `channel: string`, `api.bind('msg', ...)` with
   * `channel: null`.
   */
  bind<T extends BindType>(type: T, flags: string, mask: string, handler: BindHandler<T>): void;

  /** Remove a previously registered handler. The loader cleans these up on unload. */
  unbind<T extends BindType>(type: T, mask: string, handler: BindHandler<T>): void;

  // -------------------------------------------------------------------------
  // IRC output
  // -------------------------------------------------------------------------

  /** Send a PRIVMSG to a channel or nick. Long messages are split and rate-limited. */
  say(target: string, message: string): void;
  /** Send a CTCP ACTION (`/me`). */
  action(target: string, message: string): void;
  /** Send a NOTICE. */
  notice(target: string, message: string): void;
  /** Send a CTCP reply. Always uses NOTICE per RFC 2812 §3.3.2. */
  ctcpResponse(target: string, type: string, message: string): void;

  // -------------------------------------------------------------------------
  // Channel management
  //
  // The optional `actor` argument attributes the resulting `mod_log` row to
  // the triggering user rather than to the plugin itself — obtain one from
  // `api.auditActor(ctx)`. Omit for plugin-autonomous actions.
  // -------------------------------------------------------------------------

  join(channel: string, key?: string): void;
  part(channel: string, message?: string): void;
  op(channel: string, nick: string, actor?: PluginModActor): void;
  deop(channel: string, nick: string, actor?: PluginModActor): void;
  voice(channel: string, nick: string, actor?: PluginModActor): void;
  devoice(channel: string, nick: string, actor?: PluginModActor): void;
  halfop(channel: string, nick: string, actor?: PluginModActor): void;
  dehalfop(channel: string, nick: string, actor?: PluginModActor): void;
  kick(channel: string, nick: string, reason?: string, actor?: PluginModActor): void;
  ban(channel: string, mask: string, actor?: PluginModActor): void;
  /** Set one or more channel modes. Batched to respect the server's MODES limit. */
  mode(channel: string, modes: string, ...params: string[]): void;
  /** Request RPL_CHANNELMODEIS (324); fires `channel:modesReady` when received. */
  requestChannelModes(channel: string): void;
  topic(channel: string, text: string, actor?: PluginModActor): void;
  invite(channel: string, nick: string, actor?: PluginModActor): void;
  /** Change the bot's own IRC nick. Routes through the message queue for flood protection. */
  changeNick(nick: string): void;

  // -------------------------------------------------------------------------
  // Channel state
  // -------------------------------------------------------------------------

  /** Get the current state of a channel, or `undefined` if the bot is not in it. */
  getChannel(name: string): ChannelState | undefined;
  /** All users currently in a channel. */
  getUsers(channel: string): ChannelUser[];
  /** Full hostmask for a user in a channel, or `undefined` if not present. */
  getUserHostmask(channel: string, nick: string): string | undefined;
  /**
   * Names of every channel the bot is currently tracking — the union of
   * startup-config channels that joined successfully and channels joined at
   * runtime. Prefer this over `botConfig.irc.channels` for live state.
   */
  getJoinedChannels(): string[];

  /** Fires after `requestChannelModes()` reply arrives. Auto-cleaned on unload. */
  onModesReady(callback: (channel: string) => void): void;
  /** Remove a callback previously registered with {@link onModesReady}. */
  offModesReady(callback: (channel: string) => void): void;

  /**
   * Fires when a bot user's permissions record changes (`user:added`,
   * `user:flagsChanged`, `user:hostmaskAdded`).
   */
  onPermissionsChanged(callback: (handle: string) => void): void;
  offPermissionsChanged(callback: (handle: string) => void): void;

  /**
   * Fires on IRCv3 `account-notify` (null → account) and explicit
   * `verifyUser()` success.
   */
  onUserIdentified(callback: (nick: string, account: string) => void): void;
  offUserIdentified(callback: (nick: string, account: string) => void): void;

  /** Fires on IRCv3 `account-notify` (account → null). */
  onUserDeidentified(callback: (nick: string, previousAccount: string) => void): void;
  offUserDeidentified(callback: (nick: string, previousAccount: string) => void): void;

  /**
   * Fires when the bot's own NickServ identity is confirmed for the current
   * session — via SASL account-notify or a "You are now identified" notice.
   */
  onBotIdentified(callback: () => void): void;
  offBotIdentified(callback: () => void): void;

  // -------------------------------------------------------------------------
  // Sub-APIs
  // -------------------------------------------------------------------------

  /** Read-only access to the permissions database. */
  readonly permissions: PluginPermissions;
  /** NickServ identity verification. */
  readonly services: PluginServices;
  /** Namespaced key-value database scoped to this plugin. */
  readonly db: PluginDB;
  /** Core ban store, shared across all plugins (namespace `_bans`). */
  readonly banStore: PluginBanStore;
  /** Per-channel settings API. Declare settings once in `init()` via `register()`. */
  readonly channelSettings: PluginChannelSettings;
  /** Read-only view of bot-wide core settings (`logging.level`, `command_prefix`, etc.). */
  readonly coreSettings: PluginCoreSettingsView;
  /** Plugin's own settings registry, scoped to `plugin:<pluginId>`. */
  readonly settings: PluginSettings;
  /** Scoped audit-log writer for non-IRC plugin events. */
  readonly audit: PluginAudit;
  /** General-purpose helpers (wildcard matching, sliding-window counters). */
  readonly util: PluginUtil;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** The bot's core configuration, read-only and deep-frozen. Password and filesystem paths are omitted. */
  readonly botConfig: PluginBotConfig;

  // -------------------------------------------------------------------------
  // Server capabilities + utilities
  // -------------------------------------------------------------------------

  /** ISUPPORT (005) capability map (e.g. `MODES`, `CASEMAPPING`, `CHANTYPES`). */
  getServerSupports(): Record<string, string>;
  /** Lowercase a nick or channel name using the server's CASEMAPPING. */
  ircLower(text: string): string;
  /** Build `nick!ident@hostname` from any object carrying those three fields. */
  buildHostmask(source: { nick: string; ident: string; hostname: string }): string;
  /** `true` if `nick` case-folds to the bot's own configured nick. */
  isBotNick(nick: string): boolean;
  /** Configured channel key (from bot.json), or `undefined` if none. */
  getChannelKey(channel: string): string | undefined;

  // -------------------------------------------------------------------------
  // Help system
  // -------------------------------------------------------------------------

  /** Register help entries. Call once in `init()`. */
  registerHelp(entries: HelpEntry[]): void;
  /** Read-only view of the unified help corpus. */
  getHelpRegistry(): HelpRegistryView;

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------

  /** Strip IRC formatting and control characters. Use for user-controlled values in security-relevant output. */
  stripFormatting(text: string): string;

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  /** Log at INFO level. Output is prefixed with `[plugin:<pluginId>]`. */
  log(...args: unknown[]): void;
  /** Log at ERROR level. */
  error(...args: unknown[]): void;
  /** Log at WARN level. */
  warn(...args: unknown[]): void;
  /** Log at DEBUG level (only shown when `logging.level` is `'debug'`). */
  debug(...args: unknown[]): void;

  // -------------------------------------------------------------------------
  // Audit actor
  // -------------------------------------------------------------------------

  /**
   * Derive a {@link PluginModActor} from a bind-handler `ctx` so mutating
   * `api.*` calls attribute their `mod_log` row to the triggering user
   * instead of to the plugin itself.
   *
   * @example
   * api.bind('pub', 'o', '!op', (ctx) => {
   *   api.op(ctx.channel, ctx.nick, api.auditActor(ctx));
   * });
   */
  auditActor(ctx: HandlerContext): PluginModActor;
}

// ---------------------------------------------------------------------------
// Plugin module shape
// ---------------------------------------------------------------------------

/**
 * Required and optional exports for a HexBot plugin module.
 *
 * @example
 * // plugins/my-plugin/index.ts
 * import type { PluginAPI } from '../../types/index.d.ts';
 *
 * export const name = 'my-plugin';
 * export const version = '1.0.0';
 * export const description = 'An example plugin.';
 *
 * export function init(api: PluginAPI): void {
 *   api.bind('pub', '-', '!ping', ctx => ctx.reply('pong'));
 * }
 *
 * export function teardown(): void {
 *   // Clean up bare-global timers, listeners, etc.
 * }
 */
export interface PluginExports {
  /** Plugin identifier — must be unique. */
  name: string;
  /** Semantic version string. */
  version: string;
  /** One-line description. */
  description: string;
  /** Called when the plugin is loaded (or hot-reloaded). Register all binds here. */
  init(api: PluginAPI): void | Promise<void>;
  /**
   * Called when the plugin is unloaded or hot-reloaded. Clean up bare-global
   * timers, listeners, and connections — binds are removed automatically.
   */
  teardown?(): void | Promise<void>;
}
