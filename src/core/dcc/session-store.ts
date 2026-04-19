// HexBot — DCC session store
// Owns the live `handle/nick → DCCSessionEntry` map and the IRC casemapping
// used to key it. Extracted from DCCManager so the casemapping-aware
// helpers (`sessionKey`, duplicate-eviction checks, handle-wide close)
// live next to the storage they operate on, and so the manager's public
// surface doesn't have to grow every time a new consumer needs to walk
// the sessions map.
//
// The store wraps an injected `Map<string, DCCSessionEntry>` rather than
// owning a private instance so existing DCCManager tests that pre-seed
// `deps.sessions` with a plain `Map` keep working — `deps.sessions` is
// passed straight through to the store constructor.
import type { LoggerLike } from '../../logger';
import { type Casemapping, ircLower } from '../../utils/wildcard';
// Type-only import keeps the runtime graph acyclic: session-store.ts only
// uses `DCCSessionEntry` as a compile-time contract, so TS erases the
// edge at build time.
import type { DCCSessionEntry } from './index';

/**
 * IRC-casemapping-aware map of live DCC sessions, keyed by the authed
 * user's current nick (folded via `ircLower`). Iteration yields the raw
 * session entries — handle/nick live on the entry itself.
 */
export class DCCSessionStore {
  private casemapping: Casemapping = 'rfc1459';

  constructor(private readonly sessions: Map<string, DCCSessionEntry>) {}

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /**
   * IRC-case-fold a nick into the key used internally. Centralising this
   * means a casemapping change happens in exactly one place.
   */
  sessionKey(nick: string): string {
    return ircLower(nick, this.casemapping);
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Get a session by IRC nick (case-insensitive). */
  get(nick: string): DCCSessionEntry | undefined {
    return this.sessions.get(this.sessionKey(nick));
  }

  /** Insert or replace the session entry for this nick. */
  set(nick: string, session: DCCSessionEntry): void {
    this.sessions.set(this.sessionKey(nick), session);
  }

  /** Remove the session entry for this nick. Returns true if one was removed. */
  delete(nick: string): boolean {
    return this.sessions.delete(this.sessionKey(nick));
  }

  /** True if there is a live session for this nick. */
  has(nick: string): boolean {
    return this.sessions.has(this.sessionKey(nick));
  }

  values(): IterableIterator<DCCSessionEntry> {
    return this.sessions.values();
  }

  entries(): IterableIterator<[string, DCCSessionEntry]> {
    return this.sessions.entries();
  }

  /** Drop every entry, leaving the caller responsible for closing them. */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Snapshot the live sessions as a list of `{handle, nick, connectedAt}`.
   * Used by party-line displays and by {@link DCCManager.getSessionList}.
   */
  snapshot(): Array<{ handle: string; nick: string; connectedAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      handle: s.handle,
      nick: s.nick,
      connectedAt: s.connectedAt,
    }));
  }

  /**
   * Collect every session whose authenticated handle matches `handle`
   * (case-insensitive). Callers typically use this to evict sessions on
   * password rotation or user deletion — the store returns `[key, entry]`
   * pairs so the caller can `close()` each entry and then `.delete()`
   * the key without racing the map iterator.
   */
  collectByHandle(handle: string): Array<[string, DCCSessionEntry]> {
    const lowerHandle = this.sessionKey(handle);
    const matches: Array<[string, DCCSessionEntry]> = [];
    for (const [key, session] of this.sessions.entries()) {
      if (this.sessionKey(session.handle) === lowerHandle) {
        matches.push([key, session]);
      }
    }
    return matches;
  }

  /**
   * Close every live session whose authenticated handle matches
   * `handle`. A single helper with the logger write so callers don't
   * duplicate the logging + iterator-safe deletion.
   */
  closeForHandle(handle: string, reason: string, logger?: LoggerLike | null): void {
    const toClose = this.collectByHandle(handle);
    if (toClose.length === 0) return;
    logger?.warn(`Closing ${toClose.length} DCC session(s) for ${handle}: ${reason}`);
    for (const [key, session] of toClose) {
      session.close(`Session ended: ${reason}.`);
      this.sessions.delete(key);
    }
  }

  /** Close and remove every session — used on manager detach. */
  closeAll(reason?: string): void {
    for (const session of this.sessions.values()) {
      session.close(reason);
    }
    this.sessions.clear();
  }
}
