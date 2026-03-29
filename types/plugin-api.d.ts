/**
 * HexBot — Plugin API types
 *
 * Defines every interface a plugin interacts with via the `api` object
 * received in `init()`. All objects on the API are frozen at runtime.
 */
import type {
  BindHandler,
  BindType,
  ChannelState,
  ChannelUser,
  HandlerContext,
} from './events.d.ts';

// ---------------------------------------------------------------------------
// Permission flags
// ---------------------------------------------------------------------------

/**
 * Single-character permission flags. Flags are hierarchical: `n` implies all
 * lower flags; `-` matches anyone regardless of registration.
 *
 * | Flag | Name   | Description                                |
 * |------|--------|--------------------------------------------|
 * | `n`  | owner  | Full control — implies m, o, v             |
 * | `m`  | master | Elevated admin — implies o, v              |
 * | `o`  | op     | Channel operator level                     |
 * | `v`  | voice  | Voiced user level                          |
 * | `-`  | anyone | No flag check — handler fires for everyone |
 */
export type Flag = 'n' | 'm' | 'o' | 'v' | '-';

// ---------------------------------------------------------------------------
// User record
// ---------------------------------------------------------------------------

/**
 * A registered user in the permissions database.
 *
 * Users are identified by hostmask patterns (`nick!ident@hostname`), which
 * support `*` and `?` wildcards. Multiple hostmasks may be registered for
 * the same user.
 *
 * @example
 * // Example user record
 * {
 *   handle: 'alice',
 *   hostmasks: ['*!alice@trusted.host.com', '*!*@user/alice'],
 *   global: 'o',        // has +o globally
 *   channels: {
 *     '#dev': 'n',      // has +n (owner) in #dev specifically
 *   }
 * }
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
}

// ---------------------------------------------------------------------------
// Database API
// ---------------------------------------------------------------------------

/**
 * Namespaced key-value database for a single plugin.
 *
 * All operations are scoped to the plugin's namespace automatically — no
 * namespace prefix is needed in keys. The underlying store is SQLite with
 * WAL mode and synchronous reads.
 *
 * @example
 * // Store a value
 * api.db.set('last_seen:alice', String(Date.now()));
 *
 * // Retrieve it
 * const ts = api.db.get('last_seen:alice');
 *
 * // List all last_seen entries
 * const entries = api.db.list('last_seen:');
 */
