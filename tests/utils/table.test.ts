import { describe, expect, it } from 'vitest';

import { formatTable } from '../../src/utils/table';

describe('formatTable', () => {
  it('aligns columns based on widest value', () => {
    const rows = [
      ['a', 'bb', 'ccc'],
      ['dddd', 'e', 'f'],
    ];
    const result = formatTable(rows);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    // Default indent is 2 spaces, default gap is 2 spaces
    expect(lines[0]).toBe('  a     bb  ccc');
    expect(lines[1]).toBe('  dddd  e   f');
  });

  it('does not pad the last column', () => {
    const rows = [
      ['short', 'x'],
      ['longervalue', 'y'],
    ];
    const result = formatTable(rows);
    const lines = result.split('\n');
    // Last column should not have trailing spaces
    expect(lines[0]).toBe('  short        x');
    expect(lines[1]).toBe('  longervalue  y');
  });

  it('returns empty string for empty rows', () => {
    expect(formatTable([])).toBe('');
  });

  it('returns empty string for rows of empty arrays', () => {
    expect(formatTable([[], []])).toBe('');
  });

  it('handles single-column rows (no padding)', () => {
    const rows = [['hello'], ['world']];
    const result = formatTable(rows);
    expect(result).toBe('  hello\n  world');
  });

  it('handles single-row', () => {
    const rows = [['one', 'two', 'three']];
    const result = formatTable(rows);
    expect(result).toBe('  one  two  three');
  });

  it('handles rows with different lengths (pads missing cells)', () => {
    const rows = [['a', 'b', 'c'], ['x']];
    const result = formatTable(rows);
    const lines = result.split('\n');
    expect(lines[0]).toBe('  a  b  c');
    expect(lines[1]).toBe('  x     ');
  });

  it('respects custom indent', () => {
    const rows = [['a', 'b']];
    const result = formatTable(rows, { indent: '>>> ' });
    expect(result).toBe('>>> a  b');
  });

  it('respects custom gap', () => {
    const rows = [
      ['a', 'bb'],
      ['cc', 'd'],
    ];
    const result = formatTable(rows, { gap: ' | ' });
    const lines = result.split('\n');
    expect(lines[0]).toBe('  a  | bb');
    expect(lines[1]).toBe('  cc | d');
  });

  it('respects both custom indent and gap', () => {
    const rows = [['x', 'y']];
    const result = formatTable(rows, { indent: '', gap: '-' });
    expect(result).toBe('x-y');
  });
});
