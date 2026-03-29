import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { ChannelSettings } from '../../../src/core/channel-settings';
import { registerChannelCommands } from '../../../src/core/commands/channel-commands';
import { BotDatabase } from '../../../src/database';

function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('channel-commands', () => {
  let handler: CommandHandler;
  let channelSettings: ChannelSettings;

  beforeEach(() => {
    const db = new BotDatabase(':memory:');
    db.open();
    handler = new CommandHandler();
    channelSettings = new ChannelSettings(db);
    registerChannelCommands(handler, channelSettings);
  });

  describe('.chanset', () => {
    it('shows usage when no channel given', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('shows usage when argument is not a channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset notachannel', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('reports no settings when no plugins have registered any (covers snapshot.length === 0)', async () => {
      const ctx = makeCtx();
      // No settings registered — getChannelSnapshot returns []
      await handler.execute('.chanset #test', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('No channel settings registered');
    });

    it('lists settings for channel when settings are registered', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('#test');
    });

    it('lists settings showing ON for true flag, (not set) for empty string, and * for non-defaults', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A flag' },
        { key: 'mystr', type: 'string', default: '', description: 'A string' },
      ]);
      // Set flag to true (covers value ? 'ON' branch) and string to non-default (covers ' *' marker)
      channelSettings.set('#test', 'myflag', true);
      channelSettings.set('#test', 'mystr', 'hello');

      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      const output = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('ON');
      expect(output).toContain('hello');
      expect(output).toContain('*'); // non-default marker
    });

    it('shows (not set) for empty string settings at default value', async () => {
      channelSettings.register('myplugin', [
        { key: 'mystr', type: 'string', default: '', description: 'A string' },
      ]);
      // default is '' — String('') is falsy, so display = '(not set)'
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      const output = ctx.reply.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('(not set)');
    });

    it('shows unknown setting error', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test unknownkey', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Unknown setting');
    });

    it('sets flag with + prefix', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test +myflag', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('ON');
    });

    it('shows error when using +prefix on non-flag setting', async () => {
      channelSettings.register('myplugin', [
        { key: 'mystr', type: 'string', default: '', description: 'A string setting' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test +mystr', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('mystr value');
    });

    it('reverts with - prefix', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test -myflag', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('default');
    });

    it('shows usage when key is just a bare prefix character', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('shows current value when no value given', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test myflag', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('myflag');
    });

    it('shows error when setting flag with value instead of +/- prefix', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test myflag true', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('+myflag');
    });

    it('sets int setting', async () => {
      channelSettings.register('myplugin', [
        { key: 'myint', type: 'int', default: 0, description: 'An int setting' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test myint 42', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('42');
    });

    it('shows error for invalid int value', async () => {
      channelSettings.register('myplugin', [
        { key: 'myint', type: 'int', default: 0, description: 'An int setting' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test myint notanumber', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('not a valid integer');
    });

    it('sets string setting', async () => {
      channelSettings.register('myplugin', [
        { key: 'mystr', type: 'string', default: '', description: 'A string setting' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test mystr hello world', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('hello world');
    });
  });

  describe('.chaninfo', () => {
    it('shows usage when no channel given', async () => {
      const ctx = makeCtx();
      await handler.execute('.chaninfo', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('reports no settings when no plugins registered (covers snapshot.length === 0)', async () => {
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('No settings registered');
    });

    it('lists all settings with plugin grouping', async () => {
      channelSettings.register('myplugin', [
        { key: 'myflag', type: 'flag', default: false, description: 'A test flag' },
        { key: 'mystr', type: 'string', default: '', description: 'A string' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('#test');
    });
  });
});
