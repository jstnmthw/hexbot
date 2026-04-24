// HexBot — Per-target message queue with flood protection
//
// Sits between the bot's say/notice/action paths and the IRC client to
// prevent excess-flood disconnects and stop one noisy target from blocking
// output to every other target.
//
// Design:
//
// - **Per-target FIFO sub-queues.** Every enqueue carries a `target` string
//   (channel or nick). Messages for the same target stay in arrival order;
//   messages for different targets drain round-robin. This means a plugin
//   that floods `#busy` can't starve `#quiet` or stall replies to a user's
//   DM even though the global rate bucket is shared.
//
// - **Global integer-millisecond token bucket.** Same math as before
//   (`costMs = floor(1000/rate)`, `budgetMs += elapsed`). Integer arithmetic
//   avoids the float drift that used to leak tokens below threshold on
//   `rate=3`. Per-target sub-queues spend from the same global budget, so
//   the bot's wire output never exceeds `rate` messages/sec regardless of
//   how many targets are in play.
//
// - **Round-robin drain order.** `targetOrder` records targets in
//   insertion order; the cursor advances one target per drain. A target
//   whose sub-queue empties is removed from the rotation. A target that
//   re-appears goes to the tail, so bursty targets don't monopolise the
//   rotation.
//
// - **Global depth cap.** `MAX_DEPTH=500` is enforced against the sum of
//   pending messages across all sub-queues. On overflow we drop the
//   **newest** message (reject the incoming enqueue) rather than evicting
//   the oldest — the sender has a chance to observe the drop and back off,
//   and already-queued traffic stays in FIFO order.
//
// - **Per-target depth cap.** `MAX_PER_TARGET_DEPTH=50` prevents a single
//   runaway target from hogging the global budget. A misbehaving plugin
//   that spams `#busy` could otherwise fill 90%+ of the global queue before
//   the global cap kicks in, starving every other target for minutes.
//   Per-target overflow drops the newest (same policy as global).
//
// - **TARGMAX is surfaced, not enforced.** ISUPPORT's `TARGMAX` limits
//   how many distinct targets a single PRIVMSG line may carry. Hexbot
//   sends one target per line so the cap is advisory for us; we expose
//   `setTargmax` / `getTargmax` for plugins and future multi-target work
//   but do not split/merge here. See `docs/audits/irc-logic-2026-04-11.md`
//   §10 for context.
import type { LoggerLike } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageQueueOptions {
  /** Max messages per second (steady-state). Default: 2 */
  rate?: number;
  /** Burst allowance — messages that can send immediately before throttling. Default: 4 */
  burst?: number;
  /** Logger instance */
  logger?: LoggerLike | null;
}

/**
 * Fallback target name for enqueues that don't have a meaningful IRC
 * target (e.g. `MODE`, `QUIT`). Kept separate from real target names so
 * their round-robin position is stable across any target name.
 */
const UNTARGETED = '';

// ---------------------------------------------------------------------------
// MessageQueue
// ---------------------------------------------------------------------------

export class MessageQueue {
  private static readonly MAX_DEPTH = 500;
  /** Per-target queue cap — one noisy target can't hold more than this. */
  private static readonly MAX_PER_TARGET_DEPTH = 50;

  /** Per-target FIFO sub-queues, keyed by the target string. */
  private readonly subQueues: Map<string, Array<() => void>> = new Map();
  /** Insertion-ordered list of targets with pending messages. Drives round-robin. */
  private readonly targetOrder: string[] = [];
  /**
   * Round-robin cursor — the target to drain next. `null` means "start at
   * targetOrder[0]". Tracking a target *name* rather than an index keeps
   * the cursor stable across `removeTarget()` splices: removal can never
   * corrupt the cursor because the cursor isn't an array offset.
   */
  private nextTarget: string | null = null;
  /** Total messages pending across all sub-queues (cheap to maintain; avoids iterating every size() call). */
  private totalPending = 0;

