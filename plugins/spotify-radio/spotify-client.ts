// spotify-radio — Spotify Web API client (token cache + currently-playing).
//
// Plugin-local helper. Knows nothing about IRC, plugin lifecycle, or the
// session state model — its only concerns are: hold the long-lived
// refresh token, mint short-lived access tokens against it, and read
// `/v1/me/player/currently-playing`. The IRC poll loop in index.ts owns
// timing, announcement formatting, and error-budget logic.
//
// SECURITY:
//   * No log line, error, or thrown exception in this module includes
//     the access token, the refresh token, the Authorization header, or
//     the raw response body — Spotify's error responses occasionally
//     reflect submitted credentials, so the body is not safe to expose.
//   * Every fetch is wrapped by a 10-second AbortController so a hung
//     server cannot deadlock the poll loop. Aborts surface as
//     SpotifyNetworkError so the existing error-budget path handles them.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CurrentlyPlaying {
  /** Stable Spotify track id — used as the change-detection key. */
  trackId: string;
  /** Track name, raw from the API; the caller must run it through stripFormatting. */
  title: string;
  /** Comma-joined artist names, raw from the API. */
  artist: string;
  /** Album name, raw from the API. */
  album: string;
  /** Canonical https://open.spotify.com/track/<id> URL — safe to re-broadcast. */
  url: string;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
}

export interface SpotifyClient {
  getCurrentlyPlaying(): Promise<CurrentlyPlaying | null>;
  /**
   * Pre-flight check used by `!radio on` to verify the refresh-token still
   * works before announcing a new session in-channel. Resolves on success
   * (token refreshed) and rejects with a SpotifyAuthError / SpotifyHttpError
   * / SpotifyNetworkError on failure. Implementations should _not_ consume
   * a `getCurrentlyPlaying` response (test stubs script those by call count
   * and we don't want pre-flight to advance the script).
   */
  verifyToken(): Promise<void>;
}

export interface SpotifyClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /**
   * Plugin's logger surface. Only `log` and `error` are used. The client
   * never passes raw response bodies, headers, or credentials through
   * either function — log lines are limited to action verbs + status
   * codes + booleans.
   */
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /**
   * Test seam. Defaults to `globalThis.fetch`. Tests inject a stub so
   * the client can be exercised without real HTTP traffic.
   */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the per-fetch timeout (default 10s, see SECURITY note). */
  timeoutMs?: number;
  /**
   * Test seam for the cache-refresh skew (default 60s; the cached
   * access token is re-minted this many ms before its real expiry).
   */
  refreshSkewMs?: number;
  /**
   * Plugin-lifecycle abort signal. When the plugin's `teardown()` aborts
   * its own controller, every in-flight fetch this client started cancels
   * immediately instead of pinning the closure (which retains the refresh
   * token) for up to `timeoutMs`. Optional for tests that don't care
   * about teardown — production wiring always passes one.
   */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Refresh token rejected (revoked, scope mismatch, account moved, ...).
 * The poll loop ends the session immediately on this error — no point
 * retrying when the credential is dead.
 */
export class SpotifyAuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Spotify auth failed (HTTP ${status})`);
    this.name = 'SpotifyAuthError';
    this.status = status;
  }
}

/** Spotify rate-limited us; back off for `retryAfterSec` before the next call. */
export class SpotifyRateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`Spotify rate-limited (Retry-After ${retryAfterSec}s)`);
    this.name = 'SpotifyRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Any other non-2xx, non-401, non-429 HTTP status from Spotify. */
export class SpotifyHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Spotify HTTP error ${status}`);
    this.name = 'SpotifyHttpError';
    this.status = status;
  }
}

