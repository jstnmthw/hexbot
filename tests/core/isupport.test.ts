import { describe, expect, it } from 'vitest';

import {
  type SupportsProvider,
  defaultServerCapabilities,
  parseISupport,
} from '../../src/core/isupport';

// ---------------------------------------------------------------------------
// Fixtures — synthetic network.supports() matching irc-framework's shape
// ---------------------------------------------------------------------------

/**
 * Build a `SupportsProvider` that returns canned ISUPPORT values.
 * Mirrors irc-framework's `network.supports(key)` behavior — unknown keys
 * return `undefined`, values are in their parsed form (PREFIX as array of
 * `{symbol,mode}`, CHANMODES as string[], CHANTYPES as char array).
 */
function makeClient(values: Record<string, unknown>): SupportsProvider {
  return {
    network: {
      supports(feature: string): unknown {
        return values[feature.toUpperCase()];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseISupport — PREFIX', () => {
  it('parses Solanum/Libera prefixes in rank order', () => {
    // `(ov)@+` — two prefix modes, op and voice.
    const caps = parseISupport(
      makeClient({
        PREFIX: [
          { symbol: '@', mode: 'o' },
          { symbol: '+', mode: 'v' },
        ],
      }),
    );
    expect(caps.prefixModes).toEqual(['o', 'v']);
    expect(caps.prefixSet.has('o')).toBe(true);
    expect(caps.prefixSet.has('v')).toBe(true);
    expect(caps.prefixSet.has('q')).toBe(false);
    expect(caps.prefixToSymbol).toEqual({ o: '@', v: '+' });
    expect(caps.symbolToPrefix).toEqual({ '@': 'o', '+': 'v' });
  });

  it('parses InspIRCd/Unreal prefixes with q/a/h (founder/admin/halfop)', () => {
    const caps = parseISupport(
      makeClient({
        PREFIX: [
          { symbol: '~', mode: 'q' },
          { symbol: '&', mode: 'a' },
          { symbol: '@', mode: 'o' },
          { symbol: '%', mode: 'h' },
          { symbol: '+', mode: 'v' },
        ],
      }),
    );
    expect(caps.prefixModes).toEqual(['q', 'a', 'o', 'h', 'v']);
    expect(caps.symbolToPrefix['&']).toBe('a');
    expect(caps.symbolToPrefix['~']).toBe('q');
  });

  it('falls back to q/a/o/h/v when PREFIX is absent', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.prefixModes).toEqual(['q', 'a', 'o', 'h', 'v']);
  });
});

describe('parseISupport — CHANMODES + expectsParam', () => {
  it('classifies Solanum CHANMODES into A/B/C/D buckets', () => {
    const caps = parseISupport(
      makeClient({
        CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQScgimnprstuz'],
        PREFIX: [
          { symbol: '@', mode: 'o' },
          { symbol: '+', mode: 'v' },
        ],
      }),
    );
    // Type A (list)
    expect(caps.chanmodesA.has('b')).toBe(true);
    expect(caps.chanmodesA.has('e')).toBe(true);
    // Type B (always param)
    expect(caps.chanmodesB.has('k')).toBe(true);
    // Type C (param on +)
    expect(caps.chanmodesC.has('l')).toBe(true);
    // Type D (flag)
    expect(caps.chanmodesD.has('m')).toBe(true);
    expect(caps.chanmodesD.has('n')).toBe(true);
  });

  it('expectsParam returns true for prefix modes regardless of direction', () => {
    const caps = parseISupport(
      makeClient({
        PREFIX: [
          { symbol: '@', mode: 'o' },
          { symbol: '+', mode: 'v' },
        ],
      }),
    );
    expect(caps.expectsParam('o', '+')).toBe(true);
    expect(caps.expectsParam('o', '-')).toBe(true);
    expect(caps.expectsParam('v', '+')).toBe(true);
  });

  it('expectsParam returns true for Type A and B both directions', () => {
    const caps = parseISupport(makeClient({ CHANMODES: ['beI', 'k', 'l', 'imnpst'] }));
    // Type A — ban list
    expect(caps.expectsParam('b', '+')).toBe(true);
    expect(caps.expectsParam('b', '-')).toBe(true);
    // Type B — channel key
    expect(caps.expectsParam('k', '+')).toBe(true);
    expect(caps.expectsParam('k', '-')).toBe(true);
  });

  it('expectsParam returns true for Type C only on +', () => {
    const caps = parseISupport(makeClient({ CHANMODES: ['beI', 'k', 'l', 'imnpst'] }));
    expect(caps.expectsParam('l', '+')).toBe(true);
    // -l removes the channel limit and takes no param on every IRCd
    expect(caps.expectsParam('l', '-')).toBe(false);
  });

  it('expectsParam returns false for Type D flags regardless of direction', () => {
    const caps = parseISupport(makeClient({ CHANMODES: ['beI', 'k', 'l', 'imnpst'] }));
    expect(caps.expectsParam('m', '+')).toBe(false);
    expect(caps.expectsParam('n', '+')).toBe(false);
    expect(caps.expectsParam('t', '-')).toBe(false);
  });
});