export interface PluginDB {
  /**
   * Retrieve a value by key.
   * @returns The stored string value, or `undefined` if the key does not exist.
   */
  get(key: string): string | undefined;
  /**
   * Store a value. Creates or overwrites the entry.
   * @param key   Storage key. Use `:` as a namespace separator by convention.
   * @param value String value to store.
   */
  set(key: string, value: string): void;
  /** Delete a key. No-op if the key does not exist. */
  del(key: string): void;
  /**
   * List all entries whose key starts with `prefix`.
   * @param prefix Optional prefix filter. Omit to list all plugin keys.
   * @returns Array of `{ key, value }` pairs, ordered by key.
   */
  list(prefix?: string): Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Permissions API
// ---------------------------------------------------------------------------

/**
 * Read-only view of the permissions system provided to plugins.
 * Plugins may look up users and check flags, but cannot mutate the database.
 * Use the built-in `.adduser` / `.flags` dot commands for mutations.
 */
export interface PluginPermissions {
  /**
   * Find a registered user by their full hostmask (`nick!ident@hostname`).
   * Wildcards in registered hostmask patterns are matched against the provided value.
   * @returns The matching `UserRecord`, or `null` if no registered user matches.
   */
  findByHostmask(hostmask: string): UserRecord | null;
  /**
   * Check whether a user has the required flags to trigger a handler.
   * Respects per-channel overrides and the flag hierarchy (`n` implies `m` implies `o` implies `v`).
   * @param requiredFlags A flag character (`'n'`, `'m'`, `'o'`, `'v'`) or `'-'` for anyone.
   * @param ctx           The handler context supplying nick/ident/hostname/channel.
   * @returns `true` if the user has sufficient flags.
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
 * Prefer checking `ChannelUser.accountName` first (zero-latency, populated
 * via IRCv3 `account-notify` / `extended-join`). Fall back to `verifyUser()`
 * when `accountName` is `undefined` (no account-notify data available yet).
 */
export interface PluginServices {
  /**
   * Asynchronously verify a nick's NickServ identity via ACC/STATUS query.
   *
   * This sends a PRIVMSG to NickServ and waits for the response. If the
   * server supports `account-notify` / `extended-join`, prefer reading
   * `ChannelUser.accountName` directly (synchronous, no network round-trip).
   *
   * @param nick The IRC nick to verify.
   * @returns Promise resolving to a `VerifyResult`.
   *
   * @example
   * api.bind('join', 'o', '*', async (ctx) => {
   *   const u = api.getUsers(ctx.channel!).find(u => u.nick === ctx.nick);
   *   if (u?.accountName !== undefined) {
   *     // Fast path: already know account status from extended-join
   *     if (u.accountName) api.op(ctx.channel!, ctx.nick);
   *   } else {
   *     // Slow path: query NickServ
   *     const { verified } = await api.services.verifyUser(ctx.nick);
   *     if (verified) api.op(ctx.channel!, ctx.nick);
   *   }
   * });
   */
  verifyUser(nick: string): Promise<VerifyResult>;
  /**
   * Returns `true` if a services adapter is configured (`services.type` is not `'none'`).
   * When `false`, `verifyUser()` always resolves `{ verified: true, account: null }`.
   */
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Channel settings API
// ---------------------------------------------------------------------------

/** Supported value types for per-channel settings. */
export type ChannelSettingType = 'flag' | 'string' | 'int';

/** Runtime value returned by `ChannelSettings.get()`. */
export type ChannelSettingValue = boolean | string | number;

/**
 * Definition of a per-channel setting registered by a plugin.
 *
 * @example
 * api.channelSettings.register([
 *   { key: 'greet', type: 'flag', default: true,  description: 'Enable join greetings' },
 *   { key: 'greet_msg', type: 'string', default: 'Welcome, {nick}!', description: 'Greeting text' },
 *   { key: 'max_lines', type: 'int', default: 3, description: 'Max output lines' },
 * ]);
 */
export interface ChannelSettingDef {
  /**
   * Globally unique key for this setting. Use your plugin ID as a prefix to
   * avoid collisions: `'myplugin_setting'`.
   */
  key: string;
  type: ChannelSettingType;
  /**
   * Default value returned when no operator has explicitly set this setting.
   * Must match the declared `type`: `boolean` for `'flag'`, `string` for
   * `'string'`, `number` for `'int'`.
   */
  default: ChannelSettingValue;
  /** Human-readable description shown in `.chaninfo` output. */
  description: string;
}

/**
 * Per-channel settings API for plugins.
 *
 * Settings are declared once in `init()` via `register()` and then accessed
 * per-channel with `get()` / `set()`. Values persist to the database and
 * are editable by operators via `.chanset`.
 */
export interface PluginChannelSettings {
  /**
   * Declare this plugin's per-channel settings. Call once in `init()`.
   * @param defs Array of setting definitions.
   */
  register(defs: ChannelSettingDef[]): void;
  /**
   * Get the current value of a setting for a specific channel.
   * Returns the `def.default` value if an operator has not set it explicitly.
   * @param channel Lowercased channel name (e.g. `'#general'`).
   * @param key     The setting key as declared in `register()`.
   */
  get(channel: string, key: string): ChannelSettingValue;
  /**
   * Write a setting value for a channel. Use for plugin-managed state
   * (e.g. storing topic text). For operator-set values, use `.chanset` instead.
   */
  set(channel: string, key: string, value: ChannelSettingValue): void;
  /**
   * Returns `true` if an operator has explicitly set this value (not relying on default).
   */
  isSet(channel: string, key: string): boolean;
}

// ---------------------------------------------------------------------------
// Help registry
// ---------------------------------------------------------------------------

/**
 * A single help entry registered by a plugin.
 *
 * @example
 * api.registerHelp([{
 *   command: '!seen',
 *   flags: '-',
 *   usage: '!seen <nick>',
 *   description: 'Show when a nick was last active.',
 *   detail: ['Returns the timestamp of the last message or join from <nick>.'],
 *   category: 'info',
 * }]);
 */
export interface HelpEntry {
  /** Command trigger including `!` prefix (e.g. `'!op'`). */
  command: string;
  /** Required flags to use this command. Same format as `bind()` flags (`'o'`, `'-'`, etc.). */
  flags: string;
  /** Concise usage line (e.g. `'!op [nick]'`). */
  usage: string;
  /** One-line description shown in `!help` listings. */
  description: string;
  /** Extended description lines shown in `!help <command>`. */
  detail?: string[];
  /** Grouping category shown in `!help`. Defaults to the plugin ID if unset. */
  category?: string;
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

/**
 * The scoped API object every plugin receives in `init()`.
 *
 * All properties are frozen at runtime. Attempting to mutate the API or its
 * nested objects will throw in strict mode.
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
 *   api.log('Loaded');
 * }
 */
export interface PluginAPI {
  /**
   * This plugin's registered name. Matches the `name` export.
   * All binds, database entries, and log messages are scoped to this ID.
   */
  readonly pluginId: string;

