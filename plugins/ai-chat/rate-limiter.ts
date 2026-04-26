// Layered rate limiter for the AI chat plugin.
// Combines a per-user token bucket with sliding-window RPM/RPD limits, plus
// RPM backpressure that halves a user's effective burst when global RPM usage
// is near capacity. Mirrors the integer token-bucket pattern used by
// `src/core/message-queue.ts` for outgoing IRC flood protection.

/** Limits for the rate limiter — all optional; defaults come from the caller. */
export interface RateLimiterConfig {
  /** Per-user burst capacity (tokens). 0 disables the per-user bucket. */
  userBurst: number;
  /** Per-user refill interval in seconds — one token earned per interval. */
  userRefillSeconds: number;
  /** Global requests per minute (rolling 60s window). */
  globalRpm: number;
  /** Global requests per day (rolling 24h window). */
  globalRpd: number;
  /**
   * When global RPM usage exceeds this percentage of `globalRpm`, each user's
   * effective burst is halved (min 1) to prevent burst storms from many users
   * simultaneously. 0 disables backpressure.
   */
  rpmBackpressurePct: number;
  /** Ambient messages allowed per channel per hour (rolling 1h window). */
  ambientPerChannelPerHour?: number;
  /** Ambient messages allowed globally per hour (rolling 1h window). */
  ambientGlobalPerHour?: number;
}

/** Result of a rate-limit check. */
export interface RateCheckResult {
  allowed: boolean;
  /** When blocked: milliseconds until the caller may retry. */
  retryAfterMs?: number;
  /** When blocked: which layer blocked the request. */
  limitedBy?: 'user' | 'rpm' | 'rpd';
}

export interface UserBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Optional per-field seed for RateLimiter state. Every field is optional so
 * tests can pre-load a specific window/bucket without replaying N `record()`
 * calls; each list is copied defensively to keep the caller's input immutable.
 */
export interface RateLimiterInitialState {
  userBuckets?: Iterable<readonly [string, UserBucket]>;
  minuteWindow?: readonly number[];
  dayWindow?: readonly number[];
  ambientChannelWindows?: Iterable<readonly [string, readonly number[]]>;
  ambientGlobalWindow?: readonly number[];
}

// A bucket that has been at full capacity longer than this is indistinguishable
// from a freshly created one — safe to evict so nick-rotation doesn't grow
// `userBuckets` without bound.
const STALE_BUCKET_IDLE_MS = 3_600_000;

// Floor on map size before opportunistic eviction runs — prevents thrashing
// in small deployments where the natural cardinality stays well below this.
const EVICTION_MIN_BUCKETS = 64;

/**
 * Hard cap on tracked ambient channels. Mirrors `ContextManager.MAX_CHANNELS`
 * and `SocialTracker.MAX_CHANNELS` so the per-channel ai-chat maps scale
 * together. Each window is at most ambientPerChannelPerHour entries
 * (default 5), so the worst-case footprint is ~256 × 5 timestamps.
 * On overflow the LRU channel is dropped — its window is either already
 * expired or stale by definition.
 */
const MAX_AMBIENT_CHANNELS = 256;

/** Layered rate limiter: per-user token bucket + RPM + RPD + ambient budgets. All state is in-memory. */
export class RateLimiter {
  private userBuckets = new Map<string, UserBucket>();
  private minuteWindow: number[] = [];
  private dayWindow: number[] = [];
  private ambientChannelWindows = new Map<string, number[]>();
  private ambientGlobalWindow: number[] = [];

  constructor(
    private config: RateLimiterConfig,
    initialState?: RateLimiterInitialState,
  ) {
    if (initialState?.userBuckets) this.userBuckets = new Map(initialState.userBuckets);
    if (initialState?.minuteWindow) this.minuteWindow = [...initialState.minuteWindow];
    if (initialState?.dayWindow) this.dayWindow = [...initialState.dayWindow];
    if (initialState?.ambientChannelWindows) {
      this.ambientChannelWindows = new Map(
        Array.from(initialState.ambientChannelWindows, ([k, v]) => [k, [...v]]),
      );
    }
    if (initialState?.ambientGlobalWindow) {
      this.ambientGlobalWindow = [...initialState.ambientGlobalWindow];
    }
  }

  /** Update the active limits (hot-reload). */
  setConfig(config: RateLimiterConfig): void {
    this.config = config;
  }

