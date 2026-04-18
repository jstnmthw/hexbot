// Tests for ai-chat admin commands and config branches.
import { resolve } from 'node:path';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AIChatDeps } from '../../plugins/ai-chat/index';
import type { AIProvider } from '../../plugins/ai-chat/providers/types';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import { EventDispatcher } from '../../src/dispatcher';
import { BotEventBus } from '../../src/event-bus';
import { PluginLoader } from '../../src/plugin-loader';
import type { BotConfig, HandlerContext, PluginsConfig } from '../../src/types';

const BOT_CONFIG: BotConfig = {
  irc: {
    host: 'localhost',
    port: 6667,
    tls: false,
    nick: 'hexbot',
    username: 'hexbot',
    realname: 'HexBot',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!admin@adm.host' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function makeMockProvider(text = 'hi'): AIProvider {
  return {
    name: 'mock',
    initialize: vi.fn(async () => {}),
    complete: vi.fn(async () => ({ text, usage: { input: 3, output: 2 }, model: 'mock' })),
    countTokens: vi.fn(async () => 1),
    getModelName: () => 'mock-model',
  };
}

function makePubCtx(
  nick: string,
  text: string,
  ident = 'user',
  hostname = 'host.com',
  channel = '#test',
): HandlerContext & {
  reply: Mock<(msg: string) => void>;
  replyPrivate: Mock<(msg: string) => void>;
} {
  const spaceIdx = text.indexOf(' ');
  const command = spaceIdx === -1 ? text : text.substring(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : text.substring(spaceIdx + 1).trim();
  return {
    nick,
    ident,
    hostname,
    channel,
    text,
    command,
    args,
    reply: vi.fn(),
    replyPrivate: vi.fn(),
  } as HandlerContext & {
    reply: Mock<(msg: string) => void>;
    replyPrivate: Mock<(msg: string) => void>;
  };
}

describe('ai-chat admin commands', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;
  let mockProvider: AIProvider;
  let permissions: Permissions;

  async function loadPlugin(pluginsConfig?: PluginsConfig, deps?: AIChatDeps): Promise<void> {
    const result = await loader.load(
      resolve('./plugins/ai-chat/dist/index.js'),
      pluginsConfig,
      deps,
    );
    expect(result.status).toBe('ok');
  }

  beforeEach(async () => {
    mockProvider = makeMockProvider();
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    permissions = new Permissions(db);
    // Give "admin" user the n,m flags via hostmask
    permissions.addUser('admin', '*!admin@adm.host', 'nm', 'test');
    const eventBus = new BotEventBus();
    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions,
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    await loadPlugin(undefined, { provider: mockProvider });
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  // ---- stats ----
  it("!ai stats shows today's totals for admins", async () => {
    // Trigger one request so there is usage to report
    await dispatcher.dispatch('pub', makePubCtx('alice', '!ai hello'));
    const ctx = makePubCtx('admin', '!ai stats', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/1 requests/);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/5 tokens/);
  });

  it('!ai stats silently ignored for non-admins', async () => {
    const ctx = makePubCtx('alice', '!ai stats');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  // ---- reset ----
  it('!ai reset <nick> works for owner', async () => {
    // Seed usage
    await dispatcher.dispatch('pub', makePubCtx('alice', '!ai hello'));
    const ctx = makePubCtx('admin', '!ai reset alice', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Reset token usage for alice/);
  });

  it('!ai reset requires a target nick', async () => {
    const ctx = makePubCtx('admin', '!ai reset', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Usage: !ai reset/);
  });

  // ---- ignore / unignore ----
  it('!ai ignore adds nick to ignore list and blocks them', async () => {
    const ctx1 = makePubCtx('admin', '!ai ignore spammer', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx1);
    expect(ctx1.reply.mock.calls[0][0]).toMatch(/ignoring "spammer"/);

    // Now "spammer" should be ignored
    const ctx2 = makePubCtx('spammer', '!ai hi');
    await dispatcher.dispatch('pub', ctx2);
    expect(ctx2.reply).not.toHaveBeenCalled();
  });

  it('!ai ignore requires a target', async () => {
    const ctx = makePubCtx('admin', '!ai ignore', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Usage: !ai ignore/);
  });

  it('!ai unignore removes a previously-ignored target', async () => {
    await dispatcher.dispatch(
      'pub',
      makePubCtx('admin', '!ai ignore spammer', 'admin', 'adm.host'),
    );
    const ctx = makePubCtx('admin', '!ai unignore spammer', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/No longer ignoring "spammer"/);
  });

  it('!ai unignore requires a target', async () => {
    const ctx = makePubCtx('admin', '!ai unignore', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Usage: !ai unignore/);
  });

  // ---- clear ----
  it('!ai clear clears channel context', async () => {
    const ctx = makePubCtx('admin', '!ai clear', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/cleared/i);
  });

  // ---- character ----
  it('!ai character switches character for admins', async () => {
    const ctx = makePubCtx('admin', '!ai character sarcastic', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/set to sarcastic/);
  });

  it('switched character is used on the next LLM call', async () => {
    // Switch to sarcastic
    await dispatcher.dispatch(
      'pub',
      makePubCtx('admin', '!ai character sarcastic', 'admin', 'adm.host'),
    );
    // Next query should use the sarcastic character prompt
    const ctx = makePubCtx('alice', '!ai hi');
    await dispatcher.dispatch('pub', ctx);
    const [systemPrompt] = (mockProvider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemPrompt).toContain('sarcastic');
  });

  it('!ai character rejects unknown names', async () => {
    const ctx = makePubCtx('admin', '!ai character doesntexist', 'admin', 'adm.host');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Unknown character/);
  });

  it('!ai character silently ignored for non-admins', async () => {
    const ctx = makePubCtx('alice', '!ai character sarcastic');
    await dispatcher.dispatch('pub', ctx);
    // Non-admin still shouldn't get a confirmation
    const replies = ctx.reply.mock.calls.map((c) => c[0]);
    expect(replies.some((r) => r.includes('set to'))).toBe(false);
  });

  // ---- endgame fallback ----
  it('!ai endgame reports "no active session" when there is none', async () => {
    const ctx = makePubCtx('alice', '!ai endgame');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/No active session/);
  });

  // ---- non-admin silent-ignore ----
  it('!ai ignore silently ignored for non-admins', async () => {
    const ctx = makePubCtx('alice', '!ai ignore spammer');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('!ai unignore silently ignored for non-admins', async () => {
    const ctx = makePubCtx('alice', '!ai unignore spammer');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('!ai clear silently ignored for non-admins', async () => {
    const ctx = makePubCtx('alice', '!ai clear');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('!ai reset silently ignored for non-owner', async () => {
    const ctx = makePubCtx('alice', '!ai reset bob');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('ai-chat without a provider', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  beforeEach(async () => {
    delete process.env.HEX_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_CHAT_API_KEY;
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
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    const result = await loader.load(resolve('./plugins/ai-chat/dist/index.js'));
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  it('replies "unavailable" when no provider is configured', async () => {
    const ctx = makePubCtx('alice', '!ai hi');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/unavailable/i);
  });
});

describe('ai-chat sessions disabled', () => {
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
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    const result = await loader.load(
      resolve('./plugins/ai-chat/dist/index.js'),
      { 'ai-chat': { config: { sessions: { enabled: false } } } },
      { provider: makeMockProvider() } satisfies AIChatDeps,
    );
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  it('!ai games replies "Sessions are disabled"', async () => {
    const ctx = makePubCtx('alice', '!ai games');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Sessions are disabled/);
  });

  it('!ai play replies "Sessions are disabled"', async () => {
    const ctx = makePubCtx('alice', '!ai play 20questions');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Sessions are disabled/);
  });

  it('!ai endgame replies "Sessions are disabled"', async () => {
    const ctx = makePubCtx('alice', '!ai endgame');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Sessions are disabled/);
  });
});

describe('ai-chat budget/session edge paths', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;
  let mockProvider: AIProvider;

  beforeEach(async () => {
    mockProvider = makeMockProvider();
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
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    // Tiny per-user budget to force budget_exceeded
    await loader.load(
      resolve('./plugins/ai-chat/dist/index.js'),
      { 'ai-chat': { config: { token_budgets: { per_user_daily: 1, global_daily: 100 } } } },
      { provider: mockProvider } satisfies AIChatDeps,
    );
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  it('command user gets "budget exceeded" notice when over limit', async () => {
    const ctx = makePubCtx('alice', '!ai hi');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.replyPrivate.mock.calls[0][0]).toMatch(/budget exceeded/i);
  });

  it('session budget exceeded path', async () => {
    // Budget is already exceeded on first turn (per_user_daily=1 < estimate).
    const playCtx = makePubCtx('alice', '!ai play 20questions');
    await dispatcher.dispatch('pub', playCtx);
    // The "Starting..." reply still lands, but the session's opening game-turn
    // fails the budget check and triggers a budget-exceeded notice.
    expect(playCtx.replyPrivate.mock.calls.some((c) => /budget exceeded/i.test(c[0]))).toBe(true);
  });
});

describe('ai-chat play subcommand edge cases', () => {
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
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    await loader.load(resolve('./plugins/ai-chat/dist/index.js'), undefined, {
      provider: makeMockProvider(),
    } satisfies AIChatDeps);
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  it('!ai play with no args shows usage', async () => {
    const ctx = makePubCtx('alice', '!ai play');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Usage: !ai play/);
  });
});

describe('ai-chat channel_characters', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;
  let mockProvider: AIProvider;

  beforeEach(async () => {
    mockProvider = makeMockProvider();
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
      botConfig: BOT_CONFIG,
      ircClient: null,
    });
    const result = await loader.load(
      resolve('./plugins/ai-chat/dist/index.js'),
      {
        'ai-chat': {
          config: {
            channel_characters: {
              '#sarcastic': 'sarcastic',
              '#french': { character: 'friendly', language: 'French' },
            },
          },
        },
      },
      { provider: mockProvider } satisfies AIChatDeps,
    );
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    if (loader.isLoaded('ai-chat')) await loader.unload('ai-chat');
    db.close();
  });

  it('uses string-form channel_characters map', async () => {
    const ctx = makePubCtx('alice', '!ai character', 'user', 'host.com', '#sarcastic');
    await dispatcher.dispatch('pub', ctx);
    expect(ctx.reply.mock.calls[0][0]).toMatch(/sarcastic/);
  });

  it('uses object-form channel_characters with language override', async () => {
    const ctx = makePubCtx('alice', '!ai hi', 'user', 'host.com', '#french');
    await dispatcher.dispatch('pub', ctx);
    const [, messages] = (mockProvider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const lastUserTurn = messages[messages.length - 1].content;
    expect(lastUserTurn).toContain('Always respond in French.');
  });
});
