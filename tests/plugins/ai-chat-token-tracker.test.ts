import { describe, expect, it } from 'vitest';

import { GLOBAL_KEY, TokenTracker } from '../../plugins/ai-chat/token-tracker';
import type { PluginDB } from '../../src/types';

/** Minimal in-memory PluginDB for tests. */
function makeDb(): PluginDB {
  const store = new Map<string, string>();
  return {
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    del: (k) => void store.delete(k),
    list: (prefix = '') =>
      [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, value: v })),
  };
}

function makeTracker(
  budget = { perUserDaily: 1000, globalDaily: 5000 },
  date = new Date('2026-04-04T12:00:00Z'),
): { tracker: TokenTracker; db: PluginDB; clock: { now: Date } } {
  const db = makeDb();
  const clock = { now: new Date(date) };
  const tracker = new TokenTracker(db, budget, () => clock.now);
  return { tracker, db, clock };
}

describe('TokenTracker', () => {
  it('returns zero usage for an unknown nick', () => {
    const { tracker } = makeTracker();
    expect(tracker.getUsage('alice')).toEqual({ input: 0, output: 0, requests: 0 });
  });

  it('records usage and accumulates across calls', () => {
    const { tracker } = makeTracker();
    tracker.recordUsage('alice', { input: 10, output: 20 });
    tracker.recordUsage('alice', { input: 5, output: 7 });
    expect(tracker.getUsage('alice')).toEqual({ input: 15, output: 27, requests: 2 });
  });

  it('records into the global bucket as well', () => {
    const { tracker } = makeTracker();
    tracker.recordUsage('alice', { input: 10, output: 20 });
    tracker.recordUsage('bob', { input: 3, output: 4 });
    expect(tracker.getDailyTotal()).toEqual({ input: 13, output: 24, requests: 2 });
  });

  it('is case-insensitive on nicks', () => {
    const { tracker } = makeTracker();
    tracker.recordUsage('ALICE', { input: 5, output: 5 });
    expect(tracker.getUsage('alice')).toEqual({ input: 5, output: 5, requests: 1 });
    expect(tracker.getUsage('Alice')).toEqual({ input: 5, output: 5, requests: 1 });
  });

  it('canSpend returns true when under budgets', () => {
    const { tracker } = makeTracker({ perUserDaily: 100, globalDaily: 1000 });
    tracker.recordUsage('alice', { input: 20, output: 30 });
    expect(tracker.canSpend('alice', 40)).toBe(true);
  });

  it('canSpend returns false when per-user budget would be exceeded', () => {
    const { tracker } = makeTracker({ perUserDaily: 100, globalDaily: 1000 });
    tracker.recordUsage('alice', { input: 40, output: 40 });
    expect(tracker.canSpend('alice', 30)).toBe(false);
  });

  it('canSpend returns false when global budget would be exceeded', () => {
    const { tracker } = makeTracker({ perUserDaily: 10_000, globalDaily: 100 });
    tracker.recordUsage('alice', { input: 40, output: 40 });
    expect(tracker.canSpend('bob', 30)).toBe(false);
  });

  it('canSpend ignores budgets set to 0', () => {
    const { tracker } = makeTracker({ perUserDaily: 0, globalDaily: 0 });
    tracker.recordUsage('alice', { input: 1_000_000, output: 1_000_000 });
    expect(tracker.canSpend('alice', 999_999)).toBe(true);
  });

  it('canSpendGlobal ignores per-user caps (admin path)', () => {
    const { tracker } = makeTracker({ perUserDaily: 10, globalDaily: 10_000 });
    tracker.recordUsage('alice', { input: 5, output: 5 });
    // canSpend refuses (per-user exhausted) but canSpendGlobal still allows.
    expect(tracker.canSpend('alice', 1)).toBe(false);
    expect(tracker.canSpendGlobal(1)).toBe(true);
  });

  it('canSpendGlobal still enforces the global cap', () => {
    const { tracker } = makeTracker({ perUserDaily: 10_000, globalDaily: 100 });
    tracker.recordUsage('someone', { input: 60, output: 40 });
    expect(tracker.canSpendGlobal(1)).toBe(false);
  });

  it('canSpendGlobal returns true when globalDaily is 0 (disabled)', () => {
    const { tracker } = makeTracker({ perUserDaily: 10, globalDaily: 0 });
    tracker.recordUsage('alice', { input: 1_000_000, output: 1_000_000 });
    expect(tracker.canSpendGlobal(999_999)).toBe(true);
  });

  it('uses a separate bucket per day', () => {
    const { tracker, clock } = makeTracker(
      { perUserDaily: 1000, globalDaily: 10_000 },
      new Date('2026-04-04T23:50:00Z'),
    );
    tracker.recordUsage('alice', { input: 100, output: 100 });

    // Advance to the next UTC day.
    clock.now = new Date('2026-04-05T00:10:00Z');

    expect(tracker.getUsage('alice')).toEqual({ input: 0, output: 0, requests: 0 });
    expect(tracker.getDailyTotal()).toEqual({ input: 0, output: 0, requests: 0 });
  });

  it("resetUser clears today's row for that nick", () => {
    const { tracker, db } = makeTracker();
    tracker.recordUsage('alice', { input: 100, output: 100 });
    tracker.resetUser('alice');
    expect(tracker.getUsage('alice')).toEqual({ input: 0, output: 0, requests: 0 });
    // Global aggregate is untouched.
    expect(tracker.getDailyTotal().input).toBe(100);
    // Row actually deleted
    expect(db.get('tokens:2026-04-04:alice')).toBeUndefined();
  });

  it('prunes rows older than 30 days on first access each day', () => {
    const { tracker, db, clock } = makeTracker(
      { perUserDaily: 1000, globalDaily: 1000 },
      new Date('2026-04-04T12:00:00Z'),
    );
    // Seed a row that's 31 days old.
    db.set('tokens:2026-03-04:alice', JSON.stringify({ input: 1, output: 1, requests: 1 }));
    // And a row from 10 days ago (should survive).
    db.set('tokens:2026-03-25:alice', JSON.stringify({ input: 2, output: 2, requests: 2 }));
    // A malformed key that shouldn't be touched.
    db.set('tokens:nope', 'bad');

    // Triggers the cleanup.
    tracker.getUsage('alice');

    expect(db.get('tokens:2026-03-04:alice')).toBeUndefined();
    expect(db.get('tokens:2026-03-25:alice')).toBeDefined();
    expect(db.get('tokens:nope')).toBe('bad');

    // Running again same day is a no-op — bump the clock to next day to force another pass.
    clock.now = new Date('2026-04-05T12:00:00Z');
    db.set('tokens:2026-03-05:alice', JSON.stringify({ input: 1, output: 1, requests: 1 }));
    tracker.getUsage('alice');
    expect(db.get('tokens:2026-03-05:alice')).toBeUndefined();
  });

  it('treats a corrupt row as zero usage', () => {
    const { tracker, db } = makeTracker();
    db.set('tokens:2026-04-04:alice', '{not json');
    expect(tracker.getUsage('alice')).toEqual({ input: 0, output: 0, requests: 0 });
  });

  it('treats non-numeric fields as zero', () => {
    const { tracker, db } = makeTracker();
    db.set(
      'tokens:2026-04-04:alice',
      JSON.stringify({ input: 'x', output: null, requests: undefined }),
    );
    expect(tracker.getUsage('alice')).toEqual({ input: 0, output: 0, requests: 0 });
  });

  it('global record is keyed under __global__', () => {
    const { tracker, db } = makeTracker();
    tracker.recordUsage('alice', { input: 5, output: 5 });
    expect(db.get(`tokens:2026-04-04:${GLOBAL_KEY}`)).toBeDefined();
  });

  it('setConfig updates limits', () => {
    const { tracker } = makeTracker({ perUserDaily: 100, globalDaily: 1000 });
    tracker.recordUsage('alice', { input: 50, output: 50 });
    expect(tracker.canSpend('alice', 1)).toBe(false);
    tracker.setConfig({ perUserDaily: 10_000, globalDaily: 10_000 });
    expect(tracker.canSpend('alice', 1)).toBe(true);
  });
});
