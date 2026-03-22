import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Permissions } from '../../src/core/permissions.js';
import { BotDatabase } from '../../src/database.js';
import { EventDispatcher } from '../../src/dispatcher.js';
import { BotEventBus } from '../../src/event-bus.js';
import { PluginLoader } from '../../src/plugin-loader.js';
import type { BotConfig, HandlerContext } from '../../src/types.js';

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: {
    host: 'localhost',
    port: 6667,
    tls: false,
    nick: 'test',
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

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'user1',
    ident: 'user',
    hostname: 'host.com',
    channel: '#test',
    text: '!8ball Will this work?',
    command: '!8ball',
    args: 'Will this work?',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

describe('8ball plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  beforeEach(async () => {
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

    const result = await loader.load(resolve('./plugins/8ball/index.ts'));
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    if (loader.isLoaded('8ball')) {
      await loader.unload('8ball');
    }
    db.close();
  });

  it('should respond to !8ball with a question', async () => {
    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const response = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(response).toMatch(/^🎱 /);
  });

  it('should return one of the known responses', async () => {
    const KNOWN_RESPONSES = [
      'It is certain.',
      'It is decidedly so.',
      'Without a doubt.',
      'Yes — definitely.',
      'You may rely on it.',
      'As I see it, yes.',
      'Most likely.',
      'Outlook good.',
      'Yes.',
      'Signs point to yes.',
      'Reply hazy, try again.',
      'Ask again later.',
      'Better not tell you now.',
      'Cannot predict now.',
      'Concentrate and ask again.',
      "Don't count on it.",
      'My reply is no.',
      'My sources say no.',
      'Outlook not so good.',
      'Very doubtful.',
    ];

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const response = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const answer = response.replace('🎱 ', '');
    expect(KNOWN_RESPONSES).toContain(answer);
  });

  it('should show usage when no question is provided', async () => {
    const ctx = makeCtx({
      text: '!8ball',
      command: '!8ball',
      args: '',
    });
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Usage: !8ball <question>');
  });
});
