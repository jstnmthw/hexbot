import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INTERNALS,
  type SpotifyRadio,
  createSpotifyRadio,
} from '../../../plugins/spotify-radio/index';
import {
  type CurrentlyPlaying,
  SpotifyAuthError,
  type SpotifyClient,
  SpotifyHttpError,
  SpotifyNetworkError,
  SpotifyRateLimitError,
} from '../../../plugins/spotify-radio/spotify-client';
import type { BindHandler, BindType, ChannelHandlerContext, PluginAPI } from '../../../src/types';
import { createMockPluginAPI } from '../../helpers/mock-plugin-api';

interface CapturedBind<T extends BindType = BindType> {
  type: T;
  flags: string;
  mask: string;
  handler: BindHandler<T>;
}

interface Harness {
  api: PluginAPI;
  instance: SpotifyRadio;
  binds: CapturedBind[];
  says: Array<{ target: string; message: string }>;
  notices: Array<{ target: string; message: string }>;
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function harness(maxConsecutiveErrors = 5): Harness {
  const binds: CapturedBind[] = [];
  const says: Array<{ target: string; message: string }> = [];
  const notices: Array<{ target: string; message: string }> = [];
  const log = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();

  const api = createMockPluginAPI({
    bind: vi.fn(((type, flags, mask, handler) => {
      binds.push({ type, flags, mask, handler } as CapturedBind);
    }) as PluginAPI['bind']),
    say: vi.fn((target, message) => {
      says.push({ target, message });
    }),
    notice: vi.fn((target, message) => {
      notices.push({ target, message });
    }),
    log,
    warn,
    error,
    debug,
    permissions: {
      findByHostmask: vi.fn().mockReturnValue(null),
      checkFlags: vi.fn().mockReturnValue(true),
    },
    services: {
      verifyUser: vi.fn().mockResolvedValue({ verified: true, account: 'admin' }),
      isAvailable: vi.fn().mockReturnValue(false),
      isNickServVerificationReply: vi.fn().mockReturnValue(false),
      isBotIdentified: vi.fn().mockReturnValue(false),
    },
    settings: {
      register: vi.fn(),
      get: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      getString: vi.fn().mockReturnValue(''),
      getInt: vi.fn().mockReturnValue(0),
      set: vi.fn(),
      unset: vi.fn(),
      isSet: vi.fn().mockReturnValue(false),
      onChange: vi.fn(),
      offChange: vi.fn(),
      bootConfig: Object.freeze({
        client_id: 'CID',
        client_secret: 'CS',
        refresh_token: 'RT',
        poll_interval_sec: 10,
        session_ttl_hours: 6,
        announce_prefix: '[radio]',
        allowed_link_hosts: ['open.spotify.com'],
        max_consecutive_errors: maxConsecutiveErrors,
      }),
    },
  });
  const instance = createSpotifyRadio();
  return { api, instance, binds, says, notices, log, warn, error, debug };
}

function pubBind(h: Harness, mask: string): BindHandler<'pub'> {
  const b = h.binds.find((x) => x.type === 'pub' && x.mask === mask);
  if (!b) throw new Error(`no pub bind for ${mask}`);
  return b.handler as BindHandler<'pub'>;
}

function tickBind(h: Harness): BindHandler<'time'> {
  const b = h.binds.find((x) => x.type === 'time');
  if (!b) throw new Error('no time bind registered');
  return b.handler as BindHandler<'time'>;
}

function ctx(overrides: Partial<ChannelHandlerContext> = {}): ChannelHandlerContext {
  return {
    nick: 'admin',
    ident: 'admin',
    hostname: 'admin.host',
    text: '',
    command: '!radio',
    args: '',
    channel: '#radio',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  } as ChannelHandlerContext;
}

const VALID = 'https://open.spotify.com/socialsession/abc123';

function track(id: string, title = id, artist = `Artist-${id}`): CurrentlyPlaying {
  return {
    trackId: id,
    title,
    artist,
    album: 'Album',
    url: `https://open.spotify.com/track/${id}`,
    progressMs: 1234,
    durationMs: 60000,
    isPlaying: true,
  };
}

function timeCtx(): Parameters<BindHandler<'time'>>[0] {
  // The dispatcher provides a fully-typed TimeContext but for our tick
  // handler nothing in `ctx` is read — pass a minimal stand-in cast.
  return {} as unknown as Parameters<BindHandler<'time'>>[0];
}

function installScriptedSpotify(responses: Array<CurrentlyPlaying | null | Error>): {
  client: SpotifyClient;
  spy: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const spy = vi.fn(async () => {
    const r = responses[i];
    i += 1;
    if (r instanceof Error) throw r;
    return r ?? null;
  });
  return { client: { getCurrentlyPlaying: spy }, spy };
}

describe('spotify-radio poll loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startSession(h: Harness): Promise<void> {
    await pubBind(h, '!radio')(ctx({ args: `on ${VALID}` }));
  }

