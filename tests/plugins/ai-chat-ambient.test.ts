import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AmbientConfig,
  AmbientEngine,
  type AmbientSender,
  type AmbientTriggerKind,
  looksLikeQuestion,
} from '../../plugins/ai-chat/ambient';
import { RateLimiter } from '../../plugins/ai-chat/rate-limiter';
import { SocialTracker } from '../../plugins/ai-chat/social-tracker';

const BASE_CONFIG: AmbientConfig = {
  enabled: true,
  idle: { afterMinutes: 15, chance: 1.0, minUsers: 2 },
  unansweredQuestions: { enabled: true, waitSeconds: 90 },
  chattiness: 0.5,
  interests: [],
  eventReactions: { joinWb: true, topicChange: true },
};

describe('looksLikeQuestion', () => {
  it('detects trailing question mark', () => {
    expect(looksLikeQuestion('what is this?')).toBe(true);
    expect(looksLikeQuestion('huh?')).toBe(true);
  });

  it('detects interrogative words', () => {
    expect(looksLikeQuestion('who knows')).toBe(true);
    expect(looksLikeQuestion('What time is it')).toBe(true);
    expect(looksLikeQuestion('how do I do this')).toBe(true);
    expect(looksLikeQuestion('Does anyone know')).toBe(true);
    expect(looksLikeQuestion('Can you help')).toBe(true);
    expect(looksLikeQuestion('Should I do this')).toBe(true);
    expect(looksLikeQuestion('Is this right')).toBe(true);
  });

  it('returns false for plain statements', () => {
    expect(looksLikeQuestion('just chatting')).toBe(false);
    expect(looksLikeQuestion('hello everyone')).toBe(false);
    expect(looksLikeQuestion('I think so')).toBe(false);
  });
});

describe('AmbientEngine', () => {
  let engine: AmbientEngine;
  let social: SocialTracker;
  let now: number;
  let sent: Array<{ channel: string; kind: AmbientTriggerKind; prompt: string }>;
  let sender: AmbientSender;

  beforeEach(() => {
    now = 1_000_000;
    sent = [];
    sender = async (channel, kind, prompt) => {
      sent.push({ channel, kind, prompt });
    };
    social = new SocialTracker(null, () => now);
    engine = new AmbientEngine(BASE_CONFIG, social, () => now);
  });

  afterEach(() => {
    engine.stop();
  });

  /** Helper: simulate a channel message flowing through both social + ambient. */
  function message(channel: string, nick: string, text: string, isBot = false): void {
    social.onMessage(channel, nick, text, isBot);
    engine.onChannelActivity(channel);
  }

  describe('idle remarks', () => {
    it('fires idle remark when channel is quiet long enough', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      now += 16 * 60_000; // 16 minutes (threshold is 15)
      engine.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe('idle');
      expect(sent[0].channel).toBe('#test');
    });

    it('does not fire idle if channel is not quiet long enough', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      now += 10 * 60_000;
      engine.tick();
      expect(sent).toHaveLength(0);
    });

    it('does not fire idle if last message was from bot (back-to-back)', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      message('#test', 'hexbot', 'hey there', true);
      now += 16 * 60_000;
      engine.tick();
      expect(sent).toHaveLength(0);
    });

    it('does not fire idle in active channels', () => {
      engine.start(sender, 999_999);
      // Generate enough messages to make channel "active" right now
      for (let i = 0; i < 50; i++) {
        message('#test', `user${i % 5}`, `msg ${i}`);
        now += 3_000; // one every 3 seconds = 20/min within the 5-min window
      }
      // Tick immediately while still active — idle should not fire
      engine.tick();
      expect(sent).toHaveLength(0);
    });
  });

  describe('unanswered questions', () => {
    it('detects and responds to unanswered questions', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'does anyone know how to do this?');
      now += 91_000;
      engine.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe('unanswered');
      // Attacker-controlled nick/text are wrapped in delimiters so the LLM
      // treats them as data, not instruction (W13 defence-in-depth).
      expect(sent[0].prompt).toContain('<<<alice>>> asked');
      expect(sent[0].prompt).toContain('<<<does anyone know how to do this?>>>');
    });

    it('does not fire if someone responded', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'does anyone know?');
      now += 5_000;
      message('#test', 'bob', 'yeah I know');
      now += 90_000;
      engine.tick();
      expect(sent).toHaveLength(0);
    });

    it('does not fire if disabled', () => {
      const cfg = { ...BASE_CONFIG, unansweredQuestions: { enabled: false, waitSeconds: 90 } };
      engine = new AmbientEngine(cfg, social, () => now);
      engine.start(sender, 999_999);
      message('#test', 'alice', 'does anyone know?');
      now += 91_000;
      engine.tick();
      expect(sent).toHaveLength(0);
    });
  });

  describe('event reactions', () => {
    it('fires on join when enabled', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      engine.onJoin('#test', 'bob');
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe('join_wb');
      expect(sent[0].prompt).toContain('bob');
    });

    it('does not fire join if last was bot (back-to-back)', () => {
      engine.start(sender, 999_999);
      message('#test', 'hexbot', 'hey', true);
      engine.onJoin('#test', 'bob');
      expect(sent).toHaveLength(0);
    });

    it('fires on topic change when enabled', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      engine.onTopic('#test', 'alice', 'new topic');
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe('topic');
      expect(sent[0].prompt).toContain('new topic');
    });

    it('does not fire join when disabled', () => {
      const cfg = { ...BASE_CONFIG, eventReactions: { joinWb: false, topicChange: false } };
      engine = new AmbientEngine(cfg, social, () => now);
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      engine.onJoin('#test', 'bob');
      expect(sent).toHaveLength(0);
    });
  });

  describe('back-to-back prevention', () => {
    it('human message clears back-to-back flag', () => {
      engine.start(sender, 999_999);
      message('#test', 'alice', 'hello');
      message('#test', 'hexbot', 'hey', true);
      message('#test', 'bob', 'sup');
      now += 16 * 60_000;
      engine.tick();
      expect(sent).toHaveLength(1);
    });
  });

  describe('activity-gated participation', () => {
    it('does not fire ambient during flooding', () => {
      engine.start(sender, 999_999);
      // Generate flooding-level traffic (>10/min)
      for (let i = 0; i < 60; i++) {
        message('#test', `user${i % 5}`, `msg ${i}`);
        now += 1_000;
      }
      // Ask a question during flooding
      message('#test', 'alice', 'does anyone know?');
      now += 91_000;
      engine.tick();
      expect(sent).toHaveLength(0);
    });
  });
});

