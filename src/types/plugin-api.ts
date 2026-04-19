// HexBot — Plugin API + state shapes
//
// Type-only definitions for the scoped API that every plugin receives via
// init(), plus the channel-state / permission-record / help / channel-setting
// shapes that cross the plugin boundary. Pure types — no runtime code.
import type {
  ChanmodBotConfig,
  IdentityConfig,
  IrcConfig,
  LoggingConfig,
  OwnerConfig,
  ServicesConfig,
} from './config';
import type { BindHandler, BindType, HandlerContext } from './dispatch';

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------

/** Scoped database API provided to each plugin. */
export interface PluginDB {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  del(key: string): void;
  list(prefix?: string): Array<{ key: string; value: string }>;
}

/** Ban record stored in the core ban store. */
export interface BanRecord {
  mask: string;
  channel: string;
  by: string;
  ts: number;
  expires: number; // 0 = permanent, otherwise unix timestamp ms
  sticky?: boolean;
}

/** Core-owned ban store API provided to plugins. */
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
  /** Migrate ban records from a plugin's old namespace to the core _bans namespace. */
  migrateFromPluginNamespace(pluginDb: PluginDB): number;
}

/** Read-only permissions API for plugins. */
export interface PluginPermissions {
  /**
   * Look up a user by `nick!ident@host`. Returns a {@link PublicUserRecord}
   * with `password_hash` stripped — plugins never see password material.
   */
  findByHostmask(hostmask: string, account?: string | null): PublicUserRecord | null;
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/** Result from a NickServ identity verification query. */
export interface VerifyResult {
  /** True if the nick is currently identified with NickServ (ACC level ≥ 3). */
  verified: boolean;
  /** The services account name, or null if not identified / unknown. */
  account: string | null;
}

/** Read-only services API for plugins. */
export interface PluginServices {
  /** Query NickServ ACC/STATUS to verify a nick's identity. */
  verifyUser(nick: string): Promise<VerifyResult>;
  /** True if the configured services adapter is available (type is not 'none'). */
  isAvailable(): boolean;
  /**
   * True if the given IRC notice matches a NickServ ACC/STATUS reply shape
   * from the configured NickServ target. Used to filter internal
   * verification chatter from operator consoles.
   */
  isNickServVerificationReply(nick: string, message: string): boolean;
}

/** The scoped API object plugins receive in init(). */
/**
 * Options for {@link PluginAudit.log}. The factory injects `by`, `source`,
 * and `plugin` so a plugin cannot spoof another plugin's identity or pretend
 * to be a non-plugin source. Plugins control everything else.
 */
export interface PluginAuditOptions {
  channel?: string | null;
  target?: string | null;
  outcome?: 'success' | 'failure';
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Sliding-window rate counter obtained from
 * {@link PluginUtil.createSlidingWindowCounter}. Plugins use this to track
 * things like "how many times has user X done Y in the last N ms" without
 * reaching into `src/utils/sliding-window` directly (which would be a
 * plugin→core runtime import — banned by the plugin boundary contract).
 *
 * Implementation in `src/utils/sliding-window.ts` satisfies this shape;
 * plugins should only rely on the methods declared here.
 */
export interface PluginSlidingWindowCounter {
  /**
   * Record one event for `key` and return true if the total count in the
   * last `windowMs` ms (including this event) exceeds `limit`.
   */
  check(key: string, windowMs: number, limit: number): boolean;
  /** Read the current count for `key` without recording a new event. */
  peek(key: string, windowMs: number): number;
  /** Drop all timestamp history for a specific key. */
  clear(key: string): void;
  /** Drop all timestamp history for all keys. */
  reset(): void;
  /** Prune keys whose timestamps have all expired outside `windowMs`. */
  sweep(windowMs: number): void;
  /** Number of tracked keys (for observability). */
  readonly size: number;
}

/**
 * General-purpose helpers exposed to plugins on `api.util`. Exists so plugins
 * don't reach into `src/utils/*` at runtime — that boundary is type-only, so
 * anything a plugin needs as a live function/class must come through the API
 * surface. Keep this namespace small; add utilities only when at least two
 * plugins benefit.
 */
export interface PluginUtil {
  /**
   * Match `text` against a wildcard `pattern` — `*` matches any string
   * (including empty), `?` matches exactly one character. Defaults to
   * IRC-aware case folding using the network's CASEMAPPING, which is the
   * right default for hostmask / nick / channel matching. Pass
   * `{ caseInsensitive: false }` for byte-exact comparison.
   */
  matchWildcard(pattern: string, text: string, opts?: { caseInsensitive?: boolean }): boolean;
  /**
   * Create a fresh sliding-window rate counter. See
   * {@link PluginSlidingWindowCounter} for the available operations.
   */
  createSlidingWindowCounter(): PluginSlidingWindowCounter;
}

/**
 * Scoped audit-writer surface a plugin sees on `api.audit`. Calling
 * `api.audit.log('feed-add', ...)` writes a `mod_log` row with `source =
 * 'plugin'`, `plugin = <pluginId>`, and `by = <pluginId>` — the pluginId is
 * forced by the factory and cannot be overridden.
 *
 * Privileged actions that map onto `api.irc.*` (op/ban/kick/...) are
 * already auto-audited by the underlying IRCCommands wrappers — call
 * `api.audit.log` only for plugin-specific events that don't fit the
 * IRC-command shape (feed mutations, lockdowns, threat-level escalations,
 * config flips, ...).
 */
export interface PluginAudit {
  log(action: string, options?: PluginAuditOptions): void;
}

export interface PluginAPI {
  pluginId: string;

