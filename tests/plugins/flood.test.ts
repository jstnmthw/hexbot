import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type MockBot, createMockBot } from '../helpers/mock-bot';

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

function simulateNick(
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

function giveBotOps(bot: MockBot, channel: string): void {
  const nick = bot.client.user.nick;
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
// Nick-change spam tests
// ---------------------------------------------------------------------------

describe('flood plugin — nick-change spam', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          nick_threshold: 3,
          nick_window_secs: 60,
          actions: ['warn', 'kick'],
          ignore_ops: false,
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

  it('warns on nick-change flood', async () => {
    // Exceed threshold of 3 nick changes
    for (let i = 0; i < 4; i++) {
      simulateNick(bot, 'NickSpammer', 'spam', 'spam.host', `NickSpammer${i}`);
    }
    await flush();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' && m.target === 'NickSpammer3' && m.message?.includes('flood'),
      ),
    ).toBeDefined();
  });

  it('skips punishment when bot has no ops in any config channel', async () => {
    const bot2 = createMockBot({ botNick: 'hexbot' });
    // Do NOT give bot ops
    await bot2.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: { nick_threshold: 2, nick_window_secs: 60, actions: ['kick'] },
      },
    });

    for (let i = 0; i < 4; i++) {
      simulateNick(bot2, 'NickFlooder', 'f', 'f.host', `NickFlooder${i}`);
    }
    await flush();

    expect(
      bot2.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
    ).toBeUndefined();
    bot2.cleanup();
  });

  it('skips when hostmask data is incomplete', async () => {
    // ident and hostname both empty — handler returns early
    bot.client.simulateEvent('nick', {
      nick: 'Ghost',
      ident: '',
      hostname: '',
      new_nick: 'Ghost2',
    });
    bot.client.simulateEvent('nick', {
      nick: 'Ghost',
      ident: '',
      hostname: '',
      new_nick: 'Ghost3',
    });
    bot.client.simulateEvent('nick', {
      nick: 'Ghost',
      ident: '',
      hostname: '',
      new_nick: 'Ghost4',
    });
    bot.client.simulateEvent('nick', {
      nick: 'Ghost',
      ident: '',
      hostname: '',
      new_nick: 'Ghost5',
    });
    await flush();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' || (m.type === 'raw' && m.message?.includes('KICK')),
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Join flood tests
// ---------------------------------------------------------------------------

describe('flood plugin — join flood', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          join_threshold: 2,
          join_window_secs: 60,
          actions: ['warn', 'kick'],
          ignore_ops: false,
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

  it('warns on join flood exceeding threshold', async () => {
    // Same hostmask joins 3 times — threshold is 2, 3rd triggers flood
    for (let i = 0; i < 3; i++) {
      simulateJoin(bot, 'JoinFlooder', 'bad', 'bad.host', '#test');
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' && m.target === 'JoinFlooder' && m.message?.includes('flood'),
      ),
    ).toBeDefined();
  });

  it("ignores the bot's own join events", async () => {
    for (let i = 0; i < 5; i++) {
      simulateJoin(bot, 'hexbot', 'bot', 'bot.host', '#test');
    }
    await flush();
    expect(bot.client.messages.find((m) => m.type === 'notice')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timed ban cleanup (time bind fires every 60s)
// ---------------------------------------------------------------------------

describe('flood plugin — time bind ban cleanup', () => {
  let bot: MockBot;

  // Fake timers must be installed BEFORE the plugin loads so the setInterval
  // created by the 'time' bind is captured by vitest's fake timer system.
  beforeEach(async () => {
    vi.useFakeTimers();
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          msg_threshold: 5,
          msg_window_secs: 3,
          actions: ['warn', 'kick', 'tempban'],
          ban_duration_minutes: 10,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterEach(() => {
    vi.useRealTimers();
    bot.cleanup();
  });

  it('lifts expired bans when the 60s time bind fires', () => {
    // Insert an already-expired ban record directly into the flood plugin's db namespace
    const mask = '*!bad@bad.host';
    const expiredRecord = JSON.stringify({
      mask,
      channel: '#test',
      ts: Date.now() - 11 * 60_000,
      expires: Date.now() - 60_000, // expired 1 minute ago
    });
    bot.db.set('flood', `ban:#test:${mask}`, expiredRecord);
    expect(bot.db.get('flood', `ban:#test:${mask}`)).toBeTruthy();

    // Fire the time bind (every 60 seconds)
    vi.advanceTimersByTime(60_000);

    // Bot has ops in #test, so the ban should be lifted and record deleted
    const unbanCmd = bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('-b'));
    expect(unbanCmd).toBeDefined();
    expect(bot.db.get('flood', `ban:#test:${mask}`)).toBeNull();
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
