import { describe, expect, it } from 'vitest';

import { splitMessage } from '../../src/utils/split-message';

describe('splitMessage', () => {
  describe('word-boundary splitting', () => {
    it('should split a long line at the last space before maxBytes', () => {
      // 10-char words joined by spaces: "aaaaaaaaaa bbbbbbbbbb cccccccccc"
      // With maxBytes=20, the last space at or before index 20 is at index 10.
      const text = 'aaaaaaaaaa bbbbbbbbbb cccccccccc';
      const result = splitMessage(text, 20, 10);
      expect(result).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    });

    it('should split into multiple chunks when text is much longer than maxBytes', () => {
      // Four 8-char words: "wordAAAA wordBBBB wordCCCC wordDDDD"
      // With maxBytes=15, each split should carry one word per line
      const text = 'wordAAAA wordBBBB wordCCCC wordDDDD';
      const result = splitMessage(text, 15, 10);
      expect(result).toEqual(['wordAAAA', 'wordBBBB', 'wordCCCC', 'wordDDDD']);
    });

    it('should push the remaining tail after the splitting loop finishes', () => {
      // "aaaaaaaaaa bb" with maxBytes=11 => split at space index 10 => "aaaaaaaaaa" + "bb"
      const text = 'aaaaaaaaaa bb';
      const result = splitMessage(text, 11, 10);
      expect(result).toEqual(['aaaaaaaaaa', 'bb']);
    });

    it('should trim leading spaces from the remaining text after each split', () => {
      // Ensure that after splitting at a space, leading whitespace on the remainder is removed
      // "hello world   extra" — spaces at indices 5, 11, 12, 13
      // maxBytes=11: lastIndexOf(' ', 11) = 11 => substring(0,11) = "hello world"
      // remainder = "   extra".trimStart() => "extra"
      const text = 'hello world   extra';
      const result = splitMessage(text, 11, 10);
      expect(result).toEqual(['hello world', 'extra']);
    });
  });

  describe('hard split (no space found)', () => {
    it('should hard-split when a single word exceeds maxBytes', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const result = splitMessage(text, 10, 10);
      // 26 chars, maxBytes=10 => "abcdefghij" + "klmnopqrst" + "uvwxyz"
      expect(result).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    });

    it('should hard-split when the only space is at index 0', () => {
      // lastIndexOf(' ', 10) returns 0, which triggers splitIdx <= 0 branch
      const text = ' aaaaaaaaaabbbbbbbbbb';
      const result = splitMessage(text, 10, 10);
      // remaining starts as " aaaaaaaaaabbbbbbbbbb" (21 chars)
      // lastIndexOf(' ', 10) = 0, so splitIdx <= 0 => hard split at 10 => " aaaaaaaaa"
      // remainder "abbbbbbbbbb" (11 chars) > 10 => lastIndexOf(' ', 10) = -1 => hard split at 10 => "abbbbbbbbb"
      // remainder "b" pushed as tail
      expect(result).toEqual([' aaaaaaaaa', 'abbbbbbbbb', 'b']);
    });

    it('should handle a single long word with no spaces at all', () => {
      const text = 'x'.repeat(25);
      const result = splitMessage(text, 10, 10);
      expect(result).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    });

    it('should not push an empty tail when the line ends with trailing spaces', () => {
      // "aaaa " is 5 chars, maxBytes=4. lastIndexOf(' ', 4) = 4,
      // push "aaaa", remaining = "".trimStart() = "" (falsy), so nothing more is pushed.
      const text = 'aaaa ';
      const result = splitMessage(text, 4, 10);
      expect(result).toEqual(['aaaa']);
    });
  });

  describe('truncation at maxLines', () => {
    it('should truncate output and append "..." when lines exceed maxLines', () => {
      const text = 'line1\nline2\nline3\nline4\nline5';
      const result = splitMessage(text, 400, 3);
      expect(result).toEqual(['line1', 'line2', 'line3 ...']);
    });

    it('should truncate when word-boundary splitting produces too many lines', () => {
      // 6 words of 8 chars each, maxBytes=10 forces one word per line, maxLines=3.
      // "wordCCCC" is 8 bytes; appending " ..." (4 bytes) would overflow the
      // 10-byte budget, so the last line is trimmed to "wordCC ..." (10 bytes).
      const text = 'wordAAAA wordBBBB wordCCCC wordDDDD wordEEEE wordFFFF';
      const result = splitMessage(text, 10, 3);
      expect(result).toEqual(['wordAAAA', 'wordBBBB', 'wordCC ...']);
      expect(result.length).toBe(3);
    });

    it('should truncate when hard splits produce too many lines', () => {
      // 50-char string with no spaces, maxBytes=10, maxLines=2.
      // Last line is trimmed from 10 a's to 6 a's to make room for " ...".
      const text = 'a'.repeat(50);
      const result = splitMessage(text, 10, 2);
      expect(result).toEqual(['a'.repeat(10), 'a'.repeat(6) + ' ...']);
      expect(result.length).toBe(2);
    });

    it('should not truncate when lines exactly equal maxLines', () => {
      const text = 'line1\nline2\nline3';
      const result = splitMessage(text, 400, 3);
      expect(result).toEqual(['line1', 'line2', 'line3']);
    });

    it('should append "..." to the last allowed line on truncation', () => {
      const text = 'a\nb\nc\nd\ne';
      const result = splitMessage(text, 400, 2);
      expect(result).toEqual(['a', 'b ...']);
    });
  });

  describe('mixed scenarios', () => {
    it('should handle newlines combined with long lines that need splitting', () => {
      const text = 'short\n' + 'a'.repeat(25);
      const result = splitMessage(text, 10, 10);
      expect(result).toEqual(['short', 'a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    });

    it('should stop processing input lines early when maxLines is exceeded', () => {
      // First line splits into 3 chunks, maxLines=2, so second input line is never reached.
      // Last line trimmed to 6 a's to fit " ..." within the 10-byte budget.
      const text = 'a'.repeat(30) + '\nshould not appear';
      const result = splitMessage(text, 10, 2);
      expect(result).toEqual(['a'.repeat(10), 'a'.repeat(6) + ' ...']);
    });
  });

  describe('UTF-8 byte counting (§1)', () => {
    it('should split by bytes, not UTF-16 code units, for multi-byte characters', () => {
      // Japanese — each codepoint is 3 UTF-8 bytes.
      // 10 hiragana = 30 bytes; budget 15 bytes must split after 5 codepoints.
      const text = 'あいうえおかきくけこ';
      const result = splitMessage(text, 15, 10);
      expect(result).toEqual(['あいうえお', 'かきくけこ']);
      // Confirm each chunk is within budget
      for (const chunk of result) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(15);
      }
    });

    it('should never split a surrogate pair (emoji)', () => {
      // 🙂 is U+1F642 — two UTF-16 code units, 4 UTF-8 bytes.
      // A naive .length-based splitter would cut mid-surrogate and produce mojibake.
      const text = '🙂🙂🙂🙂🙂';
      const result = splitMessage(text, 12, 10);
      // 12-byte budget fits 3 emoji (12 bytes) per line.
      expect(result).toEqual(['🙂🙂🙂', '🙂🙂']);
      // Each chunk must be valid UTF-8 — round-trip through Buffer to detect mojibake.
      for (const chunk of result) {
        const bytes = Buffer.from(chunk, 'utf8');
        expect(bytes.toString('utf8')).toBe(chunk);
      }
    });

    it('should word-split Cyrillic by byte budget', () => {
      // Each Cyrillic letter is 2 UTF-8 bytes.
      // "привет мир" = 6*2 + 1 + 3*2 = 19 bytes; "привет" alone = 12 bytes.
      const text = 'привет мир';
      const result = splitMessage(text, 13, 10);
      expect(result).toEqual(['привет', 'мир']);
    });

    it('should append ellipsis without overflowing budget on multi-byte content', () => {
      // 4 hiragana (12 bytes) forced onto 2 lines with a 10-byte budget.
      // Last line must fit within 10 bytes including " ..." (4 ASCII bytes).
      const text = 'あいうえおかきくけこ';
      const result = splitMessage(text, 10, 2);
      for (const chunk of result) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(10);
      }
      expect(result[result.length - 1].endsWith(' ...')).toBe(true);
    });

    it('should handle a ZWJ emoji sequence without corrupting bytes', () => {
      // 👨‍👩‍👧 is a family ZWJ sequence — 18 UTF-8 bytes total.
      // With a 20-byte budget the whole thing fits on one line.
      const text = '👨‍👩‍👧';
      const result = splitMessage(text, 20, 10);
      expect(result).toEqual([text]);
      expect(Buffer.from(result[0], 'utf8').toString('utf8')).toBe(text);
    });
  });

  describe('reservedBytes (§1)', () => {
    it('should subtract reservedBytes from the effective byte budget', () => {
      // Budget 20, reserved 10 → effective 10.
      const text = 'a'.repeat(30);
      const result = splitMessage(text, 20, 10, 10);
      expect(result).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(10)]);
    });

    it('should never produce a zero-byte budget even when reservedBytes >= maxBytes', () => {
      // Degenerate config — the splitter clamps to at least 1 byte rather than
      // infinite-looping or dividing by zero.
      const result = splitMessage('abcde', 10, 10, 100);
      expect(result.length).toBeGreaterThan(0);
      // Each chunk must still be non-empty
      for (const chunk of result) expect(chunk.length).toBeGreaterThan(0);
    });
  });

  describe('hard input-size cap', () => {
    it('clips inputs beyond 10 MiB before byte-scanning them', () => {
      // A plugin forwarding a multi-MB buffer would otherwise have every
      // newline segment run through `Buffer.byteLength`. The entry cap
      // keeps that scan bounded. Just verify we don't hang and the
      // output is limited to maxLines.
      const oversized = 'x'.repeat(12 * 1024 * 1024);
      const start = Date.now();
      const result = splitMessage(oversized, 400, 4);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1_000); // sanity: no megabyte-scale O(n²)
      expect(result.length).toBeLessThanOrEqual(4);
    });
  });
});