  /**
   * Check whether a call from `userKey` is allowed right now.
   * Returns a result describing why it was blocked, if so.
   *
   * NOTE: This does NOT record a successful call — the caller must invoke
   * `record()` after a request is actually dispatched. This lets callers
   * bail out (e.g. on permission failure) without burning rate budget.
   */
  check(userKey: string, now = Date.now()): RateCheckResult {
    // Prune windows to the active interval.
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
    this.dayWindow = this.dayWindow.filter((t) => now - t < 86_400_000);

    if (this.config.globalRpd > 0 && this.dayWindow.length >= this.config.globalRpd) {
      const oldest = this.dayWindow[0];
      return { allowed: false, limitedBy: 'rpd', retryAfterMs: 86_400_000 - (now - oldest) };
    }

    if (this.config.globalRpm > 0 && this.minuteWindow.length >= this.config.globalRpm) {
      const oldest = this.minuteWindow[0];
      return { allowed: false, limitedBy: 'rpm', retryAfterMs: 60_000 - (now - oldest) };
    }

    if (this.config.userBurst <= 0) return { allowed: true };

    const effectiveBurst = this.effectiveBurst();
    const bucket = this.getOrCreateBucket(userKey, now);
    this.refillBucket(bucket, now);
    if (bucket.tokens > effectiveBurst) bucket.tokens = effectiveBurst;

    if (bucket.tokens < 1) {
      const refillMs = this.refillMs();
      const elapsed = now - bucket.lastRefill;
      const retryAfterMs = Math.max(1, refillMs - elapsed);
      return { allowed: false, limitedBy: 'user', retryAfterMs };
    }

    return { allowed: true };
  }

  /**
   * Check only the global RPM/RPD layers, ignoring the per-user bucket.
   * Used during game sessions where the same user is expected to send rapid turns.
   */
  checkGlobal(now = Date.now()): RateCheckResult {
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
    this.dayWindow = this.dayWindow.filter((t) => now - t < 86_400_000);

    if (this.config.globalRpd > 0 && this.dayWindow.length >= this.config.globalRpd) {
      const oldest = this.dayWindow[0];
      return { allowed: false, limitedBy: 'rpd', retryAfterMs: 86_400_000 - (now - oldest) };
    }
    if (this.config.globalRpm > 0 && this.minuteWindow.length >= this.config.globalRpm) {
      const oldest = this.minuteWindow[0];
      return { allowed: false, limitedBy: 'rpm', retryAfterMs: 60_000 - (now - oldest) };
    }
    return { allowed: true };
  }

  /** Record a call — should be invoked exactly once per dispatched request. */
  record(userKey: string, now = Date.now()): void {
    if (this.config.userBurst > 0) {
      const bucket = this.getOrCreateBucket(userKey, now);
      this.refillBucket(bucket, now);
      const effectiveBurst = this.effectiveBurst();
      if (bucket.tokens > effectiveBurst) bucket.tokens = effectiveBurst;
      bucket.tokens -= 1;
    }
    this.minuteWindow.push(now);
    this.dayWindow.push(now);
  }

  /**
   * Check whether an ambient message is allowed for this channel.
   * Ambient messages have their own budget separate from user-initiated requests.
   *
   * INVARIANT: ambient budget is independent of `check()` — ambient callers
   * must gate on BOTH this and the global RPM/RPD bucket (via `checkGlobal()`
   * or `check()`) before dispatching. `rolled` pipeline replies also count
   * here, matching ambient's "unprompted utterance" accounting class.
   */
  checkAmbient(channelKey: string, now = Date.now()): boolean {
    const perCh = this.config.ambientPerChannelPerHour ?? 5;
    const global = this.config.ambientGlobalPerHour ?? 20;
    const hour = 3_600_000;

    // Prune global ambient window
    this.ambientGlobalWindow = this.ambientGlobalWindow.filter((t) => now - t < hour);
    if (global > 0 && this.ambientGlobalWindow.length >= global) return false;

    // Prune per-channel ambient window
    const chKey = channelKey.toLowerCase();
    let chWindow = this.ambientChannelWindows.get(chKey);
    if (chWindow) {
      chWindow = chWindow.filter((t) => now - t < hour);
      this.ambientChannelWindows.set(chKey, chWindow);
    }
    if (perCh > 0 && chWindow && chWindow.length >= perCh) return false;

    return true;
  }

