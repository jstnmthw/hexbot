// HexBot — ListenerGroup utility
// Tracks a set of event listeners on a single emitter so they can be
// detached in one call. Core modules (channel-state, services,
// connection-lifecycle) attach many listeners to the IRC client at startup
// and must remove exactly those on shutdown/reload — a bare `removeAllListeners`
// would wipe every other subscriber on the same event. ListenerGroup makes
// the leak-safe pattern the default.

/**
 * Minimal emitter shape — matches Node's `EventEmitter` as well as
 * irc-framework's client surface. `off` is the irc-framework/DOM alias;
 * `removeListener` is the Node alias. We accept either so callers don't
 * have to wrap their clients.
 */
export interface ListenerTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

type Listener = (...args: unknown[]) => void;

export class ListenerGroup {
  private target: ListenerTarget;
  private entries: Array<{ event: string; fn: Listener }> = [];

  constructor(target: ListenerTarget) {
    this.target = target;
  }

  /** Attach a listener and record it for later removal. */
  on(event: string, fn: Listener): void {
    this.target.on(event, fn);
    this.entries.push({ event, fn });
  }

  /**
   * Detach every recorded listener and clear the internal record.
   *
   * Per-entry try/catch — a single throw on `off()` would otherwise leave
   * every remaining listener attached, racing with fresh listeners on the
   * next reconnect. See stability audit 2026-04-14.
   */
  removeAll(): void {
    for (const { event, fn } of this.entries) {
      try {
        if (this.target.removeListener) {
          this.target.removeListener(event, fn);
        } else if (this.target.off) {
          this.target.off(event, fn);
        }
      } catch (err) {
        console.error(`[listener-group] removeListener(${event}) threw:`, err);
      }
    }
    this.entries.length = 0;
  }

  /** Number of currently-attached listeners. Primarily for tests. */
  get size(): number {
    return this.entries.length;
  }
}
