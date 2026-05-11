import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeChanmodPluginOverrides } from '../../helpers/chanmod-plugin-config';
import type { MockBot } from '../../helpers/mock-bot';
import { createMockBot } from '../../helpers/mock-bot';
import { giveBotOps, simulateMode, tick } from '../../helpers/plugin-test-helpers';

// chanmod hostile-op response — when the bot regains ops after a takeover
// it counter-attacks the actor whose deop pushed the channel into "Active"
// threat. These tests pin the policy: deop / kickban / akick variants,
// revenge_exempt_flags shielding, fallback paths when the bot has no ops at
// fire time, and the no-op when the actor has already parted.

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

// Local `addToChannel` is a custom variant that accepts an extra `modes` string
// to optionally grant channel modes after join. Not shareable.
function addToChannel(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
  modes = '',
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
  for (const m of modes) {
    bot.client.simulateEvent('mode', {
      nick: 'ChanServ',
      ident: 'ChanServ',
      hostname: 'services.',
      target: channel,
      modes: [{ mode: `+${m}`, param: nick }],
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Raise threat to Active level (score >= 6) by simulating multiple events.
 * Bot deop (3) + mode locks (+i=1, +s=1, +k=1) = 6 → Active
 * This avoids dependency on user-deop processing (cooldowns, flag checks).
 */
function raiseThreatToActive(bot: MockBot, channel: string): void {
  simulateMode(bot, 'Attacker', channel, '-o', 'hexbot'); // 3 pts (bot_deopped)
  simulateMode(bot, 'Attacker', channel, '+i', ''); // 1 pt (mode_locked)
  simulateMode(bot, 'Attacker', channel, '+s', ''); // 1 pt (mode_locked)
  simulateMode(bot, 'Attacker', channel, '+k', 'evilkey'); // 1 pt (mode_locked)
  // Total: 6 → Active
}

// ---------------------------------------------------------------------------
// Hostile op response
// ---------------------------------------------------------------------------

describe('chanmod — hostile op response (takeover_punish=deop)', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(
      PLUGIN_PATH,
      makeChanmodPluginOverrides({
        enforce_modes: true,
        enforce_delay_ms: 5,
        takeover_window_ms: 30000,
      }),
    );
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
  });

  it('deops the hostile actor when bot regains ops at Active threat', async () => {
    bot.channelSettings.set('#deop', 'takeover_punish', 'deop');
    bot.channelSettings.set('#deop', 'takeover_detection', true);
    bot.channelSettings.set('#deop', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#deop');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#deop', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#deop', 'o');

    // Raise to Active: bot deop (3) + friendly deop (2) + mode lock (1) = 6
    raiseThreatToActive(bot, '#deop');
    await tick(50);
    bot.client.clearMessages();

    // Bot re-opped
    simulateMode(bot, 'ChanServ', '#deop', '+o', 'hexbot');
    await tick(50);

    // Attacker should be deopped
    const deopMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Attacker'),
    );
    expect(deopMsg).toBeDefined();
  });

  it('respects revenge_exempt_flags — exempt users not counter-attacked', async () => {
    bot.channelSettings.set('#exempt', 'takeover_punish', 'kickban');
    bot.channelSettings.set('#exempt', 'takeover_detection', true);
    bot.channelSettings.set('#exempt', 'mass_reop_on_recovery', false);

    // Admin has 'n' flag — should be exempt from counter-attack
    bot.permissions.addUser('admin', '*!admin@admin.host', 'n', 'test');
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#exempt');
    addToChannel(bot, 'Admin', 'admin', 'admin.host', '#exempt', 'o');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#exempt', 'o');

    // Admin deops the bot (raising threat) — Admin is the actor
    simulateMode(bot, 'Admin', '#exempt', '-o', 'hexbot'); // 3 pts
    simulateMode(bot, 'Admin', '#exempt', '-o', 'Alice'); // 2 pts
    simulateMode(bot, 'Admin', '#exempt', '+i', ''); // 1 pt
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#exempt', '+o', 'hexbot');
    await tick(50);

    // Admin should NOT be kicked or banned (exempt flag 'n')
    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('Admin'),
    );
    expect(kickMsg).toBeUndefined();
  });

  it('takeover_punish=none does not counter-attack', async () => {
    bot.channelSettings.set('#none', 'takeover_punish', 'none');
    bot.channelSettings.set('#none', 'takeover_detection', true);
    bot.channelSettings.set('#none', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#none');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#none', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#none', 'o');

    raiseThreatToActive(bot, '#none');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#none', '+o', 'hexbot');
    await tick(50);

    // No deop, kick, or ban for Attacker
    const counterMsgs = bot.client.messages.filter(
      (m) =>
        (m.type === 'mode' && m.message === '-o' && m.args?.includes('Attacker')) ||
        (m.type === 'raw' && m.message?.includes('Attacker')),
    );
    expect(counterMsgs).toHaveLength(0);
  });

  it('takeover_punish=kickban kicks and bans the hostile actor', async () => {
    bot.channelSettings.set('#kb', 'takeover_punish', 'kickban');
    bot.channelSettings.set('#kb', 'takeover_detection', true);
    bot.channelSettings.set('#kb', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#kb');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#kb', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#kb', 'o');

    raiseThreatToActive(bot, '#kb');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#kb', '+o', 'hexbot');
    await tick(50);

    // Should have a ban and a kick
    const banMsg = bot.client.messages.find((m) => m.type === 'mode' && m.message === '+b');
    expect(banMsg).toBeDefined();

    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('Attacker'),
    );
    expect(kickMsg).toBeDefined();
  });

  it('takeover_punish=akick sends AKICK via backend', async () => {
    bot.channelSettings.set('#akick', 'takeover_punish', 'akick');
    bot.channelSettings.set('#akick', 'takeover_detection', true);
    bot.channelSettings.set('#akick', 'chanserv_access', 'superop');
    bot.channelSettings.set('#akick', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#akick');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#akick', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#akick', 'o');

    raiseThreatToActive(bot, '#akick');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#akick', '+o', 'hexbot');
    await tick(50);

    // Should have sent AKICK to ChanServ
    const akickMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('AKICK #akick ADD'),
    );
    expect(akickMsg).toBeDefined();
  });

  it('akick falls back to kickban when backend has no AKICK capability', async () => {
    bot.channelSettings.set('#noakick', 'takeover_punish', 'akick');
    bot.channelSettings.set('#noakick', 'takeover_detection', true);
    bot.channelSettings.set('#noakick', 'chanserv_access', 'none'); // No AKICK capability
    bot.channelSettings.set('#noakick', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#noakick');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#noakick', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#noakick', 'o');

    raiseThreatToActive(bot, '#noakick');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#noakick', '+o', 'hexbot');
    await tick(50);

    // No AKICK — should fallback to kickban
    const akickMsg = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('AKICK'),
    );
    expect(akickMsg).toBeUndefined();

    // Should have a kick instead
    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('Attacker'),
    );
    expect(kickMsg).toBeDefined();
  });

  it('requests deop via backend when bot loses ops before hostile response fires', async () => {
    bot.channelSettings.set('#chain', 'takeover_punish', 'deop');
    bot.channelSettings.set('#chain', 'takeover_detection', true);
    bot.channelSettings.set('#chain', 'mass_reop_on_recovery', false);
    // Give the chain superop access so canDeop() returns true
    bot.channelSettings.set('#chain', 'chanserv_access', 'superop');

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#chain');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#chain', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#chain', 'o');

    // Raise to Active: bot deop (3) + mode locks (3) = 6
    raiseThreatToActive(bot, '#chain');
    await tick(50);
    bot.client.clearMessages();

    // Bot gets re-opped — this schedules the hostile response timer
    // (takeover_response_delay_ms defaults to 0 but uses setTimeout(fn, 0))
    simulateMode(bot, 'ChanServ', '#chain', '+o', 'hexbot');

    // Immediately deop the bot BEFORE the hostile response timer fires
    simulateMode(bot, 'Attacker', '#chain', '-o', 'hexbot');

    await tick(50);

    // Bot doesn't have ops, so it should fall back to chain.requestDeop
    // which sends ChanServ DEOP
    const deopMsg = bot.client.messages.find(
      (m) =>
        m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('DEOP #chain Attacker'),
    );
    expect(deopMsg).toBeDefined();
  });

  it('skips actors who left the channel', async () => {
    bot.channelSettings.set('#gone', 'takeover_punish', 'deop');
    bot.channelSettings.set('#gone', 'takeover_detection', true);
    bot.channelSettings.set('#gone', 'mass_reop_on_recovery', false);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    giveBotOps(bot, '#gone');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#gone', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#gone', 'o');

    raiseThreatToActive(bot, '#gone');
    await tick(50);

    // Attacker leaves the channel
    bot.client.simulateEvent('part', {
      nick: 'Attacker',
      ident: 'attacker',
      hostname: 'attacker.host',
      channel: '#gone',
      message: '',
    });
    await tick(10);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#gone', '+o', 'hexbot');
    await tick(50);

    // No action against Attacker — they left
    const counterMsgs = bot.client.messages.filter(
      (m) =>
        (m.type === 'mode' && m.args?.includes('Attacker')) ||
        (m.type === 'raw' && m.message?.includes('Attacker')),
    );
    expect(counterMsgs).toHaveLength(0);
  });
});
