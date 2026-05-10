import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHANMOD_SETTING_DEFS,
  createState,
  pruneExpiredState,
  readConfig,
} from '../../plugins/chanmod/state';
import { coerceFromJson } from '../../src/core/seed-from-json';
import { SettingsRegistry } from '../../src/core/settings-registry';
import { BotDatabase } from '../../src/database';
import type { PluginAPI, PluginSettings } from '../../src/types';

/**
 * Build a minimal PluginAPI whose `settings` is a real SettingsRegistry
 * fed with the test's plugin config bag (post-coercion, same path the
 * plugin loader uses). `botConfig.services.type` and `botConfig.chanmod`
 * are stubbed so readConfig() can read the chanserv-services derivation
 * and nick-recovery password defaults.
 */
function makeConfigApi(pluginConfig: Record<string, unknown>, logs: string[]): PluginAPI {
  const db = new BotDatabase(':memory:');
  db.open();
  const registry = new SettingsRegistry({
    scope: 'plugin',
    namespace: 'plugin:chanmod',
    db,
    auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
  });
  registry.register('chanmod', CHANMOD_SETTING_DEFS);
  for (const def of CHANMOD_SETTING_DEFS) {
    const seed = pluginConfig[def.key];
    if (seed === undefined) continue;
    const coerced = coerceFromJson(
      { ...def, owner: 'chanmod', reloadClass: def.reloadClass ?? 'live' },
      seed,
    );
    if (coerced !== null) registry.set('', def.key, coerced);
  }
  const settings: PluginSettings = {
    register: () => {},
    get: (key) => registry.get('', key),
    getFlag: (key) => registry.getFlag('', key),
    getString: (key) => registry.getString('', key),
    getInt: (key) => registry.getInt('', key),
    set: (key, value) => {
      registry.set('', key, value);
    },
    unset: (key) => {
      registry.unset('', key);
    },
    isSet: (key) => registry.isSet('', key),
    onChange: () => {},
    offChange: () => {},
    bootConfig: Object.freeze({ ...pluginConfig }),
  };
  return {
    settings,
    botConfig: {
      services: { type: 'atheme' },
      chanmod: { nick_recovery_password: '' },
    },
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    // The rest of PluginAPI is unused by readConfig — cast through unknown.
  } as unknown as PluginAPI;
}

