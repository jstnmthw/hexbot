import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHANMOD_SETTING_DEFS, readConfig } from '../../plugins/chanmod/state';
import { type CommandContext, CommandHandler } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { registerChannelCommands } from '../../src/core/commands/channel-commands';
import { coerceFromJson } from '../../src/core/seed-from-json';
import { SettingsRegistry } from '../../src/core/settings-registry';
import { BotDatabase } from '../../src/database';
import type { PluginAPI, PluginSettings } from '../../src/types';
import { createMockPluginAPI } from '../helpers/mock-plugin-api';

// ---------------------------------------------------------------------------
// readConfig() — validation under the typed-settings backend
// ---------------------------------------------------------------------------

describe('readConfig — config validation', () => {
  /**
   * Build a mock PluginAPI whose `settings` is backed by a real
   * SettingsRegistry + in-memory DB so readConfig sees realistic
   * coercion + isSet behavior. `bootConfig` is fed through
   * `coerceFromJson` (the same path the plugin loader uses), so JSON
   * values that fail type coercion are dropped just like in production.
   */
  function makeApi(configOverrides: Record<string, unknown> = {}): {
    api: PluginAPI;
    log: Mock;
  } {
    const log = vi.fn();
    const db = new BotDatabase(':memory:');
    db.open();
    const registry = new SettingsRegistry({
      scope: 'plugin',
      namespace: 'plugin:chanmod',
      db,
      auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
    });
    registry.register('chanmod', CHANMOD_SETTING_DEFS);
    const merged: Record<string, unknown> = {
      services_host_pattern: 'services.*',
      ...configOverrides,
    };
    for (const def of CHANMOD_SETTING_DEFS) {
      const seed = merged[def.key];
      if (seed === undefined) continue;
      const coerced = coerceFromJson(
        { ...def, owner: 'chanmod', reloadClass: def.reloadClass ?? 'live' },
        seed,
      );
      if (coerced !== null) registry.set('', def.key, coerced);
    }
    const settings: PluginSettings = {
      register: () => {},
      get: (key) => registry.get('', key),
      getFlag: (key) => registry.getFlag('', key),
      getString: (key) => registry.getString('', key),
      getInt: (key) => registry.getInt('', key),
      set: (key, value) => {
        registry.set('', key, value);
      },
      unset: (key) => {
        registry.unset('', key);
      },
      isSet: (key) => registry.isSet('', key),
      onChange: () => {},
      offChange: () => {},
      bootConfig: Object.freeze({ ...merged }),
    };
    const api = createMockPluginAPI({ settings, log });
    return { api, log };
  }

  describe('numeric fields', () => {
    it('accepts valid positive numbers', () => {
      const { api } = makeApi({ enforce_delay_ms: 1000, takeover_window_ms: 60000 });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(1000);
      expect(config.takeover_window_ms).toBe(60000);
    });

    it('accepts zero as valid', () => {
      const { api } = makeApi({ takeover_response_delay_ms: 0 });
      const config = readConfig(api);
      expect(config.takeover_response_delay_ms).toBe(0);
    });

    it('drops non-coercible values via the JSON-seed path', () => {
      // String "banana" can coerce to a string-typed setting but not an
      // int-typed one. The seed walker silently skips it; readConfig
      // returns the registered default (30_000).
      const { api } = makeApi({ takeover_window_ms: 'banana' });
      const config = readConfig(api);
      expect(config.takeover_window_ms).toBe(30_000);
    });

    it('numeric strings are dropped (only Int-shaped JSON seeds an int setting)', () => {
      // Pre-migration the validator coerced "1500" → 1500. The typed
      // registry's coerceFromJson is stricter — only number-typed JSON
      // values seed int settings — so a numeric string is dropped and
      // the default (500) wins.
      const { api } = makeApi({ enforce_delay_ms: '1500' });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(500);
    });
  });

  describe('enum fields', () => {
    it('accepts valid enum values', () => {
      const { api } = makeApi({
        revenge_action: 'kickban',
        punish_action: 'kickban',
        chanserv_services_type: 'anope',
      });
      const config = readConfig(api);
      expect(config.revenge_action).toBe('kickban');
      expect(config.punish_action).toBe('kickban');
      expect(config.chanserv_services_type).toBe('anope');
    });

    it('rejects invalid revenge_action and falls back to default', () => {
      const { api } = makeApi({ revenge_action: 'nuke' });
      const config = readConfig(api);
      expect(config.revenge_action).toBe('deop');
    });

    it('rejects invalid punish_action and falls back to default', () => {
      const { api } = makeApi({ punish_action: 'destroy' });
      const config = readConfig(api);
      expect(config.punish_action).toBe('kick');
    });

    it('rejects invalid chanserv_services_type and falls back to default', () => {
      const { api } = makeApi({ chanserv_services_type: 'dalnet' });
      const config = readConfig(api);
      expect(config.chanserv_services_type).toBe('atheme');
    });
  });

  describe('threshold ordering', () => {
    it('accepts properly ordered thresholds', () => {
      const { api } = makeApi({
        takeover_level_1_threshold: 5,
        takeover_level_2_threshold: 10,
        takeover_level_3_threshold: 15,
      });
      const config = readConfig(api);
      expect(config.takeover_level_1_threshold).toBe(5);
      expect(config.takeover_level_2_threshold).toBe(10);
      expect(config.takeover_level_3_threshold).toBe(15);
    });

    it('resets all thresholds when level_1 >= level_2', () => {
      const { api, log } = makeApi({
        takeover_level_1_threshold: 10,
        takeover_level_2_threshold: 5,
        takeover_level_3_threshold: 15,
      });
      const config = readConfig(api);
      expect(config.takeover_level_1_threshold).toBe(3);
      expect(config.takeover_level_2_threshold).toBe(6);
      expect(config.takeover_level_3_threshold).toBe(10);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('level_1'));
    });

    it('resets all thresholds when level_2 >= level_3', () => {
      const { api, log } = makeApi({
        takeover_level_1_threshold: 3,
        takeover_level_2_threshold: 15,
        takeover_level_3_threshold: 10,
      });
      const config = readConfig(api);
      expect(config.takeover_level_1_threshold).toBe(3);
      expect(config.takeover_level_2_threshold).toBe(6);
      expect(config.takeover_level_3_threshold).toBe(10);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('level_2'));
    });

    it('resets all thresholds when levels are equal', () => {
      const { api } = makeApi({
        takeover_level_1_threshold: 5,
        takeover_level_2_threshold: 5,
        takeover_level_3_threshold: 5,
      });
      const config = readConfig(api);
      expect(config.takeover_level_1_threshold).toBe(3);
      expect(config.takeover_level_2_threshold).toBe(6);
      expect(config.takeover_level_3_threshold).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------
// .chanset — allowedValues validation
// ---------------------------------------------------------------------------

describe('.chanset — allowedValues validation', () => {
  let handler: CommandHandler;
  let channelSettings: ChannelSettings;

  function makeCtx(): CommandContext & { reply: Mock<(msg: string) => void> } {
    const reply = vi.fn<(msg: string) => void>();
    const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply };
    return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
  }

  beforeEach(() => {
    const db = new BotDatabase(':memory:');
    db.open();
    handler = new CommandHandler();
    channelSettings = new ChannelSettings(db);
    registerChannelCommands({ handler, channelSettings, db: null });

    channelSettings.register('chanmod', [
      {
        key: 'chanserv_access',
        type: 'string',
        default: 'none',
        description: 'ChanServ access tier',
        allowedValues: ['none', 'op', 'superop', 'founder'],
      },
      {
        key: 'takeover_punish',
        type: 'string',
        default: 'deop',
        description: 'Takeover response',
        allowedValues: ['none', 'deop', 'kickban', 'akick'],
      },
      {
        key: 'channel_modes',
        type: 'string',
        default: '',
        description: 'Free-form mode string (no allowedValues)',
      },
    ]);
  });

  it('rejects invalid chanserv_access value', async () => {
    const ctx = makeCtx();
    await handler.execute('.chanset #test chanserv_access garbage', ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Invalid value'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('garbage'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('none, op, superop, founder'));
    expect(channelSettings.isSet('#test', 'chanserv_access')).toBe(false);
  });

  it('accepts valid chanserv_access value', async () => {
    const ctx = makeCtx();
    await handler.execute('.chanset #test chanserv_access founder', ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('founder'));
    expect(channelSettings.get('#test', 'chanserv_access')).toBe('founder');
  });

  it('rejects invalid takeover_punish value', async () => {
    const ctx = makeCtx();
    await handler.execute('.chanset #test takeover_punish typo', ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Invalid value'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('typo'));
    expect(channelSettings.isSet('#test', 'takeover_punish')).toBe(false);
  });

  it('accepts valid takeover_punish value', async () => {
    const ctx = makeCtx();
    await handler.execute('.chanset #test takeover_punish akick', ctx);
    expect(channelSettings.get('#test', 'takeover_punish')).toBe('akick');
  });

  it('does not constrain string settings without allowedValues', async () => {
    const ctx = makeCtx();
    await handler.execute('.chanset #test channel_modes +nt-s', ctx);
    expect(channelSettings.get('#test', 'channel_modes')).toBe('+nt-s');
  });
});
