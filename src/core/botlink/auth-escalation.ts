// HexBot — Bot link auth escalation math
//
// Pure, side-effect-free helpers for the per-IP ban escalation policy.
// Owns the `AuthTracker` shape and the constants that define how bans
// grow and decay. Extracted from `auth.ts` so the escalation math can be
// unit-tested without standing up an auth manager, a DB, or a hub. See
// 2026-04-19 quality audit.

/**
 * Per-IP auth-failure state. The same shape is used by both the LRU
 * tracker (live offenders) and the manual-ban fast path (`bannedUntil`
 * set to a far-future timestamp for "permanent" manual bans).
 */
export interface AuthTracker {
  failures: number;
  firstFailure: number;
  bannedUntil: number;
  /** Number of times this IP has been banned — drives escalation doubling. */
  banCount: number;
  /** Wall-clock ms of the most recent failure — drives `banCount` decay. */
  lastFailure: number;
}

/**
 * `banCount` halves once per hour since the last failure. Without
 * decay, a shared-NAT IP that occasionally fumbles auth eventually
 * accumulates a permanently escalating ban duration even when the
 * underlying offenders have long since moved on.
 */
export const BAN_COUNT_DECAY_MS = 3_600_000; // 1 hour

/** Hard cap on `banCount` so the exponential doesn't run away. */
export const BAN_COUNT_MAX = 8;

/**
 * Decay `tracker.banCount` by one half-step per `BAN_COUNT_DECAY_MS`
 * elapsed since the last failure. Mutates the tracker in place and
 * returns the new `banCount`; callers that just want the math can
 * ignore the return value — a one-off typo on a shared NAT IP shouldn't
 * compound forever.
 */
export function applyBanCountDecay(tracker: AuthTracker, now: number): number {
  if (tracker.banCount > 0) {
    const elapsed = now - tracker.lastFailure;
    if (elapsed >= BAN_COUNT_DECAY_MS) {
      const halves = Math.floor(elapsed / BAN_COUNT_DECAY_MS);
      tracker.banCount = Math.max(0, tracker.banCount - halves);
    }
  }
  return tracker.banCount;
}

/**
 * Reset the rolling failure window if it has expired. Mutates the
 * tracker in place. `banCount` is intentionally never reset here — the
 * escalation tier only decays via `applyBanCountDecay`.
 */
export function rollFailureWindowIfExpired(
  tracker: AuthTracker,
  now: number,
  windowMs: number,
): void {
  if (now - tracker.firstFailure > windowMs) {
    tracker.failures = 0;
    tracker.firstFailure = now;
  }
}

/**
 * Compute the next ban duration for an IP at escalation tier
 * `banCount`. Each tier doubles the base duration, capped at
 * `maxBanMs` to prevent absolute-duration overflow for production
 * baseBanMs values.
 */
export function computeBanDuration(banCount: number, baseBanMs: number, maxBanMs: number): number {
  return Math.min(baseBanMs * 2 ** banCount, maxBanMs);
}

/**
 * Escalate this tracker into the "banned" state: set `bannedUntil`,
 * bump `banCount` (capped at `BAN_COUNT_MAX`), and reset the failure
 * counter so the window restarts clean after the ban expires. Mutates
 * the tracker in place and returns the ban duration used.
 */
export function escalateBan(
  tracker: AuthTracker,
  now: number,
  baseBanMs: number,
  maxBanMs: number,
): number {
  const banDuration = computeBanDuration(tracker.banCount, baseBanMs, maxBanMs);
  tracker.bannedUntil = now + banDuration;
  tracker.banCount = Math.min(tracker.banCount + 1, BAN_COUNT_MAX);
  tracker.failures = 0;
  return banDuration;
}

/**
 * Fresh tracker for a first-contact IP. Centralized so the manager
 * and the store don't drift on defaults.
 */
export function newTracker(now: number): AuthTracker {
  return {
    failures: 0,
    firstFailure: now,
    bannedUntil: 0,
    banCount: 0,
    lastFailure: now,
  };
}
