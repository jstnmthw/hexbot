// Cross-dialect ISUPPORT matrix — Phase 8.
//
// The earlier isupport.test.ts exercises the parser with synthetic values
// chosen to poke at edge cases. This file is the other half: it feeds the
// parser with REAL `005` fragments taken from Solanum/Libera, InspIRCd,
// UnrealIRCd, and ngIRCd (IRCnet-style) and asserts the resulting
// `ServerCapabilities` round-trips the key properties every consumer
// depends on. A regression that breaks one dialect but not another
// (missing ngIRCd `+` halfop, dropping InspIRCd's type-C `f`) should
// fail loudly here.
//
// Also covers two regressions the audit called out specifically:
//   - NAMES parsing when `multi-prefix` is NOT negotiated: the server
//     sends only the user's highest-rank prefix (e.g. `@alice` for an
//     op+voice). Channel state must still track `o`.
//   - IRCnet `!channel` routing through `isValidChannel` when the server
//     advertises it in CHANTYPES.
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChannelState } from '../../src/core/channel-state';
import {
  type ServerCapabilities,
  type SupportsProvider,
  parseISupport,
} from '../../src/core/isupport';
import { BotEventBus } from '../../src/event-bus';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Shape of an advertised ISUPPORT entry as irc-framework stores it after
 * parsing the numeric 005. The parser pulls `PREFIX` into an array of
 * `{symbol, mode}`; `CHANMODES` into a `['A','B','C','D']` tuple; etc.
 * These fixtures mirror irc-framework's post-parse shape so the test
 * can pass them straight through `parseISupport`.
 */
interface DialectFixture {
  readonly name: string;
  readonly options: Record<string, unknown>;
}

/** Solanum (Libera Chat) — the modern Ratbox/Charybdis descendant. */
const SOLANUM: DialectFixture = {
  name: 'Solanum / Libera Chat',
  options: {
    PREFIX: [
      { symbol: '@', mode: 'o' },
      { symbol: '+', mode: 'v' },
    ],
    CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQScgimnprstuz'],
    CHANTYPES: ['#'],
    MODES: '4',
    CASEMAPPING: 'rfc1459',
    NETWORK: 'Libera.Chat',
    TARGMAX: 'ACCEPT:,MONITOR:,NAMES:1,LIST:1,KICK:1,WHOIS:1,PRIVMSG:4,NOTICE:4',
  },
};

/** InspIRCd 3.x — q/a/h prefix modes, high `MODES=` limit. */
const INSPIRCD: DialectFixture = {
  name: 'InspIRCd',
  options: {
    PREFIX: [
      { symbol: '~', mode: 'q' },
      { symbol: '&', mode: 'a' },
      { symbol: '@', mode: 'o' },
      { symbol: '%', mode: 'h' },
      { symbol: '+', mode: 'v' },
    ],
    CHANMODES: ['IXbegw', 'k', 'FHJLfjl', 'ABCDKMNOPQRSTcimnprstuz'],
    CHANTYPES: ['#'],
    MODES: '20',
    CASEMAPPING: 'rfc1459',
    NETWORK: 'InspNet',
    TARGMAX: 'PRIVMSG:20,NOTICE:20,JOIN:,KICK:1',
  },
};

/** UnrealIRCd — same founder/admin/halfop prefixes, moderate `MODES=`. */
const UNREAL: DialectFixture = {
  name: 'UnrealIRCd',
  options: {
    PREFIX: [
      { symbol: '~', mode: 'q' },
      { symbol: '&', mode: 'a' },
      { symbol: '@', mode: 'o' },
      { symbol: '%', mode: 'h' },
      { symbol: '+', mode: 'v' },
    ],
    CHANMODES: ['beI', 'kLf', 'lH', 'psmntirMRcOAQKVGCuzNSTG'],
    CHANTYPES: ['#'],
    MODES: '12',
    CASEMAPPING: 'ascii',
    NETWORK: 'UnrealNet',
  },
};

/** IRCnet (ngIRCd-style) — `!` CHANTYPE, ascii casemapping. */
const IRCNET: DialectFixture = {
  name: 'IRCnet',
  options: {
    PREFIX: [
      { symbol: '@', mode: 'o' },
      { symbol: '+', mode: 'v' },
    ],
    CHANMODES: ['beI', 'k', 'l', 'imnpstv'],
    CHANTYPES: ['#', '&', '!', '+'],
    MODES: '3',
    CASEMAPPING: 'ascii',
    NETWORK: 'IRCnet',
  },
};

const ALL_DIALECTS: readonly DialectFixture[] = [SOLANUM, INSPIRCD, UNREAL, IRCNET];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `SupportsProvider` view over a dialect fixture. Mirrors
 * irc-framework's `network.supports()` behavior: unknown keys return
 * `undefined`; known keys return the pre-parsed value.
 */
function clientFor(fixture: DialectFixture): SupportsProvider {
  return {
    network: {
      supports(feature: string): unknown {
        return fixture.options[feature.toUpperCase()];
      },
    },
  };
}

