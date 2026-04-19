// Process-wide concurrency limiter for provider calls.
//
// Why: rate limits count discrete events in sliding windows; they don't
// bound how many in-flight requests can pile up while a slow provider
// (local Ollama on a constrained box) takes 10–30s per response. A
// rolling-window RPM of 10 still admits 10 simultaneous requests if the
// channel is bursty, and Ollama serializes them on the server side
// while the bot's memory grows with queued promises and prompt copies.
//
// Approach: a non-blocking permit pool. Callers `tryAcquire()` and
// either get a release callback or `null` (= "busy, try again later").
// Refusing rather than queuing surfaces backpressure to the channel
// instead of hiding it inside an unbounded queue.

/**
 * Bounded permit pool. Not a classical semaphore — there's no `acquire()`
 * that waits; callers must handle the busy case. Process-local; safe to
 * share across plugin reloads if the same instance is reused, but the
 * plugin currently constructs a new one on each load (state resets).
 */
export class ProviderSemaphore {
  private inFlight = 0;
  constructor(private readonly maxInflight: number) {}

  /**
   * Try to grab a permit. Returns a release function on success, or `null`
   * when the pool is at capacity. The release function is idempotent — calling
   * it twice is a no-op so callers can release in `finally` without worrying
   * about double-release on retry paths.
   */
  tryAcquire(): (() => void) | null {
    if (this.maxInflight <= 0) return () => {}; // disabled — always admit
    if (this.inFlight >= this.maxInflight) return null;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
  }

  /** Current in-flight count (tests / `.ai stats`). */
  active(): number {
    return this.inFlight;
  }

  /** Configured cap. */
  capacity(): number {
    return this.maxInflight;
  }
}