describe('parseISupport — MODES', () => {
  it('reads MODES as an integer when string', () => {
    const caps = parseISupport(makeClient({ MODES: '20' }));
    expect(caps.modesPerLine).toBe(20);
  });

  it('falls back to 3 when MODES is missing', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.modesPerLine).toBe(3);
  });

  it('accepts numeric MODES values', () => {
    const caps = parseISupport(makeClient({ MODES: 12 }));
    expect(caps.modesPerLine).toBe(12);
  });

  it('ignores non-numeric MODES values and falls back to 3', () => {
    const caps = parseISupport(makeClient({ MODES: 'all' }));
    expect(caps.modesPerLine).toBe(3);
  });
});

describe('parseISupport — CHANTYPES + isValidChannel', () => {
  it('accepts #&-style networks (default)', () => {
    const caps = parseISupport(makeClient({ CHANTYPES: ['#', '&'] }));
    expect(caps.chantypes).toBe('#&');
    expect(caps.isValidChannel('#lobby')).toBe(true);
    expect(caps.isValidChannel('&local')).toBe(true);
    expect(caps.isValidChannel('!retro')).toBe(false);
    expect(caps.isValidChannel('user')).toBe(false);
  });

  it('accepts IRCnet-style ! channels when CHANTYPES advertises them', () => {
    const caps = parseISupport(makeClient({ CHANTYPES: ['#', '&', '!'] }));
    expect(caps.isValidChannel('!FOOBAR')).toBe(true);
  });

  it('handles string CHANTYPES for defensive fallback', () => {
    const caps = parseISupport(makeClient({ CHANTYPES: '#' }));
    expect(caps.isValidChannel('#lobby')).toBe(true);
    expect(caps.isValidChannel('&local')).toBe(false);
  });

  it('falls back to #& when CHANTYPES is absent', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.chantypes).toBe('#&');
  });

  it('isValidChannel rejects empty and non-string inputs', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.isValidChannel('')).toBe(false);
    // @ts-expect-error — defensive guard against non-string input
    expect(caps.isValidChannel(null)).toBe(false);
  });
});

describe('parseISupport — TARGMAX', () => {
  it('parses per-command target caps', () => {
    const caps = parseISupport(makeClient({ TARGMAX: 'PRIVMSG:4,NOTICE:4,JOIN:,KICK:1' }));
    expect(caps.targmax.PRIVMSG).toBe(4);
    expect(caps.targmax.NOTICE).toBe(4);
    expect(caps.targmax.KICK).toBe(1);
    // Empty value = unlimited
    expect(caps.targmax.JOIN).toBe(Infinity);
  });

  it('defaults to an empty map when TARGMAX is absent', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.targmax).toEqual({});
  });

  it('skips malformed TARGMAX entries', () => {
    const caps = parseISupport(makeClient({ TARGMAX: 'PRIVMSG:abc,NOTICE:-2,KICK:3' }));
    expect(caps.targmax.KICK).toBe(3);
    expect(caps.targmax.PRIVMSG).toBeUndefined();
    expect(caps.targmax.NOTICE).toBeUndefined();
  });
});

describe('parseISupport — CASEMAPPING', () => {
  it('surfaces the advertised casemapping for downstream consumers', () => {
    const caps = parseISupport(makeClient({ CASEMAPPING: 'ascii' }));
    expect(caps.casemapping).toBe('ascii');
  });

  it('returns null when CASEMAPPING is not advertised', () => {
    const caps = parseISupport(makeClient({}));
    expect(caps.casemapping).toBeNull();
  });
});

describe('defaultServerCapabilities', () => {
  it('returns RFC-conformant defaults for disconnected state', () => {
    const caps = defaultServerCapabilities();
    expect(caps.prefixModes).toEqual(['q', 'a', 'o', 'h', 'v']);
    expect(caps.chantypes).toBe('#&');
    expect(caps.modesPerLine).toBe(3);
    expect(caps.casemapping).toBeNull();
    // Common ban-list mode is a Type A
    expect(caps.chanmodesA.has('b')).toBe(true);
    // `m` is a flag
    expect(caps.chanmodesD.has('m')).toBe(true);
  });
});
