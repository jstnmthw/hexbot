import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandlerContext } from '../src/types.js';
import { type MockBot, createMockBot } from './helpers/mock-bot.js';

describe('Bot (mock)', () => {
  let bot: MockBot;

  beforeEach(() => {
    bot = createMockBot();
  });

  afterEach(() => {
    bot.cleanup();
  });

  describe('admin commands via IRC', () => {
    it('should route .say command to IRC client', async () => {
      // Add an admin user
      bot.permissions.addUser('admin', '*!admin@trusted.host', 'n', 'test');

      // Register a pub bind for the command handler
      bot.dispatcher.bind(
        'pub',
        '-',
        '.say',
        async (ctx: HandlerContext) => {
          await bot.commandHandler.execute(ctx.text, {
            source: 'irc',
            nick: ctx.nick,
            ident: ctx.ident,
            hostname: ctx.hostname,
            channel: ctx.channel,
            reply: (msg: string) => ctx.reply(msg),
          });
        },
        'core',
      );

      // Simulate an IRC message
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'admin',
        hostname: 'trusted.host',
        target: '#test',
        message: '.say #other Hello from admin!',
      });

      await new Promise((r) => setTimeout(r, 20));

      // The .say command should have sent a message via the IRC client
      const sayMsg = bot.client.messages.find((m) => m.type === 'say' && m.target === '#other');
      expect(sayMsg).toBeDefined();
      expect(sayMsg?.message).toBe('Hello from admin!');

      bot.dispatcher.unbindAll('core');
    });

    it('should route .status command', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.status', {
        source: 'repl',
        nick: 'REPL',
        channel: null,
        reply: (msg: string) => replies.push(msg),
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Status:');
      expect(replies[0]).toContain('Uptime:');
      expect(replies[0]).toContain('Channels:');
    });
  });

  describe('startup wiring', () => {
    it('should create all modules', () => {
      expect(bot.client).toBeDefined();
      expect(bot.db).toBeDefined();
      expect(bot.permissions).toBeDefined();
      expect(bot.dispatcher).toBeDefined();
      expect(bot.commandHandler).toBeDefined();
      expect(bot.eventBus).toBeDefined();
      expect(bot.bridge).toBeDefined();
    });

    it('should have commands registered', () => {
      const commands = bot.commandHandler.getCommands();
      const names = commands.map((c) => c.name);

      expect(names).toContain('help');
      expect(names).toContain('adduser');
      expect(names).toContain('deluser');
      expect(names).toContain('flags');
      expect(names).toContain('users');
      expect(names).toContain('binds');
      expect(names).toContain('say');
      expect(names).toContain('join');
      expect(names).toContain('part');
      expect(names).toContain('status');
      expect(names).toContain('plugins');
      expect(names).toContain('load');
      expect(names).toContain('unload');
      expect(names).toContain('reload');
    });
  });

  describe('IRC events flow through to dispatcher', () => {
    it('should dispatch channel messages from IRC', async () => {
      const handler = vi.fn();
      bot.dispatcher.bind('pub', '-', '!ping', handler, 'test-plugin');

      bot.client.simulateEvent('privmsg', {
        nick: 'someone',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!ping',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();

      bot.dispatcher.unbindAll('test-plugin');
    });

    it('should dispatch join events from IRC', async () => {
      const handler = vi.fn();
      bot.dispatcher.bind('join', '-', '*', handler, 'test-plugin');

      bot.client.simulateEvent('join', {
        nick: 'newuser',
        ident: 'new',
        hostname: 'new.host',
        channel: '#test',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();

      bot.dispatcher.unbindAll('test-plugin');
    });
  });

  describe('cleanup', () => {
    it('should detach bridge and close database on cleanup', () => {
      // Verify the bridge is attached by checking it dispatches
      const handler = vi.fn();
      bot.dispatcher.bind('pub', '-', '!test', handler, 'test');

      bot.cleanup();

      // After cleanup, events should not dispatch
      bot.client.simulateEvent('privmsg', {
        nick: 'user',
        ident: 'u',
        hostname: 'h',
        target: '#test',
        message: '!test',
      });

      // Should not fire since bridge is detached
      // (using setTimeout to ensure async completion)
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(handler).not.toHaveBeenCalled();
          bot.dispatcher.unbindAll('test');
          resolve();
        }, 10);
      });
    });
  });
});
