import { describe, expect, it } from 'vitest';

import { LRUMap } from '../../../src/core/botlink/lru-map';

describe('LRUMap', () => {
  it('promotes existing keys to MRU on re-set without resizing', () => {
    // The cap=2 LRU keeps a/b. Re-setting `a` must move it to the tail; a
    // subsequent insert of `c` should then evict `b` (now LRU) — not `a`.
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10); // touch
    m.set('c', 3);
    expect(m.has('a')).toBe(true);
    expect(m.get('a')).toBe(10);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(true);
    expect(m.size).toBe(2);
  });

  it('evicts the oldest entry when full', () => {
    const m = new LRUMap<string, string>(3);
    m.set('a', 'A');
    m.set('b', 'B');
    m.set('c', 'C');
    m.set('d', 'D'); // pushes a out
    expect(m.has('a')).toBe(false);
    expect(m.size).toBe(3);
    expect([...m.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('exposes the same iteration shape as Map for keys/values/entries/iterator', () => {
    // These delegates are the entire reason the wrapper is drop-in-compatible
    // with code that previously used a plain Map. A regression here would
    // silently break every consumer that iterates the map.
    const m = new LRUMap<string, number>(4);
    m.set('x', 1);
    m.set('y', 2);
    expect([...m.keys()]).toEqual(['x', 'y']);
    expect([...m.values()]).toEqual([1, 2]);
    expect([...m.entries()]).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
    // Symbol.iterator should return entries.
    expect([...m]).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
  });

  it('clear() empties the underlying map', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has('a')).toBe(false);
    expect([...m.entries()]).toEqual([]);
  });

  it('delete() returns Map.delete semantics', () => {
    const m = new LRUMap<string, number>(2);
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    expect(m.size).toBe(0);
  });
});
