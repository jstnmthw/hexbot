import { describe, expect, it } from 'vitest';

import { AuditFallbackBuffer } from '../../src/core/audit-fallback';
import type { LogModActionOptions } from '../../src/core/mod-log';

const sample = (action: string): LogModActionOptions => ({
  action,
  source: 'system',
});

describe('AuditFallbackBuffer', () => {
  it('starts empty with zero drops', () => {
    const buf = new AuditFallbackBuffer();
    expect(buf.snapshot()).toEqual([]);
    expect(buf.stats()).toEqual({ held: 0, dropped: 0 });
  });

  it('appends entries in FIFO order', () => {
    const buf = new AuditFallbackBuffer();
    buf.push(sample('a'));
    buf.push(sample('b'));
    expect(buf.snapshot().map((e) => e.action)).toEqual(['a', 'b']);
    expect(buf.stats().held).toBe(2);
  });

  it('snapshot is a defensive copy', () => {
    const buf = new AuditFallbackBuffer(4);
    buf.push(sample('a'));
    const snap = buf.snapshot();
    snap.push(sample('mutate'));
    expect(buf.snapshot().map((e) => e.action)).toEqual(['a']);
  });

  it('FIFO-evicts oldest entry past capacity and counts the drop', () => {
    const buf = new AuditFallbackBuffer(2);
    buf.push(sample('a'));
    buf.push(sample('b'));
    buf.push(sample('c'));
    expect(buf.snapshot().map((e) => e.action)).toEqual(['b', 'c']);
    expect(buf.stats()).toEqual({ held: 2, dropped: 1 });
  });

  it('dropped count is monotonic across multiple overflows', () => {
    const buf = new AuditFallbackBuffer(1);
    buf.push(sample('a'));
    buf.push(sample('b'));
    buf.push(sample('c'));
    buf.push(sample('d'));
    expect(buf.snapshot().map((e) => e.action)).toEqual(['d']);
    expect(buf.stats()).toEqual({ held: 1, dropped: 3 });
  });
});
