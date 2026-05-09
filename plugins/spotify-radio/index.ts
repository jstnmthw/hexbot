// spotify-radio — Now-playing announcer for Spotify Jam sessions.
//
// The operator starts a Jam in their own Spotify client, runs
// `!radio on <jam-url>` in a channel, and the bot polls
// `/v1/me/player/currently-playing` against the operator's account and
// announces each track transition. See README.md and the plan in
// docs/plans/spotify-radio.md for the full design.
//
// Architecture note: state (`cfg`, `spotify`, `session`) lives in a
// closure created by `createSpotifyRadio()`. The plugin loader sees a
// singleton instance through the module-level `init` / `teardown`
// exports; tests create fresh instances per test for isolation. See
// `DESIGN.md` §Plugin test seams.
import type { ChannelHandlerContext, PluginAPI } from '../../src/types';
import {
  type CurrentlyPlaying,
  SpotifyAuthError,
  type SpotifyClient,
  SpotifyHttpError,
  SpotifyNetworkError,
  SpotifyRateLimitError,
  createSpotifyClient,
} from './spotify-client';
import { validateJamUrl } from './url-validator';

export const name = 'spotify-radio';
export const version = '0.1.0';
export const description = 'Announces tracks from a Spotify Jam session to a channel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fully-resolved plugin config. Mirrors the keys of
 * `plugins/spotify-radio/config.json` after the plugin loader has
 * resolved `<field>_env` indirections from `process.env` — secrets are
 * never read directly from `process.env` here.
 */
export interface PluginConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  pollIntervalSec: number;
  sessionTtlHours: number;
  announcePrefix: string;
  allowedLinkHosts: string[];
  maxConsecutiveErrors: number;
}

/**
 * In-memory session model. One per bot — see open question #1 in the
 * plan. Lifetime is bounded by `ttlMs` and by the `maxConsecutiveErrors`
 * circuit breaker. State dies on plugin reload, on bot restart, on
 * `!radio off`, and when either of the two limits trips.
 */
export interface RadioSession {
  channel: string;
  jamUrl: string;
  startedAt: number;
  ttlMs: number;
  /** Last announced trackId, or null until the first poll has fired. */
  lastTrackId: string | null;
  /** Reset to 0 on any successful poll. */
  consecutiveErrors: number;
  /** Wall-clock ms of the most recent poll attempt (success or failure). */
  lastPollAt: number;
}

export type SessionEndReason = 'manual' | 'ttl' | 'error';

/**
 * Test-only seam exposed by each `createSpotifyRadio()` instance under
 * the `INTERNALS` symbol. Reaching it requires explicitly importing
 * `INTERNALS` from this module — there is no string-keyed accessor and
 * no global `Symbol.for` registration, so production code (and other
 * plugins) cannot stumble onto it. The plugin loader only touches the
 * module-level `init` / `teardown` re-exports of the default singleton.
 */
export interface RadioInternals {
  getState(): {
    cfg: PluginConfig | null;
    spotify: SpotifyClient | null;
    session: RadioSession | null;
  };
  setSpotifyClient(client: SpotifyClient | null): void;
}

/**
 * Symbol used to key the test-only `RadioInternals` accessor on every
 * `SpotifyRadio` instance. A fresh `Symbol(...)` (not `Symbol.for(...)`)
 * means the only way to obtain the symbol is to import it from this
 * module — it cannot be reached via a global registry.
 */
export const INTERNALS: unique symbol = Symbol('spotify-radio:internals');

export interface SpotifyRadio {
  init(api: PluginAPI): Promise<void>;
  teardown(): void;
  [INTERNALS]: RadioInternals;
}

// The dispatcher's timer floor is 10s (DESIGN.md §2.3), so the plan
// clamps any operator-configured value below 10 up to 10. The clamped
// value is what the per-target due-time gate compares against.
const TIMER_FLOOR_SEC = 10;
const SECONDS_TO_MS = 1000;
const HOURS_TO_MS = 3600 * 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh spotify-radio instance. Each call allocates its own
 * closure-scoped state — no two instances share `cfg`, `spotify`, or
 * `session`. The plugin loader uses one default instance (see the
 * `init` / `teardown` re-exports below); tests create their own per
 * test for isolation.
 */