  /** Budget in milliseconds. Each message costs `costMs`. Integer arithmetic only. */
  private budgetMs: number;
  private lastRefill: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rate: number;
  private readonly burst: number;
  /** Millisecond cost per message: floor(1000 / rate). */
  private readonly costMs: number;
  /** Maximum budget in milliseconds: burst * costMs. */
  private readonly capacityMs: number;
  private readonly logger: LoggerLike | null;
  /** ISUPPORT TARGMAX map, surfaced but not enforced. Keys are uppercased command names. */
  private targmax: Record<string, number> = {};

  constructor(options: MessageQueueOptions = {}) {
    this.rate = options.rate ?? 2;
    this.burst = options.burst ?? 4;
    this.costMs = Math.floor(1000 / this.rate);
    // Capacity must allow at least 1 message so drain() can always accumulate enough budget
    this.capacityMs = Math.max(this.costMs, this.burst * this.costMs);
    this.budgetMs = this.burst * this.costMs;
    this.lastRefill = Date.now();
    this.logger = options.logger?.child('message-queue') ?? null;

    this.start();
  }

  /** Total number of messages waiting across every per-target sub-queue. */
  get pending(): number {
    return this.totalPending;
  }

  /**
   * Push a send operation onto the queue. Sends immediately if the global
   * budget allows and no contention exists; otherwise appends to the named
   * target's sub-queue.
   *
   * @param target - IRC target (channel or nick). Pass `''` for messages
   *                 with no specific target; they share a dedicated bucket.
   * @param fn     - Send closure. Must be idempotent-on-no-effect so the
   *                 drain timer can call it at the right moment.
   */
  enqueue(target: string, fn: () => void): void {
    this.refill();

    // Fast path: nothing pending anywhere and we have budget — send inline.
    // This preserves the hot-path behaviour of the old single-queue version
    // while still paying cost against the shared bucket.
    if (this.totalPending === 0 && this.budgetMs >= this.costMs) {
      this.budgetMs -= this.costMs;
      fn();
      return;
    }

    if (this.totalPending >= MessageQueue.MAX_DEPTH) {
      this.logger?.warn(
        `Message queue full (${MessageQueue.MAX_DEPTH}), dropping outgoing message for ${target || '(no target)'}`,
      );
      return;
    }

    // Per-target cap — reject when one target has already accumulated too
    // much. Matches the global-cap policy (drop the newest; keep queued
    // FIFO intact) so behaviour is consistent regardless of which limit
    // trips first.
    const key = target || UNTARGETED;
    const existing = this.subQueues.get(key);
    if (existing && existing.length >= MessageQueue.MAX_PER_TARGET_DEPTH) {
      this.logger?.warn(
        `Per-target queue full for ${target || '(no target)'} (${MessageQueue.MAX_PER_TARGET_DEPTH}), dropping outgoing message`,
      );
      return;
    }

    this.enqueueToSubQueue(target, fn);
  }

  /** Send all queued messages immediately (for graceful shutdown). */
  flush(): void {
    while (this.totalPending > 0) {
      const fn = this.popNext();
      if (fn) fn();
    }
  }

  /**
   * Attempt to flush the queue synchronously, capped by a wall-clock
   * deadline. Used by the disconnect path so kick/mode commands the
   * operator queued before a netsplit still get pushed into the
   * irc-framework send buffer (where they may or may not reach the
   * server) — instead of being silently discarded by {@link clear}.
   * See stability audit 2026-04-14.
   *
   * @returns number of messages drained from the queue.
   */
  flushWithDeadline(maxMs: number): number {
    const deadline = Date.now() + maxMs;
    let drained = 0;
    while (this.totalPending > 0 && Date.now() < deadline) {
      const fn = this.popNext();
      if (!fn) break;
      try {
        fn();
      } catch {
        /* Per-message isolation — one bad send must not abort the flush loop. */
      }
      drained++;
    }
    return drained;
  }

  /** Discard all queued messages (for reconnect). */
  clear(): void {
    const dropped = this.totalPending;
    this.subQueues.clear();
    this.targetOrder.length = 0;
    this.nextTarget = null;
    this.totalPending = 0;
    this.budgetMs = this.capacityMs;
    this.lastRefill = Date.now();
    if (dropped > 0) {
      this.logger?.debug(`Message queue cleared, ${dropped} messages dropped`);
    }
  }