  /** Record an ambient message for budget tracking. */
  recordAmbient(channelKey: string, now = Date.now()): void {
    const chKey = channelKey.toLowerCase();
    let chWindow = this.ambientChannelWindows.get(chKey);
    if (!chWindow) {
      // LRU eject when the cap is hit. Map iteration is insertion order,
      // so the first key is the coldest write site. Active channels are
      // promoted via `delete + set` on every record; cold ones drift to
      // the head and get pushed out.
      if (this.ambientChannelWindows.size >= MAX_AMBIENT_CHANNELS) {
        const oldest = this.ambientChannelWindows.keys().next().value;
        if (oldest !== undefined) this.ambientChannelWindows.delete(oldest);
      }
      chWindow = [];
      this.ambientChannelWindows.set(chKey, chWindow);
    } else {
      this.ambientChannelWindows.delete(chKey);
      this.ambientChannelWindows.set(chKey, chWindow);
    }
    chWindow.push(now);
    this.ambientGlobalWindow.push(now);
  }

  /** Erase all state (tests, plugin reload). */
  reset(): void {
    this.userBuckets.clear();
    this.minuteWindow = [];
    this.dayWindow = [];
    this.ambientChannelWindows.clear();
    this.ambientGlobalWindow = [];
  }

  /**
   * Drop a single user's bucket. Wire to user QUIT so a nick that leaves
   * the network releases its bucket immediately instead of waiting for the
   * idle-bucket eviction. No-op if the user has never spoken.
   */
  forgetUser(userKey: string): void {
    this.userBuckets.delete(userKey.toLowerCase());
  }

  // -------------------------------------------------------------------------
  // Internal — token-bucket bookkeeping
  // -------------------------------------------------------------------------

  private refillMs(): number {
    return Math.max(1, this.config.userRefillSeconds * 1000);
  }

  /**
   * Effective burst for the current RPM-pressure level. When usage crosses
   * `rpmBackpressurePct`, halve the burst (min 1) to throttle bursty users
   * before the global RPM cap blocks everyone uniformly.
   */
  private effectiveBurst(): number {
    const burst = this.config.userBurst;
    const threshold = this.config.rpmBackpressurePct;
    if (burst <= 1 || threshold <= 0 || this.config.globalRpm <= 0) return burst;
    const rpmPct = (this.minuteWindow.length / this.config.globalRpm) * 100;
    if (rpmPct > threshold) return Math.max(1, Math.floor(burst / 2));
    return burst;
  }

  private getOrCreateBucket(userKey: string, now: number): UserBucket {
    // Defence-in-depth: normalise the key here so a future caller that forgets
    // to lowercase doesn't silently split one user's bucket across casings.
    const key = userKey.toLowerCase();
    let bucket = this.userBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.userBurst, lastRefill: now };
      this.userBuckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Refill earned tokens, capped at `userBurst`. Advances `lastRefill` by
   * `newTokens * refillMs` rather than to `now` to avoid drift — the same
   * integer-arithmetic pattern used by `MessageQueue` for IRC flood control.
   */
  private refillBucket(bucket: UserBucket, now: number): void {
    const refillMs = this.refillMs();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    const earned = Math.floor(elapsed / refillMs);
    if (earned <= 0) return;
    bucket.tokens = Math.min(this.config.userBurst, bucket.tokens + earned);
    bucket.lastRefill += earned * refillMs;
    // Opportunistic eviction: only when the map is large AND this bucket has
    // been idle past STALE_BUCKET_IDLE_MS AND is at full capacity. The size
    // floor prevents thrashing in small deployments; the idle+full check
    // ensures we only evict buckets that look indistinguishable from fresh.
    if (
      bucket.tokens >= this.config.userBurst &&
      now - bucket.lastRefill > STALE_BUCKET_IDLE_MS &&
      this.userBuckets.size > EVICTION_MIN_BUCKETS
    ) {
      this.evictStaleBuckets(now);
    }
  }

  private evictStaleBuckets(now: number): void {
    const cutoff = now - STALE_BUCKET_IDLE_MS;
    for (const [key, b] of this.userBuckets) {
      if (b.lastRefill < cutoff && b.tokens >= this.config.userBurst) {
        this.userBuckets.delete(key);
      }
    }
  }
}