function capsFor(fixture: DialectFixture): ServerCapabilities {
  return parseISupport(clientFor(fixture));
}

class MockClient extends EventEmitter {
  simulateEvent(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }
}

// ---------------------------------------------------------------------------
// ISUPPORT parser — per-dialect round-trips
// ---------------------------------------------------------------------------

describe('ISUPPORT dialect matrix — parser round-trips', () => {
  it('Solanum advertises only op/voice and Type-A beIq list modes', () => {
    const caps = capsFor(SOLANUM);
    expect(caps.prefixModes).toEqual(['o', 'v']);
    expect(caps.prefixToSymbol).toEqual({ o: '@', v: '+' });
    // Type A list modes include ban, invite-except, ban-exception, quiet.
    for (const ch of 'beIq') expect(caps.chanmodesA.has(ch)).toBe(true);
    // Type C modes (`f`/`l`/`j` — forward, limit, join throttle) only take
    // a param on `+`.
    expect(caps.expectsParam('l', '+')).toBe(true);
    expect(caps.expectsParam('l', '-')).toBe(false);
    expect(caps.expectsParam('f', '+')).toBe(true);
    expect(caps.expectsParam('f', '-')).toBe(false);
    expect(caps.modesPerLine).toBe(4);
    expect(caps.chantypes).toBe('#');
    expect(caps.isValidChannel('#libera')).toBe(true);
    expect(caps.isValidChannel('!ircnet')).toBe(false);
    expect(caps.targmax.PRIVMSG).toBe(4);
  });

  it('InspIRCd exposes q/a/h prefix modes and MODES=20', () => {
    const caps = capsFor(INSPIRCD);
    expect(caps.prefixModes).toEqual(['q', 'a', 'o', 'h', 'v']);
    expect(caps.prefixToSymbol['%']).toBeUndefined(); // `%` is a symbol, not a mode char
    expect(caps.prefixToSymbol.h).toBe('%');
    expect(caps.symbolToPrefix['~']).toBe('q');
    // Every prefix mode must expect a param on both directions.
    for (const mode of caps.prefixModes) {
      expect(caps.expectsParam(mode, '+')).toBe(true);
      expect(caps.expectsParam(mode, '-')).toBe(true);
    }
    // InspIRCd's `f` is Type C (param on + only).
    expect(caps.expectsParam('f', '+')).toBe(true);
    expect(caps.expectsParam('f', '-')).toBe(false);
    // `i` / `m` / `n` are Type D (never param).
    expect(caps.expectsParam('i', '+')).toBe(false);
    expect(caps.expectsParam('m', '-')).toBe(false);
    expect(caps.modesPerLine).toBe(20);
  });

  it('UnrealIRCd exposes halfop in prefix and `k`/`L`/`f` as always-param', () => {
    const caps = capsFor(UNREAL);
    expect(caps.prefixSet.has('h')).toBe(true);
    // Type B — channel key, `L` linked channel, `f` flood protection:
    // always take a param in both directions.
    for (const ch of 'kLf') {
      expect(caps.expectsParam(ch, '+')).toBe(true);
      expect(caps.expectsParam(ch, '-')).toBe(true);
    }
    // Type C — channel limit + history: param on + only.
    expect(caps.expectsParam('l', '+')).toBe(true);
    expect(caps.expectsParam('l', '-')).toBe(false);
    expect(caps.expectsParam('H', '+')).toBe(true);
    expect(caps.expectsParam('H', '-')).toBe(false);
    expect(caps.modesPerLine).toBe(12);
    expect(caps.casemapping).toBe('ascii');
  });

  it('IRCnet advertises `!` CHANTYPE and accepts it via isValidChannel', () => {
    const caps = capsFor(IRCNET);
    expect(caps.chantypes).toBe('#&!+');
    expect(caps.isValidChannel('!RETRO')).toBe(true);
    expect(caps.isValidChannel('#local')).toBe(true);
    expect(caps.isValidChannel('&server')).toBe(true);
    expect(caps.isValidChannel('+local')).toBe(true);
    expect(caps.isValidChannel('nouser')).toBe(false);
    // ngIRCd default `MODES=3` per RFC 2812.
    expect(caps.modesPerLine).toBe(3);
  });

  it('every dialect yields a non-empty prefix set and chantypes string', () => {
    // Sanity check — the fallback paths in parseISupport should only
    // kick in when a fixture is totally missing, not for real dialects.
    for (const dialect of ALL_DIALECTS) {
      const caps = capsFor(dialect);
      expect(caps.prefixModes.length).toBeGreaterThan(0);
      expect(caps.chantypes.length).toBeGreaterThan(0);
      expect(caps.modesPerLine).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Channel-state NAMES integration — with and without multi-prefix
// ---------------------------------------------------------------------------

describe('NAMES parsing against each dialect', () => {
  let client: MockClient;
  let state: ChannelState;
  let eventBus: BotEventBus;

  beforeEach(() => {
    client = new MockClient();
    eventBus = new BotEventBus();
    state = new ChannelState(client, eventBus);
    state.attach();
  });

  it('tracks the classic `~foo &bar @+baz %qux +quux` multi-prefix reply', () => {
    state.setCapabilities(capsFor(INSPIRCD));
    client.simulateEvent('userlist', {
      channel: '#test',
      users: [
        { nick: 'foo', ident: 'f', hostname: 'h', modes: ['q'] },
        { nick: 'bar', ident: 'b', hostname: 'h', modes: ['a'] },
        { nick: 'baz', ident: 'z', hostname: 'h', modes: ['o', 'v'] },
        { nick: 'qux', ident: 'q', hostname: 'h', modes: ['h'] },
        { nick: 'quux', ident: 'u', hostname: 'h', modes: ['v'] },
      ],
    });
    expect(state.getUserModes('#test', 'foo')).toEqual(['q']);
    expect(state.getUserModes('#test', 'bar')).toEqual(['a']);
    expect(state.getUserModes('#test', 'baz').sort()).toEqual(['o', 'v']);
    expect(state.getUserModes('#test', 'qux')).toEqual(['h']);
    expect(state.getUserModes('#test', 'quux')).toEqual(['v']);
  });

  it('falls back to only the highest prefix when multi-prefix is NOT negotiated', () => {
    // Without `multi-prefix`, the server sends the single highest-rank
    // prefix per user. irc-framework still delivers it as a one-element
    // array — we should track whatever chars land, but we won't invent
    // modes the server chose not to send.
    state.setCapabilities(capsFor(SOLANUM));
    client.simulateEvent('userlist', {
      channel: '#libera',
      users: [
        { nick: 'oponly', ident: 'x', hostname: 'h', modes: ['o'] }, // op+voice user, only `o` sent
        { nick: 'voiceonly', ident: 'y', hostname: 'h', modes: ['v'] },
        { nick: 'plain', ident: 'z', hostname: 'h', modes: [] },
      ],
    });
    // We must NOT hallucinate a `v` entry for oponly — we only know what
    // the server told us. The bot can still add modes later via MODE
    // events when the user's other prefixes change.
    expect(state.getUserModes('#libera', 'oponly')).toEqual(['o']);
    expect(state.getUserModes('#libera', 'voiceonly')).toEqual(['v']);
    expect(state.getUserModes('#libera', 'plain')).toEqual([]);
  });

  it('maps dialect-specific status symbols (`~`, `&`) when caps advertise them', () => {
    // Bot-link CHAN sync frames use concatenated symbol strings; the
    // channel-state fallback path must map them through the active
    // capabilities snapshot. Switching dialects mid-test exercises that
    // path: on Solanum `~` is not a prefix, on Unreal it is.
    state.setCapabilities(capsFor(SOLANUM));
    client.simulateEvent('userlist', {
      channel: '#test',
      users: [{ nick: 'user1', ident: 'u', hostname: 'h', modes: '~' }],
    });
    // Solanum has no `q` prefix — the `~` char is unrecognised and
    // silently dropped. (Tracking it would contradict the advertised set.)
    expect(state.getUserModes('#test', 'user1')).toEqual([]);

    state.setCapabilities(capsFor(UNREAL));
    client.simulateEvent('userlist', {
      channel: '#test',
      users: [{ nick: 'user2', ident: 'u', hostname: 'h', modes: '~' }],
    });
    // Under Unreal the same symbol resolves to `q` (founder).
    expect(state.getUserModes('#test', 'user2')).toEqual(['q']);
  });

  it('respects dialect-specific prefix mode updates via MODE events', () => {
    // +q on a channel should register under Unreal's PREFIX set but be
    // dropped under ngIRCd's (which only supports o/v). Set caps per
    // subsim and verify.
    state.setCapabilities(capsFor(UNREAL));
    client.simulateEvent('userlist', {
      channel: '#test',
      users: [{ nick: 'alice', ident: 'a', hostname: 'h', modes: [] }],
    });
    client.simulateEvent('mode', {
      target: '#test',
      modes: [{ mode: '+q', param: 'alice' }],
    });
    expect(state.getUserModes('#test', 'alice')).toContain('q');

    // Switch to a capabilities view where `q` is NOT a prefix.
    state.setCapabilities(capsFor(IRCNET));
    client.simulateEvent('userlist', {
      channel: '#test2',
      users: [{ nick: 'bob', ident: 'b', hostname: 'h', modes: [] }],
    });
    client.simulateEvent('mode', {
      target: '#test2',
      modes: [{ mode: '+q', param: 'bob' }],
    });
    // IRCnet (ngIRCd) has no `q` prefix — our handler ignores it rather
    // than inventing a prefix the server doesn't recognize.
    expect(state.getUserModes('#test2', 'bob')).not.toContain('q');
  });
});
