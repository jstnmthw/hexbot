// Ollama provider adapter.
// Talks to a local Ollama daemon (default http://127.0.0.1:11434) via its
// native REST API. Uses the built-in fetch (Node 20+) so we don't ship an SDK.
import ipaddr from 'ipaddr.js';
import dns from 'node:dns/promises';
import net from 'node:net';

import {
  type AIMessage,
  type AIProvider,
  type AIProviderConfig,
  AIProviderError,
  type AIResponse,
  type SamplingOptions,
} from './types';

/** Short timeout for the startup /api/tags ping — we just want "is the daemon alive?". */
const OLLAMA_TAGS_TIMEOUT_MS = 5_000;

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

  async initialize(config: AIProviderConfig): Promise<void> {
    if (!config.baseUrl) {
      throw new AIProviderError('Ollama baseUrl is empty', 'other');
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

    // SSRF guard. Without this, an operator who misconfigures (or a
    // config-write attacker) can point `base_url` at `169.254.169.254`
    // (cloud-metadata), `127.0.0.1:<admin-panel>`, or a VPN-internal host,
    // and the provider happily POSTs `/api/chat` bodies at it. Defaults to
    // rejecting private/loopback/link-local addresses; operators running a
    // local Ollama daemon must set `ollama.allow_private_url: true` to opt
    // in. See audit 2026-04-19.
    await validateOllamaBaseUrl(this.baseUrl, config.allowPrivateUrl === true);

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
        console.warn(
          `[ollama] model "${this.modelName}" is not in /api/tags ` +
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
      console.warn(
        `[ollama] prompt_eval_count=${res.prompt_eval_count} exceeds 90% of ` +
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
   * POST JSON to `path`. When `body` is undefined, sends a GET. Enforces
   * `timeoutMs` via AbortController. On non-2xx, throws an Error carrying the
   * HTTP status so `mapOllamaError` can triage without us re-parsing.
   */
  private async fetchJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
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
    }
  }
}

/**
 * SSRF guard for `ollama.base_url`. Rejects any URL whose host resolves to a
 * non-public address unless `allowPrivate` is true. Mirrors the classifier
 * `plugins/rss/url-validator.ts` uses (default-deny anything whose
 * `ipaddr.js` range isn't `unicast`, including IPv4-mapped IPv6).
 *
 * Throws an AIProviderError on any failure so `initialize()` surfaces the
 * reason to the plugin's warn path instead of silently mis-routing traffic.
 */
async function validateOllamaBaseUrl(rawUrl: string, allowPrivate: boolean): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AIProviderError(`Ollama base_url is not a valid URL: ${rawUrl}`, 'other');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AIProviderError(
      `Ollama base_url scheme must be http or https (got ${parsed.protocol || '(none)'})`,
      'other',
    );
  }
  // URL() leaves IPv6 hostnames wrapped in brackets.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new AIProviderError('Ollama base_url has no hostname', 'other');
  }

  const literalFamily = net.isIP(hostname);
  const addresses: string[] = [];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses.push(hostname);
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      for (const r of records) addresses.push(r.address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AIProviderError(`Ollama base_url DNS lookup failed: ${msg}`, 'other', err);
    }
  }
  if (addresses.length === 0) {
    throw new AIProviderError(`Ollama base_url ${hostname} resolved to no addresses`, 'other');
  }

  if (allowPrivate) return;

  for (const addr of addresses) {
    if (!isPublicAddress(addr)) {
      throw new AIProviderError(
        `Ollama base_url ${hostname} resolves to blocked address ${addr} — ` +
          'set ollama.allow_private_url: true if this is intentional (localhost/private Ollama).',
        'other',
      );
    }
  }
}

/**
 * True if `ip` is a publicly-routable IPv4 or IPv6 address. Delegates to
 * `ipaddr.js` so IPv4-mapped IPv6 hex form (`::ffff:7f00:1`) is classified
 * the same as dotted form.
 */
function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return v6.toIPv4Address().range() === 'unicast';
    }
  }
  return addr.range() === 'unicast';
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
