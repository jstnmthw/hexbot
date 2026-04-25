import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelSettings } from '../src/core/channel-settings';
import { ChannelState } from '../src/core/channel-state';
import { IRCCommands } from '../src/core/irc-commands';
import { Permissions } from '../src/core/permissions';
import { Services } from '../src/core/services';
import { BotDatabase } from '../src/database';
import { EventDispatcher } from '../src/dispatcher';
import { BotEventBus } from '../src/event-bus';
import { Logger } from '../src/logger';
import { PluginLoader } from '../src/plugin-loader';
import type { PluginLoaderDeps } from '../src/plugin-loader';
import type { BotConfig, PluginAPI } from '../src/types';

// Test plugins stash their api on globalThis so we can inspect it from tests.
declare global {
  var __testPluginApi: PluginAPI | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retrieve the PluginAPI stashed on globalThis by test plugins during init(). */
function getTestPluginApi(): PluginAPI {
  return globalThis.__testPluginApi!;
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `hexbot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a plugin's compiled `index.js` under `<dir>/<name>/dist/`. Returns
 * the absolute file path so callers can pass it to `loader.load()`. The
 * `dist/` layout matches what `inferPluginName` looks for.
 */
function writePlugin(dir: string, name: string, code: string): string {
  const distDir = join(dir, name, 'dist');
  mkdirSync(distDir, { recursive: true });
  const filePath = join(distDir, 'index.js');
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

/** Write a plugin's `config.json` defaults file at `<dir>/<name>/config.json`. */
function writePluginConfig(dir: string, name: string, config: Record<string, unknown>): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'config.json'), JSON.stringify(config), 'utf-8');
}

/** Write a top-level `plugins.json` at `<dir>/plugins.json` and return its path. */
function writePluginsJson(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, 'plugins.json');
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return path;
}

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: {
    host: 'localhost',
    port: 6667,
    tls: false,
    nick: 'test',
    username: 'test',
    realname: 'test',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function createLoader(
  pluginDir: string,
  db?: BotDatabase,
): {
  loader: PluginLoader;
  dispatcher: EventDispatcher;
  eventBus: BotEventBus;
  db: BotDatabase;
  permissions: Permissions;
} {
  const database = db ?? new BotDatabase(':memory:');
  if (!db) database.open();
  const dispatcher = new EventDispatcher();
  const eventBus = new BotEventBus();
  const permissions = new Permissions(database);

  const loader = new PluginLoader({
    pluginDir,
    dispatcher,
    eventBus,
    db: database,
    permissions,
    botConfig: MINIMAL_BOT_CONFIG,
    ircClient: null,
  });

  return { loader, dispatcher, eventBus, db: database, permissions };
}

/** Create a loader with full deps (ircClient, channelState, ircCommands, services, logger). */
function createLoaderFull(pluginDir: string, overrides?: Partial<PluginLoaderDeps>) {
  const database = new BotDatabase(':memory:');
  database.open();
  const dispatcher = new EventDispatcher();
  const eventBus = new BotEventBus();
  const permissions = new Permissions(database);

  const mockIrcClient = {
    say: vi.fn() as (target: string, message: string) => void,
    notice: vi.fn() as (target: string, message: string) => void,
    action: vi.fn() as (target: string, message: string) => void,
    raw: vi.fn() as (line: string) => void,
    ctcpResponse: vi.fn() as (target: string, type: string, ...params: string[]) => void,
    join: vi.fn() as (channel: string) => void,
    part: vi.fn() as (channel: string, message?: string) => void,
  };

  // Minimal mock client for ChannelState and Services
  const mockChannelClient = {
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    removeListener: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    say: vi.fn(),
    changeNick: vi.fn(),
  };

  const channelState = new ChannelState(mockChannelClient, eventBus);
  const ircCommands = new IRCCommands(mockIrcClient, database);
  const services = new Services({
    client: mockChannelClient,
    servicesConfig: MINIMAL_BOT_CONFIG.services,
    eventBus,
  });
  const logger = new Logger(null, { value: 'debug' });

  const loader = new PluginLoader({
    pluginDir,
    dispatcher,
    eventBus,
    db: database,
    permissions,
    botConfig: MINIMAL_BOT_CONFIG,
    ircClient: mockIrcClient,
    channelState,
    ircCommands,
    services,
    logger,
    ...overrides,
  });

  return {
    loader,
    dispatcher,
    eventBus,
    db: database,
    permissions,
    mockIrcClient,
    mockChannelClient,
    channelState,
    ircCommands,
    services,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    globalThis.__testPluginApi = undefined;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should load a valid plugin and call init()', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'test-plugin',
        `
        export const name = 'test-plugin';
        export const version = '1.0.0';
        export const description = 'A test plugin';
        export function init(api) {
          api.log('initialized');
        }
      `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('ok');
      expect(result.name).toBe('test-plugin');
    });

    it('should register binds from init()', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'bind-plugin',
        `
        export const name = 'bind-plugin';
        export const version = '1.0.0';
        export const description = 'Plugin that binds';
        export function init(api) {
          api.bind('pub', '-', '!test', (ctx) => ctx.reply('ok'));
        }
      `,
      );

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      const binds = dispatcher.listBinds({ pluginId: 'bind-plugin' });
      expect(binds).toHaveLength(1);
      expect(binds[0].mask).toBe('!test');
    });

    it('should reject plugin with missing name export', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'no-name',
        `
        export function init(api) {}
      `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('name');
    });

    it('should reject plugin with missing init export', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'no-init',
        `
        export const name = 'no-init';
      `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('init');
    });

    it('should catch and report import failures (e.g. syntax error)', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'syntax-error',
        `
        this is not valid TypeScript {{ syntax error
        `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to import plugin');
    });

    it('should catch and report init() errors', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'bad-init',
        `
        export const name = 'bad-init';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          throw new Error('boom');
        }
      `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('boom');
      expect(loader.isLoaded('bad-init')).toBe(false);
    });

    it('should clean up binds when init() throws', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'partial-init',
        `
        export const name = 'partial-init';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!before', (ctx) => {});
          throw new Error('mid-init error');
        }
      `,
      );

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      const binds = dispatcher.listBinds({ pluginId: 'partial-init' });
      expect(binds).toHaveLength(0);
    });

    it('should clean up onPermissionsChanged listeners when init() throws', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'partial-perms',
        `
        export const name = 'partial-perms';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.onPermissionsChanged(() => {});
          throw new Error('mid-init error');
        }
      `,
      );

      const { loader, permissions } = createLoader(tempDir);
      await loader.load(pluginPath);

      // Adding a user should not trigger the partial-init listener since
      // it was torn down. If the cleanup path were broken, the dangling
      // listener would still observe the event (and might crash later).
      expect(() => permissions.addUser('someone', '*!*@host', 'o', 'test')).not.toThrow();
    });

    it('should reject loading the same plugin twice', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'dupe-plugin',
        `
        export const name = 'dupe-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('already loaded');
    });

    it('should reject unsafe plugin names', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'bad-name',
        `
        export const name = '../escape';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );

      const { loader } = createLoader(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('error');
      expect(result.error).toContain('invalid characters');
    });

    it('should return error for non-existent file', async () => {
      const { loader } = createLoader(tempDir);
      const result = await loader.load(join(tempDir, 'ghost', 'dist', 'index.js'));

      expect(result.status).toBe('error');
      expect(result.error).toContain('not found');
    });

    it('should emit plugin:loaded event', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'event-plugin',
        `
        export const name = 'event-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );

      const { loader, eventBus } = createLoader(tempDir);
      const listener = vi.fn();
      eventBus.on('plugin:loaded', listener);

      await loader.load(pluginPath);

      expect(listener).toHaveBeenCalledWith('event-plugin');
    });
  });

  describe('unload', () => {
    it('should call teardown() on unload', async () => {
      // We track teardown via a side effect — writing a file
      const markerPath = join(tempDir, 'teardown-marker');
      const pluginPath = writePlugin(
        tempDir,
        'teardown-plugin',
        `
        import { writeFileSync } from 'node:fs';
        export const name = 'teardown-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
        export function teardown() {
          writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'torn down', 'utf-8');
        }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);
      await loader.unload('teardown-plugin');

      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, 'utf-8')).toBe('torn down');
    });

    it('should remove all binds on unload', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'bind-unload',
        `
        export const name = 'bind-unload';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!a', (ctx) => {});
          api.bind('pubm', '-', '*hello*', (ctx) => {});
        }
      `,
      );

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      expect(dispatcher.listBinds({ pluginId: 'bind-unload' })).toHaveLength(2);

      await loader.unload('bind-unload');

      expect(dispatcher.listBinds({ pluginId: 'bind-unload' })).toHaveLength(0);
    });

    it('should throw when unloading a plugin that is not loaded', async () => {
      const { loader } = createLoader(tempDir);
      await expect(loader.unload('nonexistent')).rejects.toThrow('not loaded');
    });

    it('should emit plugin:unloaded event', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'unload-event',
        `
        export const name = 'unload-event';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );

      const { loader, eventBus } = createLoader(tempDir);
      const listener = vi.fn();
      eventBus.on('plugin:unloaded', listener);

      await loader.load(pluginPath);
      await loader.unload('unload-event');

      expect(listener).toHaveBeenCalledWith('unload-event');
    });
  });

  describe('reload', () => {
    it('should reload a plugin (unload old binds, load new binds)', async () => {
      // Vitest's module transform cache prevents true code-change reload testing.
      // Instead we verify the mechanism: unload removes binds, load re-registers.
      const pluginPath = writePlugin(
        tempDir,
        'reload-plugin',
        `
        export const name = 'reload-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.bind('pub', '-', '!reload-cmd', (ctx) => {});
        }
      `,
      );

      const { loader, dispatcher, eventBus } = createLoader(tempDir);
      await loader.load(pluginPath);

      expect(dispatcher.listBinds({ pluginId: 'reload-plugin' })).toHaveLength(1);

      const reloadedListener = vi.fn();
      eventBus.on('plugin:reloaded', reloadedListener);

      const result = await loader.reload('reload-plugin');

      expect(result.status).toBe('ok');
      expect(reloadedListener).toHaveBeenCalledWith('reload-plugin');
      // After reload, binds should be re-registered (old ones removed, new ones added)
      const binds = dispatcher.listBinds({ pluginId: 'reload-plugin' });
      expect(binds).toHaveLength(1);
      expect(binds[0].mask).toBe('!reload-cmd');
    });

    it('should throw when reloading a plugin that is not loaded', async () => {
      const { loader } = createLoader(tempDir);
      await expect(loader.reload('nonexistent')).rejects.toThrow('not loaded');
    });

    it('should not emit plugin:reloaded when reload fails', async () => {
      // Use globalThis to track load count across cache-busted imports
      (globalThis as Record<string, unknown>).__reloadFailCount = 0;
      const pluginPath = writePlugin(
        tempDir,
        'reload-fail',
        `
        export const name = 'reload-fail';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          globalThis.__reloadFailCount++;
          if (globalThis.__reloadFailCount > 1) throw new Error('reload boom');
        }
        `,
      );

      const { loader, eventBus } = createLoader(tempDir);
      const first = await loader.load(pluginPath);
      expect(first.status).toBe('ok');

      const reloadedListener = vi.fn();
      eventBus.on('plugin:reloaded', reloadedListener);

      const result = await loader.reload('reload-fail');

      expect(result.status).toBe('error');
      expect(reloadedListener).not.toHaveBeenCalled();
      delete (globalThis as Record<string, unknown>).__reloadFailCount;
    });

    it('preserves plugins.json overrides across reload', async () => {
      // Regression: before this fix, reload() called load() without the
      // plugins.json overrides, so ai-chat would silently flip from the
      // configured provider (e.g. ollama) back to its config.json default
      // (gemini) and enter degraded mode when no Gemini key was set.
      writePluginConfig(tempDir, 'cfg-reload', { greeting: 'default' });
      writePlugin(
        tempDir,
        'cfg-reload',
        `
        export const name = 'cfg-reload';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('seen-greeting', String(api.config.greeting ?? ''));
        }
      `,
      );

      const cfgPath = writePluginsJson(tempDir, {
        'cfg-reload': { enabled: true, config: { greeting: 'override' } },
      });

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);
      await loader.loadAll(cfgPath);

      expect(db.get('cfg-reload', 'seen-greeting')).toBe('override');

      const result = await loader.reload('cfg-reload');
      expect(result.status).toBe('ok');
      expect(db.get('cfg-reload', 'seen-greeting')).toBe('override');

      db.close();
    });
  });

  describe('loadAll', () => {
    it('should load only enabled plugins from plugins.json', async () => {
      writePlugin(
        tempDir,
        'enabled-one',
        `
        export const name = 'enabled-one';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );
      writePlugin(
        tempDir,
        'enabled-two',
        `
        export const name = 'enabled-two';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );
      writePlugin(
        tempDir,
        'disabled-one',
        `
        export const name = 'disabled-one';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );

      const configDir = makeTempDir();
      const cfgPath = writePluginsJson(configDir, {
        'enabled-one': { enabled: true },
        'enabled-two': { enabled: true },
        'disabled-one': { enabled: false },
      });

      const { loader } = createLoader(tempDir);
      const results = await loader.loadAll(cfgPath);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
      expect(loader.isLoaded('enabled-one')).toBe(true);
      expect(loader.isLoaded('enabled-two')).toBe(true);
      expect(loader.isLoaded('disabled-one')).toBe(false);

      rmSync(configDir, { recursive: true, force: true });
    });

    it('should log per-plugin load errors to surface failures at startup', async () => {
      writePlugin(
        tempDir,
        'good',
        `
        export const name = 'good';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
      `,
      );
      writePlugin(
        tempDir,
        'broken',
        `
        this is not valid TypeScript {{{
        `,
      );

      const configDir = makeTempDir();
      const cfgPath = writePluginsJson(configDir, {});

      const logs: string[] = [];
      const logger: import('../src/logger').LoggerLike = {
        child: () => logger,
        info: () => {},
        error: (msg: string) => logs.push(msg),
        warn: () => {},
        debug: () => {},
        setLevel: () => {},
        getLevel: () => 'info',
      };

      const { loader } = createLoaderFull(tempDir, { logger });
      const results = await loader.loadAll(cfgPath);

      expect(results.some((r) => r.status === 'error' && r.name === 'broken')).toBe(true);
      expect(logs.some((m) => m.includes('Failed to load "broken"'))).toBe(true);

      rmSync(configDir, { recursive: true, force: true });
    });
  });

  describe('scoped API', () => {
    it('should namespace database operations per plugin', async () => {
      const pluginAPath = writePlugin(
        tempDir,
        'plugin-a',
        `
        export const name = 'plugin-a';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('shared-key', 'value-from-a');
        }
      `,
      );
      const pluginBPath = writePlugin(
        tempDir,
        'plugin-b',
        `
        export const name = 'plugin-b';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('shared-key', 'value-from-b');
        }
      `,
      );

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);

      await loader.load(pluginAPath);
      await loader.load(pluginBPath);

      // Verify isolation — each plugin sees its own namespace
      expect(db.get('plugin-a', 'shared-key')).toBe('value-from-a');
      expect(db.get('plugin-b', 'shared-key')).toBe('value-from-b');

      db.close();
    });

    it('should not allow plugin A to access plugin B database', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'namespace-test',
        `
        export const name = 'namespace-test';
        export const version = '1.0.0';
        export const description = '';
        let savedApi;
        export function init(api) {
          savedApi = api;
          api.db.set('mykey', 'myvalue');
        }
        export function getApi() { return savedApi; }
      `,
      );

      const db = new BotDatabase(':memory:');
      db.open();

      // Pre-seed a different namespace
      db.set('other-plugin', 'secret', 'top-secret');

      const { loader } = createLoader(tempDir, db);
      await loader.load(pluginPath);

      // The plugin can only see its own namespace
      expect(db.get('namespace-test', 'mykey')).toBe('myvalue');
      // Direct DB access shows isolation
      expect(db.get('namespace-test', 'secret')).toBeNull();
      expect(db.get('other-plugin', 'secret')).toBe('top-secret');

      db.close();
    });
  });

  describe('config merging', () => {
    it('should merge plugin config.json with plugins.json overrides', async () => {
      // Write plugin with config.json defaults
      writePluginConfig(tempDir, 'config-plugin', {
        greeting: 'hello',
        color: 'blue',
      });
      // Plugin writes its config values to the DB so we can verify
      const pluginPath = writePlugin(
        tempDir,
        'config-plugin',
        `
        export const name = 'config-plugin';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.db.set('cfg-greeting', String(api.config.greeting ?? ''));
          api.db.set('cfg-color', String(api.config.color ?? ''));
          api.db.set('cfg-extra', String(api.config.extra ?? ''));
        }
      `,
      );

      const pluginsConfig = {
        'config-plugin': {
          enabled: true,
          config: {
            color: 'red',
            extra: 'new',
          },
        },
      };

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);
      await loader.load(pluginPath, pluginsConfig);

      // Verify merged config: defaults + overrides
      expect(db.get('config-plugin', 'cfg-greeting')).toBe('hello');
      expect(db.get('config-plugin', 'cfg-color')).toBe('red');
      expect(db.get('config-plugin', 'cfg-extra')).toBe('new');

      db.close();
    });

    it('should resolve _env fields in plugin config from process.env', async () => {
      const envVarBackup = process.env.TEST_PLUGIN_SECRET_X;
      process.env.TEST_PLUGIN_SECRET_X = 'resolved-value';

      try {
        writePluginConfig(tempDir, 'env-plugin', {
          endpoint: 'https://api.example.com',
          api_key_env: 'TEST_PLUGIN_SECRET_X',
        });
        const pluginPath = writePlugin(
          tempDir,
          'env-plugin',
          `
          export const name = 'env-plugin';
          export const version = '1.0.0';
          export const description = '';
          export function init(api) {
            api.db.set('api_key', String(api.config.api_key ?? ''));
            api.db.set('api_key_env', String(api.config.api_key_env ?? ''));
            api.db.set('endpoint', String(api.config.endpoint ?? ''));
          }
        `,
        );

        const db = new BotDatabase(':memory:');
        db.open();
        const { loader } = createLoader(tempDir, db);
        const result = await loader.load(pluginPath);
        expect(result.status).toBe('ok');

        // _env field was resolved and the raw _env key dropped
        expect(db.get('env-plugin', 'api_key')).toBe('resolved-value');
        expect(db.get('env-plugin', 'api_key_env')).toBe('');
        expect(db.get('env-plugin', 'endpoint')).toBe('https://api.example.com');

        db.close();
      } finally {
        if (envVarBackup === undefined) delete process.env.TEST_PLUGIN_SECRET_X;
        else process.env.TEST_PLUGIN_SECRET_X = envVarBackup;
      }
    });
  });

  describe('list', () => {
    it('should list loaded plugins', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'list-plugin',
        `
        export const name = 'list-plugin';
        export const version = '2.5.0';
        export const description = 'A listable plugin';
        export function init(api) {}
      `,
      );

      const { loader } = createLoader(tempDir);
      expect(loader.list()).toHaveLength(0);

      await loader.load(pluginPath);

      const plugins = loader.list();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('list-plugin');
      expect(plugins[0].version).toBe('2.5.0');
      expect(plugins[0].description).toBe('A listable plugin');
    });
  });

  describe('scoped API — IRC methods with null ircClient', () => {
    it('should not throw when ircClient is null', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-irc',
        `
        export const name = 'null-irc';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          globalThis.__testPluginApi = api;
        }
      `,
      );

      // createLoader uses ircClient: null by default
      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // All IRC methods should be no-ops when ircClient is null
      expect(() => api.say('#test', 'hello')).not.toThrow();
      expect(() => api.action('#test', 'waves')).not.toThrow();
      expect(() => api.notice('#test', 'notice')).not.toThrow();
      expect(() => api.ctcpResponse('nick', 'VERSION', 'test')).not.toThrow();
    });
  });

  describe('scoped API — IRC methods with a real ircClient', () => {
    it('should delegate say/action/notice/ctcpResponse to ircClient', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'real-irc',
        `
        export const name = 'real-irc';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader, mockIrcClient } = createLoaderFull(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      api.say('#chan', 'hello');
      expect(mockIrcClient.say).toHaveBeenCalledWith('#chan', 'hello');

      api.action('#chan', 'waves');
      expect(mockIrcClient.action).toHaveBeenCalledWith('#chan', 'waves');

      api.notice('#chan', 'yo');
      expect(mockIrcClient.notice).toHaveBeenCalledWith('#chan', 'yo');

      api.ctcpResponse('nick', 'VERSION', 'hexbot');
      expect(mockIrcClient.ctcpResponse).toHaveBeenCalledWith('nick', 'VERSION', 'hexbot');
    });
  });

  describe('scoped API — IRC commands with null ircCommands', () => {
    it('should not throw when ircCommands is null', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-cmds',
        `
        export const name = 'null-cmds';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      // createLoader uses no ircCommands by default
      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(() => api.op('#test', 'nick')).not.toThrow();
      expect(() => api.deop('#test', 'nick')).not.toThrow();
      expect(() => api.voice('#test', 'nick')).not.toThrow();
      expect(() => api.devoice('#test', 'nick')).not.toThrow();
      expect(() => api.kick('#test', 'nick', 'reason')).not.toThrow();
      expect(() => api.ban('#test', '*!*@bad.host')).not.toThrow();
      expect(() => api.mode('#test', '+o', 'nick')).not.toThrow();
      expect(() => api.topic('#test', 'new topic')).not.toThrow();
      expect(() => api.invite('#test', 'nick')).not.toThrow();
    });
  });

  describe('scoped API — IRC commands with real ircCommands', () => {
    it('should delegate op/deop/voice/devoice/kick/ban/mode/topic to ircCommands', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'real-cmds',
        `
        export const name = 'real-cmds';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader, ircCommands } = createLoaderFull(tempDir);
      vi.spyOn(ircCommands, 'op');
      vi.spyOn(ircCommands, 'deop');
      vi.spyOn(ircCommands, 'voice');
      vi.spyOn(ircCommands, 'devoice');
      vi.spyOn(ircCommands, 'kick');
      vi.spyOn(ircCommands, 'ban');
      vi.spyOn(ircCommands, 'mode');
      vi.spyOn(ircCommands, 'topic');
      vi.spyOn(ircCommands, 'invite');
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // Plugin api.irc.* methods now thread an actor `{ by: pluginId, source:
      // 'plugin', plugin: pluginId }` through to IRCCommands so the auto-
      // logged mod_log row carries plugin attribution. The actor object is
      // frozen and identical per call.
      const pluginActor = { by: 'real-cmds', source: 'plugin', plugin: 'real-cmds' };

      api.op('#ch', 'nick');
      expect(ircCommands.op).toHaveBeenCalledWith('#ch', 'nick', pluginActor);

      api.deop('#ch', 'nick');
      expect(ircCommands.deop).toHaveBeenCalledWith('#ch', 'nick', pluginActor);

      api.voice('#ch', 'nick');
      expect(ircCommands.voice).toHaveBeenCalledWith('#ch', 'nick', pluginActor);

      api.devoice('#ch', 'nick');
      expect(ircCommands.devoice).toHaveBeenCalledWith('#ch', 'nick', pluginActor);

      api.kick('#ch', 'nick', 'bye');
      expect(ircCommands.kick).toHaveBeenCalledWith('#ch', 'nick', 'bye', pluginActor);

      api.ban('#ch', '*!*@bad');
      expect(ircCommands.ban).toHaveBeenCalledWith('#ch', '*!*@bad', pluginActor);

      api.mode('#ch', '+o', 'nick');
      // mode() still takes variadic params; no actor parameter (mode batches).
      expect(ircCommands.mode).toHaveBeenCalledWith('#ch', '+o', 'nick');

      api.topic('#ch', 'new topic');
      expect(ircCommands.topic).toHaveBeenCalledWith('#ch', 'new topic', pluginActor);

      api.invite('#ch', 'someuser');
      expect(ircCommands.invite).toHaveBeenCalledWith('#ch', 'someuser', pluginActor);
    });
  });

  describe('scoped API — channel state with null channelState', () => {
    it('should return undefined/empty when channelState is null', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-chan',
        `
        export const name = 'null-chan';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      // createLoader has no channelState by default
      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(api.getChannel('#test')).toBeUndefined();
      expect(api.getUsers('#test')).toEqual([]);
      expect(api.getUserHostmask('#test', 'nick')).toBeUndefined();
    });
  });

  describe('scoped API — channel state with real channelState', () => {
    it('should return channel data when channel exists', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'real-chan',
        `
        export const name = 'real-chan';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader, channelState, mockChannelClient } = createLoaderFull(tempDir);
      await loader.load(pluginPath);

      // Simulate a user joining so channelState has data
      channelState.attach();
      // Find the join handler registered by attach() on the mock client
      const onCalls = mockChannelClient.on.mock.calls;
      const joinCall = onCalls.find((c) => c[0] === 'join');
      if (joinCall) {
        joinCall[1]({
          nick: 'testuser',
          ident: 'user',
          hostname: 'host.example.com',
          channel: '#test',
        });
      }

      const api = getTestPluginApi();

      const ch = api.getChannel('#test');
      expect(ch).toBeDefined();
      expect(ch!.name).toBe('#test');
      expect(ch!.users.size).toBe(1);
      const user = ch!.users.get('testuser');
      expect(user).toBeDefined();
      expect(user!.nick).toBe('testuser');
      expect(user!.ident).toBe('user');
      expect(user!.hostname).toBe('host.example.com');
      expect(user!.modes).toBe('');
      expect(typeof user!.joinedAt).toBe('number');

      const users = api.getUsers('#test');
      expect(users).toHaveLength(1);
      expect(users[0].nick).toBe('testuser');

      const hostmask = api.getUserHostmask('#test', 'testuser');
      expect(hostmask).toBe('testuser!user@host.example.com');
    });

    it('should return undefined for non-existent channel', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'no-chan',
        `
        export const name = 'no-chan';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoaderFull(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(api.getChannel('#nonexistent')).toBeUndefined();
      expect(api.getUsers('#nonexistent')).toEqual([]);
      expect(api.getUserHostmask('#nonexistent', 'nobody')).toBeUndefined();
    });
  });

  describe('scoped API — services with null services', () => {
    it('should return defaults when services is null', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-svc',
        `
        export const name = 'null-svc';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      // createLoader has no services by default
      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      const result = await api.services.verifyUser('someone');
      expect(result).toEqual({ verified: false, account: null });
      expect(api.services.isAvailable()).toBe(false);
    });
  });

  describe('scoped API — logging methods', () => {
    it('should not throw when logger is null', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-log',
        `
        export const name = 'null-log';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      // createLoader has no logger by default
      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(() => api.log('test message')).not.toThrow();
      expect(() => api.error('error msg')).not.toThrow();
      expect(() => api.warn('warn msg')).not.toThrow();
      expect(() => api.debug('debug msg')).not.toThrow();
    });

    it('should delegate to logger when logger is provided', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'with-log',
        `
        export const name = 'with-log';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoaderFull(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // These should work without error (logger exists)
      expect(() => api.log('test')).not.toThrow();
      expect(() => api.error('err')).not.toThrow();
      expect(() => api.warn('wrn')).not.toThrow();
      expect(() => api.debug('dbg')).not.toThrow();
    });
  });

  describe('scoped API — db stub when db is null', () => {
    it('should return no-op stubs', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'null-db',
        `
        export const name = 'null-db';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const dispatcher = new EventDispatcher();
      const eventBus = new BotEventBus();
      const permissions = new Permissions(null);

      const loader = new PluginLoader({
        pluginDir: tempDir,
        dispatcher,
        eventBus,
        db: null,
        permissions,
        botConfig: MINIMAL_BOT_CONFIG,
        ircClient: null,
      });

      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(api.db.get('key')).toBeUndefined();
      expect(() => api.db.set('key', 'val')).not.toThrow();
      expect(() => api.db.del('key')).not.toThrow();
      expect(api.db.list()).toEqual([]);
    });
  });

  describe('config merging edge cases', () => {
    it('should use empty defaults when plugin config.json does not exist', async () => {
      // No config.json in plugin dir
      const pluginPath = writePlugin(
        tempDir,
        'no-config',
        `
        export const name = 'no-config';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const pluginsConfig = {
        'no-config': { enabled: true, config: { key1: 'val1' } },
      };

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath, pluginsConfig);

      const api = getTestPluginApi();

      expect(api.config.key1).toBe('val1');
    });

    it('should handle invalid config.json gracefully', async () => {
      // Write invalid JSON as config.json
      const pluginDir = join(tempDir, 'bad-config');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'config.json'), '{not valid json!!!', 'utf-8');

      const pluginPath = writePlugin(
        tempDir,
        'bad-config',
        `
        export const name = 'bad-config';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoaderFull(tempDir);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('ok');
    });

    it('should use empty config when no pluginsConfig and no config.json', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'empty-cfg',
        `
        export const name = 'empty-cfg';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoader(tempDir);
      // Load without pluginsConfig argument
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // Config should be an empty (frozen) object
      expect(Object.keys(api.config)).toHaveLength(0);
    });
  });

  describe('readPluginsConfig edge cases', () => {
    it('should return empty results when plugins.json does not exist', async () => {
      const { loader } = createLoader(tempDir);
      // loadAll with a path that doesn't exist
      const results = await loader.loadAll(join(tempDir, 'nonexistent-plugins.json'));
      expect(results).toEqual([]);
    });

    it('should return empty results when plugins.json is invalid JSON', async () => {
      const cfgPath = join(tempDir, 'bad-plugins.json');
      writeFileSync(cfgPath, '{broken json!!!', 'utf-8');

      const { loader } = createLoaderFull(tempDir);
      const results = await loader.loadAll(cfgPath);
      expect(results).toEqual([]);
    });
  });

  describe('inferPluginName edge cases', () => {
    it('should use filename when path is not a dist/index.js pattern', async () => {
      const { loader } = createLoader(tempDir);
      // A path like /some/dir/myplugin.ts (not index.js) should infer "myplugin"
      const result = await loader.load(join(tempDir, 'myplugin.ts'));

      expect(result.status).toBe('error');
      expect(result.name).toBe('myplugin');
    });

    it('should infer plugin name from dist/index.js path (two levels up)', async () => {
      const { loader } = createLoader(tempDir);
      // A path like /some/my-plugin/dist/index.js should infer "my-plugin"
      const result = await loader.load(join(tempDir, 'my-plugin', 'dist', 'index.js'));

      expect(result.status).toBe('error');
      expect(result.name).toBe('my-plugin');
    });
  });

  describe('scoped API — getServerSupports', () => {
    it('should return an empty object', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'supports-test',
        `
        export const name = 'supports-test';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(api.getServerSupports()).toEqual({});
    });
  });

  describe('scoped API — permissions and botConfig', () => {
    it('should expose read-only permissions API', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'perm-test',
        `
        export const name = 'perm-test';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // Permissions API should be available and return null for unknown hostmask
      expect(api.permissions.findByHostmask('nobody!nobody@nowhere')).toBeNull();
    });

    it('should expose botConfig without password', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'cfg-test',
        `
        export const name = 'cfg-test';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      expect(api.botConfig.irc.nick).toBe('test');
      expect(api.botConfig.services).toBeDefined();
      expect((api.botConfig.services as Record<string, unknown>).password).toBeUndefined();
    });
  });

  describe('plugin default version and description', () => {
    it('should default version to 0.0.0 and description to empty string', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'no-meta',
        `
        export const name = 'no-meta';
        export function init(api) {}
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const plugins = loader.list();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].version).toBe('0.0.0');
      expect(plugins[0].description).toBe('');
    });
  });

  describe('async init and teardown', () => {
    it('should handle async init()', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'async-init',
        `
        export const name = 'async-init';
        export const version = '1.0.0';
        export const description = '';
        export async function init(api) {
          await Promise.resolve();
          api.db.set('loaded', 'yes');
        }
      `,
      );

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);
      const result = await loader.load(pluginPath);

      expect(result.status).toBe('ok');
      expect(db.get('async-init', 'loaded')).toBe('yes');
      db.close();
    });

    it('should handle async teardown()', async () => {
      const markerPath = join(tempDir, 'async-teardown-marker');
      const pluginPath = writePlugin(
        tempDir,
        'async-teardown',
        `
        import { writeFileSync } from 'node:fs';
        export const name = 'async-teardown';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
        export async function teardown() {
          await Promise.resolve();
          writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'async torn down', 'utf-8');
        }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);
      await loader.unload('async-teardown');

      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(markerPath, 'utf-8')).toBe('async torn down');
    });

    it('should propagate teardown errors and leave plugin marked loaded (hard-stop)', async () => {
      // Stability audit 2026-04-14: teardown failure must NOT silently
      // drop the plugin from the loaded map — that papers over ghost
      // state (listeners, timers, DB cursors) and the next reload would
      // double-register them. Instead, throw from `unload()` and keep
      // the plugin in place so operators must fix the teardown path or
      // restart the bot.
      const pluginPath = writePlugin(
        tempDir,
        'bad-teardown',
        `
        export const name = 'bad-teardown';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {}
        export function teardown() {
          throw new Error('teardown explosion');
        }
      `,
      );

      const { loader } = createLoaderFull(tempDir);
      await loader.load(pluginPath);

      await expect(loader.unload('bad-teardown')).rejects.toThrow('teardown explosion');
      // Plugin stays in the loaded map — operator intervention required.
      expect(loader.isLoaded('bad-teardown')).toBe(true);
    });
  });

  describe('scoped API — db del and list with real db', () => {
    it('should delegate del() and list() to the real database', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'db-ops',
        `
        export const name = 'db-ops';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const db = new BotDatabase(':memory:');
      db.open();
      const { loader } = createLoader(tempDir, db);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      api.db.set('key1', 'val1');
      api.db.set('key2', 'val2');
      expect(api.db.get('key1')).toBe('val1');

      const listed = api.db.list();
      expect(listed.length).toBe(2);

      api.db.del('key1');
      expect(api.db.get('key1')).toBeUndefined();

      const listedAfter = api.db.list('key');
      expect(listedAfter.length).toBe(1);
      expect(listedAfter[0].key).toBe('key2');

      db.close();
    });
  });

  describe('scoped API — permissions checkFlags', () => {
    it('should delegate checkFlags to permissions module', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'check-flags',
        `
        export const name = 'check-flags';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader } = createLoader(tempDir);
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      const ctx = {
        nick: 'nobody',
        ident: 'nobody',
        hostname: 'nowhere',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: () => {},
        replyPrivate: () => {},
      };

      // "-" flag means "anyone", should always pass
      const result = api.permissions.checkFlags('-', ctx);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('scoped API — services verifyUser with real services', () => {
    it('should delegate verifyUser to services module', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'real-svc',
        `
        export const name = 'real-svc';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) { globalThis.__testPluginApi = api; }
      `,
      );

      const { loader, services } = createLoaderFull(tempDir);
      vi.spyOn(services, 'verifyUser').mockResolvedValue({ verified: true, account: 'testacct' });

      await loader.load(pluginPath);

      const api = getTestPluginApi();

      const result = await api.services.verifyUser('someone');
      expect(result).toEqual({ verified: true, account: 'testacct' });
      expect(services.verifyUser).toHaveBeenCalledWith('someone');
    });
  });

  describe('scoped API — channelSettings.get()', () => {
    it('should return the correct value from channelSettings', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'chanset-get',
        `
        export const name = 'chanset-get';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          api.channelSettings.register([
            { key: 'greeting', type: 'string', default: 'hello' },
          ]);
          globalThis.__testPluginApi = api;
        }
      `,
      );

      const db = new BotDatabase(':memory:');
      db.open();
      const chanSettings = new ChannelSettings(db);

      const { loader } = createLoaderFull(tempDir, { channelSettings: chanSettings });
      await loader.load(pluginPath);

      const api = getTestPluginApi();

      // Should return the default value when nothing is stored
      expect(api.channelSettings.get('#test', 'greeting')).toBe('hello');

      // isSet should return false before any explicit set
      expect(api.channelSettings.isSet('#test', 'greeting')).toBe(false);

      // Set a value and confirm get() returns the stored value
      api.channelSettings.set('#test', 'greeting', 'howdy');
      expect(api.channelSettings.get('#test', 'greeting')).toBe('howdy');
      expect(api.channelSettings.isSet('#test', 'greeting')).toBe(true);
    });
  });

  describe('channel object form in botConfig', () => {
    it('should expose channel names when config uses object form', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'chanobj-test',
        `
        export const name = 'chanobj-test';
        export const version = '1.0.0';
        export function init(api) {
          globalThis.__testPluginApi = api;
        }
        `,
      );

      const botConfig = {
        ...MINIMAL_BOT_CONFIG,
        irc: {
          ...MINIMAL_BOT_CONFIG.irc,
          channels: ['#plain', { name: '#keyed', key: 'secret' }] as (
            | string
            | { name: string; key: string }
          )[],
        },
      };

      const database = new BotDatabase(':memory:');
      database.open();
      const dispatcher = new EventDispatcher();
      const eventBus = new BotEventBus();
      const permissions = new Permissions(database);
      const loader = new PluginLoader({
        pluginDir: tempDir,
        dispatcher,
        eventBus,
        db: database,
        permissions,
        botConfig: botConfig as BotConfig,
        ircClient: null,
      });

      await loader.load(pluginPath);
      const api = getTestPluginApi();
      // Plugin should see channel names only, not keys
      expect(api.botConfig.irc.channels).toEqual(['#plain', '#keyed']);
      database.close();
    });
  });

  describe('scoped API — unbind', () => {
    it('should allow plugins to unbind handlers', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'unbind-test',
        `
        export const name = 'unbind-test';
        export const version = '1.0.0';
        export const description = '';
        const handler = (ctx) => {};
        export function init(api) {
          api.bind('pub', '-', '!removeme', handler);
          api.unbind('pub', '!removeme', handler);
        }
      `,
      );

      const { loader, dispatcher } = createLoader(tempDir);
      await loader.load(pluginPath);

      const binds = dispatcher.listBinds({ pluginId: 'unbind-test' });
      expect(binds).toHaveLength(0);
    });
  });

  describe('messageQueue routing', () => {
    it('should route plugin say() through messageQueue when provided', async () => {
      const pluginPath = writePlugin(
        tempDir,
        'mq-test',
        `
        export const name = 'mq-test';
        export const version = '1.0.0';
        export const description = '';
        export function init(api) {
          globalThis.__testPluginApi = api;
        }
        `,
      );

      const { MessageQueue } = await import('../src/core/message-queue');
      const mq = new MessageQueue({ rate: 10, burst: 0 });
      const enqueueSpy = vi.spyOn(mq, 'enqueue');

      const { mockIrcClient } = createLoaderFull(tempDir, { messageQueue: mq });
      const { loader } = createLoaderFull(tempDir, { messageQueue: mq });
      await loader.load(pluginPath);

      const api = getTestPluginApi();
      api.say('#test', 'hello');

      // Message should go through the queue, not directly to IRC client
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(mockIrcClient.say).not.toHaveBeenCalled();

      mq.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Channel scoping
  // -------------------------------------------------------------------------

  describe('channel scoping', () => {
    const SCOPED_PLUGIN = `
      export const name = 'scoped';
      export const version = '1.0.0';
      export const description = 'test';
      export function init(api) {
        api.bind('pub', '-', '!cmd', (ctx) => { ctx.reply('fired'); });
        api.bind('msg', '-', '!pm', (ctx) => { ctx.reply('pm-fired'); });
        api.bind('join', '-', '*', (ctx) => { ctx.reply('join-fired'); });
        api.bind('time', '-', '*', (ctx) => { /* timer */ });
      }
    `;

    function makeCtx(
      overrides: Partial<import('../src/types').HandlerContext> = {},
    ): import('../src/types').HandlerContext {
      return {
        nick: 'testuser',
        ident: 'user',
        hostname: 'test.host',
        channel: '#test',
        text: '',
        command: '',
        args: '',
        reply: vi.fn(),
        replyPrivate: vi.fn(),
        ...overrides,
      };
    }

    it('should fire handler in scoped channel', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);
      expect(ctx.reply).toHaveBeenCalledWith('fired');
    });

    it('should skip handler in non-scoped channel', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: '#other', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should always fire for non-channel events (msg)', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: null, command: '!pm' });
      await dispatcher.dispatch('msg', ctx);
      expect(ctx.reply).toHaveBeenCalledWith('pm-fired');
    });

    it('should always fire for timer events (ctx.channel = null)', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: null, command: '', text: '' });
      await dispatcher.dispatch('time', ctx);
      // No assertion on reply (timer handler doesn't call it) — just confirm no error
    });

    it('should block all channel events with empty channels array', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: [] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should fire in all channels when channels field is omitted', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: {},
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx1 = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx1);
      expect(ctx1.reply).toHaveBeenCalledWith('fired');

      const ctx2 = makeCtx({ channel: '#anywhere', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx2);
      expect(ctx2.reply).toHaveBeenCalledWith('fired');
    });

    it('should match channel names case-insensitively', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#Test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctx = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);
      expect(ctx.reply).toHaveBeenCalledWith('fired');
    });

    it('should support multiple channels in scope', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#a', '#b'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctxA = makeCtx({ channel: '#a', command: '!cmd' });
      await dispatcher.dispatch('pub', ctxA);
      expect(ctxA.reply).toHaveBeenCalledWith('fired');

      const ctxB = makeCtx({ channel: '#b', command: '!cmd' });
      await dispatcher.dispatch('pub', ctxB);
      expect(ctxB.reply).toHaveBeenCalledWith('fired');

      const ctxC = makeCtx({ channel: '#c', command: '!cmd' });
      await dispatcher.dispatch('pub', ctxC);
      expect(ctxC.reply).not.toHaveBeenCalled();
    });

    it('should scope join events to allowed channels', async () => {
      writePlugin(tempDir, 'scoped', SCOPED_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        scoped: { channels: ['#lobby'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      const ctxIn = makeCtx({
        channel: '#lobby',
        nick: 'alice',
        text: '#lobby alice!user@host',
        command: 'JOIN',
      });
      await dispatcher.dispatch('join', ctxIn);
      expect(ctxIn.reply).toHaveBeenCalledWith('join-fired');

      const ctxOut = makeCtx({
        channel: '#other',
        nick: 'alice',
        text: '#other alice!user@host',
        command: 'JOIN',
      });
      await dispatcher.dispatch('join', ctxOut);
      expect(ctxOut.reply).not.toHaveBeenCalled();
    });

    it('should allow api.unbind() to remove scoped handlers', async () => {
      const UNBIND_PLUGIN = `
        let handler;
        export const name = 'unbindable';
        export const version = '1.0.0';
        export const description = 'test';
        export function init(api) {
          handler = (ctx) => { ctx.reply('fired'); };
          api.bind('pub', '-', '!cmd', handler);
          // Expose an unbind trigger via a second bind
          api.bind('pub', '-', '!stop', () => {
            api.unbind('pub', '!cmd', handler);
          });
        }
      `;
      writePlugin(tempDir, 'unbindable', UNBIND_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        unbindable: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      // First fire: handler is bound
      const ctx1 = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx1);
      expect(ctx1.reply).toHaveBeenCalledWith('fired');

      // Trigger unbind
      const ctxStop = makeCtx({ channel: '#test', command: '!stop' });
      await dispatcher.dispatch('pub', ctxStop);

      // Second fire: handler should be gone
      const ctx2 = makeCtx({ channel: '#test', command: '!cmd' });
      await dispatcher.dispatch('pub', ctx2);
      expect(ctx2.reply).not.toHaveBeenCalled();
    });

    it('should unbind correctly when the same handler is bound to multiple type/mask pairs', async () => {
      const REUSE_PLUGIN = `
        let handler;
        export const name = 'reuse';
        export const version = '1.0.0';
        export const description = 'test';
        export function init(api) {
          handler = (ctx) => { ctx.reply('fired-' + ctx.command); };
          api.bind('pub', '-', '!one', handler);
          api.bind('pub', '-', '!two', handler);
          api.bind('msg', '-', '!one', handler);
          api.bind('pub', '-', '!drop-two', () => {
            api.unbind('pub', '!two', handler);
          });
        }
      `;
      writePlugin(tempDir, 'reuse', REUSE_PLUGIN);
      const cfgPath = writePluginsJson(tempDir, {
        reuse: { channels: ['#test'] },
      });
      const { loader, dispatcher } = createLoader(tempDir);
      await loader.loadAll(cfgPath);

      // All three binds fire initially
      const ctxOne = makeCtx({ channel: '#test', command: '!one' });
      await dispatcher.dispatch('pub', ctxOne);
      expect(ctxOne.reply).toHaveBeenCalledWith('fired-!one');

      const ctxTwo = makeCtx({ channel: '#test', command: '!two' });
      await dispatcher.dispatch('pub', ctxTwo);
      expect(ctxTwo.reply).toHaveBeenCalledWith('fired-!two');

      const ctxMsg = makeCtx({ channel: null, command: '!one' });
      await dispatcher.dispatch('msg', ctxMsg);
      expect(ctxMsg.reply).toHaveBeenCalledWith('fired-!one');

      // Drop only pub|!two
      const ctxDrop = makeCtx({ channel: '#test', command: '!drop-two' });
      await dispatcher.dispatch('pub', ctxDrop);

      // pub|!two is gone, but pub|!one and msg|!one remain
      const ctxOne2 = makeCtx({ channel: '#test', command: '!one' });
      await dispatcher.dispatch('pub', ctxOne2);
      expect(ctxOne2.reply).toHaveBeenCalledWith('fired-!one');

      const ctxTwo2 = makeCtx({ channel: '#test', command: '!two' });
      await dispatcher.dispatch('pub', ctxTwo2);
      expect(ctxTwo2.reply).not.toHaveBeenCalled();

      const ctxMsg2 = makeCtx({ channel: null, command: '!one' });
      await dispatcher.dispatch('msg', ctxMsg2);
      expect(ctxMsg2.reply).toHaveBeenCalledWith('fired-!one');
    });
  });

  // ---------------------------------------------------------------------------
  // getChannelKey()
  // ---------------------------------------------------------------------------

  describe('getChannelKey', () => {
    function createKeyedLoader(dir: string) {
      const configWithKeys: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        irc: {
          ...MINIMAL_BOT_CONFIG.irc,
          channels: [{ name: '#secret', key: 'sesame' }, '#public'],
        },
      };

      const database = new BotDatabase(':memory:');
      database.open();
      const dispatcher = new EventDispatcher();
      const eventBus = new BotEventBus();
      const permissions = new Permissions(database);

      const loader = new PluginLoader({
        pluginDir: dir,
        dispatcher,
        eventBus,
        db: database,
        permissions,
        botConfig: configWithKeys,
        ircClient: null,
      });

      return { loader, database };
    }

    it('returns the key for a keyed channel', async () => {
      const dir = makeTempDir();
      const pluginPath = writePlugin(
        dir,
        'keytest',
        `export const name='keytest'; export const version='1.0.0'; export const description='d';
         export function init(api) { globalThis.__testPluginApi = api; }`,
      );

      const { loader, database } = createKeyedLoader(dir);
      await loader.load(pluginPath);
      const api = getTestPluginApi();

      expect(api.getChannelKey('#secret')).toBe('sesame');

      await loader.unload(api.pluginId);
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns undefined for a keyless channel', async () => {
      const dir = makeTempDir();
      const pluginPath = writePlugin(
        dir,
        'keytest2',
        `export const name='keytest2'; export const version='1.0.0'; export const description='d';
         export function init(api) { globalThis.__testPluginApi = api; }`,
      );

      const { loader, database } = createKeyedLoader(dir);
      await loader.load(pluginPath);
      const api = getTestPluginApi();

      expect(api.getChannelKey('#public')).toBeUndefined();
      expect(api.getChannelKey('#nonexistent')).toBeUndefined();

      await loader.unload(api.pluginId);
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('performs case-insensitive channel lookup', async () => {
      const dir = makeTempDir();
      const pluginPath = writePlugin(
        dir,
        'keytest3',
        `export const name='keytest3'; export const version='1.0.0'; export const description='d';
         export function init(api) { globalThis.__testPluginApi = api; }`,
      );

      const configWithKeys: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        irc: {
          ...MINIMAL_BOT_CONFIG.irc,
          channels: [{ name: '#Secret', key: 'sesame' }],
        },
      };

      const database = new BotDatabase(':memory:');
      database.open();
      const dispatcher = new EventDispatcher();
      const eventBus = new BotEventBus();
      const permissions = new Permissions(database);

      const loader = new PluginLoader({
        pluginDir: dir,
        dispatcher,
        eventBus,
        db: database,
        permissions,
        botConfig: configWithKeys,
        ircClient: null,
      });

      await loader.load(pluginPath);
      const api = getTestPluginApi();

      expect(api.getChannelKey('#SECRET')).toBe('sesame');
      expect(api.getChannelKey('#secret')).toBe('sesame');

      await loader.unload(api.pluginId);
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
