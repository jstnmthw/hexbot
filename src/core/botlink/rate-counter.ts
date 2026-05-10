// HexBot — sliding window rate limiter used by the bot link hub.
//
// Sits in its own file so `protocol.ts` can stay framing-only. The hub is
// currently the only caller (per-leaf CMD / PARTY_CHAT / PROTECT_* limits)
// but the class is general enough to be reused elsewhere if a future leaf
// concern ever needs throttling.

/**
 * Sliding-window counter capped at `limit` events per `windowMs`. State is
 * just an array of unix-ms timestamps; on every {@link check} call entries
 * older than `now - windowMs` are filtered out before the limit comparison,
 * so the window slides continuously rather than resetting on a fixed
 * boundary. The per-call O(n) filter is fine in practice — `n` is bounded
 * by `limit`, which is small (≤ 50 for any current caller).
 */
export class RateCounter {
  private timestamps: number[] = [];
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Test-and-record: returns true if the action is allowed (under the
   * rate limit) and atomically records the timestamp. Returning false
   * leaves state untouched, so a rejected event does not poison the
   * window for legitimate ones.
   */
  check(): boolean {
    const now = Date.now();
    // Drop timestamps that have fallen out of the trailing window.
    // Reassigns rather than mutating in place because `filter` returning
    // a fresh array avoids the splice-while-iterating footgun.
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  /** Drop all recorded timestamps. Used by tests; not called in production. */
  reset(): void {
    this.timestamps = [];
  }
}
