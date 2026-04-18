import { describe, expect, it } from 'vitest';

import { IterStats } from '../../plugins/ai-chat/iter-stats';

describe('IterStats', () => {
  it('starts at zero', () => {
    const s = new IterStats(() => 1000);
    const snap = s.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.input).toBe(0);
    expect(snap.output).toBe(0);
    expect(snap.sinceMs).toBe(0);
  });

  it('accumulates tokens and requests across record() calls', () => {
    const s = new IterStats(() => 0);
    s.record({ input: 10, output: 5 });
    s.record({ input: 3, output: 2 });
    const snap = s.snapshot();
    expect(snap.requests).toBe(2);
    expect(snap.input).toBe(13);
    expect(snap.output).toBe(7);
  });

  it('sinceMs reflects time elapsed since construction', () => {
    let clock = 1000;
    const s = new IterStats(() => clock);
    clock = 3500;
    expect(s.snapshot().sinceMs).toBe(2500);
  });

  it('reset zeroes counters and restarts the timer', () => {
    let clock = 100;
    const s = new IterStats(() => clock);
    s.record({ input: 4, output: 6 });
    clock = 500;
    s.reset();
    clock = 700;
    const snap = s.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.input).toBe(0);
    expect(snap.output).toBe(0);
    expect(snap.sinceMs).toBe(200);
  });
});
