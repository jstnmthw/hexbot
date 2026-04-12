// HexBot — Plugin loader
// Discovers, loads, unloads, and hot-reloads plugins. Each plugin gets a scoped API.
// The shape of that API (and the per-plugin wrappers) lives in plugin-api-factory.ts.
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
import type { Logger } from './logger';
import { type IRCClientForPlugins, createPluginApi } from './plugin-api-factory';
import type { BotConfig, Casemapping, PluginAPI, PluginsConfig } from './types';

export type { IRCClientForPlugins };

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
  logger?: Logger | null;
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
  private logger: Logger | null;
  private rootLogger: Logger | null;
  private getCasemapping: () => Casemapping;
  private getServerSupports: () => Record<string, string>;
  private modesReadyListeners: Map<string, Array<(channel: string) => void>> = new Map();
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

  /** Delete any orphaned .reload-*.ts temp files left by a previous crashed process. */
  cleanupOrphanedTempFiles(): void {
    try {
      const entries = readdirSync(this.pluginDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = join(this.pluginDir, entry.name);
        try {
          for (const file of readdirSync(pluginDir)) {
            /* v8 ignore start -- orphaned temp files only exist after interrupted reloads; TRUE branch unreachable in tests */
            if (/^\.reload-\d+-[^/]+\.ts$/.test(file)) {
              unlinkSync(join(pluginDir, file));
              this.logger?.debug(`Cleaned orphaned temp file: ${entry.name}/${file}`);
            }
            /* v8 ignore stop */
          }
        } catch {
          /* plugin dir may not be readable */
        }
      }
    } catch {
      /* plugin dir may not exist yet */
    }
  }

  /** Load all enabled plugins from the plugins config + auto-discovered plugins. */
  async loadAll(pluginsConfigPath?: string): Promise<LoadResult[]> {
    this.cleanupOrphanedTempFiles();
    /* v8 ignore next -- ?? fallback: tests always pass an explicit path; default production path unreachable */
    const cfgPath = pluginsConfigPath ?? resolve('./config/plugins.json');
    const pluginsConfig = this.readPluginsConfig(cfgPath) ?? {};

    // Build the full set of plugin names: configured plugins first, then
    // auto-discovered plugins from the plugins directory that aren't listed.
    const pluginNames = new Set(Object.keys(pluginsConfig));
    try {
      for (const entry of readdirSync(this.pluginDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (existsSync(join(this.pluginDir, entry.name, 'index.ts'))) {
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

      const pluginPath = join(this.pluginDir, name, 'index.ts');
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
    const api = this.createPluginApi(pluginName, config, channelScope);

    // Call init()
    try {
      const result = (mod.init as (api: PluginAPI) => void | Promise<void>)(api);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Clean up partial init: drain any teardown the plugin registered
      if (typeof mod.teardown === 'function') {
        try {
          (mod.teardown as () => void)();
        } catch {
          /* swallow teardown errors */
        }
      }
      // Clean up binds registered during partial init
      this.dispatcher.unbindAll(pluginName);
      // Remove help entries
      this.helpRegistry?.unregister(pluginName);
      // Remove channel setting defs and change listeners
      this.channelSettings?.unregister(pluginName);
      this.channelSettings?.offChange(pluginName);
      // Remove modesReady listeners
      const modesListeners = this.modesReadyListeners.get(pluginName);
      if (modesListeners) {
        for (const fn of modesListeners) this.eventBus.off('channel:modesReady', fn);
        this.modesReadyListeners.delete(pluginName);
      }
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
        plugin.teardownFailed = true;
        this.logger?.error(
          `[plugin-loader] WARNING: teardown() for ${pluginName} threw — some resources may not have been released. Recommend restarting the bot if behavior is unstable.`,
          err,
        );
      }
    }

    // Remove all binds
    this.dispatcher.unbindAll(pluginName);

    // Remove help entries
    this.helpRegistry?.unregister(pluginName);

    // Remove channel setting defs and change listeners (stored values are intentionally preserved)
    this.channelSettings?.unregister(pluginName);
    this.channelSettings?.offChange(pluginName);

    // Remove modesReady listeners
    const modesListeners = this.modesReadyListeners.get(pluginName);
    if (modesListeners) {
      for (const fn of modesListeners) this.eventBus.off('channel:modesReady', fn);
      this.modesReadyListeners.delete(pluginName);
    }

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

  private createPluginApi(
    pluginId: string,
    config: Record<string, unknown>,
    channelScope?: string[],
  ): PluginAPI {
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

    // Resolve any `<field>_env` references from process.env so plugins see
    // fully-resolved config values and never touch process.env directly.
    // See docs/plans/config-secrets-env.md and docs/PLUGIN_API.md.
    return resolveSecrets({ ...defaults, ...overrides });
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
    // First load of this file in this process: nothing is cached yet, so skip the
    // cache-busting dance entirely. This lets bots run with a read-only plugins/
    // mount as long as they don't hot-reload.
    if (!this.importedOnce.has(absPath)) {
      this.importedOnce.add(absPath);
      return (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
    }

    const ts = Date.now();
    const dir = dirname(absPath);

    // Discover all local .ts files reachable from this plugin entry
    const allFiles = new Map<string, string>(); // abs path -> source
    this.collectLocalModules(absPath, dir, allFiles);

    /* v8 ignore next -- FALSE branch: process.env.VITEST is always set in tests; multi-file non-test path unreachable */
    if (allFiles.size === 1 || process.env.VITEST) {
      // Single-file plugins or test environments (where hot-reload isn't needed):
      // simple query-string cache-bust so V8 coverage can track original file paths.
      const fileUrl = pathToFileURL(absPath).href + `?t=${ts}`;
      return (await import(fileUrl)) as Record<string, unknown>;
    }

    /* v8 ignore start -- multi-file plugin reload: writes temp files and imports them; guarded by process.env.VITEST check above */
    // Multi-file plugin: create uniquely-named temp copies so Node treats each
    // as a new module, bypassing its module cache.
    const nameRemap = this.buildNameRemap(allFiles, ts);
    const { tmpFiles, entryTmpPath } = this.writeRewrittenFiles(dir, absPath, allFiles, nameRemap);
    try {
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
    /* v8 ignore stop */
  }

  /**
   * Build a mapping from each file's base name (no ext) to a unique temp base name.
   * Used to rewrite intra-plugin imports so Node sees each reload as a fresh module.
   */
  /* v8 ignore next -- only called from multi-file production reload path above */
  private buildNameRemap(allFiles: Map<string, string>, ts: number): Map<string, string> {
    /* v8 ignore start -- only called from multi-file production reload path above */
    const nameRemap = new Map<string, string>();
    for (const origPath of allFiles.keys()) {
      const base = basename(origPath, '.ts');
      nameRemap.set(base, `.reload-${ts}-${base}`);
    }
    return nameRemap;
    /* v8 ignore stop */
  }

  /**
   * Write temp copies of all plugin files with intra-plugin imports rewritten
   * to point to the corresponding temp file names.
   * Returns the list of temp file paths and the entry temp path.
   */
  /* v8 ignore next -- only called from multi-file production reload path above */
  private writeRewrittenFiles(
    dir: string,
    entryPath: string,
    allFiles: Map<string, string>,
    nameRemap: Map<string, string>,
  ): { tmpFiles: string[]; entryTmpPath: string } {
    /* v8 ignore start -- only called from multi-file production reload path above */
    const tmpFiles: string[] = [];
    let entryTmpPath = '';
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
      if (origPath === entryPath) entryTmpPath = tmpPath;
    }
    return { tmpFiles, entryTmpPath };
    /* v8 ignore stop */
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
