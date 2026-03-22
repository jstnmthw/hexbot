import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { themeNames } from '../../plugins/topic/themes.js';
import { type MockBot, createMockBot } from '../helpers/mock-bot.js';

const PLUGIN_PATH = resolve('./plugins/topic/index.ts');

function simulatePrivmsg(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
  message: string,
): void {
  bot.client.simulateEvent('privmsg', { nick, ident, hostname, target: channel, message });
}

async function tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

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

    const reply = bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage'));
    expect(reply).toBeDefined();
  });

  it('!topic with unknown theme — should report error', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic nonexistent Hello world');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Unknown theme'),
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
      (m) => m.type === 'say' && m.message?.includes('Topic set'),
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

    // The preview should output formatted text via say, not set topic
    const sayMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === '#test' && m.message?.includes('Preview text'),
    );
    expect(sayMsg).toBeDefined();

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
      (m) => m.type === 'say' && m.message?.includes('Unknown theme'),
    );
    expect(reply).toBeDefined();
  });

  it('!topic preview with insufficient args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topic preview');
    await tick();

    const reply = bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage'));
    expect(reply).toBeDefined();
  });

  it('!topics — should list available themes', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!topics');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Available themes'),
    );
    expect(reply).toBeDefined();
    // Should include at least one known theme name
    expect(reply!.message).toContain(themeNames[0]);
  });

  it('!topic <theme> with no text — should show usage', async () => {
    const themeName = themeNames[0];
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', `!topic ${themeName}`);
    await tick();

    const reply = bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage'));
    expect(reply).toBeDefined();
  });

  it('teardown — should not throw', async () => {
    await bot.pluginLoader.unload('topic');
    expect(bot.pluginLoader.isLoaded('topic')).toBe(false);
  });

  it('should warn when formatted topic exceeds 390 chars', async () => {
    // Create a very long text that will exceed 390 chars after theming
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
      (m) => m.type === 'say' && m.message?.includes('Warning'),
    );
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('chars');
  });
});
