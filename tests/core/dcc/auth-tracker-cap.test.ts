// Covers two behaviors of DCCAuthTracker:
//  - `maxEntries` hard cap with oldest-by-`firstFailure` eviction.
//  - banCount decay on success + cap at BAN_COUNT_MAX so legitimate users
//    who occasionally typo don't accumulate a permanently escalating
//    lockout.
import { describe, expect, it } from 'vitest';

import { DCCAuthTracker } from '../../../src/core/dcc/auth-tracker';

describe('DCCAuthTracker maxEntries (W-DCC4)', () => {
  it('evicts the oldest-firstFailure entry when the cap would be exceeded', () => {
    const tracker = new DCCAuthTracker({ maxEntries: 3, maxFailures: 999 });

    tracker.recordFailure('alice', 1000);
    tracker.recordFailure('bob', 2000);
    tracker.recordFailure('carol', 3000);

    // At cap. Adding a fresh key evicts the oldest (alice).
    tracker.recordFailure('dave', 4000);

    // Alice is gone — a new `check` treats her as unknown.
    expect(tracker.check('alice', 4500).failures).toBe(0);
    // The others survive.
    expect(tracker.check('bob', 4500).failures).toBeGreaterThan(0);
    expect(tracker.check('carol', 4500).failures).toBeGreaterThan(0);
    expect(tracker.check('dave', 4500).failures).toBeGreaterThan(0);
  });

  it('subsequent failures for an existing key do not trigger eviction', () => {
    const tracker = new DCCAuthTracker({ maxEntries: 2, maxFailures: 999 });

    tracker.recordFailure('alice', 1000);
    tracker.recordFailure('bob', 2000);
    // Hitting alice again must not kick bob out — we only evict on new-key insert.
    tracker.recordFailure('alice', 2500);

    expect(tracker.check('alice', 3000).failures).toBe(2);
    expect(tracker.check('bob', 3000).failures).toBe(1);
  });

  it('uses the default maxEntries=10_000 when not specified', () => {
    const tracker = new DCCAuthTracker();
    expect(tracker.maxEntries).toBe(10_000);
  });
});

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

  it('caps banCount escalation so the lockout duration does not run away', () => {
    // With maxFailures=1 every failure escalates, but after BAN_COUNT_MAX=8
    // the lock duration plateaus at base * 2^8 = 256_000 ms.
    const tracker = new DCCAuthTracker({ maxFailures: 1, baseLockMs: 1000 });
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      tracker.recordFailure('mallory', t);
      t += 500; // stay inside the 1h decay window so banCount keeps climbing
    }
    const status = tracker.check('mallory', t);
    const duration = status.lockedUntil - t;
    expect(duration).toBeLessThanOrEqual(256_000);
  });
});
