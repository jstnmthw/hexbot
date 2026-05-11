import { describe, expect, it } from 'vitest';

import {
  activityScale,
  decideReply,
  recencyBoost,
  rolledProbability,
  startsWithCommandSigil,
} from '../../../plugins/ai-chat/reply-policy';
import type { SocialSnapshot } from '../../../plugins/ai-chat/reply-policy';
import type { TriggerMatch } from '../../../plugins/ai-chat/triggers';

const QUIET_SOCIAL: SocialSnapshot = {
  activity: 'slow',
  lastWasBot: false,
  recentBotInteraction: false,
};

describe('activityScale', () => {
  it('returns 0 for flooding', () => {
    expect(activityScale('flooding')).toBe(0);
  });
  it('returns 0.5 for active', () => {
    expect(activityScale('active')).toBe(0.5);
  });
  it('returns 1.0 for normal/slow/dead', () => {
    expect(activityScale('normal')).toBe(1.0);
    expect(activityScale('slow')).toBe(1.0);
    expect(activityScale('dead')).toBe(1.0);
  });
});

describe('recencyBoost', () => {
  it('returns 1.5 when recent', () => {
    expect(recencyBoost(true)).toBe(1.5);
  });
  it('returns 1.0 when not recent', () => {
    expect(recencyBoost(false)).toBe(1.0);
  });
});

describe('startsWithCommandSigil', () => {
  it('matches typical command sigils', () => {
    for (const s of ['!foo', '.bar', '/quit', '~cmd', '@op', '%hop', '$v', '&a', '+v']) {
      expect(startsWithCommandSigil(s)).toBe(true);
    }
  });
  it('does not match ordinary text', () => {
    expect(startsWithCommandSigil('hello')).toBe(false);
    expect(startsWithCommandSigil('neo: hi')).toBe(false);
  });
  it('ignores leading whitespace', () => {
    expect(startsWithCommandSigil('   !cmd')).toBe(true);
  });
});

describe('rolledProbability', () => {
  const baseInput = {
    text: 'just chatting',
    social: QUIET_SOCIAL,
    randomChance: 0.1,
    characterChattiness: 1.0,
  };

  it('is 0 when randomChance is 0', () => {
    expect(rolledProbability({ ...baseInput, randomChance: 0 })).toBe(0);
  });

  it('is 0 when lastWasBot (back-to-back guard)', () => {
    expect(rolledProbability({ ...baseInput, social: { ...QUIET_SOCIAL, lastWasBot: true } })).toBe(
      0,
    );
  });

  it('is 0 for command-sigil text', () => {
    expect(rolledProbability({ ...baseInput, text: '!help' })).toBe(0);
    expect(rolledProbability({ ...baseInput, text: '.chanset foo' })).toBe(0);
  });

  it('is 0 when flooding', () => {
    expect(
      rolledProbability({ ...baseInput, social: { ...QUIET_SOCIAL, activity: 'flooding' } }),
    ).toBe(0);
  });

  it('applies activity × chattiness', () => {
    // base 0.1 × chattiness 0.5 × slow 1.0 = 0.05
    expect(rolledProbability({ ...baseInput, characterChattiness: 0.5 })).toBeCloseTo(0.05);
  });

  it('applies recency boost', () => {
    expect(
      rolledProbability({
        ...baseInput,
        social: { ...QUIET_SOCIAL, recentBotInteraction: true },
      }),
    ).toBeCloseTo(0.15);
  });

  it('halves for active channel', () => {
    expect(
      rolledProbability({ ...baseInput, social: { ...QUIET_SOCIAL, activity: 'active' } }),
    ).toBeCloseTo(0.05);
  });

  it('clamps to [0,1]', () => {
    expect(rolledProbability({ ...baseInput, randomChance: 2, characterChattiness: 2 })).toBe(1);
  });
});

describe('decideReply', () => {
  const baseSocial: SocialSnapshot = QUIET_SOCIAL;

  const direct: TriggerMatch = { kind: 'direct', prompt: 'hi' };

  it('returns address on a direct-trigger hit regardless of social state', () => {
    expect(
      decideReply({
        text: 'hexbot: hi',
        trigger: direct,
        engaged: false,
        social: { ...baseSocial, lastWasBot: true },
        characterChattiness: 1,
        randomChance: 0,
      }),
    ).toBe('address');
  });

  it('returns engaged when the user is currently engaged and no explicit trigger', () => {
    expect(
      decideReply({
        text: 'still thinking',
        trigger: null,
        engaged: true,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0,
      }),
    ).toBe('engaged');
  });

  it('returns skip when engaged but text starts with a command sigil', () => {
    expect(
      decideReply({
        text: '!help ai',
        trigger: null,
        engaged: true,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0,
      }),
    ).toBe('skip');
  });

  it('returns skip when randomChance is 0', () => {
    expect(
      decideReply({
        text: 'just chatting',
        trigger: null,
        engaged: false,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0,
      }),
    ).toBe('skip');
  });

  it('returns rolled when RNG under threshold in a quiet channel', () => {
    expect(
      decideReply({
        text: 'just chatting',
        trigger: null,
        engaged: false,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0.5,
        rng: () => 0.1,
      }),
    ).toBe('rolled');
  });

  it('returns skip when RNG above threshold', () => {
    expect(
      decideReply({
        text: 'just chatting',
        trigger: null,
        engaged: false,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0.5,
        rng: () => 0.9,
      }),
    ).toBe('skip');
  });

  it('returns skip when flooding (activity scale = 0)', () => {
    expect(
      decideReply({
        text: 'chatter',
        trigger: null,
        engaged: false,
        social: { ...baseSocial, activity: 'flooding' },
        characterChattiness: 1,
        randomChance: 1,
        rng: () => 0,
      }),
    ).toBe('skip');
  });

  it('returns skip when lastWasBot (back-to-back)', () => {
    expect(
      decideReply({
        text: 'chatter',
        trigger: null,
        engaged: false,
        social: { ...baseSocial, lastWasBot: true },
        characterChattiness: 1,
        randomChance: 1,
        rng: () => 0,
      }),
    ).toBe('skip');
  });

  it('recency boost widens the roll threshold', () => {
    // base p = 0.3; with recency = 0.45
    // RNG 0.4 rolls as 'skip' without recency, 'rolled' with recency.
    expect(
      decideReply({
        text: 'chatter',
        trigger: null,
        engaged: false,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 0.3,
        rng: () => 0.4,
      }),
    ).toBe('skip');
    expect(
      decideReply({
        text: 'chatter',
        trigger: null,
        engaged: false,
        social: { ...baseSocial, recentBotInteraction: true },
        characterChattiness: 1,
        randomChance: 0.3,
        rng: () => 0.4,
      }),
    ).toBe('rolled');
  });

  it('returns skip for command-sigil text even with a high random chance', () => {
    expect(
      decideReply({
        text: '!help',
        trigger: null,
        engaged: false,
        social: baseSocial,
        characterChattiness: 1,
        randomChance: 1,
        rng: () => 0,
      }),
    ).toBe('skip');
  });
});
