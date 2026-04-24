import { describe, expect, it } from 'vitest';

import { escapeLikePattern } from '../../src/utils/sql';

describe('escapeLikePattern', () => {
  it('escapes percent signs', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
  });

  it('escapes underscores', () => {
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
  });

  it('escapes backslashes before other metacharacters so the escape char itself is safe', () => {
    // `\%` in the input must become `\\\%` (backslash-escaped backslash +
    // escaped percent) so the ESCAPE '\\' clause interprets the trailing
    // percent as a literal.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('escapes all three metacharacters in one pass', () => {
    expect(escapeLikePattern('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });

  it('returns plain input unchanged', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world');
  });

  it('returns empty string unchanged', () => {
    expect(escapeLikePattern('')).toBe('');
  });
});
