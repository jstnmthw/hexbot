import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SpotifyAuthError,
  SpotifyHttpError,
  SpotifyNetworkError,
  SpotifyRateLimitError,
  createSpotifyClient,
} from '../../../plugins/spotify-radio/spotify-client';

const TEST_REFRESH = 'TEST_REFRESH_SENTINEL';
const TEST_ROTATED = 'TEST_ROTATED_REFRESH';
const TEST_CLIENT_SECRET = 'TEST_CLIENT_SECRET_SENTINEL';
const TEST_CLIENT_ID = 'TEST_CLIENT_ID';
const TEST_ACCESS = 'TEST_ACCESS_TOKEN';

// Helpers --------------------------------------------------------------------

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function trackBody(opts: {
  id?: string;
  name?: string;
  artists?: Array<{ name: string }>;
  album?: { name: string };
  duration_ms?: number;
  progress_ms?: number;
  is_playing?: boolean;
  type?: 'track' | 'episode';
}): unknown {
  return {
    progress_ms: opts.progress_ms ?? 1234,
    is_playing: opts.is_playing ?? true,
    item: {
      id: opts.id ?? 'TRACK_A',
      name: opts.name ?? 'A',
      type: opts.type ?? 'track',
      duration_ms: opts.duration_ms ?? 60000,
      artists: opts.artists ?? [{ name: 'ArtistA' }],
      album: opts.album ?? { name: 'AlbumA' },
      external_urls: { spotify: `https://open.spotify.com/track/${opts.id ?? 'TRACK_A'}` },
    },
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchFn = typeof globalThis.fetch;
type LogFn = (...args: unknown[]) => void;

function makeRecorder(): {
  fetchSpy: ReturnType<typeof vi.fn<FetchFn>>;
  calls: FetchCall[];
  reply: (handler: (call: FetchCall) => Response | Promise<Response>) => void;
} {
  const calls: FetchCall[] = [];
  let handler: ((call: FetchCall) => Response | Promise<Response>) | null = null;
  const fetchSpy = vi.fn<FetchFn>(async (url, init) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    if (!handler) throw new Error('no handler installed');
    return handler(call);
  });
  return {
    fetchSpy,
    calls,
    reply: (h) => {
      handler = h;
    },
  };
}

interface LogState {
  log: ReturnType<typeof vi.fn<LogFn>>;
  error: ReturnType<typeof vi.fn<LogFn>>;
}

function makeLog(): LogState {
  return { log: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

function assertNoSecrets(...spies: Array<ReturnType<typeof vi.fn<LogFn>>>): void {
  const SECRETS = [TEST_REFRESH, TEST_ROTATED, TEST_CLIENT_SECRET, TEST_ACCESS];
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        const text = typeof arg === 'string' ? arg : JSON.stringify(arg);
        for (const s of SECRETS) {
          expect(text).not.toContain(s);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------

describe('createSpotifyClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('access-token cache + refresh', () => {
    it('mints a token on first call and caches it for subsequent calls', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      let mintCount = 0;
      recorder.reply((call) => {
        if (call.url.includes('/api/token')) {
          mintCount += 1;
          return tokenResponse({
            access_token: TEST_ACCESS,
            expires_in: 3600,
          });
        }
        return jsonResponse(trackBody({}), 200);
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await client.getCurrentlyPlaying();
      await client.getCurrentlyPlaying();
      expect(mintCount).toBe(1);
      assertNoSecrets(log.log, log.error);
    });

    it('re-mints when the cached token is within the refresh skew of expiry', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      let mintCount = 0;
      recorder.reply((call) => {
        if (call.url.includes('/api/token')) {
          mintCount += 1;
          return tokenResponse({
            access_token: `${TEST_ACCESS}_${mintCount}`,
            expires_in: 60, // 60 seconds, default skew is 60 seconds
          });
        }
        return jsonResponse(trackBody({}), 200);
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await client.getCurrentlyPlaying();
      // Default skew is 60s; expiry is 60s away → second call must re-mint.
      await client.getCurrentlyPlaying();
      expect(mintCount).toBe(2);
    });

    it('rotates the refresh token when Spotify returns a new one and never sends the old one again', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      let firstMint = true;
      const sentRefreshTokens: string[] = [];
      recorder.reply((call) => {
        if (call.url.includes('/api/token')) {
          const body = call.init.body;
          const params = new URLSearchParams(typeof body === 'string' ? body : '');
          sentRefreshTokens.push(params.get('refresh_token') ?? '');
          if (firstMint) {
            firstMint = false;
            return tokenResponse({
              access_token: `${TEST_ACCESS}_1`,
              refresh_token: TEST_ROTATED,
              expires_in: 1, // force re-mint immediately
            });
          }
          return tokenResponse({
            access_token: `${TEST_ACCESS}_2`,
            expires_in: 3600,
          });
        }
        return jsonResponse(trackBody({}), 200);
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await client.getCurrentlyPlaying();
      await client.getCurrentlyPlaying();
      expect(sentRefreshTokens[0]).toBe(TEST_REFRESH);
      expect(sentRefreshTokens[1]).toBe(TEST_ROTATED);
      // Rotation announced (fact only, not value).
      expect(log.log).toHaveBeenCalled();
      assertNoSecrets(log.log, log.error);
    });

    it('throws SpotifyAuthError on 400 from the token endpoint', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      // Hostile body shape: error description that quotes the secret.
      // The thrown error must NOT echo it.
      recorder.reply(() =>
        tokenResponse(
          { error: 'invalid_grant', error_description: `bad refresh: ${TEST_REFRESH}` },
          400,
        ),
      );
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      let thrown: unknown = null;
      try {
        await client.getCurrentlyPlaying();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SpotifyAuthError);
      const msg = (thrown as Error).message;
      expect(msg).not.toContain(TEST_REFRESH);
      assertNoSecrets(log.log, log.error);
    });

    it('throws SpotifyHttpError when the token-endpoint body is malformed (missing access_token)', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      // 200 OK with a body that's missing fields parseTokenResponse requires.
      recorder.reply(() => tokenResponse({ refresh_token: 'rt', expires_in: 60 }));
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('throws SpotifyHttpError when the token-endpoint body is missing expires_in', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      recorder.reply(() => tokenResponse({ access_token: TEST_ACCESS, refresh_token: 'rt' }));
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('throws SpotifyHttpError when the token-endpoint body parses to a non-object (string)', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      // JSON-valid but not an object — parses to "stringly-typed".
      recorder.reply(
        () =>
          new Response(JSON.stringify('stringly-typed'), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('throws SpotifyHttpError on a non-JSON 200 token-endpoint body', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      recorder.reply(() => new Response('not json', { status: 200 }));
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('throws SpotifyHttpError on other non-2xx from the token endpoint', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      recorder.reply(() => new Response('', { status: 503 }));
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('wraps a non-Error thrown from fetch as SpotifyNetworkError', async () => {
      const log = makeLog();
      const fetchSpy = vi.fn<FetchFn>(async () => {
        // Intentionally non-Error to exercise the fallback branch.
        throw 'string-failure';
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyNetworkError);
    });

    it('throws SpotifyAuthError on 401 from the token endpoint', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      recorder.reply(() => new Response('', { status: 401 }));
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyAuthError);
    });
  });

  // -------------------------------------------------------------------------
  describe('getCurrentlyPlaying', () => {
    function clientWithSequencedFetch(responses: Response[]) {
      const recorder = makeRecorder();
      const log = makeLog();
      // Token endpoint always succeeds; the listed responses cover the
      // currently-playing endpoint in order.
      let i = 0;
      recorder.reply((call) => {
        if (call.url.includes('/api/token')) {
          return tokenResponse({ access_token: TEST_ACCESS, expires_in: 3600 });
        }
        const r = responses[i++];
        if (!r) throw new Error('out of scripted responses');
        return r;
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      return { client, recorder, log };
    }

    it('returns null on 204', async () => {
      const { client } = clientWithSequencedFetch([new Response(null, { status: 204 })]);
      await expect(client.getCurrentlyPlaying()).resolves.toBeNull();
    });

    it('returns a populated CurrentlyPlaying on 200 with item.type === track', async () => {
      const { client } = clientWithSequencedFetch([
        jsonResponse(
          trackBody({ id: 'X', name: 'Song', artists: [{ name: 'A1' }, { name: 'A2' }] }),
          200,
        ),
      ]);
      const got = await client.getCurrentlyPlaying();
      expect(got).not.toBeNull();
      expect(got!.trackId).toBe('X');
      expect(got!.title).toBe('Song');
      expect(got!.artist).toBe('A1, A2');
      expect(got!.url).toBe('https://open.spotify.com/track/X');
    });

    it('returns null when item.type is episode', async () => {
      const { client } = clientWithSequencedFetch([
        jsonResponse(trackBody({ type: 'episode' }), 200),
      ]);
      await expect(client.getCurrentlyPlaying()).resolves.toBeNull();
    });

    it('one-shot retries on 401 and succeeds when retry returns 200', async () => {
      const { client, recorder } = clientWithSequencedFetch([
        new Response('', { status: 401 }),
        jsonResponse(trackBody({ id: 'Y' }), 200),
      ]);
      const got = await client.getCurrentlyPlaying();
      expect(got).not.toBeNull();
      expect(got!.trackId).toBe('Y');
      // Token endpoint hit twice (initial mint + force-mint); currently-
      // playing endpoint hit twice (initial 401 + retry 200).
      const tokenCalls = recorder.calls.filter((c) => c.url.includes('/api/token')).length;
      const playingCalls = recorder.calls.filter((c) =>
        c.url.includes('/me/player/currently-playing'),
      ).length;
      expect(tokenCalls).toBe(2);
      expect(playingCalls).toBe(2);
    });

    it('throws SpotifyAuthError when both initial 401 and retry 401 occur', async () => {
      const { client } = clientWithSequencedFetch([
        new Response('', { status: 401 }),
        new Response('', { status: 401 }),
      ]);
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyAuthError);
    });

    it('throws SpotifyRateLimitError on 429 with Retry-After', async () => {
      const { client } = clientWithSequencedFetch([
        new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
      ]);
      let thrown: unknown = null;
      try {
        await client.getCurrentlyPlaying();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SpotifyRateLimitError);
      expect((thrown as SpotifyRateLimitError).retryAfterSec).toBe(30);
    });

    it('clamps absurd Retry-After values to 300s', async () => {
      const { client } = clientWithSequencedFetch([
        new Response('', { status: 429, headers: { 'Retry-After': '99999' } }),
      ]);
      const err = await client.getCurrentlyPlaying().catch((e) => e);
      expect((err as SpotifyRateLimitError).retryAfterSec).toBe(300);
    });

    it('throws SpotifyHttpError when /currently-playing returns 200 with malformed JSON', async () => {
      const recorder = makeRecorder();
      const log = makeLog();
      let phase = 0;
      recorder.reply((call) => {
        phase += 1;
        if (call.url.includes('/api/token')) {
          return tokenResponse({ access_token: TEST_ACCESS, expires_in: 3600 });
        }
        // First /currently-playing call — return 200 with non-JSON body.
        return new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      });
      void phase;
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('throws SpotifyHttpError on other non-2xx responses', async () => {
      const { client } = clientWithSequencedFetch([new Response('', { status: 503 })]);
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyHttpError);
    });

    it('wraps a fetch rejection as SpotifyNetworkError', async () => {
      const log = makeLog();
      const fetchSpy = vi.fn<FetchFn>(async () => {
        throw new TypeError('fetch failed');
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: fetchSpy,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyNetworkError);
    });

    it('aborts a hung fetch after the configured timeout', async () => {
      const log = makeLog();
      // A fetch that resolves to whatever signal aborts it.
      const fetchSpy = vi.fn<FetchFn>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: fetchSpy,
        timeoutMs: 50,
      });
      const pending = client.getCurrentlyPlaying().catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await pending;
      expect(err).toBeInstanceOf(SpotifyNetworkError);
      expect((err as Error).message).toMatch(/timed out/);
    });

    it('cancels in-flight fetch when an external abortSignal fires', async () => {
      const log = makeLog();
      const fetchSpy = vi.fn<FetchFn>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const external = new AbortController();
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: fetchSpy,
        timeoutMs: 30_000,
        abortSignal: external.signal,
      });
      const pending = client.getCurrentlyPlaying().catch((e) => e);
      // Yield once so fetchWithTimeout has registered the abort listener.
      await Promise.resolve();
      external.abort();
      const err = await pending;
      expect(err).toBeInstanceOf(SpotifyNetworkError);
    });

    it('rejects immediately when external abortSignal is already aborted', async () => {
      const log = makeLog();
      // Mock matches real fetch semantics: an already-aborted signal at
      // call time produces an immediate AbortError rejection.
      const fetchSpy = vi.fn<FetchFn>(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const fail = (): void => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal?.aborted) {
              fail();
              return;
            }
            signal?.addEventListener('abort', fail);
          }),
      );
      const external = new AbortController();
      external.abort();
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: fetchSpy,
        timeoutMs: 30_000,
        abortSignal: external.signal,
      });
      await expect(client.getCurrentlyPlaying()).rejects.toBeInstanceOf(SpotifyNetworkError);
    });
  });

  // -------------------------------------------------------------------------
  describe('secret redaction across all paths', () => {
    it('never includes credentials in any thrown error or log call across the test matrix above', async () => {
      // This test re-exercises a representative sample of failure modes
      // and asserts the global property: secrets MUST NOT appear in any
      // thrown Error or in any log/error spy invocation. The earlier
      // tests assert this per-case; this one is the catch-all backstop.
      const recorder = makeRecorder();
      const log = makeLog();
      let phase = 0;
      recorder.reply((call) => {
        phase += 1;
        if (call.url.includes('/api/token')) {
          if (phase === 1) {
            return tokenResponse({
              access_token: TEST_ACCESS,
              refresh_token: TEST_ROTATED,
              expires_in: 1,
            });
          }
          return tokenResponse(
            { error: 'invalid_grant', error_description: `secret was ${TEST_REFRESH}` },
            400,
          );
        }
        return new Response('', { status: 401 });
      });
      const client = createSpotifyClient({
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        refreshToken: TEST_REFRESH,
        log: log.log,
        error: log.error,
        fetch: recorder.fetchSpy,
      });
      const err = await client.getCurrentlyPlaying().catch((e) => e);
      // Whatever it threw, the message must not echo secrets.
      const msg = err instanceof Error ? err.message : String(err);
      for (const secret of [TEST_REFRESH, TEST_ROTATED, TEST_CLIENT_SECRET, TEST_ACCESS]) {
        expect(msg).not.toContain(secret);
      }
      assertNoSecrets(log.log, log.error);
    });
  });
});
