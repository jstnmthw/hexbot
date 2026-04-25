// flood — sliding-window rate counters for msg/join/part/nick events
//
// Thin wrapper around four sliding-window counter instances, one per event
// class. Lives behind its own module so the plugin's bind handlers just ask
// "did this user flood X" without knowing which counter belongs to which
// event — and so the sweep schedule stays in one place.
//
// Counters come from `api.util.createSlidingWindowCounter()` so this module
// doesn't reach into `src/utils/*` at runtime — that boundary is type-only
// per CLAUDE.md / DESIGN.md. The factory returns the canonical
// SlidingWindowCounter (hard key cap + emergency sweep) so a nick-rotation
// attacker can't balloon the map between 60s plugin sweeps. See memleak
// audit C1 (2026-04-14).
import type { PluginSlidingWindowCounter } from '../../src/types';

export type RateLimitKind = 'msg' | 'join' | 'part' | 'nick';

/** Factory signature matching `api.util.createSlidingWindowCounter`. */
export type CounterFactory = () => PluginSlidingWindowCounter;

export interface RateLimitWindows {
  msgThreshold: number;
  msgWindowMs: number;
  joinThreshold: number;
  joinWindowMs: number;
  partThreshold: number;
  partWindowMs: number;
  nickThreshold: number;
  nickWindowMs: number;
}

/**
 * Optional pre-built counters for each event class. Tests that need "msg
 * counter already at 45/50, join counter idle" can construct each counter
 * with its own seed (directly instantiating the underlying
 * `SlidingWindowCounter` class) and pass them in here without replaying
 * hundreds of `check()` calls.
 */
export interface RateLimitTrackerInitialCounters {
  msg?: PluginSlidingWindowCounter;
  join?: PluginSlidingWindowCounter;
  part?: PluginSlidingWindowCounter;
  nick?: PluginSlidingWindowCounter;
}

/**
 * Groups four independent sliding-window counters (one per event class) so the
 * plugin's bind handlers can ask "did this user flood X" without knowing
 * which counter belongs to which event. Sweep and reset are fanned out
 * across all four in a single call. `counterFactory` supplies fresh
 * counters for any kind not pre-seeded via `initialCounters` — pass
 * `api.util.createSlidingWindowCounter` from the plugin's init().
 */
export class RateLimitTracker {
  private readonly counters: Record<RateLimitKind, PluginSlidingWindowCounter>;

  constructor(
    private readonly windows: RateLimitWindows,
    counterFactory: CounterFactory,
    initialCounters?: RateLimitTrackerInitialCounters,
  ) {
    this.counters = {
      msg: initialCounters?.msg ?? counterFactory(),
      join: initialCounters?.join ?? counterFactory(),
      part: initialCounters?.part ?? counterFactory(),
      nick: initialCounters?.nick ?? counterFactory(),
    };
  }

  /** Record one hit on `kind` and return true once the threshold is exceeded. */
  check(kind: RateLimitKind, key: string): boolean {
    const { windowMs, threshold } = this.windowFor(kind);
    return this.counters[kind].check(key, windowMs, threshold);
  }

  /** Prune stale keys from all four counters. Called from the periodic sweep. */
  sweep(): void {
    this.counters.msg.sweep(this.windows.msgWindowMs);
    this.counters.join.sweep(this.windows.joinWindowMs);
    this.counters.part.sweep(this.windows.partWindowMs);
    this.counters.nick.sweep(this.windows.nickWindowMs);
  }

  /** Drop all counter state — called from plugin teardown. */
  reset(): void {
    this.counters.msg.reset();
    this.counters.join.reset();
    this.counters.part.reset();
    this.counters.nick.reset();
  }

  /** Look up the (windowMs, threshold) tuple for one of the four event kinds. */
  private windowFor(kind: RateLimitKind): { windowMs: number; threshold: number } {
    switch (kind) {
      case 'msg':
        return { windowMs: this.windows.msgWindowMs, threshold: this.windows.msgThreshold };
      case 'join':
        return { windowMs: this.windows.joinWindowMs, threshold: this.windows.joinThreshold };
      case 'part':
        return { windowMs: this.windows.partWindowMs, threshold: this.windows.partThreshold };
      case 'nick':
        return { windowMs: this.windows.nickWindowMs, threshold: this.windows.nickThreshold };
    }
  }
}
