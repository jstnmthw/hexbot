import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';
import { addToChannel, giveBotOps, simulateMode, tick } from '../helpers/plugin-test-helpers';

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

/** Simulate a ChanServ NOTICE (private message to bot). */
function simulateChanServNotice(bot: MockBot, text: string): void {
  bot.client.simulateEvent('notice', {
    nick: 'ChanServ',
    ident: 'ChanServ',
    hostname: 'services.libera.chat',
    target: 'hexbot',
    message: text,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Auto-detect ChanServ access on join
// ---------------------------------------------------------------------------

describe('chanmod — ChanServ auto-detect on join', () => {
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
          chanserv_op_delay_ms: 10,
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

  it('sends FLAGS probe on join and auto-detects access from response', async () => {
    // Bot joins a channel with no chanserv_access set
    bot.client.clearMessages();
    bot.client.simulateEvent('join', {
      nick: 'hexbot',
      ident: 'bot',
      hostname: 'bot.host',
      channel: '#newchan',
    });
    await tick(10);

    // FLAGS probe should have been sent
    const flagsMsg = bot.client.messages.find(
      (m) =>
        m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('FLAGS #newchan hexbot'),
    );
    expect(flagsMsg).toBeDefined();

    // Simulate ChanServ response with op-level flags
    simulateChanServNotice(bot, '2 hexbot +oiA');
    await tick(10);

    // chanserv_access should now be 'op' (auto-detected)
    const access = bot.channelSettings.getString('#newchan', 'chanserv_access');
    expect(access).toBe('op');
  });

  it('auto-detected access enables ChanServ OP request on deop', async () => {
    // Set up: auto-detect access for the channel
    bot.channelSettings.set('#autochan', 'chanserv_access', 'op');
    await tick(10);
    giveBotOps(bot, '#autochan');
    addToChannel(bot, 'Attacker', 'attacker', 'evil.host', '#autochan');
    bot.client.clearMessages();

    // Deop the bot
    simulateMode(bot, 'Attacker', '#autochan', '-o', 'hexbot');
    await tick(50);

    // OP request should be sent via ProtectionChain (not via chanserv_op flag)
    const opMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #autochan'),
    );
    expect(opMsg).toBeDefined();
  });

  it('kick triggers UNBAN + rejoin + OP when chanserv_access >= op', async () => {
    bot.channelSettings.set('#kickchan', 'chanserv_access', 'op');
    bot.channelSettings.set('#kickchan', 'chanserv_unban_on_kick', true);
    await tick(10);

    giveBotOps(bot, '#kickchan');
    bot.client.clearMessages();

    simulateKick(bot, '#kickchan', 'hexbot', 'EvilOp');
    await tick(600);

    const unbanMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'UNBAN #kickchan',
    );
    expect(unbanMsg).toBeDefined();

    const joinMsg = bot.client.messages.find((m) => m.type === 'join' && m.target === '#kickchan');
    expect(joinMsg).toBeDefined();

    const opMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #kickchan'),
    );
    expect(opMsg).toBeDefined();
  });

  it('manual .chanset chanserv_access none prevents auto-detect from overriding', async () => {
    // Explicitly set to 'none'
    bot.channelSettings.set('#manual', 'chanserv_access', 'none');
    await tick(10);

    giveBotOps(bot, '#manual');
    addToChannel(bot, 'Attacker', 'attacker', 'evil.host', '#manual');
    bot.client.clearMessages();

    // Deop bot — should NOT trigger OP request (access is explicitly 'none')
    simulateMode(bot, 'Attacker', '#manual', '-o', 'hexbot');
    await tick(50);

    const opMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #manual'),
    );
    expect(opMsg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Takeover escalation with auto-detected access
// ---------------------------------------------------------------------------

describe('chanmod — takeover escalation with ChanServ backend', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#takeover');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          chanserv_services_type: 'atheme',
          chanserv_nick: 'ChanServ',
          chanserv_op_delay_ms: 0,
          enforce_delay_ms: 5,
          takeover_window_ms: 30000,
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

  it('threat level 3 triggers RECOVER when chanserv_access is founder', async () => {
    bot.channelSettings.set('#takeover', 'chanserv_access', 'founder');
    bot.channelSettings.set('#takeover', 'takeover_detection', true);
    bot.channelSettings.set('#takeover', 'chanserv_unban_on_kick', true);
    await tick(10);

    giveBotOps(bot, '#takeover');
    addToChannel(bot, 'Attacker', 'attacker', 'evil.host', '#takeover');
    bot.client.clearMessages();

    // Deop bot (3 pts → Alert)
    simulateMode(bot, 'Attacker', '#takeover', '-o', 'hexbot');
    await tick(10);

    // Kick bot (4 pts → Active, total 7)
    simulateKick(bot, '#takeover', 'hexbot', 'Attacker');
    await tick(600);

    // Bot rejoins, gets opped again
    giveBotOps(bot, '#takeover');
    bot.client.clearMessages();

    // Ban bot (5 pts → Critical, total 12)
    simulateMode(bot, 'Attacker', '#takeover', '+b', '*!*@bot.host');
    await tick(10);

    // RECOVER should be sent
    const recoverMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message === 'RECOVER #takeover',
    );
    expect(recoverMsg).toBeDefined();
  });

  it('loads without error when deprecated chanserv_op is in config', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      const result = await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            chanserv_op: true, // deprecated key — should not cause error
            chanserv_nick: 'ChanServ',
          },
        },
      });
      // Plugin loads successfully despite the deprecated key
      expect(result.status).toBe('ok');
    } finally {
      freshBot.cleanup();
    }
  });
});
