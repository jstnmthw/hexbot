import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { themeNames } from '../../plugins/topic/themes';
import { type MockBot, createMockBot } from '../helpers/mock-bot';
import { giveBotOps, simulatePrivmsg, tick } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/topic/index.ts');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('topic plugin', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');

    // Add an opped user for command tests
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterEach(() => {
    bot.cleanup();
  });

  it('!topic with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Usage'),
    );
    expect(reply).toBeDefined();
  });

  it('!topic with unknown theme — should report error', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic nonexistent Hello world');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Unknown theme'),
    );
    expect(reply).toBeDefined();
  });

  it('!topic with valid theme — should set topic', async () => {
    const themeName = themeNames[0]; // Use first available theme
    simulatePrivmsg(
      bot,
      'Admin',
      'admin',
      'admin.host',
      '#test',
      `!topic ${themeName} Hello world`,
    );
    await tick();

    const topicMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('TOPIC'),
    );
    expect(topicMsg).toBeDefined();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Topic set'),
    );
    expect(reply).toBeDefined();
  });

  it('!topic preview — should show formatted text in channel', async () => {
    const themeName = themeNames[0];
    simulatePrivmsg(
      bot,
      'Admin',
      'admin',
      'admin.host',
      '#test',
      `!topic preview ${themeName} Preview text`,
    );
    await tick();

    // The preview should output formatted text via notice to nick, not set topic
    const noticeMsg = bot.client.messages.find(
      (m) => m.type === 'notice' && m.target === 'Admin' && m.message?.includes('Preview text'),
    );
    expect(noticeMsg).toBeDefined();

    // Should NOT set the actual topic
    const topicMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('TOPIC'),
    );
    expect(topicMsg).toBeUndefined();
  });

  it('!topic preview with unknown theme — should report error', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic preview faketheme Hello');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Unknown theme'),
    );
    expect(reply).toBeDefined();
  });

  it('!topic preview with insufficient args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic preview');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Usage'),
    );
    expect(reply).toBeDefined();
  });

  it('!topics — should list available themes', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topics');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Available themes'),
    );
    expect(reply).toBeDefined();
    // Should include at least one known theme name
    expect(reply!.message).toContain(themeNames[0]);
  });

  it('!topics preview with no text — uses default "Sample Topic Text"', async () => {
    // No text after "preview" — uses fallback sample text
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topics preview');
    await tick();

    // Should send previews mentioning the default sample text
    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Sample Topic Text'),
    );
    expect(reply).toBeDefined();
  });

  it('!topics preview cooldown — second call within window is rejected', async () => {
    // First call — succeeds and sets the cooldown
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topics preview hello');
    await tick();
    bot.client.clearMessages();

    // Second call immediately — should hit the cooldown branch
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topics preview hello');
    await tick();

    const cooldownReply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.target === 'Admin' && m.message?.includes('cooldown'),
    );
    expect(cooldownReply).toBeDefined();
    expect(cooldownReply!.message).toMatch(/Preview cooldown active/);
  });

  it('!topic <theme> with no text — should show usage', async () => {
    const themeName = themeNames[0];
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', `!topic ${themeName}`);
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Usage'),
    );
    expect(reply).toBeDefined();
  });

  it('teardown — should not throw', async () => {
    await bot.pluginLoader.unload('topic');
    expect(bot.pluginLoader.isLoaded('topic')).toBe(false);
  });

  it('should warn when formatted topic exceeds 390 bytes', async () => {
    // Create a very long text that will exceed 390 bytes after theming
    const longText = 'A'.repeat(400);
    const themeName = themeNames[0];
    simulatePrivmsg(
      bot,
      'Admin',
      'admin',
      'admin.host',
      '#test',
      `!topic ${themeName} ${longText}`,
    );
    await tick();

    const warning = bot.client.messages.find(
      (m) => m.type === 'notice' && m.message?.includes('Warning'),
    );
    expect(warning).toBeDefined();
    // Warning now expresses the limit in bytes (UTF-8 byte length), not
    // UTF-16 code units, so multi-byte code points aren't silently
    // over-permitted against a byte-counted server cap.
    expect(warning!.message).toContain('bytes');
  });

  // ---------------------------------------------------------------------------
  // !topic lock / !topic unlock
  // ---------------------------------------------------------------------------

  describe('!topic lock', () => {
    function setLiveTopic(b: MockBot, channel: string, topic: string): void {
      // Channel-state ignores TOPIC for channels we never joined (the
      // [C-ENSURECHAN] containment). If the channel record is missing,
      // bootstrap it with a JOIN; if it already exists (e.g. giveBotOps
      // already simulated a bot-join), don't re-join — that would
      // clobber the bot's user-modes record.
      if (!b.channelState.getChannel(channel)) {
        b.client.simulateEvent('join', {
          nick: 'hexbot',
          ident: 'hexbot',
          hostname: 'host',
          channel,
        });
      }
      b.client.simulateEvent('topic', {
        nick: 'server',
        ident: '',
        hostname: '',
        channel,
        topic,
      });
    }

    it('locks the current live topic', async () => {
      setLiveTopic(bot, '#test', 'Welcome to #test!');
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic lock');
      await tick();

      expect(bot.channelSettings.get('#test', 'topic_lock')).toBe(true);
      expect(bot.channelSettings.get('#test', 'topic_text')).toBe('Welcome to #test!');

      const reply = bot.client.messages.find(
        (m) => m.type === 'notice' && m.message?.includes('locked'),
      );
      expect(reply).toBeDefined();
    });

    it('reports error when no topic is set', async () => {
      // No live topic set — channel will have empty string
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic lock');
      await tick();

      expect(bot.channelSettings.get('#test', 'topic_lock')).toBe(false);
      const reply = bot.client.messages.find(
        (m) => m.type === 'notice' && m.message?.includes('Cannot lock'),
      );
      expect(reply).toBeDefined();
    });

    it('warns when live topic exceeds 390 chars but still locks', async () => {
      const longTopic = 'A'.repeat(400);
      setLiveTopic(bot, '#test', longTopic);
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic lock');
      await tick();

      expect(bot.channelSettings.get('#test', 'topic_lock')).toBe(true);
      expect(bot.channelSettings.get('#test', 'topic_text')).toBe(longTopic);
      const warning = bot.client.messages.find(
        (m) => m.type === 'notice' && m.message?.includes('Warning'),
      );
      expect(warning).toBeDefined();
    });
  });

  describe('!topic unlock', () => {
    it('disables topic protection', async () => {
      bot.channelSettings.set('#test', 'topic_lock', true);
      bot.channelSettings.set('#test', 'topic_text', 'some locked topic');

      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic unlock');
      await tick();

      expect(bot.channelSettings.get('#test', 'topic_lock')).toBe(false);
      expect(bot.channelSettings.get('#test', 'topic_text')).toBe('');
      const reply = bot.client.messages.find(
        (m) => m.type === 'notice' && m.message?.includes('disabled'),
      );
      expect(reply).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Protection integration (lock → change → restore)
  // ---------------------------------------------------------------------------

  describe('topic protection integration', () => {
    async function advancePastGrace(): Promise<void> {
      await vi.advanceTimersByTimeAsync(5001);
      await Promise.resolve();
    }

    function setLiveTopic(b: MockBot, channel: string, topic: string): void {
      // [C-ENSURECHAN] containment: TOPIC for an unjoined channel is dropped.
      // Simulate a JOIN only when no record exists — re-joining a channel
      // would otherwise overwrite the bot's user-modes (e.g. +o set by
      // `giveBotOps`) since onJoin reseats the user record from scratch.
      if (!b.channelState.getChannel(channel)) {
        b.client.simulateEvent('join', {
          nick: 'hexbot',
          ident: 'hexbot',
          hostname: 'host',
          channel,
        });
      }
      b.client.simulateEvent('topic', {
        nick: 'server',
        ident: '',
        hostname: '',
        channel,
        topic,
      });
    }

    it('topic_lock enabled but no topic_text stored → no restore', async () => {
      // topic_lock is on but topic_text is empty — guard returns early
      bot.channelSettings.set('#test', 'topic_lock', true);
      // do NOT set topic_text — it stays as '' (falsy)
      await advancePastGrace();
      bot.client.clearMessages();

      bot.client.simulateEvent('topic', {
        nick: 'someuser',
        ident: 'user',
        hostname: 'user.host',
        channel: '#test',
        topic: 'anything',
      });
      await tick();

      // No TOPIC restore since there's nothing to enforce
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.startsWith('TOPIC')),
      ).toBeUndefined();

      // Cleanup
      bot.channelSettings.set('#test', 'topic_lock', false);
    });

    it('non-op change after lock → bot restores enforced topic', async () => {
      // Bot must hold `+o` on the channel for the restore path to fire —
      // without ops the plugin now skips the restore to avoid burning the
      // message-queue on a takeover.
      giveBotOps(bot, '#test');
      setLiveTopic(bot, '#test', 'locked topic');
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic lock');
      await tick();

      await advancePastGrace();
      bot.client.clearMessages();

      // Non-op changes the topic
      bot.client.simulateEvent('topic', {
        nick: 'someuser',
        ident: 'user',
        hostname: 'user.host',
        channel: '#test',
        topic: 'rogue topic',
      });
      await tick();

      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(1);
      expect(topicCmds[0].message).toContain('locked topic');
    });

    it('authorized op change while locked → updates stored topic', async () => {
      setLiveTopic(bot, '#test', 'original topic');
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic lock');
      await tick();

      await advancePastGrace();
      bot.client.clearMessages();

      // Op (Admin has +o) changes the topic to something different
      bot.client.simulateEvent('topic', {
        nick: 'Admin',
        ident: 'admin',
        hostname: 'admin.host',
        channel: '#test',
        topic: 'new authorized topic',
      });
      await tick();

      // No restore should happen
      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(0);

      // Stored topic should be updated to the authorized change
      expect(bot.channelSettings.get('#test', 'topic_text')).toBe('new authorized topic');
    });

    it('non-op change after unlock → bot does NOT restore', async () => {
      bot.channelSettings.set('#test', 'topic_lock', true);
      bot.channelSettings.set('#test', 'topic_text', 'was locked');

      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic unlock');
      await tick();

      await advancePastGrace();
      bot.client.clearMessages();

      bot.client.simulateEvent('topic', {
        nick: 'someuser',
        ident: 'user',
        hostname: 'user.host',
        channel: '#test',
        topic: 'new topic',
      });
      await tick();

      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Echo-loop fix
  // ---------------------------------------------------------------------------

  describe('topic protection echo loop', () => {
    async function advancePastGrace(): Promise<void> {
      await vi.advanceTimersByTimeAsync(5001);
      await Promise.resolve();
    }

    it("bot's own TOPIC echo (matching enforced text) does not trigger another TOPIC command", async () => {
      // Set up channel state with a locked topic
      bot.channelSettings.set('#test', 'topic_text', 'locked text');
      bot.channelSettings.set('#test', 'topic_lock', true);

      await advancePastGrace();
      bot.client.clearMessages();

      // Simulate the bot's own echo: setter = botNick, topic = enforced text
      bot.client.simulateEvent('topic', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'localhost',
        channel: '#test',
        topic: 'locked text',
      });
      await tick();

      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(0);
    });

    it('unauthorized topic change (different text) triggers one restore', async () => {
      // Bot must hold `+o` on the channel for the restore path to fire —
      // without ops the plugin now skips the restore to avoid burning the
      // message-queue on a takeover.
      giveBotOps(bot, '#test');
      bot.channelSettings.set('#test', 'topic_text', 'locked text');
      bot.channelSettings.set('#test', 'topic_lock', true);

      await advancePastGrace();
      bot.client.clearMessages();

      // Non-op changes the topic
      bot.client.simulateEvent('topic', {
        nick: 'someuser',
        ident: 'user',
        hostname: 'user.host',
        channel: '#test',
        topic: 'rogue topic',
      });
      await tick();

      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(1);
      expect(topicCmds[0].message).toContain('locked text');
    });

    it('unauthorized topic change with bot deopped → no restore', async () => {
      // Without ops, the restore path is skipped outright so a takeover
      // that deops the bot can't trigger the bot to flood its message
      // queue with rejected TOPIC attempts.
      bot.channelSettings.set('#test', 'topic_text', 'locked text');
      bot.channelSettings.set('#test', 'topic_lock', true);

      await advancePastGrace();
      bot.client.clearMessages();

      bot.client.simulateEvent('topic', {
        nick: 'someuser',
        ident: 'user',
        hostname: 'user.host',
        channel: '#test',
        topic: 'rogue topic',
      });
      await tick();

      const topicCmds = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('TOPIC'),
      );
      expect(topicCmds).toHaveLength(0);
    });
  });
});
