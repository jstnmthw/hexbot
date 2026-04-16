import { describe, expect, it } from 'vitest';

import {
  type TriggerConfig,
  detectTrigger,
  isIgnored,
  isLikelyBot,
} from '../../plugins/ai-chat/triggers';

const BASE: TriggerConfig = {
  directAddress: true,
  command: true,
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

  it('matches command trigger with prefix + space', () => {
    expect(detectTrigger('!ai tell me a joke', 'hexbot', BASE)).toEqual({
      kind: 'command',
      prompt: 'tell me a joke',
    });
  });

  it('matches bare command prefix', () => {
    expect(detectTrigger('!ai', 'hexbot', BASE)).toEqual({ kind: 'command', prompt: '' });
  });

  it('is case-insensitive on command prefix', () => {
    expect(detectTrigger('!AI hi', 'hexbot', BASE)).toEqual({
      kind: 'command',
      prompt: 'hi',
    });
  });

  it('does not match command when command trigger is disabled', () => {
    expect(detectTrigger('!ai hi', 'hexbot', { ...BASE, command: false })).toBeNull();
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

  it('does not match when nick is just a prefix of another word', () => {
    // "hexbotter" should NOT match "hexbot"
    expect(detectTrigger('hexbotter hello', 'hexbot', BASE)).toBeNull();
  });

  it('does not match direct address when disabled', () => {
    expect(detectTrigger('hexbot: hi', 'hexbot', { ...BASE, directAddress: false })).toBeNull();
  });

  it('returns null when direct address has no prompt', () => {
    // "hexbot:" alone shouldn't fire a response
    expect(detectTrigger('hexbot:', 'hexbot', BASE)).toBeNull();
  });

  it('matches keyword triggers case-insensitively', () => {
    const cfg = { ...BASE, directAddress: false, command: false, keywords: ['typescript'] };
    expect(detectTrigger('I love TypeScript', 'hexbot', cfg)).toEqual({
      kind: 'keyword',
      prompt: 'I love TypeScript',
    });
  });

  it('ignores blank keyword entries', () => {
    const cfg = { ...BASE, directAddress: false, command: false, keywords: [''] };
    expect(detectTrigger('anything', 'hexbot', cfg)).toBeNull();
  });

  it('fires random trigger when rng under threshold', () => {
    const cfg = { ...BASE, directAddress: false, command: false, randomChance: 0.5 };
    expect(detectTrigger('just chatting', 'hexbot', cfg, () => 0.1)?.kind).toBe('random');
  });

  it('does not fire random trigger when rng above threshold', () => {
    const cfg = { ...BASE, directAddress: false, command: false, randomChance: 0.5 };
    expect(detectTrigger('just chatting', 'hexbot', cfg, () => 0.9)).toBeNull();
  });

  it('command trigger beats direct address when prefix matches nick', () => {
    // e.g. bot's command prefix "hexbot" and nick "hexbot" — command wins
    const cfg = { ...BASE, commandPrefix: 'hexbot' };
    expect(detectTrigger('hexbot hi', 'hexbot', cfg)).toEqual({
      kind: 'command',
      prompt: 'hi',
    });
  });
});
