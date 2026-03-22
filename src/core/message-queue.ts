// n0xb0t — Message queue with flood protection
// Token-bucket rate limiter for outgoing IRC messages. Sits between
// the bot's say/notice/action methods and the IRC client to prevent
// excess-flood disconnects.

import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageQueueOptions {
  /** Max messages per second (steady-state). Default: 2 */
  rate?: number;
  /** Burst allowance — messages that can send immediately before throttling. Default: 4 */
  burst?: number;
  /** Logger instance */
  logger?: Logger | null;
}

// ---------------------------------------------------------------------------
// MessageQueue
// ---------------------------------------------------------------------------

export class MessageQueue {
  private readonly queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rate: number;
  private readonly burst: number;
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly logger: Logger | null;

  constructor(options: MessageQueueOptions = {}) {
    this.rate = options.rate ?? 2;
    this.burst = options.burst ?? 4;
    // Bucket capacity must be at least 1 so drain() can always accumulate a token
    this.capacity = Math.max(1, this.burst);
    this.tokens = this.burst;
    this.lastRefill = Date.now();
    this.intervalMs = Math.floor(1000 / this.rate);
    this.logger = options.logger ?? null;

    this.start();
  }

  /** Number of messages waiting in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Push a send operation onto the queue. Sends immediately if tokens available. */
  enqueue(fn: () => void): void {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens--;
      fn();
      return;
    }

    this.queue.push(fn);
  }

  /** Send all queued messages immediately (for graceful shutdown). */
  flush(): void {
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      fn();
    }
  }

  /** Discard all queued messages (for reconnect). */
  clear(): void {
    const dropped = this.queue.length;
    this.queue.length = 0;
    this.tokens = this.burst;
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

  /** Start (or restart) the drain timer. */
  private start(): void {
    this.stop();
    this.timer = setInterval(() => this.drain(), this.intervalMs);
    // Don't keep the process alive just for the queue timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /** Refill tokens based on elapsed time. */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / 1000) * this.rate;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /** Drain one message from the queue if tokens are available. */
  private drain(): void {
    if (this.queue.length === 0) return;

    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens--;
      const fn = this.queue.shift()!;
      fn();
    }
  }
}
