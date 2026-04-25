import { describe, expect, it } from 'vitest';

import {
  CONSOLE_FLAG_LETTERS,
  DEFAULT_CONSOLE_FLAGS,
  categorize,
  consoleFlagKey,
  extractExplicitCategory,
  formatFlags,
  isConsoleFlagLetter,
  parseCanonicalFlags,
  parseFlagsMutation,
  shouldDeliverToSession,
} from '../../src/core/dcc';
import type { LogRecord } from '../../src/logger';

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    level: 'info',
    timestamp: new Date(),
    source: null,
    formatted: '',
    plain: '',
    dccFormatted: '',
    ...overrides,
  };
}

describe('dcc-console-flags — parser/formatter', () => {
  it('parses a simple +flags mutation from an empty base', () => {
    const result = parseFlagsMutation('+moj');
    expect('flags' in result).toBe(true);
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('moj');
    }
  });

  it('subtracts letters with -flags', () => {
    const result = parseFlagsMutation('-j', parseCanonicalFlags('moj'));
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('mo');
    }
  });

  it('combines +add and -remove tokens', () => {
    const result = parseFlagsMutation('+d -m', parseCanonicalFlags('moj'));
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('ojd');
    }
  });

  it('expands +all to every known letter', () => {
    const result = parseFlagsMutation('+all');
    if ('flags' in result) {
      expect(result.flags.size).toBe(CONSOLE_FLAG_LETTERS.length);
      for (const l of CONSOLE_FLAG_LETTERS) expect(result.flags.has(l)).toBe(true);
    }
  });

  it('expands -all to an empty set', () => {
    const result = parseFlagsMutation('-all', parseCanonicalFlags('mojkdwpbs'));
    if ('flags' in result) {
      expect(result.flags.size).toBe(0);
    }
  });

  it('allows combining -all with + letters in one call', () => {
    const result = parseFlagsMutation('-all +mw', parseCanonicalFlags('mojk'));
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('mw');
    }
  });

  it('rejects unknown letters', () => {
    const result = parseFlagsMutation('+z');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('z');
    }
  });

  it('accepts letters without a leading +', () => {
    const result = parseFlagsMutation('mw');
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('mw');
    }
  });

  it('parseCanonicalFlags drops unknown letters silently', () => {
    const set = parseCanonicalFlags('mzjx');
    expect(formatFlags(set)).toBe('mj');
  });

  it('formatFlags produces the canonical letter order', () => {
    // Unsorted input, canonical output order from CONSOLE_FLAG_LETTERS.
    expect(formatFlags(['w', 'm', 'j'])).toBe('mjw');
  });

  it('isConsoleFlagLetter recognizes valid letters', () => {
    expect(isConsoleFlagLetter('m')).toBe(true);
    expect(isConsoleFlagLetter('z')).toBe(false);
    expect(isConsoleFlagLetter('')).toBe(false);
  });

  it('DEFAULT_CONSOLE_FLAGS is the expected canonical string', () => {
    expect(DEFAULT_CONSOLE_FLAGS).toBe('mojw');
  });

  it('an empty input leaves the base set unchanged', () => {
    const result = parseFlagsMutation('', parseCanonicalFlags('mj'));
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('mj');
    }
  });

  it('whitespace-only input leaves the base set unchanged', () => {
    const result = parseFlagsMutation('   ', parseCanonicalFlags('o'));
    if ('flags' in result) {
      expect(formatFlags(result.flags)).toBe('o');
    }
  });

  it('parseCanonicalFlags returns an empty set for null input', () => {
    expect(parseCanonicalFlags(null).size).toBe(0);
    expect(parseCanonicalFlags(undefined).size).toBe(0);
  });
});

describe('dcc-console-flags — categorize', () => {
  it('honors an explicit #category override on the source', () => {
    expect(categorize('plugin:chanmod#k', 'info')).toBe('k');
  });

  it('extractExplicitCategory returns null when no suffix is present', () => {
    expect(extractExplicitCategory('plugin:chanmod')).toBeNull();
  });

  it('extractExplicitCategory returns null for an unknown suffix letter', () => {
    expect(extractExplicitCategory('plugin:chanmod#z')).toBeNull();
  });

  it('routes debug-level records to the d category regardless of source', () => {
    expect(categorize('bot', 'debug')).toBe('d');
    expect(categorize(null, 'debug')).toBe('d');
  });

  it('routes known operator sources to o', () => {
    expect(categorize('plugin:chanmod', 'info')).toBe('o');
    expect(categorize('irc-commands', 'info')).toBe('o');
  });

  it('routes connection/reconnect sources to s', () => {
    expect(categorize('connection', 'info')).toBe('s');
    expect(categorize('reconnect', 'info')).toBe('s');
    expect(categorize('sts', 'info')).toBe('s');
  });

  it('routes channel-state and join-related plugins to j', () => {
    expect(categorize('channel-state', 'info')).toBe('j');
    expect(categorize('plugin:greeter', 'info')).toBe('j');
    expect(categorize('plugin:seen', 'info')).toBe('j');
  });

  it('routes unknown sources to the m fallback', () => {
    expect(categorize('brand-new-subsystem', 'info')).toBe('m');
    expect(categorize(null, 'info')).toBe('m');
  });
});

describe('dcc-console-flags — shouldDeliverToSession', () => {
  it('delivers warn records when w is set', () => {
    const flags = parseCanonicalFlags('w');
    expect(shouldDeliverToSession(makeRecord({ level: 'warn', source: 'bot' }), flags)).toBe(true);
  });

  it('delivers error records when w is set', () => {
    const flags = parseCanonicalFlags('w');
    expect(shouldDeliverToSession(makeRecord({ level: 'error', source: 'bot' }), flags)).toBe(true);
  });

  it('drops debug records when d is not set', () => {
    const flags = parseCanonicalFlags('mojw');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'debug', source: 'dispatcher' }), flags),
    ).toBe(false);
  });

  it('delivers debug records when d is set', () => {
    const flags = parseCanonicalFlags('d');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'debug', source: 'dispatcher' }), flags),
    ).toBe(true);
  });

  it('delivers an info chanmod line when o is set', () => {
    const flags = parseCanonicalFlags('o');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'info', source: 'plugin:chanmod' }), flags),
    ).toBe(true);
  });

  it('drops an info chanmod line when o is cleared', () => {
    const flags = parseCanonicalFlags('mjw');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'info', source: 'plugin:chanmod' }), flags),
    ).toBe(false);
  });

  it('routes explicitly-categorised k lines to k', () => {
    const flags = parseCanonicalFlags('k');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'info', source: 'plugin:chanmod#k' }), flags),
    ).toBe(true);
    expect(
      shouldDeliverToSession(
        makeRecord({ level: 'info', source: 'plugin:chanmod#k' }),
        parseCanonicalFlags('o'),
      ),
    ).toBe(false);
  });

  it('falls through to the category rule when w is unset for warn records', () => {
    // A warn from chanmod, no w, but o is on — fall through to category.
    const flags = parseCanonicalFlags('o');
    expect(
      shouldDeliverToSession(makeRecord({ level: 'warn', source: 'plugin:chanmod' }), flags),
    ).toBe(true);
  });
});

describe('dcc-console-flags — kv key shape', () => {
  it('consoleFlagKey embeds the handle', () => {
    expect(consoleFlagKey('admin')).toBe('console_flags:admin');
  });
});
