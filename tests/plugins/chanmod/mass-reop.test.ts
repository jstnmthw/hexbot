import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeChanmodPluginOverrides } from '../../helpers/chanmod-plugin-config';
import type { MockBot } from '../../helpers/mock-bot';
import { createMockBot } from '../../helpers/mock-bot';
import { giveBotOps, simulateMode, tick } from '../../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

// Local `addToChannel` is a custom variant that accepts an extra `modes` string
// argument to optionally grant channel modes after join. Not shareable.
function addToChannel(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
  modes = '',
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
  // Optionally give the user modes
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

// ---------------------------------------------------------------------------
// Mass re-op after recovery
// ---------------------------------------------------------------------------

describe('chanmod — mass re-op on recovery', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(
      PLUGIN_PATH,
      makeChanmodPluginOverrides({
        enforce_modes: true,
        enforce_delay_ms: 5,
        bitch: true,
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

  /**
   * Simulate an elevated threat level by directly injecting threat events
   * into the threat state. This is the cleanest approach since we've already
   * unit tested the full threat scoring in chanmod-takeover.test.ts.
   */
  function raiseThreatLevel(channel: string): void {
    // Deop the bot (3 pts) — puts us at Alert level
    simulateMode(bot, 'Attacker', channel, '-o', 'hexbot');
  }

  it('re-ops flagged users who lost ops when bot is opped during elevated threat', async () => {
    bot.channelSettings.set('#test', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#test', 'takeover_detection', true);

    // Set up: alice and bob are flagged ops
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    bot.permissions.addUser('bob', '*!bob@bob.host', 'o', 'test');

    // Add them to channel without ops (they were deopped during attack)
    giveBotOps(bot, '#test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'Bob', 'bob', 'bob.host', '#test');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#test');

    // Raise threat level: deop bot by a non-nodesynch nick (3 pts → Alert)
    raiseThreatLevel('#test');
    await tick(50);
    bot.client.clearMessages();

    // Bot gets re-opped by someone other than the mode handler flow
    // Use a non-ChanServ setter to avoid any interference
    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // Mass re-op sends batched MODE via raw (ircCommands.mode → sendModeRaw → client.raw)
    const rawOpMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('+o') && m.message?.includes('Alice'),
    );
    expect(rawOpMsg).toBeDefined();
    expect(rawOpMsg!.message).toContain('Bob');
  });

  it('deops unauthorized ops during mass re-op when bitch mode is on', async () => {
    bot.channelSettings.set('#test', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#test', 'bitch', true);
    bot.channelSettings.set('#test', 'takeover_detection', true);

    // No permissions for EvilOp — they're unauthorized
    giveBotOps(bot, '#test');
    addToChannel(bot, 'EvilOp', 'evil', 'evil.host', '#test', 'o');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#test');

    // Raise threat
    raiseThreatLevel('#test');
    await tick(50);
    bot.client.clearMessages();

    // Bot gets re-opped
    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // EvilOp should be deopped (sent via raw MODE)
    const deopMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('-o') && m.message?.includes('EvilOp'),
    );
    expect(deopMsg).toBeDefined();
  });

  it('batches mode changes into a single MODE command', async () => {
    bot.channelSettings.set('#test', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#test', 'takeover_detection', true);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    bot.permissions.addUser('bob', '*!bob@bob.host', 'o', 'test');
    bot.permissions.addUser('charlie', '*!charlie@charlie.host', 'o', 'test');

    giveBotOps(bot, '#test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'Bob', 'bob', 'bob.host', '#test');
    addToChannel(bot, 'Charlie', 'charlie', 'charlie.host', '#test');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#test');

    raiseThreatLevel('#test');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // Should send batched +ooo (all three nicks in one MODE line)
    const batchedOp = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('+ooo'),
    );
    expect(batchedOp).toBeDefined();
    // Verify all three nicks are in the command
    expect(batchedOp!.message).toContain('Alice');
    expect(batchedOp!.message).toContain('Bob');
    expect(batchedOp!.message).toContain('Charlie');
  });

  it('does NOT mass re-op when threat level is Normal', async () => {
    // Use #calm channel which has no prior threat events
    bot.channelSettings.set('#calm', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#calm', 'takeover_detection', true);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    giveBotOps(bot, '#calm');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#calm');
    bot.client.clearMessages();

    // Bot opped at threat level 0 (Normal) — no mass re-op
    simulateMode(bot, 'ChanServ', '#calm', '+o', 'hexbot');
    await tick(50);

    // Should not have any raw MODE for Alice
    const opMsgs = bot.client.messages.filter(
      (m) => m.type === 'raw' && m.message?.includes('+o') && m.message?.includes('Alice'),
    );
    expect(opMsgs).toHaveLength(0);
  });

  it('does NOT mass re-op when mass_reop_on_recovery is disabled', async () => {
    bot.channelSettings.set('#test', 'mass_reop_on_recovery', false);
    bot.channelSettings.set('#test', 'takeover_detection', true);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    giveBotOps(bot, '#test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#test');

    raiseThreatLevel('#test');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // No mass re-op
    const opMsgs = bot.client.messages.filter(
      (m) => m.type === 'raw' && m.message?.includes('+o') && m.message?.includes('Alice'),
    );
    expect(opMsgs).toHaveLength(0);
  });

  it('re-voices flagged users during mass re-op', async () => {
    bot.channelSettings.set('#test', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#test', 'takeover_detection', true);

    bot.permissions.addUser('viewer', '*!viewer@viewer.host', 'v', 'test');
    giveBotOps(bot, '#test');
    addToChannel(bot, 'Viewer', 'viewer', 'viewer.host', '#test');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#test');

    raiseThreatLevel('#test');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#test', '+o', 'hexbot');
    await tick(50);

    // Viewer should be voiced (sent via raw MODE)
    const voiceMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('+v') && m.message?.includes('Viewer'),
    );
    expect(voiceMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mass re-op — halfop batching (mode-enforce.ts lines 615-617)
// ---------------------------------------------------------------------------

describe('chanmod — mass re-op halfop batching', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    // Configure halfop_flags to use 'v' (a valid permission flag)
    // with voice_flags empty, so 'v'-flagged users get halfop instead of voice
    const result = await bot.pluginLoader.load(
      PLUGIN_PATH,
      makeChanmodPluginOverrides({
        enforce_modes: true,
        enforce_delay_ms: 5,
        takeover_window_ms: 30000,
        halfop_flags: ['v'],
        voice_flags: [],
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

  it('re-halfops flagged users during mass re-op', async () => {
    bot.channelSettings.set('#halfop', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#halfop', 'takeover_detection', true);

    // Use 'v' flag which maps to halfop via halfop_flags: ['v']
    bot.permissions.addUser('halfie', '*!halfie@halfie.host', 'v', 'test');
    giveBotOps(bot, '#halfop');
    addToChannel(bot, 'Halfie', 'halfie', 'halfie.host', '#halfop');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#halfop');

    // Raise threat: deop bot → 3 pts → Alert
    simulateMode(bot, 'Attacker', '#halfop', '-o', 'hexbot');
    await tick(50);
    bot.client.clearMessages();

    simulateMode(bot, 'ChanServ', '#halfop', '+o', 'hexbot');
    await tick(50);

    // Halfie should be halfopped (sent via raw MODE +h)
    const halfopMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('+h') && m.message?.includes('Halfie'),
    );
    expect(halfopMsg).toBeDefined();
  });
});
