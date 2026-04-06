// HexBot — Shared type definitions
// These are type-only definitions (interfaces/types) — no runtime code.

// ---------------------------------------------------------------------------
// IRC network types
// ---------------------------------------------------------------------------

/** IRC CASEMAPPING values from ISUPPORT 005. */
export type Casemapping = 'rfc1459' | 'strict-rfc1459' | 'ascii';

// ---------------------------------------------------------------------------
// Bind system types
// ---------------------------------------------------------------------------

/** Bind types supported by the dispatcher. */
export type BindType =
  | 'pub' // Channel message — exact command match, non-stackable
  | 'pubm' // Channel message — wildcard on full text, stackable
  | 'msg' // Private message — exact command match, non-stackable
  | 'msgm' // Private message — wildcard on full text, stackable
  | 'join' // User joins channel, stackable
  | 'part' // User parts channel, stackable
  | 'kick' // User kicked, stackable
  | 'nick' // Nick change, stackable
  | 'mode' // Mode change, stackable
  | 'raw' // Raw server line, stackable
  | 'time' // Timer (interval), stackable
  | 'ctcp' // CTCP request, stackable
  | 'notice' // Notice message, stackable
  | 'topic' // Topic change, stackable
  | 'quit' // User quit (not channel-scoped), stackable
  | 'invite' // Bot invited to a channel, stackable
  | 'join_error'; // Bot failed to join a channel (banned, invite-only, bad key, etc.), stackable

/** Permission flags: n=owner, m=master, o=op, v=voice, d=deop (suppress auto-op/halfop), -=anyone. */
export type Flag = 'n' | 'm' | 'o' | 'v' | 'd' | '-';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Context object passed to every bind handler.
 *
 * Field semantics vary by bind type:
 *
 * | type    | nick           | channel      | text                        | command             | args                    |
 * |---------|----------------|--------------|-----------------------------|---------------------|-------------------------|
 * | pub     | sender         | #channel     | full message (raw)          | command word        | text after command      |
 * | pubm    | sender         | #channel     | full message (raw)          | command word / `''` for `/me` | args / action text |
 * | msg     | sender         | null (PM)    | full message (raw)          | command word        | text after command      |
 * | msgm    | sender         | null (PM)    | full message (raw)          | command word / `''` for `/me` | args / action text |
 * | join    | joiner         | #channel     | `"#chan nick!ident@host"`    | `'JOIN'`            | `''`                    |
 * | part    | parter         | #channel     | `"#chan nick!ident@host"`    | `'PART'`            | part reason             |
 * | kick    | **kicked** nick | #channel    | `"#chan kicked!ident@host"`  | `'KICK'`            | `"reason (by kicker)"` |
 * | nick    | old nick       | null         | new nick                    | `'NICK'`            | new nick                |
 * | mode    | mode setter    | #channel     | `"#chan +o nick"`            | mode string (`+o`)  | mode param              |
 * | ctcp    | sender         | null         | CTCP payload (no type prefix)| CTCP type (upper)  | CTCP payload            |
 * | notice  | sender         | #chan / null | notice text                 | `'NOTICE'`          | notice text             |
 * | topic   | setter         | #channel     | new topic                   | `'topic'`           | `''`                    |
 * | quit    | quitter        | null         | quit reason                 | `'quit'`            | `''`                    |
 * | invite  | inviter        | #channel     | `"#chan nick!ident@host"`    | `'INVITE'`          | `''`                    |
 * | time    | `''`           | null         | `''`                        | `''`                | `''`                    |
 */
