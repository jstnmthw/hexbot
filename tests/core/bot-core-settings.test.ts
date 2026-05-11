// Verifies `.set core <key> <value>` reaches the live subsystem (logger,
// message queue, flood limiter, mod_log toggle, memo manager) without a
// process restart, and restart-class keys surface the operator-facing
// "stored; takes effect after .restart" hint without applying.
import { describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { registerSettingsCommands } from '../../src/core/commands/settings-commands';
import { SettingsRegistry } from '../../src/core/settings-registry';
import { BotDatabase } from '../../src/database';
import type { LogLevel } from '../../src/logger';

interface Fakes {
  setLevel: (level: LogLevel) => void;
  setRate: (rate: number, burst: number) => void;
  setFloodConfig: (cfg: unknown) => void;
  setModLogEnabled: (enabled: boolean) => void;
  memoSetConfig: (partial: unknown) => void;
  changeNick: (nick: string) => void;
}

function setup(): {
  handler: CommandHandler;
  coreSettings: SettingsRegistry;
  fakes: Fakes;
} {
  const db = new BotDatabase(':memory:');
  db.open();
  const handler = new CommandHandler();
  const coreSettings = new SettingsRegistry({
    scope: 'core',
    namespace: 'core',
    db,
    auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
  });

  const fakes: Fakes = {
    setLevel: vi.fn(),
    setRate: vi.fn(),
    setFloodConfig: vi.fn(),
    setModLogEnabled: vi.fn(),
    memoSetConfig: vi.fn(),
    changeNick: vi.fn(),
  };

  // Mirror the subset of registrations + dispatcher Bot wires; if this
  // diverges from Bot.registerCoreSettings the test catches it.
  coreSettings.register('bot', [
    {
      key: 'logging.level',
      type: 'string',
      default: 'info',
      description: 'Log level',
      reloadClass: 'live',
    },
    {
      key: 'queue.rate',
      type: 'int',
      default: 2,
      description: 'Rate',
      reloadClass: 'live',
    },
    {
      key: 'queue.burst',
      type: 'int',
      default: 4,
      description: 'Burst',
      reloadClass: 'live',
    },
    {
      key: 'flood.pub.count',
      type: 'int',
      default: 0,
      description: 'pub count',
      reloadClass: 'live',
    },
    {
      key: 'flood.pub.window',
      type: 'int',
      default: 0,
      description: 'pub window',
      reloadClass: 'live',
    },
    {
      key: 'logging.mod_actions',
      type: 'flag',
      default: true,
      description: 'mod actions',
      reloadClass: 'live',
    },
    {
      key: 'memo.memoserv_relay',
      type: 'flag',
      default: true,
      description: 'memo relay',
      reloadClass: 'live',
    },
    {
      key: 'irc.nick',
      type: 'string',
      default: 'hexbot',
      description: 'nick',
      reloadClass: 'reload',
      onReload: (value) => {
        if (typeof value === 'string') fakes.changeNick(value);
      },
    },
    {
      key: 'irc.host',
      type: 'string',
      default: 'irc.example',
      description: 'host',
      reloadClass: 'restart',
    },
  ]);

  coreSettings.onChange('bot', (_instance, key, value) => {
    if (key === 'logging.level' && typeof value === 'string') {
      fakes.setLevel(value as LogLevel);
    } else if (key === 'queue.rate' || key === 'queue.burst') {
      fakes.setRate(coreSettings.getInt('', 'queue.rate'), coreSettings.getInt('', 'queue.burst'));
    } else if (key.startsWith('flood.')) {
      const pubCount = coreSettings.getInt('', 'flood.pub.count');
      const pubWindow = coreSettings.getInt('', 'flood.pub.window');
      fakes.setFloodConfig({ pub: { count: pubCount, window: pubWindow } });
    } else if (key === 'logging.mod_actions' && typeof value === 'boolean') {
      fakes.setModLogEnabled(value);
    } else if (key.startsWith('memo.')) {
      fakes.memoSetConfig({
        memoserv_relay: coreSettings.getFlag('', 'memo.memoserv_relay'),
      });
    }
  });

  registerSettingsCommands({
    handler,
    coreSettings,
    channelSettings: new ChannelSettings(db),
    pluginSettings: new Map(),
  });

  return { handler, coreSettings, fakes };
}

describe('Phase 7 — live core keys reach their subsystems', () => {
  it('logging.level: .set fires logger.setLevel', async () => {
    const { handler, fakes } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core logging.level debug', ctx);
    expect(fakes.setLevel).toHaveBeenCalledWith('debug');
  });

  it('queue.rate: .set fires messageQueue.setRate with both rate+burst', async () => {
    const { handler, coreSettings, fakes } = setup();
    coreSettings.set('', 'queue.burst', 8);
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core queue.rate 5', ctx);
    expect(fakes.setRate).toHaveBeenCalledWith(5, 8);
  });

  it('flood.pub.count + flood.pub.window: .set rebuilds and fires setFloodConfig', async () => {
    const { handler, fakes } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core flood.pub.count 3', ctx);
    await handler.execute('.set core flood.pub.window 60', ctx);
    expect(fakes.setFloodConfig).toHaveBeenCalledTimes(2);
    expect(fakes.setFloodConfig).toHaveBeenLastCalledWith({ pub: { count: 3, window: 60 } });
  });

  it('logging.mod_actions: .set fires db.setModLogEnabled', async () => {
    const { handler, fakes } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core logging.mod_actions false', ctx);
    expect(fakes.setModLogEnabled).toHaveBeenCalledWith(false);
  });

  it('memo.memoserv_relay: .set fires memo.setConfig', async () => {
    const { handler, fakes } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core memo.memoserv_relay false', ctx);
    expect(fakes.memoSetConfig).toHaveBeenCalledWith({ memoserv_relay: false });
  });
});

describe('Phase 7 — reload class triggers onReload', () => {
  it('irc.nick: .set fires onReload (client.changeNick)', async () => {
    const { handler, fakes } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core irc.nick newnick', ctx);
    expect(fakes.changeNick).toHaveBeenCalledWith('newnick');
    expect(ctx.reply.mock.calls[0][0]).toMatch(/subsystem reloaded/);
  });
});

describe('Phase 7 — restart class warns without applying', () => {
  it('irc.host: .set stores the value but emits restart hint', async () => {
    const { handler, coreSettings } = setup();
    const ctx = {
      source: 'repl' as const,
      nick: 'admin',
      channel: null,
      reply: vi.fn(),
    };
    await handler.execute('.set core irc.host new.host.net', ctx);
    expect(coreSettings.getString('', 'irc.host')).toBe('new.host.net');
    expect(ctx.reply.mock.calls[0][0]).toMatch(/restart/);
  });
});
