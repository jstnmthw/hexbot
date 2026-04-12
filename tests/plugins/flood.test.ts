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

  it('does not crash when bot user is missing from channel state', async () => {
    const bot2 = createMockBot({ botNick: 'hexbot' });
    // Join a different user so the channel exists, but the bot itself is NOT in channel state
    simulateJoin(bot2, 'SomeUser', 'some', 'some.host', '#nochan');
    await bot2.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#nochan'],
        config: { msg_threshold: 3, msg_window_secs: 10, actions: ['kick'] },
      },
    });

    // Flood from a user — botHasOps should return false without throwing
    for (let i = 0; i < 5; i++) {
      simulatePrivmsg(bot2, 'BadUser', 'bad', 'bad.host', '#nochan', `msg ${i}`);
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
// Permanent ban storage (ban_duration_minutes: 0)
// ---------------------------------------------------------------------------

describe('flood plugin — permanent ban (ban_duration_minutes: 0)', () => {
  it('stores ban record with expires=0 when duration is 0', async () => {
    const bot2 = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot2, '#test');
    try {
      await bot2.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 1,
            msg_window_secs: 10,
            ban_duration_minutes: 0, // permanent ban
            actions: ['tempban'],
            ignore_ops: false,
          },
        },
      });
      bot2.client.simulateEvent('join', {
        nick: 'PermSpammer',
        ident: 'perm',
        hostname: 'perm.host',
        channel: '#test',
      });
      simulatePrivmsg(bot2, 'PermSpammer', 'perm', 'perm.host', '#test', 'msg1');
      simulatePrivmsg(bot2, 'PermSpammer', 'perm', 'perm.host', '#test', 'msg2');
      await flush();

      const bans = bot2.db.list('flood', 'ban:');
      expect(bans.length).toBeGreaterThan(0);
      const record = JSON.parse(bans[0].value) as { expires: number };
      expect(record.expires).toBe(0); // permanent ban has expires=0
    } finally {
      bot2.cleanup();
    }
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
// Join flood — skips privileged user (flood/index.ts line 223)
// ---------------------------------------------------------------------------

