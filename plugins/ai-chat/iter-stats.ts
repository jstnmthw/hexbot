// In-memory iteration counter for prompt/character tuning. Accumulates
// token and request totals since the last reset so a developer can measure
// the delta between code tweaks. Independent from TokenTracker — does not
// persist across reloads and has no budget semantics.

export interface IterStatsSnapshot {
  requests: number;
  input: number;
  output: number;
  sinceMs: number;
}

/**
 * Lightweight in-memory request/token counter. One instance per plugin init
 * — all counters and the `since` anchor reset on teardown, by design. Exposed
 * through `!ai iter` so a developer tweaking a prompt or character can read
 * the delta without pulling daily rows out of TokenTracker.
 */
export class IterStats {
  private requests = 0;
  private input = 0;
  private output = 0;
  private since: number;

  constructor(private now: () => number = Date.now) {
    this.since = now();
  }

  /** Accumulate one request's token usage. Called once per LLM round-trip. */
  record(usage: { input: number; output: number }): void {
    this.requests += 1;
    this.input += usage.input;
    this.output += usage.output;
  }

  /** Read-only view of the current totals plus elapsed wall time since reset. */
  snapshot(): IterStatsSnapshot {
    return {
      requests: this.requests,
      input: this.input,
      output: this.output,
      sinceMs: this.now() - this.since,
    };
  }

  /** Zero all counters and re-anchor `sinceMs` to now. */
  reset(): void {
    this.requests = 0;
    this.input = 0;
    this.output = 0;
    this.since = this.now();
  }
}
