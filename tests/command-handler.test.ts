import { type Mock, describe, expect, it, vi } from 'vitest';

import {
  type CommandContext,
  CommandHandler,
  type CommandPermissionsProvider,
} from '../src/command-handler';
import { HelpRegistry } from '../src/core/help-registry';

/** Helper: create a minimal CommandContext with a typed reply mock. */
function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
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
      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Available commands');
      expect(output).toContain('.help');
    });

    it('should group multiple commands in the same category', async () => {
      const handler = new CommandHandler();
      handler.registerCommand(
        'foo',
        { flags: '-', description: 'Foo', usage: '.foo', category: 'general' },
        vi.fn(),
      );
      handler.registerCommand(
        'bar',
        { flags: '-', description: 'Bar', usage: '.bar', category: 'general' },
        vi.fn(),
      );
      const ctx = makeCtx();
      await handler.execute('.help', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('.foo');
      expect(output).toContain('.bar');
    });

    it('should show help for a specific command', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.help help', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('.help');
      expect(output).toContain('List commands');
    });

    it('should report unknown command in help', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.help nosuchcommand', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('No help for "nosuchcommand"');
    });
  });

  // -------------------------------------------------------------------------
  // registerCommand
  // -------------------------------------------------------------------------

  describe('registerCommand', () => {
    it('should register and execute a custom command', async () => {
      const handler = new CommandHandler();
      const handlerFn = vi.fn();
      handler.registerCommand(
        'test',
        {
          flags: '-',
          description: 'Test command',
          usage: '.test',
          category: 'testing',
        },
        handlerFn,
      );

      const ctx = makeCtx();
      await handler.execute('.test some args', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
      expect(handlerFn).toHaveBeenCalledWith('some args', ctx);
    });

    it('should appear in getCommands()', () => {
      const handler = new CommandHandler();
      handler.registerCommand(
        'foo',
        {
          flags: '-',
          description: 'Foo',
          usage: '.foo',
          category: 'test',
        },
        vi.fn(),
      );

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

      const output = ctx.reply.mock.calls[0][0];
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

    it('should ignore a bare dot with no command name', async () => {
      const handler = new CommandHandler();
      const ctx = makeCtx();
      await handler.execute('.', ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should catch and report handler errors', async () => {
      const handler = new CommandHandler();
      handler.registerCommand(
        'broken',
        {
          flags: '-',
          description: 'Broken command',
          usage: '.broken',
          category: 'test',
        },
        () => {
          throw new Error('something went wrong');
        },
      );

      const ctx = makeCtx();
      await handler.execute('.broken', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Error');
      expect(output).toContain('something went wrong');
    });

    it('should handle non-Error thrown values', async () => {
      const handler = new CommandHandler();
      handler.registerCommand(
        'throwstring',
        { flags: '-', description: 'Throws a string', usage: '.throwstring', category: 'test' },
        () => {
          throw 'bare string error';
        },
      );

      const ctx = makeCtx();
      await handler.execute('.throwstring', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Error: bare string error');
    });
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  describe('case insensitivity', () => {
    it('should match commands case-insensitively', async () => {
      const handler = new CommandHandler();
      const handlerFn = vi.fn();
      handler.registerCommand(
        'test',
        {
          flags: '-',
          description: 'Test',
          usage: '.test',
          category: 'test',
        },
        handlerFn,
      );

      const ctx = makeCtx();
      await handler.execute('.TEST', ctx);
      expect(handlerFn).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Permission flag enforcement
  // -------------------------------------------------------------------------

  describe('flag enforcement', () => {
    function makePermissions(allows: boolean): CommandPermissionsProvider {
      return { checkFlags: vi.fn().mockReturnValue(allows) };
    }

    it('should block IRC user without required flags', async () => {
      const perms = makePermissions(false);
      const handler = new CommandHandler(perms);
      const handlerFn = vi.fn();
      handler.registerCommand(
        'admin',
        {
          flags: '+n',
          description: 'Admin only',
          usage: '.admin',
          category: 'test',
        },
        handlerFn,
      );

      const ctx = makeCtx({
        source: 'irc',
        nick: 'stranger',
        ident: 'user',
        hostname: 'evil.host',
      });
      await handler.execute('.admin', ctx);

      expect(handlerFn).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Permission denied.');
    });

    it('should allow IRC user with required flags', async () => {
      const perms = makePermissions(true);
      const handler = new CommandHandler(perms);
      const handlerFn = vi.fn();
      handler.registerCommand(
        'admin',
        {
          flags: '+n',
          description: 'Admin only',
          usage: '.admin',
          category: 'test',
        },
        handlerFn,
      );

      const ctx = makeCtx({
        source: 'irc',
        nick: 'owner',
        ident: 'admin',
        hostname: 'trusted.host',
      });
      await handler.execute('.admin', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
    });

    it('should skip flag check for REPL source', async () => {
      const perms = makePermissions(false);
      const handler = new CommandHandler(perms);
      const handlerFn = vi.fn();
      handler.registerCommand(
        'admin',
        {
          flags: '+n',
          description: 'Admin only',
          usage: '.admin',
          category: 'test',
        },
        handlerFn,
      );

      const ctx = makeCtx({ source: 'repl' });
      await handler.execute('.admin', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
    });

    it('should deny IRC user when no permissions provider is configured', async () => {
      const handler = new CommandHandler(); // no permissions provider
      const handlerFn = vi.fn();
      handler.registerCommand(
        'admin',
        { flags: '+n', description: 'Admin only', usage: '.admin', category: 'test' },
        handlerFn,
      );

      const ctx = makeCtx({ source: 'irc', nick: 'anyone', ident: 'u', hostname: 'h' });
      await handler.execute('.admin', ctx);

      expect(handlerFn).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Permission denied.');
    });

    it('should use empty string for missing ident and hostname during permission check', async () => {
      const perms: CommandPermissionsProvider = { checkFlags: vi.fn().mockReturnValue(true) };
      const handler = new CommandHandler(perms);
      const handlerFn = vi.fn();
      handler.registerCommand(
        'admin',
        { flags: '+n', description: 'Admin only', usage: '.admin', category: 'test' },
        handlerFn,
      );

      // No ident or hostname — should default to ''
      const ctx = makeCtx({ source: 'irc', nick: 'someone' });
      await handler.execute('.admin', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
      const passedCtx = (perms.checkFlags as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(passedCtx.ident).toBe('');
      expect(passedCtx.hostname).toBe('');
    });

    it('should allow anyone for flags "-" from IRC', async () => {
      const perms = makePermissions(false);
      const handler = new CommandHandler(perms);
      const handlerFn = vi.fn();
      handler.registerCommand(
        'public',
        {
          flags: '-',
          description: 'Public',
          usage: '.public',
          category: 'test',
        },
        handlerFn,
      );

      const ctx = makeCtx({ source: 'irc' });
      await handler.execute('.public', ctx);

      expect(handlerFn).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Configurable command prefix
  // -------------------------------------------------------------------------

  describe('configurable command prefix', () => {
    it('parses commands under a custom single-char prefix', async () => {
      const handler = new CommandHandler(null, '!');
      const fn = vi.fn();
      handler.registerCommand(
        'ping',
        { flags: '-', description: 'Ping', usage: '!ping', category: 'test' },
        fn,
      );
      const ctx = makeCtx();
      await handler.execute('!ping', ctx);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('ignores messages under the default `.` prefix when configured for `!`', async () => {
      const handler = new CommandHandler(null, '!');
      const fn = vi.fn();
      handler.registerCommand(
        'ping',
        { flags: '-', description: 'Ping', usage: '!ping', category: 'test' },
        fn,
      );
      const ctx = makeCtx();
      await handler.execute('.ping', ctx);
      expect(fn).not.toHaveBeenCalled();
    });

    it('accepts multi-character prefixes', async () => {
      const handler = new CommandHandler(null, '::');
      const fn = vi.fn();
      handler.registerCommand(
        'ping',
        { flags: '-', description: 'Ping', usage: '::ping', category: 'test' },
        fn,
      );
      const ctx = makeCtx();
      await handler.execute('::ping', ctx);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('echoes the custom prefix in unknown-command errors and help text', async () => {
      const handler = new CommandHandler(null, '~');
      const ctx = makeCtx();
      await handler.execute('~bogus', ctx);
      const unknownMsg = ctx.reply.mock.calls[0][0];
      expect(unknownMsg).toContain('~bogus');
      expect(unknownMsg).toContain('~help');

      ctx.reply.mockClear();
      await handler.execute('~help', ctx);
      const helpMsg = ctx.reply.mock.calls[0][0];
      expect(helpMsg).toContain('~help');
    });

    it('falls back to the default `.` when no prefix is supplied', () => {
      const handler = new CommandHandler();
      expect(handler.getPrefix()).toBe('.');
    });

    it('falls back to the default `.` when an empty string is supplied', () => {
      const handler = new CommandHandler(null, '');
      expect(handler.getPrefix()).toBe('.');
    });
  });

  // -------------------------------------------------------------------------
  // HelpRegistry mirroring
  // -------------------------------------------------------------------------

  describe('helpRegistry mirroring', () => {
    it('mirrors built-in .help into the shared corpus under the core bucket', () => {
      const registry = new HelpRegistry();
      new CommandHandler(null, '.', registry);

      const entry = registry.get('.help');
      expect(entry).toBeDefined();
      expect(entry?.pluginId).toBe('core');
      expect(entry?.command).toBe('.help');
      expect(entry?.usage).toBe('.help [command]');
      expect(entry?.category).toBe('general');
    });

    it('mirrors every registerCommand call into the help registry', () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '.', registry);
      handler.registerCommand(
        'kick',
        { flags: 'o', description: 'Kick a user', usage: '.kick <nick>', category: 'moderation' },
        vi.fn(),
      );

      const entry = registry.get('.kick');
      expect(entry).toMatchObject({
        command: '.kick',
        flags: 'o',
        description: 'Kick a user',
        category: 'moderation',
        pluginId: 'core',
      });
    });

    it('uses the configured prefix when mirroring command names', () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '!', registry);
      handler.registerCommand(
        'ping',
        { flags: '-', description: 'Ping', usage: '!ping', category: 'fun' },
        vi.fn(),
      );

      expect(registry.get('!ping')).toBeDefined();
      expect(registry.get('ping')?.command).toBe('!ping');
    });

    it('auto-instantiates a private registry when none is supplied', () => {
      // Bot wires the shared instance in production; standalone constructors
      // get their own so registerCommand always has a corpus to mirror into.
      const handler = new CommandHandler();
      handler.registerCommand(
        'noop',
        { flags: '-', description: 'Noop', usage: '.noop', category: 'test' },
        vi.fn(),
      );
      // The auto-registry is private — reach for it via the .help dispatch
      // which renders from it directly.
      expect(handler.getCommands().some((c) => c.name === 'noop')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // .help via shared renderer
  // -------------------------------------------------------------------------

  describe('.help via shared renderer', () => {
    it('routes .help <plugin-cmd> through the shared corpus to render the plugin entry', async () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '.', registry);
      // Plugin registers a dot-prefix entry — .help only surfaces its
      // own prefix's corpus, so an admin-side plugin command is reached
      // via `.foo` rather than `!foo`.
      registry.register('rss', [
        {
          command: '.rss',
          flags: '-',
          usage: '.rss <feed>',
          description: 'Subscribe to an RSS feed',
          category: 'feeds',
        },
      ]);
      const ctx = makeCtx();
      await handler.execute('.help rss', ctx);

      const out = ctx.reply.mock.calls[0][0];
      expect(out).toContain('.rss');
      expect(out).toContain('Subscribe to an RSS feed');
    });

    it('does not surface bang-prefix plugin entries via .help (corpus isolation)', async () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '.', registry);
      registry.register('chanmod', [
        {
          command: '!ban',
          flags: 'o',
          usage: '!ban <nick|mask>',
          description: 'Channel ban',
          category: 'moderation',
        },
      ]);
      const ctx = makeCtx();
      await handler.execute('.help ban', ctx);

      const out = ctx.reply.mock.calls[0][0];
      expect(out).toContain('No help for "ban"');
    });

    it('routes .help set <scope> through the scope renderer (lists keys)', async () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '.', registry);
      registry.register('bot', [
        {
          command: '.set core',
          flags: 'n',
          usage: '.set core <key> [value]',
          description: 'Bot-wide singletons',
          category: 'set:core',
        },
        {
          command: '.set core logging.level',
          flags: 'n',
          usage: '.set core logging.level <string>',
          description: 'Minimum log level',
          category: 'set:core',
        },
      ]);

      const ctx = makeCtx();
      await handler.execute('.help set core', ctx);

      const out = ctx.reply.mock.calls[0][0];
      expect(out).toContain('core');
      expect(out).toContain('logging.level');
      expect(out).toContain('Type .help set core <key> for detail.');
    });

    it('routes .help set <scope> <key> through the per-entry detail render', async () => {
      const registry = new HelpRegistry();
      const handler = new CommandHandler(null, '.', registry);
      registry.register('bot', [
        {
          command: '.set core logging.level',
          flags: 'n',
          usage: '.set core logging.level <string>',
          description: 'Minimum log level',
          detail: ['Type: string  Default: info  Reload: live'],
          category: 'set:core',
        },
      ]);

      const ctx = makeCtx();
      await handler.execute('.help set core logging.level', ctx);

      const out = ctx.reply.mock.calls[0][0];
      expect(out).toContain('logging.level');
      expect(out).toContain('Minimum log level');
      expect(out).toContain('Type: string');
      expect(out).toContain('Default: info');
    });
  });
});
