import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeChanmodPluginOverrides } from '../helpers/chanmod-plugin-config';
import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';
import { addToChannel, giveBotOps, simulateMode, tick } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Speed optimization: zero delays during elevated threat
// ---------------------------------------------------------------------------

describe('chanmod — speed optimization: ChanServ OP request delay', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(
      PLUGIN_PATH,
      makeChanmodPluginOverrides({
        chanserv_op_delay_ms: 1000, // 1 second normally
        enforce_delay_ms: 500,
        takeover_response_delay_ms: 0,
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

  it('ChanServ OP request uses normal delay (1000ms) at threat level 0', async () => {
    bot.channelSettings.set('#normal', 'chanserv_access', 'op');
    bot.channelSettings.set('#normal', 'takeover_detection', true);

    giveBotOps(bot, '#normal');
    bot.client.clearMessages();

    // Deop bot by ChanServ (nodesynch — no threat points)
    simulateMode(bot, 'ChanServ', '#normal', '-o', 'hexbot');

    // After 100ms — OP request should NOT have been sent yet (1000ms delay)
    await tick(100);
    const earlyOp = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #normal'),
    );
    expect(earlyOp).toBeUndefined();

    // After 1100ms — OP request should be sent
    await tick(1000);
    const lateOp = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #normal'),
    );
    expect(lateOp).toBeDefined();
  });

  it('ChanServ OP request uses zero delay during elevated threat', async () => {
    bot.channelSettings.set('#fast', 'chanserv_access', 'op');
    bot.channelSettings.set('#fast', 'takeover_detection', true);

    giveBotOps(bot, '#fast');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#fast');
    bot.client.clearMessages();

    // Deop bot by non-nodesynch (3 pts → Alert) — triggers zero-delay ChanServ OP
    simulateMode(bot, 'Attacker', '#fast', '-o', 'hexbot');

    // After just 1ms (setTimeout(fn, 0) resolves immediately in fake timers)
    await tick(1);
    const fastOp = bot.client.messages.find(
      (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #fast'),
    );
    expect(fastOp).toBeDefined();
  });
});

describe('chanmod — speed optimization: recovery action delays', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(
      PLUGIN_PATH,
      makeChanmodPluginOverrides({
        enforce_delay_ms: 500, // normal enforcement delay
        takeover_response_delay_ms: 0, // zero for recovery
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

  it('mass re-op fires with zero delay (takeover_response_delay_ms=0)', async () => {
    bot.channelSettings.set('#reop', 'mass_reop_on_recovery', true);
    bot.channelSettings.set('#reop', 'takeover_detection', true);

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    giveBotOps(bot, '#reop');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#reop');
    addToChannel(bot, 'Attacker', 'attacker', 'attacker.host', '#reop');

    // Raise threat
    simulateMode(bot, 'Attacker', '#reop', '-o', 'hexbot');
    await tick(50);
    bot.client.clearMessages();

    // Bot re-opped
    simulateMode(bot, 'ChanServ', '#reop', '+o', 'hexbot');

    // With takeover_response_delay_ms=0, mass re-op fires immediately
    await tick(1);
    const opMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('+o') && m.message?.includes('Alice'),
    );
    expect(opMsg).toBeDefined();
  });
});
