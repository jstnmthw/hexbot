// hexbot — Plugin loader
// Discovers, loads, unloads, and hot-reloads plugins. Each plugin gets a scoped API.
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChannelSettings } from './core/channel-settings';
import type { ChannelState } from './core/channel-state';
import { HelpRegistry } from './core/help-registry';
import type { IRCCommands } from './core/irc-commands';
import type { MessageQueue } from './core/message-queue';
import type { Permissions } from './core/permissions';
import type { Services } from './core/services';
import type { BotDatabase } from './database';
import type { EventDispatcher } from './dispatcher';
import type { BotEventBus } from './event-bus';
import type { Logger } from './logger';
import type {
  BindHandler,
  BindType,
  BotConfig,
  Casemapping,
  ChannelSettingDef,
  ChannelSettingValue,
  ChannelUser,
  HelpEntry,
  PluginAPI,
  PluginChannelSettings,
  PluginDB,
  PluginPermissions,
  PluginServices,
  PluginsConfig,
} from './types';
import { sanitize } from './utils/sanitize';
import { stripFormatting } from './utils/strip-formatting';
import { ircLower } from './utils/wildcard';

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
  messageQueue?: MessageQueue | null;
  services?: Services | null;
  helpRegistry?: HelpRegistry | null;
  channelSettings?: ChannelSettings | null;
  logger?: Logger | null;
  getCasemapping?: () => Casemapping;
  getServerSupports?: () => Record<string, string>;
}

