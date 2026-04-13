/**
 * HexBot — Configuration types
 *
 * Shapes for `config/bot.json` and `config/plugins.json`.
 * These types mirror the config files exactly — all optional fields
 * are optional here too.
 */

// ---------------------------------------------------------------------------
// Channel entry
// ---------------------------------------------------------------------------

/**
 * A channel entry in `irc.channels`. Either a plain name string or an object
 * with a `key` for password-protected (`+k`) channels.
 *
 * @example
 * "channels": ["#general", { "name": "#secret", "key": "pass123" }]
 */
export interface ChannelEntry {
  /** Channel name (e.g. `"#secret"`). */
  name: string;
  /** Channel key required to join a `+k` channel. */
  key?: string;
}

// ---------------------------------------------------------------------------
// IRC connection
// ---------------------------------------------------------------------------

/**
 * IRC connection settings (`config/bot.json` → `irc`).
 *
 * @example
 * {
 *   "host": "irc.libera.chat",
 *   "port": 6697,
 *   "tls": true,
 *   "nick": "MyBot",
 *   "username": "mybot",
 *   "realname": "My IRC Bot",
 *   "channels": ["#general", "#dev"]
 * }
 */
export interface IrcConfig {
  /** IRC server hostname or IP address. */
  host: string;
  /** IRC server port. Default is `6697` for TLS, `6667` for plaintext. */
  port: number;
  /** Whether to use TLS. **Strongly recommended** — defaults to `true`. */
  tls: boolean;
  /** Bot's desired nick. */
  nick: string;
  /** IRC username (ident). */
  username: string;
  /** IRC real name / GECOS field. */
  realname: string;
  /**
   * Channels to join automatically on connect. Each entry is either a plain
   * channel name (`"#general"`) or a `ChannelEntry` object with a key for
   * password-protected channels.
   */
  channels: (string | ChannelEntry)[];
  /**
   * Verify the server's TLS certificate against the system CA store. Defaults to `true`.
   * Set to `false` only for networks with self-signed certificates — disables certificate
   * validation and exposes the connection to MITM attacks.
   */
  tls_verify?: boolean;
  /**
   * Path to a PEM-format TLS client certificate file.
   * Required when `services.sasl_mechanism` is `"EXTERNAL"` (CertFP).
   *
   * @example "certs/bot.pem"
   */
  tls_cert?: string;
  /**
   * Path to a PEM-format TLS client private key file.
   * Required when `services.sasl_mechanism` is `"EXTERNAL"` (CertFP).
   *
   * @example "certs/bot.key"
   */
  tls_key?: string;
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

/**
 * Bot owner settings (`config/bot.json` → `owner`).
 *
 * The owner entry is automatically created in the permissions database on startup
 * with `n` (owner) flags. If no owner record exists yet, it is created from
 * `handle` + `hostmask`.
 */
export interface OwnerConfig {
  /**
   * Unique handle for the owner user.
   * @example "alice"
   */
  handle: string;
  /**
   * Hostmask pattern identifying the owner.
   * Wildcards `*` and `?` are supported.
   * Prefer a static host or services cloak over `nick!*@*`.
   *
   * @example "*!alice@trusted.vps.net"
   * @example "*!*@user/alice"          // Services-assigned cloak (recommended)
   */
  hostmask: string;
}

// ---------------------------------------------------------------------------
// Identity / permissions
// ---------------------------------------------------------------------------

/**
 * Identity verification settings (`config/bot.json` → `identity`).
 *
 * Controls when the dispatcher requires NickServ ACC verification before
 * calling a privileged handler.
 */
export interface IdentityConfig {
  /**
   * Identity method. Currently only `'hostmask'` is supported:
   * users are identified by matching their `nick!ident@hostname` against
   * registered hostmask patterns.
   */
  method: 'hostmask';
  /**
   * Flag levels that require NickServ ACC verification before a handler fires.
   * The dispatcher automatically gates any bind whose required flags are at
   * or above any threshold listed here.
   *
   * Use the `+flag` format (e.g. `"+o"`, `"+n"`).
   *
   * @example ["+o", "+n"]  // Verify all op-level and owner-level handlers
   * @example []            // Disabled — no ACC verification required
   */
  require_acc_for: string[];
}

// ---------------------------------------------------------------------------
// Services (NickServ / SASL)
// ---------------------------------------------------------------------------

/**
 * Services integration settings (`config/bot.json` → `services`).
 *
 * Configures how the bot authenticates with NickServ and how it verifies
 * user identity.
 *
 * ### Authentication methods (in order of security)
 *
 * 1. **SASL EXTERNAL (CertFP)** — Most secure. Bot authenticates with a TLS
 *    client certificate. No password stored in config.
 *    Set `sasl: true`, `sasl_mechanism: "EXTERNAL"`, and `irc.tls_cert` + `irc.tls_key`.
 *
 * 2. **SASL PLAIN** — Bot sends password via SASL during connection (over TLS).
 *    Set `sasl: true` (default) and `password`.
 *
 * 3. **NickServ IDENTIFY** — Bot sends `PRIVMSG NickServ :IDENTIFY password` after
 *    connecting. Less secure than SASL. Set `sasl: false` and `password`.
 */
export interface ServicesConfig {
  /**
   * Services software variant. Determines the ACC/STATUS query format used
   * for identity verification.
   *
   * | Value      | Software       | Verification command              |
   * |------------|----------------|-----------------------------------|
   * | `"atheme"` | Atheme (Libera)| `NickServ ACC <nick>`             |
   * | `"anope"`  | Anope          | `NickServ STATUS <nick>`          |
   * | `"dalnet"` | DALnet         | `NickServ ACCESS <nick>`          |
   * | `"none"`   | No services    | `verifyUser()` always returns true |
   */
  type: 'atheme' | 'anope' | 'dalnet' | 'none';
  /**
   * NickServ target nick. Default `"NickServ"`. Change for networks that use
   * a different name (e.g. `"AuthServ"` on QuakeNet).
   */
  nickserv: string;
  /**
   * NickServ/SASL password. Required for `sasl: true` (PLAIN) or IDENTIFY.
   * Leave empty when using SASL EXTERNAL (CertFP) — no password is needed.
   */
  password: string;
  /** Use SASL for authentication (recommended). Default `true`. */
  sasl: boolean;
  /**
   * SASL mechanism. Default `"PLAIN"`.
   *
   * Set to `"EXTERNAL"` to use TLS client certificate authentication (CertFP).
   * Requires `irc.tls_cert` and `irc.tls_key` to point to valid PEM files,
   * and the certificate's fingerprint must be registered with NickServ.
   */
  sasl_mechanism?: 'PLAIN' | 'EXTERNAL';
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Logging settings (`config/bot.json` → `logging`). */
export interface LoggingConfig {
  /** Minimum log level. Messages below this level are suppressed. */
  level: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Whether to write moderation actions (op, deop, kick, ban) to the `mod_log`
   * database table. Useful for audit trails.
   */
  mod_actions: boolean;
  /**
   * Retention window for mod_log rows, in days. Default `0` (unlimited).
   * On startup, rows older than the cutoff are deleted in a single pass.
   */
  mod_log_retention_days?: number;
}

// ---------------------------------------------------------------------------
// Message queue
// ---------------------------------------------------------------------------

/**
 * Outbound message rate-limiting settings (`config/bot.json` → `queue`).
 *
 * The message queue uses a token-bucket algorithm to prevent IRC flood
 * disconnects. All `say()`, `notice()`, and `action()` calls pass through it.
 */
export interface QueueConfig {
  /**
   * Steady-state messages per second. Default: `2`.
   * IRC servers typically tolerate ~1–2 messages/second before throttling.
   */
  rate?: number;
  /**
   * Burst allowance — messages that can be sent immediately before the rate
   * limit kicks in. Default: `4`.
   */
  burst?: number;
}

// ---------------------------------------------------------------------------
// Input flood limiter
// ---------------------------------------------------------------------------

/**
 * Per-event-type flood window configuration.
 * When the event count within the window is exceeded, further events are blocked.
 */
export interface FloodWindowConfig {
  /** Maximum events allowed within the window before blocking. */
  count: number;
  /** Window size in seconds. */
  window: number;
}

/**
 * Input flood limiter settings (`config/bot.json` → `flood`).
 *
 * `pub` covers channel commands (`pub` + `pubm`); `msg` covers private message
 * commands (`msg` + `msgm`). If absent, flood limiting is disabled.
 *
 * @example
 * {
 *   "pub":  { "count": 5, "window": 10 },
 *   "msg":  { "count": 3, "window": 10 }
 * }
 */
export interface FloodConfig {
  pub?: FloodWindowConfig;
  msg?: FloodWindowConfig;
}

// ---------------------------------------------------------------------------
// SOCKS5 proxy
// ---------------------------------------------------------------------------

/**
 * Optional SOCKS5 proxy settings (`config/bot.json` → `proxy`).
 * Useful for connecting through Tor or a corporate proxy.
 */
export interface ProxyConfig {
  /** Must be `true` for the proxy to be used. Presence of the config block alone does not activate it. */
  enabled: boolean;
  /** SOCKS5 proxy hostname or IP. */
  host: string;
  /** SOCKS5 proxy port. */
  port: number;
  /** Optional SOCKS5 username for authenticated proxies. */
  username?: string;
  /** Optional SOCKS5 password for authenticated proxies. */
  password?: string;
}

// ---------------------------------------------------------------------------
// DCC CHAT
// ---------------------------------------------------------------------------

/**
 * DCC CHAT settings (`config/bot.json` → `dcc`).
 *
 * The bot uses passive DCC only: it opens a listening port, sends the user
 * a CTCP DCC CHAT token, and the user connects. No active DCC (no `SEND`
 * from the bot's side).
 *
 * **Security note:** The listening port accepts the first TCP connection
 * within the 30-second window, regardless of source IP. Ensure
 * `nickserv_verify: true` and strong `require_flags` for untrusted networks.
 */
export interface DccConfig {
  /** Enable DCC CHAT support. Default `false`. */
  enabled: boolean;
  /**
   * Bot's public IPv4 address. Required when `enabled: true`.
   * Must be reachable by users (not a NAT'd private address).
   */
  ip: string;
  /**
   * Port range `[min, max]` (inclusive) for passive DCC listeners.
   * Ensure these ports are open in the firewall.
   *
   * @example [49152, 49200]
   */
  port_range: [number, number];
  /**
   * Minimum flag level required to open a DCC session. Default `"m"` (master).
   * Use `"n"` to restrict to owner-only.
   */
  require_flags: string;
  /** Maximum concurrent DCC sessions. Default `5`. */
  max_sessions: number;
  /**
   * Idle timeout before disconnecting an inactive DCC session, in milliseconds.
   * Default `300000` (5 minutes).
   */
  idle_timeout_ms: number;
  /**
   * Require NickServ ACC verification (level ≥ 3) before accepting a DCC
   * connection. Recommended on public networks. Default `false`.
   */
  nickserv_verify: boolean;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/**
 * Shape of `config/bot.json` — the main bot configuration file.
 *
 * This file contains credentials and should be mode `600` (owner read/write only).
 * The bot will refuse to start if the file is world-readable.
 *
 * @example
 * {
 *   "irc": { "host": "irc.libera.chat", "port": 6697, "tls": true, ... },
 *   "owner": { "handle": "alice", "hostmask": "*!*@user/alice" },
 *   "identity": { "method": "hostmask", "require_acc_for": ["+o"] },
 *   "services": { "type": "atheme", "nickserv": "NickServ", "password": "s3cret", "sasl": true },
 *   "database": "./data/hexbot.db",
 *   "pluginDir": "./plugins",
 *   "logging": { "level": "info", "mod_actions": true }
 * }
 */
export interface BotConfig {
  irc: IrcConfig;
  owner: OwnerConfig;
  identity: IdentityConfig;
  services: ServicesConfig;
  /** Path to the SQLite database file. Created if it does not exist. */
  database: string;
  /** Path to the plugins directory. Default `'./plugins'`. */
  pluginDir: string;
  logging: LoggingConfig;
  queue?: QueueConfig;
  flood?: FloodConfig;
  proxy?: ProxyConfig;
  dcc?: DccConfig;
  /** QUIT message sent when the bot shuts down. */
  quit_message?: string;
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/**
 * A single plugin entry in `config/plugins.json`.
 *
 * @example
 * {
 *   "chanmod": {
 *     "enabled": true,
 *     "channels": ["#general", "#dev"]
 *   },
 *   "greeter": {
 *     "enabled": true,
 *     "config": {
 *       "greeting": "Welcome to {channel}, {nick}!"
 *     }
 *   }
 * }
 */
export interface PluginConfig {
  /** Whether this plugin is loaded on startup. Default `true`. */
  enabled: boolean;
  /**
   * Whitelist of channels where this plugin is active.
   * If omitted, the plugin is active in all channels the bot is in.
   */
  channels?: string[];
  /**
   * Config overrides merged on top of the plugin's own `config.json` defaults.
   * Available to the plugin as `api.config`.
   */
  config?: Record<string, unknown>;
}

/**
 * Shape of `config/plugins.json` — maps plugin names to their configs.
 * Plugin names must match the `name` export of the plugin's `index.ts`.
 */
export type PluginsConfig = Record<string, PluginConfig>;
