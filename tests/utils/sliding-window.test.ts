import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlidingWindowCounter } from '../../src/utils/sliding-window';

describe('SlidingWindowCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows events below the limit', () => {
    const counter = new SlidingWindowCounter();
    expect(counter.check('key', 1000, 3)).toBe(false);
    expect(counter.check('key', 1000, 3)).toBe(false);
    expect(counter.check('key', 1000, 3)).toBe(false);
  });

  it('returns true when the limit is exceeded', () => {
    const counter = new SlidingWindowCounter();
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);
    expect(counter.check('key', 1000, 2)).toBe(true); // 3rd event > limit 2
  });

  it('prunes timestamps outside the window', () => {
    const counter = new SlidingWindowCounter();
    // Fill the window with 3 events
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);

    // Advance past the window — old timestamps are pruned
    vi.advanceTimersByTime(1001);

    // New event should not trigger — previous events are gone
    expect(counter.check('key', 1000, 2)).toBe(false);
  });

  it('tracks separate keys independently', () => {
    const counter = new SlidingWindowCounter();
    counter.check('a', 1000, 1);
    counter.check('a', 1000, 1); // 'a' exceeds limit

    // 'b' should be unaffected
    expect(counter.check('b', 1000, 1)).toBe(false);
  });

  it('clear() removes history for a specific key', () => {
    const counter = new SlidingWindowCounter();
    counter.check('key', 1000, 1);
    counter.check('key', 1000, 1);
    counter.clear('key');
    // After clear, first event should not trigger
    expect(counter.check('key', 1000, 1)).toBe(false);
  });

  it('reset() removes all key history', () => {
    const counter = new SlidingWindowCounter();
    // Exceed limit for both keys
    counter.check('a', 1000, 1);
    counter.check('a', 1000, 1); // 2nd event exceeds limit=1
    counter.check('b', 1000, 1);
    counter.check('b', 1000, 1);
    counter.reset();
    // After reset, first event for each key is below limit
    expect(counter.check('a', 1000, 1)).toBe(false);
    expect(counter.check('b', 1000, 1)).toBe(false);
  });

  it('handles a limit of 0 — every event exceeds', () => {
    const counter = new SlidingWindowCounter();
    expect(counter.check('key', 1000, 0)).toBe(true);
  });

  describe('sweep()', () => {
    it('removes keys whose timestamps have all expired', () => {
      const counter = new SlidingWindowCounter();
      counter.check('stale', 1000, 10);
      counter.check('fresh', 1000, 10);

      vi.advanceTimersByTime(1001);

      // Add a fresh event for 'fresh' so it survives the sweep
      counter.check('fresh', 1000, 10);

      counter.sweep(1000);
      expect(counter.size).toBe(1); // only 'fresh' remains
    });

    it('removes keys with empty timestamp arrays', () => {
      const counter = new SlidingWindowCounter();
      counter.check('a', 1000, 10);
      counter.clear('a');
      // clear() deletes the key, so nothing to sweep — but check sweep handles it
      counter.check('b', 500, 10);
      vi.advanceTimersByTime(501);
      counter.sweep(500);
      expect(counter.size).toBe(0);
    });

    it('preserves keys with active timestamps', () => {
      const counter = new SlidingWindowCounter();
      counter.check('a', 1000, 10);
      counter.check('b', 1000, 10);
      counter.sweep(1000);
      expect(counter.size).toBe(2);
    });
  });

  describe('size', () => {
    it('reflects the number of tracked keys', () => {
      const counter = new SlidingWindowCounter();
      expect(counter.size).toBe(0);
      counter.check('a', 1000, 10);
      expect(counter.size).toBe(1);
      counter.check('b', 1000, 10);
      expect(counter.size).toBe(2);
      counter.clear('a');
      expect(counter.size).toBe(1);
    });
  });
});
