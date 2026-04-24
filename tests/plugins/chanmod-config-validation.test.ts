import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../../plugins/chanmod/state';
import { type CommandContext, CommandHandler } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { registerChannelCommands } from '../../src/core/commands/channel-commands';
import { BotDatabase } from '../../src/database';
import { createMockPluginAPI } from '../helpers/mock-plugin-api';

// ---------------------------------------------------------------------------
// readConfig() — numeric and enum validation
// ---------------------------------------------------------------------------

describe('readConfig — config validation', () => {
  function makeApi(configOverrides: Record<string, unknown> = {}) {
    const log = vi.fn();
    // services_host_pattern is required by readConfig (audit 2026-04-24
    // CRITICAL ChanServ pin). Fill it in so validation tests aren't
    // blocked on the unrelated hard-fail; tests that specifically exercise
    // the missing-pattern path live in chanmod-state.test.ts.
    const api = createMockPluginAPI({
      config: { services_host_pattern: 'services.*', ...configOverrides },
      log,
    });
    return { api, log };
  }

  describe('numeric fields', () => {
    it('accepts valid positive numbers', () => {
      const { api, log } = makeApi({ enforce_delay_ms: 1000, takeover_window_ms: 60000 });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(1000);
      expect(config.takeover_window_ms).toBe(60000);
      expect(log).not.toHaveBeenCalled();
    });

    it('accepts zero as valid', () => {
      const { api, log } = makeApi({ takeover_response_delay_ms: 0 });
      const config = readConfig(api);
      expect(config.takeover_response_delay_ms).toBe(0);
      expect(log).not.toHaveBeenCalled();
    });

    it('rejects string values and falls back to default', () => {
      const { api, log } = makeApi({ takeover_window_ms: 'banana' });
      const config = readConfig(api);
      expect(config.takeover_window_ms).toBe(30_000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid takeover_window_ms'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"banana"'));
    });

    it('rejects negative numbers and falls back to default', () => {
      const { api, log } = makeApi({ chanserv_unban_retry_ms: -5000 });
      const config = readConfig(api);
      expect(config.chanserv_unban_retry_ms).toBe(2000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid chanserv_unban_retry_ms'));
    });

    it('rejects NaN and falls back to default', () => {
      const { api, log } = makeApi({ anope_recover_step_delay_ms: NaN });
      const config = readConfig(api);
      expect(config.anope_recover_step_delay_ms).toBe(200);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Invalid anope_recover_step_delay_ms'),
      );
    });

    it('rejects Infinity and falls back to default', () => {
      const { api, log } = makeApi({ enforce_delay_ms: Infinity });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(500);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid enforce_delay_ms'));
    });

    it('coerces numeric strings to numbers', () => {
      const { api, log } = makeApi({ enforce_delay_ms: '1500' });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(1500);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('enum fields', () => {
    it('accepts valid enum values', () => {
      const { api, log } = makeApi({
        revenge_action: 'kickban',
        punish_action: 'kickban',
        chanserv_services_type: 'anope',
      });
      const config = readConfig(api);
      expect(config.revenge_action).toBe('kickban');
      expect(config.punish_action).toBe('kickban');
      expect(config.chanserv_services_type).toBe('anope');
      expect(log).not.toHaveBeenCalled();
    });

    it('rejects invalid revenge_action and falls back to default', () => {
      const { api, log } = makeApi({ revenge_action: 'nuke' });
      const config = readConfig(api);
      expect(config.revenge_action).toBe('deop');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid revenge_action'));
    });

    it('rejects invalid punish_action and falls back to default', () => {
      const { api, log } = makeApi({ punish_action: 'destroy' });
      const config = readConfig(api);
      expect(config.punish_action).toBe('kick');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid punish_action'));
    });

    it('rejects invalid chanserv_services_type and falls back to default', () => {
      const { api, log } = makeApi({ chanserv_services_type: 'dalnet' });
      const config = readConfig(api);
      expect(config.chanserv_services_type).toBe('atheme');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid chanserv_services_type'));
    });

    it('rejects non-string enum values', () => {
      const { api, log } = makeApi({ revenge_action: 42 });
      const config = readConfig(api);
      expect(config.revenge_action).toBe('deop');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid revenge_action'));
    });
  });

  describe('threshold ordering', () => {
    it('accepts properly ordered thresholds', () => {
      const { api, log } = makeApi({
        takeover_level_1_threshold: 5,
        takeover_level_2_threshold: 10,
        takeover_level_3_threshold: 15,
      });
      const config = readConfig(api);
      expect(config.takeover_level_1_threshold).toBe(5);
      expect(config.takeover_level_2_threshold).toBe(10);
      expect(config.takeover_level_3_threshold).toBe(15);
      expect(log).not.toHaveBeenCalled();
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
      const { api, log: _log } = makeApi({
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

  describe('multiple invalid values', () => {
    it('logs a warning for each invalid field', () => {
      const { api, log } = makeApi({
        enforce_delay_ms: 'bad',
        revenge_action: 'invalid',
        takeover_window_ms: -1,
      });
      const config = readConfig(api);
      expect(config.enforce_delay_ms).toBe(500);
      expect(config.revenge_action).toBe('deop');
      expect(config.takeover_window_ms).toBe(30_000);
      expect(log).toHaveBeenCalledTimes(3);
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
