import { describe, it, expect } from 'vitest';
import { wildcardMatch } from '../../src/utils/wildcard.js';

describe('wildcardMatch', () => {
  describe('exact match', () => {
    it('should match identical strings', () => {
      expect(wildcardMatch('hello', 'hello')).toBe(true);
    });

    it('should not match different strings', () => {
      expect(wildcardMatch('hello', 'world')).toBe(false);
    });

    it('should not match when lengths differ', () => {
      expect(wildcardMatch('hello', 'hell')).toBe(false);
      expect(wildcardMatch('hell', 'hello')).toBe(false);
    });
  });

  describe('* wildcard', () => {
    it('should match any string with lone *', () => {
      expect(wildcardMatch('*', '')).toBe(true);
      expect(wildcardMatch('*', 'anything')).toBe(true);
      expect(wildcardMatch('*', 'hello world')).toBe(true);
    });

    it('should match prefix with trailing *', () => {
      expect(wildcardMatch('hello*', 'hello')).toBe(true);
      expect(wildcardMatch('hello*', 'hello world')).toBe(true);
      expect(wildcardMatch('hello*', 'hell')).toBe(false);
    });

    it('should match suffix with leading *', () => {
      expect(wildcardMatch('*world', 'world')).toBe(true);
      expect(wildcardMatch('*world', 'hello world')).toBe(true);
      expect(wildcardMatch('*world', 'worlds')).toBe(false);
    });

    it('should match *word* pattern (contains)', () => {
      expect(wildcardMatch('*ello*', 'hello world')).toBe(true);
      expect(wildcardMatch('*ello*', 'yellow')).toBe(true);
      expect(wildcardMatch('*ello*', 'elk')).toBe(false);
    });

    it('should handle multiple * wildcards', () => {
      expect(wildcardMatch('*a*b*', 'aXb')).toBe(true);
      expect(wildcardMatch('*a*b*', 'Xab')).toBe(true);
      expect(wildcardMatch('*a*b*', 'ba')).toBe(false);
    });

    it('should handle consecutive *', () => {
      expect(wildcardMatch('**', 'anything')).toBe(true);
      expect(wildcardMatch('a**b', 'aXYZb')).toBe(true);
    });
  });

  describe('? wildcard', () => {
    it('should match exactly one character', () => {
      expect(wildcardMatch('h?llo', 'hello')).toBe(true);
      expect(wildcardMatch('h?llo', 'hallo')).toBe(true);
    });

    it('should not match zero characters', () => {
      expect(wildcardMatch('h?llo', 'hllo')).toBe(false);
    });

    it('should not match more than one character', () => {
      expect(wildcardMatch('h?llo', 'heello')).toBe(false);
    });

    it('should handle multiple ? wildcards', () => {
      expect(wildcardMatch('??', 'ab')).toBe(true);
      expect(wildcardMatch('??', 'a')).toBe(false);
      expect(wildcardMatch('??', 'abc')).toBe(false);
    });
  });

  describe('combined * and ?', () => {
    it('should work with both wildcards', () => {
      expect(wildcardMatch('h?llo*', 'hello world')).toBe(true);
      expect(wildcardMatch('*?orld', 'hello world')).toBe(true);
    });
  });

  describe('case-insensitive mode', () => {
    it('should match case-insensitively when flag is true', () => {
      expect(wildcardMatch('HELLO', 'hello', true)).toBe(true);
      expect(wildcardMatch('hello', 'HELLO', true)).toBe(true);
      expect(wildcardMatch('Hello', 'hElLo', true)).toBe(true);
    });

    it('should not match case-insensitively when flag is false', () => {
      expect(wildcardMatch('HELLO', 'hello', false)).toBe(false);
      expect(wildcardMatch('HELLO', 'hello')).toBe(false);
    });

    it('should work with wildcards in case-insensitive mode', () => {
      expect(wildcardMatch('*WORLD', 'hello world', true)).toBe(true);
      expect(wildcardMatch('H?LLO', 'hello', true)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should match empty pattern against empty text', () => {
      expect(wildcardMatch('', '')).toBe(true);
    });

    it('should not match empty pattern against non-empty text', () => {
      expect(wildcardMatch('', 'hello')).toBe(false);
    });

    it('should match * pattern against empty text', () => {
      expect(wildcardMatch('*', '')).toBe(true);
    });

    it('should not match non-* pattern against empty text', () => {
      expect(wildcardMatch('?', '')).toBe(false);
      expect(wildcardMatch('a', '')).toBe(false);
    });

    it('should handle IRC hostmask patterns', () => {
      expect(wildcardMatch('*!*@*.host.com', 'nick!ident@some.host.com')).toBe(true);
      expect(wildcardMatch('*!*@*.host.com', 'nick!ident@other.net')).toBe(false);
      expect(wildcardMatch('nick!*@*', 'nick!anything@anywhere')).toBe(true);
    });

    it('should handle IRC channel mask patterns', () => {
      expect(wildcardMatch('#test *!*@*', '#test nick!user@host')).toBe(true);
    });
  });
});