  /** Stop the drain timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply the ISUPPORT `TARGMAX` map from ServerCapabilities. Surfaced for
   * introspection and plugins that need to decide on multi-target sends;
   * the queue itself does not enforce the limits because hexbot never
   * sends a multi-target PRIVMSG line.
   */
  setTargmax(targmax: Record<string, number>): void {
    this.targmax = { ...targmax };
  }

  /** Return the current advisory TARGMAX map. */
  getTargmax(): Readonly<Record<string, number>> {
    return this.targmax;
  }

  // -------------------------------------------------------------------------
  // Internal — sub-queue management
  // -------------------------------------------------------------------------

  private enqueueToSubQueue(target: string, fn: () => void): void {
    const key = target || UNTARGETED;
    let queue = this.subQueues.get(key);
    if (!queue) {
      queue = [];
      this.subQueues.set(key, queue);
      this.targetOrder.push(key);
    }
    queue.push(fn);
    this.totalPending++;
  }

  /**
   * Pop the next message in round-robin order. Returns the send closure
   * (caller is responsible for invoking it and paying the cost) or
   * undefined when every sub-queue is empty. Advances the cursor to the
   * target *after* the one we drained so each call visits a different
   * target when more than one has work.
   */
  private popNext(): (() => void) | undefined {
    if (this.targetOrder.length === 0) return undefined;

    // Resolve the current target. If `nextTarget` is unset or names a
    // target that's since been removed, restart from index 0. No
    // defensive clamping needed — the cursor is a name, not an offset.
    let currentIdx = this.nextTarget === null ? 0 : this.targetOrder.indexOf(this.nextTarget);
    if (currentIdx === -1) currentIdx = 0;
    const key = this.targetOrder[currentIdx];
    const queue = this.subQueues.get(key);
    /* v8 ignore next -- invariant: targetOrder entries always have a non-empty sub-queue */
    if (!queue || queue.length === 0) return undefined;

    const fn = queue.shift();
    /* v8 ignore next -- guarded by the length check above */
    if (!fn) return undefined;
    this.totalPending--;

    // Pick the target to drain next *before* potentially removing the
    // current one: the "peer after me" is always targetOrder[currentIdx+1]
    // (wrapping) regardless of whether we end up splicing the current slot.
    const peerIdx = (currentIdx + 1) % this.targetOrder.length;
    const nextAfter = this.targetOrder[peerIdx];

    if (queue.length === 0) {
      this.removeTarget(key);
    }

    // If the queue we just drained is the only one left, nextTarget is
    // effectively itself — re-point to nextAfter unless it's the target
    // we just removed. Null when nothing is left keeps the "start at 0"
    // invariant tidy.
    if (this.targetOrder.length === 0) {
      this.nextTarget = null;
    } else if (nextAfter === key && queue.length === 0) {
      // Removed the only target we had; fall back to whatever is now at 0.
      this.nextTarget = this.targetOrder[0];
    } else {
      this.nextTarget = nextAfter;
    }

    return fn;
  }

  private removeTarget(key: string): void {
    this.subQueues.delete(key);
    const idx = this.targetOrder.indexOf(key);
    if (idx !== -1) this.targetOrder.splice(idx, 1);
    // `nextTarget` is a name — if the caller removed a target that happened
    // to be the cursor, `popNext()` will re-resolve from the name on the
    // next call and transparently fall back to index 0 if not found.
  }

  // -------------------------------------------------------------------------
  // Internal — timer + budget
  // -------------------------------------------------------------------------

  /** Start (or restart) the drain timer. */
  private start(): void {
    this.stop();
    this.timer = setInterval(() => this.drain(), this.costMs);
    // Don't keep the process alive just for the queue timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /** Add elapsed milliseconds to the budget. Integer arithmetic, no floats. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.budgetMs = Math.min(this.capacityMs, this.budgetMs + elapsed);
      this.lastRefill = now;
    }
  }

  /** Drain one message from the round-robin queue if budget allows. */
  private drain(): void {
    if (this.totalPending === 0) return;

    this.refill();

    if (this.budgetMs < this.costMs) return;

    const fn = this.popNext();
    if (!fn) return;
    this.budgetMs -= this.costMs;
    fn();
  }
}
