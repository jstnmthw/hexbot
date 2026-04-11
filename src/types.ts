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
 * Context object passed to every bind handler. The plugin-facing `api.bind` is
 * generic on `BindType`, so each handler receives a context narrowed to its
 * bind type — see {@link BindContextFor}. For example, a `'pub'` handler gets
 * {@link ChannelHandlerContext} (channel is `string`), and a `'join'` handler
 * gets {@link JoinContext} (channel is `string`, command is the literal
 * `'JOIN'`, args is the literal `''`).
 *
 * `HandlerContext` below is the *union* of every per-type shape, used by the
 * dispatcher and permission internals where the bind type isn't known at
 * compile time.
 *
 * Field semantics by bind type (cross-reference the type names in the last
 * column — each one is exported for use outside `api.bind` callbacks):
 *
 * | type        | nick            | channel       | text                         | command             | args                    | interface                        |
 * |-------------|-----------------|---------------|------------------------------|---------------------|-------------------------|----------------------------------|
 * | pub         | sender          | #channel      | full message (raw)           | command word        | text after command      | {@link ChannelHandlerContext}    |
 * | pubm        | sender          | #channel      | full message (raw)           | command word / `''` for `/me` | args / action text | {@link ChannelHandlerContext}    |
 * | msg         | sender          | null (PM)     | full message (raw)           | command word        | text after command      | {@link NullChannelHandlerContext}|
 * | msgm        | sender          | null (PM)     | full message (raw)           | command word / `''` for `/me` | args / action text | {@link NullChannelHandlerContext}|
 * | join        | joiner          | #channel      | `"#chan nick!ident@host"`    | `'JOIN'`            | `''`                    | {@link JoinContext}              |
 * | part        | parter          | #channel      | `"#chan nick!ident@host"`    | `'PART'`            | part reason             | {@link PartContext}              |
 * | kick        | **kicked** nick | #channel      | `"#chan kicked!ident@host"`  | `'KICK'`            | `"reason (by kicker)"`  | {@link KickContext}              |
 * | nick        | old nick        | null          | new nick                     | `'NICK'`            | new nick                | {@link NickContext}              |
 * | mode        | mode setter     | #channel      | `"#chan +o nick"`            | mode string (`+o`)  | mode param              | {@link ModeContext}              |
 * | ctcp        | sender          | null          | CTCP payload (no type prefix)| CTCP type (upper)   | CTCP payload            | {@link CtcpContext}              |
 * | notice      | sender          | #chan / null  | notice text                  | `'NOTICE'`          | notice text             | {@link NullableChannelHandlerContext}|
 * | topic       | setter          | #channel      | new topic                    | `'topic'`           | `''`                    | {@link TopicContext}             |
 * | quit        | quitter         | null          | quit reason                  | `'quit'`            | `''`                    | {@link QuitContext}              |
 * | invite      | inviter         | #channel      | `"#chan nick!ident@host"`    | `'INVITE'`          | `''`                    | {@link InviteContext}            |
 * | time        | `''`            | null          | `''`                         | `''`                | `''`                    | {@link TimeContext}              |
 * | raw         | `''`            | null          | raw server line              | raw command         | raw params              | {@link RawContext}               |
 * | join_error  | bot nick        | #channel      | failure reason               | error name          | `''`                    | {@link JoinErrorContext}         |
 */
