// HexBot — Bot Link pending-request helper
//
// Shared implementation of the "send a ref-keyed request, await a reply,
// time out after N ms" pattern used by both botlink-hub and botlink-leaf
// for CMD, PARTY_WHOM, and protection-request round trips. Centralising
// the bookkeeping removes three parallel Map declarations per side and
// makes shutdown drain paths impossible to forget.
import type { LoggerLike } from '../../logger';

interface PendingEntry<T> {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: T) => void;
  /**
   * When set, only a {@link PendingRequestMap.resolve} call whose `responder`
   * matches (case-insensitively) may resolve this entry. Used on the hub to
   * bind a reply frame to the leaf the request was actually sent to, so a
   * different (compromised) leaf can't answer another leaf's pending request
   * by guessing its ref. Left unset for peers with a single trusted
   * counterpart (a leaf only ever hears from the hub).
   */
  expectedResponder?: string;
}

/**
 * Hard cap on the number of concurrent pending relay requests. Under
 * sustained botlink load with a laggy hub, entries can accumulate
 * faster than their individual timeouts reclaim them. Above the cap,
 * `create()` rejects immediately with the timeout value so callers see
 * a predictable degradation instead of an unbounded memory footprint.
 */
const DEFAULT_MAX_PENDING = 4096;

export interface PendingRequestMapOptions {
  /** Maximum concurrent pending entries. Defaults to `DEFAULT_MAX_PENDING` (4096). */
  maxPending?: number;
  /** Human-friendly label for cap-hit warnings (e.g. `"hub:pendingCmds"`). */
  label?: string;
  /** Logger to notify on cap-hit. A null/undefined logger silences the warning. */
  logger?: LoggerLike | null;
}

export class PendingRequestMap<T> {
  private map = new Map<string, PendingEntry<T>>();
  private readonly maxPending: number;
  private readonly label: string;
  private readonly logger: LoggerLike | null;
  private droppedAtCap = 0;

  /**
   * Construct a pending-request map. Accepts either a plain `maxPending`
   * number (legacy shape, kept to avoid churning 8+ call sites that don't
   * need logger plumbing) or an options object carrying a logger and
   * label for cap-hit observability.
   */
  constructor(maxPending?: number);
  constructor(options: PendingRequestMapOptions);
  constructor(arg: number | PendingRequestMapOptions = DEFAULT_MAX_PENDING) {
    const opts: PendingRequestMapOptions = typeof arg === 'number' ? { maxPending: arg } : arg;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.label = opts.label ?? 'pending';
    this.logger = opts.logger ?? null;
  }

  /**
   * Register a pending request keyed by `ref` and return a promise that
   * resolves either via `resolve(ref, value)` or after `timeoutMs` with the
   * caller-supplied `timeoutValue`.
   *
   * Rejects at cap with the timeout value so callers see the same
   * "this relay failed, move on" signal as a real network timeout.
   */
  create(ref: string, timeoutMs: number, timeoutValue: T, expectedResponder?: string): Promise<T> {
    // Guard against unbounded growth when the remote peer stops
    // responding and every caller still schedules a new entry. After
    // the cap, resolve immediately — callers treat it the same as a
    // natural timeout.
    if (this.map.size >= this.maxPending) {
      this.droppedAtCap++;
      // Log on the first drop and then every 100th — a laggy peer can
      // drive this counter upward fast and we don't want to flood the
      // log, but operators need to see it happening at least once.
      if (this.droppedAtCap === 1 || this.droppedAtCap % 100 === 0) {
        this.logger?.warn(
          `[botlink:${this.label}] pending-request cap ${this.maxPending} reached — dropping ref "${ref}" (${this.droppedAtCap} total drops)`,
        );
      }
      return Promise.resolve(timeoutValue);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(timeoutValue);
    }
    return new Promise<T>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.map.delete(ref);
        resolvePromise(timeoutValue);
      }, timeoutMs);
      this.map.set(ref, { timer, resolve: resolvePromise, expectedResponder });
    });
  }

  /** Count of `create()` calls that hit the cap since startup. */
  get droppedCount(): number {
    return this.droppedAtCap;
  }

  /**
   * Resolve the pending entry for `ref`, clearing its timeout. No-op when
   * the entry has already been resolved or timed out — callers don't need
   * to guard.
   */
  resolve(ref: string, value: T, responder?: string): boolean {
    const entry = this.map.get(ref);
    if (!entry) return false;
    // Responder binding: if this entry names an expected responder and the
    // caller supplied who actually answered, a mismatch is a forged reply —
    // ignore it WITHOUT consuming the entry so the legitimate responder's
    // reply can still resolve it (or it can time out naturally).
    if (
      entry.expectedResponder !== undefined &&
      responder !== undefined &&
      responder.toLowerCase() !== entry.expectedResponder.toLowerCase()
    ) {
      return false;
    }
    clearTimeout(entry.timer);
    this.map.delete(ref);
    entry.resolve(value);
    return true;
  }

  /**
   * Resolve every outstanding entry with a shared fallback value, clearing
   * their timers. Used during disconnect/shutdown drain so awaiting callers
   * don't hang.
   */
  drain(fallback: T): void {
    for (const entry of this.map.values()) {
      clearTimeout(entry.timer);
      entry.resolve(fallback);
    }
    this.map.clear();
  }

  /* v8 ignore next 3 -- observability helper, not exercised in tests */
  get size(): number {
    return this.map.size;
  }
}
