import { describe, expect, it } from 'vitest';

import { splitMessage } from '../../src/utils/split-message.js';

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
      // 6 words of 8 chars each, maxBytes=10 forces one word per line, maxLines=3
      const text = 'wordAAAA wordBBBB wordCCCC wordDDDD wordEEEE wordFFFF';
      const result = splitMessage(text, 10, 3);
      expect(result).toEqual(['wordAAAA', 'wordBBBB', 'wordCCCC ...']);
      expect(result.length).toBe(3);
    });

    it('should truncate when hard splits produce too many lines', () => {
      // 50-char string with no spaces, maxBytes=10, maxLines=2
      const text = 'a'.repeat(50);
      const result = splitMessage(text, 10, 2);
      expect(result).toEqual(['a'.repeat(10), 'a'.repeat(10) + ' ...']);
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
      // First line splits into 3 chunks, maxLines=2, so second input line is never reached
      const text = 'a'.repeat(30) + '\nshould not appear';
      const result = splitMessage(text, 10, 2);
      expect(result).toEqual(['a'.repeat(10), 'a'.repeat(10) + ' ...']);
    });
  });
});
