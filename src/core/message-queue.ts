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

  /** Per-target FIFO sub-queues, keyed by the target string. */
  private readonly subQueues: Map<string, Array<() => void>> = new Map();
  /** Insertion-ordered list of targets with pending messages. Drives round-robin. */
  private readonly targetOrder: string[] = [];
  /** Round-robin cursor — next `drain()` call will pop from `targetOrder[rrIndex]`. */
  private rrIndex = 0;
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

    this.enqueueToSubQueue(target, fn);
  }

  /** Send all queued messages immediately (for graceful shutdown). */
  flush(): void {
    while (this.totalPending > 0) {
      const fn = this.popNext();
      if (fn) fn();
    }
  }

  /** Discard all queued messages (for reconnect). */
  clear(): void {
    const dropped = this.totalPending;
    this.subQueues.clear();
    this.targetOrder.length = 0;
    this.rrIndex = 0;
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
   * undefined when every sub-queue is empty. Advances `rrIndex` so each
   * drain visits the next target.
   */
  private popNext(): (() => void) | undefined {
    if (this.targetOrder.length === 0) return undefined;

    // `rrIndex` may be stale after a removal; clamp into range.
    if (this.rrIndex >= this.targetOrder.length) this.rrIndex = 0;

    const key = this.targetOrder[this.rrIndex];
    const queue = this.subQueues.get(key);
    /* v8 ignore next -- invariant: targetOrder entries always have a sub-queue */
    if (!queue || queue.length === 0) {
      // Defensive: drop the stale entry and try again on the next tick.
      this.removeTarget(key);
      return this.popNext();
    }

    const fn = queue.shift();
    /* v8 ignore next -- guarded by the length check above */
    if (!fn) return undefined;
    this.totalPending--;

    if (queue.length === 0) {
      this.removeTarget(key);
    } else {
      // Only advance when this target still has work — keeps fairness
      // without oscillating through empty slots.
      this.rrIndex++;
      if (this.rrIndex >= this.targetOrder.length) this.rrIndex = 0;
    }

    return fn;
  }

  private removeTarget(key: string): void {
    this.subQueues.delete(key);
    const idx = this.targetOrder.indexOf(key);
    if (idx === -1) return;
    this.targetOrder.splice(idx, 1);
    // After removal `rrIndex` may now point one past the slot that was
    // shifted down — clamp back into range so the next pop stays fair.
    if (this.rrIndex > idx) this.rrIndex--;
    if (this.rrIndex >= this.targetOrder.length) this.rrIndex = 0;
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
