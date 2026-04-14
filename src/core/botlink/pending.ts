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

export class PendingRequestMap<T> {
  private map = new Map<string, PendingEntry<T>>();

  /**
   * Register a pending request keyed by `ref` and return a promise that
   * resolves either via `resolve(ref, value)` or after `timeoutMs` with the
   * caller-supplied `timeoutValue`.
   */
  create(ref: string, timeoutMs: number, timeoutValue: T): Promise<T> {
    return new Promise<T>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.map.delete(ref);
        resolvePromise(timeoutValue);
      }, timeoutMs);
      this.map.set(ref, { timer, resolve: resolvePromise });
    });
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
