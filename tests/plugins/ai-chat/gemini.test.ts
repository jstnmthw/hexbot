// Unit tests for the Gemini provider adapter.
// The @google/generative-ai SDK is mocked so no real API calls are made.
import {
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
} from '@google/generative-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiProvider,
  mapGeminiError,
  redactGeminiKey,
} from '../../../plugins/ai-chat/providers/gemini';
import { AIProviderError } from '../../../plugins/ai-chat/providers/types';

const generateContent = vi.fn();
const countTokensFn = vi.fn();
const getGenerativeModel = vi.fn();

vi.mock('@google/generative-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/generative-ai')>();
  class MockGoogleGenerativeAI {
    getGenerativeModel = getGenerativeModel;
  }
  return {
    ...actual,
    GoogleGenerativeAI: MockGoogleGenerativeAI,
  };
});

beforeEach(() => {
  generateContent.mockReset();
  countTokensFn.mockReset();
  getGenerativeModel.mockReset();
  getGenerativeModel.mockReturnValue({
    generateContent,
    countTokens: countTokensFn,
  });
});

async function makeProvider(): Promise<GeminiProvider> {
  const provider = new GeminiProvider();
  await provider.initialize({
    apiKey: 'test-key',
    model: 'gemini-2.5-flash-lite',
    maxOutputTokens: 128,
    temperature: 0.7,
  });
  return provider;
}

describe('GeminiProvider.initialize', () => {
  it('throws AIProviderError when apiKey is empty', async () => {
    const provider = new GeminiProvider();
    await expect(
      provider.initialize({ apiKey: '', model: 'm', maxOutputTokens: 100, temperature: 0.5 }),
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it('stores model name for getModelName()', async () => {
    const provider = await makeProvider();
    expect(provider.getModelName()).toBe('gemini-2.5-flash-lite');
  });
});

describe('GeminiProvider.complete', () => {
  it('throws when not initialized', async () => {
    const provider = new GeminiProvider();
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'hi' }], 100),
    ).rejects.toMatchObject({
      kind: 'other',
    });
  });

  it('returns text + usage on success', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hello there' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    });

    const res = await provider.complete('system', [{ role: 'user', content: 'hi' }], 256);
    expect(res.text).toBe('hello there');
    expect(res.usage).toEqual({ input: 10, output: 5 });
    expect(res.model).toBe('gemini-2.5-flash-lite');
  });

  it('maps user/assistant roles to Gemini user/model roles and skips system', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    });

    await provider.complete(
      'you are helpful',
      [
        { role: 'system', content: 'system msg should be stripped' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      128,
    );

    const callArg = generateContent.mock.calls[0][0];
    expect(callArg.contents).toEqual([
      { role: 'user', parts: [{ text: 'q1' }] },
      { role: 'model', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ text: 'q2' }] },
    ]);
    expect(callArg.systemInstruction).toMatchObject({
      parts: [{ text: 'you are helpful' }],
    });
    expect(callArg.generationConfig.maxOutputTokens).toBe(128);
  });

  it('omits systemInstruction when prompt is empty', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    });

    await provider.complete('', [{ role: 'user', content: 'q' }], 128);

    const callArg = generateContent.mock.calls[0][0];
    expect(callArg.systemInstruction).toBeUndefined();
  });

  it('throws when no messages are supplied', async () => {
    const provider = await makeProvider();
    await expect(provider.complete('sys', [], 100)).rejects.toMatchObject({ kind: 'other' });
  });

  it('throws safety error when promptFeedback.blockReason is set', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [],
        promptFeedback: { blockReason: 'SAFETY' },
      },
    });

    await expect(
      provider.complete('sys', [{ role: 'user', content: 'bad' }], 128),
    ).rejects.toMatchObject({
      kind: 'safety',
    });
  });

  it('throws safety error when finishReason is SAFETY', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
      },
    });

    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'safety',
    });
  });

  it('throws safety error for RECITATION finishReason', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }],
      },
    });

    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'safety',
    });
  });

  it('throws generic error when candidate has no content', async () => {
    const provider = await makeProvider();
    generateContent.mockResolvedValueOnce({
      response: { candidates: [{ content: { parts: [] }, finishReason: 'OTHER' }] },
    });

    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'other',
    });
  });

  it('maps 429 fetch errors to rate_limit', async () => {
    const provider = await makeProvider();
    generateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError('quota exceeded', 429, 'Too Many Requests'),
    );
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('maps 401/403 fetch errors to auth', async () => {
    const provider = await makeProvider();
    generateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError('unauthorized', 401, 'Unauthorized'),
    );
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('maps 5xx fetch errors to network', async () => {
    const provider = await makeProvider();
    generateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError('server boom', 503, 'Service Unavailable'),
    );
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps other fetch errors to network', async () => {
    const provider = await makeProvider();
    generateContent.mockRejectedValueOnce(
      new GoogleGenerativeAIFetchError('bad request', 400, 'Bad Request'),
    );
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps response errors to safety', async () => {
    const provider = await makeProvider();
    generateContent.mockRejectedValueOnce(new GoogleGenerativeAIResponseError('blocked'));
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'x' }], 128),
    ).rejects.toMatchObject({
      kind: 'safety',
    });
  });
});

