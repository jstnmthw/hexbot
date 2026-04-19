// AI provider adapter interface.
// Defines the shape every LLM provider (Gemini, Claude, OpenAI, Ollama, …) must implement.
// The plugin only talks to providers through this interface.

/** A single message exchanged with the AI model. */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Per-call sampling overrides. All fields optional; unset fields fall back
 * to the provider's init-time defaults. Used to thread per-character
 * generation settings into a single `complete()` call without re-initialising
 * the provider.
 */
export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  /** Stop sequences. Overrides the init-time stop list when provided. */
  stop?: string[];
}

/** Token usage reported after a completion. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** The result of a single completion call. */
export interface AIResponse {
  text: string;
  usage: TokenUsage;
  model: string;
}

/** Configuration passed to a provider's initialize(). */
export interface AIProviderConfig {
  model: string;
  maxOutputTokens: number;
  temperature: number;
  /** API key — required by hosted providers (Gemini, Claude, OpenAI); ignored by Ollama. */
  apiKey?: string;
  /** Base URL — required by Ollama; ignored by hosted providers. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults vary by provider. */
  requestTimeoutMs?: number;
  /** Extra sampling options passed through to the provider. Free-form; each provider pulls what it understands. */
  samplingOptions?: Record<string, number | string | boolean>;
  /**
   * Stop sequences. llama.cpp-family providers pass these as `options.stop`;
   * hosted providers ignore. On hit, generation terminates mid-token — the
   * cheapest prompt-echo / speaker-fabrication defence available. Cap ~10
   * entries (llama.cpp stop-list bugs at larger sizes).
   */
  stop?: string[];
  /** Ollama-only: use the server's /api/tokenize endpoint instead of a length heuristic. */
  useServerTokenizer?: boolean;
  /**
   * Ollama-only: how long to keep the model loaded between requests
   * (e.g. `"30m"`, `"-1"` for "forever", `"0"` to unload immediately).
   * Default Ollama behaviour is 5 minutes — too short for low-traffic bots
   * since every idle gap forces a cold reload and discards KV-cache.
   */
  keepAlive?: string;
  /**
   * Ollama-only: pinned context window size passed as `options.num_ctx`.
   * When set, the daemon uses this value instead of the per-model default
   * so subsequent calls with the same prefix reuse KV-cache (which is
   * invalidated by num_ctx drift). `0` / undefined → leave unset and let
   * Ollama pick.
   */
  numCtx?: number;
  /**
   * Ollama-only: allow `base_url` to point at loopback/link-local/private
   * addresses. Defaults to `false` — a misconfigured or config-write-attacker
   * base_url otherwise routes bot requests at cloud-metadata endpoints
   * (`169.254.169.254`) or internal admin panels. Operators running Ollama
   * on localhost must opt in explicitly. See audit 2026-04-19.
   */
  allowPrivateUrl?: boolean;
}

/**
 * Provider adapter contract. Implementations wrap a specific LLM vendor API
 * (Gemini, Claude, OpenAI, …) and expose a uniform surface the plugin uses.
 */
export interface AIProvider {
  /** Human-readable name of the provider (e.g. "gemini"). */
  readonly name: string;

  /** Set up the client. Called once at plugin startup. */
  initialize(config: AIProviderConfig): Promise<void>;

  /**
   * Generate a completion.
   * @param systemPrompt  — persona/instructions prepended to the conversation
   * @param messages      — conversation history (ordered, includes the latest user turn)
   * @param maxTokens     — upper bound on output tokens for this call
   * @param sampling      — optional per-call sampling overrides (per-character
   *                        temperature, topP, repeatPenalty, stop list)
   */
  complete(
    systemPrompt: string,
    messages: AIMessage[],
    maxTokens: number,
    sampling?: SamplingOptions,
  ): Promise<AIResponse>;

  /** Count tokens for the given text using the provider's tokenizer. */
  countTokens(text: string): Promise<number>;

  /** Return the model identifier currently in use. */
  getModelName(): string;

  /**
   * Abort every in-flight {@link complete} / {@link countTokens} call.
   * Implementations must reject pending promises immediately — the plugin's
   * teardown path invokes this so awaiters release their captured closures
   * (prompt, session, rateLimiter refs) instead of running to resolution
   * against a torn-down module graph. Optional so stub/mock providers in
   * tests don't have to implement it; real providers should.
   */
  abort?(): void;
}

/**
 * Provider-side error envelope with a coarse `kind` tag the Resilient wrapper
 * uses to decide retry vs. fail-fast vs. circuit-break. See
 * `providers/resilient.ts` for the routing matrix:
 *
 *   - `rate_limit` (429)      — retryable; counts toward breaker
 *   - `network`   (5xx, DNS)  — retryable; counts toward breaker
 *   - `safety`                — NOT retryable, does NOT trip breaker (policy)
 *   - `auth`                  — NOT retryable, does NOT trip breaker (config)
 *   - `other` (404/400/etc.)  — NOT retryable; counts toward breaker
 *
 * Keeping this a blacklist in the breaker logic means any *new* transient
 * kind added later defaults to counting — safer than an allowlist.
 */
export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'rate_limit' | 'safety' | 'network' | 'auth' | 'other',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

const AI_PROVIDER_ERROR_KINDS = new Set(['rate_limit', 'safety', 'network', 'auth', 'other']);

/**
 * Cross-bundle-safe type guard. `instanceof AIProviderError` breaks when the
 * plugin is bundled (tsup) and a caller constructs the error from a different
 * module copy, so we discriminate by `name` and a valid `kind` instead.
 */
export function isAIProviderError(err: unknown): err is AIProviderError {
  if (!(err instanceof Error) || err.name !== 'AIProviderError') return false;
  const kind = (err as unknown as { kind?: unknown }).kind;
  return typeof kind === 'string' && AI_PROVIDER_ERROR_KINDS.has(kind);
}