  // Bind system (auto-tagged with plugin ID)
  bind<T extends BindType>(type: T, flags: string, mask: string, handler: BindHandler<T>): void;
  unbind<T extends BindType>(type: T, mask: string, handler: BindHandler<T>): void;

  // IRC actions
  say(target: string, message: string): void;
  action(target: string, message: string): void;
  notice(target: string, message: string): void;
  ctcpResponse(target: string, type: string, message: string): void;

  // IRC channel operations
  join(channel: string, key?: string): void;
  part(channel: string, message?: string): void;
  op(channel: string, nick: string): void;
  deop(channel: string, nick: string): void;
  voice(channel: string, nick: string): void;
  devoice(channel: string, nick: string): void;
  halfop(channel: string, nick: string): void;
  dehalfop(channel: string, nick: string): void;
  kick(channel: string, nick: string, reason?: string): void;
  ban(channel: string, mask: string): void;
  mode(channel: string, modes: string, ...params: string[]): void;
  /** Request the current channel modes from the server (triggers RPL_CHANNELMODEIS / channel:modesReady). */
  requestChannelModes(channel: string): void;
  topic(channel: string, text: string): void;
  /** Invite a user to a channel. */
  invite(channel: string, nick: string): void;
  /** Change the bot's own IRC nick (e.g. for nick recovery). */
  changeNick(nick: string): void;

  // Channel state
  /** Register a callback for when channel modes are received from the server (RPL_CHANNELMODEIS). Auto-cleaned on unload. */
  onModesReady(callback: (channel: string) => void): void;
  /** Remove a callback previously registered with {@link onModesReady}. No-op if not registered. */
  offModesReady(callback: (channel: string) => void): void;
  getChannel(name: string): ChannelState | undefined;
  getUsers(channel: string): ChannelUser[];
  getUserHostmask(channel: string, nick: string): string | undefined;

  /**
   * Register a callback for when a bot user's permissions record changes in a
   * way that might affect mode placement — currently `user:added`,
   * `user:flagsChanged`, and `user:hostmaskAdded`. Fires with the handle of
   * the changed user. Auto-cleaned on unload.
   */
  onPermissionsChanged(callback: (handle: string) => void): void;
  /** Remove a callback previously registered with {@link onPermissionsChanged}. No-op if not registered. */
  offPermissionsChanged(callback: (handle: string) => void): void;

  /**
   * Register a callback for when the bot observes that a nick is identified
   * to services — fires on IRCv3 `account-notify` transitions (null → account)
   * and on explicit `verifyUser()` success. Use this to react to users
   * identifying after they've already joined. Auto-cleaned on unload.
   */
  onUserIdentified(callback: (nick: string, account: string) => void): void;
  /** Remove a callback previously registered with {@link onUserIdentified}. No-op if not registered. */
  offUserIdentified(callback: (nick: string, account: string) => void): void;

