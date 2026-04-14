// HexBot — sliding window rate limiter used by the bot link hub.
//
// Sits in its own file so `protocol.ts` can stay framing-only. The hub is
// currently the only caller (per-leaf CMD / PARTY_CHAT / PROTECT_* limits)
// but the class is general enough to be reused elsewhere if a future leaf
// concern ever needs throttling.

export class RateCounter {
  private timestamps: number[] = [];
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if the action is allowed (under the rate limit). */
  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}
