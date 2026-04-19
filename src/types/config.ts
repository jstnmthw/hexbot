// HexBot — Config shapes
//
// Runtime config types (after secret resolution) and on-disk config types
// (pre-resolution, with `<field>_env` references). The config loader's
// resolveSecrets() transforms the on-disk shapes into the runtime shapes
// that the rest of the bot consumes. See src/config.ts and
// docs/plans/config-secrets-env.md.

// ---------------------------------------------------------------------------
// Config shapes — runtime (resolved)
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

/** Owner settings from config/bot.json (runtime shape). */
export interface OwnerConfig {
  handle: string;
  hostmask: string;
  /**
   * Seed password, resolved from `password_env` in the on-disk config. Used
   * by `Bot.ensureOwner()` to seed the owner's password hash on first boot
   * when the DB has none. After the hash exists it is DB-of-record — further
   * boots ignore this field, exactly like MySQL's `MYSQL_ROOT_PASSWORD`.
   */
  password?: string;
}

/**
 * On-disk owner settings (before secret resolution). Mirrors {@link OwnerConfig}
 * but accepts `password_env` instead of a resolved `password`. The config
 * loader's `resolveSecrets()` rewrites the `_env` suffix into its sibling.
 */
export interface OwnerConfigOnDisk {
  handle: string;
  hostmask: string;
  password_env?: string;
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
  /**
   * Retention window for mod_log rows, in days. Optional; `0` or unset
   * means unlimited. On startup, rows older than the cutoff are deleted
   * in a single DELETE and the count is logged.
   */
  mod_log_retention_days?: number;
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
  /**
   * Prefix for built-in admin commands (`.help`, `.say`, `.join`, …) executed
   * via the REPL or a DCC CHAT session. Default: `"."`. Change this if `.`
   * collides with another tool's input or if you want a less-chatty prefix.
   * Plugin-owned command binds choose their own prefixes — this setting is
   * scoped to `CommandHandler` alone.
   */
  command_prefix?: string;
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
  'irc' | 'owner' | 'services' | 'proxy' | 'botlink' | 'chanmod'
> {
  irc: IrcConfigOnDisk;
  owner: OwnerConfigOnDisk;
  services: ServicesConfigOnDisk;
  proxy?: ProxyConfigOnDisk;
  botlink?: BotlinkConfigOnDisk;
  chanmod?: ChanmodBotConfigOnDisk;
}

// ---------------------------------------------------------------------------
// Plugin config shapes
// ---------------------------------------------------------------------------

/** Shape for a single plugin entry in config/plugins.json. */
export interface PluginConfig {
  enabled?: boolean;
  channels?: string[];
  config?: Record<string, unknown>;
}

/** Shape for config/plugins.json (map of plugin name to config). */
export type PluginsConfig = Record<string, PluginConfig>;
