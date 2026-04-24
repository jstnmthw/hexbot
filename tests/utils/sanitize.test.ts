import { describe, expect, it } from 'vitest';

import { sanitize } from '../../src/utils/sanitize';

describe('sanitize', () => {
  it('strips CR, LF, and NUL', () => {
    expect(sanitize('hello\r\nworld\0!')).toBe('helloworld!');
  });

  it('strips U+0085 NEL', () => {
    expect(sanitize('a\x85b')).toBe('ab');
  });

  it('strips U+2028 LS (line separator)', () => {
    expect(sanitize('a b')).toBe('ab');
  });

  it('strips U+2029 PS (paragraph separator)', () => {
    expect(sanitize('a b')).toBe('ab');
  });

  it('strips all line separators in a single pass', () => {
    expect(sanitize('a\rb\nc\0d\x85e f g')).toBe('abcdefg');
  });

  it('coerces numeric input to string without throwing', () => {
    // Callers occasionally pass numbers (timestamps, counters) to formatters
    // that eventually reach sanitize(). The defensive coercion keeps the
    // hot path cheap and eliminates a class of TypeError crashes.
    expect(sanitize(42 as unknown as string)).toBe('42');
  });

  it('coerces null to empty string', () => {
    expect(sanitize(null as unknown as string)).toBe('');
  });

  it('coerces undefined to empty string', () => {
    expect(sanitize(undefined as unknown as string)).toBe('');
  });

  it('returns a safe string for plain input', () => {
    expect(sanitize('hello world')).toBe('hello world');
  });
});