/** Network failure: DNS, TCP, TLS, or fetch timeout. */
export class SpotifyNetworkError extends Error {
  constructor(message: string) {
    super(`Spotify network error: ${message}`);
    this.name = 'SpotifyNetworkError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const CURRENTLY_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a SpotifyClient bound to one operator's credentials. Each call
 * to `createSpotifyClient` allocates fresh state — there is no shared
 * cache between sessions.
 *
 * The refresh token is held in a module-local mutable variable inside
 * this closure. When Spotify returns a rotated `refresh_token` in a
 * token-endpoint response, the closure overwrites the variable and
 * logs that rotation happened (without echoing the value). The bot
 * never persists the rotated value back to bot.env — on restart, the
 * operator re-runs `pnpm run spotify:auth` if Spotify has fully
 * rotated the original token.
 */
export function createSpotifyClient(opts: SpotifyClientOptions): SpotifyClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

  // Mutable refresh-token slot. Seeded from opts; rotated in-memory if
  // Spotify returns a new value in any future token-endpoint response.
  // Kept inside this closure so no other module can read it.
  let currentRefreshToken = opts.refreshToken;
  let cached: CachedToken | null = null;

  /**
   * `fetch` wrapper with a hard AbortController timeout. A hung TLS
   * handshake or a TCP black hole would otherwise stall the bot's
   * poll loop indefinitely; this path always resolves within
   * `timeoutMs` (or sooner on a real error). When the caller supplies
   * `opts.abortSignal`, we forward an aggregate signal so a plugin
   * teardown that aborts mid-flight cancels the fetch immediately
   * instead of waiting for the timeout — without this, the SpotifyClient
   * closure (which holds the refresh token) is pinned for up to
   * `timeoutMs` after teardown.
   */
  async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = opts.abortSignal;
    let onExternalAbort: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        onExternalAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new SpotifyNetworkError(
        isAbort ? `request timed out after ${timeoutMs}ms` : describeNetworkError(err),
      );
    } finally {
      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async function refreshAccessToken(): Promise<CachedToken> {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
    });
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: body.toString(),
    });
    if (res.status === 400 || res.status === 401) {
      // Drain and discard the body — Spotify error responses can echo
      // the submitted credentials, so we never read it into a logged
      // string. Reading-and-discarding ensures the connection isn't
      // left hanging.
      await safeDrain(res);
      throw new SpotifyAuthError(res.status);
    }
    if (!res.ok) {
      await safeDrain(res);
      throw new SpotifyHttpError(res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SpotifyHttpError(res.status);
    }
    const parsed = parseTokenResponse(json);
    if (parsed.refreshToken && parsed.refreshToken !== currentRefreshToken) {
      currentRefreshToken = parsed.refreshToken;
      // Log the *fact* of rotation only — never the value.
      opts.log('refresh_token rotated by Spotify (held in memory only)');
    }
    const cachedToken: CachedToken = {
      accessToken: parsed.accessToken,
      expiresAt: Date.now() + parsed.expiresIn * 1000,
    };
    cached = cachedToken;
    return cachedToken;
  }

  async function getAccessToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt - refreshSkewMs) {
      return cached.accessToken;
    }
    const fresh = await refreshAccessToken();
    return fresh.accessToken;
  }

  async function getCurrentlyPlayingOnce(): Promise<CurrentlyPlaying | null> {
    const accessToken = await getAccessToken();
    const res = await fetchWithTimeout(CURRENTLY_PLAYING_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 204) return null;
    if (res.status === 401) {
      await safeDrain(res);
      throw new SpotifyAuthError(401);
    }
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      await safeDrain(res);
      throw new SpotifyRateLimitError(retryAfter);
    }
    if (!res.ok) {
      await safeDrain(res);
      throw new SpotifyHttpError(res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // 200 with a malformed body — treat as transient HTTP weirdness.
      throw new SpotifyHttpError(res.status);
    }
    return projectCurrentlyPlaying(json);
  }

  async function getCurrentlyPlaying(): Promise<CurrentlyPlaying | null> {
    try {
      return await getCurrentlyPlayingOnce();
    } catch (err) {
      // 401 one-shot recovery: the cached access token might be stale
      // even though we thought it was fresh (clock skew, server-side
      // revocation). Force-mint and retry exactly once. If the retry
      // also 401s, the refresh token itself is dead.
      if (err instanceof SpotifyAuthError && err.status === 401) {
        cached = null;
        return await getCurrentlyPlayingOnce();
      }
      throw err;
    }
  }

  /**
   * Force a refresh-token round-trip to confirm the credential still works.
   * Cheap (no Spotify-API call beyond `oauth/token`) and side-effect-free
   * apart from updating the cached access token. Used by `!radio on` so a
   * dead token surfaces privately to the operator instead of as a 50s-late
   * "Too many errors" channel announce.
   */
  async function verifyToken(): Promise<void> {
    cached = null; // Force a fresh refresh — don't trust an old cache.
    await refreshAccessToken();
  }

  return { getCurrentlyPlaying, verifyToken };
}