  // -------------------------------------------------------------------------
  // Bind system
  // -------------------------------------------------------------------------

  /**
   * Register a handler for an IRC event.
   *
   * @param type    The event type to listen for.
   * @param flags   Required permission flags. Use `'-'` for public commands.
   *                The dispatcher checks flags before calling the handler —
   *                the handler only fires if the user has sufficient privileges.
   * @param mask    Event mask. Semantics vary by type:
   *                - `pub`/`msg`: exact command (e.g. `'!op'`); case-insensitive
   *                - `pubm`/`msgm`: wildcard pattern on full text (e.g. `'*hello*'`)
   *                - `join`/`part`/`kick`: `'#channel nick!ident@host'` or `'*'` for all
   *                - `mode`: `'#channel +o'` or `'*'` for all modes
   *                - `ctcp`: CTCP type (e.g. `'VERSION'`); case-insensitive
   *                - `time`: interval in seconds as a string (min `'10'`)
   *                - all others: `'*'` to match everything
   * @param handler The function to call when the event fires.
   *
   * @example
   * // Public !hello command
   * api.bind('pub', '-', '!hello', ctx => ctx.reply('Hello!'));
   *
   * // Op-only !kick command
   * api.bind('pub', 'o', '!kick', async (ctx) => {
   *   const nick = ctx.args.split(' ')[0];
   *   if (nick) api.kick(ctx.channel!, nick, 'Requested');
   * });
   *
   * // Timer: run every 60 seconds
   * api.bind('time', '-', '60', () => {
   *   api.log('Tick!');
   * });
   */
  bind(type: BindType, flags: string, mask: string, handler: BindHandler): void;

  /**
   * Remove a previously registered handler. The `handler` reference must be
   * the same function object passed to `bind()`. Generally unnecessary — the
   * plugin loader removes all binds automatically on unload.
   */
  unbind(type: BindType, mask: string, handler: BindHandler): void;

  // -------------------------------------------------------------------------
  // IRC output
  // -------------------------------------------------------------------------

  /**
   * Send a PRIVMSG to a channel or nick.
   * Output is rate-limited through the message queue.
   * @param target Channel name (e.g. `'#general'`) or nick.
   * @param message Message text. Long messages are NOT automatically split here
   *                (use `ctx.reply()` for automatic splitting).
   */
  say(target: string, message: string): void;

  /**
   * Send a `/me` action PRIVMSG (CTCP ACTION).
   * @param target Channel name or nick.
   * @param message Action text (without the `/me ` prefix).
   */
  action(target: string, message: string): void;

  /**
   * Send a NOTICE to a channel or nick.
   * @param target Channel name or nick.
   * @param message Notice text.
   */
  notice(target: string, message: string): void;

