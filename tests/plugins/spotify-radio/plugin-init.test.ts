import { describe, expect, it, vi } from 'vitest';

import { createSpotifyRadio, loadConfig } from '../../../plugins/spotify-radio/index';
import type { PluginAPI } from '../../../src/types';
import { createMockPluginAPI } from '../../helpers/mock-plugin-api';

const VALID_CLIENT_ID = 'TEST_CLIENT_ID_VALUE';
const VALID_CLIENT_SECRET = 'TEST_CLIENT_SECRET_VALUE';
const VALID_REFRESH_TOKEN = 'TEST_REFRESH_TOKEN_VALUE';

function apiWithBootConfig(bootConfig: Record<string, unknown>): {
  api: PluginAPI;
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const log = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const api = createMockPluginAPI({
    log,
    warn,
    error,
    debug,
    settings: {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(''),
      getFlag: vi.fn().mockReturnValue(false),
      getString: vi.fn().mockReturnValue(''),
      getInt: vi.fn().mockReturnValue(0),
      set: vi.fn(),
      unset: vi.fn(),
      isSet: vi.fn().mockReturnValue(false),
      onChange: vi.fn(),
      offChange: vi.fn(),
      bootConfig: Object.freeze(bootConfig),
    },
  });
  return { api, log, warn, error, debug };
}

function fullValidBootConfig(): Record<string, unknown> {
  return {
    client_id: VALID_CLIENT_ID,
    client_secret: VALID_CLIENT_SECRET,
    refresh_token: VALID_REFRESH_TOKEN,
    poll_interval_sec: 10,
    session_ttl_hours: 6,
    announce_prefix: '[radio]',
    allowed_link_hosts: ['open.spotify.com'],
    max_consecutive_errors: 5,
  };
}

function assertNoSecretsInCalls(...spies: Array<ReturnType<typeof vi.fn>>): void {
  const SECRETS = [VALID_CLIENT_ID, VALID_CLIENT_SECRET, VALID_REFRESH_TOKEN];
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        const text = typeof arg === 'string' ? arg : JSON.stringify(arg);
        for (const secret of SECRETS) {
          expect(text).not.toContain(secret);
        }
      }
    }
  }
}

describe('spotify-radio init / loadConfig', () => {
  it('loads cleanly when every required field is present', async () => {
    const { api, log } = apiWithBootConfig(fullValidBootConfig());
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('throws naming the env var when client_id is missing', async () => {
    const cfg = fullValidBootConfig();
    delete cfg.client_id;
    const { api, log, warn, error, debug } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/HEX_SPOTIFY_CLIENT_ID/);
    assertNoSecretsInCalls(log, warn, error, debug);
  });

  it('throws naming the env var when client_secret is missing', async () => {
    const cfg = fullValidBootConfig();
    delete cfg.client_secret;
    const { api, log, warn, error, debug } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/HEX_SPOTIFY_CLIENT_SECRET/);
    assertNoSecretsInCalls(log, warn, error, debug);
  });

  it('throws naming the env var when refresh_token is missing', async () => {
    const cfg = fullValidBootConfig();
    delete cfg.refresh_token;
    const { api, log, warn, error, debug } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/HEX_SPOTIFY_REFRESH_TOKEN/);
    assertNoSecretsInCalls(log, warn, error, debug);
  });

  it('throws naming the env var (not the value) when refresh_token has leading whitespace', async () => {
    const cfg = fullValidBootConfig();
    cfg.refresh_token = `  ${VALID_REFRESH_TOKEN}`;
    const { api, log, warn, error, debug } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    let thrown: Error | null = null;
    try {
      await instance.init(api);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/HEX_SPOTIFY_REFRESH_TOKEN/);
    expect(thrown!.message).not.toContain(VALID_REFRESH_TOKEN);
    assertNoSecretsInCalls(log, warn, error, debug);
  });

  it('throws naming the env var when refresh_token is the empty string', async () => {
    const cfg = fullValidBootConfig();
    cfg.refresh_token = '';
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/HEX_SPOTIFY_REFRESH_TOKEN/);
  });

  it('warns and continues when poll_interval_sec is below the dispatcher floor', async () => {
    const cfg = fullValidBootConfig();
    cfg.poll_interval_sec = 5;
    const { api, warn } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await instance.init(api);
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((c) => c.join(' '));
    expect(messages.some((m) => m.includes('10s timer floor'))).toBe(true);
  });

  it('rejects a non-array allowed_link_hosts', async () => {
    const cfg = fullValidBootConfig();
    cfg.allowed_link_hosts = 'open.spotify.com';
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/allowed_link_hosts/);
  });

  it('lowercases each entry of allowed_link_hosts', async () => {
    const cfg = fullValidBootConfig();
    cfg.allowed_link_hosts = ['Open.Spotify.com', 'SPOTIFY.LINK'];
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).resolves.toBeUndefined();
    // Re-run loadConfig directly so we can read back the normalized value.
    const resolved = loadConfig(api);
    expect(resolved.allowedLinkHosts).toEqual(['open.spotify.com', 'spotify.link']);
  });

  it('teardown is idempotent', () => {
    const instance = createSpotifyRadio();
    expect(() => instance.teardown()).not.toThrow();
    expect(() => instance.teardown()).not.toThrow();
  });

  it('rejects a non-integer poll_interval_sec', async () => {
    const cfg = fullValidBootConfig();
    cfg.poll_interval_sec = 'never' as unknown as number;
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/poll_interval_sec/);
  });

  it('rejects a poll_interval_sec out of range', async () => {
    const cfg = fullValidBootConfig();
    cfg.poll_interval_sec = 99999;
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/poll_interval_sec/);
  });

  it('rejects a non-string announce_prefix', async () => {
    const cfg = fullValidBootConfig();
    cfg.announce_prefix = 42 as unknown as string;
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/announce_prefix/);
  });

  it('rejects allowed_link_hosts containing an empty string', async () => {
    const cfg = fullValidBootConfig();
    cfg.allowed_link_hosts = ['open.spotify.com', ''];
    const { api } = apiWithBootConfig(cfg);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).rejects.toThrow(/allowed_link_hosts/);
  });

  it('falls back to defaults when tunables are omitted from bootConfig', async () => {
    const minimal: Record<string, unknown> = {
      client_id: VALID_CLIENT_ID,
      client_secret: VALID_CLIENT_SECRET,
      refresh_token: VALID_REFRESH_TOKEN,
    };
    const { api } = apiWithBootConfig(minimal);
    const instance = createSpotifyRadio();
    await expect(instance.init(api)).resolves.toBeUndefined();
    const c = loadConfig(api);
    expect(c.pollIntervalSec).toBe(10);
    expect(c.sessionTtlHours).toBe(6);
    expect(c.announcePrefix).toBe('[radio]');
    expect(c.allowedLinkHosts).toEqual(['open.spotify.com']);
    expect(c.maxConsecutiveErrors).toBe(5);
  });
});
