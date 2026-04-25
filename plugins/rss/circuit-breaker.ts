// rss — per-feed circuit breaker for chronically failing feeds
//
// Tracks consecutive poll failures per feed id. Once a feed crosses the
// failure threshold, the next poll attempt is deferred until the backoff
// window elapses. The delay doubles on every subsequent failure, capped
// at CIRCUIT_BREAK_MAX_MS. The first break triggers a one-shot operator
// warn so a buried log line doesn't get missed; subsequent breaks stay
// quiet until recordPollSuccess clears the state. See stability audit
// 2026-04-14.
import type { PluginAPI } from '../../src/types';

/** Consecutive failures before the breaker opens. 5 absorbs short outages
 *  (DNS blip, single 500, brief connection refusal) without locking out a
 *  feed that's about to recover, while still tripping fast on a feed
 *  that's genuinely broken. */
const CIRCUIT_BREAK_THRESHOLD = 5;
/** Initial backoff once the breaker opens. 1 min is short enough that an
 *  operator-resolved outage clears quickly and long enough that a hard-down
 *  feed isn't retried tens of times per hour. */
const CIRCUIT_BREAK_BASE_MS = 60_000;
/** Backoff ceiling. After ~6 doublings (60s, 2m, 4m, 8m, 16m, 32m) we cap
 *  here — past 1h the noise reduction is moot and we may as well keep
 *  retrying hourly until the feed recovers or an operator removes it. */
const CIRCUIT_BREAK_MAX_MS = 3_600_000;

/**
 * Per-feed circuit breaker state, collected in one class so teardown
 * clears everything in a single `.reset()` call and the plugin body
 * isn't peppered with parallel Map declarations.
 */
export class CircuitBreaker {
  private readonly failureCount = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly brokenNotified = new Set<string>();

  /** True if the feed is in backoff at `now` and should be skipped this tick. */
  isOpen(feedId: string, now: number): boolean {
    const until = this.backoffUntil.get(feedId) ?? 0;
    return until > now;
  }

  /**
   * Record a failed poll. Once consecutive failures reach the threshold,
   * schedules exponential backoff and emits a one-shot operator warn.
   */
  recordFailure(api: PluginAPI, feedId: string): void {
    const count = (this.failureCount.get(feedId) ?? 0) + 1;
    this.failureCount.set(feedId, count);
    if (count >= CIRCUIT_BREAK_THRESHOLD) {
      // Exponential backoff doubling per failure past the threshold,
      // capped at CIRCUIT_BREAK_MAX_MS. `over` starts at 0 on the first
      // breaking failure so the very first backoff is exactly BASE_MS.
      const over = count - CIRCUIT_BREAK_THRESHOLD;
      const delay = Math.min(CIRCUIT_BREAK_BASE_MS * 2 ** over, CIRCUIT_BREAK_MAX_MS);
      this.backoffUntil.set(feedId, Date.now() + delay);
      if (!this.brokenNotified.has(feedId)) {
        this.brokenNotified.add(feedId);
        api.warn(
          `RSS feed "${feedId}" has failed ${count} times in a row — circuit broken, next retry in ${Math.round(delay / 1000)}s. Check the feed URL.`,
        );
      }
    }
  }

  /** Clear all failure state for a feed after a successful poll. */
  recordSuccess(feedId: string): void {
    this.failureCount.delete(feedId);
    this.backoffUntil.delete(feedId);
    this.brokenNotified.delete(feedId);
  }

  /**
   * Drop every scrap of state tied to a feed id. Semantically distinct
   * from {@link recordSuccess}: a forgotten feed isn't "succeeding", it's
   * gone — callers use this from `!rss remove` so an add/remove churn of
   * unique ids can't leave stale `failureCount`/`backoffUntil`/`brokenNotified`
   * entries that accumulate forever.
   */
  forget(feedId: string): void {
    this.failureCount.delete(feedId);
    this.backoffUntil.delete(feedId);
    this.brokenNotified.delete(feedId);
  }

  /** Reset every feed's state — called from plugin teardown. */
  reset(): void {
    this.failureCount.clear();
    this.backoffUntil.clear();
    this.brokenNotified.clear();
  }
}
