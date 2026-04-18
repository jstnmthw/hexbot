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

export class IterStats {
  private requests = 0;
  private input = 0;
  private output = 0;
  private since: number;

  constructor(private now: () => number = Date.now) {
    this.since = now();
  }

  record(usage: { input: number; output: number }): void {
    this.requests += 1;
    this.input += usage.input;
    this.output += usage.output;
  }

  snapshot(): IterStatsSnapshot {
    return {
      requests: this.requests,
      input: this.input,
      output: this.output,
      sinceMs: this.now() - this.since,
    };
  }

  reset(): void {
    this.requests = 0;
    this.input = 0;
    this.output = 0;
    this.since = this.now();
  }
}
