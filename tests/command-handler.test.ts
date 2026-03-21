import { describe, it, expect, vi } from 'vitest';
import { CommandHandler, type CommandContext } from '../src/command-handler.js';

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

describe('CommandHandler', () => {
  // -------------------------------------------------------------------------
  // .help
  // -------------------------------------------------------------------------

  describe('.help', () => {
    it('should list available commands', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.help', ctx);

      expect(ctx.reply).toHaveBeenCalledOnce();
      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Available commands');
      expect(output).toContain('.help');
    });

    it('should show help for a specific command', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.help help', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('.help');
      expect(output).toContain('List commands');
    });

    it('should report unknown command in help', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.help nosuchcommand', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Unknown command');
    });
  });

  // -------------------------------------------------------------------------
  // registerCommand
  // -------------------------------------------------------------------------

  describe('registerCommand', () => {
    it('should register and execute a custom command', async () => {
      const handler = new CommandHandler();
      const handlerFn = vi.fn();
      handler.registerCommand('test', {
        flags: '-',
        description: 'Test command',
        usage: '.test',
        category: 'testing',
      }, handlerFn);

      const ctx = makeCtx();
      await handler.execute('.test some args', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
      expect(handlerFn).toHaveBeenCalledWith('some args', ctx);
    });

    it('should appear in getCommands()', () => {
      const handler = new CommandHandler();
      handler.registerCommand('foo', {
        flags: '-',
        description: 'Foo',
        usage: '.foo',
        category: 'test',
      }, vi.fn());

      const commands = handler.getCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain('help');
      expect(names).toContain('foo');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown command
  // -------------------------------------------------------------------------

  describe('unknown command', () => {
    it('should return helpful error for unknown commands', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.nonexistent', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Unknown command');
      expect(output).toContain('.help');
    });
  });

  // -------------------------------------------------------------------------
  // Empty / non-command input
  // -------------------------------------------------------------------------

  describe('empty / non-command input', () => {
    it('should handle empty input gracefully', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should handle whitespace-only input gracefully', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('   ', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('should ignore input without command prefix', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('hello world', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should catch and report handler errors', async () => {
      const handler = new CommandHandler();
      handler.registerCommand('broken', {
        flags: '-',
        description: 'Broken command',
        usage: '.broken',
        category: 'test',
      }, () => {
        throw new Error('something went wrong');
      });

      const ctx = makeCtx();
      await handler.execute('.broken', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Error');
      expect(output).toContain('something went wrong');
    });
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  describe('case insensitivity', () => {
    it('should match commands case-insensitively', async () => {
      const handler = new CommandHandler();
      const handlerFn = vi.fn();
      handler.registerCommand('test', {
        flags: '-',
        description: 'Test',
        usage: '.test',
        category: 'test',
      }, handlerFn);

      const ctx = makeCtx();
      await handler.execute('.TEST', ctx);
      expect(handlerFn).toHaveBeenCalledOnce();
    });
  });
});
