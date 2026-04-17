// HexBot — Plugin loader
// Discovers, loads, unloads, and hot-reloads plugins. Each plugin gets a scoped API.
// The shape of that API (and the per-plugin wrappers) lives in plugin-api-factory.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveSecrets } from './config';
import type { BanStore } from './core/ban-store';
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
import type { LoggerLike } from './logger';
import { type IRCClientForPlugins, createPluginApi } from './plugin-api-factory';
import type { BotConfig, Casemapping, PluginAPI, PluginsConfig } from './types';

export type { IRCClientForPlugins };

// ---------------------------------------------------------------------------
// Plugin module shape
// ---------------------------------------------------------------------------

/** The subset of a plugin module we need for validation + lifecycle calls. */
interface PluginModule {
  name: string;
  version?: unknown;
  description?: unknown;
  // The second arg is an optional, plugin-specific deps bag forwarded from
  // `load(..., deps)`. Plugins that don't take deps declare `init(api)` and
  // the extra arg is simply ignored at the JS level.
  init: (api: PluginAPI, deps?: unknown) => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

/** Type-guard: does an imported module conform to the required export shape? */
function isValidPluginModule(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & PluginModule {
  /* v8 ignore next -- name already validated by caller, this is a redundant guard */
  if (typeof mod.name !== 'string' || mod.name.length === 0) return false;
  if (typeof mod.init !== 'function') return false;
  /* v8 ignore next -- defensive: tests never supply a non-function teardown */
  if (mod.teardown !== undefined && typeof mod.teardown !== 'function') return false;
  return true;
}

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
  /**
   * Neutralise the plugin's api handle — every method becomes a no-op.
   * Called after teardown so a stale closure retaining the api can't
   * fan out to the dispatcher, database, or IRC client on the next
   * reload. See audit finding W-PS1 (2026-04-14).
   */
  disposeApi: () => void;
  /** True if teardown() threw an error — resources may not have been released cleanly. */
  teardownFailed?: boolean;
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
  banStore?: BanStore | null;
  logger?: LoggerLike | null;
  getCasemapping?: () => Casemapping;
  getServerSupports?: () => Record<string, string>;
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
  private banStore: BanStore | null;
  private logger: LoggerLike | null;
  private rootLogger: LoggerLike | null;
  private getCasemapping: () => Casemapping;
  private getServerSupports: () => Record<string, string>;
  private modesReadyListeners: Map<string, Array<(channel: string) => void>> = new Map();
  private permissionsChangedListeners: Map<string, Array<(handle: string) => void>> = new Map();
  /** Absolute paths of plugin entry files already imported in this process. */
  private importedOnce: Set<string> = new Set();

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
    this.banStore = deps.banStore ?? null;
    this.rootLogger = deps.logger ?? null;
    this.logger = deps.logger?.child('plugin-loader') ?? null;
    this.getCasemapping = deps.getCasemapping ?? (() => 'rfc1459');
    this.getServerSupports = deps.getServerSupports ?? (() => ({}));
  }

  /** Read-only access to the bot config (for integration tests that need to adjust settings). */
  getBotConfig(): BotConfig {
    return this.botConfig;
  }

