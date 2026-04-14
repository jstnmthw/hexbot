// Covers audit finding W-DCC4: the `maxEntries` hard cap with
// oldest-by-`firstFailure` eviction.
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
