import { describe, expect, it, vi } from 'vitest';

import {
  INTERNALS,
  type SpotifyRadio,
  createSpotifyRadio,
} from '../../../plugins/spotify-radio/index';
import type { BindHandler, BindType, ChannelHandlerContext, PluginAPI } from '../../../src/types';
import { createMockPluginAPI } from '../../helpers/mock-plugin-api';

/**
 * Inject a default-success stub Spotify client so the `!radio on` pre-flight
 * (token verify) succeeds without hitting the real Spotify API. Tests that
 * specifically exercise the pre-flight refusal path should call
 * `setSpotifyClient` themselves with a `verifyToken` that throws.
 */
function stubSpotifyClient(h: { instance: SpotifyRadio }): void {
  h.instance[INTERNALS].setSpotifyClient({
    getCurrentlyPlaying: vi.fn(async () => null),
    verifyToken: vi.fn(async () => {}),
  });
}

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
  checkFlagsResult: { value: boolean };
  servicesAvailable: { value: boolean };
  verifyResult: { verified: boolean; account: string | null };
}

function harness(
  opts: {
    ownerHasFlag?: boolean;
    servicesAvailable?: boolean;
    verified?: boolean;
  } = {},
): Harness {
  const ownerHasFlag = opts.ownerHasFlag ?? true;
  const servicesAvailable = opts.servicesAvailable ?? false;
  const verified = opts.verified ?? true;

  const binds: CapturedBind[] = [];
  const says: Array<{ target: string; message: string }> = [];
  const notices: Array<{ target: string; message: string }> = [];
  const log = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();

  const checkFlagsResult = { value: ownerHasFlag };
  const servicesAvailableHolder = { value: servicesAvailable };
  const verifyResult = { verified, account: verified ? 'admin' : null };

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
      checkFlags: vi.fn(() => checkFlagsResult.value),
    },
    services: {
      verifyUser: vi.fn(async () => ({ ...verifyResult })),
      isAvailable: vi.fn(() => servicesAvailableHolder.value),
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
        max_consecutive_errors: 5,
      }),
    },
  });

  const instance = createSpotifyRadio();
  return {
    api,
    instance,
    binds,
    says,
    notices,
    log,
    warn,
    error,
    debug,
    checkFlagsResult,
    servicesAvailable: servicesAvailableHolder,
    verifyResult,
  };
}

function pubBind(h: Harness, mask: string): BindHandler<'pub'> {
  const bind = h.binds.find((b) => b.type === 'pub' && b.mask === mask);
  if (!bind) throw new Error(`no pub bind for ${mask}`);
  return bind.handler as BindHandler<'pub'>;
}

