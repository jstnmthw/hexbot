import { describe, expect, it, vi } from 'vitest';

import type { Bot } from '../../src/bot';
import { buildCoreSettingEntries } from '../../src/core/core-settings-defs';

interface MockBot {
  logger: { setLevel: ReturnType<typeof vi.fn> };
  db: {
    setModLogEnabled: ReturnType<typeof vi.fn>;
    setModLogRetentionDays: ReturnType<typeof vi.fn>;
  };
  messageQueue: { setRate: ReturnType<typeof vi.fn> };
  dispatcher: { setFloodConfig: ReturnType<typeof vi.fn> };
  memo: { setConfig: ReturnType<typeof vi.fn> };
  client: { changeNick: ReturnType<typeof vi.fn> };
  coreSettings: {
    getInt: ReturnType<typeof vi.fn>;
    getString: ReturnType<typeof vi.fn>;
    getFlag: ReturnType<typeof vi.fn>;
  };
  config: {
    queue: { rate: number; burst: number };
    quit_message: string;
    channel_rejoin_interval_ms: number;
    services: {
      services_host_pattern: string;
      identify_before_join: boolean;
      identify_before_join_timeout_ms: number;
    };
    dcc: {
      require_flags: string;
      max_sessions: number;
      idle_timeout_ms: number;
    };
  };
}

const mockBot = (): MockBot => ({
  logger: { setLevel: vi.fn() },
  db: { setModLogEnabled: vi.fn(), setModLogRetentionDays: vi.fn() },
  messageQueue: { setRate: vi.fn() },
  dispatcher: { setFloodConfig: vi.fn() },
  memo: { setConfig: vi.fn() },
  client: { changeNick: vi.fn() },
  coreSettings: {
    getInt: vi.fn().mockReturnValue(0),
    getString: vi.fn().mockReturnValue(''),
    getFlag: vi.fn().mockReturnValue(false),
  },
  config: {
    queue: { rate: 2, burst: 4 },
    quit_message: '',
    channel_rejoin_interval_ms: 30_000,
    services: {
      services_host_pattern: '',
      identify_before_join: false,
      identify_before_join_timeout_ms: 0,
    },
    dcc: { require_flags: 'm', max_sessions: 5, idle_timeout_ms: 0 },
  },
});

const entriesFor = (bot: MockBot) => buildCoreSettingEntries(bot as unknown as Bot);

const fire = (bot: MockBot, key: string, value: unknown): void => {
  const entry = entriesFor(bot).find((e) => e.def.key === key);
  expect(entry).toBeDefined();
  entry!.onChange?.(value);
};

