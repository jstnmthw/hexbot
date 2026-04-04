import { describe, expect, it } from 'vitest';

import { SessionManager } from '../../plugins/ai-chat/session-manager';

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

describe('SessionManager', () => {
  it('creates a session', () => {
    const { mgr } = make();
    const s = mgr.createSession('alice', '#games', '20q', 'prompt');
    expect(s.userKey).toBe('alice');
    expect(s.channel).toBe('#games');
    expect(s.type).toBe('20q');
    expect(s.systemPrompt).toBe('prompt');
  });

  it('getSession returns active sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'p');
    expect(mgr.getSession('alice', '#games')).not.toBeNull();
  });

  it('session keys are case-insensitive on nick and channel', () => {
    const { mgr } = make();
    mgr.createSession('Alice', '#Games', '20q', 'p');
    expect(mgr.getSession('alice', '#games')).not.toBeNull();
    expect(mgr.getSession('ALICE', '#GAMES')).not.toBeNull();
  });

  it('enforces one session per (user, channel)', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'a');
    mgr.createSession('alice', '#games', 'trivia', 'b');
    const s = mgr.getSession('alice', '#games')!;
    expect(s.type).toBe('trivia');
  });

  it('allows the same user to have sessions in different channels', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#games', '20q', 'a');
    mgr.createSession('alice', '#trivia', 'trivia', 'b');
    expect(mgr.getSession('alice', '#games')?.type).toBe('20q');
    expect(mgr.getSession('alice', '#trivia')?.type).toBe('trivia');
  });

  it('allows PM sessions separately from channel sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', null, 'pm-20q', 'a');
    mgr.createSession('alice', '#games', 'ch-20q', 'b');
    expect(mgr.getSession('alice', null)?.type).toBe('pm-20q');
    expect(mgr.getSession('alice', '#games')?.type).toBe('ch-20q');
  });

  it('isInSession returns true for active sessions', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', '20q', 'p');
    expect(mgr.isInSession('alice', '#g')).toBe(true);
    expect(mgr.isInSession('bob', '#g')).toBe(false);
  });

  it('endSession returns true when a session existed, false otherwise', () => {
    const { mgr } = make();
    mgr.createSession('alice', '#g', '20q', 'p');
    expect(mgr.endSession('alice', '#g')).toBe(true);
    expect(mgr.endSession('alice', '#g')).toBe(false);
  });

  it('addMessage appends to context and bumps lastActivity', () => {
    const { mgr, clock } = make();
    const s = mgr.createSession('alice', '#g', '20q', 'p');
    const startedAt = s.lastActivityAt;
    clock.advance(5000);
    mgr.addMessage(s, { role: 'user', content: 'hello' });
    expect(s.context).toHaveLength(1);
    expect(s.lastActivityAt).toBeGreaterThan(startedAt);
  });

  it('getSession returns null for expired sessions', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', '20q', 'p');
    clock.advance(60_001);
    expect(mgr.getSession('alice', '#g')).toBeNull();
  });

  it('isInSession returns false for expired sessions', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', '20q', 'p');
    clock.advance(60_001);
    expect(mgr.isInSession('alice', '#g')).toBe(false);
  });

  it('expireInactive removes stale sessions and returns them', () => {
    const { mgr, clock } = make();
    const sA = mgr.createSession('alice', '#g', '20q', 'p');
    clock.advance(30_000);
    mgr.createSession('bob', '#g', 'trivia', 'p');
    clock.advance(40_000);
    // alice is now 70s old (stale), bob is 40s old (active)
    const expired = mgr.expireInactive();
    expect(expired).toContainEqual(expect.objectContaining({ id: sA.id }));
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].userKey).toBe('bob');
  });

  it('list returns a snapshot of sessions', () => {
    const { mgr } = make();
    mgr.createSession('a', '#g', 't', 'p');
    mgr.createSession('b', '#g', 't', 'p');
    expect(mgr.list()).toHaveLength(2);
  });

  it('clear removes all sessions', () => {
    const { mgr } = make();
    mgr.createSession('a', '#g', 't', 'p');
    mgr.clear();
    expect(mgr.list()).toHaveLength(0);
  });

  it('setInactivityMs updates the timeout', () => {
    const { mgr, clock } = make();
    mgr.createSession('alice', '#g', 't', 'p');
    mgr.setInactivityMs(10_000);
    clock.advance(15_000);
    expect(mgr.getSession('alice', '#g')).toBeNull();
  });

  it('assigns unique IDs', () => {
    const { mgr } = make();
    const a = mgr.createSession('alice', '#g', 't', 'p');
    const b = mgr.createSession('bob', '#g', 't', 'p');
    expect(a.id).not.toBe(b.id);
  });
});
