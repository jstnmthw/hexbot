import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectChannelsWithKeyEnv,
  resolveSecrets,
  validateChannelKeys,
  validateResolvedSecrets,
} from '../src/config';
import type { BotConfig } from '../src/types';

describe('resolveSecrets', () => {
  const envBackup: Record<string, string | undefined> = {};
  const trackedVars = [
    'TEST_VAR_A',
    'TEST_VAR_B',
    'TEST_VAR_C',
    'TEST_NESTED',
    'TEST_ARRAY_1',
    'TEST_ARRAY_2',
  ];

  beforeEach(() => {
    for (const v of trackedVars) envBackup[v] = process.env[v];
  });

  afterEach(() => {
    for (const v of trackedVars) {
      if (envBackup[v] === undefined) delete process.env[v];
      else process.env[v] = envBackup[v];
    }
  });

  it('resolves a flat _env field from process.env', () => {
    process.env.TEST_VAR_A = 'hunter2';
    const resolved = resolveSecrets({ password_env: 'TEST_VAR_A' } as Record<string, unknown>);
    expect(resolved).toEqual({ password: 'hunter2' });
  });

  it('resolves nested _env fields', () => {
    process.env.TEST_NESTED = 'deep-secret';
    const resolved = resolveSecrets({
      services: {
        type: 'anope',
        password_env: 'TEST_NESTED',
      },
    } as Record<string, unknown>);
    expect(resolved).toEqual({
      services: { type: 'anope', password: 'deep-secret' },
    });
  });

  it('resolves _env fields inside arrays (for irc.channels)', () => {
    process.env.TEST_ARRAY_1 = 'key-one';
    process.env.TEST_ARRAY_2 = 'key-two';
    const resolved = resolveSecrets({
      channels: [
        '#public',
        { name: '#secret1', key_env: 'TEST_ARRAY_1' },
        { name: '#secret2', key_env: 'TEST_ARRAY_2' },
      ],
    } as Record<string, unknown>);
    expect(resolved).toEqual({
      channels: [
        '#public',
        { name: '#secret1', key: 'key-one' },
        { name: '#secret2', key: 'key-two' },
      ],
    });
  });

  it('drops the _env key when the env var is unset (no empty siblings left)', () => {
    delete process.env.TEST_VAR_A;
    const resolved = resolveSecrets({
      password_env: 'TEST_VAR_A',
      keep: 'me',
    } as Record<string, unknown>);
    expect(resolved).toEqual({ keep: 'me' });
    expect('password' in (resolved as object)).toBe(false);
    expect('password_env' in (resolved as object)).toBe(false);
  });

  it('emits a warning when the _env value is not a string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveSecrets({
      password_env: 123 as unknown,
    } as Record<string, unknown>);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('password_env'));
    // Non-string _env is preserved verbatim (leave as-is)
    expect((resolved as Record<string, unknown>).password_env).toBe(123);
    warn.mockRestore();
  });

  it('emits a warning and prefers _env when both forms present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.TEST_VAR_B = 'from-env';
    const resolved = resolveSecrets({
      password: 'inline-value',
      password_env: 'TEST_VAR_B',
    } as Record<string, unknown>);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('password'));
    expect(resolved).toEqual({ password: 'from-env' });
    warn.mockRestore();
  });

  it('does not mutate the input object', () => {
    process.env.TEST_VAR_C = 'result';
    const input = {
      nested: { password_env: 'TEST_VAR_C' },
      arr: [{ key_env: 'TEST_VAR_C' }],
    } as Record<string, unknown>;
    const before = JSON.stringify(input);
    resolveSecrets(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('passes through primitives unchanged', () => {
    expect(resolveSecrets('hello')).toBe('hello');
    expect(resolveSecrets(42)).toBe(42);
    expect(resolveSecrets(true)).toBe(true);
    expect(resolveSecrets(null)).toBe(null);
  });
});

describe('validateResolvedSecrets', () => {
  const baseConfig = (): BotConfig =>
    ({
      irc: {
        host: 'irc.example.net',
        port: 6697,
        tls: true,
        nick: 'Hexbot',
        username: 'hexbot',
        realname: 'HexBot',
        channels: [],
      },
      owner: { handle: 'admin', hostmask: '*!*@*' },
      identity: { method: 'hostmask', require_acc_for: [] },
      services: { type: 'anope', nickserv: 'NickServ', password: '', sasl: false },
      database: './data/test.db',
      pluginDir: './plugins',
      logging: { level: 'info', mod_actions: true },
    }) as BotConfig;

  it('passes when SASL enabled + NICKSERV_PASSWORD set', () => {
    const cfg = baseConfig();
    cfg.services.sasl = true;
    cfg.services.password = 'set';
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('fails when SASL enabled + NICKSERV_PASSWORD unset', () => {
    const cfg = baseConfig();
    cfg.services.sasl = true;
    cfg.services.password = '';
    expect(() => validateResolvedSecrets(cfg)).toThrow(/HEX_NICKSERV_PASSWORD must be set/);
  });

  it('passes when SASL disabled + NICKSERV_PASSWORD unset', () => {
    const cfg = baseConfig();
    cfg.services.sasl = false;
    cfg.services.password = '';
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('passes when SASL EXTERNAL + NICKSERV_PASSWORD unset', () => {
    const cfg = baseConfig();
    cfg.services.sasl = true;
    cfg.services.sasl_mechanism = 'EXTERNAL';
    cfg.services.password = '';
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('fails when botlink enabled + BOTLINK_PASSWORD unset', () => {
    const cfg = baseConfig();
    cfg.botlink = {
      enabled: true,
      role: 'leaf',
      botname: 'test',
      password: '',
      ping_interval_ms: 30000,
      link_timeout_ms: 90000,
    };
    expect(() => validateResolvedSecrets(cfg)).toThrow(/HEX_BOTLINK_PASSWORD must be set/);
  });

  it('passes when botlink enabled + BOTLINK_PASSWORD set', () => {
    const cfg = baseConfig();
    cfg.botlink = {
      enabled: true,
      role: 'leaf',
      botname: 'test',
      password: 'shared-secret',
      ping_interval_ms: 30000,
      link_timeout_ms: 90000,
    };
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('passes when botlink disabled regardless of password', () => {
    const cfg = baseConfig();
    cfg.botlink = {
      enabled: false,
      role: 'leaf',
      botname: 'test',
      password: '',
      ping_interval_ms: 30000,
      link_timeout_ms: 90000,
    };
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('fails when proxy has username but no password', () => {
    const cfg = baseConfig();
    cfg.proxy = {
      enabled: true,
      host: '127.0.0.1',
      port: 9050,
      username: 'socks-user',
    };
    expect(() => validateResolvedSecrets(cfg)).toThrow(/HEX_PROXY_PASSWORD must be set/);
  });

  it('passes when proxy enabled but no username', () => {
    const cfg = baseConfig();
    cfg.proxy = { enabled: true, host: '127.0.0.1', port: 9050 };
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });

  it('passes when proxy disabled', () => {
    const cfg = baseConfig();
    cfg.proxy = {
      enabled: false,
      host: '127.0.0.1',
      port: 9050,
      username: 'socks-user',
    };
    expect(() => validateResolvedSecrets(cfg)).not.toThrow();
  });
});

describe('validateChannelKeys', () => {
  it('passes when all key_env channels resolved', () => {
    const onDisk = ['#plain', { name: '#keyed', key_env: 'CHANNEL_KEY_A' }];
    const resolved = ['#plain', { name: '#keyed', key: 'resolved-value' }];
    expect(() => validateChannelKeys(onDisk, resolved)).not.toThrow();
  });

  it('fails when a key_env channel did not resolve', () => {
    const onDisk = [{ name: '#keyed', key_env: 'MISSING_KEY_ENV' }];
    const resolved = [{ name: '#keyed' }];
    expect(() => validateChannelKeys(onDisk, resolved)).toThrow(
      /Channel key env var MISSING_KEY_ENV for #keyed is unset/,
    );
  });

  it('ignores channels without key_env', () => {
    const onDisk = ['#plain', { name: '#other', key: 'hardcoded' }];
    const resolved = ['#plain', { name: '#other', key: 'hardcoded' }];
    expect(() => validateChannelKeys(onDisk, resolved)).not.toThrow();
  });
});

describe('collectChannelsWithKeyEnv', () => {
  it('returns only channels with a declared key_env', () => {
    const result = collectChannelsWithKeyEnv([
      '#plain',
      { name: '#a', key_env: 'VAR_A' },
      { name: '#b', key: 'inline' },
      { name: '#c', key_env: 'VAR_C' },
    ]);
    expect(result).toEqual([
      { name: '#a', envVarName: 'VAR_A' },
      { name: '#c', envVarName: 'VAR_C' },
    ]);
  });
});