describe('buildCoreSettingEntries', () => {
  it('registers a def for every expected core key', () => {
    const entries = entriesFor(mockBot());
    const keys = entries.map((e) => e.def.key);
    expect(keys).toContain('logging.level');
    expect(keys).toContain('queue.rate');
    expect(keys).toContain('flood.pub.count');
    expect(keys).toContain('irc.nick');
    expect(keys).toContain('command_prefix');
  });

  it('logging.level routes to logger.setLevel', () => {
    const bot = mockBot();
    fire(bot, 'logging.level', 'debug');
    expect(bot.logger.setLevel).toHaveBeenCalledWith('debug');
  });

  it('logging.mod_actions routes to db.setModLogEnabled', () => {
    const bot = mockBot();
    fire(bot, 'logging.mod_actions', false);
    expect(bot.db.setModLogEnabled).toHaveBeenCalledWith(false);
  });

  it('logging.mod_log_retention_days routes to db.setModLogRetentionDays', () => {
    const bot = mockBot();
    fire(bot, 'logging.mod_log_retention_days', 7);
    expect(bot.db.setModLogRetentionDays).toHaveBeenCalledWith(7);
  });

  it('queue.rate fan-out rebuilds rate+burst from the registry', () => {
    const bot = mockBot();
    bot.coreSettings.getInt = vi.fn().mockImplementation((_owner: string, key: string) => {
      if (key === 'queue.rate') return 5;
      if (key === 'queue.burst') return 10;
      return 0;
    });
    fire(bot, 'queue.rate', 5);
    expect(bot.messageQueue.setRate).toHaveBeenCalledWith(5, 10);
  });

  it('flood.* fan-out builds a struct with both pub and msg keys', () => {
    const bot = mockBot();
    bot.coreSettings.getInt = vi.fn().mockImplementation((_owner: string, key: string) => {
      if (key === 'flood.pub.count') return 3;
      if (key === 'flood.pub.window') return 5;
      if (key === 'flood.msg.count') return 2;
      if (key === 'flood.msg.window') return 10;
      return 0;
    });
    fire(bot, 'flood.pub.count', 3);
    expect(bot.dispatcher.setFloodConfig).toHaveBeenCalledWith({
      pub: { count: 3, window: 5 },
      msg: { count: 2, window: 10 },
    });
  });

  it('flood.* fan-out omits disabled sides', () => {
    const bot = mockBot();
    bot.coreSettings.getInt = vi.fn().mockReturnValue(0);
    fire(bot, 'flood.msg.window', 0);
    expect(bot.dispatcher.setFloodConfig).toHaveBeenCalledWith({});
  });

  it('memo.* fan-out rebuilds the memo config struct', () => {
    const bot = mockBot();
    bot.coreSettings.getFlag = vi.fn().mockReturnValue(true);
    bot.coreSettings.getString = vi.fn().mockReturnValue('MemoServ');
    bot.coreSettings.getInt = vi.fn().mockReturnValue(120);
    fire(bot, 'memo.memoserv_relay', true);
    expect(bot.memo.setConfig).toHaveBeenCalledWith({
      memoserv_relay: true,
      memoserv_nick: 'MemoServ',
      delivery_cooldown_seconds: 120,
    });
  });

  it('memo.memoserv_nick falls back to "MemoServ" on empty', () => {
    const bot = mockBot();
    bot.coreSettings.getString = vi.fn().mockReturnValue('');
    fire(bot, 'memo.memoserv_nick', '');
    expect(bot.memo.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ memoserv_nick: 'MemoServ' }),
    );
  });

  it('quit_message and channel_rejoin_interval_ms mutate live config', () => {
    const bot = mockBot();
    fire(bot, 'quit_message', 'bye');
    expect(bot.config.quit_message).toBe('bye');
    fire(bot, 'channel_rejoin_interval_ms', 60_000);
    expect(bot.config.channel_rejoin_interval_ms).toBe(60_000);
  });

  it('services.* keys mutate live services config', () => {
    const bot = mockBot();
    fire(bot, 'services.identify_before_join', true);
    expect(bot.config.services.identify_before_join).toBe(true);
    fire(bot, 'services.identify_before_join_timeout_ms', 5000);
    expect(bot.config.services.identify_before_join_timeout_ms).toBe(5000);
    fire(bot, 'services.services_host_pattern', 'services.example.org');
    expect(bot.config.services.services_host_pattern).toBe('services.example.org');
  });

  it('dcc.* keys mutate live dcc config when present', () => {
    const bot = mockBot();
    fire(bot, 'dcc.require_flags', 'n');
    expect(bot.config.dcc.require_flags).toBe('n');
    fire(bot, 'dcc.max_sessions', 10);
    expect(bot.config.dcc.max_sessions).toBe(10);
    fire(bot, 'dcc.idle_timeout_ms', 1000);
    expect(bot.config.dcc.idle_timeout_ms).toBe(1000);
  });

  it('irc.nick onReload calls client.changeNick when the value is set', () => {
    const bot = mockBot();
    const entries = entriesFor(bot);
    const ircNick = entries.find((e) => e.def.key === 'irc.nick');
    expect(ircNick?.def.reloadClass).toBe('reload');
    ircNick!.def.onReload?.('NewNick');
    expect(bot.client.changeNick).toHaveBeenCalledWith('NewNick');
  });

  it('irc.nick onReload ignores empty string', () => {
    const bot = mockBot();
    const ircNick = entriesFor(bot).find((e) => e.def.key === 'irc.nick');
    ircNick!.def.onReload?.('');
    expect(bot.client.changeNick).not.toHaveBeenCalled();
  });

  it('restart-class keys have no onChange', () => {
    const entries = entriesFor(mockBot());
    const restartKeys = ['irc.host', 'irc.port', 'services.sasl', 'command_prefix'];
    for (const k of restartKeys) {
      const entry = entries.find((e) => e.def.key === k);
      expect(entry?.def.reloadClass).toBe('restart');
      expect(entry?.onChange).toBeUndefined();
    }
  });

  it('rejects mistyped values silently (type-guards return)', () => {
    const bot = mockBot();
    fire(bot, 'logging.level', 42);
    expect(bot.logger.setLevel).not.toHaveBeenCalled();
    fire(bot, 'logging.mod_actions', 'yes');
    expect(bot.db.setModLogEnabled).not.toHaveBeenCalled();
    fire(bot, 'logging.mod_log_retention_days', '7');
    expect(bot.db.setModLogRetentionDays).not.toHaveBeenCalled();
  });
});
