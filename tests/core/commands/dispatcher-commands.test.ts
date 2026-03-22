import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler.js';
import { registerDispatcherCommands } from '../../../src/core/commands/dispatcher-commands.js';
import { EventDispatcher } from '../../../src/dispatcher.js';

/** Helper: create a minimal CommandContext. */
function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    source: 'repl',
    nick: 'admin',
    channel: null,
    reply: vi.fn(),
    ...overrides,
  };
}

describe('dispatcher-commands', () => {
  let handler: CommandHandler;
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    handler = new CommandHandler();
    dispatcher = new EventDispatcher();
    registerDispatcherCommands(handler, dispatcher);
  });

  afterEach(() => {
    dispatcher.unbindAll('test-plugin');
    dispatcher.unbindAll('seen');
  });

  describe('.binds', () => {
    it('should return the bind list', async () => {
      dispatcher.bind('pub', '-', '!hello', vi.fn(), 'test-plugin');
      dispatcher.bind('pubm', '-', '*bye*', vi.fn(), 'test-plugin');

      const ctx = makeCtx();
      await handler.execute('.binds', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('All binds');
      expect(output).toContain('!hello');
      expect(output).toContain('*bye*');
      expect(output).toContain('test-plugin');
    });

    it('should filter by plugin', async () => {
      dispatcher.bind('pub', '-', '!a', vi.fn(), 'test-plugin');
      dispatcher.bind('pub', '-', '!b', vi.fn(), 'seen');

      const ctx = makeCtx();
      await handler.execute('.binds seen', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('seen');
      expect(output).not.toContain('test-plugin');
    });

    it('should report no binds when empty', async () => {
      const ctx = makeCtx();
      await handler.execute('.binds', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('No active binds');
    });
  });
});