  /**
   * Send a CTCP reply (e.g. in response to a VERSION request).
   * @param target Nick to reply to.
   * @param type   CTCP type (e.g. `'VERSION'`, `'PING'`).
   * @param message CTCP reply payload.
   */
  ctcpResponse(target: string, type: string, message: string): void;

  // -------------------------------------------------------------------------
  // Channel management
  // -------------------------------------------------------------------------

  /** Join a channel, optionally with a key. */
  join(channel: string, key?: string): void;

  /** Part a channel with an optional reason message. */
  part(channel: string, message?: string): void;

  /** Give channel operator status to a nick. */
  op(channel: string, nick: string): void;

  /** Remove channel operator status from a nick. */
  deop(channel: string, nick: string): void;

  /** Give voice status to a nick. */
  voice(channel: string, nick: string): void;

  /** Remove voice status from a nick. */
  devoice(channel: string, nick: string): void;

  /** Give half-operator status to a nick (server must support `+h`). */
  halfop(channel: string, nick: string): void;

  /** Remove half-operator status from a nick. */
  dehalfop(channel: string, nick: string): void;

  /**
   * Kick a nick from a channel.
   * @param reason Optional kick reason shown to the user.
   */
  kick(channel: string, nick: string, reason?: string): void;

  /**
   * Ban a hostmask from a channel (`MODE #chan +b mask`).
   * @param mask Full hostmask to ban (e.g. `'*!*@evil.host'`).
   */
  ban(channel: string, mask: string): void;

  /**
   * Set one or more channel modes.
   * Mode changes are automatically batched to respect the server's MODES limit.
   * @param modes Mode string (e.g. `'+im'`, `'-o'`).
   * @param params Optional mode parameters (one per parameterised mode).
   *
   * @example
   * api.mode('#general', '+m');           // Set moderated
   * api.mode('#general', '+o', 'alice');  // Op alice
   */
  mode(channel: string, modes: string, ...params: string[]): void;

  /**
   * Set the channel topic.
   * @param text New topic text.
   */
  topic(channel: string, text: string): void;

  // -------------------------------------------------------------------------
  // Channel state
  // -------------------------------------------------------------------------

  /**
   * Get the current state of a channel.
   * @param name Channel name (case-insensitive).
   * @returns Channel state object, or `undefined` if the bot is not in the channel.
   *
   * @example
   * const ch = api.getChannel('#general');
   * if (ch) {
   *   api.log(`${ch.users.size} users in ${ch.name}`);
   * }
   */
  getChannel(name: string): ChannelState | undefined;

  /**
   * Get all users currently in a channel as a flat array.
   * @param channel Channel name (case-insensitive).
   * @returns Array of `ChannelUser` objects, or `[]` if the bot is not in the channel.
   */
  getUsers(channel: string): ChannelUser[];

  /**
   * Get the full hostmask (`nick!ident@hostname`) for a user in a channel.
   * @returns The hostmask string, or `undefined` if the user is not in the channel.
   */
  getUserHostmask(channel: string, nick: string): string | undefined;

  // -------------------------------------------------------------------------
  // Permissions, services, and database
  // -------------------------------------------------------------------------

  /** Read-only access to the permissions database. */
  readonly permissions: PluginPermissions;

  /** NickServ identity verification. */
  readonly services: PluginServices;

  /**
   * Namespaced key-value database scoped to this plugin.
   * All keys are automatically prefixed — no namespace management needed.
   */
  readonly db: PluginDB;

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * The bot's core configuration (`config/bot.json`), read-only and deep-frozen.
   * The NickServ/SASL password is redacted — never present in this object.
   */
  readonly botConfig: Record<string, unknown>;

  /**
   * This plugin's merged configuration. Values come from the plugin's own
   * `config.json` defaults, overridden by the `config` key in
   * `config/plugins.json`.
   *
   * @example
   * // In init():
   * const greeting = (api.config.greeting as string) ?? 'Hello!';
   */
  readonly config: Record<string, unknown>;

  // -------------------------------------------------------------------------
  // Server capabilities
  // -------------------------------------------------------------------------

