// Game session manager — isolated conversation contexts for AI-driven games.
// A session is identified by (userKey, channel) — only one active per user per channel.
import type { AIMessage } from './providers/types';

/**
 * Bound on session.context length — caps per-turn token burn on long games.
 * 40 turns ≈ 20 player/bot exchange pairs, enough for a 20questions playthrough
 * or a multi-round trivia session before sliding-window pruning kicks in.
 * Beyond this, per-call cost grows roughly linearly with no quality benefit
 * (game state is short-horizon — older turns rarely change current play).
 */
const MAX_SESSION_TURNS = 40;

/**
 * Hard cap on concurrent sessions. Inactivity expiry runs on a poll, so a
 * nick-rotation flood across many channels could otherwise grow the map
 * unbounded between ticks. On overflow we evict oldest-by-`lastActivityAt`.
 */
const MAX_SESSIONS = 500;

/**
 * Identity captured at session creation to prevent nick-takeover hijacks.
 * A session is bound to the creator's account (when available) and their
 * ident+host; a different caller using the same nick is refused.
 */
export interface SessionIdentity {
  /** Services account name (from IRCv3 account-tag). null when unauthenticated. */
  account: string | null;
  /** `ident@host` at session-creation time. Used as a fallback when account is absent. */
  identHost: string;
}

/** A single game session. */
export interface Session {
  id: string;
  userKey: string; // lowercased nick
  channel: string | null; // channel where game runs; null for PM
  type: string; // game name, e.g. "20questions"
  systemPrompt: string;
  context: AIMessage[];
  startedAt: number;
  lastActivityAt: number;
  /** Creator identity — enforced on every subsequent retrieval. */
  identity: SessionIdentity;
}

/** SessionManager tracks in-memory sessions with inactivity expiry. */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private nextId = 1;

  constructor(
    private inactivityMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Update the active inactivity timeout (hot-reload). */
  setInactivityMs(ms: number): void {
    this.inactivityMs = ms;
  }

  /**
   * Create or replace a session for (userKey, channel).
   * If a session already exists for this key it is overwritten.
   */
  createSession(
    userKey: string,
    channel: string | null,
    type: string,
    systemPrompt: string,
    identity: SessionIdentity,
  ): Session {
    const key = sessionKey(userKey, channel);
    // Evict the oldest-by-activity session when at cap and this is a new key,
    // so a nick-rotation flood can't grow the map without bound. Replacing an
    // existing key doesn't increase size and skips eviction.
    if (!this.sessions.has(key) && this.sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastActivityAt < oldestAt) {
          oldestAt = s.lastActivityAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) this.sessions.delete(oldestKey);
    }
    const session: Session = {
      id: `sess-${this.nextId++}`,
      userKey: userKey.toLowerCase(),
      channel,
      type,
      systemPrompt,
      context: [],
      startedAt: this.now(),
      lastActivityAt: this.now(),
      identity,
    };
    this.sessions.set(key, session);
    return session;
  }

  /**
   * Fetch an active (non-expired) session for this caller. Returns null if
   * there is none, the session expired, or the caller's identity doesn't
   * match the creator's. Identity gate closes the nick-takeover attack where
   * the creator disconnects and an attacker grabs the nick to inherit the
   * live session (its prior context, cooldown bypass, and token accounting).
   */
  getSession(userKey: string, channel: string | null, identity?: SessionIdentity): Session | null {
    const key = sessionKey(userKey, channel);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (this.now() - s.lastActivityAt > this.inactivityMs) {
      this.sessions.delete(key);
      return null;
    }
    if (identity && !identityMatches(s.identity, identity)) return null;
    return s;
  }

  /** End the session for (userKey, channel). Returns true if one existed. */
  endSession(userKey: string, channel: string | null): boolean {
    return this.sessions.delete(sessionKey(userKey, channel));
  }

  /**
   * Append a message to the session's context and bump lastActivity. The
   * context array is bounded at MAX_SESSION_TURNS — older turns are dropped
   * (sliding window) so long trivia/20Q games don't scale quadratically in
   * per-turn token cost.
   */
  addMessage(session: Session, message: AIMessage): void {
    session.context.push(message);
    if (session.context.length > MAX_SESSION_TURNS) {
      session.context.splice(0, session.context.length - MAX_SESSION_TURNS);
    }
    session.lastActivityAt = this.now();
  }

  /** True if a session exists for (userKey, channel) and is still active. */
  isInSession(userKey: string, channel: string | null, identity?: SessionIdentity): boolean {
    return this.getSession(userKey, channel, identity) !== null;
  }

  /** Remove all sessions past the inactivity timeout. Returns expired session IDs. */
  expireInactive(): Session[] {
    const expired: Session[] = [];
    const cutoff = this.now() - this.inactivityMs;
    for (const [key, s] of this.sessions) {
      if (s.lastActivityAt < cutoff) {
        this.sessions.delete(key);
        expired.push(s);
      }
    }
    return expired;
  }

  /** Snapshot of all active sessions. */
  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Clear everything. */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Compose the (userKey, channel) → session lookup key. Pipe is the separator
 * because IRC nicks and channel names cannot contain it; `*` stands in for
 * the null channel (PM) so a sessionless PM doesn't collide with a sessionful
 * channel of the same name.
 */
function sessionKey(userKey: string, channel: string | null): string {
  return `${userKey.toLowerCase()}|${channel?.toLowerCase() ?? '*'}`;
}

/**
 * Identity match: prefer services account (strong, services-verified), fall
 * back to `ident@host` (works on networks without account-tag). On a network
 * that writes account for some users and not others, the presence/absence of
 * account itself counts — a session created by an authenticated user should
 * not be resumable by an unauthenticated caller and vice-versa.
 */
function identityMatches(stored: SessionIdentity, caller: SessionIdentity): boolean {
  if (stored.account !== null || caller.account !== null) {
    return stored.account === caller.account;
  }
  return stored.identHost === caller.identHost;
}
