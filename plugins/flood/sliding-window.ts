// Local sliding-window counter for the flood plugin. Core exposes a richer
// SlidingWindowCounter, but DESIGN.md requires plugins to stay off core
// internals — so we keep an inlined minimal version here.
export class SlidingWindowCounter {
  private windows = new Map<string, number[]>();

  check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);
    const timestamps = existing ? existing.filter((t) => now - t < windowMs) : [];
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return timestamps.length > limit;
  }

  reset(): void {
    this.windows.clear();
  }

  sweep(windowMs: number): void {
    const now = Date.now();
    for (const [key, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps.every((t) => now - t >= windowMs)) {
        this.windows.delete(key);
      }
    }
  }
}
