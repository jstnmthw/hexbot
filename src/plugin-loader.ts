// n0xb0t — Plugin loader
// Discovers, loads, unloads, and hot-reloads plugins. Each plugin gets a scoped API.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EventDispatcher } from './dispatcher.js';
import type { BotEventBus } from './event-bus.js';
import type { BotDatabase } from './database.js';
import type { Permissions } from './core/permissions.js';
import type { ChannelState } from './core/channel-state.js';
import type { IRCCommands } from './core/irc-commands.js';
import type { Services } from './core/services.js';
import type {
  PluginAPI,
  PluginDB,
  PluginPermissions,
  PluginServices,
  PluginsConfig,
  BindType,
  BindHandler,
  BotConfig,
  ChannelUser,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single plugin load attempt. */
export interface LoadResult {
  name: string;
  status: 'ok' | 'error';
  error?: string;
}

/** Info about a loaded plugin (returned by list()). */
export interface LoadedPluginInfo {
  name: string;
  version: string;
  description: string;
  filePath: string;
}

/** Internal tracking for a loaded plugin. */
interface LoadedPlugin {
  name: string;
  version: string;
  description: string;
  filePath: string;
  teardown?: () => void | Promise<void>;
}

/** Dependencies injected into the plugin loader. */
export interface PluginLoaderDeps {
  pluginDir: string;
  dispatcher: EventDispatcher;
  eventBus: BotEventBus;
  db: BotDatabase | null;
  permissions: Permissions;
  botConfig: BotConfig;
  ircClient: IRCClientForPlugins | null;
  channelState?: ChannelState | null;
  ircCommands?: IRCCommands | null;
  services?: Services | null;
}

/** Minimal IRC client interface for plugin actions. */
export interface IRCClientForPlugins {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  action(target: string, message: string): void;
  raw(line: string): void;
}

/** Safe plugin name pattern. */
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export class PluginLoader {
  private loaded: Map<string, LoadedPlugin> = new Map();
  private pluginDir: string;
  private dispatcher: EventDispatcher;
  private eventBus: BotEventBus;
  private db: BotDatabase | null;
  private permissions: Permissions;
  private botConfig: BotConfig;
  private ircClient: IRCClientForPlugins | null;
  private channelState: ChannelState | null;
  private ircCommands: IRCCommands | null;
  private services: Services | null;

  constructor(deps: PluginLoaderDeps) {
    this.pluginDir = resolve(deps.pluginDir);
    this.dispatcher = deps.dispatcher;
    this.eventBus = deps.eventBus;
    this.db = deps.db;
    this.permissions = deps.permissions;
    this.botConfig = deps.botConfig;
    this.ircClient = deps.ircClient;
    this.channelState = deps.channelState ?? null;
    this.ircCommands = deps.ircCommands ?? null;
    this.services = deps.services ?? null;
  }

  /** Load all enabled plugins from the plugins config. */
  async loadAll(pluginsConfigPath?: string): Promise<LoadResult[]> {
    const cfgPath = pluginsConfigPath ?? resolve('./config/plugins.json');
    const pluginsConfig = this.readPluginsConfig(cfgPath);

    if (!pluginsConfig) {
      console.log('[plugin-loader] No plugins.json found — skipping plugin loading');
      return [];
    }

    const results: LoadResult[] = [];

    for (const [name, config] of Object.entries(pluginsConfig)) {
      if (!config.enabled) {
        console.log(`[plugin-loader] Skipping disabled plugin: ${name}`);
        continue;
      }

      const pluginPath = join(this.pluginDir, name, 'index.ts');
      const result = await this.load(pluginPath, pluginsConfig);
      results.push(result);
    }

    const ok = results.filter((r) => r.status === 'ok').length;
    const err = results.filter((r) => r.status === 'error').length;
    console.log(`[plugin-loader] Loaded ${ok} plugins (${err} errors)`);

    return results;
  }

  /** Load a single plugin from a file path. */
  async load(pluginPath: string, pluginsConfig?: PluginsConfig): Promise<LoadResult> {
    const absPath = resolve(pluginPath);

    if (!existsSync(absPath)) {
      const name = this.inferPluginName(absPath);
      return { name, status: 'error', error: `Plugin file not found: ${absPath}` };
    }

    let mod: Record<string, unknown>;
    try {
      const fileUrl = pathToFileURL(absPath).href + `?t=${Date.now()}`;
      mod = await import(fileUrl) as Record<string, unknown>;
    } catch (err) {
      const name = this.inferPluginName(absPath);
      const message = err instanceof Error ? err.message : String(err);
      return { name, status: 'error', error: `Failed to import plugin: ${message}` };
    }

    // Validate required exports
    if (typeof mod.name !== 'string' || !mod.name) {
      const name = this.inferPluginName(absPath);
      return { name, status: 'error', error: 'Plugin must export a "name" string' };
    }
    if (typeof mod.init !== 'function') {
      return { name: mod.name as string, status: 'error', error: 'Plugin must export an "init" function' };
    }

    const pluginName = mod.name as string;

    // Validate safe name
    if (!SAFE_NAME_RE.test(pluginName)) {
      return {
        name: pluginName,
        status: 'error',
        error: `Plugin name "${pluginName}" contains invalid characters (must be alphanumeric, hyphens, underscores)`,
      };
    }

    // Reject duplicate
    if (this.loaded.has(pluginName)) {
      return { name: pluginName, status: 'error', error: `Plugin "${pluginName}" is already loaded` };
    }

    // Create scoped API
    const config = this.mergeConfig(pluginName, absPath, pluginsConfig);
    const api = this.createPluginApi(pluginName, config);

    // Call init()
    try {
      const result = (mod.init as (api: PluginAPI) => void | Promise<void>)(api);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Clean up any binds registered before the error
      this.dispatcher.unbindAll(pluginName);
      return { name: pluginName, status: 'error', error: `Plugin init() threw: ${message}` };
    }

    // Track loaded plugin
    const plugin: LoadedPlugin = {
      name: pluginName,
      version: typeof mod.version === 'string' ? mod.version : '0.0.0',
      description: typeof mod.description === 'string' ? mod.description : '',
      filePath: absPath,
      teardown: typeof mod.teardown === 'function' ? mod.teardown as () => void | Promise<void> : undefined,
    };
    this.loaded.set(pluginName, plugin);

    this.eventBus.emit('plugin:loaded', pluginName);
    console.log(`[plugin-loader] Loaded: ${pluginName} v${plugin.version}`);

    return { name: pluginName, status: 'ok' };
  }

  /** Unload a plugin by name. */
  async unload(pluginName: string): Promise<void> {
    const plugin = this.loaded.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }

    // Call teardown if it exists
    if (plugin.teardown) {
      try {
        const result = plugin.teardown();
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        console.error(`[plugin-loader] Teardown error for ${pluginName}:`, err);
      }
    }

    // Remove all binds
    this.dispatcher.unbindAll(pluginName);

    // Remove from loaded map
    this.loaded.delete(pluginName);

    this.eventBus.emit('plugin:unloaded', pluginName);
    console.log(`[plugin-loader] Unloaded: ${pluginName}`);
  }

  /** Reload a plugin (unload + load from same path). */
  async reload(pluginName: string): Promise<LoadResult> {
    const plugin = this.loaded.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" is not loaded`);
    }

    const filePath = plugin.filePath;
    await this.unload(pluginName);

    const result = await this.load(filePath);

    if (result.status === 'ok') {
      this.eventBus.emit('plugin:reloaded', pluginName);
    }

    return result;
  }

  /** List all loaded plugins. */
  list(): LoadedPluginInfo[] {
    return Array.from(this.loaded.values()).map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      filePath: p.filePath,
    }));
  }

  /** Check if a plugin is loaded. */
  isLoaded(pluginName: string): boolean {
    return this.loaded.has(pluginName);
  }

  // -------------------------------------------------------------------------
  // Scoped plugin API
  // -------------------------------------------------------------------------

  private createPluginApi(pluginId: string, config: Record<string, unknown>): PluginAPI {
    const dispatcher = this.dispatcher;
    const db = this.db;
    const ircClient = this.ircClient;
    const channelState = this.channelState;
    const ircCommands = this.ircCommands;
    const permissions = this.permissions;
    const services = this.services;

    // Scoped database API
    const pluginDb: PluginDB = db
      ? Object.freeze({
          get(key: string): string | undefined {
            return db.get(pluginId, key) ?? undefined;
          },
          set(key: string, value: string): void {
            db.set(pluginId, key, value);
          },
          del(key: string): void {
            db.del(pluginId, key);
          },
          list(prefix?: string): Array<{ key: string; value: string }> {
            return db.list(pluginId, prefix);
          },
        })
      : Object.freeze({
          get(): string | undefined { return undefined; },
          set(): void {},
          del(): void {},
          list(): Array<{ key: string; value: string }> { return []; },
        });

    // Read-only permissions API
    const pluginPermissions: PluginPermissions = Object.freeze({
      findByHostmask(hostmask: string) {
        return permissions.findByHostmask(hostmask);
      },
      checkFlags(requiredFlags: string, ctx: import('./types.js').HandlerContext) {
        return permissions.checkFlags(requiredFlags, ctx);
      },
    });

    // Services API (read-only verification)
    const pluginServicesApi: PluginServices = Object.freeze({
      async verifyUser(nick: string) {
        if (!services) return { verified: false, account: null };
        return services.verifyUser(nick);
      },
      isAvailable() {
        return services?.isAvailable() ?? false;
      },
    });

    const api: PluginAPI = {
      pluginId,

      // Bind system (auto-tagged with pluginId)
      bind(type: BindType, flags: string, mask: string, handler: BindHandler): void {
        dispatcher.bind(type, flags, mask, handler, pluginId);
      },
      unbind(type: BindType, mask: string, handler: BindHandler): void {
        dispatcher.unbind(type, mask, handler);
      },

      // IRC actions
      say(target: string, message: string): void {
        ircClient?.say(target, message);
      },
      action(target: string, message: string): void {
        ircClient?.action(target, message);
      },
      notice(target: string, message: string): void {
        ircClient?.notice(target, message);
      },
      raw(line: string): void {
        ircClient?.raw(line);
      },

      // IRC channel operations (delegated to IRCCommands)
      op(channel: string, nick: string): void {
        ircCommands?.op(channel, nick);
      },
      deop(channel: string, nick: string): void {
        ircCommands?.deop(channel, nick);
      },
      voice(channel: string, nick: string): void {
        ircCommands?.voice(channel, nick);
      },
      devoice(channel: string, nick: string): void {
        ircCommands?.devoice(channel, nick);
      },
      kick(channel: string, nick: string, reason?: string): void {
        ircCommands?.kick(channel, nick, reason);
      },
      ban(channel: string, mask: string): void {
        ircCommands?.ban(channel, mask);
      },
      mode(channel: string, modes: string, ...params: string[]): void {
        ircCommands?.mode(channel, modes, ...params);
      },

      // Channel state
      getChannel(name: string) {
        if (!channelState) return undefined;
        const ch = channelState.getChannel(name);
        if (!ch) return undefined;
        // Convert UserInfo (internal) to ChannelUser (plugin-facing)
        const users = new Map<string, ChannelUser>();
        for (const [key, u] of ch.users) {
          users.set(key, {
            nick: u.nick,
            ident: u.ident,
            hostname: u.hostname,
            modes: u.modes.join(''),
            joinedAt: u.joinedAt.getTime(),
          });
        }
        return { name: ch.name, topic: ch.topic, modes: ch.modes, users };
      },
      getUsers(channel: string): ChannelUser[] {
        if (!channelState) return [];
        const ch = channelState.getChannel(channel);
        if (!ch) return [];
        return Array.from(ch.users.values()).map((u) => ({
          nick: u.nick,
          ident: u.ident,
          hostname: u.hostname,
          modes: u.modes.join(''),
          joinedAt: u.joinedAt.getTime(),
        }));
      },
      getUserHostmask(channel: string, nick: string): string | undefined {
        return channelState?.getUserHostmask(channel, nick);
      },

      // Permissions (read-only)
      permissions: pluginPermissions,

      // Services (identity verification)
      services: pluginServicesApi,

      // Database
      db: pluginDb,

      // Bot config (read-only)
      botConfig: Object.freeze({ ...this.botConfig }),

      // Config
      config: Object.freeze({ ...config }),

      // Server capabilities
      getServerSupports(): Record<string, string> {
        return {};
      },

      // Logging
      log(...args: unknown[]): void {
        console.log(`[plugin:${pluginId}]`, ...args);
      },
      error(...args: unknown[]): void {
        console.error(`[plugin:${pluginId}]`, ...args);
      },
    };

    return Object.freeze(api);
  }

  // -------------------------------------------------------------------------
  // Config merging
  // -------------------------------------------------------------------------

  /** Merge plugin's own config.json with plugins.json overrides. */
  private mergeConfig(
    pluginName: string,
    pluginFilePath: string,
    pluginsConfig?: PluginsConfig,
  ): Record<string, unknown> {
    // Read plugin's own config.json defaults
    const pluginDir = resolve(pluginFilePath, '..');
    const pluginConfigPath = join(pluginDir, 'config.json');
    let defaults: Record<string, unknown> = {};

    if (existsSync(pluginConfigPath)) {
      try {
        const raw = readFileSync(pluginConfigPath, 'utf-8');
        defaults = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        console.warn(`[plugin-loader] Failed to read config.json for ${pluginName}:`, err);
      }
    }

    // Overlay with plugins.json overrides
    const overrides = pluginsConfig?.[pluginName]?.config ?? {};

    return { ...defaults, ...overrides };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Read plugins.json config file. */
  private readPluginsConfig(configPath: string): PluginsConfig | null {
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as PluginsConfig;
    } catch (err) {
      console.error(`[plugin-loader] Failed to parse plugins.json:`, err);
      return null;
    }
  }

  /** Infer a plugin name from its file path. */
  private inferPluginName(filePath: string): string {
    // Try to get the parent directory name
    const parts = filePath.split('/');
    const indexIdx = parts.lastIndexOf('index.ts');
    if (indexIdx > 0) {
      return parts[indexIdx - 1];
    }
    // Fallback: filename without extension
    const last = parts[parts.length - 1];
    return last.replace(/\.(ts|js)$/, '');
  }
}
