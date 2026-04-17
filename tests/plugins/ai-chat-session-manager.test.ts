import { describe, expect, it } from 'vitest';

import { type SessionIdentity, SessionManager } from '../../plugins/ai-chat/session-manager';

function make() {
  let now = 1000;
  const clock = {
    get: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const mgr = new SessionManager(60_000, () => clock.get());
  return { mgr, clock };
}

/** Default identity used by pre-W5 tests that don't care about identity gating. */
const ID: SessionIdentity = { account: null, identHost: 'user@host.com' };

describe('SessionManager', () => {
  it('creates a session', () => {
    const { mgr } = make();
    const s = mgr.createSession('alice', '#games', '20q', 'prompt', ID);
    expect(s.userKey).toBe('alice');
    expect(s.channel).toBe('#games');
    expect(s.type).toBe('20q');
    expect(s.systemPrompt).toBe('prompt');
  });

  it('getSession returns active sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'p', ID);
    expect(mgr.getSession('alice', '#games')).not.toBeNull();
  });

  it('session keys are case-insensitive on nick and channel', () => {
    const { mgr } = make();
    mgr.createSession('Alice', '#Games', '20q', 'p', ID);
    expect(mgr.getSession('alice', '#games')).not.toBeNull();
    expect(mgr.getSession('ALICE', '#GAMES')).not.toBeNull();
  });

  it('enforces one session per (user, channel)', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'a', ID);
    mgr.createSession('alice', '#games', 'trivia', 'b', ID);
    const s = mgr.getSession('alice', '#games')!;
    expect(s.type).toBe('trivia');
  });

  it('allows the same user to have sessions in different channels', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'a', ID);
    mgr.createSession('alice', '#trivia', 'trivia', 'b', ID);
    expect(mgr.getSession('alice', '#games')?.type).toBe('20q');
    expect(mgr.getSession('alice', '#trivia')?.type).toBe('trivia');
  });

  it('allows PM sessions separately from channel sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', null, 'pm-20q', 'a', ID);
    mgr.createSession('alice', '#games', 'ch-20q', 'b', ID);
    expect(mgr.getSession('alice', null)?.type).toBe('pm-20q');
    expect(mgr.getSession('alice', '#games')?.type).toBe('ch-20q');
  });

  it('isInSession returns true for active sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', '20q', 'p', ID);
    expect(mgr.isInSession('alice', '#g')).toBe(true);
    expect(mgr.isInSession('bob', '#g')).toBe(false);
  });

  it('endSession returns true when a session existed, false otherwise', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', '20q', 'p', ID);
    expect(mgr.endSession('alice', '#g')).toBe(true);
    expect(mgr.endSession('alice', '#g')).toBe(false);
  });

  it('addMessage appends to context and bumps lastActivity', () => {
    const { mgr, clock } = make();
    const s = mgr.createSession('alice', '#g', '20q', 'p', ID);
    const startedAt = s.lastActivityAt;
    clock.advance(5000);
    mgr.addMessage(s, { role: 'user', content: 'hello' });
    expect(s.context).toHaveLength(1);
    expect(s.lastActivityAt).toBeGreaterThan(startedAt);
  });

  it('getSession returns null for expired sessions', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', '20q', 'p', ID);
    clock.advance(60_001);
    expect(mgr.getSession('alice', '#g')).toBeNull();
  });

  it('isInSession returns false for expired sessions', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', '20q', 'p', ID);
    clock.advance(60_001);
    expect(mgr.isInSession('alice', '#g')).toBe(false);
  });

  it('expireInactive removes stale sessions and returns them', () => {
    const { mgr, clock } = make();
    const sA = mgr.createSession('alice', '#g', '20q', 'p', ID);
    clock.advance(30_000);
    mgr.createSession('bob', '#g', 'trivia', 'p', ID);
    clock.advance(40_000);
    // alice is now 70s old (stale), bob is 40s old (active)
    const expired = mgr.expireInactive();
    expect(expired).toContainEqual(expect.objectContaining({ id: sA.id }));
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].userKey).toBe('bob');
  });

  it('list returns a snapshot of sessions', () => {
    const { mgr } = make();
    mgr.createSession('a', '#g', 't', 'p', ID);
    mgr.createSession('b', '#g', 't', 'p', ID);
    expect(mgr.list()).toHaveLength(2);
  });

  it('clear removes all sessions', () => {
    const { mgr } = make();
    mgr.createSession('a', '#g', 't', 'p', ID);
    mgr.clear();
    expect(mgr.list()).toHaveLength(0);
  });

  it('setInactivityMs updates the timeout', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', 't', 'p', ID);
    mgr.setInactivityMs(10_000);
    clock.advance(15_000);
    expect(mgr.getSession('alice', '#g')).toBeNull();
  });

  it('assigns unique IDs', () => {
    const { mgr } = make();
    const a = mgr.createSession('alice', '#g', 't', 'p', ID);
    const b = mgr.createSession('bob', '#g', 't', 'p', ID);
    expect(a.id).not.toBe(b.id);
  });

  // --- W5: identity gating (prevents nick-takeover inheriting sessions) ---

  it('refuses getSession when caller account differs from creator account', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', 't', 'p', { account: 'alice-acct', identHost: 'a@h' });
    expect(
      mgr.getSession('alice', '#g', { account: 'alice-acct', identHost: 'a@h' }),
    ).not.toBeNull();
    expect(mgr.getSession('alice', '#g', { account: 'mallory-acct', identHost: 'm@h' })).toBeNull();
  });

  it('falls back to ident@host when account is null on both sides', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', 't', 'p', { account: null, identHost: 'alice@h' });
    expect(mgr.getSession('alice', '#g', { account: null, identHost: 'alice@h' })).not.toBeNull();
    expect(mgr.getSession('alice', '#g', { account: null, identHost: 'mallory@h' })).toBeNull();
  });

  it('refuses when creator had account but caller has none', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', 't', 'p', { account: 'alice', identHost: 'a@h' });
    expect(mgr.getSession('alice', '#g', { account: null, identHost: 'a@h' })).toBeNull();
  });

  it('still permits legacy callers without identity argument (back-compat)', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', 't', 'p', { account: 'alice', identHost: 'a@h' });
    expect(mgr.getSession('alice', '#g')).not.toBeNull();
  });

  // --- W7: session context cap ---

  it('caps session.context at 40 turns (sliding window)', () => {
    const { mgr } = make();
    const s = mgr.createSession('alice', '#g', 't', 'p', ID);
    for (let i = 0; i < 50; i++) {
      mgr.addMessage(s, { role: 'user', content: `msg-${i}` });
    }
    expect(s.context).toHaveLength(40);
    // Oldest turns dropped; last entry preserved.
    expect(s.context[0].content).toBe('msg-10');
    expect(s.context[39].content).toBe('msg-49');
  });

  // --- MAX_SESSIONS overflow eviction ---

  it('evicts oldest-by-lastActivity on overflow past the session cap', () => {
    const { mgr, clock } = make();
    // Seed cap-worth of sessions; advance the clock between each so
    // lastActivityAt is strictly ordered and the oldest is unambiguous.
    for (let i = 0; i < 500; i++) {
      clock.advance(1);
      mgr.createSession(`u${i}`, `#c${i}`, 't', 'p', ID);
    }
    expect(mgr.list()).toHaveLength(500);
    // The very first session should still be here before the overflow insert.
    expect(mgr.getSession('u0', '#c0')).not.toBeNull();
    // One more new session pushes us past the cap → oldest-by-activity evicted.
    clock.advance(1);
    mgr.createSession('overflow', '#new', 't', 'p', ID);
    expect(mgr.list()).toHaveLength(500);
    expect(mgr.getSession('u0', '#c0')).toBeNull();
    expect(mgr.getSession('overflow', '#new')).not.toBeNull();
  });

  it('replacing an existing session at the cap does not evict anyone', () => {
    const { mgr, clock } = make();
    for (let i = 0; i < 500; i++) {
      clock.advance(1);
      mgr.createSession(`u${i}`, `#c${i}`, 't', 'p', ID);
    }
    clock.advance(1);
    // Same (userKey, channel) → replaces, doesn't grow the map.
    mgr.createSession('u0', '#c0', 'newtype', 'p', ID);
    expect(mgr.list()).toHaveLength(500);
    expect(mgr.getSession('u0', '#c0')?.type).toBe('newtype');
    // u1 (next-oldest) still present — no eviction happened.
    expect(mgr.getSession('u1', '#c1')).not.toBeNull();
  });
});
