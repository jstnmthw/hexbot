// Unit tests for the Ollama provider adapter.
// Global fetch is mocked so no real HTTP requests escape the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OllamaHttpError,
  OllamaProvider,
  mapOllamaError,
} from '../../plugins/ai-chat/providers/ollama';
import { AIProviderError } from '../../plugins/ai-chat/providers/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Build a Response-like object the provider's fetchJson will accept. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, text = ''): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

/** Initialize the provider with a stubbed /api/tags response. */
async function makeProvider(overrides: Partial<Parameters<OllamaProvider['initialize']>[0]> = {}) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      models: [{ name: 'llama3:8b-instruct-q4_K_M' }],
    }),
  );
  const provider = new OllamaProvider();
  await provider.initialize({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3:8b-instruct-q4_K_M',
    maxOutputTokens: 128,
    temperature: 0.7,
    requestTimeoutMs: 30_000,
    ...overrides,
  });
  return provider;
}

describe('OllamaProvider.initialize', () => {
  it('rejects when baseUrl is empty', async () => {
    const provider = new OllamaProvider();
    await expect(
      provider.initialize({ baseUrl: '', model: 'm', maxOutputTokens: 100, temperature: 0.5 }),
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it('stores the model name and strips trailing slashes from baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'llama3' }] }));
    const provider = new OllamaProvider();
    await provider.initialize({
      baseUrl: 'http://127.0.0.1:11434///',
      model: 'llama3',
      maxOutputTokens: 64,
      temperature: 0.6,
    });
    expect(provider.getModelName()).toBe('llama3');
    // Subsequent call will use the stripped base URL.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'hi' } }),
    );
    await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('warns but does not throw when the model is absent from /api/tags', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'other-model' }] }));
    const provider = new OllamaProvider();
    await provider.initialize({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      maxOutputTokens: 64,
      temperature: 0.6,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('maps daemon unreachable to network error', async () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    fetchMock.mockRejectedValueOnce(err);
    const provider = new OllamaProvider();
    await expect(
      provider.initialize({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3',
        maxOutputTokens: 64,
        temperature: 0.6,
      }),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('OllamaProvider.complete', () => {
  it('throws when not initialized', async () => {
    const provider = new OllamaProvider();
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'hi' }], 128),
    ).rejects.toMatchObject({ kind: 'other' });
  });

  it('returns text + usage on a successful chat response', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        message: { role: 'assistant', content: 'hello there' },
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    );
    const res = await provider.complete('system', [{ role: 'user', content: 'hi' }], 256);
    expect(res.text).toBe('hello there');
    expect(res.usage).toEqual({ input: 10, output: 5 });
    expect(res.model).toBe('llama3:8b-instruct-q4_K_M');
  });

  it('prepends a system message and passes through conversation roles', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete(
      'you are helpful',
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      128,
    );
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3:8b-instruct-q4_K_M');
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(body.options.num_predict).toBe(128);
  });

  it('omits the system message when the prompt is empty', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete('', [{ role: 'user', content: 'q' }], 64);
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toEqual({ role: 'user', content: 'q' });
  });

  it('omits keep_alive and options.num_ctx when they are not configured', async () => {
    // Default config doesn't set either — we must NOT send them so the
    // daemon picks its own defaults instead of pinning to zero.
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty('keep_alive');
    expect(body.options).not.toHaveProperty('num_ctx');
  });

  it('sends keep_alive at the top level of the request body when configured', async () => {
    const provider = await makeProvider({ keepAlive: '30m' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body.keep_alive).toBe('30m');
  });

  it('sends options.num_ctx when numCtx is a positive integer', async () => {
    const provider = await makeProvider({ numCtx: 4096 });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body.options.num_ctx).toBe(4096);
  });

  it('omits num_ctx when numCtx is 0 (leave daemon default)', async () => {
    // Operators who pass num_ctx: 0 explicitly want "no pin" — we must not
    // send options.num_ctx: 0 since that would load the model with a 0-size
    // context and fail. Only positive values get forwarded.
    const provider = await makeProvider({ numCtx: 0 });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'ok' } }),
    );
    await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init.body));
    expect(body.options).not.toHaveProperty('num_ctx');
  });

  it('returns zero usage when the server omits eval counts', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: 'hi' } }),
    );
    const res = await provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    expect(res.usage).toEqual({ input: 0, output: 0 });
  });

  it('maps HTTP 404 to non-retryable "other" (model not pulled)', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(errorResponse(404, 'model not found'));
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'other' });
  });

  it('maps HTTP 400 to non-retryable "other"', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(errorResponse(400, 'bad prompt'));
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'other' });
  });

  it('maps HTTP 500 to retryable network error', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'overloaded'));
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps ECONNREFUSED to network error', async () => {
    const provider = await makeProvider();
    const err = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    fetchMock.mockRejectedValueOnce(err);
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps AbortError (timeout) to network error', async () => {
    const provider = await makeProvider();
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(err);
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('aborts the request when the per-request timeout fires', async () => {
    const provider = await makeProvider({ requestTimeoutMs: 50 });
    fetchMock.mockImplementationOnce(
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
            reject(err);
          });
        }),
    );
    const promise = provider.complete('sys', [{ role: 'user', content: 'q' }], 64);
    await expect(promise).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws "other" when the response has no content and no error field', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { role: 'assistant', content: '' } }));
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'other' });
  });

  it('surfaces the server error field when content is empty', async () => {
    const provider = await makeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { role: 'assistant', content: '' }, error: 'model unloaded' }),
    );
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'other', message: expect.stringContaining('model unloaded') });
  });

  it('falls back to empty body when response.text() throws', async () => {
    const provider = await makeProvider();
    const response = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
      text: async () => {
        throw new Error('body already consumed');
      },
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      provider.complete('sys', [{ role: 'user', content: 'q' }], 64),
    ).rejects.toMatchObject({ kind: 'other' });
  });
});

