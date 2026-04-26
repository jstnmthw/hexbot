// rss — circuit-breaker state machine
//
// The breaker exists so a chronically failing feed (DNS gone, 500ing
// forever) does not pile its poll calls onto the network or spam the
// operator with a warn every minute. The behaviors that matter:
//   - opens only after THRESHOLD consecutive failures
//   - backoff doubles per failure past the threshold, capped at MAX
//   - operator is warned exactly once per breaker cycle (not per failure)
//   - a successful poll resets every counter and re-arms the warn
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../plugins/rss/circuit-breaker';
import type { PluginAPI } from '../../src/types';

const THRESHOLD = 5;
const BASE_MS = 60_000;
const MAX_MS = 3_600_000;

function makeApi(): { api: PluginAPI; warns: string[] } {
  const warns: string[] = [];
  const api = {
    warn: (msg: string) => warns.push(msg),
  } as unknown as PluginAPI;
  return { api, warns };
}

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts closed for any feed', () => {
    expect(cb.isOpen('feed-a', 0)).toBe(false);
    expect(cb.isOpen('never-seen', 999)).toBe(false);
  });

  it('does not open before THRESHOLD consecutive failures', () => {
    const { api, warns } = makeApi();
    for (let i = 0; i < THRESHOLD - 1; i++) cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', Date.now())).toBe(false);
    expect(warns).toEqual([]);
  });

  it('opens at exactly THRESHOLD failures and warns once', () => {
    const { api, warns } = makeApi();
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', Date.now() + 1)).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"feed"');
    expect(warns[0]).toContain(`${THRESHOLD} times`);
  });

  it('does not re-warn on subsequent failures within the same broken cycle', () => {
    const { api, warns } = makeApi();
    for (let i = 0; i < THRESHOLD + 5; i++) cb.recordFailure(api, 'feed');
    // Exactly one warn for the entire run, no matter how many failures
    // pile on. Otherwise a feed stuck at error spams once per poll tick.
    expect(warns).toHaveLength(1);
  });

  it('doubles backoff per failure past the threshold', () => {
    const { api } = makeApi();
    // First over-threshold failure -> BASE_MS * 2^0 = BASE_MS
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', BASE_MS - 1)).toBe(true);
    expect(cb.isOpen('feed', BASE_MS + 1)).toBe(false);

    // Next failure -> BASE_MS * 2 = 2 * BASE_MS
    cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', BASE_MS * 2 - 1)).toBe(true);
    expect(cb.isOpen('feed', BASE_MS * 2 + 1)).toBe(false);

    // Two more failures -> BASE_MS * 8
    cb.recordFailure(api, 'feed');
    cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', BASE_MS * 8 - 1)).toBe(true);
  });

  it('caps backoff at MAX_MS', () => {
    const { api } = makeApi();
    // Push way past saturation: 5 (threshold) + 100 over.
    for (let i = 0; i < THRESHOLD + 100; i++) cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', MAX_MS - 1)).toBe(true);
    expect(cb.isOpen('feed', MAX_MS + 1)).toBe(false);
  });

  it('recordSuccess clears failure counter, backoff, and notification latch', () => {
    const { api, warns } = makeApi();
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'feed');
    expect(cb.isOpen('feed', Date.now() + 1)).toBe(true);

    cb.recordSuccess('feed');
    expect(cb.isOpen('feed', Date.now() + BASE_MS)).toBe(false);

    // Re-arm: failures must reach the threshold again before opening,
    // and the warn fires again when it does.
    for (let i = 0; i < THRESHOLD - 1; i++) cb.recordFailure(api, 'feed');
    expect(warns).toHaveLength(1); // still the original one
    cb.recordFailure(api, 'feed');
    expect(warns).toHaveLength(2);
  });

  it('tracks per-feed state independently', () => {
    const { api, warns } = makeApi();
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'feed-a');
    cb.recordFailure(api, 'feed-b');

    expect(cb.isOpen('feed-a', Date.now() + 1)).toBe(true);
    expect(cb.isOpen('feed-b', Date.now() + 1)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('feed-a');
  });

  it('reset() clears every feed', () => {
    const { api } = makeApi();
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'a');
    for (let i = 0; i < THRESHOLD; i++) cb.recordFailure(api, 'b');

    cb.reset();

    expect(cb.isOpen('a', Date.now() + 1)).toBe(false);
    expect(cb.isOpen('b', Date.now() + 1)).toBe(false);
  });
});
