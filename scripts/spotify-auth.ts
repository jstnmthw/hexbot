// scripts/spotify-auth.ts — Workstation-side helper to obtain a Spotify
// refresh token for the spotify-radio plugin.
//
// Usage:
//   HEX_SPOTIFY_CLIENT_ID=... HEX_SPOTIFY_CLIENT_SECRET=... pnpm run spotify:auth
//
// Headless fallback (when you can't open a browser on the host running
// this script — e.g. SSH'd into a workstation, ran the authorize flow on
// your phone, and just need to swap the code for tokens):
//
//   HEX_SPOTIFY_CLIENT_ID=... HEX_SPOTIFY_CLIENT_SECRET=... \
//     pnpm run spotify:auth -- --code <auth-code>
//
// This is a dev tool, not a plugin — direct process.env access is
// acceptable here. The refresh token is printed to stdout once at the
// end of a successful run; nothing else (no debug logs, no error stacks)
// references it. Paste the value into config/bot.env on the bot host.
//
// Plain authorization-code flow with a confidential client (client_secret
// is in env). PKCE was considered and dropped — it targets public clients
// (mobile/SPA) that can't keep a secret, and adding it here would force
// the --code headless mode to persist code_verifier between two separate
// invocations for no security benefit.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Spotify endpoints and required configuration.
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-read-currently-playing user-read-playback-state';
const LISTENER_HOST = '127.0.0.1';
const LISTENER_PORT = 8888;
const LISTENER_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (covered by tests/plugins/spotify-radio/auth-script.test.ts)
// ---------------------------------------------------------------------------

export interface AuthorizeUrlOpts {
  clientId: string;
  state: string;
}

/**
 * Build the Spotify authorize URL. Pure — no network, no env reads.
 * Tests cover that every required query parameter is present and that
 * the constants (redirect URI, scope, response type) match Spotify's
 * documented contract.
 */
export function buildAuthorizeUrl(opts: AuthorizeUrlOpts): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', opts.state);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Validate and project the JSON body of a successful token-exchange
 * response. Throws on missing or wrong-typed fields. Error messages name
 * which field is missing but never echo the response body — Spotify
 * error responses can include the client secret or auth code reflected
 * back in the body, so the body is not safe to put in a thrown error or
 * a log line.
 */
export function parseTokenResponse(body: unknown): TokenResponse {
  const r = asRecord(body);
  if (!r) throw new Error('token response was not a JSON object');
  if (typeof r.access_token !== 'string' || r.access_token === '') {
    throw new Error('token response missing access_token');
  }
  if (typeof r.refresh_token !== 'string' || r.refresh_token === '') {
    throw new Error('token response missing refresh_token');
  }
  if (typeof r.expires_in !== 'number') {
    throw new Error('token response missing expires_in');
  }
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresIn: r.expires_in,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

/** Defensive screen for `\r`, `\n`, `\0` in any value we splice into a request. */
export function isControlSafe(s: string): boolean {
  return !/[\r\n\0]/.test(s);
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for an access + refresh token pair.
 *
 * Errors are sanitised: only the HTTP status survives. The raw response
 * body can echo credentials in some Spotify error shapes, and the request
 * body contains the auth code itself — neither belongs in any logged or
 * thrown error.
 */
async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: params.toString(),
    });
  } catch {
    throw new Error('token exchange failed: network error');
  }
  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('token exchange returned non-JSON response');
  }
  return parseTokenResponse(json);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function readEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v === '') {
    console.error(`[spotify-auth] ${name} is not set in the environment.`);
    process.exit(1);
  }
  return v;
}

function printRefreshTokenBanner(refreshToken: string): void {
  console.log('');
  console.log('───────────────────────────────────────────────────────────────────');
  console.log('  Spotify refresh token obtained.');
  console.log('  Paste this value into config/bot.env on the bot host:');
  console.log('');
  console.log(`    HEX_SPOTIFY_REFRESH_TOKEN=${refreshToken}`);
  console.log('');
  console.log('  Treat this token like a password — never check it into git.');
  console.log('───────────────────────────────────────────────────────────────────');
}

