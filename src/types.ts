// hexbot — Shared type definitions
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
  | 'invite'; // Bot invited to a channel, stackable

/** Permission flags: n=owner, m=master, o=op, v=voice, -=anyone. */
export type Flag = 'n' | 'm' | 'o' | 'v' | '-';

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
  topic(channel: string, text: string): void;
  /** Change the bot's own IRC nick (e.g. for nick recovery). */
  changeNick(nick: string): void;

  // Channel state
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
  /** Channel modes as a string (e.g. `"+mnt"`). */
  modes: string;
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

/** Shape for config/bot.json. */
export interface BotConfig {
  irc: IrcConfig;
  owner: OwnerConfig;
  identity: IdentityConfig;
  services: ServicesConfig;
  database: string;
  pluginDir: string;
  logging: LoggingConfig;
  queue?: QueueConfig;
  flood?: FloodConfig;
  proxy?: ProxyConfig;
  dcc?: DccConfig;
  quit_message?: string;
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
}

/** ChannelSettingDef with its owning plugin attached (internal + PluginAPI). */
export interface ChannelSettingEntry extends ChannelSettingDef {
  pluginId: string;
}

/** Per-channel settings API provided to plugins. */
export interface PluginChannelSettings {
  /** Declare per-channel setting definitions for this plugin. Call once in init(). */
  register(defs: ChannelSettingDef[]): void;
  /** Read a per-channel setting. Returns def.default if not set by an operator. */
  get(channel: string, key: string): ChannelSettingValue;
  /** Write a per-channel setting (for plugin-managed settings, e.g. topic text). */
  set(channel: string, key: string, value: ChannelSettingValue): void;
  /** True if an operator has explicitly set this value (not relying on default). */
  isSet(channel: string, key: string): boolean;
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
}

/** Shape for a single plugin entry in config/plugins.json. */
export interface PluginConfig {
  enabled: boolean;
  channels?: string[];
  config?: Record<string, unknown>;
}

/** Shape for config/plugins.json (map of plugin name to config). */
export type PluginsConfig = Record<string, PluginConfig>;
