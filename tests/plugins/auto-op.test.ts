import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { createMockBot, type MockBot } from '../helpers/mock-bot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_PATH = resolve('./plugins/auto-op/index.ts');

function simulateJoin(bot: MockBot, nick: string, ident: string, hostname: string, channel: string): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

/** Wait for async join handlers to fire. */
async function tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto-op plugin', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
  });

  afterEach(() => {
    bot.cleanup();
  });

  it('should op a user with +o flag on join', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    simulateJoin(bot, 'Alice', 'alice', 'alice.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should voice a user with +v flag on join', async () => {
    bot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');

    simulateJoin(bot, 'Bob', 'bob', 'bob.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should op a user with +n flag (owner implies op)', async () => {
    bot.permissions.addUser('owner', '*!owner@owner.host', 'n', 'test');

    simulateJoin(bot, 'Owner', 'owner', 'owner.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Owner')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should do nothing for unknown user', async () => {
    simulateJoin(bot, 'Stranger', 'stranger', 'unknown.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should not op user with flags for different channel only', async () => {
    bot.permissions.addUser('channeluser', '*!cu@cu.host', '', 'test');
    bot.permissions.setChannelFlags('channeluser', '#other', 'o', 'test');

    simulateJoin(bot, 'ChannelUser', 'cu', 'cu.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should op user with channel-specific +o flag', async () => {
    bot.permissions.addUser('chanop', '*!cop@cop.host', '', 'test');
    bot.permissions.setChannelFlags('chanop', '#test', 'o', 'test');

    simulateJoin(bot, 'ChanOp', 'cop', 'cop.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('ChanOp')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should not op/voice the bot itself', async () => {
    bot.permissions.addUser('botuser', '*!n0xb0t@bot.host', 'o', 'test');

    simulateJoin(bot, 'n0xb0t', 'n0xb0t', 'bot.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should op user with +m flag (master implies op)', async () => {
    bot.permissions.addUser('master', '*!master@master.host', 'mo', 'test');

    simulateJoin(bot, 'Master', 'master', 'master.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Master')
    );
    expect(modeMsg).toBeDefined();
  });
});
