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
  ): Promise<AIResponse> {
    if (!this.model) throw new AIProviderError('Gemini provider not initialized', 'other');

    const contents = toGeminiContents(messages);
    if (contents.length === 0) {
      throw new AIProviderError('No messages to send to Gemini', 'other');
    }

    try {
      const result = await withTimeout(
        this.model.generateContent({
          contents,
          systemInstruction: systemPrompt
            ? { role: 'system', parts: [{ text: systemPrompt }] }
            : undefined,
          generationConfig: {
            temperature: this.temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        GEMINI_REQUEST_TIMEOUT_MS,
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
    }
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
 * treat it like any other transient infrastructure failure.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AIProviderError(`Gemini request timed out after ${ms}ms`, 'network'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
      `Gemini HTTP ${status}${err.statusText ? `: ${err.statusText}` : ''}`,
      'network',
      err,
    );
  }

  if (err instanceof GoogleGenerativeAIResponseError) {
    return new AIProviderError('Gemini response error', 'safety', err);
  }

  if (err instanceof Error) {
    return new AIProviderError(err.message, 'other', err);
  }

  return new AIProviderError('Unknown Gemini error', 'other', err);
}
