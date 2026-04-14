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
}

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

  constructor(
    options: {
      maxFailures?: number;
      windowMs?: number;
      baseLockMs?: number;
      maxLockMs?: number;
    } = {},
  ) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseLockMs = options.baseLockMs ?? 300_000;
    this.maxLockMs = options.maxLockMs ?? 86_400_000;
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
      tracker = { failures: 0, firstFailure: now, bannedUntil: 0, banCount: 0 };
      this.trackers.set(key, tracker);
    }
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
    if (tracker.failures >= this.maxFailures) {
      const lockDuration = Math.min(this.baseLockMs * 2 ** tracker.banCount, this.maxLockMs);
      tracker.bannedUntil = now + lockDuration;
      tracker.banCount++;
      tracker.failures = 0;
    }
    return {
      locked: tracker.bannedUntil > now,
      lockedUntil: tracker.bannedUntil,
      failures: tracker.failures,
    };
  }

  /** Record a successful attempt — zeroes the failure counter but preserves banCount. */
  recordSuccess(key: string): void {
    const tracker = this.trackers.get(key);
    if (tracker) {
      tracker.failures = 0;
    }
  }

  /** Prune expired trackers — called from DCCManager sweep. */
  sweep(now: number = Date.now()): void {
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
