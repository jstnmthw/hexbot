/**
 * A true sliding-window event counter.
 * Tracks individual event timestamps and prunes entries older than the window.
 *
 * Internal cap on tracked keys: when `check()` is about to insert a new key
 * past {@link MAX_KEYS}, the counter first runs an opportunistic sweep of
 * entries whose most recent timestamp is older than `windowMs`. Without
 * this, an attacker rotating hostmasks could accumulate entries
 * indefinitely since nothing else guarantees `sweep()` is ever called.
 */
const MAX_KEYS = 8192;

export class SlidingWindowCounter {
  private windows = new Map<string, number[]>();

  /**
   * @param initialWindows Optional seed map of `key → timestamps[]`. Copies
   *   each timestamp list so caller arrays stay immutable while the internal
   *   arrays remain mutable (the check/sweep paths rewrite them in place).
   *   Unblocks tests that need a counter pre-loaded to "just under threshold"
   *   without replaying N `check()` calls.
   */
  constructor(initialWindows?: Iterable<readonly [string, readonly number[]]>) {
    if (initialWindows) {
      this.windows = new Map(Array.from(initialWindows, ([k, v]) => [k, [...v]]));
    }
  }

  /**
   * Record one event for `key` and return true if the total count in the last
   * `windowMs` milliseconds (including this event) exceeds `limit`.
   */
  check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);
    const timestamps = existing ? existing.filter((t) => now - t < windowMs) : [];
    timestamps.push(now);
    /* v8 ignore start -- emergency cap path requires 8192+ distinct keys; exercised only under attacker-rotation workload */
    if (!existing && this.windows.size >= MAX_KEYS) {
      // Emergency sweep: drop anything whose latest timestamp is outside
      // the window. If the map is still at the cap we fall back to FIFO
      // eviction of the oldest insertion-order entry so legitimate
      // recent traffic always has room to land.
      for (const [k, ts] of this.windows) {
        if (ts.length === 0 || now - ts[ts.length - 1] >= windowMs) {
          this.windows.delete(k);
        }
      }
      if (this.windows.size >= MAX_KEYS) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) this.windows.delete(oldestKey);
      }
    }
    /* v8 ignore stop */
    this.windows.set(key, timestamps);
    return timestamps.length > limit;
  }

  /**
   * Check without recording. Opportunistically evicts the key if every
   * timestamp has fallen outside the window — lets callers that only read
   * keep the map bounded without scheduling a sweep.
   */
  peek(key: string, windowMs: number): number {
    const existing = this.windows.get(key);
    if (!existing) return 0;
    const now = Date.now();
    const live = existing.filter((t) => now - t < windowMs);
    if (live.length === 0) {
      this.windows.delete(key);
      return 0;
    }
    if (live.length !== existing.length) this.windows.set(key, live);
    return live.length;
  }

  /** Remove all timestamp history for a specific key. */
  clear(key: string): void {
    this.windows.delete(key);
  }

  /** Remove all timestamp history for all keys. */
  reset(): void {
    this.windows.clear();
  }

  /** Remove keys whose timestamps have all expired outside `windowMs`. */
  sweep(windowMs: number): void {
    const now = Date.now();
    for (const [key, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps.every((t) => now - t >= windowMs)) {
        this.windows.delete(key);
      }
    }
  }

  /** Number of tracked keys (for observability). */
  get size(): number {
    return this.windows.size;
  }
}
