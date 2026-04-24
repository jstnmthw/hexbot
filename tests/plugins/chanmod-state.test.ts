import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ChanmodConfig,
  createState,
  pruneExpiredState,
  readConfig,
} from '../../plugins/chanmod/state';
import type { PluginAPI } from '../../src/types';

/**
 * Build the smallest PluginAPI shim readConfig() touches: api.config (raw
 * plugin config), api.botConfig.services.type, api.botConfig.chanmod, and
 * api.log() so we can capture validation warnings.
 */
function makeConfigApi(pluginConfig: Record<string, unknown>, logs: string[]): PluginAPI {
  return {
    config: pluginConfig,
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
  // readConfig() validation paths — exercise the cfgString and cfgStringArray
  // "wrong type" branches so a typo in plugins.json produces a warning and
  // falls back to the default rather than silently propagating bad data.
  // -------------------------------------------------------------------------

  describe('readConfig() type validation', () => {
    it('warns and falls back when a string config is given a non-string', () => {
      const logs: string[] = [];
      const api = makeConfigApi(
        { chanserv_nick: 12345, services_host_pattern: 'services.*' },
        logs,
      );
      const cfg: ChanmodConfig = readConfig(api);
      // Default for chanserv_nick is "ChanServ" — fallback should win.
      expect(cfg.chanserv_nick).toBe('ChanServ');
      expect(logs.some((m) => m.includes('Invalid chanserv_nick'))).toBe(true);
      expect(logs.some((m) => m.includes('expected string'))).toBe(true);
    });

    it('warns and falls back when a string-array config is not an array of strings', () => {
      const logs: string[] = [];
      // Mixed-type array: must be rejected by the every(string) guard.
      const api = makeConfigApi(
        { op_flags: ['n', 42, 'o'], services_host_pattern: 'services.*' },
        logs,
      );
      const cfg: ChanmodConfig = readConfig(api);
      // Default for op_flags is ['n', 'm', 'o'] — fallback should win.
      expect(cfg.op_flags).toEqual(['n', 'm', 'o']);
      expect(logs.some((m) => m.includes('Invalid op_flags'))).toBe(true);
      expect(logs.some((m) => m.includes('expected string[]'))).toBe(true);
    });

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

    it('warns once per offending key, not for valid neighbours', () => {
      const logs: string[] = [];
      const api = makeConfigApi(
        {
          chanserv_nick: { wrong: 'shape' },
          op_flags: ['n', 'm'],
          services_host_pattern: 'services.*',
        },
        logs,
      );
      readConfig(api);
      // Only chanserv_nick should warn — op_flags is a valid string array.
      const offending = logs.filter((m) => m.includes('Invalid'));
      expect(offending).toHaveLength(1);
      expect(offending[0]).toContain('chanserv_nick');
    });
  });
});