describe('flood plugin — join flood skips privileged user', () => {
  it('does not act when the join-flooder has op permission and ignore_ops is true', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: { join_threshold: 2, join_window_secs: 60, actions: ['kick'], ignore_ops: true },
        },
      });
      bot.permissions.addUser('opjoiner', '*!opjoiner@op.host', 'o', 'test');
      giveBotOps(bot, '#test');
      bot.client.clearMessages();

      // Flood: 3 joins exceed threshold of 2
      for (let i = 0; i < 3; i++) {
        simulateJoin(bot, 'OpJoiner', 'opjoiner', 'op.host', '#test');
      }
      await flush();

      // isPrivileged('OpJoiner', '#test', true) → hostmask found → op flag → skip
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
      ).toBeUndefined();
    } finally {
      bot.cleanup();
    }
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

  it('does not lift a permanent ban (expires=0)', () => {
    const mask = '*!perm@perm.host';
    bot.db.set(
      'flood',
      `ban:#test:${mask}`,
      JSON.stringify({ mask, channel: '#test', ts: Date.now() - 60 * 60_000, expires: 0 }),
    );

    vi.advanceTimersByTime(60_000);

    // Permanent ban (expires=0) must never be removed
    expect(bot.db.get('flood', `ban:#test:${mask}`)).toBeTruthy();
  });

  it('does not lift a ban that has not yet expired', () => {
    const mask = '*!future@future.host';
    bot.db.set(
      'flood',
      `ban:#test:${mask}`,
      JSON.stringify({
        mask,
        channel: '#test',
        ts: Date.now(),
        expires: Date.now() + 10 * 60_000, // expires 10 minutes from now
      }),
    );

    vi.advanceTimersByTime(60_000);

    // Not-yet-expired ban must remain
    expect(bot.db.get('flood', `ban:#test:${mask}`)).toBeTruthy();
  });

  it('does not unban when bot has no ops in the ban channel', () => {
    const mask = '*!noops@noops.host';
    bot.db.set(
      'flood',
      `ban:#other:${mask}`,
      JSON.stringify({
        mask,
        channel: '#other', // bot has no ops in #other (never joined)
        ts: Date.now() - 30 * 60_000,
        expires: Date.now() - 60_000,
      }),
    );

    vi.advanceTimersByTime(60_000);

    // Bot has no ops in #other, so ban record must remain
    expect(bot.db.get('flood', `ban:#other:${mask}`)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// isPrivileged — user found in permissions DB (covers lines 92-94)
// ---------------------------------------------------------------------------

describe('flood plugin — isPrivileged with DB lookup', () => {
  it('skips message flood for a user with op permission when ignore_ops is true', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 2,
            msg_window_secs: 10,
            actions: ['warn'],
            ignore_ops: true,
          },
        },
      });
      // Put the user into channel-state (so getUserHostmask returns a value)
      bot.client.simulateEvent('join', {
        nick: 'OpUser',
        ident: 'opuser',
        hostname: 'op.host',
        channel: '#test',
      });
      // Register the user in the permissions DB with an op flag
      bot.permissions.addUser('opuser', '*!opuser@op.host', 'o', 'admin');
      bot.client.clearMessages();

      // Flood — would normally trigger warn, but user is privileged
      for (let i = 0; i < 5; i++) {
        simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', `msg ${i}`);
      }
      await flush();

      // No flood action because isPrivileged returns true
      expect(bot.client.messages.find((m) => m.type === 'notice')).toBeUndefined();
    } finally {
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// isPrivileged / buildFloodBanMask / getAction edge cases
// ---------------------------------------------------------------------------

describe('flood plugin — isPrivileged and buildFloodBanMask edge cases', () => {
  it('does NOT skip flood for a user with hostmask but no permissions entry', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 2,
            msg_window_secs: 10,
            actions: ['warn'],
            ignore_ops: true,
          },
        },
      });
      bot.client.simulateEvent('join', {
        nick: 'UnknownUser',
        ident: 'unk',
        hostname: 'unknown.host',
        channel: '#test',
      });
      // Do NOT add UnknownUser to permissions DB
      bot.client.clearMessages();

      for (let i = 0; i < 5; i++) {
        simulatePrivmsg(bot, 'UnknownUser', 'unk', 'unknown.host', '#test', `msg ${i}`);
      }
      await flush();

      // Flood action fires because isPrivileged returns false (user not in DB)
      expect(
        bot.client.messages.find((m) => m.type === 'notice' && m.target === 'UnknownUser'),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
  });

  it('falls back to kick when hostmask ends with @ (empty host)', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 1,
            msg_window_secs: 10,
            actions: ['tempban'],
            ignore_ops: false,
          },
        },
      });
      bot.client.simulateEvent('join', {
        nick: 'EmptyHost',
        ident: 'e',
        hostname: 'real.host',
        channel: '#test',
      });
      // Mutate hostmask to end with @ (empty host after @)
      const userInfo = bot.channelState.getUser('#test', 'EmptyHost');
      userInfo!.hostmask = 'EmptyHost!e@';
      bot.client.clearMessages();

      simulatePrivmsg(bot, 'EmptyHost', 'e', 'real.host', '#test', 'msg1');
      simulatePrivmsg(bot, 'EmptyHost', 'e', 'real.host', '#test', 'msg2');
      await flush();

      // Should kick (fallback) but no ban
      const kickMsg = bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('EmptyHost'),
      );
      expect(kickMsg).toBeDefined();
      const banMsg = bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+b'));
      expect(banMsg).toBeUndefined();
    } finally {
      bot.cleanup();
    }
  });

  it('getAction returns warn for empty actions array', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 1,
            msg_window_secs: 10,
            actions: [],
            ignore_ops: false,
          },
        },
      });
      bot.client.simulateEvent('join', {
        nick: 'EmptyAct',
        ident: 'e',
        hostname: 'empty.host',
        channel: '#test',
      });
      bot.client.clearMessages();

      simulatePrivmsg(bot, 'EmptyAct', 'e', 'empty.host', '#test', 'msg1');
      simulatePrivmsg(bot, 'EmptyAct', 'e', 'empty.host', '#test', 'msg2');
      await flush();

      // With empty actions, getAction falls back to 'warn'
      expect(
        bot.client.messages.find((m) => m.type === 'notice' && m.target === 'EmptyAct'),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// nick flood — isPrivileged skips punishment (flood/index.ts line 246)
// ---------------------------------------------------------------------------

describe('flood plugin — nick flood skips privileged user', () => {
  it('does not kick when nick-spammer has op permission and ignore_ops is true', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: { nick_threshold: 3, nick_window_secs: 60, actions: ['kick'], ignore_ops: true },
        },
      });

      // Pre-add user under the FINAL nick (the new_nick on the flood-trigger event: NickPriv3)
      // so getUserHostmask can find them when isPrivileged fires
      bot.client.simulateEvent('join', {
        nick: 'NickPriv3',
        ident: 'priv',
        hostname: 'priv.host',
        channel: '#test',
      });
      bot.permissions.addUser('privuser', '*!priv@priv.host', 'o', 'test');
      giveBotOps(bot, '#test');
      bot.client.clearMessages();

      // Fire 4 nick events from the same OLD nick (same flood key) — 4th exceeds threshold
      // new_nick increments so the 4th event has new_nick='NickPriv3' (matching channel state)
      for (let i = 0; i < 4; i++) {
        simulateNick(bot, 'NickPriv', 'priv', 'priv.host', `NickPriv${i}`);
      }
      await flush();

      // isPrivileged('NickPriv3', '#test', true) → hostmask found → op flag → return true → no kick
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
      ).toBeUndefined();
    } finally {
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Tempban with malformed hostmask (no '@') — falls back to plain kick
// Covers flood/index.ts lines 186-188
// ---------------------------------------------------------------------------

describe('flood plugin — tempban fallback when buildFloodBanMask returns null', () => {
  it('falls back to kick when getUserHostmask returns a hostmask without @', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            msg_threshold: 1,
            msg_window_secs: 10,
            actions: ['tempban'], // first offence goes straight to tempban
            ignore_ops: false,
          },
        },
      });

      // Join the user so they exist in channel state
      bot.client.simulateEvent('join', {
        nick: 'BadMask',
        ident: 'bad',
        hostname: 'bad.host',
        channel: '#test',
      });

      // Mutate the stored hostmask to one without '@' so buildFloodBanMask returns null
      const userInfo = bot.channelState.getUser('#test', 'BadMask');
      expect(userInfo).toBeDefined();
      userInfo!.hostmask = 'badmask-no-at-sign';

      bot.client.clearMessages();

      // Trigger flood: 2 messages exceed threshold of 1
      simulatePrivmsg(bot, 'BadMask', 'bad', 'bad.host', '#test', 'msg1');
      simulatePrivmsg(bot, 'BadMask', 'bad', 'bad.host', '#test', 'msg2');
      await flush();

      // Should have kicked (fallback) but NOT set a ban
      const kickMsg = bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('BadMask'),
      );
      expect(kickMsg).toBeDefined();

      // No ban mode should be set since banMask was null
      const banMsg = bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+b'));
      expect(banMsg).toBeUndefined();

      // No ban record in DB
      const bans = bot.db.list('flood', 'ban:');
      expect(bans.length).toBe(0);
    } finally {
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Part flood tests
// ---------------------------------------------------------------------------

function simulatePart(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
  reason = '',
): void {
  bot.client.simulateEvent('part', { nick, ident, hostname, channel, message: reason });
}

describe('flood plugin — part flood', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      flood: {
        enabled: true,
        channels: ['#test'],
        config: {
          part_threshold: 2,
          part_window_secs: 60,
          actions: ['warn', 'kick'],
          ignore_ops: false,
          flood_lock_count: 0, // disable lockdown so we test part flood in isolation
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
    // 2 parts = at threshold, not exceeding
    simulatePart(bot, 'PartUser', 'bad', 'bad.host', '#test');
    simulatePart(bot, 'PartUser', 'bad', 'bad.host', '#test');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'notice' || (m.type === 'raw' && m.message?.includes('KICK')),
      ),
    ).toBeUndefined();
  });

  it('warns on part flood exceeding threshold', async () => {
    // 3 parts from same hostmask — threshold is 2, 3rd triggers flood
    for (let i = 0; i < 3; i++) {
      simulatePart(bot, 'PartFlooder', 'bad', 'bad2.host', '#test', 'spam reason');
    }
    await flush();
    expect(
      bot.client.messages.find(
        (m) =>
          m.type === 'notice' && m.target === 'PartFlooder' && m.message?.includes('part flood'),
      ),
    ).toBeDefined();
  });

  it("ignores the bot's own part events", async () => {
    for (let i = 0; i < 5; i++) {
      simulatePart(bot, 'hexbot', 'bot', 'bot.host', '#test');
    }
    await flush();
    expect(bot.client.messages.find((m) => m.type === 'notice')).toBeUndefined();
  });

  it('skips privileged users when ignore_ops is true', async () => {
    const bot2 = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot2, '#test');
    try {
      await bot2.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            part_threshold: 2,
            part_window_secs: 60,
            actions: ['kick'],
            ignore_ops: true,
            flood_lock_count: 0,
          },
        },
      });
      bot2.permissions.addUser('opuser', '*!opuser@op.host', 'o', 'test');
      bot2.client.clearMessages();

      // Re-join before each part so the user stays in channel state for hostmask lookup
      for (let i = 0; i < 5; i++) {
        simulateJoin(bot2, 'OpUser', 'opuser', 'op.host', '#test');
        simulatePart(bot2, 'OpUser', 'opuser', 'op.host', '#test');
      }
      await flush();

      expect(
        bot2.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
      ).toBeUndefined();
    } finally {
      bot2.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Channel lockdown tests (join/part flood → +R/+i)
// ---------------------------------------------------------------------------

describe('flood plugin — channel lockdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers +R lockdown when flood_lock_count distinct flooders detected', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 3,
            flood_lock_window: 60,
            flood_lock_duration: 30,
            flood_lock_mode: 'R',
          },
        },
      });
      bot.client.clearMessages();

      // 3 distinct hostmasks each trip the join flood detector (threshold 1 → 2nd join triggers)
      for (let i = 0; i < 3; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      // Should have set +R
      const modeMsg = bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('+R'),
      );
      expect(modeMsg).toBeDefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('auto-lifts lockdown after configured duration', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      // Trip 2 distinct flooders
      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      // Verify lockdown triggered
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeDefined();

      // Advance time past lock duration
      bot.client.clearMessages();
      vi.advanceTimersByTime(31_000);

      // Should have lifted -R
      const unlockMsg = bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('-R'),
      );
      expect(unlockMsg).toBeDefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('uses +i when flood_lock_mode is set to i', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
            flood_lock_mode: 'i',
          },
        },
      });
      bot.client.clearMessages();

      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+i')),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('part floods also contribute to lockdown', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            part_threshold: 1,
            part_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      // First flooder trips via join flood
      simulateJoin(bot, 'JoinFlood', 'jf', 'jf.host', '#test');
      simulateJoin(bot, 'JoinFlood', 'jf', 'jf.host', '#test');
      await flush();

      // Second flooder trips via part flood
      simulatePart(bot, 'PartFlood', 'pf', 'pf.host', '#test');
      simulatePart(bot, 'PartFlood', 'pf', 'pf.host', '#test');
      await flush();

      // Both contribute to lockdown — should trigger +R
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('does not lock when flood_lock_count is 0 (disabled)', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 0, // disabled
          },
        },
      });
      bot.client.clearMessages();

      for (let i = 0; i < 5; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeUndefined();
    } finally {
      bot.cleanup();
    }
  });

  it('does not lock when bot has no ops', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    // Do NOT give bot ops
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      for (let i = 0; i < 3; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeUndefined();
    } finally {
      bot.cleanup();
    }
  });

  it('does not double-lock on continued flooding', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 60,
          },
        },
      });
      bot.client.clearMessages();

      // Trip lockdown
      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      const lockMsgs = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.includes('+R'),
      );
      expect(lockMsgs.length).toBe(1);

      // More flooders arrive while locked — should not set +R again
      for (let i = 10; i < 13; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      const lockMsgs2 = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.includes('+R'),
      );
      expect(lockMsgs2.length).toBe(1); // still just 1
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('does not double-count the same hostmask', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 3,
            flood_lock_window: 60,
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      // One flooder triggers join flood multiple times (same hostmask)
      // Each join after threshold calls recordFloodForLockdown again
      for (let i = 0; i < 6; i++) {
        simulateJoin(bot, 'Repeat', 'r', 'repeat.host', '#test');
      }
      // Second distinct flooder
      simulateJoin(bot, 'Second', 's', 'second.host', '#test');
      simulateJoin(bot, 'Second', 's', 'second.host', '#test');
      await flush();

      // Only 2 distinct hostmasks < 3 threshold — should NOT lock
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('does not count stale flooders outside the lock window', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 3,
            flood_lock_window: 10, // tight 10s window
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      // First flooder at t=0
      simulateJoin(bot, 'Early0', 'e0', 'early0.host', '#test');
      simulateJoin(bot, 'Early0', 'e0', 'early0.host', '#test');
      await flush();

      // Advance past the 10s window so the first flooder's timestamp expires
      vi.advanceTimersByTime(15_000);

      // Two more flooders arrive — but the first is now stale, so only 2 active < 3 threshold
      simulateJoin(bot, 'Late1', 'l1', 'late1.host', '#test');
      simulateJoin(bot, 'Late1', 'l1', 'late1.host', '#test');
      simulateJoin(bot, 'Late2', 'l2', 'late2.host', '#test');
      simulateJoin(bot, 'Late2', 'l2', 'late2.host', '#test');
      await flush();

      // Should NOT lock — only 2 flooders in the 10s window
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });

  it('uses chanset override for flood_lock_mode', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
            flood_lock_mode: 'R', // global default
          },
        },
      });

      // Override per-channel to +i
      bot.channelSettings.set('#test', 'flood_lock_mode', 'i');
      bot.client.clearMessages();

      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();

      // Should use +i from chanset, not +R from global config
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+i')),
      ).toBeDefined();
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Part flood — additional edge cases
// ---------------------------------------------------------------------------

