// Layered rate limiter for the AI chat plugin.
// Combines per-key cooldowns and sliding-window RPM/RPD limits.

/** Limits for the rate limiter — all optional; defaults come from the caller. */
export interface RateLimiterConfig {
  /** Per-user cooldown in seconds (one request per key per N seconds). */
  userCooldownSeconds: number;
  /** Per-channel cooldown in seconds. */
  channelCooldownSeconds: number;
  /** Global requests per minute (rolling 60s window). */
  globalRpm: number;
  /** Global requests per day (rolling 24h window). */
  globalRpd: number;
}

/** Result of a rate-limit check. */
export interface RateCheckResult {
  allowed: boolean;
  /** When blocked: milliseconds until the caller may retry. */
  retryAfterMs?: number;
  /** When blocked: which layer blocked the request. */
  limitedBy?: 'user' | 'channel' | 'rpm' | 'rpd';
}

/** Layered rate limiter: cooldowns + RPM + RPD. All state is in-memory. */
export class RateLimiter {
  private userLastCall = new Map<string, number>();
  private channelLastCall = new Map<string, number>();
  private minuteWindow: number[] = [];
  private dayWindow: number[] = [];

  constructor(private config: RateLimiterConfig) {}

  /** Update the active limits (hot-reload). */
  setConfig(config: RateLimiterConfig): void {
    this.config = config;
  }

  /**
   * Check whether a call from `userKey` in `channelKey` is allowed right now.
   * Returns a result describing why it was blocked, if so.
   *
   * NOTE: This does NOT record a successful call — the caller must invoke
   * `record()` after a request is actually dispatched. This lets callers
   * bail out (e.g. on permission failure) without burning rate budget.
   */
  check(userKey: string, channelKey: string | null, now = Date.now()): RateCheckResult {
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

    const userWindowMs = this.config.userCooldownSeconds * 1000;
    if (userWindowMs > 0) {
      const last = this.userLastCall.get(userKey);
      if (last !== undefined && now - last < userWindowMs) {
        return { allowed: false, limitedBy: 'user', retryAfterMs: userWindowMs - (now - last) };
      }
    }

    if (channelKey !== null) {
      const chWindowMs = this.config.channelCooldownSeconds * 1000;
      if (chWindowMs > 0) {
        const last = this.channelLastCall.get(channelKey);
        if (last !== undefined && now - last < chWindowMs) {
          return {
            allowed: false,
            limitedBy: 'channel',
            retryAfterMs: chWindowMs - (now - last),
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check only the global RPM/RPD layers, ignoring per-user and per-channel cooldowns.
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
  record(userKey: string, channelKey: string | null, now = Date.now()): void {
    this.userLastCall.set(userKey, now);
    if (channelKey !== null) this.channelLastCall.set(channelKey, now);
    this.minuteWindow.push(now);
    this.dayWindow.push(now);
  }

  /** Erase all state (tests, plugin reload). */
  reset(): void {
    this.userLastCall.clear();
    this.channelLastCall.clear();
    this.minuteWindow = [];
    this.dayWindow = [];
  }
}