describe('RateLimiter ambient budget', () => {
  it('allows ambient messages within budget', () => {
    const rl = new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      rpmBackpressurePct: 80,
      globalRpm: 100,
      globalRpd: 1000,
      ambientPerChannelPerHour: 5,
      ambientGlobalPerHour: 20,
    });
    expect(rl.checkAmbient('#test')).toBe(true);
    rl.recordAmbient('#test');
    expect(rl.checkAmbient('#test')).toBe(true);
  });

  it('blocks when per-channel ambient budget is exhausted', () => {
    const rl = new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      rpmBackpressurePct: 80,
      globalRpm: 100,
      globalRpd: 1000,
      ambientPerChannelPerHour: 2,
      ambientGlobalPerHour: 20,
    });
    rl.recordAmbient('#test');
    rl.recordAmbient('#test');
    expect(rl.checkAmbient('#test')).toBe(false);
    expect(rl.checkAmbient('#other')).toBe(true);
  });

  it('blocks when global ambient budget is exhausted', () => {
    const rl = new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      rpmBackpressurePct: 80,
      globalRpm: 100,
      globalRpd: 1000,
      ambientPerChannelPerHour: 100,
      ambientGlobalPerHour: 3,
    });
    rl.recordAmbient('#a');
    rl.recordAmbient('#b');
    rl.recordAmbient('#c');
    expect(rl.checkAmbient('#d')).toBe(false);
  });

  it('reset clears ambient state', () => {
    const rl = new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      rpmBackpressurePct: 80,
      globalRpm: 100,
      globalRpd: 1000,
      ambientPerChannelPerHour: 1,
      ambientGlobalPerHour: 1,
    });
    rl.recordAmbient('#test');
    expect(rl.checkAmbient('#test')).toBe(false);
    rl.reset();
    expect(rl.checkAmbient('#test')).toBe(true);
  });
});
