// HexBot — Bot Link pending-request helper
//
// Shared implementation of the "send a ref-keyed request, await a reply,
// time out after N ms" pattern used by both botlink-hub and botlink-leaf
// for CMD, PARTY_WHOM, and protection-request round trips. Centralising
// the bookkeeping removes three parallel Map declarations per side and
// makes shutdown drain paths impossible to forget.

interface PendingEntry<T> {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: T) => void;
}

/**
 * Hard cap on the number of concurrent pending relay requests. Under
 * sustained botlink load with a laggy hub, entries can accumulate
 * faster than their individual timeouts reclaim them. Above the cap,
 * `create()` rejects immediately with the timeout value so callers see
 * a predictable degradation instead of an unbounded memory footprint.
 * See stability audit 2026-04-14.
 */
const DEFAULT_MAX_PENDING = 4096;

export class PendingRequestMap<T> {
  private map = new Map<string, PendingEntry<T>>();
  private readonly maxPending: number;
  private droppedAtCap = 0;

  constructor(maxPending: number = DEFAULT_MAX_PENDING) {
    this.maxPending = maxPending;
  }

  /**
   * Register a pending request keyed by `ref` and return a promise that
   * resolves either via `resolve(ref, value)` or after `timeoutMs` with the
   * caller-supplied `timeoutValue`.
   *
   * Rejects at cap with the timeout value so callers see the same
   * "this relay failed, move on" signal as a real network timeout.
   */
  create(ref: string, timeoutMs: number, timeoutValue: T): Promise<T> {
    // Guard against unbounded growth when the remote peer stops
    // responding and every caller still schedules a new entry. After
    // the cap, resolve immediately — callers treat it the same as a
    // natural timeout. See stability audit 2026-04-14.
    if (this.map.size >= this.maxPending) {
      this.droppedAtCap++;
      return Promise.resolve(timeoutValue);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(timeoutValue);
    }
    return new Promise<T>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.map.delete(ref);
        resolvePromise(timeoutValue);
      }, timeoutMs);
      this.map.set(ref, { timer, resolve: resolvePromise });
    });
  }

  /** Count of `create()` calls that hit the cap since startup. */
  get droppedCount(): number {
    return this.droppedAtCap;
  }

  /**
   * Resolve the pending entry for `ref`, clearing its timeout. No-op when
   * the entry has already been resolved or timed out — callers don't need
   * to guard.
   */
  resolve(ref: string, value: T): boolean {
    const entry = this.map.get(ref);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.map.delete(ref);
    entry.resolve(value);
    return true;
  }

  /**
   * Resolve every outstanding entry with a shared fallback value, clearing
   * their timers. Used during disconnect/shutdown drain so awaiting callers
   * don't hang.
   */
  drain(fallback: T): void {
    for (const entry of this.map.values()) {
      clearTimeout(entry.timer);
      entry.resolve(fallback);
    }
    this.map.clear();
  }

  /* v8 ignore next 3 -- observability helper, not exercised in tests */
  get size(): number {
    return this.map.size;
  }
}
