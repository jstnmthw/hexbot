// flood — sliding-window rate counters for msg/join/part/nick events
//
// Thin wrapper around four SlidingWindowCounter instances, one per event
// class. Lives behind its own module so the plugin's bind handlers just ask
// "did this user flood X" without knowing which counter belongs to which
// event — and so the sweep schedule stays in one place.
//
// Uses the canonical SlidingWindowCounter from src/utils (hard key cap +
// emergency sweep) so a nick-rotation attacker can't balloon the map
// between 60s plugin sweeps. See memleak audit C1 (2026-04-14).
import { SlidingWindowCounter } from '../../src/utils/sliding-window';

export type RateLimitKind = 'msg' | 'join' | 'part' | 'nick';

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

export class RateLimitTracker {
  private readonly counters: Record<RateLimitKind, SlidingWindowCounter> = {
    msg: new SlidingWindowCounter(),
    join: new SlidingWindowCounter(),
    part: new SlidingWindowCounter(),
    nick: new SlidingWindowCounter(),
  };

  constructor(private readonly windows: RateLimitWindows) {}

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
