// Ollama provider adapter.
// Talks to a local Ollama daemon (default http://127.0.0.1:11434) via its
// native REST API. Uses the built-in fetch (Node 20+) so we don't ship an SDK.
import {
  type AIMessage,
  type AIProvider,
  type AIProviderConfig,
  AIProviderError,
  type AIResponse,
  type ProviderLogger,
  type SamplingOptions,
} from './types';

/** Short timeout for the startup /api/tags ping — we just want "is the daemon alive?". */
const OLLAMA_TAGS_TIMEOUT_MS = 5_000;

/**
 * Best-effort check: is `hostname` loopback / RFC1918 / link-local?
 * Used by the http://-without-TLS warning so we only nag operators when
 * the cleartext leak actually crosses a network boundary. Hostname-only
 * (no DNS lookup) — a hostname like `internal.example` is treated as
 * "public" and warned, which is the conservative side of the call.
 */
function isLocalOrPrivateHost(hostname: string): boolean {
  // Strip surrounding `[]` from IPv6 literals.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  // RFC1918 IPv4 quick check via leading-octet match.
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Link-local IPv4 169.254/16, IPv6 fe80::/10, IPv6 ULA fc00::/7.
  if (/^169\.254\./.test(host)) return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

/** 4 characters per token is the standard conservative heuristic for English
 *  (GPT-style tokenisers average ~3.8 chars/token). Rounding up keeps budget
 *  enforcement on the safe side of the true count. */
const CHARS_PER_TOKEN = 4;

/** Shape of the /api/chat non-streaming response we care about. */
interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Shape of /api/tags (list of locally pulled models). */
interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/** Shape of /api/tokenize (server-side tokenisation, optional feature). */
interface OllamaTokenizeResponse {
  tokens?: unknown[];
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  private baseUrl = 'http://127.0.0.1:11434';
  private modelName = '';
  private temperature = 0.9;
  private maxOutputTokens = 256;
  private requestTimeoutMs = 60_000;
  private extraOptions: Record<string, number | string | boolean> = {};
  private useServerTokenizer = false;
  private keepAlive: string | undefined;
  private numCtx = 0;
  private stopSequences: string[] = [];
  private logger: ProviderLogger | null = null;
  /**
   * Every {@link fetchJson} call registers its AbortController here for the
   * duration of the request so {@link abort} can cancel a torn-down-plugin's
   * outstanding 60s /api/chat call instead of letting it drain against the
   * old captured prompt/context closures. Entries are removed in `finally`.
   */
  private inflightControllers = new Set<AbortController>();
  /**
   * Epoch counter — bumped on every `abort()`. A fetch tags itself with the
   * epoch at start; if its `finally` runs after `abort()` cleared the set
   * (the AbortError takes a microtask to propagate through `fetch`), the
   * mismatched epoch tells the cleanup code to skip touching state — the
   * abort already cleared it. Without this, a stale completion could race
   * a fresh fetch and yank its controller out of the set, leaving the
   * fresh fetch unabortable on the next reload.
   */
  private epoch = 0;

  async initialize(config: AIProviderConfig): Promise<void> {
    if (!config.baseUrl) {
      throw new AIProviderError('Ollama baseUrl is empty', 'other');
    }
    // Validate the URL up front so a misconfigured `base_url` (typo,
    // missing scheme, smuggled credentials in `userinfo`) fails the init
    // ping rather than later mid-request. `URL` throws on malformed input.
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new AIProviderError(
        `Ollama baseUrl is not a valid URL: ${JSON.stringify(config.baseUrl)}`,
        'other',
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AIProviderError(
        `Ollama baseUrl must use http:// or https:// (got "${parsed.protocol}")`,
        'other',
      );
    }
    if (parsed.username || parsed.password) {
      throw new AIProviderError(
        'Ollama baseUrl must not embed userinfo (user:password@host)',
        'other',
      );
    }
    // SSRF / cleartext defense-in-depth: when the configured base URL
    // points at a non-loopback / non-RFC1918 host over plaintext HTTP,
    // every prompt and response transits the wire in clear. Warn loudly
    // (not fatal — operators tunneling through localhost-bound proxies
    // legitimately use `http://` to a non-loopback proxy address).
    if (parsed.protocol === 'http:' && !isLocalOrPrivateHost(parsed.hostname)) {
      this.logger?.warn(
        `[security] Ollama base_url uses http:// to non-loopback host "${parsed.hostname}". ` +
          'Every prompt/response transits the wire in cleartext. Switch to https:// or tunnel via a localhost-bound proxy.',
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // SECURITY: `modelName` must only ever be set from operator config
    // (loaded into `AIProviderConfig` by the plugin loader). Do NOT add a
    // public setter or wire any IRC command into this field — Ollama's
    // `/api/chat` will implicitly pull an unknown model on first call,
    // so a user-mutable model name lets anyone in-channel trigger an
    // arbitrary GGUF download. See the matching read-only guard at the
    // `model:` subcommand in plugins/ai-chat/index.ts and docs/SECURITY.md.
    this.modelName = config.model;
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
    this.extraOptions = config.samplingOptions ?? {};
    this.useServerTokenizer = config.useServerTokenizer ?? false;
    this.keepAlive = config.keepAlive;
    this.numCtx = config.numCtx ?? 0;
    this.stopSequences = config.stop ?? [];
    this.logger = config.logger ?? null;

    // Startup ping: fail fast if the daemon is unreachable, but only warn if
    // the configured model isn't pulled yet — operator may pull it after boot.
    try {
      const tags = await this.fetchJson<OllamaTagsResponse>(
        '/api/tags',
        undefined,
        OLLAMA_TAGS_TIMEOUT_MS,
      );
      const known = (tags.models ?? [])
        .map((m) => m.name ?? m.model ?? '')
        .filter((n) => n.length > 0);
      if (known.length > 0 && !known.includes(this.modelName)) {
        this.logger?.warn(
          `model "${this.modelName}" is not in /api/tags ` +
            `(available: ${known.join(', ')}). The first completion will fail ` +
            `with 404 until the model is pulled.`,
        );
      }
    } catch (err) {
      throw mapOllamaError(err);
    }
  }

  async complete(
    systemPrompt: string,
    messages: AIMessage[],
    maxTokens: number,
    sampling?: SamplingOptions,
  ): Promise<AIResponse> {
    if (!this.modelName) {
      throw new AIProviderError('Ollama provider not initialized', 'other');
    }

    // Ollama accepts a system role inline in messages, which is simpler than
    // Gemini's separate systemInstruction param. Prepend only if non-empty.
    const wire: Array<{ role: string; content: string }> = [];
    if (systemPrompt) wire.push({ role: 'system', content: systemPrompt });
    for (const m of messages) wire.push({ role: m.role, content: m.content });

    // `keep_alive` goes at the top level (per Ollama API); `num_ctx` inside
    // options only when configured > 0, otherwise we leave it unset so the
    // daemon picks the model default. Both feed llama.cpp's KV-cache: a
    // resident model + pinned ctx size is the difference between a 10-17×
    // prefill-speed hit and a cold rebuild every call.
    const options: Record<string, number | string | boolean | string[]> = {
      temperature: sampling?.temperature ?? this.temperature,
      num_predict: maxTokens,
      ...this.extraOptions,
    };
    if (sampling?.topP !== undefined) options.top_p = sampling.topP;
    if (sampling?.repeatPenalty !== undefined) options.repeat_penalty = sampling.repeatPenalty;
    if (this.numCtx > 0) options.num_ctx = this.numCtx;
    // Per-call stop overrides the init-time stop list; otherwise fall back to
    // the operator-/tier-configured list. llama.cpp has historical bugs with
    // very large stop lists — cap defensively at 10.
    const stopList = (sampling?.stop ?? this.stopSequences).slice(0, 10);
    if (stopList.length > 0) options.stop = stopList;
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: wire,
      stream: false,
      options,
    };
    if (this.keepAlive !== undefined) body.keep_alive = this.keepAlive;

    let res: OllamaChatResponse;
    try {
      res = await this.fetchJson<OllamaChatResponse>('/api/chat', body, this.requestTimeoutMs);
    } catch (err) {
      throw mapOllamaError(err);
    }

    const text = (res.message?.content ?? '').trim();
    if (!text) {
      if (res.error) {
        throw new AIProviderError(`Ollama error: ${res.error}`, 'other');
      }
      throw new AIProviderError('Ollama returned no content', 'other');
    }

    // Context-window headroom warning. When prompt tokens cross 90% of the
    // pinned num_ctx, the next turn will likely truncate — operators need
    // this in the log without correlating stats by hand.
    if (this.numCtx > 0 && res.prompt_eval_count && res.prompt_eval_count > this.numCtx * 0.9) {
      this.logger?.warn(
        `prompt_eval_count=${res.prompt_eval_count} exceeds 90% of ` +
          `num_ctx=${this.numCtx} — reduce context.max_messages or raise ollama.num_ctx.`,
      );
    }

    return {
      text,
      usage: {
        input: res.prompt_eval_count ?? 0,
        output: res.eval_count ?? 0,
      },
      model: this.modelName,
    };
  }

  async countTokens(text: string): Promise<number> {
    if (!this.useServerTokenizer) {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    }
    try {
      const res = await this.fetchJson<OllamaTokenizeResponse>(
        '/api/tokenize',
        { model: this.modelName, prompt: text },
        this.requestTimeoutMs,
      );
      return Array.isArray(res.tokens) ? res.tokens.length : 0;
    } catch (err) {
      throw mapOllamaError(err);
    }
  }

  getModelName(): string {
    return this.modelName;
  }

  /**
   * Cancel every in-flight fetch. The `fetch()` promise rejects with
   * AbortError, which {@link mapOllamaError} converts to an
   * `AIProviderError('network')` — the pipeline's catch path then releases
   * its semaphore permit and rateLimiter reservation cleanly.
   */
  abort(): void {
    this.epoch++;
    for (const controller of this.inflightControllers) {
      controller.abort();
    }
    this.inflightControllers.clear();
  }

  /**
   * POST JSON to `path`. When `body` is undefined, sends a GET. Enforces
   * `timeoutMs` via AbortController. On non-2xx, throws an Error carrying the
   * HTTP status so `mapOllamaError` can triage without us re-parsing.
   */
  private async fetchJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const startEpoch = this.epoch;
    this.inflightControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${this.baseUrl}${path}`, init);
      if (!response.ok) {
        const text = await safeReadText(response);
        throw new OllamaHttpError(response.status, text || response.statusText);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
      // Skip cleanup when the epoch advanced — abort() already cleared the
      // set, and a stale delete here could remove a fresh fetch's controller
      // that happened to land at the same identity.
      if (startEpoch === this.epoch) {
        this.inflightControllers.delete(controller);
      }
    }
  }
}

/** Read a response body to string without throwing if it's already consumed or malformed. */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Carries the HTTP status code out of `fetchJson` so `mapOllamaError` can triage it. */
export class OllamaHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OllamaHttpError';
  }
}

/**
 * Convert a raw fetch/HTTP failure into an AIProviderError with a kind tag
 * the ResilientProvider can act on. `network` is retryable; `other` is not.
 * Deterministic failures (404 missing model, 400 malformed request) must not
 * retry — they'd just burn budget and trip the breaker on a config bug.
 */
export function mapOllamaError(err: unknown): AIProviderError {
  if (err instanceof AIProviderError) return err;

  if (err instanceof OllamaHttpError) {
    if (err.status === 404) {
      return new AIProviderError(
        `Ollama model not pulled (HTTP 404): ${err.message}`,
        'other',
        err,
      );
    }
    if (err.status === 400) {
      return new AIProviderError(`Ollama bad request (HTTP 400): ${err.message}`, 'other', err);
    }
    if (err.status >= 500) {
      return new AIProviderError(`Ollama server error (HTTP ${err.status})`, 'network', err);
    }
    return new AIProviderError(`Ollama HTTP ${err.status}: ${err.message}`, 'other', err);
  }

  if (err instanceof Error) {
    // AbortError on timeout, and Node's fetch wraps ECONNREFUSED/ENOTFOUND in
    // a generic "fetch failed" whose .cause carries the code. Both are
    // transient/infra — retry-eligible, same as Gemini's network bucket.
    const msg = err.message || '';
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code;
    if (
      err.name === 'AbortError' ||
      msg.includes('fetch failed') ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN'
    ) {
      return new AIProviderError(msg || 'Ollama network error', 'network', err);
    }
    return new AIProviderError(msg, 'other', err);
  }

  return new AIProviderError('Unknown Ollama error', 'other', err);
}
