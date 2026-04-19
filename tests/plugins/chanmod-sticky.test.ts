// Tests for chanmod sticky ban enforcement.
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type MockBot, createMockBot } from '../helpers/mock-bot';
import { giveBotOps } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('chanmod — sticky ban enforcement', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    // Add a user record with +m so they can manage bans
    bot.permissions.addUser('admin', '*!admin@admin.host', 'm', 'test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('re-applies a sticky ban when -b is detected from another user', async () => {
    bot.banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
    bot.banStore.setSticky('#test', '*!*@evil.com', true);

    // Simulate an op removing the ban
    bot.client.simulateEvent('mode', {
      nick: 'SomeOp',
      ident: 'op',
      hostname: 'op.host',
      target: '#test',
      modes: [{ mode: '-b', param: '*!*@evil.com' }],
    });
    await flush();

    // The bot should re-apply the ban (captured as mode type by mock client)
    const banMsg = bot.client.messages.find(
      (m) =>
        m.type === 'mode' &&
        m.target === '#test' &&
        m.message === '+b' &&
        m.args?.[0] === '*!*@evil.com',
    );
    expect(banMsg).toBeDefined();
  });

  it('does not re-apply a non-sticky ban', async () => {
    bot.banStore.storeBan('#test', '*!*@notsticky.com', 'admin', 0);

    bot.client.simulateEvent('mode', {
      nick: 'SomeOp',
      ident: 'op',
      hostname: 'op.host',
      target: '#test',
      modes: [{ mode: '-b', param: '*!*@notsticky.com' }],
    });
    await flush();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b' && m.args?.[0] === '*!*@notsticky.com',
    );
    expect(banMsg).toBeUndefined();
  });

  it('does not re-apply when the bot itself removed the ban (loop guard)', async () => {
    bot.banStore.storeBan('#test', '*!*@botremoved.com', 'admin', 0);
    bot.banStore.setSticky('#test', '*!*@botremoved.com', true);

    // The bot itself removes the ban
    bot.client.simulateEvent('mode', {
      nick: 'hexbot',
      ident: 'bot',
      hostname: 'bot.host',
      target: '#test',
      modes: [{ mode: '-b', param: '*!*@botremoved.com' }],
    });
    await flush();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b' && m.args?.[0] === '*!*@botremoved.com',
    );
    expect(banMsg).toBeUndefined();
  });
});
