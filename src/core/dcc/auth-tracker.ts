// HexBot — DCC auth failure tracker
//
// Per-hostmask failure counter with exponential backoff. Mirrors the
// strategy in `BotLinkAuthManager` but against DCC keys. Used by
// `DCCManager` to short-circuit the password prompt path for abusive
// clients. The class owns no timers — the sweep is driven by the enclosing
// manager, matching how the botlink tracker is driven by its hub.

export interface DCCAuthLockStatus {
  locked: boolean;
  lockedUntil: number;
  failures: number;
}

interface TrackerEntry {
  failures: number;
  firstFailure: number;
  bannedUntil: number;
  banCount: number;
  /** Wall-clock ms of the most recent failure — drives `banCount` decay. */
  lastFailure: number;
}

/**
 * After this long without a failure, `banCount` halves on the next
 * read. A legitimate user who occasionally typos their password
 * should not end up with a permanently escalating lockout duration.
 */
const BAN_COUNT_DECAY_MS = 3_600_000; // 1 hour

/** Hard cap on `banCount` so the backoff doesn't blow past practical lockouts. */
const BAN_COUNT_MAX = 8;

export class DCCAuthTracker {
  private readonly trackers: Map<string, TrackerEntry> = new Map();

  /** Max failures per window before a lockout. */
  readonly maxFailures: number;
  /** Sliding window over which failures accumulate. */
  readonly windowMs: number;
  /** Base lockout duration. Doubles on each re-ban up to {@link maxLockMs}. */
  readonly baseLockMs: number;
  /** Upper bound on the exponential lockout duration. */
  readonly maxLockMs: number;
  /**
   * Hard cap on distinct tracker entries. A brute-force attacker cycling
   * identities can otherwise grow the map arbitrarily between 24h-based
   * sweeps. When {@link recordFailure} is about to insert a new entry
   * past this cap, the oldest-by-`firstFailure` entry is evicted.
   */
  readonly maxEntries: number;

  constructor(
    options: {
      maxFailures?: number;
      windowMs?: number;
      baseLockMs?: number;
      maxLockMs?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseLockMs = options.baseLockMs ?? 300_000;
    this.maxLockMs = options.maxLockMs ?? 86_400_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** Is this key currently locked out? */
  check(key: string, now: number = Date.now()): DCCAuthLockStatus {
    const tracker = this.trackers.get(key);
    if (!tracker) return { locked: false, lockedUntil: 0, failures: 0 };
    if (tracker.bannedUntil > now) {
      return { locked: true, lockedUntil: tracker.bannedUntil, failures: tracker.failures };
    }
    return { locked: false, lockedUntil: 0, failures: tracker.failures };
  }

  /** Record a failed attempt. May escalate to a lockout. */
  recordFailure(key: string, now: number = Date.now()): DCCAuthLockStatus {
    let tracker = this.trackers.get(key);
    if (!tracker) {
      // About to insert a new entry. If we'd exceed the hard cap, evict
      // the oldest-by-firstFailure entry first. Iterating to find the
      // oldest is O(n); acceptable because this only fires past 10k
      // distinct keys under brute-force conditions.
      if (this.trackers.size >= this.maxEntries) {
        let oldestKey: string | null = null;
        let oldestFirstFailure = Infinity;
        for (const [k, entry] of this.trackers) {
          if (entry.firstFailure < oldestFirstFailure) {
            oldestFirstFailure = entry.firstFailure;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) this.trackers.delete(oldestKey);
      }
      tracker = {
        failures: 0,
        firstFailure: now,
        bannedUntil: 0,
        banCount: 0,
        lastFailure: now,
      };
      this.trackers.set(key, tracker);
    }
    // Decay `banCount` before using it: halve once per hour since the
    // last failure. A legitimate operator who typos once every few
    // weeks should see the base lockout, not an escalating one.
    this.decayBanCount(tracker, now);
    // Sliding-window reset semantics: we only reset on *new* failures that
    // arrive after the window has elapsed, rather than sweeping windows on a
    // timer. The effect is that `failures` can sit stale at a non-zero value
    // between attacks, which is fine — `check()` reads `bannedUntil`, and
    // `sweep()` is what actually purges idle trackers. The counter is reset
    // to 0 (not 1) before incrementing so the returned `failures` field is
    // consistent with the count seen by `check()` afterwards.
    if (now - tracker.firstFailure > this.windowMs) {
      tracker.failures = 0;
      tracker.firstFailure = now;
    }
    tracker.failures++;
    tracker.lastFailure = now;
    if (tracker.failures >= this.maxFailures) {
      const lockDuration = Math.min(this.baseLockMs * 2 ** tracker.banCount, this.maxLockMs);
      tracker.bannedUntil = now + lockDuration;
      tracker.banCount = Math.min(tracker.banCount + 1, BAN_COUNT_MAX);
      tracker.failures = 0;
    }
    return {
      locked: tracker.bannedUntil > now,
      lockedUntil: tracker.bannedUntil,
      failures: tracker.failures,
    };
  }

  /**
   * Record a successful attempt — zeroes the failure counter and
   * decays `banCount` by one step. A legitimate user who finally
   * gets their password right shouldn't carry the escalation weight
   * of every previous typo indefinitely.
   */
  recordSuccess(key: string): void {
    const tracker = this.trackers.get(key);
    if (tracker) {
      tracker.failures = 0;
      if (tracker.banCount > 0) tracker.banCount--;
    }
  }

  /**
   * Halve `banCount` for each hour elapsed since the last failure.
   * Kept as a private helper so both recordFailure (which consults
   * banCount to compute the next lockout) and check() apply the
   * same decay curve.
   */
  private decayBanCount(tracker: TrackerEntry, now: number): void {
    if (tracker.banCount === 0) return;
    const elapsed = now - tracker.lastFailure;
    if (elapsed < BAN_COUNT_DECAY_MS) return;
    const halves = Math.floor(elapsed / BAN_COUNT_DECAY_MS);
    tracker.banCount = Math.max(0, tracker.banCount - halves);
  }

  /** Prune expired trackers — called from DCCManager sweep. */
  sweep(now: number = Date.now()): void {
    // Keep ban escalation state for 24h past expiry so a repeat offender
    // returning the next morning still lands on their escalated banCount
    // rather than starting fresh. Mirrors BotLinkAuthManager — the same
    // horizon applies to both DCC and botlink failure tracking.
    const STALE_MS = 86_400_000;
    for (const [key, tracker] of this.trackers) {
      const banExpired = tracker.bannedUntil < now;
      const failureWindowExpired = now - tracker.firstFailure > this.windowMs;
      if (banExpired && failureWindowExpired) {
        if (tracker.banCount === 0) {
          this.trackers.delete(key);
        } else if (now - tracker.bannedUntil > STALE_MS) {
          this.trackers.delete(key);
        }
      }
    }
  }
}
