import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import { EventDispatcher } from '../../src/dispatcher';
import { BotEventBus } from '../../src/event-bus';
import { PluginLoader } from '../../src/plugin-loader';
import type { IRCClientForPlugins } from '../../src/plugin-loader';
import type { BotConfig, HandlerContext, HelpEntry, PluginsConfig } from '../../src/types';

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

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'user1',
    ident: 'user',
    hostname: 'host.com',
    channel: '#test',
    text: '!help',
    command: '!help',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

const OP_ENTRY: HelpEntry = {
  command: '!op',
  flags: 'o',
  usage: '!op [nick]',
  description: 'Op a nick',
  category: 'moderation',
};

const BALL_ENTRY: HelpEntry = {
  command: '!8ball',
  flags: '-',
  usage: '!8ball <question>',
  description: 'Ask the magic 8-ball',
  category: 'fun',
};

const SEEN_ENTRY: HelpEntry = {
  command: '!seen',
  flags: '-',
  usage: '!seen <nick>',
  description: 'Show when a nick was last seen',
  category: 'info',
};

describe('help plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;
  let permissions: Permissions;
  let helpRegistry: HelpRegistry;
  let mockNotice: ReturnType<typeof vi.fn>;
  let mockSay: ReturnType<typeof vi.fn>;

  async function loadHelp(pluginsConfig?: PluginsConfig): Promise<void> {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();
    permissions = new Permissions(db);
    helpRegistry = new HelpRegistry();
    mockNotice = vi.fn();
    mockSay = vi.fn();

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions,
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: {
        notice: mockNotice,
        say: mockSay,
        action: vi.fn(),
        ctcpResponse: vi.fn(),
      } as IRCClientForPlugins,
      helpRegistry,
    });

    const result = await loader.load(resolve('./plugins/help/index.ts'), pluginsConfig);
    expect(result.status).toBe('ok');
  }

  afterEach(async () => {
    if (loader?.isLoaded('help')) {
      await loader.unload('help');
    }
    db?.close();
  });

  // ---------------------------------------------------------------------------
  // List view — default reply_type: notice
  // ---------------------------------------------------------------------------

  it('sends list view via NOTICE to nick when called from a channel', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ channel: '#test' });
    await dispatcher.dispatch('pub', ctx);

    // All notices should go to the nick, not the channel
    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
    expect(mockNotice).toHaveBeenCalled();
  });

  it('sends list view via NOTICE to nick when called from a PM', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ channel: null, text: '!help', command: '!help' });
    await dispatcher.dispatch('msg', ctx);

    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
  });

  it('includes header and footer in list view', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages[0]).toBe('*** Help ***');
    expect(messages[messages.length - 1]).toBe('*** End of Help ***');
  });

  it('lists commands grouped by category', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);
    helpRegistry.register('seen', [SEEN_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages).toContain('[fun]');
    expect(messages).toContain('[info]');
  });

  // ---------------------------------------------------------------------------
  // reply_type: privmsg
  // ---------------------------------------------------------------------------

  it('sends list view via PRIVMSG when reply_type is privmsg', async () => {
    await loadHelp({
      help: { enabled: true, config: { reply_type: 'privmsg', cooldown_ms: 0 } },
    });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    expect(mockSay).toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
    for (const call of mockSay.mock.calls) {
      expect(call[0]).toBe('user1');
    }
  });

  // ---------------------------------------------------------------------------
  // reply_type: channel_notice
  // ---------------------------------------------------------------------------

  it('sends list view to channel when reply_type is channel_notice and called from channel', async () => {
    await loadHelp({
      help: { enabled: true, config: { reply_type: 'channel_notice', cooldown_ms: 0 } },
    });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ channel: '#test' });
    await dispatcher.dispatch('pub', ctx);

    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('#test');
    }
  });

  it('falls back to private notice for channel_notice when called via PM', async () => {
    await loadHelp({
      help: { enabled: true, config: { reply_type: 'channel_notice', cooldown_ms: 0 } },
    });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ channel: null });
    await dispatcher.dispatch('msg', ctx);

    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
  });

  // ---------------------------------------------------------------------------
  // Permission filtering
  // ---------------------------------------------------------------------------

  it('shows only flags:- entries to a user with no permissions', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('chanmod', [OP_ENTRY]);
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx(); // no user registered — no flags
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    const hasOp = messages.some((m) => m.includes('!op'));
    const hasBall = messages.some((m) => m.includes('!8ball'));

    expect(hasOp).toBe(false);
    expect(hasBall).toBe(true);
  });

  it('shows flags:o entries to a user with +o permission', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('chanmod', [OP_ENTRY]);
    helpRegistry.register('8ball', [BALL_ENTRY]);

    // Register user with op flag
    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ nick: 'user1', ident: 'user', hostname: 'host.com' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages.some((m) => m.includes('!op'))).toBe(true);
    expect(messages.some((m) => m.includes('!8ball'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------------------------

  it('!help <command> returns detail for the command (always to nick)', async () => {
    await loadHelp();
    helpRegistry.register('chanmod', [OP_ENTRY]);

    const ctx = makeCtx({ args: 'op', text: '!help op', channel: '#test' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalled();
    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages.some((m) => m.includes('!op [nick]'))).toBe(true);
  });

  it('!help !op (with leading !) also works', async () => {
    await loadHelp();
    helpRegistry.register('chanmod', [OP_ENTRY]);

    const ctx = makeCtx({ args: '!op', text: '!help !op' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages.some((m) => m.includes('!op [nick]'))).toBe(true);
  });

  it('!help <command> shows detail lines when present', async () => {
    await loadHelp();
    const withDetail: HelpEntry = { ...OP_ENTRY, detail: ['Extra info here', 'More info'] };
    helpRegistry.register('chanmod', [withDetail]);

    const ctx = makeCtx({ args: 'op' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1] as string);
    expect(messages).toContain('Extra info here');
    expect(messages).toContain('More info');
  });

  it('!help <unknowncmd> returns explicit not-found reply', async () => {
    await loadHelp();

    const ctx = makeCtx({ args: 'unknowncmd', text: '!help unknowncmd' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalledWith('user1', 'No help available for !unknowncmd');
  });

  // ---------------------------------------------------------------------------
  // Cooldown
  // ---------------------------------------------------------------------------

  it('silently drops second !help list call within cooldown window', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 60000 } } });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);
    const callsAfterFirst = mockNotice.mock.calls.length;

    // Second call — should be dropped
    await dispatcher.dispatch('pub', ctx);
    expect(mockNotice.mock.calls.length).toBe(callsAfterFirst);
  });

  it('allows !help list after cooldown expires', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);
    const firstCount = mockNotice.mock.calls.length;

    await dispatcher.dispatch('pub', ctx);
    expect(mockNotice.mock.calls.length).toBeGreaterThan(firstCount);
  });

  it('detail view bypasses cooldown', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 60000 } } });
    helpRegistry.register('chanmod', [OP_ENTRY]);

    // Trigger list view first to set cooldown
    const listCtx = makeCtx();
    await dispatcher.dispatch('pub', listCtx);
    mockNotice.mockClear();

    // Detail view should still work
    const detailCtx = makeCtx({ args: 'op', text: '!help op' });
    await dispatcher.dispatch('pub', detailCtx);

    expect(mockNotice).toHaveBeenCalled();
  });
});
