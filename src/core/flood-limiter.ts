// HexBot — Input flood limiter
// Per-user rate limiting for channel (pub) and private (msg) PRIVMSG traffic.
// Extracted from `EventDispatcher` so the two pieces of state (the two
// sliding-window counters + the one-time warning set) and the periodic
// sweep schedule live in one place, and so dispatcher.ts can focus on
// bind routing. The dispatcher still owns the public flood API — it
// simply delegates to this class.
import type { LoggerLike } from '../logger';
import type { FloodConfig, FloodWindowConfig, HandlerContext } from '../types';
import { SlidingWindowCounter } from '../utils/sliding-window';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional permissions interface — if provided, used for `n` (owner) bypass. */
export interface FloodPermissionsProvider {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/**
 * Narrow interface for sending flood-warning NOTICEs.
 * Injected by the bot to avoid a direct dep on the IRC client.
 */
export interface FloodNoticeProvider {
  sendNotice(nick: string, message: string): void;
}

/** Result from check(). */
export interface FloodCheckResult {
  /** True if the user is currently rate-limited and this message should be dropped. */
  blocked: boolean;
  /**
   * True only on the first blocked message per window — the caller should
   * send a one-time warning notice if this is true.
   * Always false when blocked is false.
   */
  firstBlock: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOOD_DEFAULTS: Required<FloodWindowConfig> = { count: 5, window: 10 };

/** How often the sweep fires (ms). Cheap short-circuit in the hot path. */
const SWEEP_INTERVAL_MS = 300_000;

/**
 * Hard cap on the `warned` set size. Matches the SlidingWindowCounter
 * MAX_KEYS ceiling so the two companion structures share a failure
 * mode — an attacker rotating hostmasks can't inflate `warned` past the
 * counters it mirrors, and an idle bot that floods once at boot and then
 * goes silent can't pin peak warn-state until the next sweep.
 */
const MAX_WARNED_KEYS = 8192;

// ---------------------------------------------------------------------------
// FloodLimiter
// ---------------------------------------------------------------------------

/**
 * Per-user input flood limiter with two independent windows (pub vs. msg).
 *
 * Call `check()` once per inbound IRC message in the bridge **before** the
 * paired dispatch calls (pub+pubm for channel, msg+msgm for private). If
 * `blocked` is true, skip both dispatch calls.
 *
 * - Users with the `n` (owner) flag bypass flood protection entirely.
 * - On the first blocked message per window, `firstBlock` is true and the
 *   configured `FloodNoticeProvider` (if any) is notified exactly once.
 * - If no config is supplied, flood limiting is disabled.
 */
export class FloodLimiter {
  private permissions: FloodPermissionsProvider | null;
  private logger: LoggerLike | null;
  private noticeProvider: FloodNoticeProvider | null = null;

  private config: {
    pub: Required<FloodWindowConfig>;
    msg: Required<FloodWindowConfig>;
  } | null = null;

  private pubFlood = new SlidingWindowCounter();
  private msgFlood = new SlidingWindowCounter();
  /** Tracks which keys have already received the one-time flood warning this window. */
  private warned = new Set<string>();
  private lastSweep = 0;

  constructor(permissions?: FloodPermissionsProvider | null, logger?: LoggerLike | null) {
    this.permissions = permissions ?? null;
    this.logger = logger ?? null;
  }

  /** Apply the `flood` section of bot.json. Without this, limiting is disabled. */
  setConfig(config: FloodConfig): void {
    this.config = {
      pub: { ...FLOOD_DEFAULTS, ...config.pub },
      msg: { ...FLOOD_DEFAULTS, ...config.msg },
    };
  }

  /** Wire in the notice provider used for one-time flood warnings. */
  setNoticeProvider(provider: FloodNoticeProvider): void {
    this.noticeProvider = provider;
  }

  /**
   * Drop all per-key rate-limit state. Called on `bot:disconnected` so a
   * user whose old-session key was flagged isn't instantly rate-limited
   * on their first message after reconnect.
   */
  reset(): void {
    this.pubFlood.reset();
    this.msgFlood.reset();
    this.warned.clear();
  }

  /**
   * Record one event against the given kind/key and decide whether it should
   * be blocked. See class-level docs for semantics.
   */
  check(kind: 'pub' | 'msg', key: string, ctx: HandlerContext): FloodCheckResult {
    this.maybeSweep();

    if (!this.config) return { blocked: false, firstBlock: false };

    // Owner bypass — n-flagged users are never flood-limited.
    if (this.permissions?.checkFlags('n', ctx)) return { blocked: false, firstBlock: false };

    const cfg = this.config[kind];
    const counter = kind === 'pub' ? this.pubFlood : this.msgFlood;
    const windowMs = cfg.window * 1000;

    const exceeded = counter.check(key, windowMs, cfg.count);

    if (!exceeded) {
      // Window has room — clear any stale warned state so next flood gets a fresh notice.
      this.warned.delete(key);
      return { blocked: false, firstBlock: false };
    }

    // User is flooding.
    if (!this.warned.has(key)) {
      // FIFO-evict the oldest entry before adding when capped. JavaScript Sets
      // preserve insertion order (ES2015 §23.2 — `[[SetData]]` iteration), so
      // `values().next()` yields the earliest-warned key without us having to
      // track insertion order separately.
      if (this.warned.size >= MAX_WARNED_KEYS) {
        const oldest = this.warned.values().next().value;
        if (oldest !== undefined) this.warned.delete(oldest);
      }
      this.warned.add(key);
      this.noticeProvider?.sendNotice(
        ctx.nick,
        'You are sending commands too quickly. Please slow down.',
      );
      this.logger?.warn(`[dispatcher] flood: ${key} (${kind}) — blocked`);
      return { blocked: true, firstBlock: true };
    }

    return { blocked: true, firstBlock: false };
  }

  /**
   * Prune stale keys from both counters and clear the one-time warning set.
   * Safe to call whenever — the hot-path caller short-circuits on the
   * timestamp check so this is effectively free between sweeps.
   */
  sweep(): void {
    this.lastSweep = Date.now();
    if (this.config) {
      this.pubFlood.sweep(this.config.pub.window * 1000);
      this.msgFlood.sweep(this.config.msg.window * 1000);
    }
    this.warned.clear();
  }

  /** Tracked-key counts per counter — for observability/debug. */
  stats(): { pub: number; msg: number; warned: number } {
    return {
      pub: this.pubFlood.size,
      msg: this.msgFlood.size,
      warned: this.warned.size,
    };
  }

  /**
   * Cheap periodic sweep gate — runs `sweep()` at most every
   * {@link SWEEP_INTERVAL_MS}. Kept private so call sites don't accidentally
   * implement their own throttling.
   */
  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweep <= SWEEP_INTERVAL_MS) return;
    this.sweep();
  }
}
