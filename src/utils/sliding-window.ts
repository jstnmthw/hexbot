/**
 * A true sliding-window event counter.
 * Tracks individual event timestamps and prunes entries older than the window.
 */
export class SlidingWindowCounter {
  private windows = new Map<string, number[]>();

  /**
   * Record one event for `key` and return true if the total count in the last
   * `windowMs` milliseconds (including this event) exceeds `limit`.
   */
  check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);
    const timestamps = existing ? existing.filter((t) => now - t < windowMs) : [];
    timestamps.push(now);
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
