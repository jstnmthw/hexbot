// Gemini provider adapter.
// Wraps Google's @google/generative-ai SDK behind the AIProvider interface.
import {
  type Content,
  type GenerativeModel,
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
} from '@google/generative-ai';

import {
  type AIMessage,
  type AIProvider,
  type AIProviderConfig,
  AIProviderError,
  type AIResponse,
  type SamplingOptions,
} from './types';

/**
 * Per-request timeout for Gemini API calls. A hung TCP body / slow-loris
 * from the endpoint would otherwise stall generateContent forever — the
 * ResilientProvider circuit-breaker only fires on thrown errors, not on
 * hangs, so one stuck request starves the global RPM slot. 30s gives
 * enough slack for legitimate cold-start latency while bounding worst case.
 */
const GEMINI_REQUEST_TIMEOUT_MS = 30_000;

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  private client: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;
  private modelName = '';
  private temperature = 0.9;
  private maxOutputTokens = 256;
  /**
   * Per-request AbortControllers tracked for {@link abort}. The Google SDK
   * doesn't expose a cancel API, so we can't stop the underlying HTTP POST
   * — but we can reject the outer {@link withTimeout} race so the plugin's
   * awaiters see an AbortError and release their captured refs. The SDK
   * call finishes on its own and its result is dropped.
   */
  private inflightControllers = new Set<AbortController>();
  /**
   * Bumped on every {@link abort}; fetches tag themselves with the epoch at
   * start and skip the cleanup-on-finish if it advanced. See ollama.ts for
   * the full rationale (W10.3).
   */
  private epoch = 0;

  async initialize(config: AIProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new AIProviderError('Gemini API key is empty', 'auth');
    }
    this.modelName = config.model;
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens;
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.model = this.client.getGenerativeModel({
      model: this.modelName,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
      },
    });
  }

  async complete(
    systemPrompt: string,
    messages: AIMessage[],
    maxTokens: number,
    sampling?: SamplingOptions,
  ): Promise<AIResponse> {
    if (!this.model) throw new AIProviderError('Gemini provider not initialized', 'other');

    const contents = toGeminiContents(messages);
    if (contents.length === 0) {
      throw new AIProviderError('No messages to send to Gemini', 'other');
    }

    const generationConfig: Record<string, unknown> = {
      temperature: sampling?.temperature ?? this.temperature,
      maxOutputTokens: maxTokens,
    };
    if (sampling?.topP !== undefined) generationConfig.topP = sampling.topP;
    if (sampling?.stop && sampling.stop.length > 0) {
      generationConfig.stopSequences = sampling.stop.slice(0, 5);
    }

    const controller = new AbortController();
    const startEpoch = this.epoch;
    this.inflightControllers.add(controller);
    try {
      const result = await withTimeout(
        this.model.generateContent({
          contents,
          systemInstruction: systemPrompt
            ? { role: 'system', parts: [{ text: systemPrompt }] }
            : undefined,
          generationConfig,
        }),
        GEMINI_REQUEST_TIMEOUT_MS,
        controller.signal,
      );

      const response = result.response;
      const candidate = response.candidates?.[0];

      // Gemini returns empty candidates when content is blocked by safety filters.
      if (!candidate || !candidate.content?.parts?.length) {
        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
          throw new AIProviderError(`Gemini blocked the prompt: ${blockReason}`, 'safety');
        }
        const finish = candidate?.finishReason;
        if (finish === 'SAFETY' || finish === 'RECITATION') {
          throw new AIProviderError(`Gemini blocked the response: ${finish}`, 'safety');
        }
        throw new AIProviderError('Gemini returned no content', 'other');
      }

      // Gemini may return multiple parts for a single candidate (e.g.
      // text + tool-use parts); we only consume `text` parts and concatenate
      // them in order. Non-text parts are silently dropped — the bot doesn't
      // call any tool-use APIs, so any non-text part is unexpected output.
      const text = candidate.content.parts
        .map((p) => ('text' in p && typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();

      const usage = response.usageMetadata;
      return {
        text,
        usage: {
          input: usage?.promptTokenCount ?? 0,
          output: usage?.candidatesTokenCount ?? 0,
        },
        model: this.modelName,
      };
    } catch (err) {
      throw mapGeminiError(err);
    } finally {
      // See ollama.ts for the epoch-mismatch skip rationale (W10.3).
      if (startEpoch === this.epoch) {
        this.inflightControllers.delete(controller);
      }
    }
  }

  /**
   * Reject the outer withTimeout race for every outstanding call. Underlying
   * Google SDK fetches keep running but their results are dropped on arrival.
   */
  abort(): void {
    this.epoch++;
    for (const controller of this.inflightControllers) {
      controller.abort();
    }
    this.inflightControllers.clear();
  }

  async countTokens(text: string): Promise<number> {
    if (!this.model) throw new AIProviderError('Gemini provider not initialized', 'other');
    try {
      const res = await this.model.countTokens(text);
      return res.totalTokens;
    } catch (err) {
      throw mapGeminiError(err);
    }
  }

  getModelName(): string {
    return this.modelName;
  }
}

/** Map an array of AIMessages to Gemini's Content[] format (system messages stripped — handled via systemInstruction). */
function toGeminiContents(messages: AIMessage[]): Content[] {
  const out: Content[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    out.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }
  return out;
}

/**
 * Race a promise against a timeout. On timeout, rejects with an AIProviderError
 * tagged 'network' so the resilient wrapper's retry + circuit-breaker layers
 * treat it like any other transient infrastructure failure. When `abortSignal`
 * is provided, its abort event also rejects the race with a tagged 'network'
 * error — lets plugin teardown release outer awaiters without waiting for
 * the SDK's opaque request promise to settle on its own.
 */
function withTimeout<T>(p: Promise<T>, ms: number, abortSignal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AIProviderError(`Gemini request timed out after ${ms}ms`, 'network'));
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AIProviderError('Gemini request aborted', 'network'));
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Strip anything shaped like a Gemini API key from `s`. Google keys start
 * with `AIza` followed by 35 URL-safe chars; the SDK has, in past versions,
 * embedded the key in the status-line string on auth failures. Every error
 * message we emit passes through this so a 401/403 can't leak an AIza…
 * literal into logs, DCC mirrors, or channel-visible error paths.
 */
export function redactGeminiKey(s: string): string {
  return s.replace(/AIza[0-9A-Za-z_-]{35,}/g, '[REDACTED_API_KEY]');
}

/** Convert Gemini SDK errors into AIProviderError with a kind tag. */
export function mapGeminiError(err: unknown): AIProviderError {
  if (err instanceof AIProviderError) return err;

  if (err instanceof GoogleGenerativeAIFetchError) {
    const status = err.status ?? 0;
    if (status === 429) return new AIProviderError('Gemini rate limit exceeded', 'rate_limit', err);
    if (status === 401 || status === 403)
      return new AIProviderError('Gemini auth error', 'auth', err);
    if (status >= 500) return new AIProviderError('Gemini server error', 'network', err);
    return new AIProviderError(
      redactGeminiKey(`Gemini HTTP ${status}${err.statusText ? `: ${err.statusText}` : ''}`),
      'network',
      err,
    );
  }

  if (err instanceof GoogleGenerativeAIResponseError) {
    return new AIProviderError('Gemini response error', 'safety', err);
  }

  if (err instanceof Error) {
    return new AIProviderError(redactGeminiKey(err.message), 'other', err);
  }

  return new AIProviderError('Unknown Gemini error', 'other', err);
}
