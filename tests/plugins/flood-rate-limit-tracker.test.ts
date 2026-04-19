import { describe, expect, it } from 'vitest';

import { RateLimitTracker, type RateLimitWindows } from '../../plugins/flood/rate-limit-tracker';
import { SlidingWindowCounter } from '../../src/utils/sliding-window';

const WINDOWS: RateLimitWindows = {
  msgThreshold: 2,
  msgWindowMs: 10_000,
  joinThreshold: 2,
  joinWindowMs: 10_000,
  partThreshold: 2,
  partWindowMs: 10_000,
  nickThreshold: 2,
  nickWindowMs: 10_000,
};

describe('RateLimitTracker initialCounters seed', () => {
  it('uses a pre-built counter when one is provided per kind', () => {
    const now = Date.now();
    const msgSeed = new SlidingWindowCounter([['alice', [now - 1_000, now - 500]]]);
    const tracker = new RateLimitTracker(WINDOWS, () => new SlidingWindowCounter(), {
      msg: msgSeed,
    });
    // msg counter starts pre-loaded at 2; next check pushes it over the
    // threshold of 2 (3 > 2).
    expect(tracker.check('msg', 'alice')).toBe(true);
    // join counter is default/empty — below threshold on first hit.
    expect(tracker.check('join', 'alice')).toBe(false);
  });
});
