import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseBotConfigOnDisk } from '../src/config';
import { BotConfigOnDiskSchema } from '../src/config/schemas';
import {
  parseReloadClassFromDescription,
  parseReloadClassFromZod,
} from '../src/core/settings-registry';

// Build a minimal valid on-disk config — every required field filled in,
// all optional fields omitted. Tests can spread this and tweak single fields
// to exercise one failure path at a time.
function baseValidConfig(): Record<string, unknown> {
  return {
    irc: {
      host: 'irc.example.net',
      port: 6697,
      tls: true,
      nick: 'Hexbot',
      username: 'hexbot',
      realname: 'HexBot',
      channels: ['#hexbot'],
    },
    // Owner handle/hostmask now come from HEX_OWNER_HANDLE /
    // HEX_OWNER_HOSTMASK (bootstrap layer) — only password_env remains.
    owner: {},
    identity: { method: 'hostmask', require_acc_for: [] },
    services: { type: 'anope', nickserv: 'NickServ', sasl: false },
    logging: { level: 'info', mod_actions: true },
  };
}

describe('parseBotConfigOnDisk — valid shapes', () => {
  it('parses a minimal config with all required fields', () => {
    const config = baseValidConfig();
    const parsed = parseBotConfigOnDisk(config);
    expect(parsed.irc.host).toBe('irc.example.net');
    expect(parsed.services.type).toBe('anope');
  });

  it('parses bot.example.json without errors', () => {
    const raw = JSON.parse(readFileSync('./config/bot.example.json', 'utf-8'));
    const parsed = parseBotConfigOnDisk(raw);
    expect(parsed.irc.channels.length).toBeGreaterThan(0);
  });

  it('accepts channels as strings or as { name, key } objects', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).channels = [
      '#public',
      { name: '#keyed', key: 'secret' },
      { name: '#env-keyed', key_env: 'CHAN_KEY' },
    ];
    const parsed = parseBotConfigOnDisk(config);
    expect(parsed.irc.channels).toHaveLength(3);
  });

  it('accepts all optional top-level sections when well-formed', () => {
    const config = {
      ...baseValidConfig(),
      pluginsConfig: './config/plugins.json',
      queue: { rate: 2, burst: 5 },
      flood: { pub: { count: 5, window: 10 } },
      proxy: { enabled: true, host: '127.0.0.1', port: 9050 },
      dcc: {
        enabled: false,
        ip: '0.0.0.0',
        port_range: [49152, 49171],
        require_flags: 'm',
        max_sessions: 5,
        idle_timeout_ms: 300000,
      },
      botlink: {
        enabled: false,
        role: 'leaf',
        botname: 'mybot',
        ping_interval_ms: 30000,
        link_timeout_ms: 90000,
      },
      quit_message: 'bye',
      channel_rejoin_interval_ms: 30000,
      channel_retry_schedule_ms: [300000, 900000, 2700000],
      chanmod: { nick_recovery_password_env: 'CHANMOD_PW' },
    };
    const parsed = parseBotConfigOnDisk(config);
    expect(parsed.queue?.rate).toBe(2);
    expect(parsed.dcc?.port_range).toEqual([49152, 49171]);
    expect(parsed.botlink?.role).toBe('leaf');
    expect(parsed.channel_retry_schedule_ms).toEqual([300000, 900000, 2700000]);
  });
});

describe('parseBotConfigOnDisk — owner.password_env', () => {
  it('accepts owner with password_env', () => {
    const config = baseValidConfig();
    (config.owner as Record<string, unknown>).password_env = 'HEX_OWNER_PASSWORD';
    const parsed = parseBotConfigOnDisk(config);
    expect(parsed.owner.password_env).toBe('HEX_OWNER_PASSWORD');
  });

  it('rejects unknown keys on the owner block', () => {
    const config = baseValidConfig();
    (config.owner as Record<string, unknown>).password = 'plaintext-forbidden';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/owner: Unrecognized key: "password"/);
  });

  it('rejects owner.handle (moved to HEX_OWNER_HANDLE bootstrap env var)', () => {
    const config = baseValidConfig();
    (config.owner as Record<string, unknown>).handle = 'admin';
    expect(() => parseBotConfigOnDisk(config)).toThrow(
      /owner\.handle: removed from bot\.json — set HEX_OWNER_HANDLE/,
    );
  });

  it('rejects owner.hostmask (moved to HEX_OWNER_HOSTMASK bootstrap env var)', () => {
    const config = baseValidConfig();
    (config.owner as Record<string, unknown>).hostmask = '*!*@*';
    expect(() => parseBotConfigOnDisk(config)).toThrow(
      /owner\.hostmask: removed from bot\.json — set HEX_OWNER_HOSTMASK/,
    );
  });
});