describe('OllamaProvider.countTokens', () => {
  it('uses the 4-chars-per-token heuristic by default', async () => {
    const provider = await makeProvider();
    expect(await provider.countTokens('x'.repeat(400))).toBe(100);
    // Rounds up — one extra char bumps the count.
    expect(await provider.countTokens('x'.repeat(401))).toBe(101);
  });

  it('calls /api/tokenize when use_server_tokenizer is true', async () => {
    const provider = await makeProvider({ useServerTokenizer: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ tokens: [1, 2, 3, 4, 5] }));
    expect(await provider.countTokens('hello world')).toBe(5);
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:11434/api/tokenize');
  });

  it('wraps server tokenizer errors into AIProviderError', async () => {
    const provider = await makeProvider({ useServerTokenizer: true });
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom'));
    await expect(provider.countTokens('hi')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('mapOllamaError', () => {
  it('passes AIProviderError through unchanged', () => {
    const original = new AIProviderError('already mapped', 'network');
    expect(mapOllamaError(original)).toBe(original);
  });

  it('tags 404 OllamaHttpError as "other" so it does not retry', () => {
    const mapped = mapOllamaError(new OllamaHttpError(404, 'no such model'));
    expect(mapped.kind).toBe('other');
  });

  it('tags 502 OllamaHttpError as "network" for retry', () => {
    const mapped = mapOllamaError(new OllamaHttpError(502, 'bad gateway'));
    expect(mapped.kind).toBe('network');
  });

  it('tags 401 OllamaHttpError as "other" (no retry on auth-style failures)', () => {
    const mapped = mapOllamaError(new OllamaHttpError(401, 'unauthorized'));
    expect(mapped.kind).toBe('other');
  });

  it('tags a plain Error without a network-style code as "other"', () => {
    const mapped = mapOllamaError(new Error('bogus JSON'));
    expect(mapped.kind).toBe('other');
  });

  it('tags non-error values as "other"', () => {
    expect(mapOllamaError('nope').kind).toBe('other');
  });
});
