import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createState, pruneExpiredState } from '../../plugins/chanmod/state';

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

  describe('scheduleCycle()', () => {
    it('auto-removes timer from set after firing', () => {
      const state = createState();
      const fn = vi.fn();

      state.scheduleCycle(200, fn);
      expect(state.cycleTimers.size).toBe(1);

      vi.advanceTimersByTime(201);
      expect(fn).toHaveBeenCalledOnce();
      expect(state.cycleTimers.size).toBe(0);
    });
  });
});