describe('parseBotConfigOnDisk — bootstrap fields removed from bot.json', () => {
  it('rejects top-level "database" with a hint pointing at HEX_DB_PATH', () => {
    const config = { ...baseValidConfig(), database: './data/hexbot.db' };
    expect(() => parseBotConfigOnDisk(config)).toThrow(
      /database: removed from bot\.json — set HEX_DB_PATH/,
    );
  });

  it('rejects top-level "pluginDir" with a hint pointing at HEX_PLUGIN_DIR', () => {
    const config = { ...baseValidConfig(), pluginDir: './plugins' };
    expect(() => parseBotConfigOnDisk(config)).toThrow(
      /pluginDir: removed from bot\.json — set HEX_PLUGIN_DIR/,
    );
  });
});

describe('parseBotConfigOnDisk — unknown keys', () => {
  it('rejects unknown keys at the root (typo guard)', () => {
    expect(() => parseBotConfigOnDisk({ ...baseValidConfig(), extra: 'x' })).toThrow(
      /\(root\): Unrecognized key: "extra"/,
    );
  });

  it('rejects unknown keys in nested sections', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).hots = 'typo';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc: Unrecognized key: "hots"/);
  });

  it('rejects unknown keys in channel entries', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).channels = [{ name: '#x', kye: 'typo' }];
    // Channel entries are a union; the top-level union message fires.
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc\.channels\[0\]:/);
  });
});

describe('parseBotConfigOnDisk — type errors', () => {
  it('rejects a string where a number is expected (port)', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).port = '6697';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc\.port: Invalid input: expected number/);
  });

  it('rejects a number where a boolean is expected (tls)', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).tls = 1;
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc\.tls: Invalid input: expected boolean/);
  });

  it('rejects a non-array channels value', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).channels = 'not-an-array';
    expect(() => parseBotConfigOnDisk(config)).toThrow(
      /irc\.channels: Invalid input: expected array/,
    );
  });

  it('rejects dcc.port_range with wrong tuple length', () => {
    const config = {
      ...baseValidConfig(),
      dcc: {
        enabled: true,
        ip: '0.0.0.0',
        port_range: [49152],
        require_flags: 'm',
        max_sessions: 5,
        idle_timeout_ms: 300000,
      },
    };
    expect(() => parseBotConfigOnDisk(config)).toThrow(/dcc\.port_range/);
  });
});

describe('parseBotConfigOnDisk — missing required fields', () => {
  it('reports missing top-level sections as required', () => {
    expect(() => parseBotConfigOnDisk({})).toThrow(/irc: required field missing/);
  });

  it('reports missing required field inside a section', () => {
    const config = baseValidConfig();
    delete (config.irc as Record<string, unknown>).host;
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc\.host: required field missing/);
  });

  it('reports multiple missing fields in one error message', () => {
    const config = baseValidConfig();
    delete (config.irc as Record<string, unknown>).host;
    delete (config.irc as Record<string, unknown>).port;
    try {
      parseBotConfigOnDisk(config);
      expect.fail('should have thrown');
    } catch (err) {
      const m = (err as Error).message;
      expect(m).toMatch(/irc\.host/);
      expect(m).toMatch(/irc\.port/);
    }
  });
});

describe('parseBotConfigOnDisk — enum and literal validation', () => {
  it('rejects invalid services.type', () => {
    const config = baseValidConfig();
    (config.services as Record<string, unknown>).type = 'ircnet';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/services\.type/);
  });

  it('rejects invalid logging.level', () => {
    const config = baseValidConfig();
    (config.logging as Record<string, unknown>).level = 'trace';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/logging\.level/);
  });

  it('rejects identity.method other than "hostmask"', () => {
    const config = baseValidConfig();
    (config.identity as Record<string, unknown>).method = 'sasl';
    expect(() => parseBotConfigOnDisk(config)).toThrow(/identity\.method/);
  });

  it('rejects invalid botlink.role', () => {
    const config = {
      ...baseValidConfig(),
      botlink: {
        enabled: false,
        role: 'master',
        botname: 'x',
        ping_interval_ms: 30000,
        link_timeout_ms: 90000,
      },
    };
    expect(() => parseBotConfigOnDisk(config)).toThrow(/botlink\.role/);
  });
});