  /**
   * Get the server's ISUPPORT (005) capabilities.
   * @returns Key-value map of all ISUPPORT tokens received from the server.
   *
   * @example
   * const modes = api.getServerSupports()['MODES']; // e.g. '4'
   * const casemapping = api.getServerSupports()['CASEMAPPING']; // e.g. 'rfc1459'
   */
  getServerSupports(): Record<string, string>;

  /**
   * Lowercase a nick or channel name using the server's CASEMAPPING setting.
   * Use when comparing or storing nicks/channel names as map keys.
   *
   * @example
   * const key = api.ircLower('#General'); // '#general' on most networks
   */
  ircLower(text: string): string;

  // -------------------------------------------------------------------------
  // Per-channel settings
  // -------------------------------------------------------------------------

  /** Per-channel settings API. Declare settings once in `init()` via `register()`. */
  readonly channelSettings: PluginChannelSettings;

  // -------------------------------------------------------------------------
  // Help system
  // -------------------------------------------------------------------------

  /**
   * Register help entries for this plugin's commands.
   * Entries appear in `!help` listings and `!help <command>` detail.
   * Call once in `init()`.
   */
  registerHelp(entries: HelpEntry[]): void;

  /** Get all currently registered help entries (from all plugins). */
  getHelpEntries(): HelpEntry[];

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Strip IRC formatting and control characters from a string.
   *
   * Removes bold (`\x02`), color (`\x03`), italic (`\x1D`), underline (`\x1F`),
   * strikethrough (`\x1E`), monospace (`\x11`), reverse (`\x16`), and reset (`\x0F`),
   * including any color code parameters.
   *
   * **Use whenever user-controlled values appear in security-relevant output**
   * (permission grants, op/kick/ban announcements, log messages) to prevent IRC
   * color codes from visually hiding or spoofing messages.
   *
   * @example
   * api.say(channel, `Ops granted to ${api.stripFormatting(ctx.nick)}`);
   */
  stripFormatting(text: string): string;

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  /**
   * Log at INFO level. Output is prefixed with `[plugin:<pluginId>]`.
   */
  log(...args: unknown[]): void;

  /**
   * Log at ERROR level. Output is prefixed with `[plugin:<pluginId>]`.
   */
  error(...args: unknown[]): void;

  /**
   * Log at WARN level. Output is prefixed with `[plugin:<pluginId>]`.
   */
  warn(...args: unknown[]): void;

  /**
   * Log at DEBUG level (only shown when `logging.level` is `'debug'`).
   * Output is prefixed with `[plugin:<pluginId>]`.
   */
  debug(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Plugin module shape
// ---------------------------------------------------------------------------

/**
 * Required and optional exports for a HexBot plugin module.
 *
 * A plugin is a directory under `plugins/` containing an `index.ts` that
 * exports at least `name`, `version`, `description`, and `init`.
 *
 * @example
 * // plugins/my-plugin/index.ts
 * import type { PluginAPI } from '../../types/index.d.ts';
 *
 * export const name = 'my-plugin';
 * export const version = '1.0.0';
 * export const description = 'An example plugin.';
 *
 * let intervalId: ReturnType<typeof setInterval> | null = null;
 *
 * export function init(api: PluginAPI): void {
 *   api.bind('pub', '-', '!ping', ctx => ctx.reply('pong'));
 *   api.log('Loaded');
 * }
 *
 * export function teardown(): void {
 *   if (intervalId) clearInterval(intervalId);
 * }
 */
export interface PluginExports {
  /** Plugin identifier — must be unique. Alphanumeric, hyphens, underscores. */
  name: string;
  /** Semantic version string (e.g. `'1.2.3'`). */
  version: string;
  /** One-line description of the plugin. */
  description: string;
  /**
   * Called when the plugin is loaded (or hot-reloaded). Register all binds here.
   * May be async.
   */
  init(api: PluginAPI): void | Promise<void>;
  /**
   * Called when the plugin is unloaded or hot-reloaded. Clean up any external
   * resources (timers, open connections, etc.). Binds are removed automatically
   * by the loader — no need to call `api.unbind()` here.
   */
  teardown?(): void | Promise<void>;
}