  /** Load all enabled plugins from the plugins config + auto-discovered plugins. */
  async loadAll(pluginsConfigPath?: string): Promise<LoadResult[]> {
    /* v8 ignore next -- ?? fallback: tests always pass an explicit path; default production path unreachable */
    const cfgPath = pluginsConfigPath ?? resolve('./config/plugins.json');
    const pluginsConfig = this.readPluginsConfig(cfgPath) ?? {};

    // Build the full set of plugin names: configured plugins first, then
    // auto-discovered plugins from the plugins directory that aren't listed.
    // Keys from `plugins.json` pass through `join(pluginDir, name, 'dist', 'index.js')`
    // below, so any entry whose name fails SAFE_NAME_RE is a path-traversal
    // attempt and is dropped with a loud warning instead of being imported.
    const pluginNames = new Set<string>();
    for (const rawName of Object.keys(pluginsConfig)) {
      if (!SAFE_NAME_RE.test(rawName)) {
        this.logger?.warn(
          `Ignoring plugin config entry "${rawName}" — invalid name (path-traversal guard)`,
        );
        continue;
      }
      pluginNames.add(rawName);
    }
    try {
      for (const entry of readdirSync(this.pluginDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (existsSync(join(this.pluginDir, entry.name, 'dist', 'index.js'))) {
          pluginNames.add(entry.name);
        }
      }
    } catch {
      /* plugin dir may not exist or not be readable */
    }

    const results: LoadResult[] = [];

    for (const name of pluginNames) {
      const config = pluginsConfig[name];
      if (config && config.enabled === false) {
        this.logger?.debug(`Skipping disabled plugin: ${name}`);
        continue;
      }

      const pluginPath = join(this.pluginDir, name, 'dist', 'index.js');
      const result = await this.load(pluginPath, pluginsConfig);
      results.push(result);
    }

    for (const r of results) {
      if (r.status === 'error') {
        this.logger?.error(`Failed to load "${r.name}": ${r.error}`);
      }
    }
    const ok = results.filter((r) => r.status === 'ok').length;
    const err = results.filter((r) => r.status === 'error').length;
    this.logger?.info(`Loaded ${ok} plugins (${err} errors)`);

    return results;
  }

  /**
   * Load a single plugin from a file path.
   *
   * `deps` is an optional, plugin-specific dependencies bag that gets
   * forwarded to the plugin's `init(api, deps)` call. Tests use this to
   * inject mock collaborators (e.g. a fake AIProvider) without needing a
   * module-local test hatch inside the plugin. Production callers
   * (`loadAll`, `reload`) pass no deps, so plugins receive `undefined` and
   * construct real dependencies from config as before.
   */
  async load(
    pluginPath: string,
    pluginsConfig?: PluginsConfig,
    deps?: unknown,
  ): Promise<LoadResult> {
    const absPath = resolve(pluginPath);

    // Path traversal guard — reject any plugin path that resolves outside
    // the configured plugin directory before we call `import()` on it.
    // `resolve(this.pluginDir) + sep` is the canonical form we compare
    // against; without this, a `plugins.json` entry like `../../../etc`
    // would execute whatever module sat at the resolved path.
    const absPluginDir = resolve(this.pluginDir) + sep;
    if (!absPath.startsWith(absPluginDir)) {
      const name = this.inferPluginName(absPath);
      return {
        name,
        status: 'error',
        error: `Plugin path escapes plugin directory: ${pluginPath}`,
      };
    }

    // Validate the directory name against SAFE_NAME_RE before import. The
    // inferred name is the plugin directory (two levels up from
    // `dist/index.js`); it must match the same character set we enforce
    // on `mod.name`.
    const inferredName = this.inferPluginName(absPath);
    if (!SAFE_NAME_RE.test(inferredName)) {
      return {
        name: inferredName,
        status: 'error',
        error: `Plugin directory name "${inferredName}" contains invalid characters`,
      };
    }

    if (!existsSync(absPath)) {
      return { name: inferredName, status: 'error', error: `Plugin file not found: ${absPath}` };
    }

    let mod: Record<string, unknown>;
    try {
      mod = await this.importWithCacheBust(absPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: inferredName,
        status: 'error',
        error: `Failed to import plugin: ${message}`,
      };
    }

    // Validate required exports
    if (typeof mod.name !== 'string' || !mod.name) {
      const name = this.inferPluginName(absPath);
      return { name, status: 'error', error: 'Plugin must export a "name" string' };
    }
    if (!isValidPluginModule(mod)) {
      return {
        name: mod.name,
        status: 'error',
        error: 'Plugin must export an "init" function',
      };
    }

    const pluginName = mod.name;

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
    const channelScope = pluginsConfig?.[pluginName]?.channels;
    const { api, dispose: disposeApi } = this.createPluginApi(pluginName, config, channelScope);

    // Call init()
    try {
      const result = mod.init(api, deps);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Clean up partial init: drain any teardown the plugin registered.
      // A teardown throw during init-failure recovery is itself significant
      // (the plugin may leave listeners or resources dangling) — log it
      // loudly rather than swallowing silently. See stability audit
      // 2026-04-14.
      if (mod.teardown) {
        try {
          mod.teardown();
        } catch (tdErr) {
          this.logger?.warn(
            `Plugin "${pluginName}" teardown threw during init-failure cleanup — listeners or timers may remain attached:`,
            tdErr,
          );
        }
      }
      this.cleanupPluginResources(pluginName, disposeApi);
      return { name: pluginName, status: 'error', error: `Plugin init() threw: ${message}` };
    }

    // Track loaded plugin
    const plugin: LoadedPlugin = {
      name: pluginName,
      version: typeof mod.version === 'string' ? mod.version : '0.0.0',
      description: typeof mod.description === 'string' ? mod.description : '',
      filePath: absPath,
      teardown: mod.teardown,
      disposeApi,
    };
    this.loaded.set(pluginName, plugin);

    this.eventBus.emit('plugin:loaded', pluginName);
    this.logger?.child(`plugin:${pluginName}`).info(`Loaded v${plugin.version}`);

    return { name: pluginName, status: 'ok' };
  }

  /**
   * Unload a plugin by name.
   *
   * @throws when `teardown()` itself throws — the plugin stays in the
   *   loaded map so operators can retry teardown or restart the bot.
   *   Silently dropping a plugin whose teardown failed leaves ghost
   *   state (listeners, timers, DB cursors) that the next reload would
   *   then duplicate. See stability audit 2026-04-14.
   */
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
        plugin.teardownFailed = true;
        this.logger?.error(
          `[plugin-loader] WARNING: teardown() for ${pluginName} threw — resources may not have been released cleanly. Plugin stays marked loaded; fix the teardown path or restart the bot.`,
          err,
        );
        // Hard stop the unload: do NOT call cleanupPluginResources, do
        // NOT delete from the loaded map. The previous behaviour deleted
        // regardless, which papered over the problem and caused the
        // next reload to double-register listeners against ghost state.
        throw err;
      }
    }

    this.cleanupPluginResources(pluginName, plugin.disposeApi);

    // Remove from loaded map
    this.loaded.delete(pluginName);

    this.eventBus.emit('plugin:unloaded', pluginName);
    this.logger?.info(`Unloaded: ${pluginName}`);
  }

  /**
   * Reload a plugin (unload + load from same path).
   *
   * Fail-loud on reload failure: when `load()` fails after `unload()`
   * has already run, the plugin is left in the unloaded state with a
   * prominent error log and a `plugin:reload_failed` event emit.
   * Silently resurrecting the old instance would mask the breakage
   * and leave operators running stale code without realising it.
   * Operator must fix the code and re-run `.load`. See stability
   * audit 2026-04-14.
   */
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
    } else {
      this.logger?.error(
        `[plugin-loader] RELOAD FAILED for "${pluginName}" — plugin is now UNLOADED. ` +
          `Fix the code and run \`.load ${pluginName}\` to recover. Error: ${result.error}`,
      );
      this.eventBus.emit('plugin:reload_failed', pluginName, result.error ?? 'unknown error');
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

  /**
   * Drop every resource a plugin registered against core subsystems —
   * binds, help entries, channel settings, event-bus listeners, and the
   * scoped api handle. Used by both `load()`'s init-catch path and
   * `unload()` so the two cleanup recipes can never drift apart. See
   * audit finding W-PS3 (2026-04-14).
   */
  private cleanupPluginResources(pluginName: string, disposeApi: () => void): void {
    // Neutralise the plugin's api handle first so no downstream cleanup
    // step can reach back into a plugin method. See W-PS1.
    try {
      disposeApi();
    } catch (err) {
      this.logger?.error(`[plugin-loader] disposeApi() for ${pluginName} threw:`, err);
    }

    // Drain any event-bus listeners the plugin registered via
    // `trackListener(pluginName, ...)`. See W-BO1.
    this.eventBus.removeByOwner(pluginName);

    // Clean up binds, help entries, and channel settings.
    this.dispatcher.unbindAll(pluginName);
    this.helpRegistry?.unregister(pluginName);
    this.channelSettings?.unregister(pluginName);
    this.channelSettings?.offChange(pluginName);

    // Drain the per-plugin `onModesReady` listeners registered via the
    // plugin API. These live in a parallel map (not trackListener) so the
    // off* methods can look them up by callback identity. See W-PS2.
    //
    // Per-entry try/catch: a single throw from `off()` must not leave the
    // remaining listeners attached. See stability audit 2026-04-14.
    const modesListeners = this.modesReadyListeners.get(pluginName);
    if (modesListeners) {
      for (const fn of modesListeners) {
        try {
          this.eventBus.off('channel:modesReady', fn);
        } catch (err) {
          this.logger?.error(
            `[plugin-loader] channel:modesReady off() for ${pluginName} threw:`,
            err,
          );
        }
      }
      this.modesReadyListeners.delete(pluginName);
    }

    // Drain the per-plugin `onPermissionsChanged` listeners. One wrapper
    // per callback is fanned across three events. Per-entry try/catch
    // per event so a single off() throw doesn't leave siblings attached.
    // See stability audit 2026-04-14.
    const permsListeners = this.permissionsChangedListeners.get(pluginName);
    if (permsListeners) {
      const tryOff = (ev: string, fn: (handle: string) => void): void => {
        try {
          // Each of these three events carries a different payload tuple,
          // but we store one wrapper-per-callback typed on the narrowest
          // signature (`handle`) — cast once here so grep'ing for unsafe
          // listener casts lands on a single site.
          const loose = this.eventBus as unknown as {
            off: (ev: string, fn: (...args: unknown[]) => void) => void;
          };
          loose.off(ev, fn as unknown as (...args: unknown[]) => void);
        } catch (err) {
          this.logger?.error(`[plugin-loader] ${ev} off() for ${pluginName} threw:`, err);
        }
      };
      for (const fn of permsListeners) {
        tryOff('user:added', fn);
        tryOff('user:flagsChanged', fn);
        tryOff('user:hostmaskAdded', fn);
      }
      this.permissionsChangedListeners.delete(pluginName);
    }
  }

  private createPluginApi(
    pluginId: string,
    config: Record<string, unknown>,
    channelScope?: string[],
  ): ReturnType<typeof createPluginApi> {
    return createPluginApi(
      {
        dispatcher: this.dispatcher,
        eventBus: this.eventBus,
        db: this.db,
        permissions: this.permissions,
        botConfig: this.botConfig,
        ircClient: this.ircClient,
        channelState: this.channelState,
        ircCommands: this.ircCommands,
        messageQueue: this.messageQueue,
        services: this.services,
        helpRegistry: this.helpRegistry,
        channelSettings: this.channelSettings,
        banStore: this.banStore,
        rootLogger: this.rootLogger,
        getCasemapping: this.getCasemapping,
        getServerSupports: this.getServerSupports,
        modesReadyListeners: this.modesReadyListeners,
        permissionsChangedListeners: this.permissionsChangedListeners,
      },
      pluginId,
      config,
      channelScope,
    );
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
    // Read plugin's own config.json defaults (pluginFilePath is
    // plugins/<name>/dist/index.js — go up two levels to the plugin root)
    const pluginDir = resolve(pluginFilePath, '..', '..');
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

    // Resolve any `<field>_env` references from process.env so plugins see
    // fully-resolved config values and never touch process.env directly.
    // See docs/plans/config-secrets-env.md and docs/PLUGIN_API.md.
    return resolveSecrets({ ...defaults, ...overrides }, this.logger);
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

  /** Import a plugin bundle with cache busting. */
  private async importWithCacheBust(absPath: string): Promise<Record<string, unknown>> {
    if (!this.importedOnce.has(absPath)) {
      this.importedOnce.add(absPath);
      return (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
    }
    const ts = Date.now();
    const fileUrl = pathToFileURL(absPath).href + `?t=${ts}`;
    return (await import(fileUrl)) as Record<string, unknown>;
  }

  /** Infer a plugin name from its file path. */
  private inferPluginName(filePath: string): string {
    // Path is plugins/<name>/dist/index.js — name is two levels above the file
    const parts = filePath.split('/');
    const indexIdx = parts.lastIndexOf('index.js');
    if (indexIdx > 1) {
      return parts[indexIdx - 2];
    }
    // Fallback: filename without extension
    const last = parts[parts.length - 1];
    return last.replace(/\.(ts|js)$/, '');
  }
}