  // -------------------------------------------------------------------------
  it('first tick announces whatever is currently playing', async () => {
    const h = harness();
    await h.instance.init(h.api);
    const { client } = installScriptedSpotify([track('A')]);
    h.instance[INTERNALS].setSpotifyClient(client);
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    expect(h.says.some((s) => s.target === '#radio' && s.message.includes('A'))).toBe(true);
    expect(h.instance[INTERNALS].getState().session!.lastTrackId).toBe('A');
  });

  it('announcement format: "<prefix> Now playing: <artist> — <title> • Listen: <jamUrl>"', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([track('XYZ', 'Astatine', 'Mat Zo')]).client,
    );
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    const announce = h.says.find((s) => s.target === '#radio');
    expect(announce).toBeDefined();
    // Artist precedes title (the user-requested order), and the URL on the
    // line is the operator's pasted Jam URL — never the per-track URL.
    expect(announce!.message).toBe(`[radio] Now playing: Mat Zo — Astatine • Listen: ${VALID}`);
    expect(announce!.message).not.toContain('https://open.spotify.com/track/');
  });

  it('announce_prefix is read live from settings on every announcement', async () => {
    const h = harness();
    await h.instance.init(h.api);
    // Operator changes the prefix mid-session via `.set spotify-radio
    // announce_prefix "[FM]"`; the next announcement picks it up
    // without a reload.
    (h.api.settings.getString as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
      key === 'announce_prefix' ? '[FM]' : '',
    );
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([track('A', 'Title', 'Artist')]).client,
    );
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    const announce = h.says.find((s) => s.target === '#radio');
    expect(announce!.message.startsWith('[FM] Now playing:')).toBe(true);
  });

  it('announce_prefix sanitises control bytes and length-caps the value', async () => {
    const h = harness();
    await h.instance.init(h.api);
    // CRLF would smuggle a second IRC line; long values would push the
    // announcement past 512 bytes once title/artist are appended.
    const malicious = `[evil]\r\nQUIT :pwn${'x'.repeat(200)}`;
    (h.api.settings.getString as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
      key === 'announce_prefix' ? malicious : '',
    );
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A')]).client);
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    const announce = h.says.find((s) => s.target === '#radio');
    expect(announce).toBeDefined();
    // No CR/LF/NUL anywhere — defends against IRC line-injection.
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1F]/.test(announce!.message)).toBe(false);
    // Prefix truncated to 32 chars and followed by " Now playing:".
    const expectedPrefix = malicious.replace(/[\r\n]/g, '').slice(0, 32);
    expect(expectedPrefix).toHaveLength(32);
    expect(announce!.message.startsWith(`${expectedPrefix} Now playing:`)).toBe(true);
  });

  it('announce_prefix falls back to "[radio]" on empty string', async () => {
    const h = harness();
    await h.instance.init(h.api);
    (h.api.settings.getString as ReturnType<typeof vi.fn>).mockReturnValue('');
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A')]).client);
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    const announce = h.says.find((s) => s.target === '#radio');
    expect(announce!.message.startsWith('[radio] Now playing:')).toBe(true);
  });

  it('second tick on the same track does not re-announce', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A'), track('A')]).client);
    await startSession(h);
    await tickBind(h)(timeCtx());
    h.says.length = 0;
    // Advance past the per-target due-time gate (10s).
    await vi.advanceTimersByTimeAsync(11_000);
    await tickBind(h)(timeCtx());
    expect(h.says.length).toBe(0);
  });

  it('track change announces and updates lastTrackId', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A'), track('B')]).client);
    await startSession(h);
    await tickBind(h)(timeCtx());
    await vi.advanceTimersByTimeAsync(11_000);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    expect(h.says.some((s) => s.message.includes('B'))).toBe(true);
    expect(h.instance[INTERNALS].getState().session!.lastTrackId).toBe('B');
  });

  it('null response (nothing playing) does not announce and does not advance lastTrackId', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A'), null]).client);
    await startSession(h);
    await tickBind(h)(timeCtx()); // sets lastTrackId = 'A'
    await vi.advanceTimersByTimeAsync(11_000);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    expect(h.says.length).toBe(0);
    expect(h.instance[INTERNALS].getState().session!.lastTrackId).toBe('A');
  });

  it('returning to a previously-played track triggers a fresh announcement', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([track('A'), track('B'), track('A')]).client,
    );
    await startSession(h);
    await tickBind(h)(timeCtx());
    await vi.advanceTimersByTimeAsync(11_000);
    await tickBind(h)(timeCtx());
    await vi.advanceTimersByTimeAsync(11_000);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    expect(h.says.some((s) => s.message.includes('A'))).toBe(true);
  });

  it('SpotifyRateLimitError pushes lastPollAt forward and increments error count', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([new SpotifyRateLimitError(30)]).client,
    );
    await startSession(h);
    const start = Date.now();
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session!.consecutiveErrors).toBe(1);
    expect(h.instance[INTERNALS].getState().session!.lastPollAt).toBeGreaterThanOrEqual(
      start + 30_000,
    );
  });

  it('SpotifyNetworkError × max_consecutive_errors ends session with error reason', async () => {
    const max = 3;
    const h = harness(max);
    await h.instance.init(h.api);
    const errors = Array.from({ length: max }, () => new SpotifyNetworkError('blip'));
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify(errors).client);
    await startSession(h);
    for (let i = 0; i < max; i += 1) {
      await tickBind(h)(timeCtx());
      await vi.advanceTimersByTimeAsync(11_000);
    }
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.says.some((s) => s.message.toLowerCase().includes('too many errors'))).toBe(true);
  });

  it('SpotifyAuthError ends the session immediately', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([new SpotifyAuthError(401)]).client,
    );
    await startSession(h);
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.error).toHaveBeenCalled();
  });

  it('SpotifyHttpError counts toward the error budget', async () => {
    const h = harness(2);
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([new SpotifyHttpError(503), new SpotifyHttpError(503)]).client,
    );
    await startSession(h);
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session!.consecutiveErrors).toBe(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session).toBeNull();
  });

  it('TTL expiry ends the session and announces the TTL reason', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(installScriptedSpotify([track('A')]).client);
    await startSession(h);
    // Advance past the configured 6h TTL.
    await vi.advanceTimersByTimeAsync(6 * 3600_000 + 1_000);
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.says.some((s) => s.message.toLowerCase().includes('session ttl reached'))).toBe(true);
  });

  it('formatter strips IRC formatting from track titles before splicing', async () => {
    const h = harness();
    await h.instance.init(h.api);
    h.instance[INTERNALS].setSpotifyClient(
      installScriptedSpotify([track('X', '\x02bold\x02 \x0304red\x03')]).client,
    );
    // Override stripFormatting to simulate the real strip behavior on the
    // mocked api so we can assert the cap does its job.
    vi.mocked(h.api.stripFormatting).mockImplementation((s: string) =>
      // eslint-disable-next-line no-control-regex
      s.replace(/[\x00-\x1F\x7F]/g, '').replace(/\d{0,2}(?:,\d{0,2})?/g, ''),
    );
    await startSession(h);
    h.says.length = 0;
    await tickBind(h)(timeCtx());
    const announce = h.says.find((s) => s.target === '#radio');
    expect(announce).toBeDefined();
    // No control bytes in the announced line.
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1F]/.test(announce!.message)).toBe(false);
  });

  it('catch-all handles an unexpected throw without propagating', async () => {
    const h = harness();
    await h.instance.init(h.api);
    const spy = vi.fn(async () => {
      throw new Error('not a Spotify error');
    });
    h.instance[INTERNALS].setSpotifyClient({ getCurrentlyPlaying: spy });
    await startSession(h);
    await tickBind(h)(timeCtx());
    expect(h.instance[INTERNALS].getState().session!.consecutiveErrors).toBe(1);
    expect(h.error).toHaveBeenCalled();
  });

  it('per-target due-time gate skips polls within the configured interval', async () => {
    const h = harness();
    await h.instance.init(h.api);
    const spotifyResult = installScriptedSpotify([track('A')]);
    h.instance[INTERNALS].setSpotifyClient(spotifyResult.client);
    await startSession(h);
    await tickBind(h)(timeCtx());
    expect(spotifyResult.spy).toHaveBeenCalledTimes(1);
    // Tick again without advancing time — should be skipped by the gate.
    await tickBind(h)(timeCtx());
    expect(spotifyResult.spy).toHaveBeenCalledTimes(1);
  });
});
