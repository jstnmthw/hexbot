// Resilience wrappers for AIProvider: retry transient errors + circuit breaker.
import { type AIProvider, type AIProviderConfig, AIProviderError, type AIResponse } from './types';

export interface ResilienceConfig {
  /** Max retry attempts for retryable errors (0 = no retries). */
  maxRetries: number;
  /** Initial backoff in ms; each retry doubles this. */
  initialBackoffMs: number;
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open after tripping, in ms. */
  openDurationMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  maxRetries: 2,
  initialBackoffMs: 500,
  failureThreshold: 5,
  openDurationMs: 5 * 60 * 1000,
};

/** Wraps a provider with retry + circuit-breaker semantics. */
export class ResilientProvider implements AIProvider {
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | null = null;

  constructor(
    public readonly inner: AIProvider,
    private config: ResilienceConfig = DEFAULT_RESILIENCE,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async initialize(config: AIProviderConfig): Promise<void> {
    return this.inner.initialize(config);
  }

  async complete(
    systemPrompt: string,
    messages: Parameters<AIProvider['complete']>[1],
    maxTokens: number,
  ): Promise<AIResponse> {
    this.assertCircuitClosed();
    let backoff = this.config.initialBackoffMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const res = await this.inner.complete(systemPrompt, messages, maxTokens);
        this.recordSuccess();
        return res;
      } catch (err) {
        const provErr = toProviderError(err);
        // Retryable kinds: rate_limit (429) and network (5xx) only.
        const retryable = provErr.kind === 'rate_limit' || provErr.kind === 'network';
        if (!retryable || attempt >= this.config.maxRetries) {
          this.recordFailure();
          throw provErr;
        }
        await this.sleep(backoff);
        backoff *= 2;
      }
    }

    // Unreachable — loop either returns or throws.
    /* v8 ignore next 2 */
    throw new AIProviderError('Retries exhausted', 'other');
  }

  async countTokens(text: string): Promise<number> {
    return this.inner.countTokens(text);
  }

  getModelName(): string {
    return this.inner.getModelName();
  }

  /** True if the circuit is currently open. */
  isOpen(): boolean {
    if (this.circuitOpenedAt === null) return false;
    if (this.now() - this.circuitOpenedAt > this.config.openDurationMs) {
      // Half-open — allow another attempt. Failure re-opens the circuit.
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private assertCircuitClosed(): void {
    if (this.isOpen()) {
      throw new AIProviderError('Circuit breaker open', 'other');
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.circuitOpenedAt = this.now();
    }
  }
}

function toProviderError(err: unknown): AIProviderError {
  if (err instanceof AIProviderError) return err;
  if (err instanceof Error) return new AIProviderError(err.message, 'other', err);
  return new AIProviderError('Unknown error', 'other', err);
}