export interface BaseHandlerContext {
  /** Nick of the user who triggered this event. For `kick`: the kicked user (not the kicker). */
  nick: string;
  /** Ident of the user who triggered this event. */
  ident: string;
  /** Hostname of the user who triggered this event. */
  hostname: string;
  /**
   * Services account name for the triggering user, when IRCv3 `account-tag`
   * was present on the inbound message.
   * - `string`    — authoritative: server confirmed this account sent the message
   * - `null`      — authoritative: server confirmed the sender is not identified
   * - `undefined` — tag not available (no account-tag cap, non-PRIVMSG event,
   *                 or server didn't include the tag on this message)
   * Plugin authors should treat a defined value as safer than a WHOIS / ACC
   * round-trip and an undefined value as "unknown, fall back to other signals".
   */
  account?: string | null;
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

/** Channel is guaranteed to be set. Bind types: `pub`, `pubm`, `join`, `part`, `kick`, `mode`, `topic`, `invite`, `join_error`. */
export interface ChannelHandlerContext extends BaseHandlerContext {
  channel: string;
}

/** Channel is guaranteed to be null. Bind types: `msg`, `msgm`, `nick`, `ctcp`, `quit`, `time`, `raw`. */
export interface NullChannelHandlerContext extends BaseHandlerContext {
  channel: null;
}

/**
 * Channel may be either. Bind type: `notice` — channel notices carry a channel,
 * PM notices do not. Handlers must narrow before using `channel`.
 */
export interface NullableChannelHandlerContext extends BaseHandlerContext {
  channel: string | null;
}

/** Context for `'join'` binds. */
export interface JoinContext extends ChannelHandlerContext {
  command: 'JOIN';
  args: '';
}

/** Context for `'part'` binds. `args` is the part reason (may be empty). */
export interface PartContext extends ChannelHandlerContext {
  command: 'PART';
}

/**
 * Context for `'kick'` binds. `nick` is the *kicked* user (not the kicker);
 * `args` is `"reason (by kicker)"` or `"by kicker"`.
 */
export interface KickContext extends ChannelHandlerContext {
  command: 'KICK';
}

/** Context for `'nick'` binds. `nick` is the old nick; `args` and `text` are the new nick. */
export interface NickContext extends NullChannelHandlerContext {
  command: 'NICK';
}

/** Context for `'mode'` binds. `command` is the mode string (e.g. `'+o'`); `args` is the mode parameter. */
// Mode strings are not literal-narrowable, so this is structurally identical to ChannelHandlerContext.
export type ModeContext = ChannelHandlerContext;

/** Context for `'topic'` binds. `text` is the new topic. */
export interface TopicContext extends ChannelHandlerContext {
  command: 'topic';
  args: '';
}

/** Context for `'invite'` binds. */
export interface InviteContext extends ChannelHandlerContext {
  command: 'INVITE';
  args: '';
}

/** Context for `'quit'` binds. `text` is the quit reason. */
export interface QuitContext extends NullChannelHandlerContext {
  command: 'quit';
  args: '';
}

/** Context for `'time'` (timer) binds. All user fields are empty — timers fire on a schedule, not on user input. */
export interface TimeContext extends NullChannelHandlerContext {
  nick: '';
  ident: '';
  hostname: '';
  text: '';
  command: '';
  args: '';
}

/** Context for `'join_error'` binds. `command` is the irc-framework error name (or `'need_registered_nick'`); `text` is the failure reason. */
export interface JoinErrorContext extends ChannelHandlerContext {
  args: '';
}

/** Context for `'ctcp'` binds. `command` is the uppercased CTCP type (e.g. `'PING'`); `text`/`args` are the payload. */
// CTCP types are user-controlled and unbounded, so this is structurally identical to NullChannelHandlerContext.
export type CtcpContext = NullChannelHandlerContext;

/** Context for `'raw'` binds. Free-form fields carrying the raw server line. */
// Raw binds are rarely used and fields are already loose, so this is structurally identical to NullChannelHandlerContext.
export type RawContext = NullChannelHandlerContext;

/**
 * Mapped type: pick the right handler context for a given bind type.
 * Used by {@link BindHandler} to narrow `ctx` at plugin call sites.
 */
export type BindContextFor<T extends BindType> = T extends 'pub'
  ? ChannelHandlerContext
  : T extends 'pubm'
    ? ChannelHandlerContext
    : T extends 'msg'
      ? NullChannelHandlerContext
      : T extends 'msgm'
        ? NullChannelHandlerContext
        : T extends 'join'
          ? JoinContext
          : T extends 'part'
            ? PartContext
            : T extends 'kick'
              ? KickContext
              : T extends 'nick'
                ? NickContext
                : T extends 'mode'
                  ? ModeContext
                  : T extends 'raw'
                    ? RawContext
                    : T extends 'time'
                      ? TimeContext
                      : T extends 'ctcp'
                        ? CtcpContext
                        : T extends 'notice'
                          ? NullableChannelHandlerContext
                          : T extends 'topic'
                            ? TopicContext
                            : T extends 'quit'
                              ? QuitContext
                              : T extends 'invite'
                                ? InviteContext
                                : T extends 'join_error'
                                  ? JoinErrorContext
                                  : never;

/**
 * The widest handler context — a union over every bind type. Used by dispatcher
 * and permission internals where the bind type isn't statically known. Plugin
 * authors rarely see this directly; `api.bind<'pub'>(...)` narrows automatically.
 */
export type HandlerContext = BindContextFor<BindType>;

/**
 * Signature for bind handler functions. Generic on `BindType` so `ctx` narrows
 * to the specific per-type shape at the call site. Defaults to the widest
 * `HandlerContext` union for code that takes handlers without knowing the type.
 */
export type BindHandler<T extends BindType = BindType> = (
  ctx: BindContextFor<T>,
) => void | Promise<void>;

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
  ): number;
  /** Migrate ban records from a plugin's old namespace to the core _bans namespace. */
  migrateFromPluginNamespace(pluginDb: PluginDB): number;
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
  getChannel(name: string): ChannelState | undefined;
  getUsers(channel: string): ChannelUser[];
  getUserHostmask(channel: string, nick: string): string | undefined;

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
