// HexBot — Config shapes
//
// Runtime config types (after secret resolution) and on-disk config types
// (pre-resolution, with `<field>_env` references). The config loader's
// resolveSecrets() transforms the on-disk shapes into the runtime shapes
// that the rest of the bot consumes. See src/config.ts.

// ---------------------------------------------------------------------------
// Config shapes — runtime (resolved)
// ---------------------------------------------------------------------------

/** A channel entry — plain name or name+key for keyed (+k) channels. */
export interface ChannelEntry {
  /** Channel name including the `#` (or `&`) prefix. */
  name: string;
  /** Channel key for joining +k channels. Treated as low-sensitivity per SECURITY.md §6. */
  key?: string;
}

/** IRC connection settings from config/bot.json. */
export interface IrcConfig {
  /** IRC server hostname or IP. */
  host: string;
  /** TCP port for the IRC connection. Conventionally 6667 (plaintext) / 6697 (TLS). */
  port: number;
  /** Use TLS for the connection. Strongly recommended; SASL PLAIN credentials over plaintext are refused at startup. */
  tls: boolean;
  /** Primary nick the bot registers as. Subject to GHOST recovery if `ghost_on_recover` is true. */
  nick: string;
  /** USER ident — the local part shown before `@host` in `nick!ident@host`. Often abbreviated. */
  username: string;
  /** GECOS / realname — the free-text "real name" field shown in `/whois`. */
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
  /**
   * Fallback nick used by irc-framework when the primary nick is taken.
   * If absent, irc-framework appends `_` automatically; setting this lets
   * the operator choose a predictable collision nick (e.g. "HEX_backup").
   * Used only as the connection option — the bot still attempts GHOST to
   * reclaim the primary nick when `ghost_on_recover` is true.
   */
  alt_nick?: string;
  /**
   * When true, the bot will attempt GHOST + NICK to reclaim its primary nick
   * if it registers under a collision nick. Requires `services.password` to
   * be set. Default: false.
   */
  ghost_on_recover?: boolean;
}

