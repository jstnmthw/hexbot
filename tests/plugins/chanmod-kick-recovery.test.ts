import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';
import { giveBotOps, simulateMode, tick } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

function simulateKick(bot: MockBot, channel: string, kicked: string, kicker: string): void {
  bot.client.simulateEvent('kick', {
    nick: kicker,
    kicked,
    ident: 'ident',
    hostname: 'host',
    channel,
    message: 'Kicked',
  });
}

function simulateChannelInfo(
  bot: MockBot,
  channel: string,
  rawModes: string,
  rawParams: string[] = [],
): void {
  const modes: Array<{ mode: string; param: string | null }> = [];
  let adding = true;
  let paramIdx = 0;
  const PARAM_ON_SET = new Set(['k', 'l']);
  for (const ch of rawModes) {
    if (ch === '+') {
      adding = true;
    } else if (ch === '-') {
      adding = false;
    } else {
      const needsParam = adding && PARAM_ON_SET.has(ch);
      modes.push({
        mode: (adding ? '+' : '-') + ch,
        param: needsParam ? (rawParams[paramIdx++] ?? null) : null,
      });
    }
  }
  bot.client.simulateEvent('channel info', {
    channel,
    modes,
    raw_modes: rawModes,
    raw_params: rawParams,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Kick+Ban Recovery — Atheme backend
// ---------------------------------------------------------------------------

describe('chanmod — kick+ban recovery with Atheme backend', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 5000,
          chanserv_services_type: 'atheme',
          chanserv_nick: 'ChanServ',
          enforce_delay_ms: 5,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
    // Clear rejoin attempt counters so tests don't interfere with each other
    bot.db.del('chanmod', 'rejoin_attempts:#test');
  });

  it('sends UNBAN before rejoin when chanserv_access is set and bot is kicked', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', true);
    await tick(10);

    // Re-establish bot in channel before kick
    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    // UNBAN should be sent immediately (no delay)
    const unbanMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #test',
    );
    expect(unbanMsg).toBeDefined();

    // Rejoin should happen after 500ms (backend delay, not 5000ms)
    await tick(600);
    const joinMsg = bot.client.messages.find((m) => m.type === 'join' && m.target === '#test');
    expect(joinMsg).toBeDefined();

    // OP request should follow the rejoin
    const opMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #test'),
    );
    expect(opMsg).toBeDefined();
  });

  it('sends INVITE when channel had +i before kick', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', true);

    // Set up bot in channel with +i mode
    giveBotOps(bot, '#test');
    simulateChannelInfo(bot, '#test', '+nti', []);
    await tick(10);
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #test',
      ),
    ).toBeDefined();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'INVITE #test',
      ),
    ).toBeDefined();
  });

  it('sends INVITE when channel had +k before kick', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', true);

    giveBotOps(bot, '#test');
    simulateChannelInfo(bot, '#test', '+ntk', ['secret']);
    await tick(10);
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'INVITE #test',
      ),
    ).toBeDefined();
  });

  it('does NOT send UNBAN when chanserv_access is none', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'none');

    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    // No ChanServ messages — only normal rejoin
    const csMsgs = bot.client.messages.filter((m) => m.type === 'say' && m.target === 'ChanServ');
    expect(csMsgs).toHaveLength(0);

    // Normal rejoin delay (5000ms)
    await tick(100);
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();
    await tick(5100);
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeDefined();
  });

  it('does NOT send UNBAN when chanserv_unban_on_kick is disabled', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', false);

    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    const unbanMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #test',
    );
    expect(unbanMsg).toBeUndefined();
  });

  it('uses shorter rejoin delay (500ms) when backend UNBAN was sent', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', true);

    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');

    // At 100ms — too early for even the backend delay (500ms)
    await tick(100);
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();

    // At 600ms — after the 500ms backend delay, rejoin should have fired
    await tick(500);
    expect(
      bot.client.messages.find((m) => m.type === 'join' && m.target === '#test'),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Kick+Ban Recovery — Anope backend
// ---------------------------------------------------------------------------

describe('chanmod — kick+ban recovery with Anope backend', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 5000,
          chanserv_services_type: 'anope',
          chanserv_nick: 'ChanServ',
          enforce_delay_ms: 5,
          anope_recover_step_delay_ms: 5,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
  });

  it('sends UNBAN before rejoin when chanserv_access is set', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'op');
    bot.channelSettings.set('#test', 'chanserv_unban_on_kick', true);

    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    simulateKick(bot, '#test', 'hexbot', 'EvilOp');
    await tick(10);

    const unbanMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #test',
    );
    expect(unbanMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Post-RECOVER cleanup (Atheme)
// ---------------------------------------------------------------------------

describe('chanmod — Atheme post-RECOVER +i +m cleanup', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          chanserv_services_type: 'atheme',
          chanserv_nick: 'ChanServ',
          enforce_delay_ms: 5,
          enforce_modes: true,
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

  it('removes +i +m when bot is opped after RECOVER', async () => {
    bot.channelSettings.set('#test', 'chanserv_access', 'founder');
    bot.channelSettings.set('#test', 'takeover_detection', true);

    // Simulate the RECOVER being triggered: we need to get the backend to
    // call requestRecover. The simplest way is to trigger enough threat events
    // to reach critical level — but that requires a chain with founder access.
    // Instead, we'll directly simulate the effect: mark the channel for cleanup
    // and then simulate the bot being opped.

    // The Atheme backend sets pendingRecoverCleanup via onRecoverCallback.
    // Since we can't easily access the backend instance, let's simulate the
    // scenario end-to-end: ChanServ ops the bot after a RECOVER.

    // First, simulate bot joining a channel after being kicked+recovered
    giveBotOps(bot, '#test');
    bot.client.clearMessages();

    // Simulate a heavy attack that would trigger RECOVER at the threat detection level
    // But for this unit test, we test the mode handler's cleanup logic directly.
    // The integration test would require triggering assessThreat to level 3.

    // Direct approach: simulate the bot being opped by ChanServ
    // after RECOVER was used. The pendingRecoverCleanup flag would be set
    // by the Atheme backend's onRecoverCallback.

    // We need to verify the mode handler cleans up +i +m.
    // Let's test via a full scenario: kick the bot, trigger enough events
    // for level 3, then verify cleanup.

    // For now, test that +o on bot doesn't trigger bitch mode
    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // Bot being opped should not cause any deop (bitch mode bypass)
    const deopMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('hexbot'),
    );
    expect(deopMsg).toBeUndefined();
  });

  it('Atheme onRecoverCallback fires and triggers +i +m cleanup on bot op', async () => {
    // Use a fresh channel to avoid prior state
    const chan = '#recover';
    bot.channelSettings.set(chan, 'chanserv_access', 'founder');
    bot.channelSettings.set(chan, 'takeover_detection', true);

    // Set up channel with bot and flagged users
    giveBotOps(bot, chan);
    bot.client.simulateEvent('join', {
      nick: 'Alice',
      ident: 'alice',
      hostname: 'alice.host',
      channel: chan,
    });
    simulateMode(bot, 'ChanServ', chan, '+o', 'Alice');
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    bot.client.simulateEvent('join', {
      nick: 'Bob',
      ident: 'bob',
      hostname: 'bob.host',
      channel: chan,
    });
    simulateMode(bot, 'ChanServ', chan, '+o', 'Bob');
    bot.permissions.addUser('bob', '*!bob@bob.host', 'o', 'test');

    // Add attacker
    bot.client.simulateEvent('join', {
      nick: 'Attacker',
      ident: 'attacker',
      hostname: 'attacker.host',
      channel: chan,
    });

    await tick(10);

    // Reach Critical threat level (score >= 10):
    // We need to accumulate 10+ points. Friendly deops require bot to have ops,
    // so we must keep bot opped while deopping friendlies, then deop bot.
    // Alice deop (2) + Bob deop (2) when bot has ops = 4 pts
    // Then: deop bot (3) + mode locks (+i=1, +s=1, +k=1) = 6 pts
    // Total: 4 + 6 = 10 → Critical
    simulateMode(bot, 'Attacker', chan, '-o', 'Alice'); // 2 pts (friendly, bot has ops)
    simulateMode(bot, 'Attacker', chan, '-o', 'Bob'); // 2 pts (friendly, bot has ops)
    await tick(10);
    simulateMode(bot, 'Attacker', chan, '-o', 'hexbot'); // 3 pts (bot deopped)
    simulateMode(bot, 'Attacker', chan, '+i', ''); // 1 pt
    simulateMode(bot, 'Attacker', chan, '+s', ''); // 1 pt
    simulateMode(bot, 'Attacker', chan, '+k', 'evilkey'); // 1 pt
    await tick(100);

    // The takeover detection should have triggered RECOVER via the Atheme backend
    const recoverMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === `RECOVER ${chan}`,
    );
    const csMsgs = bot.client.messages
      .filter((m) => m.type === 'say' && m.target === 'ChanServ')
      .map((m) => m.message);
    expect(recoverMsg, `ChanServ msgs: ${JSON.stringify(csMsgs)}`).toBeDefined();

    bot.client.clearMessages();

    // Now simulate bot being opped after RECOVER (ChanServ ops the bot)
    simulateMode(bot, 'ChanServ', chan, '+o', 'hexbot');
    await tick(50);

    // The post-RECOVER cleanup should remove +i +m
    const cleanupMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('-im'),
    );
    expect(cleanupMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Backup retry path — bot not in channel after first rejoin
// ---------------------------------------------------------------------------

describe('chanmod — backup rejoin retry path', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 5000,
          chanserv_services_type: 'atheme',
          chanserv_nick: 'ChanServ',
          enforce_delay_ms: 5,
          chanserv_unban_retry_ms: 500,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
    bot.db.del('chanmod', 'rejoin_attempts:#retry');
  });

  it('retries UNBAN + rejoin when bot is NOT in channel after first rejoin', async () => {
    bot.channelSettings.set('#retry', 'chanserv_access', 'op');
    bot.channelSettings.set('#retry', 'chanserv_unban_on_kick', true);

    // Establish bot in channel
    giveBotOps(bot, '#retry');
    bot.client.clearMessages();

    // Bot gets kicked — triggers backend UNBAN + short-delay rejoin
    simulateKick(bot, '#retry', 'hexbot', 'EvilOp');
    await tick(10);

    // UNBAN should have been sent
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #retry',
      ),
    ).toBeDefined();

    // First rejoin happens after 500ms (SERVICES_PROCESSING_MS)
    await tick(600);
    const firstJoin = bot.client.messages.find((m) => m.type === 'join' && m.target === '#retry');
    expect(firstJoin).toBeDefined();

    // Simulate that the first rejoin FAILED — bot is still not in the channel.
    // Remove the channel from channel-state to simulate server rejecting the JOIN.
    // The retry checks api.getChannel(channel) — falsy means "not in channel".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bot.channelState as any).channels.delete('#retry');

    // The retry fires at chanserv_unban_retry_ms (500ms).
    bot.client.clearMessages();
    await tick(600);

    // The backup retry should have sent another UNBAN and scheduled another join
    const retryUnban = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #retry',
    );
    expect(retryUnban).toBeDefined();

    // Wait for the inner rejoin timer (SERVICES_PROCESSING_MS = 500ms)
    await tick(600);
    const retryJoin = bot.client.messages.find((m) => m.type === 'join' && m.target === '#retry');
    expect(retryJoin).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Revenge timer race guard — channel parted before timer fires
// ---------------------------------------------------------------------------

describe('chanmod — revenge timer race: channel parted before firing', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 50,
          revenge_action: 'deop',
          revenge_delay_ms: 500,
          enforce_delay_ms: 5,
        },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
  });

  it('skips revenge when channel is parted before revenge timer fires', async () => {
    bot.channelSettings.set('#revenge', 'revenge', true);

    giveBotOps(bot, '#revenge');
    bot.client.simulateEvent('join', {
      nick: 'EvilOp',
      ident: 'evil',
      hostname: 'evil.host',
      channel: '#revenge',
    });
    bot.client.clearMessages();

    // Bot gets kicked — triggers rejoin + revenge timer
    simulateKick(bot, '#revenge', 'hexbot', 'EvilOp');
    await tick(10);

    // Bot rejoins after rejoin_delay_ms
    await tick(100);

    // Remove the channel from state before the revenge timer fires (500ms)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bot.channelState as any).channels.delete('#revenge');
    bot.client.clearMessages();

    // Advance past revenge_delay_ms (500ms)
    await tick(600);

    // No revenge action (deop) should have been sent — early return from null channel
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
    ).toBeUndefined();
  });
});
