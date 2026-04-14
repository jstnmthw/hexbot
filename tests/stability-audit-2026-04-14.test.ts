// Behaviour tests for fixes landed from docs/audits/stability-all-2026-04-14.md.
// Grouped by subsystem rather than finding number so each describe block
// stays readable as the refactor evolves.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PendingRequestMap } from '../src/core/botlink/pending';
import { DCCAuthTracker } from '../src/core/dcc/auth-tracker';
import { Permissions } from '../src/core/permissions';
import { BotDatabase, DatabaseFullError } from '../src/database';
import { ListenerGroup } from '../src/utils/listener-group';
import { validateRequireAccFor } from '../src/utils/verify-flags';

// ---------------------------------------------------------------------------
// src/core/dcc/auth-tracker.ts — banCount decay on success
// ---------------------------------------------------------------------------

describe('DCCAuthTracker: banCount decays on success', () => {
  it('decrements banCount by one step when recordSuccess fires', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 2, baseLockMs: 1000 });
    // Two failures → ban with banCount=1
    tracker.recordFailure('alice', 1000);
    tracker.recordFailure('alice', 1100);
    // recordSuccess should halve the escalation
    tracker.recordSuccess('alice');
    // A fresh fail cycle should now hit the BASE lock, not 2× base.
    tracker.recordFailure('alice', 2_000_000); // far past any decay window
    tracker.recordFailure('alice', 2_000_100);
    const status = tracker.check('alice', 2_000_200);
    expect(status.locked).toBe(true);
    expect(status.lockedUntil - 2_000_100).toBe(1000);
  });

  it('caps banCount escalation so the duration does not run away', () => {
    // With maxFailures=1 every failure escalates, but after BAN_COUNT_MAX=8
    // the lock duration plateaus at base * 2^8.
    const tracker = new DCCAuthTracker({ maxFailures: 1, baseLockMs: 1000 });
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      tracker.recordFailure('mallory', t);
      t += 500; // stay inside the 1h decay window
    }
    const status = tracker.check('mallory', t);
    const duration = status.lockedUntil - t;
    // banCount cap is 8 → 1000 * 2^8 = 256000.
    expect(duration).toBeLessThanOrEqual(256_000);
  });
});

// ---------------------------------------------------------------------------
// src/core/botlink/pending.ts — pending-request cap
// ---------------------------------------------------------------------------

describe('PendingRequestMap: MAX_PENDING cap', () => {
  it('resolves with the fallback value when the cap is hit', async () => {
    const map = new PendingRequestMap<string>(3);
    // Fill the cap with long-timeout promises so they stay pending.
    const p1 = map.create('r1', 60_000, 'fallback');
    const p2 = map.create('r2', 60_000, 'fallback');
    const p3 = map.create('r3', 60_000, 'fallback');
    // The 4th immediately resolves with the fallback.
    const p4 = await map.create('r4', 60_000, 'fallback');
    expect(p4).toBe('fallback');
    expect(map.droppedCount).toBe(1);
    // Drain the others to keep vitest happy.
    map.drain('cleanup');
    await Promise.all([p1, p2, p3]);
  });
});

// ---------------------------------------------------------------------------
// src/utils/listener-group.ts — per-entry error containment in removeAll
// ---------------------------------------------------------------------------

describe('ListenerGroup: removeAll keeps going on per-entry errors', () => {
  it('removes every listener even if one off() throws', () => {
    const removedEvents: string[] = [];
    let firstRemoveCalled = false;
    const target = {
      on: (_ev: string, _fn: (...args: unknown[]) => void) => {},
      removeListener(ev: string, _fn: (...args: unknown[]) => void): void {
        if (!firstRemoveCalled) {
          firstRemoveCalled = true;
          throw new Error('boom');
        }
        removedEvents.push(ev);
      },
    };
    const group = new ListenerGroup(target);
    group.on('a', () => {});
    group.on('b', () => {});
    group.on('c', () => {});
    // Must not throw even though the first removeListener throws.
    expect(() => group.removeAll()).not.toThrow();
    // The two subsequent listeners still got removed.
    expect(removedEvents).toEqual(['b', 'c']);
    expect(group.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// src/utils/verify-flags.ts — unknown flag warning at config load
// ---------------------------------------------------------------------------

describe('validateRequireAccFor: warns on unknown flags', () => {
  it('filters unknown flags and logs a warning', () => {
    const warns: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warns.push(msg),
      debug: () => {},
      error: () => {},
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };
    // `+Q` is nonsense, `+o` is valid.
    const result = validateRequireAccFor(['+o', '+Q'], logger);
    expect(result).toEqual(['+o']);
    expect(warns.some((m) => m.includes('+Q'))).toBe(true);
  });

  it('passes recognised flags through unchanged', () => {
    const result = validateRequireAccFor(['+n', '+m', '+o', '+v'], null);
    expect(result).toEqual(['+n', '+m', '+o', '+v']);
  });
});

// ---------------------------------------------------------------------------
// src/database.ts — busy_timeout pragma + transaction helper
// ---------------------------------------------------------------------------

describe('BotDatabase: open() sets busy_timeout and exposes transaction()', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  it('exposes transaction() that commits on success', () => {
    db.transaction(() => {
      db.set('ns', 'k1', 'v1');
      db.set('ns', 'k2', 'v2');
    });
    expect(db.get('ns', 'k1')).toBe('v1');
    expect(db.get('ns', 'k2')).toBe('v2');
  });

  it('transaction() rolls back when the callback throws', () => {
    db.set('ns', 'seed', 'initial');
    expect(() =>
      db.transaction(() => {
        db.set('ns', 'seed', 'mutated');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(db.get('ns', 'seed')).toBe('initial');
  });

  it('short-circuits writes after setAuditFallback observes a prior disable', () => {
    // We can't easily simulate SQLITE_FULL in-memory, so instead exercise
    // the degrade branch by manually tripping writesDisabled via a
    // known-FULL error. The typed guard in the `set` path throws
    // DatabaseFullError when the flag is set.
    //
    // Access the internal flag via any-cast; keeping the test honest
    // about what it's exercising.
    const internal = db as unknown as { writesDisabled: boolean };
    internal.writesDisabled = true;
    expect(() => db.set('ns', 'k', 'v')).toThrow(DatabaseFullError);
    // Reads still work — the degrade path is deliberately asymmetric.
    expect(db.get('ns', 'k')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// src/core/permissions.ts — saveToDb uses per-record upsert in a transaction
// ---------------------------------------------------------------------------

describe('Permissions.saveToDb: transactional per-record upsert', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  it('does not delete rows whose key still exists in memory', () => {
    const perms = new Permissions(db, null);
    perms.addUser('alice', '*!alice@*', 'n', 'test');
    perms.addUser('bob', '*!bob@*', 'o', 'test');
    // Simulate a mutation that used to full-rewrite the namespace.
    perms.setGlobalFlags('alice', 'nm', 'test');
    // Both users still persisted.
    const rows = db.list('_permissions');
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['alice', 'bob']);
  });

  it('drops rows for removed users', () => {
    const perms = new Permissions(db, null);
    perms.addUser('alice', '*!alice@*', 'n', 'test');
    perms.addUser('bob', '*!bob@*', 'o', 'test');
    perms.removeUser('bob', 'test');
    const keys = db.list('_permissions').map((r) => r.key);
    expect(keys).toEqual(['alice']);
  });
});
