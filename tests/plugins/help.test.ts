import { resolve } from 'node:path';
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
import { Permissions } from '../../src/core/permissions';
import { SettingsRegistry } from '../../src/core/settings-registry';
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
  let mockNotice: Mock<(target: string, message: string) => void>;
  let mockSay: Mock<(target: string, message: string) => void>;

  async function loadHelp(pluginsConfig?: PluginsConfig): Promise<void> {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();
    permissions = new Permissions(db);
    helpRegistry = new HelpRegistry();
    mockNotice = vi.fn<(target: string, message: string) => void>();
    mockSay = vi.fn<(target: string, message: string) => void>();

    const coreSettings = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
    });
    const pluginSettings = new Map<string, SettingsRegistry>();
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
      coreSettings,
      pluginSettings,
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
  // List view — default compact_index: true
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

  it('compact index: sends bold intro line and one line per category', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('8ball', [BALL_ENTRY]);
    helpRegistry.register('seen', [SEEN_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    // First line is the bold intro
    expect(messages[0].startsWith('\x02')).toBe(true);
    expect(messages[0]).toContain('— !help <category> or !help <command>');
    // One line per category, no footer
    expect(messages.some((m) => m.includes('\x02fun\x02'))).toBe(true);
    expect(messages.some((m) => m.includes('\x02info\x02'))).toBe(true);
    // No classic header/footer lines
    expect(messages).not.toContain('*** Help ***');
    expect(messages).not.toContain('*** End of Help ***');
  });

  it('compact index: category line lists command names without !', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    const funLine = messages.find((m) => m.includes('\x02fun\x02'));
    expect(funLine).toBeDefined();
    expect(funLine).toContain('8ball');
    // Command names are stripped of ! in compact index
    expect(funLine).not.toContain('!8ball');
  });

  // ---------------------------------------------------------------------------
  // List view — verbose mode (compact_index: false)
  // ---------------------------------------------------------------------------

  it('verbose mode: sends bold header and footer', async () => {
    await loadHelp({
      help: {
        enabled: true,
        config: {
          compact_index: false,
          cooldown_ms: 0,
          header: 'Test Help',
          footer: '--- End ---',
        },
      },
    });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02Test Help\x02');
    expect(messages[messages.length - 1]).toBe('--- End ---');
  });

  it('verbose mode: lists commands grouped by category with bold formatting', async () => {
    await loadHelp({
      help: { enabled: true, config: { compact_index: false, cooldown_ms: 0 } },
    });
    helpRegistry.register('8ball', [BALL_ENTRY]);
    helpRegistry.register('seen', [SEEN_ENTRY]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages).toContain('\x02[fun]\x02');
    expect(messages).toContain('\x02[info]\x02');
    expect(messages.some((m) => m.includes('\x02!8ball\x02'))).toBe(true);
    expect(messages.some((m) => m.includes('\x02!seen\x02'))).toBe(true);
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
    await loadHelp({
      help: { enabled: true, config: { compact_index: false, cooldown_ms: 0 } },
    });
    helpRegistry.register('chanmod', [OP_ENTRY]);
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx(); // no user registered — no flags
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    const hasOp = messages.some((m) => m.includes('!op'));
    const hasBall = messages.some((m) => m.includes('!8ball'));

    expect(hasOp).toBe(false);
    expect(hasBall).toBe(true);
  });

  it('shows flags:o entries to a user with +o permission', async () => {
    await loadHelp({
      help: { enabled: true, config: { compact_index: false, cooldown_ms: 0 } },
    });
    helpRegistry.register('chanmod', [OP_ENTRY]);
    helpRegistry.register('8ball', [BALL_ENTRY]);

    // Register user with op flag
    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ nick: 'user1', ident: 'user', hostname: 'host.com' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages.some((m) => m.includes('!op'))).toBe(true);
    expect(messages.some((m) => m.includes('!8ball'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------------------------

  it('!help <command> returns detail for the command (always to nick)', async () => {
    await loadHelp();
    helpRegistry.register('chanmod', [OP_ENTRY]);
    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ args: 'op', text: '!help op', channel: '#test' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalled();
    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
    const messages = mockNotice.mock.calls.map((c) => c[1]);
    // Single line: bold usage — description | Requires: <flags>
    expect(messages).toEqual(['\x02!op\x02 [nick] — Op a nick | Requires: o']);
  });

  it('!help <command> with flags:- omits the Requires suffix entirely', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ args: '8ball' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages).toEqual(['\x02!8ball\x02 <question> — Ask the magic 8-ball']);
  });

  it('!help !op (with leading !) also works', async () => {
    await loadHelp();
    helpRegistry.register('chanmod', [OP_ENTRY]);
    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ args: '!op', text: '!help !op' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02!op\x02 [nick] — Op a nick | Requires: o');
  });

  it('!help <command> shows detail lines when present', async () => {
    await loadHelp();
    const withDetail: HelpEntry = { ...OP_ENTRY, detail: ['Extra info here', 'More info'] };
    helpRegistry.register('chanmod', [withDetail]);
    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ args: 'op' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    // Detail lines are indented to match the list view's two-space prefix.
    expect(messages).toContain('  Extra info here');
    expect(messages).toContain('  More info');
  });

  it('!help <command> hides privileged commands from unprivileged users', async () => {
    await loadHelp();
    helpRegistry.register('chanmod', [OP_ENTRY]);

    // user1 does NOT have 'o' flag — should get "No help" instead of details
    const ctx = makeCtx({ args: 'op', text: '!help op' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalledWith('user1', 'No help for "op" — try !help for a list');
  });

  it('!help <unknowncmd> returns explicit not-found reply', async () => {
    await loadHelp();

    const ctx = makeCtx({ args: 'unknowncmd', text: '!help unknowncmd' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalledWith(
      'user1',
      'No help for "unknowncmd" — try !help for a list',
    );
  });

  // ---------------------------------------------------------------------------
  // Category drill-down
  // ---------------------------------------------------------------------------

  it("!help <category> shows that category's commands to nick", async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]); // flags: '-', visible to all

    const ctx = makeCtx({ args: 'fun', channel: '#test' });
    await dispatcher.dispatch('pub', ctx);

    // Category view always sends to nick, not channel
    for (const call of mockNotice.mock.calls) {
      expect(call[0]).toBe('user1');
    }
    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02[fun]\x02');
    expect(messages.some((m) => m.includes('\x02!8ball\x02'))).toBe(true);
  });

  it('!help <category> filters by permission', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('chanmod', [OP_ENTRY]);

    // User has no 'o' flag — moderation category hidden
    const ctx = makeCtx({ args: 'moderation' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalledWith(
      'user1',
      'No help for "moderation" — try !help for a list',
    );
  });

  it('!help <category> shows commands when user has the required flag', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('chanmod', [OP_ENTRY]);

    permissions.addUser('opuser', 'user1!user@host.com', 'o', 'test');
    permissions.loadFromDb();

    const ctx = makeCtx({ nick: 'user1', ident: 'user', hostname: 'host.com', args: 'moderation' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02[moderation]\x02');
    expect(messages.some((m) => m.includes('\x02!op\x02'))).toBe(true);
  });

  it('!help <category> case-insensitive match', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ args: 'FUN' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02[fun]\x02');
    expect(messages.some((m) => m.includes('\x02!8ball\x02'))).toBe(true);
  });

  it('command name takes priority over category name in arg dispatch', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    // Register a command named "!fun" and entries with category "fun"
    const funCommand: HelpEntry = {
      command: '!fun',
      flags: '-',
      usage: '!fun',
      description: 'A command called fun',
      category: 'misc',
    };
    helpRegistry.register('misc', [funCommand, BALL_ENTRY]);

    const ctx = makeCtx({ args: 'fun' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    // Should show detail for !fun command, not the category view
    expect(messages).toEqual(['\x02!fun\x02 — A command called fun']);
  });

  it('!help <unknowncategory> returns not-found reply', async () => {
    await loadHelp();
    helpRegistry.register('8ball', [BALL_ENTRY]);

    const ctx = makeCtx({ args: 'unknowncat' });
    await dispatcher.dispatch('pub', ctx);

    expect(mockNotice).toHaveBeenCalledWith(
      'user1',
      'No help for "unknowncat" — try !help for a list',
    );
  });

  // ---------------------------------------------------------------------------
  // ?? fallback defaults — config values explicitly null
  // ---------------------------------------------------------------------------

  describe('config ?? fallback defaults (null config values)', () => {
    it('cooldown_ms defaults to 30000 when config value is null', async () => {
      await loadHelp({
        help: { enabled: true, config: { cooldown_ms: null } },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      // First call should work
      const ctx1 = makeCtx();
      await dispatcher.dispatch('pub', ctx1);
      const firstCount = mockNotice.mock.calls.length;
      expect(firstCount).toBeGreaterThan(0);

      // Second call immediately — should be silently dropped due to 30s default cooldown
      const ctx2 = makeCtx();
      await dispatcher.dispatch('pub', ctx2);
      expect(mockNotice.mock.calls.length).toBe(firstCount);
    });

    it('reply_type defaults to "notice" when config value is null', async () => {
      await loadHelp({
        help: { enabled: true, config: { reply_type: null, cooldown_ms: 0 } },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      const ctx = makeCtx({ channel: '#test' });
      await dispatcher.dispatch('pub', ctx);

      // Default reply_type is 'notice' — messages sent via api.notice to nick
      expect(mockNotice).toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();
      for (const call of mockNotice.mock.calls) {
        expect(call[0]).toBe('user1');
      }
    });

    it('compact_index defaults to true when config value is null', async () => {
      await loadHelp({
        help: { enabled: true, config: { compact_index: null, cooldown_ms: 0 } },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);
      helpRegistry.register('seen', [SEEN_ENTRY]);

      const ctx = makeCtx();
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      // Compact index: first line is bold intro with usage hint
      expect(messages[0].startsWith('\x02')).toBe(true);
      expect(messages[0]).toContain('— !help <category> or !help <command>');
      // One line per category, no verbose footer
      expect(messages.some((m: string) => m.includes('\x02fun\x02'))).toBe(true);
      expect(messages).not.toContain('*** End of Help ***');
    });

    it('header defaults to "HexBot Commands" when config value is null', async () => {
      await loadHelp({
        help: {
          enabled: true,
          config: { header: null, compact_index: false, cooldown_ms: 0 },
        },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      const ctx = makeCtx();
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      expect(messages[0]).toBe('\x02HexBot Commands\x02');
    });

    it('footer defaults to "*** End of Help ***" when config value is null', async () => {
      await loadHelp({
        help: {
          enabled: true,
          config: { footer: null, compact_index: false, cooldown_ms: 0 },
        },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      const ctx = makeCtx();
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      expect(messages[messages.length - 1]).toBe('*** End of Help ***');
    });

    it('all config values null — full defaults work together', async () => {
      await loadHelp({
        help: {
          enabled: true,
          config: {
            cooldown_ms: null,
            reply_type: null,
            compact_index: null,
            header: null,
            footer: null,
          },
        },
      });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      const ctx = makeCtx({ channel: '#test' });
      await dispatcher.dispatch('pub', ctx);

      // Defaults: reply_type=notice, compact_index=true, header=HexBot Commands
      expect(mockNotice).toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      // Compact index with default header
      expect(messages[0]).toContain('HexBot Commands');
      expect(messages[0]).toContain('— !help <category> or !help <command>');
      // All notices go to nick (default reply_type=notice)
      for (const call of mockNotice.mock.calls) {
        expect(call[0]).toBe('user1');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Entries without explicit category (fallback to pluginId)
  // ---------------------------------------------------------------------------

  it('compact index: entry without category falls back to pluginId', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    const noCategory: HelpEntry = {
      command: '!foo',
      flags: '-',
      usage: '!foo',
      description: 'A command with no category',
      // category intentionally omitted
    };
    helpRegistry.register('myplugin', [noCategory]);

    const ctx = makeCtx();
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    // The pluginId 'myplugin' should be used as the category label
    expect(messages.some((m) => m.includes('myplugin'))).toBe(true);
  });

  it('!help <category> works for entry without explicit category (pluginId as fallback)', async () => {
    await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
    const noCategory: HelpEntry = {
      command: '!foo',
      flags: '-',
      usage: '!foo',
      description: 'A command with no category',
    };
    helpRegistry.register('myplugin', [noCategory]);

    const ctx = makeCtx({ args: 'myplugin' });
    await dispatcher.dispatch('pub', ctx);

    const messages = mockNotice.mock.calls.map((c) => c[1]);
    expect(messages[0]).toBe('\x02[myplugin]\x02');
    expect(messages.some((m) => m.includes('\x02!foo\x02'))).toBe(true);
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

  // ---------------------------------------------------------------------------
  // Settings-scope index folding (Phase 2)
  // ---------------------------------------------------------------------------

  describe('settings-scope index', () => {
    function registerScope(
      registry: HelpRegistry,
      owner: string,
      scope: string,
      summary: string,
      keys: Array<{ key: string; description: string }>,
    ): void {
      registry.register(owner, [
        {
          command: `.set ${scope}`,
          flags: 'n',
          usage: `.set ${scope} <key> [value]`,
          description: summary,
          category: `set:${scope}`,
        },
        ...keys.map((k) => ({
          command: `.set ${scope} ${k.key}`,
          flags: 'n',
          usage: `.set ${scope} ${k.key} <string>`,
          description: k.description,
          category: `set:${scope}`,
        })),
      ]);
    }

    it('!help corpus excludes settings entries even for privileged users (prefix isolation)', async () => {
      await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
      // Even with the operator flag, `.set ...` entries don't surface in
      // the channel-facing `!help` index — they belong to the admin
      // `.help` corpus served by the core dot-command path.
      permissions.addUser('admin', 'user1!user@host.com', 'n', 'test');
      permissions.loadFromDb();

      registerScope(helpRegistry, 'bot', 'core', 'Bot-wide singletons', [
        { key: 'logging.level', description: 'Log level' },
        { key: 'queue.rate', description: 'Outbound rate' },
      ]);
      registerScope(helpRegistry, 'rss', 'rss', 'RSS feed announcer', [
        { key: 'dedup_window_days', description: 'Dedup window' },
      ]);

      const ctx = makeCtx({ nick: 'user1', ident: 'user', hostname: 'host.com' });
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      // No settings-scope content surfaces under `!help`.
      expect(messages.some((m) => m.includes('[settings]'))).toBe(false);
      expect(messages.some((m) => m.includes('Bot-wide singletons'))).toBe(false);
      expect(messages.some((m) => m.includes('RSS feed announcer'))).toBe(false);
      expect(messages.some((m) => m.includes('logging.level'))).toBe(false);
      expect(messages.some((m) => m.includes('dedup_window_days'))).toBe(false);
    });

    it('omits the settings index entirely when no set:* entries are visible', async () => {
      await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
      helpRegistry.register('8ball', [BALL_ENTRY]);

      const ctx = makeCtx();
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      expect(messages.some((m) => m.includes('[settings]'))).toBe(false);
    });

    it('hides set:* entries from unprivileged users (per-entry flag filter)', async () => {
      await loadHelp({ help: { enabled: true, config: { cooldown_ms: 0 } } });
      registerScope(helpRegistry, 'bot', 'core', 'Bot-wide singletons', [
        { key: 'logging.level', description: 'Log level' },
      ]);

      // user1 has no flags — settings entries (flags 'n') are filtered out.
      const ctx = makeCtx();
      await dispatcher.dispatch('pub', ctx);

      const messages = mockNotice.mock.calls.map((c) => c[1]);
      expect(messages.some((m) => m.includes('[settings]'))).toBe(false);
      expect(messages.some((m) => m.includes('core'))).toBe(false);
    });
  });
});