describe('flood plugin — part flood edge cases', () => {
  it('punishes non-privileged part-flooder even with ignore_ops true (no perms entry)', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            part_threshold: 2,
            part_window_secs: 60,
            actions: ['warn'],
            ignore_ops: true,
            flood_lock_count: 0,
          },
        },
      });
      // Do NOT add user to permissions — isPrivileged should return false via knownHostmask path
      bot.client.clearMessages();

      for (let i = 0; i < 3; i++) {
        simulatePart(bot, 'NoPerm', 'np', 'noperm.host', '#test');
      }
      await flush();

      expect(
        bot.client.messages.find(
          (m) => m.type === 'notice' && m.target === 'NoPerm' && m.message?.includes('part flood'),
        ),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
  });

  it('punishes part-flooder when ignore_ops is false (skips privilege check)', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            part_threshold: 2,
            part_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 0,
          },
        },
      });
      // Even with op flag, should be punished because ignore_ops is false
      bot.permissions.addUser('opuser', '*!opuser@op.host', 'o', 'test');
      bot.client.clearMessages();

      for (let i = 0; i < 3; i++) {
        simulatePart(bot, 'OpUser', 'opuser', 'op.host', '#test');
      }
      await flush();

      expect(
        bot.client.messages.find(
          (m) => m.type === 'notice' && m.target === 'OpUser' && m.message?.includes('part flood'),
        ),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
  });

  it('punishes part-flooder who has hostmask in perms but with non-privileged flag', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            part_threshold: 2,
            part_window_secs: 60,
            actions: ['warn'],
            ignore_ops: true,
            flood_lock_count: 0,
          },
        },
      });
      // User exists in perms but only has 'v' flag (not n/m/o)
      bot.permissions.addUser('voiceuser', '*!vu@voice.host', 'v', 'test');
      bot.client.clearMessages();

      for (let i = 0; i < 3; i++) {
        simulatePart(bot, 'VoiceUser', 'vu', 'voice.host', '#test');
      }
      await flush();

      expect(
        bot.client.messages.find(
          (m) =>
            m.type === 'notice' && m.target === 'VoiceUser' && m.message?.includes('part flood'),
        ),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Lockdown — bot loses ops before unlock timer fires
// ---------------------------------------------------------------------------

describe('flood plugin — lockdown lift without ops', () => {
  it('does not send -R when bot lost ops before unlock timer fires', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 30,
          },
        },
      });
      bot.client.clearMessages();

      // Trip lockdown
      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeDefined();

      // Bot loses ops
      bot.client.simulateEvent('mode', {
        nick: 'Attacker',
        ident: 'a',
        hostname: 'a.host',
        target: '#test',
        modes: [{ mode: '-o', param: 'hexbot' }],
      });
      bot.client.clearMessages();

      // Advance past lock duration
      vi.advanceTimersByTime(31_000);

      // Should NOT send -R since bot has no ops
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('-R')),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Config defaults (covers ?? fallback branches when keys are omitted)
// ---------------------------------------------------------------------------

