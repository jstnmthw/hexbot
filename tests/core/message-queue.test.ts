import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue } from '../../src/core/message-queue.js';

describe('MessageQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends burst messages immediately', () => {
    const q = new MessageQueue({ rate: 2, burst: 4 });
    const sent: number[] = [];

    for (let i = 0; i < 4; i++) {
      q.enqueue(() => sent.push(i));
    }

    expect(sent).toEqual([0, 1, 2, 3]);
    expect(q.pending).toBe(0);
    q.stop();
  });

  it('queues messages beyond burst', () => {
    const q = new MessageQueue({ rate: 2, burst: 2 });
    const sent: number[] = [];

    for (let i = 0; i < 5; i++) {
      q.enqueue(() => sent.push(i));
    }

    // First 2 sent immediately (burst), rest queued
    expect(sent).toEqual([0, 1]);
    expect(q.pending).toBe(3);
    q.stop();
  });

  it('drains queued messages at the configured rate', () => {
    const q = new MessageQueue({ rate: 2, burst: 0 });
    const sent: number[] = [];

    for (let i = 0; i < 4; i++) {
      q.enqueue(() => sent.push(i));
    }

    expect(sent).toEqual([]);
    expect(q.pending).toBe(4);

    // Advance 500ms (1/rate interval) — should drain one
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([0]);
    expect(q.pending).toBe(3);

    // Another 500ms — drain another
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([0, 1]);
    expect(q.pending).toBe(2);

    q.stop();
  });

  it('preserves message order', () => {
    const q = new MessageQueue({ rate: 1, burst: 0 });
    const sent: string[] = [];

    q.enqueue(() => sent.push('a'));
    q.enqueue(() => sent.push('b'));
    q.enqueue(() => sent.push('c'));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(sent).toEqual(['a', 'b', 'c']);
    q.stop();
  });

  it('flush() sends all remaining immediately', () => {
    const q = new MessageQueue({ rate: 1, burst: 0 });
    const sent: number[] = [];

    for (let i = 0; i < 5; i++) {
      q.enqueue(() => sent.push(i));
    }

    expect(sent).toEqual([]);
    q.flush();
    expect(sent).toEqual([0, 1, 2, 3, 4]);
    expect(q.pending).toBe(0);
    q.stop();
  });

  it('clear() discards pending messages', () => {
    const q = new MessageQueue({ rate: 1, burst: 0 });
    const sent: number[] = [];

    for (let i = 0; i < 5; i++) {
      q.enqueue(() => sent.push(i));
    }

    q.clear();
    expect(q.pending).toBe(0);

    // Advance time — nothing should send
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
    q.stop();
  });

  it('clear() resets burst tokens', () => {
    const q = new MessageQueue({ rate: 2, burst: 3 });
    const sent: number[] = [];

    // Exhaust burst
    for (let i = 0; i < 3; i++) {
      q.enqueue(() => sent.push(i));
    }
    expect(sent).toEqual([0, 1, 2]);

    // Next message should be queued (no tokens)
    q.enqueue(() => sent.push(99));
    expect(q.pending).toBe(1);

    // Clear resets tokens
    q.clear();
    expect(q.pending).toBe(0);

    // Now burst should be available again
    for (let i = 10; i < 13; i++) {
      q.enqueue(() => sent.push(i));
    }
    expect(sent).toEqual([0, 1, 2, 10, 11, 12]);
    q.stop();
  });

  it('stop() prevents further draining', () => {
    const q = new MessageQueue({ rate: 2, burst: 0 });
    const sent: number[] = [];

    q.enqueue(() => sent.push(1));
    q.enqueue(() => sent.push(2));

    q.stop();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it('tokens refill over time allowing new bursts', () => {
    const q = new MessageQueue({ rate: 2, burst: 2 });
    const sent: number[] = [];

    // Exhaust burst
    q.enqueue(() => sent.push(1));
    q.enqueue(() => sent.push(2));
    expect(sent).toEqual([1, 2]);

    // Wait 1 second — should refill 2 tokens (rate=2/sec)
    vi.advanceTimersByTime(1000);

    // These should send immediately from refilled tokens
    q.enqueue(() => sent.push(3));
    q.enqueue(() => sent.push(4));
    expect(sent).toEqual([1, 2, 3, 4]);
    q.stop();
  });

  it('uses sensible defaults', () => {
    const q = new MessageQueue();
    const sent: number[] = [];

    // Default burst is 4
    for (let i = 0; i < 6; i++) {
      q.enqueue(() => sent.push(i));
    }

    expect(sent).toEqual([0, 1, 2, 3]);
    expect(q.pending).toBe(2);
    q.stop();
  });
});
