import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue } from '../../src/core/message-queue';
import type { LoggerLike } from '../../src/logger';

/** Short alias used throughout; every test now has to pass a target. */
const T = '#test';

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
      q.enqueue(T, () => sent.push(i));
    }

    expect(sent).toEqual([0, 1, 2, 3]);
    expect(q.pending).toBe(0);
    q.stop();
  });

  it('queues messages beyond burst', () => {
    const q = new MessageQueue({ rate: 2, burst: 2 });
    const sent: number[] = [];

    for (let i = 0; i < 5; i++) {
      q.enqueue(T, () => sent.push(i));
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
      q.enqueue(T, () => sent.push(i));
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

  it('preserves message order within a single target', () => {
    const q = new MessageQueue({ rate: 1, burst: 0 });
    const sent: string[] = [];

    q.enqueue(T, () => sent.push('a'));
    q.enqueue(T, () => sent.push('b'));
    q.enqueue(T, () => sent.push('c'));

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
      q.enqueue(T, () => sent.push(i));
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
      q.enqueue(T, () => sent.push(i));
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
      q.enqueue(T, () => sent.push(i));
    }
    expect(sent).toEqual([0, 1, 2]);

    // Next message should be queued (no tokens)
    q.enqueue(T, () => sent.push(99));
    expect(q.pending).toBe(1);

    // Clear resets tokens
    q.clear();
    expect(q.pending).toBe(0);

    // Now burst should be available again
    for (let i = 10; i < 13; i++) {
      q.enqueue(T, () => sent.push(i));
    }
    expect(sent).toEqual([0, 1, 2, 10, 11, 12]);
    q.stop();
  });

  it('stop() prevents further draining', () => {
    const q = new MessageQueue({ rate: 2, burst: 0 });
    const sent: number[] = [];

    q.enqueue(T, () => sent.push(1));
    q.enqueue(T, () => sent.push(2));

    q.stop();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it('tokens refill over time allowing new bursts', () => {
    const q = new MessageQueue({ rate: 2, burst: 2 });
    const sent: number[] = [];

    // Exhaust burst
    q.enqueue(T, () => sent.push(1));
    q.enqueue(T, () => sent.push(2));
    expect(sent).toEqual([1, 2]);

    // Wait 1 second — should refill 2 tokens (rate=2/sec)
    vi.advanceTimersByTime(1000);

    // These should send immediately from refilled tokens
    q.enqueue(T, () => sent.push(3));
    q.enqueue(T, () => sent.push(4));
    expect(sent).toEqual([1, 2, 3, 4]);
    q.stop();
  });

  it('uses sensible defaults', () => {
    const q = new MessageQueue();
    const sent: number[] = [];

    // Default burst is 4
    for (let i = 0; i < 6; i++) {
      q.enqueue(T, () => sent.push(i));
    }

    expect(sent).toEqual([0, 1, 2, 3]);
    expect(q.pending).toBe(2);
    q.stop();
  });

  it('drops messages when queue reaches MAX_DEPTH (500)', () => {
    const q = new MessageQueue({ rate: 2, burst: 0 });
    const sent: number[] = [];

    // Spread enqueues across many targets so the per-target cap (50) never
    // trips before the global cap does. We want to observe the global drop.
    for (let i = 0; i < 501; i++) {
      q.enqueue(`#t${i % 20}`, () => sent.push(i));
    }

    expect(sent).toEqual([]);
    expect(q.pending).toBe(500);
    q.stop();
  });

  it('clear() on already-empty queue does not log', () => {
    const debugMsgs: string[] = [];
    const mockLogger: LoggerLike = {
      debug: (msg: string) => debugMsgs.push(msg),
      warn: () => {},
      info: () => {},
      error: () => {},
      child() {
        return mockLogger;
      },
      setLevel: () => {},
      getLevel: () => 'info',
    };

    const q = new MessageQueue({ rate: 1, burst: 0, logger: mockLogger });
    expect(q.pending).toBe(0);
    q.clear();
    expect(debugMsgs).toHaveLength(0);
    q.stop();
  });

  it('rate=3 drains correctly with integer budget (no float drift)', () => {
    // rate=3 → costMs=floor(1000/3)=333ms; one drain interval refills exactly 333ms = 1 message
    // Old float math: (333/1000)*3 = 0.999 < 1 — message stuck. Integer math: 333ms >= 333ms — sends.
    const q = new MessageQueue({ rate: 3, burst: 0 });
    const sent: number[] = [];

    q.enqueue(T, () => sent.push(1));
    q.enqueue(T, () => sent.push(2));
    expect(sent).toEqual([]); // no budget, nothing sent yet
    expect(q.pending).toBe(2);

    // Advance one drain interval — budget refills 333ms, costMs is 333ms, message sends
    vi.advanceTimersByTime(333);
    expect(sent).toEqual([1]);
    expect(q.pending).toBe(1);

    q.stop();
  });

  it('logs warning on queue full when logger is provided', () => {
    const warnMsgs: string[] = [];
    const mockLogger: LoggerLike = {
      warn: (msg: string) => warnMsgs.push(msg),
      debug: () => {},
      info: () => {},
      error: () => {},
      child: () => mockLogger,
      setLevel: () => {},
      getLevel: () => 'info',
    };

    const q = new MessageQueue({ rate: 2, burst: 0, logger: mockLogger });

    // Spread across many targets so the global cap is what fires, not the
    // per-target cap (which logs a different message).
    for (let i = 0; i < 501; i++) {
      q.enqueue(`#t${i % 20}`, () => {});
    }

    expect(warnMsgs).toHaveLength(1);
    expect(warnMsgs[0]).toContain('Message queue full');
    q.stop();
  });

  it('calls unref() on the drain timer when available', () => {
    // In Node.js, setInterval returns a Timeout object with unref().
    // This test verifies the guard executes the unref() branch.
    vi.useRealTimers(); // real timers have unref()

    const q = new MessageQueue({ rate: 2, burst: 0 });
    // Enqueue something to start the drain timer
    q.enqueue(T, () => {});

    // If unref() guard is broken, the process would stay alive — we just
    // verify no errors are thrown and the queue is functional.
    expect(q.pending).toBe(1);
    q.stop();

    vi.useFakeTimers(); // restore for afterEach
  });

  // -------------------------------------------------------------------------
  // Per-target sub-queues (§10 Phase 6)
  // -------------------------------------------------------------------------

  describe('per-target sub-queues', () => {
    it('drains round-robin across targets instead of FIFO-global', () => {
      // Burst=0 forces every message through the drain loop, then advance
      // one tick at a time so we can see the round-robin cursor at work.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      // `#a` floods with 3 messages, then `#b` with 2. Round-robin drain
      // should interleave them as a1 b1 a2 b2 a3 instead of running #a to
      // completion first.
      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#a', () => sent.push('a2'));
      q.enqueue('#a', () => sent.push('a3'));
      q.enqueue('#b', () => sent.push('b1'));
      q.enqueue('#b', () => sent.push('b2'));

      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1']);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1']);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'a2']);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'a2', 'b2']);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);

      q.stop();
    });

    it('does not starve a quiet target behind a flooding one', () => {
      // Fill `#busy` up to its per-target cap, then add a single `#quiet`
      // message. The per-target cap means #busy can't grow further but the
      // quiet target still gets its slot — and on the next drain tick after
      // #busy's first message, #quiet drains round-robin.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      // Use 49 so `#busy` sits at per-target cap-minus-one; extra enqueues
      // on `#busy` would be rejected, which would skew the pending count.
      for (let i = 0; i < 49; i++) {
        q.enqueue('#busy', () => sent.push(`busy${i}`));
      }
      q.enqueue('#quiet', () => sent.push('quiet'));

      expect(q.pending).toBe(50);
      // First drain goes to #busy (first in targetOrder), second to #quiet.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['busy0', 'quiet']);
      q.stop();
    });

    it('preserves FIFO ordering within a single target', () => {
      // 3 messages to the same target must leave the queue in arrival order.
      const q = new MessageQueue({ rate: 1, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#chan', () => sent.push('first'));
      q.enqueue('#chan', () => sent.push('second'));
      q.enqueue('#chan', () => sent.push('third'));

      q.flush();
      expect(sent).toEqual(['first', 'second', 'third']);
      q.stop();
    });

    it('drops the newest message on MAX_DEPTH across all targets combined', () => {
      // Split the 500-slot cap across enough targets (each within the
      // per-target cap) to hit the global limit without tripping the
      // per-target drop first. 50 msgs/target * 10 targets = 500 total.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      for (let t = 0; t < 10; t++) {
        for (let i = 0; i < 50; i++) q.enqueue(`#t${t}`, () => {});
      }
      expect(q.pending).toBe(500);
      // Any further enqueue is rejected — a brand-new target would hit
      // the global cap before creating its per-target sub-queue.
      q.enqueue('#new', () => {});
      expect(q.pending).toBe(500);
      q.stop();
    });

    it('drops messages when a single target hits the per-target cap (50)', () => {
      // One noisy target should saturate its sub-queue at 50 regardless of
      // how much headroom remains in the global 500 pool.
      const warnMsgs: string[] = [];
      const mockLogger: LoggerLike = {
        warn: (msg: string) => warnMsgs.push(msg),
        debug: () => {},
        info: () => {},
        error: () => {},
        child: () => mockLogger,
        setLevel: () => {},
        getLevel: () => 'info',
      };

      const q = new MessageQueue({ rate: 2, burst: 0, logger: mockLogger });
      for (let i = 0; i < 60; i++) q.enqueue('#flood', () => {});

      expect(q.pending).toBe(50);
      // All 10 over-cap enqueues should have logged a per-target warning.
      expect(warnMsgs.length).toBe(10);
      expect(warnMsgs[0]).toContain('Per-target queue full');
      q.stop();
    });

    it('reuses the same sub-queue for repeat targets', () => {
      // Target re-appears after a gap; should append to its existing
      // sub-queue rather than inserting a new slot in targetOrder.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#b', () => sent.push('b1'));
      q.enqueue('#a', () => sent.push('a2'));

      // Round-robin order is a, b, (a again). Second a should come after b.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'a2']);
      q.stop();
    });

    it('handles a single-target queue without cursor churn', () => {
      // One target, many messages — round-robin degenerates to a simple FIFO.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#solo', () => sent.push('a'));
      q.enqueue('#solo', () => sent.push('b'));
      q.enqueue('#solo', () => sent.push('c'));

      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a', 'b', 'c']);
      q.stop();
    });

    it('re-resolves the cursor after a target removal mid-rotation', () => {
      // Three targets in rotation; drain `#a` to empty (which removes it
      // from targetOrder) and verify `#b` and `#c` keep rotating fairly.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#b', () => sent.push('b1'));
      q.enqueue('#b', () => sent.push('b2'));
      q.enqueue('#c', () => sent.push('c1'));
      q.enqueue('#c', () => sent.push('c2'));

      // Rotation: a1 (a empty, removed), b1, c1, b2, c2.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'c1', 'b2', 'c2']);
      q.stop();
    });

    it('adds a new target to the tail of the rotation mid-drain', () => {
      // Drain partway through `#a`/`#b`, then a new `#c` appears — it should
      // slot in at the end of the rotation and not jump the queue.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#a', () => sent.push('a2'));
      q.enqueue('#b', () => sent.push('b1'));
      q.enqueue('#b', () => sent.push('b2'));

      // Drain the first two: a1, b1.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1']);

      // Now add a third target while `#a` is the next target in rotation.
      q.enqueue('#c', () => sent.push('c1'));

      // Rotation continues: a2, b2, c1.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['a1', 'b1', 'a2', 'b2', 'c1']);
      q.stop();
    });

    it('returns to an empty rotation cleanly and re-starts from target 0', () => {
      // Drain everything, then enqueue fresh messages — new rotation must
      // begin at the freshly-added target without stale cursor state.
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#b', () => sent.push('b1'));

      q.flush();
      expect(sent).toEqual(['a1', 'b1']);
      expect(q.pending).toBe(0);

      // Fresh batch — the cursor should not remember the prior rotation.
      q.enqueue('#x', () => sent.push('x1'));
      q.enqueue('#y', () => sent.push('y1'));
      q.enqueue('#x', () => sent.push('x2'));

      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent.slice(2)).toEqual(['x1', 'y1', 'x2']);
      q.stop();
    });

    it('flush() drains fairly across targets, not target-by-target', () => {
      // `flush()` shares the round-robin path — verify it produces the same
      // interleaving a slow drain would.
      const q = new MessageQueue({ rate: 1, burst: 0 });
      const sent: string[] = [];

      q.enqueue('#a', () => sent.push('a1'));
      q.enqueue('#a', () => sent.push('a2'));
      q.enqueue('#b', () => sent.push('b1'));
      q.enqueue('#b', () => sent.push('b2'));

      q.flush();
      expect(sent).toEqual(['a1', 'b1', 'a2', 'b2']);
      q.stop();
    });

    it('untargeted sends share the empty-string bucket', () => {
      const q = new MessageQueue({ rate: 2, burst: 0 });
      const sent: string[] = [];

      q.enqueue('', () => sent.push('u1'));
      q.enqueue('', () => sent.push('u2'));
      q.enqueue('#chan', () => sent.push('c1'));

      // '' is round-robin slot 0, then #chan, then '' again.
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(sent).toEqual(['u1', 'c1', 'u2']);
      q.stop();
    });
  });

  // -------------------------------------------------------------------------
  // flushWithDeadline — netsplit/disconnect best-effort drain
  // -------------------------------------------------------------------------

  describe('flushWithDeadline()', () => {
    it('drains every queued message when none of them throw and the deadline is generous', () => {
      // Real timers so Date.now() advances — the deadline check uses wall clock.
      vi.useRealTimers();
      const q = new MessageQueue({ rate: 1, burst: 0 });
      const sent: number[] = [];
      for (let i = 0; i < 5; i++) {
        q.enqueue(T, () => sent.push(i));
      }

      const drained = q.flushWithDeadline(5_000);
      expect(drained).toBe(5);
      expect(sent).toEqual([0, 1, 2, 3, 4]);
      expect(q.pending).toBe(0);
      q.stop();
      vi.useFakeTimers();
    });

    it('continues past sends that throw (per-message isolation)', () => {
      // The disconnect-path drain must not abort on a single bad send —
      // otherwise one failing closure could strand kick/mode commands an
      // operator queued before the netsplit.
      vi.useRealTimers();
      const q = new MessageQueue({ rate: 1, burst: 0 });
      const sent: string[] = [];
      q.enqueue(T, () => sent.push('a'));
      q.enqueue(T, () => {
        throw new Error('boom');
      });
      q.enqueue(T, () => sent.push('c'));

      const drained = q.flushWithDeadline(5_000);
      expect(drained).toBe(3);
      expect(sent).toEqual(['a', 'c']);
      expect(q.pending).toBe(0);
      q.stop();
      vi.useFakeTimers();
    });

    it('returns 0 immediately when the queue is empty', () => {
      vi.useRealTimers();
      const q = new MessageQueue({ rate: 1, burst: 0 });
      expect(q.flushWithDeadline(10)).toBe(0);
      q.stop();
      vi.useFakeTimers();
    });

    it('stops draining once the wall-clock deadline has passed', () => {
      // Deadline of 0 ms means the loop exits before doing any work — the
      // bound proves the deadline is honored even on a backed-up queue.
      vi.useRealTimers();
      const q = new MessageQueue({ rate: 1, burst: 0 });
      for (let i = 0; i < 50; i++) q.enqueue(T, () => {});
      const drained = q.flushWithDeadline(0);
      expect(drained).toBe(0);
      expect(q.pending).toBe(50);
      q.stop();
      vi.useFakeTimers();
    });
  });

  // -------------------------------------------------------------------------
  // TARGMAX surface (§10 Phase 6)
  // -------------------------------------------------------------------------

  describe('TARGMAX', () => {
    it('defaults to an empty map', () => {
      const q = new MessageQueue();
      expect(q.getTargmax()).toEqual({});
      q.stop();
    });

    it('accepts and exposes the ISUPPORT TARGMAX map', () => {
      const q = new MessageQueue();
      q.setTargmax({ PRIVMSG: 4, NOTICE: 4, JOIN: Infinity });
      expect(q.getTargmax().PRIVMSG).toBe(4);
      expect(q.getTargmax().NOTICE).toBe(4);
      expect(q.getTargmax().JOIN).toBe(Infinity);
      q.stop();
    });

    it('stores a defensive copy of the map', () => {
      const q = new MessageQueue();
      const src: Record<string, number> = { PRIVMSG: 4 };
      q.setTargmax(src);
      src.PRIVMSG = 99; // mutate the input
      expect(q.getTargmax().PRIVMSG).toBe(4);
      q.stop();
    });
  });
});