function makeCtx(overrides: Partial<ChannelHandlerContext> = {}): ChannelHandlerContext {
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

describe('spotify-radio commands', () => {
  it('bare !radio prints "Radio is off." via notice when no session is active', async () => {
    const h = harness();
    await h.instance.init(h.api);
    await pubBind(h, '!radio')(makeCtx({ args: '' }));
    expect(h.notices.length).toBeGreaterThan(0);
    expect(h.notices[0]!.target).toBe('admin');
    expect(h.notices[0]!.message).toContain('Radio is off');
    expect(h.says.length).toBe(0);
  });

  it('!radio on <valid-url> as owner — creates session and announces opening line', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    expect(h.instance[INTERNALS].getState().session).not.toBeNull();
    expect(h.instance[INTERNALS].getState().session!.jamUrl).toBe(VALID);
    expect(h.instance[INTERNALS].getState().session!.lastTrackId).toBeNull();
    expect(
      h.says.some((s) => s.target === '#radio' && s.message.endsWith(`Tune In: ${VALID}`)),
    ).toBe(true);
  });

  it('!radio on <valid-url> as non-owner — refused, session stays null', async () => {
    const h = harness({ ownerHasFlag: false });
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.notices.some((n) => n.message.toLowerCase().includes('permission'))).toBe(true);
  });

  it('!radio on <invalid-url> — refused with reason, no session', async () => {
    const h = harness();
    await h.instance.init(h.api);
    await pubBind(h, '!radio')(makeCtx({ args: 'on http://evil.example/jam/x' }));
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.notices.some((n) => n.message.toLowerCase().includes('share link'))).toBe(true);
  });

  it('!radio on <valid-url> when a session already exists — refused', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    h.notices.length = 0;
    h.says.length = 0;
    await pubBind(
      h,
      '!radio',
    )(makeCtx({ args: `on https://open.spotify.com/socialsession/different`, channel: '#other' }));
    expect(h.instance[INTERNALS].getState().session!.channel).toBe('#radio');
    expect(h.notices.some((n) => n.message.toLowerCase().includes('already'))).toBe(true);
  });

  it('!radio off as owner with active session — clears session and announces ended', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    h.says.length = 0;
    await pubBind(h, '!radio')(makeCtx({ args: 'off' }));
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.says.some((s) => s.target === '#radio' && s.message.includes('ended'))).toBe(true);
  });

  it('!radio off with no session — notice only, no channel spam', async () => {
    const h = harness();
    await h.instance.init(h.api);
    await pubBind(h, '!radio')(makeCtx({ args: 'off' }));
    expect(h.says.length).toBe(0);
    expect(h.notices.some((n) => n.message.toLowerCase().includes('not on'))).toBe(true);
  });

  it('!listen prints status to the channel, not as a notice', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    h.says.length = 0;
    h.notices.length = 0;
    await pubBind(h, '!listen')(makeCtx({ args: '' }));
    expect(h.says.some((s) => s.target === '#radio')).toBe(true);
    expect(h.notices.length).toBe(0);
  });

  it('!radio on with services available + verifyUser failing — refused', async () => {
    const h = harness({ servicesAvailable: true, verified: false });
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(
      h.notices.some((n) => n.message.toLowerCase().includes('nickserv verification required')),
    ).toBe(true);
  });

  it('!radio on with services unavailable — proceeds with hostmask gating only', async () => {
    const h = harness({ servicesAvailable: false, verified: false });
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    expect(h.instance[INTERNALS].getState().session).not.toBeNull();
  });

  it('teardown mid-session clears session and a fresh init starts clean', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(h, '!radio')(makeCtx({ args: `on ${VALID}` }));
    expect(h.instance[INTERNALS].getState().session).not.toBeNull();
    h.instance.teardown();
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.instance[INTERNALS].getState().cfg).toBeNull();
    expect(h.instance[INTERNALS].getState().spotify).toBeNull();
    const h2 = harness();
    await h2.instance.init(h2.api);
    expect(h2.instance[INTERNALS].getState().session).toBeNull();
    expect(h2.instance[INTERNALS].getState().cfg).not.toBeNull();
  });

  it('strips utm tracking params on !radio on but preserves si', async () => {
    const h = harness();
    await h.instance.init(h.api);
    stubSpotifyClient(h);
    await pubBind(
      h,
      '!radio',
    )(makeCtx({ args: `on https://open.spotify.com/socialsession/abc?si=keep&utm_source=evil` }));
    const url = h.instance[INTERNALS].getState().session!.jamUrl;
    expect(url).toContain('si=keep');
    expect(url).not.toContain('utm_source');
  });

  it('!radio on with no url argument — usage notice, no session', async () => {
    const h = harness();
    await h.instance.init(h.api);
    await pubBind(h, '!radio')(makeCtx({ args: 'on' }));
    expect(h.instance[INTERNALS].getState().session).toBeNull();
    expect(h.notices.some((n) => n.message.toLowerCase().includes('usage'))).toBe(true);
  });

  it('!radio with an unknown subcommand — usage notice', async () => {
    const h = harness();
    await h.instance.init(h.api);
    await pubBind(h, '!radio')(makeCtx({ args: 'frobnicate' }));
    expect(h.notices.some((n) => n.message.toLowerCase().includes('usage'))).toBe(true);
  });

  it('registers help entries for !radio and !listen', async () => {
    const h = harness();
    await h.instance.init(h.api);
    expect(h.api.registerHelp).toHaveBeenCalled();
    const calls = (h.api.registerHelp as ReturnType<typeof vi.fn>).mock.calls;
    const allEntries = calls.flatMap((c) => c[0] as Array<{ command: string }>);
    const cmds = allEntries.map((e) => e.command);
    expect(cmds).toContain('!radio');
    expect(cmds).toContain('!listen');
  });
});
