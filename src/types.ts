// n0xb0t — Shared type definitions
// These are type-only definitions (interfaces/types) — no runtime code.

// ---------------------------------------------------------------------------
// Bind system types
// ---------------------------------------------------------------------------

/** Bind types supported by the dispatcher. */
export type BindType =
  | 'pub'    // Channel message — exact command match, non-stackable
  | 'pubm'   // Channel message — wildcard on full text, stackable
  | 'msg'    // Private message — exact command match, non-stackable
  | 'msgm'   // Private message — wildcard on full text, stackable
  | 'join'   // User joins channel, stackable
  | 'part'   // User parts channel, stackable
  | 'kick'   // User kicked, stackable
  | 'nick'   // Nick change, stackable
  | 'mode'   // Mode change, stackable
  | 'raw'    // Raw server line, stackable
  | 'time'   // Timer (interval), stackable
  | 'ctcp'   // CTCP request, stackable
  | 'notice'; // Notice message, stackable

/** Permission flags: n=owner, m=master, o=op, v=voice, -=anyone. */
export type Flag = 'n' | 'm' | 'o' | 'v' | '-';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/** Context object passed to every bind handler. */
export interface HandlerContext {
  nick: string;
  ident: string;
  hostname: string;
  channel: string | null;  // null for PMs
  text: string;
  command: string;
  args: string;
  reply(msg: string): void;
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

/** Read-only services API for plugins. */
export interface PluginServices {
  verifyUser(nick: string): Promise<{ verified: boolean; account: string | null }>;
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
  raw(line: string): void;

  // IRC channel operations
  op(channel: string, nick: string): void;
  deop(channel: string, nick: string): void;
  voice(channel: string, nick: string): void;
  devoice(channel: string, nick: string): void;
  kick(channel: string, nick: string, reason?: string): void;
  ban(channel: string, mask: string): void;
  mode(channel: string, modes: string, ...params: string[]): void;
  topic(channel: string, text: string): void;

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

  // Bot config (read-only)
  botConfig: Record<string, unknown>;

  // Config (from plugins.json overrides, falling back to plugin's config.json)
  config: Record<string, unknown>;

  // Server capabilities (from ISUPPORT)
  getServerSupports(): Record<string, string>;

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

/** A user present in a channel. */
export interface ChannelUser {
  nick: string;
  ident: string;
  hostname: string;
  modes: string;    // e.g. "o" for op, "v" for voice
  joinedAt: number; // unix timestamp
}

/** State for a single channel. */
export interface ChannelState {
  name: string;
  topic: string;
  modes: string;
  users: Map<string, ChannelUser>;
}

// ---------------------------------------------------------------------------
// User / permissions
// ---------------------------------------------------------------------------

/** A user record in the permissions system. */
export interface UserRecord {
  handle: string;
  hostmasks: string[];
  global: string;                       // global flags, e.g. "nmov"
  channels: Record<string, string>;     // per-channel flag overrides
}

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

/** IRC connection settings from config/bot.json. */
export interface IrcConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  channels: string[];
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
}

/** Logging settings. */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  mod_actions: boolean;
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
}

/** Shape for a single plugin entry in config/plugins.json. */
export interface PluginConfig {
  enabled: boolean;
  channels?: string[];
  config?: Record<string, unknown>;
}

/** Shape for config/plugins.json (map of plugin name to config). */
export type PluginsConfig = Record<string, PluginConfig>;