  /**
   * Register a callback for when a nick deidentifies from services
   * (IRCv3 `account-notify` transition from account → null). The
   * `previousAccount` argument is the account the nick was identified to
   * immediately before — useful for looking up handles by `$a:account`
   * pattern even though the nick is no longer identified. Auto-cleaned
   * on unload.
   */
  onUserDeidentified(callback: (nick: string, previousAccount: string) => void): void;
  /** Remove a callback previously registered with {@link onUserDeidentified}. No-op if not registered. */
  offUserDeidentified(callback: (nick: string, previousAccount: string) => void): void;

  // Permissions (read-only)
  permissions: PluginPermissions;

  // Services (identity verification)
  services: PluginServices;

  // Database (namespaced to this plugin)
  db: PluginDB;

  // Core ban store (shared across all plugins, namespace _bans)
  banStore: PluginBanStore;

  // Bot config (read-only, password redacted)
  botConfig: PluginBotConfig;

  // Config (from plugins.json overrides, falling back to plugin's config.json)
  config: Record<string, unknown>;

  // Server capabilities (from ISUPPORT)
  getServerSupports(): Record<string, string>;

  // IRC-aware case folding using the connected network's CASEMAPPING
  ircLower(text: string): string;

  /** Returns `nick!ident@hostname` built from any object carrying those three fields. */
  buildHostmask(source: { nick: string; ident: string; hostname: string }): string;

  /** True if `nick` case-folds to the bot's own configured nick on this network. */
  isBotNick(nick: string): boolean;

  // Per-channel settings
  channelSettings: PluginChannelSettings;

  // Help registry
  registerHelp(entries: HelpEntry[]): void;
  getHelpEntries(): HelpEntry[];

  /**
   * Strip IRC formatting and control characters from a string.
   * Use whenever user-controlled values appear in security-relevant output
   * (permission grants, op/kick/ban announcements, log messages).
   * See docs/SECURITY.md section 5.2.
   */
  stripFormatting(text: string): string;

  /**
   * General-purpose helpers (wildcard matching, sliding-window counters).
   * Exposed on the API so plugins don't reach into `src/utils/*` at runtime
   * — that boundary is type-only.
   */
  util: PluginUtil;

  /** Get the configured channel key (from bot.json), or undefined if none. */
  getChannelKey(channel: string): string | undefined;

  // Logging (prefixed with [plugin:<name>])
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;

