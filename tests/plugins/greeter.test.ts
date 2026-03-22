import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Permissions } from '../../src/core/permissions.js';
import { BotDatabase } from '../../src/database.js';
import { EventDispatcher } from '../../src/dispatcher.js';
import { BotEventBus } from '../../src/event-bus.js';
import { PluginLoader } from '../../src/plugin-loader.js';
import type { BotConfig, HandlerContext, PluginsConfig } from '../../src/types.js';

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

describe('greeter plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  afterEach(async () => {
    if (loader?.isLoaded('greeter')) {
      await loader.unload('greeter');
    }
    db?.close();
  });

  async function loadGreeter(pluginsConfig?: PluginsConfig): Promise<void> {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions: new Permissions(db),
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: null,
    });

    const result = await loader.load(resolve('./plugins/greeter/index.ts'), pluginsConfig);
    expect(result.status).toBe('ok');
  }

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

  it('should use empty string fallback when channel is null', async () => {
    await loadGreeter();

    const ctx: HandlerContext = {
      nick: 'someone',
      ident: 'user',
      hostname: 'host.com',
      channel: null as unknown as string,
      text: '',
      command: 'JOIN',
      args: '',
      reply: vi.fn(),
      replyPrivate: vi.fn(),
    };
    await dispatcher.dispatch('join', ctx);

    // The template replaces {channel} with '' (the ?? '' fallback)
    expect(ctx.reply).toHaveBeenCalledWith('Welcome to , someone!');
  });
});
