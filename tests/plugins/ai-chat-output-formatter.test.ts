import { describe, expect, it } from 'vitest';

import { formatResponse, isFantasyLine } from '../../plugins/ai-chat/output-formatter';

describe('formatResponse', () => {
  it('returns empty array for empty input', () => {
    expect(formatResponse('', 4, 400)).toEqual([]);
    expect(formatResponse('   \n\n   ', 4, 400)).toEqual([]);
  });

  it('strips bold/italic/code markdown', () => {
    expect(formatResponse('**bold** and *italic* and `code`', 4, 400)).toEqual([
      'bold and italic and code',
    ]);
  });

  it('strips headers', () => {
    expect(formatResponse('# Heading\nbody', 4, 400)).toEqual(['Heading', 'body']);
  });

  it('strips block quotes', () => {
    expect(formatResponse('> quoted', 4, 400)).toEqual(['quoted']);
  });

  it('converts markdown lists to dash bullets', () => {
    expect(formatResponse('* one\n* two\n1. three', 4, 400)).toEqual(['- one', '- two', '- three']);
  });

  it('converts markdown links to "text (url)"', () => {
    expect(formatResponse('See [docs](http://x.com) for more.', 4, 400)).toEqual([
      'See docs (http://x.com) for more.',
    ]);
  });

  it('strips \\r and NULs', () => {
    expect(formatResponse('hi\rworld\0', 4, 400)).toEqual(['hiworld']);
  });

  it('strips IRC color codes', () => {
    expect(formatResponse('\x0304red\x03 text \x02bold\x02', 4, 400)).toEqual(['red text bold']);
  });

  it('collapses runs of whitespace', () => {
    expect(formatResponse('too     many    spaces', 4, 400)).toEqual(['too many spaces']);
  });

  it('collapses blank lines', () => {
    expect(formatResponse('one\n\n\ntwo', 4, 400)).toEqual(['one', 'two']);
  });

  it('splits long line at sentence boundary when possible', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const out = formatResponse(text, 4, 32);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Each line must respect the length cap.
    for (const line of out) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('splits long line at word boundary when no sentence break exists', () => {
    const text = 'word '.repeat(50).trim();
    const out = formatResponse(text, 10, 40);
    for (const line of out) {
      expect(line.length).toBeLessThanOrEqual(40);
      // Should not split mid-word
      expect(line.startsWith(' ') || line.endsWith(' ')).toBe(false);
    }
  });

  it('hard-splits a line with no spaces', () => {
    const text = 'x'.repeat(200);
    const out = formatResponse(text, 10, 40);
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('truncates to maxLines with ellipsis', () => {
    const text = 'line1\nline2\nline3\nline4\nline5\nline6';
    const out = formatResponse(text, 3, 400);
    expect(out).toHaveLength(3);
    expect(out[2]).toContain('…');
  });

  it('does not add ellipsis when lines fit within maxLines', () => {
    const out = formatResponse('a\nb\nc', 4, 400);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('handles unicode correctly', () => {
    expect(formatResponse('héllo 世界 🌍', 4, 400)).toEqual(['héllo 世界 🌍']);
  });

  it('strips code fences', () => {
    expect(formatResponse('```typescript\nconst x = 1;\n```', 4, 400)).toEqual(['const x = 1;']);
  });

  it('leaves plain text untouched', () => {
    expect(formatResponse('Just a plain sentence.', 4, 400)).toEqual(['Just a plain sentence.']);
  });

  it('returns empty when stripping leaves nothing', () => {
    expect(formatResponse('\x00\x01\x02', 4, 400)).toEqual([]);
  });

  // ChanServ fantasy-command defence — see docs/audits/security-ai-injection-threat-2026-04-16.md
  // The entire response is dropped if ANY line starts with a fantasy prefix.
  it('drops response when a line starts with "." (ChanServ fantasy)', () => {
    expect(formatResponse('.deop admin', 4, 400)).toEqual([]);
  });

  it('drops response when a line starts with "!"', () => {
    expect(formatResponse('!kick target', 4, 400)).toEqual([]);
  });

  it('drops response when a line starts with "/"', () => {
    expect(formatResponse('/msg ChanServ OWNER attacker', 4, 400)).toEqual([]);
  });

  it('drops entire multi-line response if any line has a fantasy prefix', () => {
    // Even though line 1 is safe, lines 2-3 are compromised → drop everything
    expect(formatResponse('Sure thing!\n.deop admin\n.kick admin', 4, 400)).toEqual([]);
  });

  it('drops response when split chunks produce a fantasy-prefix line', () => {
    // Force a split where a chunk begins with ". …"
    const text = 'Say this. .deop admin please.';
    const out = formatResponse(text, 4, 12);
    // Entire response is dropped because a chunk starts with "."
    expect(out).toEqual([]);
  });

  it('drops response for extended fantasy prefixes (~@%$&+)', () => {
    expect(formatResponse('~command arg', 4, 400)).toEqual([]);
    expect(formatResponse('@op me', 4, 400)).toEqual([]);
    expect(formatResponse('%halfop', 4, 400)).toEqual([]);
    expect(formatResponse('$special', 4, 400)).toEqual([]);
    expect(formatResponse('&chanop', 4, 400)).toEqual([]);
    expect(formatResponse('+voice me', 4, 400)).toEqual([]);
  });

  it('leaves "-" bullet lines untouched (not a fantasy prefix)', () => {
    expect(formatResponse('- first\n- second', 4, 400)).toEqual(['- first', '- second']);
  });

  it('does NOT drop responses where fantasy chars are mid-string', () => {
    expect(formatResponse('see .config or !help', 4, 400)).toEqual(['see .config or !help']);
  });

  it('isFantasyLine returns false for safe starts', () => {
    expect(isFantasyLine('hello')).toBe(false);
    expect(isFantasyLine('- dash')).toBe(false);
    expect(isFantasyLine('')).toBe(false);
  });

  it('isFantasyLine returns true for all known fantasy prefixes', () => {
    expect(isFantasyLine('.op x')).toBe(true);
    expect(isFantasyLine('!kick x')).toBe(true);
    expect(isFantasyLine('/mode +o')).toBe(true);
    expect(isFantasyLine('~command')).toBe(true);
    expect(isFantasyLine('@op')).toBe(true);
    expect(isFantasyLine('%half')).toBe(true);
    expect(isFantasyLine('$spec')).toBe(true);
    expect(isFantasyLine('&chan')).toBe(true);
    expect(isFantasyLine('+voice')).toBe(true);
  });

  it('strips Unicode zero-width chars that would hide a fantasy prefix', () => {
    // ZWSP (U+200B) before `.deop admin` — without stripping, the invisible char
    // would sit at position 0 and isFantasyLine would miss the dot.
    expect(formatResponse('\u200b.deop admin', 4, 400)).toEqual([]);
    // ZWJ (U+200D)
    expect(formatResponse('\u200d.op attacker', 4, 400)).toEqual([]);
    // BOM (U+FEFF)
    expect(formatResponse('\ufeff.kick admin', 4, 400)).toEqual([]);
    // Bidi override (U+202E) — right-to-left override
    expect(formatResponse('\u202e.deop admin', 4, 400)).toEqual([]);
    // Word joiner (U+2060)
    expect(formatResponse('\u2060.deop admin', 4, 400)).toEqual([]);
  });

  it('strips Unicode format chars interleaved throughout the message', () => {
    // Attacker could insert ZWSPs between every char to defeat simple checks.
    // We strip them all, then the dot is at position 0 → response dropped.
    expect(formatResponse('.\u200bd\u200be\u200bo\u200bp admin', 4, 400)).toEqual([]);
  });

  it('drops response for multi-char prefix sequences (.., !!, //)', () => {
    expect(isFantasyLine('..deop admin')).toBe(true);
    expect(isFantasyLine('!!kick user')).toBe(true);
    expect(isFantasyLine('///topic foo')).toBe(true);
    expect(formatResponse('..deop admin', 4, 400)).toEqual([]);
  });

  // Atheme strtok simulation — regression test for the space-prepend bypass
  it('formatted output is never parseable as fantasy by Atheme strtok', () => {
    function athemeWouldParse(msg: string, prefix = '.!/'): boolean {
      const token = msg.trimStart().split(' ')[0];
      return token.length >= 2 && prefix.includes(token[0]) && /[a-zA-Z]/.test(token[1]);
    }

    for (const input of ['.deop admin', '!kick user', '/mode +o evil']) {
      const lines = formatResponse(input, 4, 400);
      // Response is dropped entirely — no lines to parse
      expect(lines).toEqual([]);
      for (const line of lines) {
        expect(athemeWouldParse(line)).toBe(false);
      }
    }
  });

  it('truncates last line if even ellipsis suffix wont fit', () => {
    // When the final line is already at the max length, appending suffix must still fit.
    const text =
      'a'.repeat(40) + '\n' + 'b'.repeat(40) + '\n' + 'c'.repeat(40) + '\n' + 'd'.repeat(40);
    const out = formatResponse(text, 3, 40);
    expect(out).toHaveLength(3);
    expect(out[2].endsWith('…')).toBe(true);
    expect(out[2].length).toBeLessThanOrEqual(40);
  });
});
