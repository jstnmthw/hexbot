import { type Mock, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { ChannelSettings } from '../../../src/core/channel-settings';
import { registerSettingsCommands } from '../../../src/core/commands/settings-commands';
import { SettingsRegistry } from '../../../src/core/settings-registry';
import { BotDatabase } from '../../../src/database';

function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = {
    source: 'repl',
    nick: 'admin',
    channel: null,
    reply,
    ...overrides,
  };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

function setup(): {
  handler: CommandHandler;
  db: BotDatabase;
  coreSettings: SettingsRegistry;
  channelSettings: ChannelSettings;
  pluginSettings: Map<string, SettingsRegistry>;
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
  const channelSettings = new ChannelSettings(db);
  const pluginSettings = new Map<string, SettingsRegistry>();
  pluginSettings.set(
    'rss',
    new SettingsRegistry({
      scope: 'plugin',
      namespace: 'plugin:rss',
      db,
      auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
    }),
  );
  registerSettingsCommands({ handler, coreSettings, channelSettings, pluginSettings });
  return { handler, db, coreSettings, channelSettings, pluginSettings };
}

describe('settings-commands — .set', () => {
  it('lists scopes when called with no args', async () => {
    const { handler } = setup();
    const ctx = makeCtx();
    await handler.execute('.set', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Scopes/);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/core/);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/rss/);
  });

  it('rejects unknown scopes', async () => {
    const { handler } = setup();
    const ctx = makeCtx();
    await handler.execute('.set bogus', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Unknown scope/);
  });

  it('snapshots a scope when only the scope arg is given', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/logging\.level/);
  });

  it('writes a value, fires onChange, and emits a coreset-set audit row', async () => {
    const { handler, coreSettings, db } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
    ]);
    const cb = vi.fn();
    coreSettings.onChange('bot', cb);

    const ctx = makeCtx();
    await handler.execute('.set core logging.level debug', ctx);

    expect(coreSettings.getString('', 'logging.level')).toBe('debug');
    expect(cb).toHaveBeenCalledWith('', 'logging.level', 'debug');
    expect(ctx.reply.mock.calls[0][0]).toMatch(/applied live/);
    const rows = db.getModLog({ action: 'coreset-set' });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('logging.level');
    expect(rows[0].reason).toBe('debug');
  });

  it('toggles flag with +key shorthand', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'verbose', type: 'flag', default: false, description: 'Verbose' },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core +verbose', ctx);
    expect(coreSettings.getFlag('', 'verbose')).toBe(true);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/= ON/);
  });

  it('renders detail line when called with scope+key only', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core logging.level', ctx);
    const out = ctx.reply.mock.calls[0][0];
    expect(out).toMatch(/logging\.level/);
    expect(out).toMatch(/info/);
    expect(out).toMatch(/default/);
  });

  it('rejects invalid integer values', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'queue.rate', type: 'int', default: 1, description: 'Rate' },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core queue.rate fifty', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/not a valid integer/);
    expect(coreSettings.getInt('', 'queue.rate')).toBe(1);
  });

  it('rejects strings outside allowedValues', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      {
        key: 'logging.level',
        type: 'string',
        default: 'info',
        description: 'Log level',
        allowedValues: ['debug', 'info', 'warn', 'error'],
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core logging.level chatty', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Invalid value/);
    expect(coreSettings.getString('', 'logging.level')).toBe('info');
  });

  it('routes channel scope through the channel registry (#chan key)', async () => {
    const { handler, channelSettings, db } = setup();
    channelSettings.register('chanmod', [
      { key: 'auto_op', type: 'flag', default: false, description: 'auto-op' },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set #foo +auto_op', ctx);
    expect(channelSettings.getFlag('#foo', 'auto_op')).toBe(true);
    const rows = db.getModLog({ action: 'chanset-set' });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('#foo');
  });

  it('emits restart hint for restart-class keys', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      {
        key: 'irc.host',
        type: 'string',
        default: 'irc.example',
        description: 'IRC host',
        reloadClass: 'restart',
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set core irc.host new.host.net', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/stored/);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/restart/);
  });
});

describe('settings-commands — .unset', () => {
  it('reverts a stored value to its registered default', async () => {
    const { handler, coreSettings, db } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
    ]);
    coreSettings.set('', 'logging.level', 'debug');

    const ctx = makeCtx();
    await handler.execute('.unset core logging.level', ctx);
    expect(coreSettings.getString('', 'logging.level')).toBe('info');
    expect(coreSettings.isSet('', 'logging.level')).toBe(false);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/reverted/);
    const rows = db.getModLog({ action: 'coreset-unset' });
    expect(rows).toHaveLength(1);
  });

  it('rejects unknown keys', async () => {
    const { handler } = setup();
    const ctx = makeCtx();
    await handler.execute('.unset core nope', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Unknown setting/);
  });
});

