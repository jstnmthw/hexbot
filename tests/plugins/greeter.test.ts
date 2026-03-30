import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meetsMinFlag } from '../../plugins/greeter/index';
import { ChannelSettings } from '../../src/core/channel-settings';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import { EventDispatcher } from '../../src/dispatcher';
import { BotEventBus } from '../../src/event-bus';
import { PluginLoader } from '../../src/plugin-loader';
import type { BotConfig, HandlerContext, PluginsConfig } from '../../src/types';

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: {
    host: 'localhost',
    port: 6667,
    tls: false,
    nick: 'testbot',
    username: 'test',
    realname: 'test',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function makeJoinCtx(nick: string, channel: string): HandlerContext {
  return {
    nick,
    ident: 'user',
    hostname: 'host.com',
    channel,
    text: `${channel} ${nick}!user@host.com`,
    command: 'JOIN',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
  };
}

function makePubCtx(nick: string, host: string, channel: string, args: string): HandlerContext {
  return {
    nick,
    ident: 'user',
    hostname: host,
    channel,
    text: args ? `!greet ${args}` : '!greet',
    command: '!greet',
    args,
    reply: vi.fn(),
    replyPrivate: vi.fn(),
  };
}

describe('greeter plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;
  let permissions: Permissions;

  afterEach(async () => {
    if (loader?.isLoaded('greeter')) {
      await loader.unload('greeter');
    }
    db?.close();
  });

  async function loadGreeter(
    pluginsConfig?: PluginsConfig,
    ircClient: {
      notice(target: string, message: string): void;
      say(target: string, message: string): void;
    } | null = null,
  ): Promise<void> {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();
    permissions = new Permissions(db);

    const channelSettings = new ChannelSettings(db);

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions,
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: ircClient ? { ...ircClient, action: vi.fn(), ctcpResponse: vi.fn() } : null,
      channelSettings,
    });

    const result = await loader.load(resolve('./plugins/greeter/index.ts'), pluginsConfig);
    expect(result.status).toBe('ok');
  }

  // ---------------------------------------------------------------------------
  // Existing join greeting tests
  // ---------------------------------------------------------------------------

  it('should greet users who join with default message', async () => {
    await loadGreeter();

    const ctx = makeJoinCtx('newuser', '#test');
    await dispatcher.dispatch('join', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Welcome to #test, newuser!');
  });

  it('should use custom message from config', async () => {
    await loadGreeter({
      greeter: {
        enabled: true,
        config: { message: 'Hey {nick}, welcome to {channel}!' },
      },
    });

    const ctx = makeJoinCtx('someone', '#dev');
    await dispatcher.dispatch('join', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Hey someone, welcome to #dev!');
  });

  it('should not greet the bot itself', async () => {
    await loadGreeter({
      greeter: {
        enabled: true,
        config: { botNick: 'testbot' },
      },
    });

    const ctx = makeJoinCtx('testbot', '#test');
    await dispatcher.dispatch('join', ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('should not greet the bot when nick differs in case', async () => {
    await loadGreeter();

    // Bot nick is 'testbot' (from MINIMAL_BOT_CONFIG), join as 'TestBot'
    const ctx = makeJoinCtx('TestBot', '#test');
    await dispatcher.dispatch('join', ctx);

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // meetsMinFlag helper
  // ---------------------------------------------------------------------------

  describe('meetsMinFlag', () => {
    const makeRecord = (global: string, channels: Record<string, string> = {}) => ({
      handle: 'test',
      hostmasks: ['*!*@*'],
      global,
      channels,
    });

    it('owner (n) meets any level', () => {
      const rec = makeRecord('n');
      expect(meetsMinFlag(rec, 'n', null)).toBe(true);
      expect(meetsMinFlag(rec, 'm', null)).toBe(true);
      expect(meetsMinFlag(rec, 'o', null)).toBe(true);
      expect(meetsMinFlag(rec, 'v', null)).toBe(true);
    });

    it('op (o) meets o and v but not m or n', () => {
      const rec = makeRecord('o');
      expect(meetsMinFlag(rec, 'o', null)).toBe(true);
      expect(meetsMinFlag(rec, 'v', null)).toBe(true);
      expect(meetsMinFlag(rec, 'm', null)).toBe(false);
      expect(meetsMinFlag(rec, 'n', null)).toBe(false);
    });

    it('voice (v) meets only v', () => {
      const rec = makeRecord('v');
      expect(meetsMinFlag(rec, 'v', null)).toBe(true);
      expect(meetsMinFlag(rec, 'o', null)).toBe(false);
      expect(meetsMinFlag(rec, 'm', null)).toBe(false);
      expect(meetsMinFlag(rec, 'n', null)).toBe(false);
    });

    it('no flags meets nothing', () => {
      const rec = makeRecord('');
      expect(meetsMinFlag(rec, 'v', null)).toBe(false);
      expect(meetsMinFlag(rec, 'o', null)).toBe(false);
    });

    it('unknown minFlag returns false', () => {
      const rec = makeRecord('nmov');
      expect(meetsMinFlag(rec, 'x', null)).toBe(false);
    });

    it('channel-specific op satisfies v minimum for that channel', () => {
      const rec = makeRecord('', { '#test': 'o' });
      expect(meetsMinFlag(rec, 'v', '#test')).toBe(true);
      expect(meetsMinFlag(rec, 'o', '#test')).toBe(true);
      expect(meetsMinFlag(rec, 'm', '#test')).toBe(false);
    });

    it('channel-specific flag not used when checking a different channel', () => {
      const rec = makeRecord('', { '#other': 'o' });
      expect(meetsMinFlag(rec, 'v', '#test')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // !greet commands (min_flag: v)
  // ---------------------------------------------------------------------------

  describe('!greet commands (min_flag: v)', () => {
    beforeEach(async () => {
      await loadGreeter({
        greeter: { enabled: true, config: { min_flag: 'v' } },
      });
    });

    it('!greet (no args) returns "No custom greet set" for unregistered user', async () => {
      const ctx = makePubCtx('stranger', 'stranger.com', '#test', '');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('No custom greet set.');
    });

    it('!greet (no args) returns "No custom greet set" for registered user with none set', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', '');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('No custom greet set.');
    });

    it('!greet (no args) shows current greet when one is set', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');
      db.set('greeter', 'greet:jake', "I'm back!");

      const ctx = makePubCtx('jake', 'host.com', '#test', '');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith("Your greet: I'm back!");
    });

    it('!greet set stores greet for user with sufficient flag', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'set Hello everyone!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Custom greet set.');
      expect(db.get('greeter', 'greet:jake')).toBe('Hello everyone!');
    });

    it('!greet set rejects unregistered user', async () => {
      const ctx = makePubCtx('stranger', 'stranger.com', '#test', 'set Hi!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith(
        'You must be a registered user to set a greet.',
      );
    });

    it('!greet set strips \\r and \\n from message', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'set Hello\r\nworld');
      await dispatcher.dispatch('pub', ctx);

      expect(db.get('greeter', 'greet:jake')).toBe('Helloworld');
    });

    it('!greet set truncates message at 200 chars', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');
      const long = 'a'.repeat(250);

      const ctx = makePubCtx('jake', 'host.com', '#test', `set ${long}`);
      await dispatcher.dispatch('pub', ctx);

      expect(db.get('greeter', 'greet:jake')).toHaveLength(200);
    });

    it('!greet set with no message shows usage', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'set');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Usage: !greet set <message>');
    });

    it('!greet del removes existing greet', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');
      db.set('greeter', 'greet:jake', 'Back again!');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'del');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Custom greet removed.');
      expect(db.get('greeter', 'greet:jake')).toBeNull();
    });

    it('!greet del is graceful when no greet is set', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'del');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Custom greet removed.');
    });

    it('!greet del rejects unregistered user', async () => {
      const ctx = makePubCtx('stranger', 'stranger.com', '#test', 'del');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith(
        'You must be a registered user to remove a greet.',
      );
    });

    it('!greet del rejects user with insufficient flag', async () => {
      // min_flag is 'v' but user has no flags
      permissions.addUser('lowpriv', '*!user@host.com', '');

      const ctx = makePubCtx('lowpriv', 'host.com', '#test', 'del');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith(
        'You need at least +v to remove a custom greet.',
      );
    });

    it('!greet <unknown subcommand> shows usage hint', async () => {
      const ctx = makePubCtx('user1', 'host.com', '#test', 'foobar');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith(
        'Usage: !greet | !greet set <message> | !greet del',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // delivery modes
  // ---------------------------------------------------------------------------

  describe('delivery modes', () => {
    it('delivery: "say" (default) calls ctx.reply, not api.notice', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter({ greeter: { enabled: true, config: { delivery: 'say' } } }, mockIrc);

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Welcome to #test, alice!');
      expect(mockIrc.notice).not.toHaveBeenCalled();
    });

    it('delivery: "channel_notice" sends NOTICE to channel, not ctx.reply', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        { greeter: { enabled: true, config: { delivery: 'channel_notice' } } },
        mockIrc,
      );

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
      expect(mockIrc.notice).toHaveBeenCalledWith('#test', 'Welcome to #test, alice!');
    });
  });

  // ---------------------------------------------------------------------------
  // join_notice — private notice to joining user
  // ---------------------------------------------------------------------------

  describe('join_notice', () => {
    it('sends no notice when join_notice is empty (default)', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(undefined, mockIrc);

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(mockIrc.notice).not.toHaveBeenCalled();
    });

    it('sends NOTICE to joining nick when join_notice is set', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        { greeter: { enabled: true, config: { join_notice: 'Hi! Try !help for commands.' } } },
        mockIrc,
      );

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(mockIrc.notice).toHaveBeenCalledWith('alice', 'Hi! Try !help for commands.');
    });

    it('applies {channel} and {nick} substitutions to join_notice', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        {
          greeter: {
            enabled: true,
            config: { join_notice: 'Hi {nick}, welcome to {channel}!' },
          },
        },
        mockIrc,
      );

      const ctx = makeJoinCtx('alice', '#lobby');
      await dispatcher.dispatch('join', ctx);

      expect(mockIrc.notice).toHaveBeenCalledWith('alice', 'Hi alice, welcome to #lobby!');
    });

    it('strips \\r and \\n from join_notice before sending', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        { greeter: { enabled: true, config: { join_notice: 'Hello\r\nworld' } } },
        mockIrc,
      );

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(mockIrc.notice).toHaveBeenCalledWith('alice', 'Helloworld');
    });

    it('fires both public greeting and join_notice simultaneously', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        {
          greeter: {
            enabled: true,
            config: {
              delivery: 'channel_notice',
              join_notice: 'Hi {nick}! Type !help.',
            },
          },
        },
        mockIrc,
      );

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      // Public: channel notice
      expect(mockIrc.notice).toHaveBeenCalledWith('#test', 'Welcome to #test, alice!');
      // Private: join notice to nick
      expect(mockIrc.notice).toHaveBeenCalledWith('alice', 'Hi alice! Type !help.');
      expect(mockIrc.notice).toHaveBeenCalledTimes(2);
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // !greet set — min_flag enforcement
  // ---------------------------------------------------------------------------

  describe('!greet set with min_flag: o', () => {
    beforeEach(async () => {
      await loadGreeter({
        greeter: { enabled: true, config: { min_flag: 'o' } },
      });
    });

    it('rejects a user with only v flag', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'set Hi!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('You need at least +o to set a custom greet.');
    });

    it('allows a user with o flag', async () => {
      permissions.addUser('jake', '*!user@host.com', 'o');

      const ctx = makePubCtx('jake', 'host.com', '#test', 'set Hi!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Custom greet set.');
    });
  });

  // ---------------------------------------------------------------------------
  // Join handler — custom greet lookup
  // ---------------------------------------------------------------------------

  describe('join with custom greet', () => {
    beforeEach(async () => {
      await loadGreeter();
    });

    it('uses custom greet when user has one set', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');
      db.set('greeter', 'greet:jake', "I'm back!");

      const ctx = makeJoinCtx('jake', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith("I'm back!");
    });

    it('applies {channel} and {nick} substitutions to custom greet', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');
      db.set('greeter', 'greet:jake', 'Hey {channel}, {nick} is here!');

      const ctx = makeJoinCtx('jake', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Hey #test, jake is here!');
    });

    it('falls back to default when user has no custom greet', async () => {
      permissions.addUser('jake', '*!user@host.com', 'v');

      const ctx = makeJoinCtx('jake', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Welcome to #test, jake!');
    });

    it('falls back to default for unregistered user', async () => {
      const ctx = makeJoinCtx('stranger', '#test');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Welcome to #test, stranger!');
    });
  });

  // ---------------------------------------------------------------------------
  // ?? fallback defaults — config values explicitly null
  // ---------------------------------------------------------------------------

  describe('config ?? fallback defaults (null config values)', () => {
    it('min_flag defaults to "v" when config value is null', async () => {
      await loadGreeter({
        greeter: { enabled: true, config: { min_flag: null } },
      });

      // User with +v should be allowed to set a greet (min_flag falls back to 'v')
      permissions.addUser('jake', '*!user@host.com', 'v');
      const ctx = makePubCtx('jake', 'host.com', '#test', 'set Hello!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('Custom greet set.');
    });

    it('min_flag "v" default rejects user with no flags', async () => {
      await loadGreeter({
        greeter: { enabled: true, config: { min_flag: null } },
      });

      permissions.addUser('noflag', '*!user@host.com', '');
      const ctx = makePubCtx('noflag', 'host.com', '#test', 'set Hello!');
      await dispatcher.dispatch('pub', ctx);

      expect(ctx.replyPrivate).toHaveBeenCalledWith('You need at least +v to set a custom greet.');
    });

    it('delivery defaults to "say" when config value is null', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter({ greeter: { enabled: true, config: { delivery: null } } }, mockIrc);

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      // 'say' delivery uses ctx.reply (PRIVMSG to channel), not api.notice
      expect(ctx.reply).toHaveBeenCalledWith('Welcome to #test, alice!');
      expect(mockIrc.notice).not.toHaveBeenCalled();
    });

    it('join_notice defaults to empty string when config value is null (no notice sent)', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter({ greeter: { enabled: true, config: { join_notice: null } } }, mockIrc);

      const ctx = makeJoinCtx('alice', '#test');
      await dispatcher.dispatch('join', ctx);

      // Public greeting still fires, but no private notice
      expect(ctx.reply).toHaveBeenCalled();
      expect(mockIrc.notice).not.toHaveBeenCalled();
    });

    it('message defaults to "Welcome to {channel}, {nick}!" when config value is null', async () => {
      await loadGreeter({
        greeter: { enabled: true, config: { message: null } },
      });

      const ctx = makeJoinCtx('bob', '#lobby');
      await dispatcher.dispatch('join', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Welcome to #lobby, bob!');
    });

    it('all config values null — full defaults work together', async () => {
      const mockIrc = { notice: vi.fn(), say: vi.fn() };
      await loadGreeter(
        {
          greeter: {
            enabled: true,
            config: {
              min_flag: null,
              delivery: null,
              join_notice: null,
              message: null,
            },
          },
        },
        mockIrc,
      );

      // Join greeting fires with default message and 'say' delivery
      const joinCtx = makeJoinCtx('charlie', '#test');
      await dispatcher.dispatch('join', joinCtx);

      expect(joinCtx.reply).toHaveBeenCalledWith('Welcome to #test, charlie!');
      expect(mockIrc.notice).not.toHaveBeenCalled();

      // !greet set works for +v user (default min_flag)
      permissions.addUser('charlie', '*!user@host.com', 'v');
      const setCtx = makePubCtx('charlie', 'host.com', '#test', 'set Hi all!');
      await dispatcher.dispatch('pub', setCtx);

      expect(setCtx.replyPrivate).toHaveBeenCalledWith('Custom greet set.');
    });
  });
});
