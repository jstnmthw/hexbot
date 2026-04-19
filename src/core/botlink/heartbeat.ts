// HexBot — Bot link heartbeat driver
//
// Both hub and leaf run the same loop: every `intervalMs`, check whether
// the last inbound frame's age has crossed `timeoutMs`; if so, fire the
// supplied `onTimeout` callback so the caller can tear down the
// connection; otherwise increment a sequence number and send a PING. The
// hub also sweeps stale relay routes on each tick (via `onTick`). Lifting
// this into a shared driver removes the ~20-line duplicate loop that
// drifted twice before the 2026-04-19 quality audit flagged it.
//
// The last-message timestamp stays with the caller — both hub
// (`LeafConnection.lastMessageAt`) and leaf (`this.lastHeartbeatAt`) have
// many paths that update it, and owning it here would require plumbing
// every one of those into the driver. Instead the caller passes a
// `getLastMessageAt` thunk.

/** Parameters controlling a single heartbeat loop. */
export interface HeartbeatOptions {
  /** Ping cadence in milliseconds. */
  intervalMs: number;
  /**
   * Inactivity threshold in milliseconds. When `now - getLastMessageAt()`
   * exceeds this, `onTimeout` fires and the loop stops itself.
   */
  timeoutMs: number;
  /** Returns wall-clock ms of the last inbound frame. */
  getLastMessageAt: () => number;
  /** Called with the next sequence number whenever a PING should be sent. */
  sendPing: (seq: number) => void;
  /**
   * Called once when the timeout threshold is crossed. Responsible for
   * tearing down the connection — the driver stops its own timer before
   * invoking the callback so double-fires are impossible.
   */
  onTimeout: () => void;
  /** Optional per-tick hook (e.g. route sweeps on the hub). Fires AFTER the PING send. */
  onTick?: () => void;
}

/**
 * Generic PING / timeout loop shared by botlink hub and leaf. Usage:
 *   const hb = new Heartbeat({ ... });
 *   hb.start();     // idempotent
 *   // ... on every inbound frame: (caller already records lastMessageAt)
 *   hb.stop();      // on disconnect / teardown
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly opts: HeartbeatOptions) {}

  /** Start the loop. No-op if already running. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
  }

  /** Stop the loop. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Current ping sequence number (monotonic, resets on new instance only). */
  get pingSeq(): number {
    return this.seq;
  }

  private tick(): void {
    if (Date.now() - this.opts.getLastMessageAt() > this.opts.timeoutMs) {
      // Stop before invoking onTimeout so the callback's own cleanup
      // sequence cannot re-trigger this branch on a concurrent tick.
      this.stop();
      this.opts.onTimeout();
      return;
    }
    this.seq++;
    this.opts.sendPing(this.seq);
    this.opts.onTick?.();
  }
}
