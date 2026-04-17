import { describe, expect, it } from 'vitest';

import { SocialTracker } from '../../plugins/ai-chat/social-tracker';
import type { PluginDB } from '../../src/types';

function makeDb(): PluginDB {
  const store = new Map<string, string>();
  return {
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    del: (k) => void store.delete(k),
    list: (prefix = '') =>
      [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, value: v })),
  };
}

describe('SocialTracker', () => {
  describe('activity level', () => {
    it('starts as dead for unknown channels', () => {
      const st = new SocialTracker();
      expect(st.getActivity('#test')).toBe('dead');
    });

    it('reports slow for infrequent messages', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#test', 'alice', 'hello', false);
      now += 60_000;
      st.onMessage('#test', 'bob', 'hi', false);
      expect(st.getActivity('#test')).toBe('slow');
    });

    it('reports normal for moderate traffic (2-5/min)', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      // 15 messages in 5 minutes = 3/min = normal
      for (let i = 0; i < 15; i++) {
        st.onMessage('#test', 'alice', `msg ${i}`, false);
        now += 20_000;
      }
      expect(st.getActivity('#test')).toBe('normal');
    });

    it('reports active for busy traffic (5-10/min)', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      // 35 messages in 5 minutes = 7/min = active
      for (let i = 0; i < 35; i++) {
        st.onMessage('#test', 'alice', `msg ${i}`, false);
        now += 8_500;
      }
      expect(st.getActivity('#test')).toBe('active');
    });

    it('reports flooding for very busy traffic (>10/min)', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      // 60 messages in 5 minutes = 12/min = flooding
      for (let i = 0; i < 60; i++) {
        st.onMessage('#test', 'alice', `msg ${i}`, false);
        now += 3_000;
      }
      expect(st.getActivity('#test')).toBe('flooding');
    });

    it('decays to dead after 30 minutes of silence', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#test', 'alice', 'hello', false);
      now += 31 * 60_000;
      expect(st.getActivity('#test')).toBe('dead');
    });
  });

  describe('back-to-back prevention', () => {
    it('tracks when last message was from bot', () => {
      const st = new SocialTracker();
      st.onMessage('#test', 'alice', 'hello', false);
      expect(st.isLastMessageFromBot('#test')).toBe(false);
      st.onMessage('#test', 'hexbot', 'hey', true);
      expect(st.isLastMessageFromBot('#test')).toBe(true);
      st.onMessage('#test', 'bob', 'sup', false);
      expect(st.isLastMessageFromBot('#test')).toBe(false);
    });

    it('returns false for unknown channels', () => {
      const st = new SocialTracker();
      expect(st.isLastMessageFromBot('#unknown')).toBe(false);
    });
  });

  describe('pending questions', () => {
    it('tracks questions and returns them after min age', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#test', 'alice', 'does anyone know how to do this?', false);
      expect(st.getUnansweredQuestions('#test', 90_000)).toHaveLength(0);
      now += 91_000;
      const qs = st.getUnansweredQuestions('#test', 90_000);
      expect(qs).toHaveLength(1);
      expect(qs[0].nick).toBe('alice');
    });

    it('clears questions when someone responds', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#test', 'alice', 'does anyone know?', false);
      now += 5_000;
      st.onMessage('#test', 'bob', 'yeah I do', false);
      now += 90_000;
      expect(st.getUnansweredQuestions('#test', 90_000)).toHaveLength(0);
    });

    it('consumeQuestion removes a specific question', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      // Two questions from the same nick so the second doesn't clear the first
      st.onMessage('#test', 'alice', 'question one?', false);
      now += 10_000; // past the 5s self-clear window
      st.onMessage('#test', 'alice', 'question two?', false);
      now += 91_000;
      const qs = st.getUnansweredQuestions('#test', 90_000);
      expect(qs).toHaveLength(2);
      st.consumeQuestion('#test', qs[0]);
      expect(st.getUnansweredQuestions('#test', 90_000)).toHaveLength(1);
    });

    it('cleans up old questions after 10 minutes', () => {
      let ts = 1_000_000;
      const st = new SocialTracker(null, () => ts);
      st.onMessage('#test', 'alice', 'old question?', false);
      ts += 11 * 60_000;
      st.onMessage('#test', 'bob', 'hello', false); // triggers prune
      expect(st.getUnansweredQuestions('#test', 0)).toHaveLength(0);
    });
  });

  describe('per-user interaction tracking', () => {
    it('records user messages in DB', () => {
      const db = makeDb();
      const st = new SocialTracker(db);
      st.onMessage('#test', 'alice', 'hello', false);
      st.onMessage('#test', 'alice', 'world', false);
      const stats = st.getUserInteraction('alice');
      expect(stats).not.toBeNull();
      expect(stats!.totalMessages).toBe(2);
      expect(stats!.botInteractions).toBe(0);
    });

    it('records bot interactions', () => {
      const db = makeDb();
      const st = new SocialTracker(db);
      st.onMessage('#test', 'alice', 'hello', false);
      st.recordBotInteraction('alice');
      const stats = st.getUserInteraction('alice');
      expect(stats!.botInteractions).toBe(1);
    });

    it('hasInteractedWithBot returns false for new users', () => {
      const db = makeDb();
      const st = new SocialTracker(db);
      st.onMessage('#test', 'alice', 'hello', false);
      expect(st.hasInteractedWithBot('alice')).toBe(false);
    });

    it('hasInteractedWithBot returns true after bot interaction', () => {
      const db = makeDb();
      const st = new SocialTracker(db);
      st.onMessage('#test', 'alice', 'hello', false);
      st.recordBotInteraction('alice');
      expect(st.hasInteractedWithBot('alice')).toBe(true);
    });

    it('does not track bot messages as user interactions', () => {
      const db = makeDb();
      const st = new SocialTracker(db);
      st.onMessage('#test', 'hexbot', 'response', true);
      expect(st.getUserInteraction('hexbot')).toBeNull();
    });

    it('works without a DB (no persistence)', () => {
      const st = new SocialTracker(null);
      st.onMessage('#test', 'alice', 'hello', false);
      expect(st.getUserInteraction('alice')).toBeNull();
    });
  });

  describe('clear', () => {
    it('clears all ephemeral state', () => {
      const st = new SocialTracker();
      st.onMessage('#test', 'alice', 'hello', false);
      st.clear();
      expect(st.getActivity('#test')).toBe('dead');
      expect(st.getState('#test')).toBeUndefined();
    });
  });

  describe('dropChannel', () => {
    it('drops a single channel without touching others', () => {
      const st = new SocialTracker();
      st.onMessage('#a', 'alice', 'hi', false);
      st.onMessage('#b', 'bob', 'hi', false);
      st.dropChannel('#a');
      expect(st.getState('#a')).toBeUndefined();
      expect(st.getState('#b')).toBeDefined();
    });
  });

  describe('user-interaction retention sweep', () => {
    it('drops rows older than 90 days on first access per day', () => {
      const now = 1_700_000_000_000;
      const db = makeDb();
      // Seed an ancient row (>90d old) directly.
      db.set(
        'user-interaction:ancient',
        JSON.stringify({
          lastSeen: now - 100 * 24 * 60 * 60_000,
          totalMessages: 1,
          botInteractions: 0,
          lastBotInteraction: 0,
        }),
      );
      const st = new SocialTracker(db, () => now);
      st.onMessage('#test', 'alice', 'hi', false);
      // Retention sweep runs on the first recordUserInteraction per day.
      expect(db.get('user-interaction:ancient')).toBeUndefined();
      expect(db.get('user-interaction:alice')).toBeDefined();
    });

    it('drops corrupt rows and keeps the day guard', () => {
      let now = 1_700_000_000_000;
      const db = makeDb();
      db.set('user-interaction:bad', 'not-json');
      const st = new SocialTracker(db, () => now);
      st.onMessage('#test', 'alice', 'hi', false);
      expect(db.get('user-interaction:bad')).toBeUndefined();
      // Second call same day — should be a no-op (day guard).
      now += 1_000;
      st.onMessage('#test', 'bob', 'hi', false);
      expect(db.get('user-interaction:bob')).toBeDefined();
    });
  });

  describe('activeUsers eviction', () => {
    it('drops per-nick entries whose lastSeen is outside the activity window', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#test', 'ghost', 'hello', false);
      const before = st.getState('#test')!;
      expect(before.activeUsers.has('ghost')).toBe(true);
      // Jump past the 5-minute activity window.
      now += 10 * 60_000;
      st.onMessage('#test', 'fresh', 'hi', false);
      const after = st.getState('#test')!;
      expect(after.activeUsers.has('ghost')).toBe(false);
      expect(after.activeUsers.has('fresh')).toBe(true);
    });
  });

  describe('maintain sweep (idle channels + hard cap)', () => {
    it('drops channels whose lastMessageAt is older than 24h once maintain fires', () => {
      let now = 1_000_000;
      const st = new SocialTracker(null, () => now);
      st.onMessage('#old', 'alice', 'hi', false);
      // Advance past the 24h retention AND the maintain throttle interval.
      now += 25 * 60 * 60_000;
      st.onMessage('#new', 'bob', 'hi', false);
      expect(st.getState('#old')).toBeUndefined();
      expect(st.getState('#new')).toBeDefined();
    });
  });
});
