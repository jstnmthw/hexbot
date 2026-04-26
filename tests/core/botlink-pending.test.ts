// Covers the botlink pending-relay growth fix: `PendingRequestMap`
// enforces a MAX_PENDING cap and resolves overflow calls with the
// caller-supplied fallback value.
import { describe, expect, it } from 'vitest';

import { PendingRequestMap } from '../../src/core/botlink/pending';

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
    // Drain the others so vitest doesn't see pending timers.
    map.drain('cleanup');
    await Promise.all([p1, p2, p3]);
  });
});
