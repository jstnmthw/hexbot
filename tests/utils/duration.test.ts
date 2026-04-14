import { describe, expect, it } from 'vitest';

import { formatDuration, parseDuration } from '../../src/utils/duration';

describe('parseDuration', () => {
  it('parses minutes suffix', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('1m')).toBe(60_000);
  });

  it('parses hours suffix', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('parses days suffix', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('is case-insensitive', () => {
    expect(parseDuration('5M')).toBe(300_000);
    expect(parseDuration('2H')).toBe(7_200_000);
    expect(parseDuration('1D')).toBe(86_400_000);
  });

  it('parses bare number as minutes (backward compat)', () => {
    expect(parseDuration('30')).toBe(1_800_000);
    expect(parseDuration('60')).toBe(3_600_000);
    expect(parseDuration('1')).toBe(60_000);
  });

  it('"0" means permanent (returns 0)', () => {
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('0m')).toBe(0);
    expect(parseDuration('0h')).toBe(0);
    expect(parseDuration('0d')).toBe(0);
  });

  it('returns null for invalid input', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('5.5m')).toBeNull();
    expect(parseDuration('m')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseDuration(' 5m ')).toBe(300_000);
    expect(parseDuration('  30  ')).toBe(1_800_000);
  });
});

describe('formatDuration', () => {
  it('formats minutes only', () => {
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(2_700_000)).toBe('45m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(8_100_000)).toBe('2h 15m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('formats days, hours, and minutes', () => {
    expect(formatDuration(90_060_000)).toBe('1d 1h 1m');
    expect(formatDuration(86_400_000)).toBe('1d');
  });

  it('"permanent" for 0', () => {
    expect(formatDuration(0)).toBe('permanent');
  });

  it('"expired" for negative', () => {
    expect(formatDuration(-1)).toBe('expired');
    expect(formatDuration(-100_000)).toBe('expired');
  });

  it('shows 0m for sub-minute positive values', () => {
    expect(formatDuration(30_000)).toBe('0m');
    expect(formatDuration(1)).toBe('0m');
  });
});
