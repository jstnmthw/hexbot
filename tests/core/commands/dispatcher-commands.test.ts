import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { registerDispatcherCommands } from '../../../src/core/commands/dispatcher-commands';
import { EventDispatcher } from '../../../src/dispatcher';

/** Helper: create a minimal CommandContext with a typed reply mock. */
function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('dispatcher-commands', () => {
  let handler: CommandHandler;
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    handler = new CommandHandler();
    dispatcher = new EventDispatcher();
    registerDispatcherCommands({ handler, dispatcher });
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

      const output = ctx.reply.mock.calls[0][0];
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

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('seen');
      expect(output).not.toContain('test-plugin');
    });

    it('should report no binds when empty', async () => {
      const ctx = makeCtx();
      await handler.execute('.binds', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('No active binds');
    });

    it('should group binds by plugin with headers', async () => {
      dispatcher.bind('pub', '-', '!a', vi.fn(), 'test-plugin');
      dispatcher.bind('join', '-', '*', vi.fn(), 'test-plugin');
      dispatcher.bind('pub', '-', '!b', vi.fn(), 'seen');

      const ctx = makeCtx();
      await handler.execute('.binds', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('[test-plugin] 2 binds');
      expect(output).toContain('[seen] 1 bind');
    });

    it('should include plugin name in message when filtered and no binds found', async () => {
      const ctx = makeCtx();
      await handler.execute('.binds nonexistent-plugin', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('nonexistent-plugin');
      expect(output).toContain('No active binds');
    });
  });
});
