// After `dispose()` is called on a plugin API handle, every method
// (top-level and sub-API namespace) must become a no-op. The test also
// covers `offModesReady` / `offPermissionsChanged` since they share a
// factory path.
import { describe, expect, it, vi } from 'vitest';

import { SettingsRegistry } from '../src/core/settings-registry';
import { BotDatabase } from '../src/database';
import { BotEventBus } from '../src/event-bus';
import { type PluginApiDeps, createPluginApi } from '../src/plugin-api-factory';

function makeDeps(): PluginApiDeps {
  const eventBus = new BotEventBus();
  return {
    dispatcher: {
      bind: vi.fn(),
      unbind: vi.fn(),
      unbindAll: vi.fn(),
    },
    eventBus,
    db: null,
    permissions: {
      findByHostmask: vi.fn().mockReturnValue(null),
      checkFlags: vi.fn().mockReturnValue(false),
    } as unknown as PluginApiDeps['permissions'],
    botVersion: '0.0.0-test',
    botConfig: {
      irc: {
        host: 'h',
        port: 6667,
        tls: false,
        nick: 'hexbot',
        username: 'h',
        realname: 'h',
        channels: [],
      },
      owner: { handle: 'o', hostmask: '*!*@o' },
      identity: { method: 'hostmask', require_acc_for: [] },
      services: { type: 'none', nickserv: 'NickServ', sasl: false, password: '' },
      database: ':memory:',
      pluginDir: '',
      logging: { level: 'info', mod_actions: true },
    } as PluginApiDeps['botConfig'],
    ircClient: null,
    channelState: null,
    ircCommands: null,
    messageQueue: null,
    services: null,
    helpRegistry: null,
    channelSettings: null,
    coreSettings: null,
    pluginSettings: null,
    banStore: null,
    rootLogger: null,
    getCasemapping: () => 'rfc1459',
    getServerSupports: () => ({}),
    modesReadyListeners: new Map(),
    permissionsChangedListeners: new Map(),
    userIdentifiedListeners: new Map(),
    userDeidentifiedListeners: new Map(),
    botIdentifiedListeners: new Map(),
  };
}

describe('plugin-api dispose (W-PS1)', () => {
  it('top-level methods work before dispose and no-op after', () => {
    const deps = makeDeps();
    const { api, dispose } = createPluginApi(deps, 'demo', {});

    // Before dispose: normal behavior
    expect(api.isBotNick('hexbot')).toBe(true);
    expect(api.ircLower('FOO')).toBe('foo');
    expect(api.buildHostmask({ nick: 'a', ident: 'b', hostname: 'c' })).toBe('a!b@c');

    dispose();

    // After dispose: every method returns undefined (the guarded no-op)
    expect(api.isBotNick('hexbot')).toBeUndefined();
    expect(api.ircLower('FOO')).toBeUndefined();
    expect(api.buildHostmask({ nick: 'a', ident: 'b', hostname: 'c' })).toBeUndefined();
  });

  it('bind is guarded: calls the dispatcher before dispose, nothing after', () => {
    const deps = makeDeps();
    const { api, dispose } = createPluginApi(deps, 'demo', {});
    const noHandler = () => {};

    api.bind('pub', '-', '*', noHandler);
    expect(deps.dispatcher.bind).toHaveBeenCalledTimes(1);

    dispose();
    api.bind('pub', '-', '*', noHandler);
    expect(deps.dispatcher.bind).toHaveBeenCalledTimes(1); // unchanged
  });

  it('sub-API namespaces (permissions, db stub) also no-op after dispose', () => {
    const deps = makeDeps();
    const { api, dispose } = createPluginApi(deps, 'demo', {});

    // Before dispose: permissions.findByHostmask flows through to the stub
    expect(api.permissions.findByHostmask('a!b@c')).toBeNull();

    dispose();

    // After dispose: every method on sub-namespaces returns undefined
    expect(api.permissions.findByHostmask('a!b@c')).toBeUndefined();
    // The banStore sub-API (no-op stub path) — still no-ops, now via dispose
    expect(api.banStore.getBan('#c', 'mask')).toBeUndefined();
    // db null-stub path also neutralized
    expect(api.db.get('k')).toBeUndefined();
  });

  it('settings.bootConfig and botConfig data objects are still readable after dispose', () => {
    const deps = makeDeps();
    const { api, dispose } = createPluginApi(deps, 'demo', { foo: 'bar' });

    dispose();

    // Data-only keys pass through unchanged — plugins reading config after
    // teardown (e.g. a stale log line) must not crash.
    expect(api.pluginId).toBe('demo');
    expect(api.settings.bootConfig).toEqual({ foo: 'bar' });
    expect(api.botConfig.irc.nick).toBe('hexbot');
  });

  it('dispose() is idempotent', () => {
    const deps = makeDeps();
    const { api, dispose } = createPluginApi(deps, 'demo', {});
    dispose();
    expect(() => dispose()).not.toThrow();
    expect(api.isBotNick('hexbot')).toBeUndefined();
  });
});

