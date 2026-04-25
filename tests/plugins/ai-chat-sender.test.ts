// Unit tests for the post-gate IRC send wrapper.
// Verifies the latch behavior (gate fires once, all subsequent lines drop),
// the early-return paths in sendLinesGated, and the integration with the
// drip-feed `sendLines` setTimeout path. Multi-line scheduling uses fake
// timers so the test stays fast and deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatedSender, sendLinesGated } from '../../plugins/ai-chat/sender';

describe('gatedSender', () => {
  it('forwards lines while the gate stays open', () => {
    const send = vi.fn();
    const gate = vi.fn(() => false);
    const wrapped = gatedSender(gate, 'test', send);

    wrapped('one');
    wrapped('two');
    wrapped('three');

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['one', 'two', 'three']);
    // Gate is consulted on every line until it fires.
    expect(gate).toHaveBeenCalledTimes(3);
  });

  it('drops the first line and latches when the gate fires immediately', () => {
    const send = vi.fn();
    const gate = vi.fn(() => true);
    const wrapped = gatedSender(gate, 'reason-x', send);

    wrapped('one');
    wrapped('two');
    wrapped('three');

    // Nothing reached the sender — gate fired on the very first line.
    expect(send).not.toHaveBeenCalled();
    // After latching, the gate is no longer consulted on subsequent calls.
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith('reason-x');
  });

  it('passes through earlier lines, then latches once the gate flips mid-batch', () => {
    const send = vi.fn();
    let calls = 0;
    // Open for the first two checks, closed thereafter.
    const gate = vi.fn(() => {
      calls++;
      return calls > 2;
    });
    const wrapped = gatedSender(gate, 'reason', send);

    wrapped('a');
    wrapped('b');
    wrapped('c'); // gate trips on this call → dropped, latch engages
    wrapped('d');
    wrapped('e');

    expect(send.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    // 'c' triggered the latch (3 gate calls); 'd'/'e' short-circuited.
    expect(gate).toHaveBeenCalledTimes(3);
  });

  it('passes the supplied reason string to the gate predicate', () => {
    const send = vi.fn();
    const gate = vi.fn(() => false);
    const wrapped = gatedSender(gate, 'founder-check', send);

    wrapped('hi');

    expect(gate).toHaveBeenCalledWith('founder-check');
  });
});

describe('sendLinesGated', () => {
  it('resolves immediately for an empty line list (no gate calls, no sends)', async () => {
    const send = vi.fn();
    const gate = vi.fn(() => false);
    await sendLinesGated([], gate, 'r', send, 100);
    expect(send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
  });

  it('sends a single line synchronously and consults the gate once', async () => {
    const send = vi.fn();
    const gate = vi.fn(() => false);
    await sendLinesGated(['only'], gate, 'r', send, 500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('only');
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('sends all lines synchronously when interLineDelayMs <= 0', async () => {
    const send = vi.fn();
    const gate = vi.fn(() => false);
    await sendLinesGated(['a', 'b', 'c'], gate, 'r', send, 0);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('drops the entire batch when the gate fires before the first line', async () => {
    const send = vi.fn();
    const gate = vi.fn(() => true);
    await sendLinesGated(['a', 'b', 'c'], gate, 'r', send, 0);
    expect(send).not.toHaveBeenCalled();
    // Gate latches after first hit even in the synchronous path.
    expect(gate).toHaveBeenCalledTimes(1);
  });

  describe('multi-line scheduling with delay > 0', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('uses setTimeout between lines and resolves after all are sent', async () => {
      const send = vi.fn();
      const gate = vi.fn(() => false);
      const promise = sendLinesGated(['a', 'b', 'c'], gate, 'r', send, 200);

      // First line sent synchronously by sendLines.
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith('a');

      await vi.advanceTimersByTimeAsync(200);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith('b');

      await vi.advanceTimersByTimeAsync(200);
      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenLastCalledWith('c');

      await promise;
    });

    it('stops sending once the gate flips between scheduled lines', async () => {
      const send = vi.fn();
      let gateClosed = false;
      const gate = vi.fn(() => gateClosed);
      const promise = sendLinesGated(['a', 'b', 'c', 'd'], gate, 'flip', send, 100);

      // Line 1 goes through immediately.
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith('a');

      // Flip the gate before the next setTimeout fires.
      gateClosed = true;

      // Drain remaining schedules. None of b/c/d should be sent.
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(send).toHaveBeenCalledTimes(1);
      // Once latched, gate is not consulted again — 'a' open + 'b' close = 2.
      expect(gate).toHaveBeenCalledTimes(2);
    });
  });
});
