import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type MockBot, createMockBot } from '../helpers/mock-bot.js';

const PLUGIN_PATH = resolve('./plugins/flood/index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function simulateJoin(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

function _simulateNick(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  newNick: string,
): void {
  bot.client.simulateEvent('nick', { nick, ident, hostname, new_nick: newNick });
}

async function flush(): Promise<void> {
  await Promise.resolve();
}

async function _tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

function giveBotOps(bot: MockBot, channel: string): void {
  const nick = (bot.client.user as { nick: string }).nick;
  bot.client.simulateEvent('join', { nick, ident: 'bot', hostname: 'bot.host', channel });
  bot.client.simulateEvent('mode', {
    nick: 'ChanServ',
    ident: 'ChanServ',
    hostname: 'services.',
    target: channel,
    modes: [{ mode: '+o', param: nick }],
  });
}

// ---------------------------------------------------------------------------
// Message flood tests
// ---------------------------------------------------------------------------

describe('flood plugin — message flood', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          msg_threshold: 3,
          msg_window_secs: 10,
          actions: ['warn', 'kick', 'tempban'],
          ignore_ops: true,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('no action below threshold', async () => {
    for (let i = 0; i < 3; i++) {
      simulatePrivmsg(bot, 'Flooder', 'bad', 'bad.host', '#test', `msg ${i}`);
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' || (m.type === 'raw' && m.message?.includes('KICK')),
      ),
    ).toBeUndefined();
  });

  it('warns on first flood offence', async () => {
    // Send 4 messages to exceed threshold of 3
    for (let i = 0; i < 4; i++) {
      simulatePrivmsg(bot, 'FloodUser', 'bad', 'bad.host', '#test', `msg ${i}`);
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' && m.target === 'FloodUser' && m.message?.includes('flood'),
      ),
    ).toBeDefined();
  });

  it('kicks on second flood offence', async () => {
    // First flood already recorded from previous test — send another burst
    for (let i = 0; i < 4; i++) {
      simulatePrivmsg(bot, 'FloodUser', 'bad', 'bad.host', '#test', `burst2 msg ${i}`);
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('FloodUser'),
      ),
    ).toBeDefined();
  });

  it('does nothing when bot has no ops', async () => {
    const bot2 = createMockBot({ botNick: 'hexbot' });
    // Do NOT give bot ops
    await bot2.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: { msg_threshold: 3, msg_window_secs: 10, actions: ['kick'] },
      },
    });

    for (let i = 0; i < 5; i++) {
      simulatePrivmsg(bot2, 'BadUser', 'bad', 'bad.host', '#test', `msg ${i}`);
    }
    await flush();
    expect(
      bot2.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
    ).toBeUndefined();
    bot2.cleanup();
  });

  it("ignores the bot's own messages", async () => {
    for (let i = 0; i < 10; i++) {
      simulatePrivmsg(bot, 'hexbot', 'bot', 'bot.host', '#test', `msg ${i}`);
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' || (m.type === 'raw' && m.message?.includes('KICK')),
      ),
    ).toBeUndefined();
  });

  it('ignores privileged users (ops)', async () => {
    bot.permissions.addUser('opuser', '*!opuser@op.host', 'o', 'test');
    // Must simulate join so getUserHostmask can resolve OpUser's hostmask
    simulateJoin(bot, 'OpUser', 'opuser', 'op.host', '#test');
    bot.client.clearMessages();
    for (let i = 0; i < 10; i++) {
      simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', `msg ${i}`);
    }
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'notice' && m.target === 'OpUser'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timed tempban tests
// ---------------------------------------------------------------------------

describe('flood plugin — tempban storage', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          msg_threshold: 1,
          msg_window_secs: 10,
          ban_duration_minutes: 5,
          actions: ['tempban'],
          ignore_ops: false,
        },
      },
    });
    // Add user to channel state
    bot.client.simulateEvent('join', {
      nick: 'Spammer',
      ident: 'spam',
      hostname: 'spam.host',
      channel: '#test',
    });
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('tempban stores a DB record with expiry', async () => {
    simulatePrivmsg(bot, 'Spammer', 'spam', 'spam.host', '#test', 'msg1');
    simulatePrivmsg(bot, 'Spammer', 'spam', 'spam.host', '#test', 'msg2');
    await flush();

    // Should have a ban record in DB
    const bans = bot.db.list('flood', 'ban:');
    expect(bans.length).toBeGreaterThan(0);
    const record = JSON.parse(bans[0].value) as { expires: number };
    expect(record.expires).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('flood plugin — teardown', () => {
  it('clears state on unload', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    await bot.pluginLoader.load(PLUGIN_PATH);
    await bot.pluginLoader.unload('flood');
    expect(bot.pluginLoader.isLoaded('flood')).toBe(false);
    bot.cleanup();
  });
});