// ---------------------------------------------------------------------------
// Pure helpers (covered by spotify-client.test.ts)
// ---------------------------------------------------------------------------

interface ParsedTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

/**
 * Narrow an unknown value to a JSON-object record, returning null if the
 * value isn't a non-null object. Centralises the
 * `typeof === 'object' && !== null` check so callers don't repeat it
 * inline with a follow-up `as Record<string, unknown>` cast.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

/**
 * Read a string field from a record, returning the value when present
 * and non-empty, or null otherwise. Lets `projectCurrentlyPlaying`
 * read Spotify's response without per-field `typeof === 'string'`
 * boilerplate and without `as string` casts.
 */
function getStringField(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Read a numeric field from a record, returning the value when present
 * or `fallback` otherwise.
 */
function getNumberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const v = record[key];
  return typeof v === 'number' ? v : fallback;
}

function parseTokenResponse(body: unknown): ParsedTokenResponse {
  const r = asRecord(body);
  if (!r) throw new SpotifyHttpError(200);
  const access = getStringField(r, 'access_token');
  if (!access) throw new SpotifyHttpError(200);
  if (typeof r.expires_in !== 'number') throw new SpotifyHttpError(200);
  return {
    accessToken: access,
    refreshToken: getStringField(r, 'refresh_token'),
    expiresIn: r.expires_in,
  };
}

/**
 * Project the `/v1/me/player/currently-playing` response shape into our
 * narrow `CurrentlyPlaying`. Returns null for podcast episodes / ads
 * (we only announce tracks). Returns null for unrecognised shapes too,
 * to keep the poll loop simple — the tick-handler treats null as
 * "nothing to announce", which is the right behavior either way.
 */
function projectCurrentlyPlaying(body: unknown): CurrentlyPlaying | null {
  const root = asRecord(body);
  if (!root) return null;
  const item = asRecord(root.item);
  if (!item || item.type !== 'track') return null;

  const id = getStringField(item, 'id');
  const title = getStringField(item, 'name');
  if (!id || !title) return null;

  const artistList = Array.isArray(item.artists) ? item.artists : [];
  const artist = artistList
    .map((a) => {
      const r = asRecord(a);
      return r ? (getStringField(r, 'name') ?? '') : '';
    })
    .filter((s) => s !== '')
    .join(', ');

  const album = readNamedField(item, 'album');
  const externalUrl = readNamedField(item, 'external_urls', 'spotify');
  const url = externalUrl ?? `https://open.spotify.com/track/${id}`;

  return {
    trackId: id,
    title,
    artist,
    album: album ?? '',
    url,
    progressMs: getNumberField(root, 'progress_ms', 0),
    durationMs: getNumberField(item, 'duration_ms', 0),
    isPlaying: root.is_playing === true,
  };
}

/**
 * Read a string-typed sub-field from a nested object — e.g.
 * `it.album.name` or `it.external_urls.spotify`. Returns null if any
 * step in the chain isn't a record / string.
 */
function readNamedField(
  record: Record<string, unknown>,
  key: string,
  inner: string = 'name',
): string | null {
  const sub = asRecord(record[key]);
  if (!sub) return null;
  return getStringField(sub, inner);
}

/**
 * Spotify's `Retry-After` is documented as seconds. Be defensive: any
 * non-numeric or absurd value clamps into a sane range. The poll-loop
 * also clamps, but defending here means the rest of the code can
 * trust the value without re-validation.
 */
function parseRetryAfter(header: string | null): number {
  if (header === null) return 5;
  const n = Number.parseInt(header, 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(n, 300);
}

/**
 * Drain a response body without holding it in memory. Some HTTP/2 stacks
 * leave the connection in a bad state if the body is never read.
 * Errors are swallowed deliberately — we don't care about a failed drain.
 */
async function safeDrain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // intentional
  }
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  // Trim to the first line and strip control bytes; never echo a stack.
  const firstLine = err.message.split(/\r?\n/, 1)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  return firstLine.replace(/[\x00-\x1F\x7F]/g, '');
}