export interface HandlerContext {
  /** Nick of the user who triggered this event. For `kick`: the kicked user (not the kicker). */
  nick: string;
  /** Ident of the user who triggered this event. */
  ident: string;
  /** Hostname of the user who triggered this event. */
  hostname: string;
  /** Channel the event occurred in. `null` for private messages, nick events, CTCP, and quit. */
  channel: string | null;
  /**
   * Raw message text (for `pub`/`msg`/`pubm`/`msgm`: includes IRC formatting codes).
   * For non-message events, a synthetic string — see table above.
   */
  text: string;
  /**
   * For `pub`/`msg`: the first whitespace-delimited word with formatting stripped (e.g. `'!op'`).
   * For `pubm`/`msgm` triggered by `/me` actions: `''`.
   * For non-message events: an event-specific keyword — see table above.
   */
  command: string;
  /**
   * For `pub`/`msg`: everything after the command word, trimmed.
   * For `pubm`/`msgm` triggered by `/me` actions: the action text.
   * For other events: event-specific value — see table above.
   */
  args: string;
  /**
   * Send a reply to the channel (or nick if from a PM).
   * Long messages are automatically split. Output is rate-limited.
   */
  reply(msg: string): void;
  /**
   * Send a private NOTICE reply to the originating nick.
   * Long messages are automatically split. Output is rate-limited.
   */
  replyPrivate(msg: string): void;
}

/** Signature for bind handler functions. */
export type BindHandler = (ctx: HandlerContext) => void | Promise<void>;

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

/** Read-only permissions API for plugins. */
export interface PluginPermissions {
  findByHostmask(hostmask: string): UserRecord | null;
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
}

/** The scoped API object plugins receive in init(). */
export interface PluginAPI {
  pluginId: string;

  // Bind system (auto-tagged with plugin ID)
  bind(type: BindType, flags: string, mask: string, handler: BindHandler): void;
  unbind(type: BindType, mask: string, handler: BindHandler): void;

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
  getChannel(name: string): ChannelState | undefined;
  getUsers(channel: string): ChannelUser[];
  getUserHostmask(channel: string, nick: string): string | undefined;

  // Permissions (read-only)
  permissions: PluginPermissions;

  // Services (identity verification)
  services: PluginServices;

  // Database (namespaced to this plugin)
  db: PluginDB;

  // Bot config (read-only, password redacted)
  botConfig: PluginBotConfig;

  // Config (from plugins.json overrides, falling back to plugin's config.json)
  config: Record<string, unknown>;

  // Server capabilities (from ISUPPORT)
  getServerSupports(): Record<string, string>;

  // IRC-aware case folding using the connected network's CASEMAPPING
  ircLower(text: string): string;

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

  /** Get the configured channel key (from bot.json), or undefined if none. */
  getChannelKey(channel: string): string | undefined;

  // Logging (prefixed with [plugin:<name>])
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
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
   * Services account name from IRCv3 `account-notify` / `extended-join`.
   * - `string`    — nick is identified as this account
   * - `null`      — nick is known NOT to be identified
   * - `undefined` — no account-notify/extended-join data available for this user
   */
  accountName?: string | null;
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
}

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

/** A channel entry — plain name or name+key for keyed (+k) channels. */
export interface ChannelEntry {
  name: string;
  key?: string;
}

/** IRC connection settings from config/bot.json. */
export interface IrcConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  /** Channel list. Each entry is either a plain name (e.g. "#hexbot") or
   *  an object with a key (e.g. {"name": "#secret", "key": "pass"}). */
  channels: (string | ChannelEntry)[];
  /**
   * Verify the server's TLS certificate against the system CA store. Defaults to `true`.
   * Set to `false` only for networks with self-signed certificates. This disables certificate
   * validation and exposes the connection to MITM attacks — use with caution.
   */
  tls_verify?: boolean;
  /**
   * Path to a TLS client certificate file (PEM format).
   * Required when `services.sasl_mechanism` is "EXTERNAL" (CertFP authentication).
   */
  tls_cert?: string;
  /**
   * Path to a TLS client private key file (PEM format).
   * Required when `services.sasl_mechanism` is "EXTERNAL" (CertFP authentication).
   */
  tls_key?: string;
}

/** Owner settings from config/bot.json. */
export interface OwnerConfig {
  handle: string;
  hostmask: string;
}

/** Identity verification settings. */
export interface IdentityConfig {
  method: 'hostmask';
  require_acc_for: string[];
}

