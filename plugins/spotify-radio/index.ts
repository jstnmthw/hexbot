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
  /**
   * Nick that ran `!radio on`. Surfaced as "Current DJ" in the `!radio`
   * status line; stored raw and stripped at display time, mirroring how
   * track artist/title are handled in `announceTrack`.
   */
  startedBy: string;
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
  /**
   * Plugin-lifecycle abort controller. Forwarded into the SpotifyClient so
   * teardown cancels in-flight fetches instead of letting them run to the
   * 10s internal timeout while pinning the closure (which retains the
   * refresh token in memory). Mirrors the pattern in `plugins/rss/index.ts`.
   */
  let teardownController: AbortController | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function init(api: PluginAPI): Promise<void> {
    // Defensive: if a prior load left a session in this closure (a
    // teardown that raced with an in-flight `!radio on`, or a singleton
    // re-init without a fresh module evaluation), clear it before
    // wiring fresh config so `_internals.getState().session` cannot lie.
    session = null;
    // Register live-tunable settings BEFORE loadConfig — the registry's
    // seed walker fires inside register(), so anything that reads the
    // setting later sees the JSON-seeded value. Defaults here mirror
    // config.json's seed values; sanitisation lives in getPrefix().
    api.settings.register([
      {
        key: 'announce_prefix',
        type: 'string',
        default: '[radio]',
        description:
          'Prefix on every spotify-radio announcement line. Control bytes are stripped and the prefix is capped at 32 characters; an empty string falls back to "[radio]".',
      },
    ]);
    cfg = loadConfig(api);
    teardownController = new AbortController();
    spotify = createSpotifyClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      log: api.log,
      error: api.error,
      abortSignal: teardownController.signal,
    });

    registerCommands(api);
    registerHelp(api);
    registerPollLoop(api);
  }

  function teardown(): void {
    // Abort first so any in-flight Spotify fetch unwinds with a clear
    // teardown reason instead of running to the 10s internal timeout
    // and pinning the SpotifyClient closure (which holds the refresh
    // token) past plugin unload.
    teardownController?.abort(new Error('spotify-radio plugin torn down'));
    teardownController = null;
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
    // Help registry takes `flags: '-'` (everyone can see help) but the
    // per-line `(n)` annotations remind users that the actual mutating
    // subcommands gate on the +n flag inside requireAuth(). Keeping this
    // visible in help avoids a "why was I rejected" round-trip.
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
          'Tip: change the [radio] tag with .set spotify-radio announce_prefix <value> (n)',
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
    if (!cfg) return;
    const send = (msg: string): void => {
      if (publicVisibility) api.say(ctx.channel, msg);
      else api.notice(ctx.nick, msg);
    };

    const prefix = getPrefix(api);
    if (!session) {
      send(`${prefix} Radio is off.`);
      return;
    }
    const ageMin = Math.floor((Date.now() - session.startedAt) / 60_000);
    const dj = api.stripFormatting(session.startedBy);
    send(`${prefix} Current DJ: ${dj} • LIVE: ${ageMin}m • Tune In: ${session.jamUrl}`);
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
        'That URL is not a recognised Spotify share link. Use Spotify\'s "Copy link" share button (gives a spotify.link/<token> URL) or the https://open.spotify.com/socialsession/<id> URL from your browser\'s address bar.',
      );
      logCmd(api, ctx, 'on', 'rejected', 'invalid url');
      return;
    }

    // Pre-flight the Spotify token before announcing in-channel. Without this,
    // an expired refresh-token / revoked credential / network outage produces
    // an asymmetric flow: "Radio is on" lands immediately, then the poll loop
    // fails 5 times and 50s later announces "Too many errors. Radio off." to
    // the same channel. Failing to the invoker privately keeps the channel
    // clean. Uses `verifyToken()` rather than `getCurrentlyPlaying()` so the
    // pre-flight only exercises the oauth path — it doesn't consume a
    // currently-playing fixture in tests, and it doesn't burn a track-read
    // quota slot in production.
    const sp = spotify;
    if (sp) {
      try {
        await sp.verifyToken();
      } catch (err) {
        api.notice(
          ctx.nick,
          `Could not reach Spotify (token / network). Not starting the session: ${err instanceof Error ? err.message : String(err)}`,
        );
        logCmd(api, ctx, 'on', 'rejected', 'spotify pre-flight failed');
        return;
      }
    }

    session = {
      channel: ctx.channel,
      jamUrl: validated,
      startedBy: ctx.nick,
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

    api.say(ctx.channel, `${getPrefix(api)} Radio is on — Tune In: ${validated}`);
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
    if (!cfg) return;
    const closingChannel = session?.channel;
    session = null;
    if (!closingChannel) return;
    const prefix = getPrefix(api);
    let line: string;
    switch (reason) {
      case 'manual':
        line = `${prefix} Session ended.`;
        break;
      case 'ttl':
        line = `${prefix} Session TTL reached. Radio off.`;
        break;
      case 'error':
        line = `${prefix} Too many errors talking to Spotify. Radio off.`;
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
    //
    // No explicit unbind in teardown(): the plugin loader drops every
    // plugin-owned bind on unload (`dispatcher.unbindAll(<pluginId>)`),
    // so capturing the bind handle here would be redundant. tickPollLoop
    // additionally early-returns when `cfg`/`session`/`spotify` are null,
    // which teardown() sets — defense in depth if the loader contract
    // were to regress.
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
      // Reset the consecutive-error counter on every successful poll. A
      // single transient blip shouldn't tip a healthy session over the
      // budget on its next failure — the budget tracks *consecutive*
      // failures by design.
      s.consecutiveErrors = 0;
      // null = "nothing playing right now" (paused, between tracks, ad, or
      // a non-track item we project away). Don't announce, don't error;
      // the next tick will pick up whatever resumes.
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
      // Push lastPollAt INTO the future so the per-target due-time gate
      // in tickPollLoop swallows ticks until the Retry-After window
      // elapses. Spotify's client clamps Retry-After to 300s (see
      // parseRetryAfter), so the worst case here is a 5min freeze, not
      // an indefinite stall.
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
    if (!cfg) return;
    // Cap before splicing — a 200-char title plus an 80-char artist plus
    // boilerplate stays well within IRC's 512-byte budget after the
    // network prepends `:nick!ident@host`. The slice happens AFTER
    // stripFormatting so caps count visible characters, not control bytes.
    const title = api.stripFormatting(current.title).slice(0, 120);
    const artist = api.stripFormatting(current.artist).slice(0, 80);
    // Listeners need a join URL on every line, not the per-track URL —
    // the radio's purpose is to direct people into the host's Jam, not
    // out to a track page. `s.jamUrl` is whatever the operator pasted,
    // already validateJamUrl-normalised.
    const line = `${getPrefix(api)} Now playing: ${artist} — ${title} • Tune In: ${s.jamUrl}`;
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

const PREFIX_FALLBACK = '[radio]';
const PREFIX_MAX_LEN = 32;

/**
 * Read the live `announce_prefix` setting and sanitise it for IRC
 * output. Reads happen on every announcement so a `.set spotify-radio
 * announce_prefix <value>` takes effect on the next line without a
 * reload. Empty / control-byte-only / unset values fall back to
 * `[radio]` so a misconfigured prefix can't silently produce a
 * leading-space line or, worse, smuggle CR/LF into `say()`.
 */
function getPrefix(api: PluginAPI): string {
  const raw = api.settings.getString('announce_prefix');
  // eslint-disable-next-line no-control-regex
  const cleaned = (raw ?? '').replace(/[\x00-\x1F\x7F]/g, '').slice(0, PREFIX_MAX_LEN);
  return cleaned !== '' ? cleaned : PREFIX_FALLBACK;
}

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
  const allowedLinkHosts = readHostList(raw, 'allowed_link_hosts', [
    'open.spotify.com',
    'spotify.link',
  ]);
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
