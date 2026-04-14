// Process-level error classification and shutdown helpers for the entry point.
// Extracted so the classifier and timeout helper are unit-testable without
// installing real process listeners.

const RECOVERABLE_SOCKET_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTCONN']);

/**
 * True if the value is a socket read error we can log-and-continue instead
 * of crashing on. Matches both the error code AND the async stack frame from
 * the native TCP read path — any other code path with the same code (e.g.
 * a filesystem op surfacing EPIPE) falls through to the fatal handler.
 */
export function isRecoverableSocketError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const err = value as { code?: unknown; stack?: unknown };
  if (typeof err.code !== 'string' || !RECOVERABLE_SOCKET_CODES.has(err.code)) return false;
  if (typeof err.stack !== 'string') return false;
  return (
    err.stack.includes('TCP.onStreamRead') || err.stack.includes('internal/stream_base_commons')
  );
}

/**
 * Run `shutdown()` with a hard deadline. Resolves `'ok'` if shutdown
 * completes first, `'timeout'` if the deadline fires first. Prevents a
 * stuck shutdown from leaving the process in limbo.
 */
export async function shutdownWithTimeout(
  shutdown: () => Promise<void>,
  timeoutMs: number,
): Promise<'ok' | 'timeout'> {
  // Definite-assignment: the Promise executor runs synchronously, so `timer`
  // is always set before the race begins.
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([shutdown().then(() => 'ok' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