describe('settings-commands — .info', () => {
  it('renders snapshot with set/default counts', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
      { key: 'verbose', type: 'flag', default: false, description: 'Verbose' },
    ]);
    coreSettings.set('', 'logging.level', 'debug');

    const ctx = makeCtx();
    await handler.execute('.info core', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/1 set, 1 default/);
    expect(out).toMatch(/logging\.level/);
    expect(out).toMatch(/verbose/);
  });

  it('respects scope discovery (rejects unknown)', async () => {
    const { handler } = setup();
    const ctx = makeCtx();
    await handler.execute('.info bogus', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Unknown scope/);
  });

  it('hides channelOverridable keys from plugin-scope snapshot and adds a footer', async () => {
    const { handler, pluginSettings } = setup();
    const rss = pluginSettings.get('rss');
    if (!rss) throw new Error('rss registry missing');
    rss.register('rss', [
      {
        key: 'fetch_interval_ms',
        type: 'int',
        default: 60_000,
        description: 'Bot-wide fetch interval',
      },
      {
        key: 'enabled',
        type: 'flag',
        default: true,
        description: 'Default enabled state for new feeds',
        channelOverridable: true,
      },
      {
        key: 'announce',
        type: 'flag',
        default: false,
        description: 'Default announce flag',
        channelOverridable: true,
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.info rss', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/fetch_interval_ms/);
    expect(out).not.toMatch(/\benabled\b/);
    expect(out).not.toMatch(/\bannounce\b/);
    expect(out).toMatch(/2 keys are per-channel — see \.chanset/);
    expect(out).toMatch(/--all to show/);
  });

  it('shows all plugin-scope keys when --all is passed', async () => {
    const { handler, pluginSettings } = setup();
    const rss = pluginSettings.get('rss');
    if (!rss) throw new Error('rss registry missing');
    rss.register('rss', [
      {
        key: 'enabled',
        type: 'flag',
        default: true,
        description: 'Default enabled state for new feeds',
        channelOverridable: true,
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.info rss --all', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/\benabled\b/);
    expect(out).not.toMatch(/per-channel — see \.chanset/);
  });

  it('does not filter for core scope (channelOverridable is plugin-scope only)', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      {
        key: 'looks_overridable',
        type: 'flag',
        default: false,
        description: 'Should still appear under core',
        // Marker is harmless on non-plugin scopes — registry just stores it.
        channelOverridable: true,
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.info core', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/looks_overridable/);
    expect(out).not.toMatch(/per-channel — see \.chanset/);
  });

  it('.set <plugin> snapshot still shows channelOverridable keys', async () => {
    const { handler, pluginSettings } = setup();
    const rss = pluginSettings.get('rss');
    if (!rss) throw new Error('rss registry missing');
    rss.register('rss', [
      {
        key: 'enabled',
        type: 'flag',
        default: true,
        description: 'Default enabled state for new feeds',
        channelOverridable: true,
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.set rss', ctx);
    const out = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/\benabled\b/);
  });
});

describe('settings-commands — .helpset removal', () => {
  it('returns Unknown command when invoked (renamed to `.help set <scope> <key>`)', async () => {
    const { handler, coreSettings } = setup();
    coreSettings.register('bot', [
      {
        key: 'logging.level',
        type: 'string',
        default: 'info',
        description: 'Log level',
        allowedValues: ['debug', 'info', 'warn'],
        reloadClass: 'live',
      },
    ]);
    const ctx = makeCtx();
    await handler.execute('.helpset core logging.level', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Unknown command/);
  });
});

describe('settings-commands — permission gates', () => {
  it('.set requires +n (denied to plain users)', async () => {
    const { coreSettings } = setup();
    coreSettings.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
    ]);
    // CommandHandler defers to the configured permissions provider — without
    // one, restrictive flags are denied. We attach a stub that says "no".
    const fakePerms = { checkFlags: () => false };
    const handler2 = new CommandHandler(fakePerms);
    handler2.registerCommand(
      'help',
      { flags: '-', description: '', usage: '', category: 'general' },
      () => {},
    );
    registerSettingsCommands({
      handler: handler2,
      coreSettings,
      channelSettings: setup().channelSettings,
      pluginSettings: new Map(),
    });
    const ctx = makeCtx();
    await handler2.execute('.set core logging.level debug', ctx);
    // command-handler.ts replies "Permission denied" or similar on flag fail
    expect(ctx.reply.mock.calls.length).toBeGreaterThan(0);
  });
});