/** Owner settings from config/bot.json (runtime shape). */
export interface OwnerConfig {
  /** Stable handle for the owner (matches a `UserRecord.handle`). Not the same as a current IRC nick. */
  handle: string;
  /** Initial owner hostmask seeded into the user record. Use account patterns (`$a:owner`) wherever possible — see SECURITY.md §3.3. */
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
 * On-disk owner settings (before secret resolution). The handle and
 * hostmask are bootstrap values — they live in `HEX_OWNER_HANDLE` /
 * `HEX_OWNER_HOSTMASK` env vars (loaded by `src/bootstrap.ts`), not in
 * bot.json. Only the password reference remains here, following the
 * `<field>_env` convention.
 */
export interface OwnerConfigOnDisk {
  /** Name of the env var holding the owner's seed password. Read once at first boot, ignored thereafter. */
  password_env?: string;
}

/** Identity verification settings. */
export interface IdentityConfig {
  /** Identity verification mechanism. Currently only `'hostmask'` is implemented. */
  method: 'hostmask';
  /** Commands (matched by name) that require a successful NickServ ACC verification before running. */
  require_acc_for: string[];
}

/** Services (NickServ/SASL) settings. */
export interface ServicesConfig {
  /** Services flavor. Drives ACC vs STATUS verification syntax and protocol quirks. `'none'` disables NickServ integration entirely. */
  type: 'atheme' | 'anope' | 'dalnet' | 'none';
  /** NickServ target — usually `'NickServ'` but some networks route via `nickserv@services.example.net`. */
  nickserv: string;
  /** Resolved NickServ / SASL password (transformed from `password_env` on disk). */
  password: string;
  /** Negotiate SASL at registration time. Strongly preferred over the `IDENTIFY` fallback. */
  sasl: boolean;
  /**
   * SASL mechanism to use. Defaults to "PLAIN" (password auth over TLS).
   * Set to "EXTERNAL" to authenticate via TLS client certificate (CertFP) —
   * eliminates the need for a plaintext password in config/bot.json.
   * Requires `irc.tls_cert` and `irc.tls_key` to be set.
   */
  sasl_mechanism?: 'PLAIN' | 'EXTERNAL';
  /**
   * When true, the bot waits for `bot:identified` (or the timeout below)
   * before sending JOIN commands after registration. Eliminates the race
   * between IDENTIFY and ChanServ probes on non-SASL networks. Default: false.
   */
  identify_before_join?: boolean;
  /**
   * Max milliseconds to wait for `bot:identified` before joining anyway.
   * Only used when `identify_before_join` is true. Default: 10000.
   */
  identify_before_join_timeout_ms?: number;
  /**
   * Wildcard pattern the NickServ NOTICE sender's hostmask must match
   * before the bot trusts it as a services response. Defence-in-depth
   * against a user `/nick NickServ` on a non-services-reserved network
   * resolving pending `verifyUser()` calls with a crafted ACC reply.
   *
   * Empty or unset disables the check (compatible with networks that
   * don't pin NickServ to a fixed services hostname). Typical values:
   * `services.*`, `*.libera.chat`, `services.rizon.net`.
   */
  services_host_pattern?: string;
}

/** Logging settings. */
export interface LoggingConfig {
  /** Minimum log level emitted by the bot. `'debug'` is verbose enough to drown a busy network — keep at `'info'` in production. */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Persist privileged actions (op/kick/ban/chanset/...) to the `mod_log` table. Disable only in tests. */
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
  /** Proxy hostname or IP. */
  host: string;
  /** Proxy TCP port. */
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
  require_flags?: string;
  /** Maximum concurrent DCC sessions. Default: 5 */
  max_sessions?: number;
  /** Idle timeout in ms before disconnecting. Default: 300000 (5 min) */
  idle_timeout_ms?: number;
}

/** Bot-to-bot link settings. */
export interface BotlinkConfig {
  /** Master switch — when false, no hub server is started and no leaf connect is attempted. */
  enabled: boolean;
  /** This bot's role in the botnet. A leaf connects out to a hub; a hub listens for leaves. */
  role: 'hub' | 'leaf';
  /** This bot's identity within the botnet (distinct from its IRC nick). Must be unique across linked bots. */
  botname: string;
  /** Hub endpoint to connect to. Required when `role: 'leaf'`. */
  hub?: { host: string; port: number };
  /** Listen endpoint for incoming leaf connections. Required when `role: 'hub'`. */
  listen?: { host: string; port: number };
  /** Resolved shared botnet password used in the HELLO HMAC challenge-response. See docs/BOTLINK.md. */
  password: string;
  /**
   * Per-botnet salt (hex). Seeds the scrypt-derived HMAC key used for the
   * HELLO challenge-response handshake. Required when `enabled: true` (both
   * hub and leaf). Must be ≥ 32 hex characters (16 bytes decoded). Not
   * secret on its own, but every bot in a botnet must share the same value.
   * Generate with `openssl rand -hex 32`. Runtime-optional only because
   * config-level validation enforces presence via validateResolvedSecrets
   * when `enabled: true`; operators never leave it unset for a live link.
   */
  link_salt?: string;
  /** Initial reconnect delay (ms) for a leaf that loses its hub link. */
  reconnect_delay_ms?: number;
  /** Cap on the leaf reconnect delay after exponential backoff (ms). */
  reconnect_max_delay_ms?: number;
  /** Hub-side cap on simultaneous connected leaves. */
  max_leaves?: number;
  /** Sync `_permissions` rows across the botnet (hub authoritative, leaves replay). */
  sync_permissions?: boolean;
  /** Sync per-channel state snapshots (NAMES/MODES) on link-up. */
  sync_channel_state?: boolean;
  /** Replicate channel ban/exempt list mutations across linked bots flagged `chanset:shared=true`. */
  sync_bans?: boolean;
  /** How often the hub pings leaves (ms). Default: 30 000. */
  ping_interval_ms?: number;
  /** Disconnect leaves that don't respond within this window (ms). Default: 90 000. */
  link_timeout_ms?: number;
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
  /**
   * Leaf-side soft ceiling on hub→leaf CMD frames per second. A compromised
   * hub would otherwise run unbounded command execution on every leaf; this
   * caps that blast radius to a reasonable admin-burst rate. Default: 50.
   */
  cmd_inbound_rate?: number;
}

/**
 * Plugin-specific credentials stored in bot.json (not plugins.json) per
 * SECURITY.md §6 — secrets must live in env-backed bot.json, never in the
 * plugin-config file that operators share with plugin authors.
 */
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
  /** IRC connection settings. */
  irc: IrcConfig;
  /** Initial owner identity — seeds the first privileged user record on a fresh DB. */
  owner: OwnerConfig;
  /** Identity verification policy (which commands require NickServ ACC). */
  identity: IdentityConfig;
  /** NickServ / SASL settings. */
  services: ServicesConfig;
  /** Path to the SQLite database file. Created on first start. */
  database: string;
  /** Directory containing plugin folders. Each subdirectory is a plugin. */
  pluginDir: string;
  /** Optional path to plugins.json (overrides plugin-shipped defaults). */
  pluginsConfig?: string;
  /** Logging level + mod-action retention policy. */
  logging: LoggingConfig;
  /** Outbound message queue / flood-protection settings. */
  queue?: QueueConfig;
  /** Inbound flood limiter for user commands. */
  flood?: FloodConfig;
  /** Optional SOCKS5 proxy for the IRC connection. */
  proxy?: ProxyConfig;
  /** DCC CHAT console settings — gated by `enabled`. */
  dcc?: DccConfig;
  /** Bot-to-bot link settings — gated by `enabled`. */
  botlink?: BotlinkConfig;
  /** Server-visible QUIT message used during clean shutdown. */
  quit_message?: string;
  /** Interval in ms for the periodic channel presence check (rejoin missing channels). Default: 30000. Set to 0 to disable. */
  channel_rejoin_interval_ms?: number;
  /**
   * Backoff schedule (ms between retries) for rejoining channels that failed
   * with a permanent-error numeric (+b/+i/+k/+r). Each entry is the delay
   * before the next JOIN attempt after the previous failure. After the last
   * tier, the bot stops retrying until the next reconnect or a manual
   * `.join`. Default: [300000, 900000, 2700000] (5, 15, 45 minutes). Set to
   * `[]` to disable retries entirely (original pre-bounded-retry behavior).
   */
  channel_retry_schedule_ms?: number[];
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
// BotConfig (above), which the rest of the bot reads. See src/config.ts.
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

/**
 * On-disk bot config — the raw JSON schema before secret resolution.
 *
 * `database`, `pluginDir`, `owner.handle`, and `owner.hostmask` are
 * bootstrap values: they live in env vars (`HEX_DB_PATH`,
 * `HEX_PLUGIN_DIR`, `HEX_OWNER_HANDLE`, `HEX_OWNER_HOSTMASK`) loaded by
 * `src/bootstrap.ts` *before* this config is parsed. The on-disk shape
 * therefore omits them; `Bot.loadConfig` folds the bootstrap values into
 * the runtime {@link BotConfig} shape on construction.
 */
export interface BotConfigOnDisk extends Omit<
  BotConfig,
  'irc' | 'owner' | 'services' | 'proxy' | 'botlink' | 'chanmod' | 'database' | 'pluginDir'
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
  /** Disable a plugin without removing its directory. Defaults to true. */
  enabled?: boolean;
  /** Optional channel allowlist — when set, the plugin's binds only fire on these channels. */
  channels?: string[];
  /** Plugin-specific config blob. Schema is defined by the plugin itself. */
  config?: Record<string, unknown>;
}

/** Shape for config/plugins.json (map of plugin name to config). */
export type PluginsConfig = Record<string, PluginConfig>;
