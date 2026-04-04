// Game session manager — isolated conversation contexts for AI-driven games.
// A session is identified by (userKey, channel) — only one active per user per channel.
import type { AIMessage } from './providers/types';

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
  ): Session {
    const key = sessionKey(userKey, channel);
    const session: Session = {
      id: `sess-${this.nextId++}`,
      userKey: userKey.toLowerCase(),
      channel,
      type,
      systemPrompt,
      context: [],
      startedAt: this.now(),
      lastActivityAt: this.now(),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** Fetch an active (non-expired) session. Returns null for missing/expired. */
  getSession(userKey: string, channel: string | null): Session | null {
    const key = sessionKey(userKey, channel);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (this.now() - s.lastActivityAt > this.inactivityMs) {
      this.sessions.delete(key);
      return null;
    }
    return s;
  }

  /** End the session for (userKey, channel). Returns true if one existed. */
  endSession(userKey: string, channel: string | null): boolean {
    return this.sessions.delete(sessionKey(userKey, channel));
  }

  /** Append a message to the session's context and bump lastActivity. */
  addMessage(session: Session, message: AIMessage): void {
    session.context.push(message);
    session.lastActivityAt = this.now();
  }

  /** True if a session exists for (userKey, channel) and is still active. */
  isInSession(userKey: string, channel: string | null): boolean {
    return this.getSession(userKey, channel) !== null;
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

function sessionKey(userKey: string, channel: string | null): string {
  return `${userKey.toLowerCase()}|${channel?.toLowerCase() ?? '*'}`;
}