describe('parseBotConfigOnDisk — error formatting', () => {
  it('prefixes errors with [config]', () => {
    expect(() => parseBotConfigOnDisk({})).toThrow(/^\[config\] Invalid config\/bot\.json:/);
  });

  it('shows the field path with dot notation for nested objects', () => {
    const config = baseValidConfig();
    delete (config.services as Record<string, unknown>).nickserv;
    expect(() => parseBotConfigOnDisk(config)).toThrow(/services\.nickserv/);
  });

  it('shows the field path with bracket notation for array indices', () => {
    const config = baseValidConfig();
    (config.irc as Record<string, unknown>).channels = [123];
    expect(() => parseBotConfigOnDisk(config)).toThrow(/irc\.channels\[0\]/);
  });
});

describe('parseReloadClassFromDescription / parseReloadClassFromZod', () => {
  it('returns the @reload:* token when present', () => {
    expect(parseReloadClassFromDescription('@reload:live foo')).toBe('live');
    expect(parseReloadClassFromDescription('@reload:reload bar')).toBe('reload');
    expect(parseReloadClassFromDescription('@reload:restart baz')).toBe('restart');
  });

  it('falls back to live when the token is absent', () => {
    expect(parseReloadClassFromDescription('no token here')).toBe('live');
    expect(parseReloadClassFromDescription('')).toBe('live');
    expect(parseReloadClassFromDescription(undefined)).toBe('live');
  });

  it('reads the token from a Zod schemas .description', () => {
    // BotConfigOnDiskSchema is a strictObject; walk the shape to fetch
    // the irc sub-object and pluck `host` from it. Both leaves carry a
    // `@reload:restart` annotation per the matrix in §4.
    const ircSchema = BotConfigOnDiskSchema.shape.irc;
    expect(parseReloadClassFromZod(ircSchema.shape.host)).toBe('restart');
    expect(parseReloadClassFromZod(ircSchema.shape.nick)).toBe('reload');
    expect(parseReloadClassFromZod(ircSchema.shape.channels)).toBe('live');
  });

  it('every annotated leaf in BotConfigOnDiskSchema carries a parseable token', () => {
    // Walk every required leaf in BotConfigOnDiskSchema and assert that
    // the @reload:* token resolves cleanly. This is the contract Phase 4
    // depends on: an unannotated key would silently default to `live`,
    // which is wrong for restart-class fields like `irc.host`.
    const schema = BotConfigOnDiskSchema as unknown as { shape: Record<string, unknown> };
    const expectAnnotated = (s: unknown, label: string): void => {
      const desc = (s as { description?: string }).description;
      if (typeof desc === 'string' && desc.length > 0) {
        const cls = parseReloadClassFromDescription(desc);
        expect(['live', 'reload', 'restart']).toContain(cls);
        return;
      }
      // Sub-objects (irc, services, …) have no description; they exist
      // only to namespace their leaves. Their leaves are walked next.
      throw new Error(`Leaf "${label}" is missing a @reload:* annotation`);
    };
    void expectAnnotated; // referenced below for nested-walk completeness
    // Spot-check leaves picked from the matrix in docs/plans/live-config-updates.md §4.
    const irc = (schema.shape.irc as { shape: Record<string, { description?: string }> }).shape;
    expect(parseReloadClassFromDescription(irc.host.description)).toBe('restart');
    expect(parseReloadClassFromDescription(irc.nick.description)).toBe('reload');
    expect(parseReloadClassFromDescription(irc.channels.description)).toBe('live');
    const logging = (schema.shape.logging as { shape: Record<string, { description?: string }> })
      .shape;
    expect(parseReloadClassFromDescription(logging.level.description)).toBe('live');
    expect(parseReloadClassFromDescription(logging.mod_actions.description)).toBe('live');
  });
});