describe('onModesReady / offModesReady (W-PS2)', () => {
  it('offModesReady removes the listener', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    const cb = vi.fn();
    api.onModesReady(cb);
    deps.eventBus.emit('channel:modesReady', '#x');
    expect(cb).toHaveBeenCalledTimes(1);
    api.offModesReady(cb);
    deps.eventBus.emit('channel:modesReady', '#x');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('offModesReady is a no-op for an unknown callback', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    expect(() => api.offModesReady(() => {})).not.toThrow();
  });

  it('onModesReady is idempotent for the same callback reference', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    const cb = vi.fn();
    api.onModesReady(cb);
    api.onModesReady(cb); // second call is a no-op
    deps.eventBus.emit('channel:modesReady', '#x');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('onPermissionsChanged / offPermissionsChanged (W-PS2)', () => {
  it('offPermissionsChanged removes the listener from all three events', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    const cb = vi.fn();
    api.onPermissionsChanged(cb);

    deps.eventBus.emit('user:added', 'alice');
    deps.eventBus.emit('user:flagsChanged', 'alice', 'm', {});
    deps.eventBus.emit('user:hostmaskAdded', 'alice', '*!*@a');
    expect(cb).toHaveBeenCalledTimes(3);

    api.offPermissionsChanged(cb);

    deps.eventBus.emit('user:added', 'bob');
    deps.eventBus.emit('user:flagsChanged', 'bob', 'm', {});
    deps.eventBus.emit('user:hostmaskAdded', 'bob', '*!*@b');
    expect(cb).toHaveBeenCalledTimes(3); // no new calls
  });

  it('offPermissionsChanged is a no-op for an unknown callback', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    expect(() => api.offPermissionsChanged(() => {})).not.toThrow();
  });

  it('onPermissionsChanged is idempotent for the same callback reference', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', {});
    const cb = vi.fn();
    api.onPermissionsChanged(cb);
    api.onPermissionsChanged(cb);
    deps.eventBus.emit('user:added', 'alice');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('api.settings register-time JSON seed', () => {
  // The factory's `register()` wrapper seeds each newly-registered key
  // from the merged plugins.json/config.json bag handed to
  // createPluginApi. These tests pin every branch of that path so the
  // happy path, the "value already set" skip, the "missing in JSON"
  // skip, and the "non-coercible JSON" skip are all exercised.
  function makeDepsWithRegistry(db: BotDatabase): { deps: PluginApiDeps; reg: SettingsRegistry } {
    const reg = new SettingsRegistry({
      scope: 'plugin',
      namespace: 'plugin:demo',
      db,
      auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
    });
    const deps = makeDeps();
    deps.db = db;
    deps.pluginSettings = reg;
    return { deps, reg };
  }

  it('seeds an int-typed setting from the JSON bag at register() time', () => {
    const db = new BotDatabase(':memory:');
    db.open();
    try {
      const { deps, reg } = makeDepsWithRegistry(db);
      const { api } = createPluginApi(deps, 'demo', { rate: 42 });
      api.settings.register([{ key: 'rate', type: 'int', default: 0, description: 'Rate' }]);
      expect(reg.getInt('', 'rate')).toBe(42);
      expect(api.settings.getInt('rate')).toBe(42);
    } finally {
      db.close();
    }
  });

  it('does NOT overwrite a KV-already-set value when register() runs', () => {
    const db = new BotDatabase(':memory:');
    db.open();
    try {
      const { deps, reg } = makeDepsWithRegistry(db);
      // Pre-seed via a prior load — operator's `.set` survived.
      reg.register('demo', [{ key: 'rate', type: 'int', default: 0, description: 'Rate' }]);
      reg.set('', 'rate', 7);
      const { api } = createPluginApi(deps, 'demo', { rate: 999 });
      api.settings.register([{ key: 'rate', type: 'int', default: 0, description: 'Rate' }]);
      expect(api.settings.getInt('rate')).toBe(7);
    } finally {
      db.close();
    }
  });

  it('skips keys missing from the JSON bag (default reads as registered)', () => {
    const db = new BotDatabase(':memory:');
    db.open();
    try {
      const { deps } = makeDepsWithRegistry(db);
      const { api } = createPluginApi(deps, 'demo', {});
      api.settings.register([{ key: 'rate', type: 'int', default: 5, description: 'Rate' }]);
      expect(api.settings.isSet('rate')).toBe(false);
      expect(api.settings.getInt('rate')).toBe(5);
    } finally {
      db.close();
    }
  });

  it('drops a non-coercible JSON value (object on string-typed def)', () => {
    const db = new BotDatabase(':memory:');
    db.open();
    try {
      const { deps } = makeDepsWithRegistry(db);
      const { api } = createPluginApi(deps, 'demo', { name: { not: 'a string' } });
      api.settings.register([
        { key: 'name', type: 'string', default: 'fallback', description: 'Name' },
      ]);
      expect(api.settings.isSet('name')).toBe(false);
      expect(api.settings.getString('name')).toBe('fallback');
    } finally {
      db.close();
    }
  });

  it('exposes bootConfig as a frozen snapshot of the merged JSON bag', () => {
    const db = new BotDatabase(':memory:');
    db.open();
    try {
      const { deps } = makeDepsWithRegistry(db);
      const { api } = createPluginApi(deps, 'demo', { foo: 'bar', nested: { k: 1 } });
      expect(api.settings.bootConfig).toEqual({ foo: 'bar', nested: { k: 1 } });
      expect(Object.isFrozen(api.settings.bootConfig)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('falls back to the no-registry stub when pluginSettings is null', () => {
    const deps = makeDeps();
    const { api } = createPluginApi(deps, 'demo', { foo: 'bar' });
    // No throws on any operation; reads return inert defaults.
    api.settings.register([{ key: 'x', type: 'int', default: 0, description: 'x' }]);
    expect(api.settings.getInt('x')).toBe(0);
    expect(api.settings.getString('x')).toBe('');
    expect(api.settings.getFlag('x')).toBe(false);
    expect(api.settings.isSet('x')).toBe(false);
    expect(api.settings.bootConfig).toEqual({ foo: 'bar' });
    api.settings.set('x', 1);
    api.settings.unset('x');
    api.settings.onChange(() => {});
    api.settings.offChange(() => {});
  });
});
