import { describe, expect, it } from 'vitest';

import {
  type TriggerConfig,
  detectTrigger,
  isIgnored,
  isLikelyBot,
} from '../../plugins/ai-chat/triggers';

const BASE: TriggerConfig = {
  directAddress: true,
  commandPrefix: '!ai',
  keywords: [],
  randomChance: 0,
};

describe('isLikelyBot', () => {
  it('returns false when ignoreBots is off', () => {
    expect(isLikelyBot('somebot', ['*bot'], false)).toBe(false);
  });

  it('matches suffix wildcard', () => {
    expect(isLikelyBot('channelbot', ['*bot'], true)).toBe(true);
    expect(isLikelyBot('alice', ['*bot'], true)).toBe(false);
  });

  it('matches prefix wildcard', () => {
    expect(isLikelyBot('BotMaster', ['Bot*'], true)).toBe(true);
    expect(isLikelyBot('Master', ['Bot*'], true)).toBe(false);
  });

  it('matches contains wildcard', () => {
    expect(isLikelyBot('xx_bot_xx', ['*bot*'], true)).toBe(true);
  });

  it('matches exact nick', () => {
    expect(isLikelyBot('ChanServ', ['ChanServ'], true)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLikelyBot('ALICEBOT', ['*bot'], true)).toBe(true);
  });
});

describe('isIgnored', () => {
  it('matches nick exactly', () => {
    expect(isIgnored('Alice', 'Alice!u@h', ['alice'])).toBe(true);
  });

  it('matches hostmask with wildcards', () => {
    expect(isIgnored('alice', 'alice!user@host.com', ['*!*@host.com'])).toBe(true);
    expect(isIgnored('bob', 'bob!user@other.com', ['*!*@host.com'])).toBe(false);
  });

  it('returns false when list is empty', () => {
    expect(isIgnored('alice', 'alice!u@h', [])).toBe(false);
  });

  it('matches without wildcards when exact', () => {
    expect(isIgnored('alice', 'alice!u@h', ['alice!u@h'])).toBe(true);
    expect(isIgnored('alice', 'alice!u@h', ['alice!u@other'])).toBe(false);
  });
});

describe('detectTrigger', () => {
  it('returns null for empty/whitespace text', () => {
    expect(detectTrigger('', 'hexbot', BASE)).toBeNull();
    expect(detectTrigger('   ', 'hexbot', BASE)).toBeNull();
  });

  it('does NOT match !ai <freeform> (subcommand console only now)', () => {
    expect(detectTrigger('!ai tell me a joke', 'hexbot', BASE)).toBeNull();
    expect(detectTrigger('!ai', 'hexbot', BASE)).toBeNull();
  });

  it('matches direct address with colon', () => {
    expect(detectTrigger('hexbot: what is the weather', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'what is the weather',
    });
  });

  it('matches direct address with comma', () => {
    expect(detectTrigger('hexbot, hello', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'hello',
    });
  });

  it('matches direct address with just whitespace', () => {
    expect(detectTrigger('hexbot tell me a joke', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'tell me a joke',
    });
  });

  it('matches direct address case-insensitively', () => {
    expect(detectTrigger('HexBot: hi', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'hi',
    });
  });

  it('matches "… hexbot?" question style', () => {
    const match = detectTrigger('who are you, hexbot?', 'hexbot', BASE);
    expect(match?.kind).toBe('direct');
  });

  it('matches trailing nick with no punctuation', () => {
    expect(detectTrigger('Welcome hexbot', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'Welcome hexbot',
    });
  });

  it('matches trailing nick with a period', () => {
    expect(detectTrigger('Wake up, hexbot.', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'Wake up, hexbot.',
    });
  });

  it('matches mid-sentence nick mention', () => {
    expect(detectTrigger('i wonder what hexbot would think', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'i wonder what hexbot would think',
    });
  });

  it('matches nick glued to em-dash-style punctuation', () => {
    expect(detectTrigger('what are your thoughts hexbot--i had a dream', 'hexbot', BASE)).toEqual({
      kind: 'direct',
      prompt: 'what are your thoughts hexbot--i had a dream',
    });
  });

  it('does not match when nick is just a prefix of another word', () => {
    expect(detectTrigger('hexbotter hello', 'hexbot', BASE)).toBeNull();
  });

  it('does not match when nick is embedded in another word', () => {
    expect(detectTrigger('neonatal care', 'neo', BASE)).toBeNull();
  });

  it('does not match direct address when disabled', () => {
    expect(detectTrigger('hexbot: hi', 'hexbot', { ...BASE, directAddress: false })).toBeNull();
  });

  it('returns null when direct address has no prompt', () => {
    expect(detectTrigger('hexbot:', 'hexbot', BASE)).toBeNull();
  });

  it('matches keyword triggers case-insensitively', () => {
    const cfg = { ...BASE, directAddress: false, keywords: ['typescript'] };
    expect(detectTrigger('I love TypeScript', 'hexbot', cfg)).toEqual({
      kind: 'keyword',
      prompt: 'I love TypeScript',
    });
  });

  it('ignores blank keyword entries', () => {
    const cfg = { ...BASE, directAddress: false, keywords: [''] };
    expect(detectTrigger('anything', 'hexbot', cfg)).toBeNull();
  });
});
