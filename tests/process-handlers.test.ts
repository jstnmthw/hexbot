import { describe, expect, it, vi } from 'vitest';

import { isRecoverableSocketError, shutdownWithTimeout } from '../src/process-handlers';

describe('isRecoverableSocketError', () => {
  const tcpStack = [
    'Error: read ETIMEDOUT',
    '    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)',
  ].join('\n');

  const fsStack = [
    'Error: EPIPE: broken pipe',
    '    at ReadStream.push (node:internal/fs/streams:42:10)',
  ].join('\n');

  it('accepts ETIMEDOUT from TCP.onStreamRead', () => {
    const err = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', stack: tcpStack });
    expect(isRecoverableSocketError(err)).toBe(true);
  });

  it('accepts ECONNRESET from the native stream_base_commons frame', () => {
    const stack = 'Error: read ECONNRESET\n    at node:internal/stream_base_commons:150:25';
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', stack });
    expect(isRecoverableSocketError(err)).toBe(true);
  });

  it('accepts EPIPE and ENOTCONN in the whitelist', () => {
    const mkErr = (code: string) =>
      Object.assign(new Error(code), {
        code,
        stack: `Error\n    at TCP.onStreamRead (node:internal/stream_base_commons:1:1)`,
      });
    expect(isRecoverableSocketError(mkErr('EPIPE'))).toBe(true);
    expect(isRecoverableSocketError(mkErr('ENOTCONN'))).toBe(true);
  });

  it('rejects a whitelisted code from a non-socket stack frame', () => {
    // EPIPE from a filesystem op — same code, wrong path.
    const err = Object.assign(new Error('EPIPE'), { code: 'EPIPE', stack: fsStack });
    expect(isRecoverableSocketError(err)).toBe(false);
  });

  it('rejects unknown codes even with a matching stack', () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOSPC', stack: tcpStack });
    expect(isRecoverableSocketError(err)).toBe(false);
  });

  it('rejects errors with no code', () => {
    const err = Object.assign(new Error('plain'), { stack: tcpStack });
    expect(isRecoverableSocketError(err)).toBe(false);
  });

  it('rejects errors with no stack', () => {
    const err = { code: 'ETIMEDOUT' };
    expect(isRecoverableSocketError(err)).toBe(false);
  });

  it('rejects non-object rejection reasons', () => {
    expect(isRecoverableSocketError(undefined)).toBe(false);
    expect(isRecoverableSocketError(null)).toBe(false);
    expect(isRecoverableSocketError('ETIMEDOUT')).toBe(false);
    expect(isRecoverableSocketError(42)).toBe(false);
  });
});

describe('shutdownWithTimeout', () => {
  it("resolves 'ok' when shutdown completes before the deadline", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const result = await shutdownWithTimeout(shutdown, 1_000);
    expect(result).toBe('ok');
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("resolves 'timeout' when shutdown hangs past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = vi.fn().mockReturnValue(new Promise<void>(() => {})); // never resolves
      const pending = shutdownWithTimeout(shutdown, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves 'failed' when shutdown rejects (W-FATALEXIT)", async () => {
    // Inner try/catch converts the rejection into a sentinel so the
    // fatalExit chain doesn't re-enter unhandledRejection.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('shutdown blew up');
      const shutdown = vi.fn().mockRejectedValue(boom);
      const result = await shutdownWithTimeout(shutdown, 1_000);
      expect(result).toBe('failed');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