/** Services (NickServ/SASL) settings. */
export interface ServicesConfig {
  type: 'atheme' | 'anope' | 'dalnet' | 'none';
  nickserv: string;
  password: string;
  sasl: boolean;
  /**
   * SASL mechanism to use. Defaults to "PLAIN" (password auth over TLS).
   * Set to "EXTERNAL" to authenticate via TLS client certificate (CertFP) —
   * eliminates the need for a plaintext password in config/bot.json.
   * Requires `irc.tls_cert` and `irc.tls_key` to be set.
   */
  sasl_mechanism?: 'PLAIN' | 'EXTERNAL';
}

/** Logging settings. */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  mod_actions: boolean;
}

/** Message queue / flood-protection settings. */
export interface QueueConfig {
  /** Max messages per second (steady-state). Default: 2 */
  rate?: number;
  /** Burst allowance — messages that can send immediately before throttling. Default: 4 */
  burst?: number;
}

/** Per-event-type flood window configuration. */
export interface FloodWindowConfig {
  /** Max events allowed within the window before blocking. */
  count: number;
  /** Window size in seconds. */
  window: number;
}

/**
 * Input flood limiter configuration.
 * `pub` covers channel commands (pub + pubm); `msg` covers private message commands (msg + msgm).
 * If absent, flood limiting is disabled.
 */
export interface FloodConfig {
  pub?: FloodWindowConfig;
  msg?: FloodWindowConfig;
}

/** SOCKS5 proxy settings. */
export interface ProxyConfig {
  /** Must be true for the proxy to be used. */
  enabled: boolean;
  host: string;
  port: number;
  /** Optional SOCKS5 username. */
  username?: string;
  /** Optional SOCKS5 password. */
  password?: string;
}

/** DCC CHAT / console settings. */
export interface DccConfig {
  /** Enable DCC CHAT. Default: false */
  enabled: boolean;
  /** Bot's public IPv4 address (required if enabled). */
  ip: string;
  /** Port range [min, max] inclusive for passive DCC listeners. */
  port_range: [number, number];
  /** Flags required to open a DCC session. Default: "m" */
  require_flags: string;
  /** Maximum concurrent DCC sessions. Default: 5 */
  max_sessions: number;
  /** Idle timeout in ms before disconnecting. Default: 300000 (5 min) */
  idle_timeout_ms: number;
  /** Require NickServ ACC verification before accepting. Default: false */
  nickserv_verify: boolean;
}

/** Bot-to-bot link settings. */
export interface BotlinkConfig {
  enabled: boolean;
  role: 'hub' | 'leaf';
  botname: string;
  hub?: { host: string; port: number };
  listen?: { host: string; port: number };
  password: string;
  reconnect_delay_ms?: number;
  reconnect_max_delay_ms?: number;
  max_leaves?: number;
  sync_permissions?: boolean;
  sync_channel_state?: boolean;
  sync_bans?: boolean;
  ping_interval_ms: number;
  link_timeout_ms: number;
  /** Max auth failures per IP before temporary ban. Default: 5. */
  max_auth_failures?: number;
  /** Sliding window for counting auth failures (ms). Default: 60 000. */
  auth_window_ms?: number;
  /** Base ban duration after exceeding max_auth_failures (ms). Doubles on each re-ban, capped at 24h. Default: 300 000. */
  auth_ban_duration_ms?: number;
  /** CIDR strings whose IPs bypass auth rate limiting entirely. Default: []. */
  auth_ip_whitelist?: string[];
  /** Handshake timeout (ms). Default: 10 000 (reduced from former 30s). */
  handshake_timeout_ms?: number;
  /** Max concurrent unauthenticated connections per IP. Default: 3. */
  max_pending_handshakes?: number;
}

/** Plugin-specific credentials stored in bot.json (not plugins.json) per SECURITY.md §6. */
export interface ChanmodBotConfig {
  /** NickServ password for GHOST command during nick recovery. Never logged. */
  nick_recovery_password?: string;
}