export function createSpotifyRadio(): SpotifyRadio {
  let cfg: PluginConfig | null = null;
  let spotify: SpotifyClient | null = null;
  let session: RadioSession | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function init(api: PluginAPI): Promise<void> {
    // Defensive: if a prior load left a session in this closure (a
    // teardown that raced with an in-flight `!radio on`, or a singleton
    // re-init without a fresh module evaluation), clear it before
    // wiring fresh config so `_internals.getState().session` cannot lie.
    session = null;
    cfg = loadConfig(api);
    spotify = createSpotifyClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      log: api.log,
      error: api.error,
    });

    registerCommands(api);
    registerHelp(api);
    registerPollLoop(api);

    api.log('Loaded — session inactive (run !radio on <jam-url> to start)');
  }

  function teardown(): void {
    cfg = null;
    spotify = null;
    session = null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  function registerCommands(api: PluginAPI): void {
    api.bind('pub', '-', '!radio', async (ctx) => {
      await routeRadio(api, ctx);
    });
    api.bind('pub', '-', '!listen', async (ctx) => {
      await handleStatus(api, ctx, true);
    });
  }

  function registerHelp(api: PluginAPI): void {
    api.registerHelp([
      {
        command: '!radio',
        flags: '-',
        usage: '!radio [on <jam-url> | off]',
        description: 'Show or control the Spotify radio session',
        detail: [
          '!radio — show current session status (notice to you)',
          '!radio on <jam-url> — start a session and rebroadcast the Jam link (n)',
          '!radio off — stop the current session (n)',
        ],
        category: 'spotify-radio',
      },
      {
        command: '!listen',
        flags: '-',
        usage: '!listen',
        description: 'Show the current Spotify radio status to the channel',
        category: 'spotify-radio',
      },
    ]);
  }

  async function routeRadio(api: PluginAPI, ctx: ChannelHandlerContext): Promise<void> {
    const args = ctx.args.trim();
    if (args === '') {
      await handleStatus(api, ctx, false);
      return;
    }
    const space = args.indexOf(' ');
    const sub = (space === -1 ? args : args.slice(0, space)).toLowerCase();
    const rest = space === -1 ? '' : args.slice(space + 1).trim();

    if (sub === 'on') {
      await handleOn(api, ctx, rest);
      return;
    }
    if (sub === 'off') {
      await handleOff(api, ctx);
      return;
    }
    api.notice(ctx.nick, 'Usage: !radio [on <jam-url> | off]');
  }

  async function handleStatus(
    api: PluginAPI,
    ctx: ChannelHandlerContext,
    publicVisibility: boolean,
  ): Promise<void> {
    const c = cfg;
    if (!c) return;
    const send = (msg: string): void => {
      if (publicVisibility) api.say(ctx.channel, msg);
      else api.notice(ctx.nick, msg);
    };

    if (!session) {
      send(`${c.announcePrefix} Radio is off.`);
      return;
    }
    const ageMin = Math.floor((Date.now() - session.startedAt) / 60_000);
    send(
      `${c.announcePrefix} Radio on for ${ageMin}m — join: ${session.jamUrl}` +
        (session.lastTrackId ? '' : ' — waiting for the first track to start playing'),
    );
  }

  async function handleOn(api: PluginAPI, ctx: ChannelHandlerContext, rest: string): Promise<void> {
    const c = cfg;
    if (!c) return;

    const safeNick = api.stripFormatting(ctx.nick);
    logCmd(api, ctx, 'on', 'attempt');

    if (!(await requireAuth(api, ctx, 'on'))) return;

    if (rest === '') {
      api.notice(ctx.nick, 'Usage: !radio on <jam-url>');
      logCmd(api, ctx, 'on', 'rejected', 'missing url');
      return;
    }

    if (session) {
      api.notice(ctx.nick, `Radio is already on in ${session.channel}. Run !radio off first.`);
      logCmd(api, ctx, 'on', 'rejected', 'already running');
      return;
    }

    const validated = validateJamUrl(rest, c.allowedLinkHosts);
    if (!validated) {
      api.notice(
        ctx.nick,
        'That URL is not a recognised Spotify Jam share link. Spotify\'s "Copy link" gives a spotify.link short URL that the bot cannot validate — open it in a browser, cancel the "Open in Spotify" prompt, then copy the https://open.spotify.com/socialsession/<id> URL from the address bar and paste that.',
      );
      logCmd(api, ctx, 'on', 'rejected', 'invalid url');
      return;
    }

    session = {
      channel: ctx.channel,
      jamUrl: validated,
      startedAt: Date.now(),
      ttlMs: c.sessionTtlHours * HOURS_TO_MS,
      lastTrackId: null,
      consecutiveErrors: 0,
      lastPollAt: 0,
    };

    api.audit.log('radio-on', {
      channel: ctx.channel,
      outcome: 'success',
      reason: `started by ${ctx.nick}`,
      metadata: {
        nick: ctx.nick,
        hostmask: api.buildHostmask(ctx),
        jam_url: validated,
        ttl_hours: c.sessionTtlHours,
      },
    });

    api.say(ctx.channel, `${c.announcePrefix} Radio is on — join the Jam: ${validated}`);
    api.log(`Session started in ${ctx.channel} by ${safeNick}`);
  }

  async function handleOff(api: PluginAPI, ctx: ChannelHandlerContext): Promise<void> {
    const c = cfg;
    if (!c) return;
    logCmd(api, ctx, 'off', 'attempt');
    if (!(await requireAuth(api, ctx, 'off'))) return;
    if (!session) {
      api.notice(ctx.nick, 'Radio is not on.');
      logCmd(api, ctx, 'off', 'rejected', 'no active session');
      return;
    }
    const safeNick = api.stripFormatting(ctx.nick);
    const closingChannel = session.channel;
    api.audit.log('radio-off', {
      channel: closingChannel,
      outcome: 'success',
      reason: `stopped by ${ctx.nick}`,
      metadata: {
        nick: ctx.nick,
        hostmask: api.buildHostmask(ctx),
        end_reason: 'manual',
      },
    });
    endSession(api, 'manual');
    api.log(`Session ended by ${safeNick} (manual)`);
  }

  /**
   * Tear down the active session and announce the closure. Shared by the
   * manual `!radio off` path, the TTL-expiry branch in the poll loop, and
   * the error-budget tripwire in the poll loop.
   */
  function endSession(api: PluginAPI, reason: SessionEndReason): void {
    const c = cfg;
    if (!c) return;
    const closingChannel = session?.channel;
    session = null;
    if (!closingChannel) return;
    let line: string;
    switch (reason) {
      case 'manual':
        line = `${c.announcePrefix} Session ended.`;
        break;
      case 'ttl':
        line = `${c.announcePrefix} Session TTL reached. Radio off.`;
        break;
      case 'error':
        line = `${c.announcePrefix} Too many errors talking to Spotify. Radio off.`;
        break;
    }
    // Bot-driven closures (TTL expiry, error-budget tripwire) emit
    // their own audit row here. The manual path's audit row is emitted
    // by handleOff before calling us, so it can carry the triggering
    // user's nick/hostmask in the metadata.
    if (reason !== 'manual') {
      api.audit.log('radio-off', {
        channel: closingChannel,
        outcome: 'success',
        reason: reason === 'ttl' ? 'session ttl reached' : 'consecutive-error budget exceeded',
        metadata: { end_reason: reason },
      });
    }
    api.say(closingChannel, line);
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  function registerPollLoop(api: PluginAPI): void {
    // The dispatcher's timer floor is 10s; configuring `poll_interval_sec`
    // below 10 still ticks every 10s but the per-target due-time gate
    // collapses configured-vs-actual to whichever is greater.
    api.bind('time', '-', String(TIMER_FLOOR_SEC), async () => {
      await tickPollLoop(api);
    });
  }

  async function tickPollLoop(api: PluginAPI): Promise<void> {
    const c = cfg;
    const s = session;
    const sp = spotify;
    if (!c || !s || !sp) return;

    const now = Date.now();

    if (now - s.startedAt >= s.ttlMs) {
      endSession(api, 'ttl');
      return;
    }

    const intervalMs = Math.max(c.pollIntervalSec, TIMER_FLOOR_SEC) * SECONDS_TO_MS;
    if (now - s.lastPollAt < intervalMs) return;
    s.lastPollAt = now;

    try {
      const current = await sp.getCurrentlyPlaying();
      s.consecutiveErrors = 0;
      if (current === null) return;
      if (current.trackId !== s.lastTrackId) {
        s.lastTrackId = current.trackId;
        announceTrack(api, s, current);
      }
    } catch (err) {
      handlePollError(api, s, c, now, err);
    }
  }

  function handlePollError(
    api: PluginAPI,
    s: RadioSession,
    c: PluginConfig,
    now: number,
    err: unknown,
  ): void {
    if (err instanceof SpotifyAuthError) {
      api.error('Spotify auth failed — refresh token likely revoked. Session ended.');
      endSession(api, 'error');
      return;
    }
    if (err instanceof SpotifyRateLimitError) {
      s.lastPollAt = now + err.retryAfterSec * SECONDS_TO_MS;
      s.consecutiveErrors += 1;
      api.warn(`Rate-limited by Spotify; backing off ${err.retryAfterSec}s`);
      if (s.consecutiveErrors >= c.maxConsecutiveErrors) endSession(api, 'error');
      return;
    }
    if (err instanceof SpotifyNetworkError || err instanceof SpotifyHttpError) {
      s.consecutiveErrors += 1;
      const status = err instanceof SpotifyHttpError ? `HTTP ${err.status}` : 'network';
      api.warn(`Poll failed (${status}); ${s.consecutiveErrors}/${c.maxConsecutiveErrors} errors`);
      if (s.consecutiveErrors >= c.maxConsecutiveErrors) endSession(api, 'error');
      return;
    }
    // Catch-all for unexpected throws (formatter bug, projection edge case,
    // etc.). Treat as a soft error so a single unexpected exception doesn't
    // wedge the session forever, but still escalate at threshold.
    s.consecutiveErrors += 1;
    api.error('Unexpected tick error', err instanceof Error ? err.message : String(err));
    if (s.consecutiveErrors >= c.maxConsecutiveErrors) endSession(api, 'error');
  }

  function announceTrack(api: PluginAPI, s: RadioSession, current: CurrentlyPlaying): void {
    const c = cfg;
    if (!c) return;
    // Cap before splicing — a 200-char title plus an 80-char artist plus
    // boilerplate stays well within IRC's 512-byte budget after the
    // network prepends `:nick!ident@host`. The slice happens AFTER
    // stripFormatting so caps count visible characters, not control bytes.
    const title = api.stripFormatting(current.title).slice(0, 120);
    const artist = api.stripFormatting(current.artist).slice(0, 80);
    const line = `${c.announcePrefix} Now playing: ${title} — ${artist} • ${current.url}`;
    api.say(s.channel, line);
  }

  return {
    init,
    teardown,
    [INTERNALS]: {
      getState: () => ({ cfg, spotify, session }),
      setSpotifyClient: (client) => {
        spotify = client;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Stateless helpers (no closure access)
// ---------------------------------------------------------------------------

/**
 * Two-gate authorisation used by every mutating !radio subcommand.
 * Stage 1: hostmask flag check (always required).
 * Stage 2: NickServ ACC verification (only when services are
 * available — networks without services rely on stage 1 alone).
 *
 * Returns true on accept; on reject, sends a notice and logs a
 * `rejected` audit line.
 */
async function requireAuth(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  sub: string,
): Promise<boolean> {
  if (!api.permissions.checkFlags('n', ctx)) {
    api.notice(ctx.nick, 'You do not have permission to use this command.');
    logCmd(api, ctx, sub, 'rejected', 'flag check failed');
    return false;
  }
  if (api.services.isAvailable()) {
    const result = await api.services.verifyUser(ctx.nick);
    if (!result.verified) {
      api.notice(ctx.nick, 'NickServ verification required for this command.');
      logCmd(api, ctx, sub, 'rejected', 'nickserv verification failed');
      return false;
    }
  }
  return true;
}

/**
 * Structured audit-log line. Every interpolated user-controlled string
 * runs through `stripFormatting` first — a nick containing IRC colour
 * codes or ANSI escapes is otherwise a log-injection vector
 * (SECURITY.md §5.3).
 */
function logCmd(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  sub: string,
  outcome: 'attempt' | 'rejected',
  reason?: string,
): void {
  const who = api.stripFormatting(api.buildHostmask(ctx));
  const safeChannel = api.stripFormatting(ctx.channel);
  const tail = reason ? ` (${reason})` : '';
  if (outcome === 'attempt') {
    api.debug(`!radio ${sub} attempted by ${who} in ${safeChannel}`);
  } else {
    api.debug(`!radio ${sub} rejected for ${who} in ${safeChannel}${tail}`);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read and validate the merged `config.json` + `plugins.json` blob the
 * plugin loader handed us. Throws a precise, env-var-named error on any
 * missing secret so an operator with an empty `bot.env` sees exactly
 * which variable to set and which command to run to obtain it.
 *
 * Secret values are NEVER interpolated into thrown errors or log lines
 * — only the env-var name is. A `loadConfig`-time validation failure
 * for a "present but malformed" secret (e.g. surrounding whitespace)
 * still names the env var, never the value.
 */
export function loadConfig(api: PluginAPI): PluginConfig {
  const raw = api.settings.bootConfig;

  const clientId = readSecret(raw, 'client_id', 'HEX_SPOTIFY_CLIENT_ID');
  const clientSecret = readSecret(raw, 'client_secret', 'HEX_SPOTIFY_CLIENT_SECRET');
  const refreshToken = readSecret(raw, 'refresh_token', 'HEX_SPOTIFY_REFRESH_TOKEN');

  const pollIntervalSec = readInt(raw, 'poll_interval_sec', 10, 1, 3600);
  const sessionTtlHours = readInt(raw, 'session_ttl_hours', 6, 1, 168);
  const announcePrefix = readString(raw, 'announce_prefix', '[radio]');
  const allowedLinkHosts = readHostList(raw, 'allowed_link_hosts', ['open.spotify.com']);
  const maxConsecutiveErrors = readInt(raw, 'max_consecutive_errors', 5, 1, 100);

  if (pollIntervalSec < TIMER_FLOOR_SEC) {
    api.warn(
      `poll_interval_sec=${pollIntervalSec} is below the dispatcher's 10s timer floor; clamping to 10`,
    );
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    pollIntervalSec,
    sessionTtlHours,
    announcePrefix,
    allowedLinkHosts,
    maxConsecutiveErrors,
  };
}

function readSecret(raw: Readonly<Record<string, unknown>>, key: string, envVar: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${envVar} not set — run 'pnpm run spotify:auth' on your workstation and paste the result into config/bot.env`,
    );
  }
  if (value !== value.trim()) {
    throw new Error(
      `${envVar} contains leading/trailing whitespace — strip it from config/bot.env`,
    );
  }
  return value;
}

function readInt(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`spotify-radio config: ${key} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function readString(raw: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`spotify-radio config: ${key} must be a string`);
  }
  return value;
}

function readHostList(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string[],
): string[] {
  const value = raw[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    throw new Error(`spotify-radio config: ${key} must be an array of non-empty strings`);
  }
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';
  if (!value.every(isNonEmptyString)) {
    throw new Error(`spotify-radio config: ${key} must be an array of non-empty strings`);
  }
  return value.map((v) => v.toLowerCase());
}

// ---------------------------------------------------------------------------
// Default singleton — wired to the plugin loader's `init` / `teardown`.
// Tests construct their own instances via `createSpotifyRadio()` to get
// closure-isolated state per test.
// ---------------------------------------------------------------------------

const _defaultInstance = createSpotifyRadio();
export const init = _defaultInstance.init;
export const teardown = _defaultInstance.teardown;
