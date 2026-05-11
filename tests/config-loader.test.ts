import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBotConfig, readBotJsonAsRecord, readPluginsJsonAsRecord } from '../src/config/loader';

const stubLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child(): unknown {
    return this;
  },
  setLevel: () => {},
});

const EXAMPLE_BOT_JSON = resolve('config/bot.example.json');

describe('loadBotConfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hexbot-loader-load-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a merged BotConfig for the example file + bootstrap', () => {
    const path = join(tmp, 'bot.json');
    copyFileSync(EXAMPLE_BOT_JSON, path);
    chmodSync(path, 0o600);
    // The example file references *_env secrets; populate them so
    // validateResolvedSecrets passes for the SASL/services path.
    process.env.HEX_OWNER_PASSWORD = 'test-owner-pass';
    process.env.HEX_NICKSERV_PASSWORD = 'test-nickserv-pass';
    process.env.HEX_CHANMOD_RECOVERY_PASSWORD = 'test-recovery-pass';
    const bootstrap = {
      dbPath: join(tmp, 'hexbot.db'),
      pluginDir: join(tmp, 'plugins'),
      ownerHandle: 'owner',
      ownerHostmask: 'owner!*@example.org',
      failOnPluginLoadFailure: false,
    };
    try {
      const cfg = loadBotConfig(path, bootstrap);
      expect(cfg.irc.nick).toBe('HexBot');
      expect(cfg.database).toBe(bootstrap.dbPath);
      expect(cfg.pluginDir).toBe(bootstrap.pluginDir);
      expect(cfg.owner.handle).toBe('owner');
    } finally {
      delete process.env.HEX_OWNER_PASSWORD;
      delete process.env.HEX_NICKSERV_PASSWORD;
      delete process.env.HEX_CHANMOD_RECOVERY_PASSWORD;
    }
  });
});

describe('readBotJsonAsRecord', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hexbot-loader-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the parsed-and-resolved bot config when the file is valid', () => {
    const path = join(tmp, 'bot.json');
    copyFileSync(EXAMPLE_BOT_JSON, path);
    chmodSync(path, 0o600);
    const logger = stubLogger();
    const result = readBotJsonAsRecord(path, logger as never);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).irc).toBeDefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and logs when the file does not exist', () => {
    const logger = stubLogger();
    const result = readBotJsonAsRecord(join(tmp, 'missing.json'), logger as never);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to re-read bot.json'),
      expect.anything(),
    );
  });

  it('returns null and logs when the file is malformed JSON', () => {
    const path = join(tmp, 'bot.json');
    writeFileSync(path, '{ broken: json');
    const logger = stubLogger();
    const result = readBotJsonAsRecord(path, logger as never);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('readPluginsJsonAsRecord', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hexbot-loader-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when pluginsConfig is undefined (no warning emitted)', () => {
    const logger = stubLogger();
    expect(readPluginsJsonAsRecord(undefined, logger as never)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns the parsed map for a valid plugins.json', () => {
    const path = join(tmp, 'plugins.json');
    writeFileSync(path, JSON.stringify({ greeter: { config: { greeting: 'hi' } } }));
    const logger = stubLogger();
    const result = readPluginsJsonAsRecord(path, logger as never);
    expect(result).not.toBeNull();
    expect(result!.greeter?.config?.greeting).toBe('hi');
  });

  it('returns null and logs when plugins.json is missing', () => {
    const logger = stubLogger();
    expect(readPluginsJsonAsRecord(join(tmp, 'missing.json'), logger as never)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to re-read plugins.json'),
      expect.anything(),
    );
  });
});
