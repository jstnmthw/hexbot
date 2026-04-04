import { describe, expect, it } from 'vitest';

import { formatResponse, neutralizeFantasyPrefix } from '../../plugins/ai-chat/output-formatter';

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

  // ChanServ fantasy-command prefix neutralization — see docs/audits/ai-chat-llm-injection-2026-04-05.md
  it('prepends a space to lines starting with "." (ChanServ fantasy)', () => {
    expect(formatResponse('.deop admin', 4, 400)).toEqual([' .deop admin']);
  });

  it('prepends a space to lines starting with "!"', () => {
    expect(formatResponse('!kick target', 4, 400)).toEqual([' !kick target']);
  });

  it('prepends a space to lines starting with "/"', () => {
    expect(formatResponse('/msg ChanServ OWNER attacker', 4, 400)).toEqual([
      ' /msg ChanServ OWNER attacker',
    ]);
  });

  it('neutralizes fantasy prefix on each line of a multi-line response', () => {
    expect(formatResponse('Sure thing!\n.deop admin\n.kick admin', 4, 400)).toEqual([
      'Sure thing!',
      ' .deop admin',
      ' .kick admin',
    ]);
  });

  it('neutralizes fantasy prefix on split chunks of a long sentence', () => {
    // Force a split where a chunk begins with ". …"
    const text = 'Say this. .deop admin please.';
    const out = formatResponse(text, 4, 12);
    // Any chunk that starts with a fantasy char must be prefixed with a space
    for (const line of out) {
      if (/[.!/]/.test(line[0])) {
        throw new Error(`Line starts with unescaped fantasy prefix: ${JSON.stringify(line)}`);
      }
    }
  });

  it('leaves "-" bullet lines untouched (not a fantasy prefix)', () => {
    expect(formatResponse('- first\n- second', 4, 400)).toEqual(['- first', '- second']);
  });

  it('does NOT neutralize lines that contain fantasy chars mid-string', () => {
    expect(formatResponse('see .config or !help', 4, 400)).toEqual(['see .config or !help']);
  });

  it('neutralizeFantasyPrefix returns input unchanged for safe starts', () => {
    expect(neutralizeFantasyPrefix('hello')).toBe('hello');
    expect(neutralizeFantasyPrefix('- dash')).toBe('- dash');
    expect(neutralizeFantasyPrefix('')).toBe('');
  });

  it('neutralizeFantasyPrefix prepends exactly one space', () => {
    expect(neutralizeFantasyPrefix('.op x')).toBe(' .op x');
    expect(neutralizeFantasyPrefix('!kick x')).toBe(' !kick x');
    expect(neutralizeFantasyPrefix('/mode +o')).toBe(' /mode +o');
  });

  it('strips Unicode zero-width chars that would hide a fantasy prefix', () => {
    // ZWSP (U+200B) before `.deop admin` — without stripping, neutralizeFantasyPrefix
    // would see ZWSP at position 0 and do nothing, letting services strip the
    // ZWSP and act on `.deop`.
    expect(formatResponse('\u200b.deop admin', 4, 400)).toEqual([' .deop admin']);
    // ZWJ (U+200D)
    expect(formatResponse('\u200d.op attacker', 4, 400)).toEqual([' .op attacker']);
    // BOM (U+FEFF)
    expect(formatResponse('\ufeff.kick admin', 4, 400)).toEqual([' .kick admin']);
    // Bidi override (U+202E) — right-to-left override
    expect(formatResponse('\u202e.deop admin', 4, 400)).toEqual([' .deop admin']);
    // Word joiner (U+2060)
    expect(formatResponse('\u2060.deop admin', 4, 400)).toEqual([' .deop admin']);
  });

  it('strips Unicode format chars interleaved throughout the message', () => {
    // Attacker could insert ZWSPs between every char to defeat simple checks.
    // We just strip them all.
    expect(formatResponse('.\u200bd\u200be\u200bo\u200bp admin', 4, 400)).toEqual([' .deop admin']);
  });

  it('catches multi-char prefix sequences (.., !!, //)', () => {
    // Any line starting with ./!/ is caught regardless of what follows —
    // including networks that configure multi-char fantasy triggers.
    expect(neutralizeFantasyPrefix('..deop admin')).toBe(' ..deop admin');
    expect(neutralizeFantasyPrefix('!!kick user')).toBe(' !!kick user');
    expect(neutralizeFantasyPrefix('///topic foo')).toBe(' ///topic foo');
  });

  it('leading space survives sanitize() and splitMessage()', async () => {
    // Verify that the downstream path (irc-bridge's ctx.reply → sanitize → splitMessage)
    // does NOT strip the leading space we inject. If it did, the CRITICAL fix would
    // be defeated silently.
    const { sanitize } = await import('../../src/utils/sanitize');
    const { splitMessage } = await import('../../src/utils/split-message');
    const neutralized = ' .deop admin';
    const afterSanitize = sanitize(neutralized);
    expect(afterSanitize).toBe(neutralized);
    const afterSplit = splitMessage(afterSanitize);
    expect(afterSplit).toEqual([neutralized]);
    expect(afterSplit[0][0]).toBe(' ');
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