describe('chanmod state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pruneExpiredState()', () => {
    it('removes expired intentionalModeChanges', () => {
      const state = createState();
      state.intentionalModeChanges.set('key1', Date.now() + 1000);
      state.intentionalModeChanges.set('key2', Date.now() - 1);

      pruneExpiredState(state);

      expect(state.intentionalModeChanges.has('key1')).toBe(true);
      expect(state.intentionalModeChanges.has('key2')).toBe(false);
    });

    it('removes expired enforcementCooldown entries', () => {
      const state = createState();
      state.enforcementCooldown.set('fresh', { count: 1, expiresAt: Date.now() + 5000 });
      state.enforcementCooldown.set('stale', { count: 2, expiresAt: Date.now() - 1 });

      pruneExpiredState(state);

      expect(state.enforcementCooldown.has('fresh')).toBe(true);
      expect(state.enforcementCooldown.has('stale')).toBe(false);
    });

    it('is a no-op on empty maps', () => {
      const state = createState();
      pruneExpiredState(state);
      expect(state.intentionalModeChanges.size).toBe(0);
      expect(state.enforcementCooldown.size).toBe(0);
    });

    it('drops idle threatScores entries when takeoverWindowMs is supplied', () => {
      const state = createState();
      const now = Date.now();
      state.threatScores.set('#fresh', { score: 1, events: [], windowStart: now });
      state.threatScores.set('#idle', {
        score: 5,
        events: [{ type: 'x', actor: 'a', timestamp: now - 1_000_000 }],
        windowStart: now - 1_000_000,
      });
      // takeoverWindowMs=30s → idle cutoff at 4*30s=120s; the #idle entry
      // is well past the cutoff and should be dropped.
      pruneExpiredState(state, 30_000);
      expect(state.threatScores.has('#fresh')).toBe(true);
      expect(state.threatScores.has('#idle')).toBe(false);
    });

    it('leaves threatScores alone when takeoverWindowMs is omitted', () => {
      const state = createState();
      state.threatScores.set('#x', {
        score: 1,
        events: [],
        windowStart: Date.now() - 1_000_000,
      });
      pruneExpiredState(state);
      expect(state.threatScores.has('#x')).toBe(true);
    });

    it('drops lastKnownModes past the 24h TTL', () => {
      const state = createState();
      const now = Date.now();
      state.lastKnownModes.set('#recent', { modes: '+nt', setAt: now - 60_000 });
      state.lastKnownModes.set('#old', {
        modes: '+nt',
        setAt: now - 25 * 60 * 60_000,
      });
      // Untimestamped legacy entry — left alone (no setAt to compare).
      state.lastKnownModes.set('#legacy', { modes: '+nt' });
      pruneExpiredState(state);
      expect(state.lastKnownModes.has('#recent')).toBe(true);
      expect(state.lastKnownModes.has('#old')).toBe(false);
      expect(state.lastKnownModes.has('#legacy')).toBe(true);
    });
  });

  describe('scheduleEnforcement()', () => {
    it('auto-removes timer from set after firing', () => {
      const state = createState();
      const fn = vi.fn();

      state.scheduleEnforcement(100, fn);
      expect(state.enforcementTimers.size).toBe(1);

      vi.advanceTimersByTime(101);
      expect(fn).toHaveBeenCalledOnce();
      expect(state.enforcementTimers.size).toBe(0);
    });
  });

  describe('cycles.schedule()', () => {
    it('auto-removes timer from set after firing', () => {
      const state = createState();
      const fn = vi.fn();

      state.cycles.schedule(200, fn);
      expect(state.cycles.size).toBe(1);

      vi.advanceTimersByTime(201);
      expect(fn).toHaveBeenCalledOnce();
      expect(state.cycles.size).toBe(0);
    });
  });

  describe('cycles.scheduleWithLock()', () => {
    it('returns false when a lock is already held and does not schedule', () => {
      const state = createState();
      const fn = vi.fn();

      expect(state.cycles.scheduleWithLock('#chan', 100, fn)).toBe(true);
      expect(state.cycles.isLocked('#chan')).toBe(true);
      expect(state.cycles.scheduleWithLock('#chan', 100, fn)).toBe(false);

      vi.advanceTimersByTime(101);
      expect(fn).toHaveBeenCalledOnce();
      // The lock persists until the caller explicitly unlocks it — matches the
      // mode-enforce-recovery pattern where unlock() fires after the rejoin lands.
      expect(state.cycles.isLocked('#chan')).toBe(true);

      state.cycles.unlock('#chan');
      expect(state.cycles.isLocked('#chan')).toBe(false);
    });
  });

  describe('cycles.clearAll()', () => {
    it('clears tracked timers and locks', () => {
      const state = createState();
      state.cycles.schedule(100, () => {});
      state.cycles.scheduleWithLock('#k', 100, () => {});
      expect(state.cycles.size).toBe(2);
      expect(state.cycles.isLocked('#k')).toBe(true);

      state.cycles.clearAll();
      expect(state.cycles.size).toBe(0);
      expect(state.cycles.isLocked('#k')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // readConfig() — post-migration the typed-settings registry handles
  // coercion and rejection at seed time, so the only remaining
  // chanmod-side validation is the load-bearing services_host_pattern
  // pin (the ChanServ-impostor guard).
  // -------------------------------------------------------------------------

  describe('readConfig() validation', () => {
    it('throws when services_host_pattern is missing — the CRITICAL ChanServ pin guard is load-bearing', () => {
      const logs: string[] = [];
      const api = makeConfigApi({}, logs);
      expect(() => readConfig(api)).toThrow(/services_host_pattern is required/);
    });

    it('throws when services_host_pattern is only whitespace', () => {
      const logs: string[] = [];
      const api = makeConfigApi({ services_host_pattern: '   ' }, logs);
      expect(() => readConfig(api)).toThrow(/services_host_pattern is required/);
    });

    it('drops a non-coercible setting and falls back to the registered default', () => {
      const logs: string[] = [];
      // chanserv_nick is `string`-typed; an object value is structurally
      // incompatible (coerceFromJson returns null) and the registered
      // default ('ChanServ') wins. Scalar numbers stringify cleanly so
      // they're not the right test target here.
      const api = makeConfigApi(
        { chanserv_nick: { not: 'a string' }, services_host_pattern: 'services.*' },
        logs,
      );
      const cfg = readConfig(api);
      expect(cfg.chanserv_nick).toBe('ChanServ');
    });

    it('drops a non-coercible string-array entry to the registered default', () => {
      const logs: string[] = [];
      // Mixed-type array: rejected by coerceFromJson's "every(string)"
      // guard for string-typed defs. Default ['n','m','o'] wins.
      const api = makeConfigApi(
        { op_flags: ['n', 42, 'o'], services_host_pattern: 'services.*' },
        logs,
      );
      const cfg = readConfig(api);
      expect(cfg.op_flags).toEqual(['n', 'm', 'o']);
    });

    it('readStringArray returns [] for an explicit empty-string setting', () => {
      const logs: string[] = [];
      // Operator wrote `.set chanmod halfop_flags ""` — the seed path
      // stores an empty string, and readStringArray's `!raw` branch
      // collapses it to an empty list (not the registered default).
      const api = makeConfigApi({ halfop_flags: '', services_host_pattern: 'services.*' }, logs);
      const cfg = readConfig(api);
      expect(cfg.halfop_flags).toEqual([]);
    });

    it('readStringOr falls back when the stored string is empty', () => {
      const logs: string[] = [];
      // Empty string seeds successfully but readStringOr treats it as
      // "no operator value" and yields the documented default.
      const api = makeConfigApi(
        { default_kick_reason: '', services_host_pattern: 'services.*' },
        logs,
      );
      const cfg = readConfig(api);
      expect(cfg.default_kick_reason).toBe('Requested');
    });

    it('chanserv_services_type derives from botConfig.services.type when JSON omits it', () => {
      const logs: string[] = [];
      const api = makeConfigApi({ services_host_pattern: 'services.*' }, logs);
      const cfg = readConfig(api);
      // makeConfigApi stubs services.type=atheme, so the derived value
      // matches and the JSON-side empty default doesn't overwrite it.
      expect(cfg.chanserv_services_type).toBe('atheme');
    });
  });
});