/** Minimal IRC client interface for plugin actions. */
export interface IRCClientForPlugins {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  action(target: string, message: string): void;
  ctcpResponse(target: string, type: string, ...params: string[]): void;
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
  private messageQueue: MessageQueue | null;
  private services: Services | null;
  private helpRegistry: HelpRegistry | null;
  private channelSettings: ChannelSettings | null;
  private logger: Logger | null;
  private rootLogger: Logger | null;
  private getCasemapping: () => Casemapping;
  private getServerSupports: () => Record<string, string>;

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
    this.messageQueue = deps.messageQueue ?? null;
    this.services = deps.services ?? null;
    this.helpRegistry = deps.helpRegistry ?? null;
    this.channelSettings = deps.channelSettings ?? null;
    this.rootLogger = deps.logger ?? null;
    this.logger = deps.logger?.child('plugin-loader') ?? null;
    this.getCasemapping = deps.getCasemapping ?? (() => 'rfc1459');
    this.getServerSupports = deps.getServerSupports ?? (() => ({}));
  }

  /** Delete any orphaned .reload-*.ts temp files left by a previous crashed process. */
  cleanupOrphanedTempFiles(): void {
    try {
      const entries = readdirSync(this.pluginDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = join(this.pluginDir, entry.name);
        try {
          for (const file of readdirSync(pluginDir)) {
            if (/^\.reload-\d+-[^/]+\.ts$/.test(file)) {
              unlinkSync(join(pluginDir, file));
              this.logger?.debug(`Cleaned orphaned temp file: ${entry.name}/${file}`);
            }
          }
        } catch {
          /* plugin dir may not be readable */
        }
      }
    } catch {
      /* plugin dir may not exist yet */
    }
  }

  /** Load all enabled plugins from the plugins config. */
  async loadAll(pluginsConfigPath?: string): Promise<LoadResult[]> {
    this.cleanupOrphanedTempFiles();
    const cfgPath = pluginsConfigPath ?? resolve('./config/plugins.json');
    const pluginsConfig = this.readPluginsConfig(cfgPath);

    if (!pluginsConfig) {
      this.logger?.info('No plugins.json found — skipping plugin loading');
      return [];
    }

    const results: LoadResult[] = [];

    for (const [name, config] of Object.entries(pluginsConfig)) {
      if (!config.enabled) {
        this.logger?.debug(`Skipping disabled plugin: ${name}`);
        continue;
      }

      const pluginPath = join(this.pluginDir, name, 'index.ts');
      const result = await this.load(pluginPath, pluginsConfig);
      results.push(result);
    }

    const ok = results.filter((r) => r.status === 'ok').length;
    const err = results.filter((r) => r.status === 'error').length;
    this.logger?.info(`Loaded ${ok} plugins (${err} errors)`);

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
      mod = await this.importWithCacheBust(absPath);
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
      return {
        name: mod.name as string,
        status: 'error',
        error: 'Plugin must export an "init" function',
      };
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
      return {
        name: pluginName,
        status: 'error',
        error: `Plugin "${pluginName}" is already loaded`,
      };
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
      teardown:
        typeof mod.teardown === 'function'
          ? (mod.teardown as () => void | Promise<void>)
          : undefined,
    };
    this.loaded.set(pluginName, plugin);

    this.eventBus.emit('plugin:loaded', pluginName);
    this.logger?.child(`plugin:${pluginName}`).info(`Loaded v${plugin.version}`);

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
        this.logger?.error(`Teardown error for ${pluginName}:`, err);
      }
    }

    // Remove all binds
    this.dispatcher.unbindAll(pluginName);

    // Remove help entries
    this.helpRegistry?.unregister(pluginName);

    // Remove channel setting defs (stored values are intentionally preserved)
    this.channelSettings?.unregister(pluginName);

    // Remove from loaded map
    this.loaded.delete(pluginName);

    this.eventBus.emit('plugin:unloaded', pluginName);
    this.logger?.info(`Unloaded: ${pluginName}`);
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
    const pluginLogger = this.rootLogger?.child(`plugin:${pluginId}`) ?? null;
    const dispatcher = this.dispatcher;
    const db = this.db;
    const ircClient = this.ircClient;
    const messageQueue = this.messageQueue;
    const channelState = this.channelState;
    const ircCommands = this.ircCommands;
    const permissions = this.permissions;
    const services = this.services;
    const helpRegistry = this.helpRegistry;
    const channelSettings = this.channelSettings;
    const getCasemapping = this.getCasemapping;
    const getServerSupports = this.getServerSupports;

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
          get(): string | undefined {
            return undefined;
          },
          set(): void {},
          del(): void {},
          list(): Array<{ key: string; value: string }> {
            return [];
          },
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

      // IRC actions — routed through message queue for flood protection
      // (sanitize for defense-in-depth, even though irc-framework handles framing)
      say(target: string, message: string): void {
        const safe = sanitize(message);
        if (messageQueue) {
          messageQueue.enqueue(() => ircClient?.say(target, safe));
        } else {
          ircClient?.say(target, safe);
        }
      },
      action(target: string, message: string): void {
        const safe = sanitize(message);
        if (messageQueue) {
          messageQueue.enqueue(() => ircClient?.action(target, safe));
        } else {
          ircClient?.action(target, safe);
        }
      },
      notice(target: string, message: string): void {
        const safe = sanitize(message);
        if (messageQueue) {
          messageQueue.enqueue(() => ircClient?.notice(target, safe));
        } else {
          ircClient?.notice(target, safe);
        }
      },
      ctcpResponse(target: string, type: string, message: string): void {
        const safeTarget = sanitize(target);
        const safeType = sanitize(type);
        const safeMessage = sanitize(message);
        if (messageQueue) {
          messageQueue.enqueue(() => ircClient?.ctcpResponse(safeTarget, safeType, safeMessage));
        } else {
          ircClient?.ctcpResponse(safeTarget, safeType, safeMessage);
        }
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
      halfop(channel: string, nick: string): void {
        ircCommands?.halfop(channel, nick);
      },
      dehalfop(channel: string, nick: string): void {
        ircCommands?.dehalfop(channel, nick);
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
      topic(channel: string, text: string): void {
        ircCommands?.topic(channel, text);
      },
      join(channel: string, key?: string): void {
        ircCommands?.join(channel, key);
      },
      part(channel: string, message?: string): void {
        ircCommands?.part(channel, message);
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
            accountName: u.accountName,
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
          accountName: u.accountName,
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

      // Bot config (read-only, deep-frozen, password redacted)
      botConfig: Object.freeze({
        irc: Object.freeze({
          ...this.botConfig.irc,
          channels: Object.freeze([...this.botConfig.irc.channels]),
        }),
        owner: Object.freeze({ ...this.botConfig.owner }),
        identity: Object.freeze({ ...this.botConfig.identity }),
        services: Object.freeze({
          type: this.botConfig.services.type,
          nickserv: this.botConfig.services.nickserv,
          sasl: this.botConfig.services.sasl,
          // password intentionally omitted
        }),
        // database and pluginDir intentionally omitted — plugins don't need filesystem paths
        logging: Object.freeze({ ...this.botConfig.logging }),
      }),

      // Config
      config: Object.freeze({ ...config }),

      // Server capabilities
      getServerSupports(): Record<string, string> {
        return getServerSupports();
      },

      // IRC-aware case folding using the network's active CASEMAPPING
      ircLower(text: string): string {
        return ircLower(text, getCasemapping());
      },

      // Per-channel settings
      channelSettings: Object.freeze({
        register(defs: ChannelSettingDef[]): void {
          channelSettings?.register(pluginId, defs);
        },
        get(channel: string, key: string): ChannelSettingValue {
          return channelSettings?.get(channel, key) ?? '';
        },
        set(channel: string, key: string, value: ChannelSettingValue): void {
          channelSettings?.set(channel, key, value);
        },
        isSet(channel: string, key: string): boolean {
          return channelSettings?.isSet(channel, key) ?? false;
        },
      } satisfies PluginChannelSettings),

      // Help registry
      registerHelp(entries: HelpEntry[]): void {
        helpRegistry?.register(pluginId, entries);
      },
      getHelpEntries(): HelpEntry[] {
        return helpRegistry?.getAll() ?? [];
      },

      // Formatting utility
      stripFormatting(text: string): string {
        return stripFormatting(text);
      },

      // Logging
      log(...args: unknown[]): void {
        pluginLogger?.info(...args);
      },
      error(...args: unknown[]): void {
        pluginLogger?.error(...args);
      },
      warn(...args: unknown[]): void {
        pluginLogger?.warn(...args);
      },
      debug(...args: unknown[]): void {
        pluginLogger?.debug(...args);
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
        this.logger?.warn(`Failed to read config.json for ${pluginName}:`, err);
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
      this.logger?.error('Failed to parse plugins.json:', err);
      return null;
    }
  }

  /** Import a plugin module with cache busting for all local dependencies. */
  private async importWithCacheBust(absPath: string): Promise<Record<string, unknown>> {
    const ts = Date.now();
    const dir = dirname(absPath);

    // Discover all local .ts files reachable from this plugin entry
    const allFiles = new Map<string, string>(); // abs path -> source
    this.collectLocalModules(absPath, dir, allFiles);

    if (allFiles.size === 1) {
      // Entry-only plugin (no local value imports) — simple query-string cache-bust
      const fileUrl = pathToFileURL(absPath).href + `?t=${ts}`;
      return (await import(fileUrl)) as Record<string, unknown>;
    }

    // Multi-file plugin: create uniquely-named temp copies so Node treats each
    // as a new module, bypassing its module cache.
    // Map: original basename (no ext) -> temp basename (no ext)
    const nameRemap = new Map<string, string>();
    for (const origPath of allFiles.keys()) {
      const base = basename(origPath, '.ts');
      nameRemap.set(base, `.reload-${ts}-${base}`);
    }

    const tmpFiles: string[] = [];
    let entryTmpPath = '';
    try {
      for (const [origPath, source] of allFiles) {
        const base = basename(origPath, '.ts');
        const tmpPath = join(dir, `${nameRemap.get(base)!}.ts`);

        // Rewrite same-directory imports to point to their corresponding temp files
        const rewritten = source.replace(
          /(from\s+['"])(\.\/[^?'"]+)(['"])/g,
          (match, pre: string, spec: string, post: string) => {
            const specBase = basename(spec.replace(/\.(ts|js)$/, ''));
            const remapped = nameRemap.get(specBase);
            return remapped ? `${pre}./${remapped}${post}` : match;
          },
        );

        writeFileSync(tmpPath, rewritten, 'utf-8');
        tmpFiles.push(tmpPath);
        if (origPath === absPath) entryTmpPath = tmpPath;
      }

      const fileUrl = pathToFileURL(entryTmpPath).href;
      return (await import(fileUrl)) as Record<string, unknown>;
    } finally {
      for (const f of tmpFiles) {
        try {
          unlinkSync(f);
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
  }

  /** Recursively collect all local .ts module files reachable from a plugin entry. */
  private collectLocalModules(absPath: string, pluginDir: string, seen: Map<string, string>): void {
    if (seen.has(absPath)) return;

    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      return;
    }

    seen.set(absPath, source);

    // Find all static import specifiers (including type-only; they're erased at runtime)
    const importRe = /from\s+['"](\.[^?'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(source)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('./')) continue; // skip parent-dir imports (e.g. ../../src/types)
      const resolved = resolve(join(dirname(absPath), spec.replace(/\.(ts|js)$/, '') + '.ts'));
      if (resolved.startsWith(pluginDir + '/') && existsSync(resolved)) {
        this.collectLocalModules(resolved, pluginDir, seen);
      }
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