/** Memo / MemoServ proxy configuration. */
export interface MemoConfig {
  /** Enable MemoServ notice relay to online owners/masters. Default: true. */
  memoserv_relay?: boolean;
  /** Nick of the MemoServ service bot. Default: "MemoServ". */
  memoserv_nick?: string;
  /** Cooldown in seconds between join-delivery notifications per user. Default: 60. */
  delivery_cooldown_seconds?: number;
  /** How long (ms) to wait for MemoServ response after sending a command. Default: 3000. */
  response_timeout_ms?: number;
}

/** Shape for config/bot.json. */
export interface BotConfig {
  irc: IrcConfig;
  owner: OwnerConfig;
  identity: IdentityConfig;
  services: ServicesConfig;
  database: string;
  pluginDir: string;
  pluginsConfig?: string;
  logging: LoggingConfig;
  queue?: QueueConfig;
  flood?: FloodConfig;
  proxy?: ProxyConfig;
  dcc?: DccConfig;
  botlink?: BotlinkConfig;
  quit_message?: string;
  /** Interval in ms for the periodic channel presence check (rejoin missing channels). Default: 30000. Set to 0 to disable. */
  channel_rejoin_interval_ms?: number;
  /** Chanmod plugin credentials (passwords belong here, not in plugins.json). */
  chanmod?: ChanmodBotConfig;
  /** Memo / notes system. */
  memo?: MemoConfig;
}

// ---------------------------------------------------------------------------
// On-disk config shapes (pre-resolution)
//
// These describe the JSON schema stored in config/bot.json. Secrets are
// referenced via `<field>_env` keys naming an environment variable. The
// config loader calls resolveSecrets() to transform these into the runtime
// BotConfig (above), which the rest of the bot reads. See src/config.ts
// and docs/plans/config-secrets-env.md.
// ---------------------------------------------------------------------------

/**
 * On-disk channel entry. Channel `+k` keys are treated as low-sensitivity
 * operational tokens (shared with every channel member) and may live inline
 * via `key`. Operators who prefer to keep them out of the config may use
 * `key_env` to reference an env var instead. See docs/SECURITY.md §6.
 */
export interface ChannelEntryOnDisk {
  name: string;
  /** Inline channel key. Fine for most use cases. */
  key?: string;
  /** Alternative: env var name holding the channel key. Resolved at startup. */
  key_env?: string;
}

/** On-disk IRC config — channels may reference keys via `key_env`. */
export interface IrcConfigOnDisk extends Omit<IrcConfig, 'channels'> {
  channels: (string | ChannelEntryOnDisk)[];
}

/** Swap a runtime `password` field for an on-disk `password_env` reference. */
type WithPasswordEnv<T extends { password?: string }> = Omit<T, 'password'> & {
  password_env?: string;
};

export type ServicesConfigOnDisk = WithPasswordEnv<ServicesConfig>;
export type BotlinkConfigOnDisk = WithPasswordEnv<BotlinkConfig>;
export type ProxyConfigOnDisk = WithPasswordEnv<ProxyConfig>;

/** On-disk chanmod bot credentials — nick recovery password is sourced from env. */
export interface ChanmodBotConfigOnDisk {
  nick_recovery_password_env?: string;
}

/** On-disk bot config — the raw JSON schema before secret resolution. */
export interface BotConfigOnDisk extends Omit<
  BotConfig,
  'irc' | 'services' | 'proxy' | 'botlink' | 'chanmod'
> {
  irc: IrcConfigOnDisk;
  services: ServicesConfigOnDisk;
  proxy?: ProxyConfigOnDisk;
  botlink?: BotlinkConfigOnDisk;
  chanmod?: ChanmodBotConfigOnDisk;
}

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

/** Shape for a single plugin entry in config/plugins.json. */
export interface PluginConfig {
  enabled?: boolean;
  channels?: string[];
  config?: Record<string, unknown>;
}

/** Shape for config/plugins.json (map of plugin name to config). */
export type PluginsConfig = Record<string, PluginConfig>;