  /**
   * Audit writer scoped to this plugin. The factory forces `source='plugin'`
   * and `plugin/by=<pluginId>` so plugin code can't spoof identity. Use this
   * for non-IRC privileged events (feed mutations, lockdowns, threat
   * escalations, ...) — IRC mode/op/kick/ban actions are already
   * auto-audited via the underlying `api.irc.*` wrappers.
   */
  audit: PluginAudit;
}

/** What a plugin module must export. */
export interface PluginExports {
  name: string;
  version: string;
  description: string;
  init(api: PluginAPI): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Channel state
// ---------------------------------------------------------------------------

/** A user present in a channel (plugin-facing view). */
export interface ChannelUser {
  nick: string;
  ident: string;
  hostname: string;
  /** Channel modes as a concatenated string, e.g. `"o"` for op, `"ov"` for op+voice. */
  modes: string;
  /** Unix timestamp (ms) of when the user joined. */
  joinedAt: number;
  /**
   * Services account name from IRCv3 `account-notify` / `extended-join` /
   * `account-tag`.
   * - `string`    — nick is identified as this account
   * - `null`      — nick is known NOT to be identified
   * - `undefined` — no account data available for this user
   */
  accountName?: string | null;
  /**
   * Away state from IRCv3 `away-notify`.
   * - `true`      — user has set an AWAY message
   * - `false`     — user is explicitly back
   * - `undefined` — no away-notify data received yet for this user
   */
  away?: boolean;
}

/** State for a single channel (plugin-facing view). */
export interface ChannelState {
  name: string;
  topic: string;
  /** Channel mode chars (e.g. `"mntsk"`). */
  modes: string;
  /** Current channel key (empty string if none). */
  key: string;
  /** Current channel user limit (0 if none). */
  limit: number;
  /** All users currently in the channel, keyed by lowercased nick. */
  users: Map<string, ChannelUser>;
}

// ---------------------------------------------------------------------------
// User / permissions
// ---------------------------------------------------------------------------

/** A user record in the permissions system. */
export interface UserRecord {
  handle: string;
  hostmasks: string[];
  global: string; // global flags, e.g. "nmov"
  channels: Record<string, string>; // per-channel flag overrides
  /**
   * Per-user scrypt password hash (stored format — see `src/core/password.ts`).
   * Required to open a DCC CHAT session; optional at rest so existing records
   * survive the migration into 0.3.0 and are blocked from DCC until an admin
   * runs `.chpass` for them.
   *
   * **Security:** This field is secret. It is stripped from every
   * plugin-facing view (see {@link PublicUserRecord}) and must never be
   * logged, serialized outside the database, or sent over bot-link sync.
   */
  password_hash?: string;
}

/**
 * Plugin-facing view of {@link UserRecord} with `password_hash` omitted.
 * Produced by {@link PluginPermissions.findByHostmask}; plugins never see
 * the hash even indirectly. Internal code (permissions, DCC, `.chpass`) uses
 * {@link UserRecord} directly so it can read/write the hash.
 */
export type PublicUserRecord = Omit<UserRecord, 'password_hash'>;

// ---------------------------------------------------------------------------
// Channel settings
// ---------------------------------------------------------------------------

/** Storage type for a per-channel setting. */
export type ChannelSettingType = 'flag' | 'string' | 'int';

/** Runtime value type returned from ChannelSettings.get(). */
export type ChannelSettingValue = boolean | string | number;

/** A typed per-channel setting definition registered by a plugin. */
export interface ChannelSettingDef {
  key: string; // globally unique key, e.g. 'bitch', 'greet_msg'
  type: ChannelSettingType;
  default: ChannelSettingValue;
  description: string; // shown in .chaninfo output
  allowedValues?: string[]; // for string-type settings: reject values not in this list
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

/** Per-channel settings API provided to plugins. */
export interface PluginChannelSettings {
  /** Declare per-channel setting definitions for this plugin. Call once in init(). */
  register(defs: ChannelSettingDef[]): void;
  /** Read a per-channel setting (untyped union). Returns def.default if not set. */
  get(channel: string, key: string): ChannelSettingValue;
  /** Read a flag (boolean) setting. Returns `false` for unknown keys. */
  getFlag(channel: string, key: string): boolean;
  /** Read a string setting. Returns `''` for unknown keys. */
  getString(channel: string, key: string): string;
  /** Read an int setting. Returns `0` for unknown keys. */
  getInt(channel: string, key: string): number;
  /** Write a per-channel setting (for plugin-managed settings, e.g. topic text). */
  set(channel: string, key: string, value: ChannelSettingValue): void;
  /** True if an operator has explicitly set this value (not relying on default). */
  isSet(channel: string, key: string): boolean;
  /** Register a callback that fires when any per-channel setting changes. Auto-cleaned on unload. */
  onChange(callback: ChannelSettingChangeCallback): void;
}

// ---------------------------------------------------------------------------
// Help system
// ---------------------------------------------------------------------------

/** A single help entry registered by a plugin. */
export interface HelpEntry {
  command: string; // trigger including "!", e.g. "!op"
  flags: string; // required flags, same format as bind (e.g. "o", "n|m", "-")
  usage: string; // concise usage line, e.g. "!op [nick]"
  description: string; // one-line description
  detail?: string[]; // extra lines shown only in !help <command>
  category?: string; // grouping label, defaults to pluginId
  /** Populated automatically by the help registry — do not set manually. */
  pluginId?: string;
}

// ---------------------------------------------------------------------------
// Plugin-facing bot config
// ---------------------------------------------------------------------------

/** IrcConfig as exposed to plugins — channels is readonly. */
export interface PluginIrcConfig extends Readonly<Omit<IrcConfig, 'channels'>> {
  readonly channels: readonly string[];
}

/** Plugin-facing bot config (read-only view, password redacted). */
export interface PluginBotConfig {
  readonly irc: PluginIrcConfig;
  readonly owner: Readonly<OwnerConfig>;
  readonly identity: Readonly<IdentityConfig>;
  /** NickServ config with password omitted. */
  readonly services: Readonly<Pick<ServicesConfig, 'type' | 'nickserv' | 'sasl'>>;
  readonly logging: Readonly<LoggingConfig>;
  /** Chanmod plugin credentials from bot.json. Only exposed to chanmod — other plugins ignore this. */
  readonly chanmod?: Readonly<ChanmodBotConfig>;
}