describe('flood plugin — config defaults', () => {
  it('uses sensible defaults when no config is provided', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      // Load with empty config — all ?? defaults must fire
      const result = await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: { enabled: true, channels: ['#test'], config: {} },
      });
      expect(result.status).toBe('ok');

      // Verify default behavior: 6 messages in 3s window exceeds threshold of 5
      bot.client.simulateEvent('join', {
        nick: 'Tester',
        ident: 't',
        hostname: 't.host',
        channel: '#test',
      });
      bot.client.clearMessages();
      for (let i = 0; i < 6; i++) {
        simulatePrivmsg(bot, 'Tester', 't', 't.host', '#test', `msg ${i}`);
      }
      await flush();

      // Default action[0] is 'warn'
      expect(
        bot.client.messages.find((m) => m.type === 'notice' && m.target === 'Tester'),
      ).toBeDefined();
    } finally {
      bot.cleanup();
    }
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

  it('clears active lockdown timers on unload', async () => {
    vi.useFakeTimers();
    const bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    try {
      await bot.pluginLoader.load(PLUGIN_PATH, {
        flood: {
          enabled: true,
          channels: ['#test'],
          config: {
            join_threshold: 1,
            join_window_secs: 60,
            actions: ['warn'],
            ignore_ops: false,
            flood_lock_count: 2,
            flood_lock_window: 60,
            flood_lock_duration: 300,
          },
        },
      });
      bot.client.clearMessages();

      // Trip lockdown
      for (let i = 0; i < 2; i++) {
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
        simulateJoin(bot, `Flood${i}`, `f${i}`, `flood${i}.host`, '#test');
      }
      await flush();
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+R')),
      ).toBeDefined();

      // Unload while lockdown active — timers should be cleared
      await bot.pluginLoader.unload('flood');
      bot.client.clearMessages();

      // Advance past the lock duration — should NOT send -R since plugin unloaded
      vi.advanceTimersByTime(301_000);
      expect(
        bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('-R')),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      bot.cleanup();
    }
  });
});
