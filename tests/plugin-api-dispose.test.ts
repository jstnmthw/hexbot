// After `dispose()` is called on a plugin API handle, every method
// (top-level and sub-API namespace) must become a no-op. The test also
// covers `offModesReady` / `offPermissionsChanged` since they share a
// factory path.
import { describe, expect, it, vi } from 'vitest';

import { SettingsRegistry } from '../src/core/settings-registry';
import { BotDatabase } from '../src/database';
import { EventDispatcher } from '../src/dispatcher';
import { BotEventBus } from '../src/event-bus';
import {
  PLUGIN_SUBSCRIPTION_HARDCAP,
  PLUGIN_SUBSCRIPTION_WARN,
  type PluginApiDeps,
  createPluginApi,
} from '../src/plugin-api-factory';

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

// ---------------------------------------------------------------------------
// M-11: wrappedHandlers must mirror dispatcher bind state for scoped plugins
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    setLevel: () => {},
    getLevel: () => 'info' as const,
  };
  return logger;
}

describe('channel-scoped api.bind wrappedHandlers reconciliation (M-11)', () => {
  it('a dispatcher-refused bind leaves no tracking entry behind', () => {
    const deps = makeDeps();
    // Simulate the dispatcher's hard-cap refusal: bind() reports rejection.
    deps.dispatcher = {
      bind: vi.fn().mockReturnValue(false),
      unbind: vi.fn(),
      unbindAll: vi.fn(),
    };
    const { api } = createPluginApi(deps, 'demo', {}, ['#chan']);
    const handler = () => {};

    api.bind('pubm', '-', 'refused', handler);
    expect(deps.dispatcher.bind).toHaveBeenCalledTimes(1);

    // With no stale tracking entry, unbind falls through to the plugin's
    // own handler reference. A stale entry would surface as a wrapper
    // function (!== handler) being passed to dispatcher.unbind.
    api.unbind('pubm', 'refused', handler);
    expect(deps.dispatcher.unbind).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.dispatcher.unbind).mock.calls[0][2]).toBe(handler);
  });

  it('refused binds at the real dispatcher hard cap do not grow dispatcher state', () => {
    const dispatcher = new EventDispatcher(null, makeLogger());
    const deps = makeDeps();
    deps.dispatcher = dispatcher;
    const { api } = createPluginApi(deps, 'demo', {}, ['#chan']);
    const handler = () => {};

    for (let i = 0; i < 1000; i++) {
      api.bind('pubm', '-', `m${i}`, handler);
    }
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(1000);

    // Past the cap: refused by the dispatcher; the factory must not track it.
    api.bind('pub', '-', 'overflow', handler);
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(1000);
    // Unbinding the refused mask must not detach anything that is live.
    api.unbind('pub', 'overflow', handler);
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(1000);
  });

  it('non-stackable re-bind replaces the tracking entry and unbind detaches the live handler', () => {
    const dispatcher = new EventDispatcher(null, makeLogger());
    const deps = makeDeps();
    deps.dispatcher = dispatcher;
    const { api } = createPluginApi(deps, 'demo', {}, ['#chan']);
    const handler = () => {};

    // Documented overwrite semantics: re-bind the same (type, mask) to
    // replace the handler. Each call evicts the previous dispatcher bind.
    api.bind('pub', '-', 'cmd', handler);
    api.bind('pub', '-', 'cmd', handler);
    api.bind('pub', '-', 'cmd', handler);
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(1);

    // Pre-fix, the stale-entry-first lookup unbinds a dead wrapper and the
    // live bind stays attached. Post-fix a single unbind detaches it.
    api.unbind('pub', 'cmd', handler);
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(0);
  });

  it('re-binding with a new handler still allows unbinding via the new handler', () => {
    const dispatcher = new EventDispatcher(null, makeLogger());
    const deps = makeDeps();
    deps.dispatcher = dispatcher;
    const { api } = createPluginApi(deps, 'demo', {}, ['#chan']);
    const first = () => {};
    const second = () => {};

    api.bind('msg', '-', 'cmd', first);
    api.bind('msg', '-', 'cmd', second); // overwrites (msg is non-stackable)
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(1);

    api.unbind('msg', 'cmd', second);
    expect(dispatcher.listBinds({ pluginId: 'demo' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M-13: per-plugin cap on the on*/onChange subscription surfaces
// ---------------------------------------------------------------------------

describe('subscription budget on on*/onChange surfaces (M-13)', () => {
  it('warns at the soft cap and refuses registrations past the hard cap with a log', () => {
    const deps = makeDeps();
    const logger = makeLogger();
    deps.rootLogger = logger;
    const { api } = createPluginApi(deps, 'demo', {});

    // Fresh closure per call — the runaway pattern the cap exists to contain.
    for (let i = 0; i < PLUGIN_SUBSCRIPTION_WARN; i++) {
      api.onModesReady(() => {});
    }
    const warnCalls = () =>
      logger.warn.mock.calls.filter((c) => String(c[0]).includes('warn threshold'));
    expect(warnCalls()).toHaveLength(0);

    // Crossing the warn threshold logs exactly once.
    api.onModesReady(() => {});
    expect(warnCalls()).toHaveLength(1);

    for (let i = PLUGIN_SUBSCRIPTION_WARN + 1; i < PLUGIN_SUBSCRIPTION_HARDCAP; i++) {
      api.onModesReady(() => {});
    }
    expect(deps.modesReadyListeners.get('demo')).toHaveLength(PLUGIN_SUBSCRIPTION_HARDCAP);
    expect(warnCalls()).toHaveLength(1); // warn fires once, not per call

    // Past the hard cap: refused, logged, and nothing is registered.
    const overflow = vi.fn();
    api.onModesReady(overflow);
    expect(deps.modesReadyListeners.get('demo')).toHaveLength(PLUGIN_SUBSCRIPTION_HARDCAP);
    const errorCalls = logger.error.mock.calls.filter((c) =>
      String(c[0]).includes('hit subscription cap'),
    );
    expect(errorCalls).toHaveLength(1);
    deps.eventBus.emit('channel:modesReady', '#x');
    expect(overflow).not.toHaveBeenCalled();
  });

  it('the cap is shared across surfaces and off* returns capacity', () => {
    const deps = makeDeps();
    deps.rootLogger = makeLogger();
    const { api } = createPluginApi(deps, 'demo', {});

    const tracked = vi.fn();
    api.onModesReady(tracked); // 1 of HARDCAP
    for (let i = 1; i < PLUGIN_SUBSCRIPTION_HARDCAP; i++) {
      api.onBotIdentified(() => {}); // fill the rest of the shared budget
    }

    // One shared counter: a different surface is refused at the cap.
    const cb = vi.fn();
    api.onUserIdentified(cb);
    expect(deps.userIdentifiedListeners.get('demo') ?? []).toHaveLength(0);

    // off* releases capacity, so the next registration succeeds.
    api.offModesReady(tracked);
    api.onUserIdentified(cb);
    expect(deps.userIdentifiedListeners.get('demo')).toHaveLength(1);
  });
});