async function runHeadless(code: string): Promise<void> {
  if (!isControlSafe(code)) {
    throw new Error('--code value contains control characters');
  }
  const clientId = readEnv('HEX_SPOTIFY_CLIENT_ID');
  const clientSecret = readEnv('HEX_SPOTIFY_CLIENT_SECRET');
  const tokens = await exchangeCode(code, clientId, clientSecret);
  printRefreshTokenBanner(tokens.refreshToken);
}

function runListener(): Promise<void> {
  const clientId = readEnv('HEX_SPOTIFY_CLIENT_ID');
  const clientSecret = readEnv('HEX_SPOTIFY_CLIENT_SECRET');
  const expectedState = randomBytes(16).toString('hex');

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // `finish` captures `server` and `timeoutHandle` via closure; both
    // are bound below before any handler that calls `finish()` actually
    // fires (the request handler runs on inbound HTTP, the timeout fires
    // after LISTENER_TIMEOUT_MS).
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      server.close();
      action();
    };

    const server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('bad request');
        return;
      }
      const reqUrl = new URL(req.url, REDIRECT_URI);
      if (reqUrl.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const error = reqUrl.searchParams.get('error');
      if (error) {
        const safe = error.replace(/[^\w-]/g, '');
        res.statusCode = 400;
        res.end(`Spotify returned error: ${safe}`);
        finish(() => reject(new Error(`Spotify authorize error: ${safe}`)));
        return;
      }
      const state = reqUrl.searchParams.get('state');
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end('state mismatch');
        finish(() => reject(new Error('state mismatch on callback')));
        return;
      }
      const code = reqUrl.searchParams.get('code');
      if (!code || !isControlSafe(code)) {
        res.statusCode = 400;
        res.end('missing or invalid code');
        finish(() => reject(new Error('missing or invalid code on callback')));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Spotify authorisation complete. You can close this tab.');
      finish(() => {
        exchangeCode(code, clientId, clientSecret)
          .then((tokens) => {
            printRefreshTokenBanner(tokens.refreshToken);
            resolve();
          })
          .catch(reject);
      });
    });

    // Bind explicitly to 127.0.0.1. Node's default listen(port) binds to
    // `::` on dual-stack systems, which would expose this callback to
    // the local network during the auth flow.
    server.listen(LISTENER_PORT, LISTENER_HOST, () => {
      const authUrl = buildAuthorizeUrl({ clientId, state: expectedState });
      console.log('');
      console.log('[spotify-auth] Open this URL in your browser to authorise hexbot:');
      console.log('');
      console.log(`  ${authUrl}`);
      console.log('');
      console.log(
        `[spotify-auth] Waiting for callback on http://${LISTENER_HOST}:${LISTENER_PORT} ...`,
      );
    });

    const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
      finish(() =>
        reject(new Error(`timed out waiting for callback after ${LISTENER_TIMEOUT_MS / 1000}s`)),
      );
    }, LISTENER_TIMEOUT_MS);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const codeIdx = argv.indexOf('--code');
  if (codeIdx >= 0) {
    const code = argv[codeIdx + 1];
    if (!code) {
      console.error('[spotify-auth] --code requires a value');
      process.exit(1);
    }
    await runHeadless(code);
    return;
  }
  await runListener();
}

// Last-line-of-defence: any uncaught error must not surface a stack
// trace that could include the authorization code or the client secret.
// A sanitised one-liner + non-zero exit code is enough.
process.on('uncaughtException', (err) => {
  console.error(`[spotify-auth] fatal: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});

// Only run main when invoked as a script. Tests `import { ... }` the pure
// helpers and must not trigger the listener body.
const entry = process.argv[1];
const isMain = entry !== undefined && fileURLToPath(import.meta.url) === entry;
if (isMain) {
  main().catch((err) => {
    console.error(`[spotify-auth] ${err instanceof Error ? err.message : 'failed'}`);
    process.exit(1);
  });
}
