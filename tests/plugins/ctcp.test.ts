import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type MockBot, createMockBot } from '../helpers/mock-bot';
import { flush } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/ctcp/index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateCtcp(bot: MockBot, nick: string, type: string, message: string): void {
  bot.client.simulateEvent('ctcp request', {
    nick,
    ident: 'user',
    hostname: 'host.com',
    target: 'testbot',
    type,
    message,
  });
}

// ---------------------------------------------------------------------------
// Core CTCP replies
// ---------------------------------------------------------------------------

describe('ctcp plugin', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('replies to VERSION with bot name and version', async () => {
    simulateCtcp(bot, 'curious', 'VERSION', '');
    await flush();

    const resp = bot.client.messages.find((m) => m.type === 'ctcpResponse');
    expect(resp).toBeDefined();
    expect(resp!.target).toBe('curious');
    expect(resp!.message).toMatch(/^VERSION hexbot v\d/);
  });

  it('replies to PING by echoing the payload', async () => {
    simulateCtcp(bot, 'pinger', 'PING', '1234567890');
    await flush();

    const resp = bot.client.messages.find((m) => m.type === 'ctcpResponse');
    expect(resp).toBeDefined();
    expect(resp!.target).toBe('pinger');
    expect(resp!.message).toBe('PING 1234567890');
  });

  it('replies to TIME with a time string', async () => {
    simulateCtcp(bot, 'timecheck', 'TIME', '');
    await flush();

    const resp = bot.client.messages.find((m) => m.type === 'ctcpResponse');
    expect(resp).toBeDefined();
    expect(resp!.target).toBe('timecheck');
    expect(resp!.message).toMatch(/^TIME .+/);
  });

  it('does not reply to SOURCE', async () => {
    simulateCtcp(bot, 'curious', 'SOURCE', '');
    await flush();

    expect(bot.client.messages.find((m) => m.type === 'ctcpResponse')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('ctcp plugin — teardown', () => {
  it('unloads cleanly', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    await bot.pluginLoader.load(PLUGIN_PATH);
    await bot.pluginLoader.unload('ctcp');
    expect(bot.pluginLoader.isLoaded('ctcp')).toBe(false);
    bot.cleanup();
  });
});