describe('GeminiProvider.countTokens', () => {
  it('throws when not initialized', async () => {
    const provider = new GeminiProvider();
    await expect(provider.countTokens('hi')).rejects.toMatchObject({ kind: 'other' });
  });

  it('returns totalTokens', async () => {
    const provider = await makeProvider();
    countTokensFn.mockResolvedValueOnce({ totalTokens: 42 });
    expect(await provider.countTokens('hello world')).toBe(42);
  });

  it('wraps SDK errors into AIProviderError', async () => {
    const provider = await makeProvider();
    countTokensFn.mockRejectedValueOnce(new GoogleGenerativeAIFetchError('bad', 429, 'Too Many'));
    await expect(provider.countTokens('hello')).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('mapGeminiError', () => {
  it('passes AIProviderError through unchanged', () => {
    const original = new AIProviderError('boom', 'safety');
    expect(mapGeminiError(original)).toBe(original);
  });

  it('maps plain Error to other', () => {
    const err = mapGeminiError(new Error('nope'));
    expect(err.kind).toBe('other');
    expect(err.message).toBe('nope');
  });

  it('maps non-error values to other', () => {
    const err = mapGeminiError('string error');
    expect(err.kind).toBe('other');
    expect(err.message).toBe('Unknown Gemini error');
  });

  it('redacts AIza… API keys from plain Error messages', () => {
    // A fake-shape key (correct prefix + 35 url-safe chars) — must not leak.
    const leak = 'auth failed for AIza0123456789ABCDEFGHIJ-_abcdefghijKLMNO key rejected';
    const err = mapGeminiError(new Error(leak));
    expect(err.message).not.toContain('AIza0123456789');
    expect(err.message).toContain('[REDACTED_API_KEY]');
  });

  it('redacts AIza… API keys from HTTP error status lines', () => {
    const fetchErr = Object.assign(new Error('HTTP 400'), {
      status: 400,
      statusText: 'Bad Request: key=AIza0123456789ABCDEFGHIJ-_abcdefghijKLMNO',
    });
    Object.setPrototypeOf(fetchErr, GoogleGenerativeAIFetchError.prototype);
    const err = mapGeminiError(fetchErr);
    expect(err.message).not.toContain('AIza0123456789');
    expect(err.message).toContain('[REDACTED_API_KEY]');
  });
});

describe('redactGeminiKey', () => {
  it('replaces key-shaped strings with a placeholder', () => {
    const out = redactGeminiKey('before AIza0123456789ABCDEFGHIJ-_abcdefghijKLMNO after');
    expect(out).toBe('before [REDACTED_API_KEY] after');
  });

  it('leaves key-free strings untouched', () => {
    expect(redactGeminiKey('no keys here')).toBe('no keys here');
  });

  it('redacts multiple keys in the same string', () => {
    const s =
      'key1=AIza0123456789ABCDEFGHIJ-_abcdefghijKLMNO key2=AIzaABCDEFGHIJKLMNOPQRS-_tuvwxyz01234567';
    const out = redactGeminiKey(s);
    expect(out).not.toMatch(/AIza[A-Za-z0-9]/);
    expect((out.match(/\[REDACTED_API_KEY\]/g) ?? []).length).toBe(2);
  });
});
