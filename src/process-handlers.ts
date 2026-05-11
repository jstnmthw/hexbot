// Process-level error classification and shutdown helpers for the entry point.
// Extracted so the classifier and timeout helper are unit-testable without
// installing real process listeners.

/**
 * Socket-layer error codes we treat as transient. All four are emitted by the
 * Node TCP read path when the peer or network drops a connection mid-read —
 * irc-framework's reconnect loop will recover, but Node first surfaces the
 * raw read error as an `uncaughtException` because no one is awaiting the
 * socket. Anything outside this set is a real bug and falls through to
 * fatalExit.
 */
const RECOVERABLE_SOCKET_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTCONN']);

/**
 * True if the value is a socket read error we can log-and-continue instead
 * of crashing on. Matches both the error code AND the async stack frame from
 * the native TCP read path — any other code path with the same code (e.g.
 * a filesystem op surfacing EPIPE) falls through to the fatal handler.
 */
export function isRecoverableSocketError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!('code' in value) || !('stack' in value)) return false;
  const { code, stack } = value;
  if (typeof code !== 'string' || !RECOVERABLE_SOCKET_CODES.has(code)) return false;
  if (typeof stack !== 'string') return false;
  return stack.includes('TCP.onStreamRead') || stack.includes('internal/stream_base_commons');
}

/**
 * Run `shutdown()` with a hard deadline. Resolves `'ok'` if shutdown
 * completes first, `'timeout'` if the deadline fires first, `'failed'`
 * if `shutdown()` threw. Prevents a stuck shutdown from leaving the
 * process in limbo, and prevents a thrown shutdown from re-rejecting up
 * through `process.on('unhandledRejection')` and re-entering the very
 * fatalExit chain that called us — at 3am during an incident, the second
 * stack trace buries the original error.
 */
export async function shutdownWithTimeout(
  shutdown: () => Promise<void>,
  timeoutMs: number,
): Promise<'ok' | 'timeout' | 'failed'> {
  // Definite-assignment: the Promise executor runs synchronously, so `timer`
  // is always set before the race begins.
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  // Inner try/catch on shutdown's own rejection. Returning a sentinel
  // (`'failed'`) lets the caller log on a dedicated channel without
  // bouncing the failure back through unhandledRejection.
  const wrapped = (async (): Promise<'ok' | 'failed'> => {
    try {
      await shutdown();
      return 'ok';
    } catch (err) {
      console.error('[bot] shutdown() rejected during exit chain:', err);
      return 'failed';
    }
  })();
  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
