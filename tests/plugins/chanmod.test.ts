import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// parseChannelModes() unit tests (helpers.ts)
// ---------------------------------------------------------------------------

import { PARAM_MODES, getParamModes, parseChannelModes } from '../../plugins/chanmod/helpers';
import { type MockBot, createMockBot } from '../helpers/mock-bot';
import { createMockPluginAPI } from '../helpers/mock-plugin-api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

function simulateJoin(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

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

function simulateMode(
  bot: MockBot,
  setter: string,
  channel: string,
  mode: string,
  param: string,
): void {
  bot.client.simulateEvent('mode', {
    nick: setter,
    ident: 'ident',
    hostname: 'host',
    target: channel,
    modes: [{ mode, param }],
  });
}

/** Flush microtasks — sufficient for synchronous handlers dispatched via async dispatch(). */
async function flush(): Promise<void> {
  await Promise.resolve();
}

/** Advance fake timers (enforcement delays, async handlers). */
async function tick(ms = 20): Promise<void> {
  // Drain async event handler chain before advancing fake timers
  await new Promise<void>((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(ms);
}

/** Add a user to channel-state so getUserHostmask works. */
function addToChannel(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

/**
 * Simulate RPL_CHANNELMODEIS (324) response — channel info event.
 * Populates channel-state modes/key/limit and emits channel:modesReady.
 * @param rawModes Mode string like '+ntsk' or '' for no modes.
 * @param rawParams Parameters for parametered modes (e.g. ['secretkey'] for +k).
 */
function simulateChannelInfo(
  bot: MockBot,
  channel: string,
  rawModes: string,
  rawParams: string[] = [],
): void {
  // Build parsed modes array matching irc-framework's format
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

/** Simulate the bot joining a channel with ops (via userlist). */
function giveBotOps(bot: MockBot, channel: string): void {
  const nick = bot.client.user.nick;
  // Ensure bot is in the channel
  bot.client.simulateEvent('join', { nick, ident: 'bot', hostname: 'bot.host', channel });
  // Give the bot +o via mode event
  bot.client.simulateEvent('mode', {
    nick: 'ChanServ',
    ident: 'ChanServ',
    hostname: 'services.',
    target: channel,
    modes: [{ mode: '+o', param: nick }],
  });
}

// Use fake timers for all tests so enforcement delays fire instantly
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Auto-op tests
// ---------------------------------------------------------------------------

describe('chanmod plugin — auto-op', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
  });

  it('should op a user with +o flag on join', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    simulateJoin(bot, 'Alice', 'alice', 'alice.host', '#test');
    await tick();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeDefined();
  });

  it('should voice a user with +v flag on join', async () => {
    bot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
    simulateJoin(bot, 'Bob', 'bob', 'bob.host', '#test');
    await tick();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob'),
      ),
    ).toBeDefined();
  });

  it('should op a user with +n flag (owner implies op)', async () => {
    bot.permissions.addUser('owner', '*!owner@owner.host', 'n', 'test');
    simulateJoin(bot, 'Owner', 'owner', 'owner.host', '#test');
    await tick();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Owner'),
      ),
    ).toBeDefined();
  });

  it('should do nothing for unknown user', async () => {
    simulateJoin(bot, 'Stranger', 'stranger', 'unknown.host', '#test');
    await tick();
    expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
  });

  it('should not op user with flags for different channel only', async () => {
    bot.permissions.addUser('channeluser', '*!cu@cu.host', '', 'test');
    bot.permissions.setChannelFlags('channeluser', '#other', 'o', 'test');
    simulateJoin(bot, 'ChannelUser', 'cu', 'cu.host', '#test');
    await tick();
    expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
  });

  it('should op user with channel-specific +o flag', async () => {
    bot.permissions.addUser('chanmod', '*!cop@cop.host', '', 'test');
    bot.permissions.setChannelFlags('chanmod', '#test', 'o', 'test');
    simulateJoin(bot, 'ChanOp', 'cop', 'cop.host', '#test');
    await tick();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('ChanOp'),
      ),
    ).toBeDefined();
  });

  it('should not op/voice the bot itself', async () => {
    bot.permissions.addUser('botuser', '*!hexbot@bot.host', 'o', 'test');
    simulateJoin(bot, 'hexbot', 'hexbot', 'bot.host', '#test');
    await tick();
    expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
  });

  it('should not auto-op when auto_op is disabled', async () => {
    const disabledBot = createMockBot({ botNick: 'hexbot' });
    try {
      const result = await disabledBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { auto_op: false } },
      });
      expect(result.status).toBe('ok');

      disabledBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      simulateJoin(disabledBot, 'Alice', 'alice', 'alice.host', '#test');
      await tick();
      expect(disabledBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    } finally {
      disabledBot.cleanup();
    }
  });

  it('should halfop a user with a configured halfop flag', async () => {
    const halfopBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(halfopBot, '#test');
    try {
      await halfopBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      halfopBot.permissions.addUser('huser', '*!huser@huser.host', 'v', 'test');
      simulateJoin(halfopBot, 'HUser', 'huser', 'huser.host', '#test');
      await tick();
      expect(
        halfopBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('HUser'),
        ),
      ).toBeDefined();
    } finally {
      halfopBot.cleanup();
    }
  });

  it('should not halfop when bot has no +h or +o in channel', async () => {
    const noOpsBot = createMockBot({ botNick: 'hexbot' });
    try {
      await noOpsBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      noOpsBot.permissions.addUser('huser', '*!huser@huser.host', 'v', 'test');
      simulateJoin(noOpsBot, 'HUser', 'huser', 'huser.host', '#test');
      await tick();
      expect(noOpsBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    } finally {
      noOpsBot.cleanup();
    }
  });

  it('should not voice when bot has no ops', async () => {
    const noOpsBot = createMockBot({ botNick: 'hexbot' });
    try {
      await noOpsBot.pluginLoader.load(PLUGIN_PATH);
      noOpsBot.permissions.addUser('vuser', '*!vuser@vuser.host', 'v', 'test');
      simulateJoin(noOpsBot, 'VUser', 'vuser', 'vuser.host', '#test');
      await tick();
      expect(noOpsBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    } finally {
      noOpsBot.cleanup();
    }
  });

  it('should voice (not op) owner with +dv flag', async () => {
    giveBotOps(bot, '#test');
    bot.permissions.addUser('deopowner', '*!downer@downer.host', 'ndv', 'test');
    simulateJoin(bot, 'DeopOwner', 'downer', 'downer.host', '#test');
    await tick();

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('DeopOwner'),
      ),
    ).toBeDefined();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('DeopOwner'),
      ),
    ).toBeUndefined();
  });

  it('should give no mode when user has +d without explicit +v', async () => {
    giveBotOps(bot, '#test');
    bot.client.clearMessages();
    bot.permissions.addUser('deoponly', '*!donly@donly.host', 'nd', 'test');
    simulateJoin(bot, 'DeopOnly', 'donly', 'donly.host', '#test');
    await tick();

    expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
  });

  it('should voice an already-joined user when +v flag is added (no rejoin)', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      // User joins with no bot-user record yet — should get nothing.
      simulateJoin(liveBot, 'BlueAngel', 'blue', 'blue.host', '#test');
      await tick();
      expect(liveBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      liveBot.client.clearMessages();
      // Now add the user with +v — reconcile should voice them immediately.
      liveBot.permissions.addUser('blueangel', '*!blue@blue.host', 'v', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('BlueAngel'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should op an already-joined user when +o flag is added (no rejoin)', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      simulateJoin(liveBot, 'Chief', 'chief', 'chief.host', '#test');
      await tick();
      liveBot.client.clearMessages();

      liveBot.permissions.addUser('chief', '*!chief@chief.host', 'o', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Chief'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should halfop an already-joined user when a halfop flag is added (no rejoin)', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      simulateJoin(liveBot, 'HUser', 'huser', 'huser.host', '#test');
      await tick();
      liveBot.client.clearMessages();

      liveBot.permissions.addUser('huser', '*!huser@huser.host', 'v', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('HUser'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should op an already-joined user when flags change from +v to +o', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      liveBot.permissions.addUser('upgrade', '*!up@up.host', 'v', 'test');
      simulateJoin(liveBot, 'Upgrade', 'up', 'up.host', '#test');
      await tick();
      // They got voiced on join.
      liveBot.client.clearMessages();

      // Now bump flags to +o — should op them without a rejoin.
      liveBot.permissions.setGlobalFlags('upgrade', 'o', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Upgrade'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should devoice an already-joined user when +v flag is removed', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      liveBot.permissions.addUser('fader', '*!fader@fader.host', 'v', 'test');
      simulateJoin(liveBot, 'Fader', 'fader', 'fader.host', '#test');
      await tick();
      // Simulate the +v landing so channel-state knows they're voiced.
      simulateMode(liveBot, 'hexbot', '#test', '+v', 'Fader');
      liveBot.client.clearMessages();

      // Strip the +v flag — reconcile should devoice them.
      liveBot.permissions.setGlobalFlags('fader', '', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-v' && m.args?.includes('Fader'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should deop an already-joined user when +o flag is removed', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      liveBot.permissions.addUser('chief', '*!chief@chief.host', 'o', 'test');
      simulateJoin(liveBot, 'Chief', 'chief', 'chief.host', '#test');
      await tick();
      simulateMode(liveBot, 'hexbot', '#test', '+o', 'Chief');
      liveBot.client.clearMessages();

      liveBot.permissions.setGlobalFlags('chief', '', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Chief'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should dehalfop an already-joined user when halfop flag is removed', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      liveBot.permissions.addUser('hchief', '*!hchief@h.host', 'v', 'test');
      simulateJoin(liveBot, 'HChief', 'hchief', 'h.host', '#test');
      await tick();
      simulateMode(liveBot, 'hexbot', '#test', '+h', 'HChief');
      liveBot.client.clearMessages();

      liveBot.permissions.setGlobalFlags('hchief', '', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-h' && m.args?.includes('HChief'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should no-op modesReady reconcile when auto_op is disabled for the channel', async () => {
    const offBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(offBot, '#test');
    try {
      await offBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { auto_op: false } },
      });
      offBot.permissions.addUser('vuser', '*!vuser@vuser.host', 'v', 'test');
      simulateJoin(offBot, 'VUser', 'vuser', 'vuser.host', '#test');
      await tick();
      offBot.client.clearMessages();

      simulateChannelInfo(offBot, '#test', '+nt');
      await tick();
      expect(offBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    } finally {
      offBot.cleanup();
    }
  });

  it('should tolerate modesReady for an untracked channel', async () => {
    const ghostBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(ghostBot, '#test');
    try {
      await ghostBot.pluginLoader.load(PLUGIN_PATH);
      // Emit modesReady for a channel the bot was never in — reconciler must
      // gracefully bail instead of crashing on undefined channel state.
      ghostBot.eventBus.emit('channel:modesReady', '#never-joined');
      await tick();
      // No messages produced, no exceptions.
      expect(ghostBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    } finally {
      ghostBot.cleanup();
    }
  });

  it('should skip unknown users during modesReady reconcile', async () => {
    const skipBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(skipBot, '#test');
    try {
      await skipBot.pluginLoader.load(PLUGIN_PATH);
      // Bot is opped but there's no permissions record for the user in channel.
      simulateJoin(skipBot, 'Randal', 'randal', 'randal.host', '#test');
      await tick();
      skipBot.client.clearMessages();

      simulateChannelInfo(skipBot, '#test', '+nt');
      await tick();
      // Randal has no matching record → no mode is applied to them.
      expect(
        skipBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Randal')),
      ).toBeUndefined();
    } finally {
      skipBot.cleanup();
    }
  });

  it('should swallow errors raised inside the reconcile paths', async () => {
    const errBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(errBot, '#test');
    try {
      await errBot.pluginLoader.load(PLUGIN_PATH);
      errBot.permissions.addUser('bomb', '*!bomb@bomb.host', 'v', 'test');
      simulateJoin(errBot, 'Bomb', 'bomb', 'bomb.host', '#test');
      await tick();
      errBot.client.clearMessages();

      // Force the next two findByHostmask calls from the reconcile paths to throw.
      const spy = vi.spyOn(errBot.permissions, 'findByHostmask').mockImplementation(() => {
        throw new Error('boom');
      });

      // onPermissionsChanged reconcile path — must not crash.
      errBot.permissions.setGlobalFlags('bomb', 'o', 'test');
      await tick();

      // onModesReady reconcile path — must not crash either.
      simulateChannelInfo(errBot, '#test', '+nt');
      await tick();

      spy.mockRestore();
      expect(errBot.client.messages).toBeDefined();
    } finally {
      errBot.cleanup();
    }
  });

  it('should voice an already-joined user when a matching hostmask is added', async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      // Add user with +v but a hostmask that doesn't match anyone in the channel yet.
      liveBot.permissions.addUser('mover', '*!mover@old.host', 'v', 'test');
      simulateJoin(liveBot, 'Mover', 'mover', 'new.host', '#test');
      await tick();
      // No match yet — nothing happens.
      expect(liveBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      // Add the matching hostmask — reconcile should voice them now.
      liveBot.permissions.addHostmask('mover', '*!mover@new.host', 'test');
      await tick();
      expect(
        liveBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Mover'),
        ),
      ).toBeDefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should voice a user synced from botlink (leaf-side) without rejoin', async () => {
    const leafBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(leafBot, '#test');
    try {
      await leafBot.pluginLoader.load(PLUGIN_PATH);
      // User is already in the channel on the leaf — no permissions record yet.
      simulateJoin(leafBot, 'BlueAngel', 'blue', 'blue.host', '#test');
      await tick();
      expect(leafBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      leafBot.client.clearMessages();
      // Simulate a botlink ADDUSER/SETFLAGS frame landing on the leaf:
      // PermissionSyncer.applyFrame calls permissions.syncUser under the hood.
      leafBot.permissions.syncUser('blueangel', ['*!blue@blue.host'], 'v', {}, 'botlink-sync');
      await tick();
      expect(
        leafBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('BlueAngel'),
        ),
      ).toBeDefined();
    } finally {
      leafBot.cleanup();
    }
  });

  it('should op a user synced from botlink (leaf-side) without rejoin', async () => {
    const leafBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(leafBot, '#test');
    try {
      await leafBot.pluginLoader.load(PLUGIN_PATH);
      simulateJoin(leafBot, 'HubOp', 'hubop', 'hubop.host', '#test');
      await tick();
      leafBot.client.clearMessages();

      leafBot.permissions.syncUser('hubop', ['*!hubop@hubop.host'], 'o', {}, 'botlink-sync');
      await tick();
      expect(
        leafBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('HubOp'),
        ),
      ).toBeDefined();
    } finally {
      leafBot.cleanup();
    }
  });

  it('should halfop a user synced from botlink (leaf-side) without rejoin', async () => {
    const leafBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(leafBot, '#test');
    try {
      await leafBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      simulateJoin(leafBot, 'HubHalf', 'hh', 'hh.host', '#test');
      await tick();
      leafBot.client.clearMessages();

      leafBot.permissions.syncUser('hubhalf', ['*!hh@hh.host'], 'v', {}, 'botlink-sync');
      await tick();
      expect(
        leafBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('HubHalf'),
        ),
      ).toBeDefined();
    } finally {
      leafBot.cleanup();
    }
  });

  it('should voice users already in a channel when the bot joins it', async () => {
    const joiningBot = createMockBot({ botNick: 'hexbot' });
    try {
      await joiningBot.pluginLoader.load(PLUGIN_PATH);

      // Seed the user record before anyone joins — mirrors the real case
      // where permissions persist across bot restarts.
      joiningBot.permissions.addUser('blueangel', '*!blue@blue.host', 'v', 'test');

      // BlueAngel is already in #test before the bot arrives. Bot isn't
      // present yet so auto-op bails out in the join handler (no ops to give).
      simulateJoin(joiningBot, 'BlueAngel', 'blue', 'blue.host', '#test');
      await tick();
      expect(joiningBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      // Bot joins and gets opped.
      giveBotOps(joiningBot, '#test');
      joiningBot.client.clearMessages();

      // Server responds to the bot's requestChannelModes with RPL_CHANNELMODEIS,
      // which fires channel:modesReady and triggers the reconciler.
      simulateChannelInfo(joiningBot, '#test', '+nt');
      await tick();

      expect(
        joiningBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('BlueAngel'),
        ),
      ).toBeDefined();
    } finally {
      joiningBot.cleanup();
    }
  });

  it('should op users already in a channel when the bot joins it', async () => {
    const joiningBot = createMockBot({ botNick: 'hexbot' });
    try {
      await joiningBot.pluginLoader.load(PLUGIN_PATH);
      joiningBot.permissions.addUser('chief', '*!chief@chief.host', 'o', 'test');
      simulateJoin(joiningBot, 'Chief', 'chief', 'chief.host', '#test');
      await tick();
      expect(joiningBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      giveBotOps(joiningBot, '#test');
      joiningBot.client.clearMessages();

      simulateChannelInfo(joiningBot, '#test', '+nt');
      await tick();
      expect(
        joiningBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Chief'),
        ),
      ).toBeDefined();
    } finally {
      joiningBot.cleanup();
    }
  });

  it('should halfop users already in a channel when the bot joins it', async () => {
    const joiningBot = createMockBot({ botNick: 'hexbot' });
    try {
      await joiningBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { halfop_flags: ['v'] } },
      });
      joiningBot.permissions.addUser('huser', '*!huser@h.host', 'v', 'test');
      simulateJoin(joiningBot, 'HUser', 'huser', 'h.host', '#test');
      await tick();
      expect(joiningBot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();

      giveBotOps(joiningBot, '#test');
      joiningBot.client.clearMessages();

      simulateChannelInfo(joiningBot, '#test', '+nt');
      await tick();
      expect(
        joiningBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('HUser'),
        ),
      ).toBeDefined();
    } finally {
      joiningBot.cleanup();
    }
  });

  it("should leave unknown users alone when another user's flags change", async () => {
    const liveBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(liveBot, '#test');
    try {
      await liveBot.pluginLoader.load(PLUGIN_PATH);
      simulateJoin(liveBot, 'Stranger', 'stranger', 'stranger.host', '#test');
      await tick();
      liveBot.client.clearMessages();

      liveBot.permissions.addUser('someone', '*!someone@someone.host', 'v', 'test');
      await tick();
      // Stranger must not be touched — they don't match any bot-user record.
      expect(
        liveBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Stranger')),
      ).toBeUndefined();
    } finally {
      liveBot.cleanup();
    }
  });

  it('should not suppress auto-op in channels without +d', async () => {
    // User has +d only in #test, should still get opped in #other
    const multiBot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(multiBot, '#other');
    try {
      await multiBot.pluginLoader.load(PLUGIN_PATH);
      multiBot.permissions.addUser('selectivedeop', '*!sd@sd.host', 'nmo', 'test');
      multiBot.permissions.setChannelFlags('selectivedeop', '#test', 'd', 'test');
      simulateJoin(multiBot, 'SelectiveDeop', 'sd', 'sd.host', '#other');
      await tick();

      expect(
        multiBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('SelectiveDeop'),
        ),
      ).toBeDefined();
    } finally {
      multiBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Command tests (!op, !deop, !kick, !voice, !bans, !halfop)
// ---------------------------------------------------------------------------

describe('chanmod plugin — commands', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
    bot.permissions.addUser('opuser', '*!opuser@op.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('!op sends mode +o for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!op SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!deop sends mode -o for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!deop SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!deop refuses to deop the bot itself', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!deop hexbot');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('cannot deop myself'),
      ),
    ).toBeDefined();
  });

  it('!voice sends mode +v for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!voice SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!devoice sends mode -v for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!devoice SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-v' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!halfop sends mode +h for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!halfop SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!dehalfop sends mode -h for target nick', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!dehalfop SomeNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-h' && m.args?.includes('SomeNick'),
      ),
    ).toBeDefined();
  });

  it('!dehalfop refuses to dehalfop the bot itself', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!dehalfop hexbot');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('cannot dehalfop myself'),
      ),
    ).toBeDefined();
  });

  it('!kick sends KICK raw command', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!kick BadUser flooding');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('BadUser'),
      ),
    ).toBeDefined();
  });

  it('!kick uses default reason when none given', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!kick BadUser');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('BadUser'),
      ),
    ).toBeDefined();
  });

  it('!bans reports no tracked bans', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!bans');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('No tracked bans')),
    ).toBeDefined();
  });

  it('!ban with explicit mask sends mode +b', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!ban *!*@bad.host');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@bad.host'),
      ),
    ).toBeDefined();
  });

  it('!bans lists a tracked ban', async () => {
    // First ban someone explicitly to create a record
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!ban *!*@listed.host 60');
    await flush();
    bot.client.clearMessages();

    // Now !bans should list it
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!bans');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('*!*@listed.host')),
    ).toBeDefined();
  });

  it('!ban resolves nick in channel to ban mask', async () => {
    // Add a target user to the channel so getUserHostmask works
    addToChannel(bot, 'BadUser', 'bad', 'bad.host', '#test');
    bot.client.clearMessages();

    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!ban BadUser');
    await flush();
    expect(bot.client.messages.find((m) => m.type === 'mode' && m.message === '+b')).toBeDefined();
  });

  it('!kick refuses to kick the bot itself', async () => {
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!kick hexbot');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('cannot kick myself'),
      ),
    ).toBeDefined();
  });

  it('!bans shows "expires in Xm" for short-duration ban', async () => {
    // 30-minute ban → formatExpiry shows "expires in 30m" (mins < 60 branch)
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!ban *!*@short.host 30');
    await flush();
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!bans');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('*!*@short.host')),
    ).toBeDefined();
  });

  it('!bans shows "expires in XhYm" for > 1-hour ban', async () => {
    // 90-minute ban → formatExpiry shows "expires in 1h 30m" (rem > 0 branch)
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!ban *!*@medium.host 90');
    await flush();
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'OpUser', 'opuser', 'op.host', '#test', '!bans');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('*!*@medium.host')),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mode enforcement tests (need per-test setup due to mutable enforcement state)
// ---------------------------------------------------------------------------

describe('chanmod plugin — mode enforcement', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
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

  it('should re-op a user with +o flags when deopped externally', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeDefined();
  });

  it('should re-voice a user with +v flags when devoiced externally', async () => {
    bot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
    addToChannel(bot, 'Bob', 'bob', 'bob.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-v', 'Bob');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob'),
      ),
    ).toBeDefined();
  });

  it('should NOT re-op when the bot itself set -o', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'hexbot', '#test', '-o', 'Alice');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeUndefined();
  });

  it('should NOT re-op after an intentional !deop command', async () => {
    bot.permissions.addUser('admin', '*!admin@admin.host', 'no', 'test');
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');

    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop Alice');
    await tick();
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-o', 'Alice');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeUndefined();
  });

  it('should NOT enforce when enforce_modes is disabled', async () => {
    const disabledBot = createMockBot({ botNick: 'hexbot' });
    try {
      await disabledBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: false } },
      });

      disabledBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      addToChannel(disabledBot, 'Alice', 'alice', 'alice.host', '#test');

      simulateMode(disabledBot, 'EvilOp', '#test', '-o', 'Alice');
      await tick(50);

      expect(
        disabledBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
        ),
      ).toBeUndefined();
    } finally {
      disabledBot.cleanup();
    }
  });

  it('should suppress enforcement after repeated deops (rate limit)', async () => {
    const rateLimitBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(rateLimitBot, '#test');
      await rateLimitBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_delay_ms: 5, auto_op: false },
        },
      });

      rateLimitBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      addToChannel(rateLimitBot, 'Alice', 'alice', 'alice.host', '#test');

      for (let i = 0; i < 5; i++) {
        simulateMode(rateLimitBot, 'EvilOp', '#test', '-o', 'Alice');
      }
      await tick(50);

      const reOps = rateLimitBot.client.messages.filter(
        (m) => m.message === '+o' && m.args?.includes('Alice'),
      );
      expect(reOps).toHaveLength(3);
    } finally {
      rateLimitBot.cleanup();
    }
  });

  it('should NOT enforce for user without flags', async () => {
    addToChannel(bot, 'Rando', 'rando', 'rando.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-o', 'Rando');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Rando'),
      ),
    ).toBeUndefined();
  });

  it('should NOT re-op a user who only has voice flags when deopped', async () => {
    bot.permissions.addUser('voiceonly', '*!vonly@vonly.host', 'v', 'test');
    addToChannel(bot, 'VoiceOnly', 'vonly', 'vonly.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-o', 'VoiceOnly');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('VoiceOnly'),
      ),
    ).toBeUndefined();
  });

  it('should NOT re-voice a user who only has op flags when devoiced', async () => {
    bot.permissions.addUser('oponly', '*!oponly@oponly.host', 'o', 'test');
    addToChannel(bot, 'OpOnly', 'oponly', 'oponly.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-v', 'OpOnly');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('OpOnly'),
      ),
    ).toBeUndefined();
  });

  it('should NOT re-op a user with +d flag when deopped externally', async () => {
    bot.permissions.addUser('deopuser', '*!deop@deop.host', 'od', 'test');
    addToChannel(bot, 'DeopUser', 'deop', 'deop.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-o', 'DeopUser');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('DeopUser'),
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !op, !deop, !voice, !devoice + DM guards
// Shared bot instance — plugin loaded once, messages cleared between tests.
// ---------------------------------------------------------------------------

describe('chanmod plugin — mode commands', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('!op nick — should op the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op Alice');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeDefined();
  });

  it('!op with no args — should op the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  it('!op from unauthorized user — should not send mode', async () => {
    simulatePrivmsg(bot, 'Nobody', 'nobody', 'nobody.host', '#test', '!op Alice');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '+o'),
    ).toBeUndefined();
  });

  it('!deop nick — should deop the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop Alice');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Alice'),
      ),
    ).toBeDefined();
  });

  it('!deop bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop hexbot');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
    ).toBeUndefined();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('cannot deop myself'),
      ),
    ).toBeDefined();
  });

  it('!voice nick — should voice the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!voice Bob');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob'),
      ),
    ).toBeDefined();
  });

  it('!devoice nick — should devoice the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!devoice Bob');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-v' && m.args?.includes('Bob'),
      ),
    ).toBeDefined();
  });

  it('should sanitize nick with newline injection (bridge strips \\r\\n)', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op bad\r\nnick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('badnick'),
      ),
    ).toBeDefined();
  });

  it('!op with invalid nick (space) — should reject', async () => {
    await bot.dispatcher.dispatch('pub', {
      nick: 'Admin',
      ident: 'admin',
      hostname: 'admin.host',
      channel: '#test',
      text: '!op bad nick',
      command: '!op',
      args: 'bad nick',
      reply: (msg: string) => {
        bot.client.say('#test', msg);
      },
      replyPrivate: () => {},
    });
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
    ).toBeDefined();
  });

  it('!deop with invalid nick (space) — should reject', async () => {
    await bot.dispatcher.dispatch('pub', {
      nick: 'Admin',
      ident: 'admin',
      hostname: 'admin.host',
      channel: '#test',
      text: '!deop bad nick',
      command: '!deop',
      args: 'bad nick',
      reply: (msg: string) => {
        bot.client.say('#test', msg);
      },
      replyPrivate: () => {},
    });
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
    ).toBeDefined();
  });

  it('!voice with invalid nick (space) — should reject', async () => {
    await bot.dispatcher.dispatch('pub', {
      nick: 'Admin',
      ident: 'admin',
      hostname: 'admin.host',
      channel: '#test',
      text: '!voice bad nick',
      command: '!voice',
      args: 'bad nick',
      reply: (msg: string) => {
        bot.client.say('#test', msg);
      },
      replyPrivate: () => {},
    });
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
    ).toBeDefined();
  });

  it('!devoice with invalid nick (space) — should reject', async () => {
    await bot.dispatcher.dispatch('pub', {
      nick: 'Admin',
      ident: 'admin',
      hostname: 'admin.host',
      channel: '#test',
      text: '!devoice bad nick',
      command: '!devoice',
      args: 'bad nick',
      reply: (msg: string) => {
        bot.client.say('#test', msg);
      },
      replyPrivate: () => {},
    });
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
    ).toBeDefined();
  });

  // DM guard tests — null channel
  for (const cmd of ['!op', '!deop', '!voice', '!devoice', '!kick', '!ban', '!unban', '!kickban']) {
    it(`${cmd} in DM (no channel) — should do nothing`, async () => {
      await bot.dispatcher.dispatch('pub', {
        nick: 'Admin',
        ident: 'admin',
        hostname: 'admin.host',
        channel: null,
        text: `${cmd} alice`,
        command: cmd,
        args: 'alice',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(
        bot.client.messages.find(
          (m) => m.type === 'mode' || (m.type === 'raw' && m.message?.includes('KICK')),
        ),
      ).toBeUndefined();
    });
  }

  it('!kickban bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban hexbot');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('cannot ban myself')),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !kick (shared bot)
// ---------------------------------------------------------------------------

describe('chanmod plugin — kick command', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('!kick nick reason — should kick with reason', async () => {
    simulatePrivmsg(
      bot,
      'Admin',
      'admin',
      'admin.host',
      '#test',
      '!kick BadUser spamming the channel',
    );
    await flush();
    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser'),
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('spamming the channel');
  });

  it('!kick nick — should kick with default reason', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick BadUser');
    await flush();
    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser'),
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('Requested');
  });

  it('!kick with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage')),
    ).toBeDefined();
  });

  it('!kick bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick hexbot');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('KICK')),
    ).toBeUndefined();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('cannot kick myself'),
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !ban, !unban, !kickban (shared bot)
// ---------------------------------------------------------------------------

describe('chanmod plugin — ban commands', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('!ban nick — should ban with type-3 mask (*!*ident@*.domain)', async () => {
    addToChannel(bot, 'BadUser', 'bad', 'evil.host.com', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban BadUser');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*bad@*.host.com'),
      ),
    ).toBeDefined();
  });

  it('!ban nick — should error when hostmask unknown', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban GhostUser');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('Cannot resolve hostmask'),
      ),
    ).toBeDefined();
  });

  it('!ban explicit mask — should ban with that mask directly', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban *!*@bad.host.net');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@bad.host.net'),
      ),
    ).toBeDefined();
  });

  it('!ban bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban hexbot');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '+b'),
    ).toBeUndefined();
  });

  it('!unban mask — should remove ban', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban *!*@bad.host.net');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.includes('MODE #test -b *!*@bad.host.net'),
      ),
    ).toBeDefined();
  });

  it('!unban with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage')),
    ).toBeDefined();
  });

  it('!kickban nick reason — should ban then kick', async () => {
    addToChannel(bot, 'BadUser2', 'bad', 'evil.host.com', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(
      bot,
      'Admin',
      'admin',
      'admin.host',
      '#test',
      '!kickban BadUser2 being terrible',
    );
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*bad@*.host.com'),
      ),
    ).toBeDefined();
    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser2'),
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('being terrible');
  });

  it('!kickban with unknown hostmask — should error', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban GhostUser');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('Cannot resolve hostmask'),
      ),
    ).toBeDefined();
  });

  it('!ban with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage')),
    ).toBeDefined();
  });

  it('!kickban with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Usage')),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('chanmod plugin — teardown', () => {
  it('should clean up state on unload (teardown)', async () => {
    const bot = createMockBot({ botNick: 'hexbot' });
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
    });

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');

    await bot.pluginLoader.unload('chanmod');
    await tick(50);

    expect(bot.pluginLoader.isLoaded('chanmod')).toBe(false);
    bot.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Ban mask builder
// ---------------------------------------------------------------------------

describe('chanmod plugin — ban mask types', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH);
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('default type 3 — wildcards first hostname component', async () => {
    addToChannel(bot, 'Target', 'evil', 'sub.example.net', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban Target');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*evil@*.example.net'),
      ),
    ).toBeDefined();
  });

  it('type 1 — *!*@host', async () => {
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { default_ban_type: 1 } },
    });
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
    addToChannel(bot, 'Target', 'evil', 'sub.example.net', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban Target');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@sub.example.net'),
      ),
    ).toBeDefined();
  });

  it('type 2 — *!*ident@host', async () => {
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { default_ban_type: 2 } },
    });
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
    addToChannel(bot, 'Target', 'evil', 'sub.example.net', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban Target');
    await flush();
    expect(
      bot.client.messages.find(
        (m) =>
          m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*evil@sub.example.net'),
      ),
    ).toBeDefined();
  });

  it('cloaked hostmask — uses exact cloak regardless of type', async () => {
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { default_ban_type: 3 } },
    });
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
    addToChannel(bot, 'Cloaked', 'cloaked', 'user/foo', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban Cloaked');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@user/foo'),
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Timed bans
// ---------------------------------------------------------------------------

describe('chanmod plugin — timed bans', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH);
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });
  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('!ban with duration stores record in DB', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban *!*@timed.host 60');
    await flush();
    const entry = bot.db.get('_bans', 'ban:#test:*!*@timed.host');
    expect(entry).toBeDefined();
    const record = JSON.parse(entry!) as { mask: string; expires: number };
    expect(record.mask).toBe('*!*@timed.host');
    expect(record.expires).toBeGreaterThan(Date.now());
  });

  it('!ban with 0 duration stores permanent record (expires=0)', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban *!*@perm.host 0');
    await flush();
    const entry = bot.db.get('_bans', 'ban:#test:*!*@perm.host');
    expect(entry).toBeDefined();
    const record = JSON.parse(entry!) as { expires: number };
    expect(record.expires).toBe(0);
  });

  it('!bans lists active bans', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!bans');
    await flush();
    const replies = bot.client.messages.filter((m) => m.type === 'say' && m.target === '#test');
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.some((r) => r.message?.includes('*!*@timed.host'))).toBe(true);
  });

  it('!bans reports no bans when channel has none', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!bans #empty');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('No tracked bans')),
    ).toBeDefined();
  });

  it('!unban removes DB record', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban *!*@timed.host');
    await flush();
    const entry = bot.db.get('_bans', 'ban:#test:*!*@timed.host');
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Channel mode enforcement
// ---------------------------------------------------------------------------

describe('chanmod plugin — channel mode enforcement', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { enforce_channel_modes: '+nt', enforce_modes: true, enforce_delay_ms: 5 },
      },
    });
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('re-applies +t when stripped by an external user', async () => {
    bot.client.clearMessages();
    simulateMode(bot, 'EvilOp', '#test', '-t', '');
    await tick(50);
    // Channel modes (no param) are sent via raw(), not mode()
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +t'),
    ).toBeDefined();
  });

  it('re-applies +n when stripped by an external user', async () => {
    bot.client.clearMessages();
    simulateMode(bot, 'EvilOp', '#test', '-n', '');
    await tick(50);
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +n'),
    ).toBeDefined();
  });

  it('does NOT re-apply when setter is in nodesynch_nicks (ChanServ)', async () => {
    bot.client.clearMessages();
    simulateMode(bot, 'ChanServ', '#test', '-t', '');
    await tick(50);
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +t'),
    ).toBeUndefined();
  });

  it('does NOT re-apply when the bot itself removes the mode', async () => {
    bot.client.clearMessages();
    simulateMode(bot, 'hexbot', '#test', '-t', '');
    await tick(50);
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +t'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Protection: rejoin on kick + revenge
// ---------------------------------------------------------------------------

describe('chanmod plugin — rejoin on kick', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 10,
          max_rejoin_attempts: 3,
          rejoin_attempt_window_ms: 300_000,
          revenge_on_kick: false,
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

  it('rejoins after being kicked', async () => {
    bot.client.simulateEvent('kick', {
      nick: 'Kicker',
      channel: '#test',
      kicked: 'hexbot',
      message: 'bye',
    });
    await tick(20);
    expect(
      bot.client.messages.find((m) => m.type === 'join' && m.target === '#test'),
    ).toBeDefined();
  });

  it('does not rejoin when a different user is kicked', async () => {
    bot.client.simulateEvent('kick', {
      nick: 'Kicker',
      channel: '#test',
      kicked: 'Alice',
      message: '',
    });
    await tick(20);
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();
  });

  it('suppresses rejoin after max_rejoin_attempts in window', async () => {
    for (let i = 0; i < 3; i++) {
      bot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: '',
      });
      await tick(20);
    }
    // 4th kick — should be suppressed
    bot.client.clearMessages();
    bot.client.simulateEvent('kick', {
      nick: 'Kicker',
      channel: '#test',
      kicked: 'hexbot',
      message: '',
    });
    await tick(20);
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();
  });

  it('does not rejoin when rejoin_on_kick is false', async () => {
    const noRejoinBot = createMockBot({ botNick: 'hexbot' });
    try {
      const result = await noRejoinBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { rejoin_on_kick: false } },
      });
      expect(result.status).toBe('ok');
      noRejoinBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: '',
      });
      await tick(20);
      expect(noRejoinBot.client.messages.find((m) => m.type === 'join')).toBeUndefined();
    } finally {
      noRejoinBot.cleanup();
    }
  });
});

describe('chanmod plugin — revenge on kick', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    addToChannel(bot, 'Kicker', 'kicker', 'kicker.host', '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          rejoin_on_kick: true,
          rejoin_delay_ms: 10,
          revenge_on_kick: true,
          revenge_action: 'deop',
          revenge_delay_ms: 10,
          revenge_exempt_flags: 'nm',
          max_rejoin_attempts: 3,
          rejoin_attempt_window_ms: 300_000,
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

  it('deops kicker after rejoin when revenge_action is "deop"', async () => {
    addToChannel(bot, 'Kicker', 'kicker', 'kicker.host', '#test');
    giveBotOps(bot, '#test');
    bot.client.simulateEvent('kick', {
      nick: 'Kicker',
      channel: '#test',
      kicked: 'hexbot',
      message: 'bye',
    });
    // Fire rejoin timer
    await tick(10);
    // Simulate bot rejoining and getting ops (as ChanServ would provide in real IRC)
    giveBotOps(bot, '#test');
    // Fire revenge timer
    await tick(10);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Kicker'),
      ),
    ).toBeDefined();
  });

  it('kicks kicker when revenge_action is "kick"', async () => {
    const kickRevengeBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(kickRevengeBot, '#test');
      addToChannel(kickRevengeBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      const result = await kickRevengeBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: true,
            revenge_action: 'kick',
            revenge_delay_ms: 10,
            revenge_exempt_flags: '',
            max_rejoin_attempts: 3,
            rejoin_attempt_window_ms: 300_000,
            revenge_kick_reason: "Don't kick me.",
          },
        },
      });
      expect(result.status).toBe('ok');
      addToChannel(kickRevengeBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      giveBotOps(kickRevengeBot, '#test');
      kickRevengeBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      await tick(10);
      // Simulate bot rejoining and getting ops
      giveBotOps(kickRevengeBot, '#test');
      await tick(10);
      expect(
        kickRevengeBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Kicker'),
        ),
      ).toBeDefined();
    } finally {
      kickRevengeBot.cleanup();
    }
  });

  it('kickbans kicker when revenge_action is "kickban"', async () => {
    const kickbanBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(kickbanBot, '#test');
      addToChannel(kickbanBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      await kickbanBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: true,
            revenge_action: 'kickban',
            revenge_delay_ms: 10,
            revenge_exempt_flags: '',
            max_rejoin_attempts: 3,
            rejoin_attempt_window_ms: 300_000,
            revenge_kick_reason: "Don't kick me.",
            default_ban_duration: 60,
          },
        },
      });
      addToChannel(kickbanBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      giveBotOps(kickbanBot, '#test');
      kickbanBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      await tick(10);
      giveBotOps(kickbanBot, '#test');
      await tick(10);
      // Should have sent +b (ban) and KICK
      expect(
        kickbanBot.client.messages.find((m) => m.type === 'mode' && m.message === '+b'),
      ).toBeDefined();
      expect(
        kickbanBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Kicker'),
        ),
      ).toBeDefined();
    } finally {
      kickbanBot.cleanup();
    }
  });

  it('skips revenge when kicker has exempt flag', async () => {
    bot.permissions.addUser('Kicker', '*!kicker@kicker.host', 'n', 'test');
    addToChannel(bot, 'Kicker', 'kicker', 'kicker.host', '#test');
    giveBotOps(bot, '#test');
    bot.client.simulateEvent('kick', {
      nick: 'Kicker',
      channel: '#test',
      kicked: 'hexbot',
      message: '',
    });
    await tick(10);
    giveBotOps(bot, '#test');
    await tick(10);
    // Should have rejoined but NOT deopped
    expect(bot.client.messages.find((m) => m.type === 'join')).toBeDefined();
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bitch mode
// ---------------------------------------------------------------------------

describe('chanmod plugin — bitch mode', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { bitch: true, enforce_delay_ms: 5, op_flags: ['o', 'n', 'm'] },
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

  it('deops a user who gains +o without op flags', async () => {
    addToChannel(bot, 'Intruder', 'int', 'int.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'SomeOp', '#test', '+o', 'Intruder');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Intruder'),
      ),
    ).toBeDefined();
  });

  it('does NOT deop a user who gains +o with op flags', async () => {
    bot.permissions.addUser('trusted', '*!trusted@trusted.host', 'o', 'test');
    addToChannel(bot, 'Trusted', 'trusted', 'trusted.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'SomeOp', '#test', '+o', 'Trusted');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Trusted'),
      ),
    ).toBeUndefined();
  });

  it('deops a +d user who gains +o even with op flags (bitch mode)', async () => {
    bot.permissions.addUser('deopped', '*!deopped@deopped.host', 'od', 'test');
    addToChannel(bot, 'Deopped', 'deopped', 'deopped.host', '#test');
    giveBotOps(bot, '#test');
    bot.client.clearMessages();
    simulateMode(bot, 'SomeOp', '#test', '+o', 'Deopped');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Deopped'),
      ),
    ).toBeDefined();
  });

  it('does NOT deop when the setter is a nodesynch nick', async () => {
    addToChannel(bot, 'Intruder', 'int', 'int.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'ChanServ', '#test', '+o', 'Intruder');
    await tick(20);
    expect(
      bot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
    ).toBeUndefined();
  });

  it('does NOT deop the bot itself', async () => {
    giveBotOps(bot, '#test');
    simulateMode(bot, 'SomeOp', '#test', '+o', 'hexbot');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('hexbot'),
      ),
    ).toBeUndefined();
  });

  it('dehalfs a user who gains +h without halfop flags (halfop_flags is empty)', async () => {
    addToChannel(bot, 'Intruder', 'int', 'int.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'SomeOp', '#test', '+h', 'Intruder');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-h' && m.args?.includes('Intruder'),
      ),
    ).toBeDefined();
  });

  it('does NOT dehalf a user with halfop flag when halfop_flags is non-empty', async () => {
    // This test exercises the ternary false branch in bitch mode for +h with non-empty halfop_flags
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { bitch: true, halfop_flags: ['v'], enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('trusted', '*!trusted@trusted.host', 'v', 'test');
      addToChannel(freshBot, 'Trusted', 'trusted', 'trusted.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '+h', 'Trusted');
      await tick(20);

      // Trusted has the 'v' flag which is in halfop_flags → isAuthorized=true → no dehalf
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-h' && m.args?.includes('Trusted'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Punish deop
// ---------------------------------------------------------------------------

describe('chanmod plugin — punish deop', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          enforce_modes: true,
          punish_deop: true,
          punish_action: 'kick',
          punish_kick_reason: "Don't deop my friends.",
          op_flags: ['o', 'n', 'm'],
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

  it('kicks setter when they deop a flagged op', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'Badguy', 'bad', 'bad.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'Badguy', '#test', '-o', 'Alice');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Badguy'),
      ),
    ).toBeDefined();
  });

  it('does NOT kick setter when they have op flags', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    bot.permissions.addUser('goodop', '*!goodop@goodop.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'GoodOp', 'goodop', 'goodop.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'GoodOp', '#test', '-o', 'Alice');
    await tick(20);
    // No kick for GoodOp — they're authorized
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('GoodOp'),
      ),
    ).toBeUndefined();
  });

  it('does NOT punish if target had no op flags', async () => {
    // Alice has no flags — deop of an unflagged person should not trigger punishment
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'Badguy', 'bad', 'bad.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'Badguy', '#test', '-o', 'Alice');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Badguy'),
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enforcebans
// ---------------------------------------------------------------------------

describe('chanmod plugin — enforcebans', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { enforcebans: true } },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  it('kicks a user whose hostmask matches a new ban mask', async () => {
    addToChannel(bot, 'Spammer', 'spam', 'evil.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'Admin', '#test', '+b', '*!*@evil.host');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Spammer'),
      ),
    ).toBeDefined();
  });

  it('does not kick a user whose hostmask does not match', async () => {
    addToChannel(bot, 'Innocent', 'good', 'good.host', '#test');
    giveBotOps(bot, '#test');
    simulateMode(bot, 'Admin', '#test', '+b', '*!*@evil.host');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Innocent'),
      ),
    ).toBeUndefined();
  });

  it('does not kick the bot itself even if it matches', async () => {
    giveBotOps(bot, '#test');
    simulateMode(bot, 'Admin', '#test', '+b', '*!*@*');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('hexbot'),
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nick recovery
// ---------------------------------------------------------------------------

describe('chanmod plugin — nick recovery', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { nick_recovery: true },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => bot.cleanup());
  beforeEach(() => bot.client.clearMessages());

  it('sends NICK when holder changes their nick', async () => {
    bot.client.simulateEvent('nick', {
      nick: 'hexbot',
      ident: 'u',
      hostname: 'h',
      new_nick: 'hexbot_old',
    });
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
    ).toBeDefined();
  });

  it('sends NICK when holder quits', async () => {
    // Bot is using hexbot_ (currentNick) but wants to reclaim hexbot (botNick = config nick)
    const freshBot = createMockBot({ botNick: 'hexbot', currentNick: 'hexbot_' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { nick_recovery: true } },
      });
      // Simulate the holder of 'hexbot' quitting — bridge won't filter it (bot is 'hexbot_')
      freshBot.client.simulateEvent('quit', {
        nick: 'hexbot',
        ident: 'u',
        hostname: 'h',
        message: 'bye',
      });
      await flush();
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does not send NICK for unrelated nick changes', async () => {
    bot.client.simulateEvent('nick', {
      nick: 'alice',
      ident: 'a',
      hostname: 'a.host',
      new_nick: 'alice_',
    });
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
    ).toBeUndefined();
  });

  it('respects 30s backoff — only attempts once in window', async () => {
    bot.client.simulateEvent('nick', {
      nick: 'hexbot',
      ident: 'u',
      hostname: 'h',
      new_nick: 'hexbot2',
    });
    await flush();
    bot.client.clearMessages();
    // Second attempt within 30s window should be suppressed
    bot.client.simulateEvent('quit', { nick: 'hexbot', ident: 'u', hostname: 'h', message: 'bye' });
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
    ).toBeUndefined();
  });

  it('no-op when nick_recovery is false', async () => {
    const noRecoveryBot = createMockBot({ botNick: 'hexbot' });
    try {
      await noRecoveryBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { nick_recovery: false } },
      });
      noRecoveryBot.client.simulateEvent('nick', {
        nick: 'hexbot',
        ident: 'u',
        hostname: 'h',
        new_nick: 'hexbot_old',
      });
      await flush();
      expect(
        noRecoveryBot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
      ).toBeUndefined();
    } finally {
      noRecoveryBot.cleanup();
    }
  });

  it('sends GHOST + deferred NICK when ghost mode is enabled', async () => {
    const ghostBot = createMockBot({ botNick: 'hexbot' });
    // Password stored in bot.json (not plugins.json) per SECURITY.md §6
    ghostBot.botConfig.chanmod = { nick_recovery_password: 's3cr3t' };
    try {
      await ghostBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            nick_recovery: true,
            nick_recovery_ghost: true,
          },
        },
      });
      ghostBot.client.simulateEvent('nick', {
        nick: 'hexbot',
        ident: 'u',
        hostname: 'h',
        new_nick: 'hexbot_old',
      });
      await flush();
      // GHOST via NickServ
      expect(
        ghostBot.client.messages.find(
          (m) => m.type === 'say' && m.target === 'NickServ' && m.message?.includes('GHOST'),
        ),
      ).toBeDefined();
      // NICK sent after 2s delay
      await tick(2100);
      expect(
        ghostBot.client.messages.find((m) => m.type === 'raw' && m.message === 'NICK hexbot'),
      ).toBeDefined();
    } finally {
      ghostBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stopnethack
// ---------------------------------------------------------------------------

describe('chanmod plugin — stopnethack mode 1 (isoptest)', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => bot.cleanup());
  beforeEach(() => {
    bot.client.clearMessages();
    // Reset split state between tests
    bot.db.del('chanset', '#test:bitch');
  });

  const triggerSplit = async () => {
    for (let i = 0; i < 3; i++) {
      bot.client.simulateEvent('quit', {
        nick: `leaf${i}`,
        ident: 'u',
        hostname: 'h',
        message: 'hub.example.net leaf.example.net',
      });
      await flush();
    }
  };

  it('deops user without op flags during split', async () => {
    await triggerSplit();
    bot.permissions.addUser('noflag', '*!noflag@noflag.host', 'v', 'test');
    addToChannel(bot, 'noflag', 'noflag', 'noflag.host', '#test');
    simulateMode(bot, 'server.net', '#test', '+o', 'noflag');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('noflag'),
      ),
    ).toBeDefined();
  });

  it('keeps user with op flags during split', async () => {
    await triggerSplit();
    bot.permissions.addUser('opuser', '*!opuser@opuser.host', 'o', 'test');
    addToChannel(bot, 'opuser', 'opuser', 'opuser.host', '#test');
    simulateMode(bot, 'server.net', '#test', '+o', 'opuser');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('opuser'),
      ),
    ).toBeUndefined();
  });

  it('does not deop when split is not active (below threshold)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      // Only 2 split quits — below threshold of 3
      for (let i = 0; i < 2; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `leaf${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'hub.example.net leaf.example.net',
        });
        await flush();
      }
      freshBot.client.clearMessages();
      freshBot.permissions.addUser('anyone', '*!anyone@host', 'v', 'test');
      addToChannel(freshBot, 'anyone', 'anyone', 'host', '#test');
      simulateMode(freshBot, 'server.net', '#test', '+o', 'anyone');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

describe('chanmod plugin — stopnethack mode 2 (wasoptest)', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { stopnethack_mode: 2, split_timeout_ms: 60000, enforce_delay_ms: 10 },
      },
    });
    expect(result.status).toBe('ok');
  });

  afterAll(() => bot.cleanup());
  beforeEach(() => bot.client.clearMessages());

  it('keeps user who had ops before split (snapshot)', async () => {
    // Give alice ops before split
    addToChannel(bot, 'alice', 'alice', 'alice.host', '#test');
    simulateMode(bot, 'ChanServ', '#test', '+o', 'alice');
    await flush();
    bot.client.clearMessages();

    // Trigger split (3 split quits → snapshot taken, alice should be in it)
    for (let i = 0; i < 3; i++) {
      bot.client.simulateEvent('quit', {
        nick: `leaf${i}`,
        ident: 'u',
        hostname: 'h',
        message: 'hub.net leaf.net',
      });
      await flush();
    }

    // alice rejoins and gets +o from server during split
    simulateMode(bot, 'server.net', '#test', '+o', 'alice');
    await tick(20);
    // alice was in snapshot → not deopped
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('alice'),
      ),
    ).toBeUndefined();
  });

  it('deops user who did NOT have ops before split', async () => {
    // bob was NOT opped before split
    addToChannel(bot, 'bob', 'bob', 'bob.host', '#test');
    bot.client.clearMessages();

    // Trigger split
    for (let i = 0; i < 3; i++) {
      bot.client.simulateEvent('quit', {
        nick: `server${i}`,
        ident: 'u',
        hostname: 'h',
        message: 'hub.net leaf.net',
      });
      await flush();
    }

    // bob gets +o from server during split
    simulateMode(bot, 'server.net', '#test', '+o', 'bob');
    await tick(20);
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('bob'),
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ban/unban/kickban edge cases (uncovered paths)
// ---------------------------------------------------------------------------

describe('chanmod plugin — ban/unban/kickban edge cases', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH);
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  // No-ops guard: !op, !deop, !voice, !devoice, !kick, !ban (use #noops where bot has no mode)
  for (const cmd of ['!op', '!deop', '!voice', '!devoice', '!kick', '!ban'] as const) {
    it(`${cmd} when bot has no ops → rejects`, async () => {
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#noops', `${cmd} SomeUser`);
      await flush();
      expect(
        bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('not opped')),
      ).toBeDefined();
    });
  }

  // No halfop guard: !halfop, !dehalfop (use #noops where bot has neither +h nor +o)
  for (const cmd of ['!halfop', '!dehalfop'] as const) {
    it(`${cmd} when bot cannot halfop → rejects`, async () => {
      simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#noops', `${cmd} SomeUser`);
      await flush();
      expect(
        bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('do not have')),
      ).toBeDefined();
    });
  }

  // Invalid nick for !halfop and !dehalfop (multi-word args, dispatch directly)
  for (const cmd of ['!halfop', '!dehalfop'] as const) {
    it(`${cmd} with invalid nick → rejects`, async () => {
      await bot.dispatcher.dispatch('pub', {
        nick: 'Admin',
        ident: 'admin',
        hostname: 'admin.host',
        channel: '#test',
        text: `${cmd} bad nick`,
        command: cmd,
        args: 'bad nick',
        reply: (msg: string) => {
          bot.client.say('#test', msg);
        },
        replyPrivate: () => {},
      });
      expect(
        bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
      ).toBeDefined();
    });
  }

  // !bans DM guard (null channel)
  it('!bans in DM (no channel) → does nothing', async () => {
    await bot.dispatcher.dispatch('pub', {
      nick: 'Admin',
      ident: 'admin',
      hostname: 'admin.host',
      channel: null,
      text: '!bans',
      command: '!bans',
      args: '',
      reply: () => {},
      replyPrivate: () => {},
    });
    expect(bot.client.messages.find((m) => m.type === 'say')).toBeUndefined();
  });

  // No-args variants (ctx.nick fallback): !deop, !voice, !devoice, !halfop, !dehalfop
  it('!deop with no args → deops the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  it('!voice with no args → voices the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!voice');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  it('!devoice with no args → devoices the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!devoice');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-v' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  it('!halfop with no args → halfops the caller', async () => {
    // Give bot halfop ability first by giving it ops
    giveBotOps(bot, '#test');
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!halfop');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  it('!dehalfop with no args → dehalfops the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!dehalfop');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-h' && m.args?.includes('Admin'),
      ),
    ).toBeDefined();
  });

  // DM guards for !halfop and !dehalfop
  for (const cmd of ['!halfop', '!dehalfop'] as const) {
    it(`${cmd} in DM (no channel) → does nothing`, async () => {
      await bot.dispatcher.dispatch('pub', {
        nick: 'Admin',
        ident: 'admin',
        hostname: 'admin.host',
        channel: null,
        text: `${cmd} Alice`,
        command: cmd,
        args: 'Alice',
        reply: () => {},
        replyPrivate: () => {},
      });
      expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
    });
  }

  // !ban nick with 0 duration → "permanent" log entry
  it('!ban nick with duration 0 → permanent ban', async () => {
    addToChannel(bot, 'PermTarget', 'pt', 'perm.host.com', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban PermTarget 0');
    await flush();
    expect(bot.client.messages.find((m) => m.type === 'mode' && m.message === '+b')).toBeDefined();
  });

  // !ban — multi-word target (space) fails isValidNick → "Invalid nick."
  it('!ban multi-word target → invalid nick', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban bad user');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('Invalid nick')),
    ).toBeDefined();
  });

  // !ban — user with empty hostname → buildBanMask returns null
  it('!ban user with empty hostname → cannot build ban mask', async () => {
    addToChannel(bot, 'NoHost', 'nh', '', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban NoHost');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('Cannot build ban mask'),
      ),
    ).toBeDefined();
  });

  // !unban — bot has no ops (use a channel the bot was never given ops in)
  it('!unban when bot has no ops → rejects', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#noops', '!unban *!*@host');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('not opped')),
    ).toBeDefined();
  });

  // !unban — valid nick, not in channel → "not in the channel"
  it('!unban nick not in channel → reports not in channel', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban GhostNick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('not in the channel'),
      ),
    ).toBeDefined();
  });

  // !unban — nick in channel with stored ban record → removes stored mask (match path)
  it('!unban nick with stored ban record → removes that mask', async () => {
    addToChannel(bot, 'BanTarget', 'bt', 'ban.target.com', '#test');
    // Ban them first to create a stored record
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban BanTarget');
    await flush();
    // Now unban by nick — should find the stored mask
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban BanTarget');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('MODE #test -b')),
    ).toBeDefined();
  });

  // !unban — nick in channel but no stored ban record → sends -b for all candidate masks
  it('!unban nick with no stored record → sends -b for all candidate masks', async () => {
    addToChannel(bot, 'CleanNick', 'cn', 'clean.nick.com', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban CleanNick');
    await flush();
    // Should have sent at least one MODE -b (trying all 3 candidate masks)
    expect(
      bot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('MODE #test -b')),
    ).toBeDefined();
  });

  // !kickban — bot has no ops
  it('!kickban when bot has no ops → rejects', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#noops', '!kickban SomeUser');
    await flush();
    expect(
      bot.client.messages.find((m) => m.type === 'say' && m.message?.includes('not opped')),
    ).toBeDefined();
  });

  // !kickban — user with empty hostname → buildBanMask returns null
  it('!kickban user with empty hostname → cannot build ban mask', async () => {
    addToChannel(bot, 'NoHostKick', 'nhk', '', '#test');
    bot.client.clearMessages();
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban NoHostKick');
    await flush();
    expect(
      bot.client.messages.find(
        (m) => m.type === 'say' && m.message?.includes('Cannot build ban mask'),
      ),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// channel_modes enforcement on bot join (auto-op.ts lines 16-27)
// ---------------------------------------------------------------------------
describe('chanmod plugin — channel_modes enforcement on bot join', () => {
  it('applies missing channel modes after modesReady fires on bot join', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+n', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#newchan');
      freshBot.client.clearMessages();
      // Simulate RPL_CHANNELMODEIS reply (channel has no modes yet)
      simulateChannelInfo(freshBot, '#newchan', '');
      await tick(10);
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #newchan +n'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// NickServ verification failure on auto-op (auto-op.ts lines 57-66)
// ---------------------------------------------------------------------------
describe('chanmod plugin — NickServ auto-op verification failure', () => {
  it('skips auto-op and sends notice when NickServ verification fails', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: true } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      vi.spyOn(freshBot.services, 'verifyUser').mockResolvedValue({
        verified: false,
        account: null,
      });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      await tick();
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeUndefined();
      expect(
        freshBot.client.messages.find((m) => m.type === 'notice' && m.target === 'Alice'),
      ).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('applies auto-op when NickServ verification succeeds', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: true } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      vi.spyOn(freshBot.services, 'verifyUser').mockResolvedValue({
        verified: true,
        account: 'alice',
      });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      await tick();
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('skips notice when NickServ verification fails with notify_on_fail=false', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: false } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      vi.spyOn(freshBot.services, 'verifyUser').mockResolvedValue({
        verified: false,
        account: null,
      });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      await tick();
      // Neither op nor notice should be sent
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeUndefined();
      expect(
        freshBot.client.messages.find((m) => m.type === 'notice' && m.target === 'Alice'),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// IRCv3 account-tag fast path for auto-op
// ---------------------------------------------------------------------------
// Regression coverage for the Phase 1 audit finding — the join bind uses flag
// `'-'` which bypasses the dispatcher's VerificationProvider gate, so the
// only thing standing between a compromised nick and an ACC race is the
// manual gate inside grantMode(). These tests lock in that gate for every
// mode path and prove the extended-join fast path skips NickServ.
describe('chanmod plugin — account-tag auto-op fast path', () => {
  it('uses extended-join account instead of NickServ when account present on JOIN', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: true } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      const verifyUser = vi
        .spyOn(freshBot.services, 'verifyUser')
        .mockResolvedValue({ verified: true, account: 'alice' });
      freshBot.client.clearMessages();
      freshBot.client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#test',
        account: 'alice',
      });
      await tick();
      expect(verifyUser).not.toHaveBeenCalled();
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('refuses auto-op when extended-join says the nick is not identified', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: true } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      const verifyUser = vi
        .spyOn(freshBot.services, 'verifyUser')
        .mockResolvedValue({ verified: true, account: 'alice' });
      freshBot.client.clearMessages();
      freshBot.client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#test',
        account: '*',
      });
      await tick();
      expect(verifyUser).not.toHaveBeenCalled();
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('falls back to NickServ verifyUser when no account tag is attached', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+o'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { notify_on_fail: true } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      const verifyUser = vi
        .spyOn(freshBot.services, 'verifyUser')
        .mockResolvedValue({ verified: true, account: 'alice' });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      await tick();
      expect(verifyUser).toHaveBeenCalledWith('Alice');
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Alice')),
      ).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('gates +h auto-halfop via verifyUser when require_acc_for includes +h', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+h'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          // User-permission flag 'v' is mapped to halfop here (halfop_flags
          // is a user-flag list, and 'h' is not a valid permission flag per
          // VALID_FLAGS = 'nmovd'). The test proves verifyUser still gates
          // the +h grant — independent of which user flag drove it.
          config: { op_flags: [], halfop_flags: ['v'], voice_flags: [], notify_on_fail: true },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      const verifyUser = vi
        .spyOn(freshBot.services, 'verifyUser')
        .mockResolvedValue({ verified: false, account: null });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Bob', 'bob', 'bob.host', '#test');
      await tick();
      expect(verifyUser).toHaveBeenCalledWith('Bob');
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Bob')),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });

  it('gates +v auto-voice via verifyUser when require_acc_for includes +v', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      freshBot.pluginLoader.getBotConfig().identity.require_acc_for = ['+v'];
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { op_flags: [], halfop_flags: [], voice_flags: ['v'], notify_on_fail: true },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('carol', '*!carol@carol.host', 'v', 'test');
      vi.spyOn(freshBot.services, 'isAvailable').mockReturnValue(true);
      const verifyUser = vi
        .spyOn(freshBot.services, 'verifyUser')
        .mockResolvedValue({ verified: false, account: null });
      freshBot.client.clearMessages();
      simulateJoin(freshBot, 'Carol', 'carol', 'carol.host', '#test');
      await tick();
      expect(verifyUser).toHaveBeenCalledWith('Carol');
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.args?.includes('Carol')),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Ban auto-lift: startup timer and time bind (bans.ts lines 65-68, 73)
// ---------------------------------------------------------------------------
describe('chanmod plugin — ban auto-lift timers', () => {
  it('lifts expired bans when startup timer fires (5s after load)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH);
      const mask = '*!bad@bad.host';
      freshBot.db.set(
        '_bans',
        `ban:#test:${mask}`,
        JSON.stringify({
          mask,
          channel: '#test',
          by: 'admin',
          ts: Date.now() - 3 * 60_000,
          expires: Date.now() - 60_000,
        }),
      );
      freshBot.client.clearMessages();
      await tick(5001);
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('-b') && m.message.includes(mask),
        ),
      ).toBeDefined();
      expect(freshBot.db.get('_bans', `ban:#test:${mask}`)).toBeNull();
    } finally {
      freshBot.cleanup();
    }
  });

  it('lifts expired bans when the 60s time bind fires', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH);
      // Advance past startup timer so it doesn't consume the ban record
      await tick(5001);
      freshBot.client.clearMessages();
      const mask = '*!stale@old.host';
      freshBot.db.set(
        '_bans',
        `ban:#test:${mask}`,
        JSON.stringify({
          mask,
          channel: '#test',
          by: 'admin',
          ts: Date.now() - 3 * 60_000,
          expires: Date.now() - 60_000,
        }),
      );
      // Advance to fire the 60s time bind
      await tick(60001);
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('-b') && m.message.includes(mask),
        ),
      ).toBeDefined();
      expect(freshBot.db.get('_bans', `ban:#test:${mask}`)).toBeNull();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// punishDeop rate limit — PUNISH_MAX (mode-enforce.ts lines 237-241)
// ---------------------------------------------------------------------------
describe('chanmod plugin — punishDeop rate limit', () => {
  it('suppresses punishment after PUNISH_MAX (2) punishments in the cooldown window', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { punish_deop: true, punish_action: 'kick', enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      addToChannel(freshBot, 'Badguy', 'bad', 'bad.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      for (let i = 0; i < 3; i++) {
        simulateMode(freshBot, 'Badguy', '#test', '-o', 'Alice');
      }
      await tick(20);
      const kicks = freshBot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Badguy'),
      );
      expect(kicks).toHaveLength(2);
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// punishDeop kickban action (mode-enforce.ts lines 249-255)
// ---------------------------------------------------------------------------
describe('chanmod plugin — punishDeop kickban action', () => {
  it('kickbans the setter when punish_action is "kickban"', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { punish_deop: true, punish_action: 'kickban', enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      addToChannel(freshBot, 'Badguy', 'bad', 'bad.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'Badguy', '#test', '-o', 'Alice');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '+b'),
      ).toBeDefined();
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Badguy'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// revenge on kick — kickban action (protection.ts lines 137-148)
// ---------------------------------------------------------------------------
describe('chanmod plugin — revenge on kick kickban', () => {
  it('kickbans the kicker when revenge_action is "kickban"', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      const result = await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: true,
            revenge_action: 'kickban',
            revenge_delay_ms: 10,
            revenge_exempt_flags: '',
            max_rejoin_attempts: 3,
            rejoin_attempt_window_ms: 300_000,
          },
        },
      });
      expect(result.status).toBe('ok');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      freshBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      // Fire rejoin timer
      await tick(10);
      // Simulate bot rejoining and getting ops
      giveBotOps(freshBot, '#test');
      // Fire revenge timer
      await tick(10);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '+b'),
      ).toBeDefined();
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('Kicker'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// revenge on kick — skipped when bot has no ops (protection.ts lines 115-117)
// ---------------------------------------------------------------------------
describe('chanmod plugin — revenge skipped without ops', () => {
  it('does NOT execute revenge when bot has no ops after rejoining', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      const result = await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: true,
            revenge_action: 'deop',
            revenge_delay_ms: 10,
            revenge_exempt_flags: '',
            max_rejoin_attempts: 3,
            rejoin_attempt_window_ms: 300_000,
          },
        },
      });
      expect(result.status).toBe('ok');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      freshBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: 'out',
      });
      // Fire rejoin timer (bot rejoins but does NOT get ops)
      await tick(10);
      // Fire revenge timer — bot has no ops, revenge should be skipped
      await tick(10);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// cycle_on_deop: bot self-deop triggers part+rejoin (mode-enforce.ts lines 60-91)
// ---------------------------------------------------------------------------
describe('chanmod plugin — cycle on deop', () => {
  it('parts and rejoins after MAX_ENFORCEMENTS (3) bot self-deops', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { cycle_on_deop: true, cycle_delay_ms: 10 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      // Three bot self-deops are required to reach MAX_ENFORCEMENTS (3)
      for (let i = 0; i < 3; i++) {
        simulateMode(freshBot, 'SomeOp', '#test', '-o', 'hexbot');
      }
      // Advance past cycle_delay_ms (10ms) + rejoin delay (2000ms)
      await tick(2200);
      expect(
        freshBot.client.messages.find((m) => m.type === 'part' && m.target === '#test'),
      ).toBeDefined();
      expect(
        freshBot.client.messages.find((m) => m.type === 'join' && m.target === '#test'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Halfop enforcement: re-halfop a flagged user (mode-enforce.ts lines 192-200)
// ---------------------------------------------------------------------------
describe('chanmod plugin — halfop enforcement', () => {
  it('re-halfopts a flagged user who is dehalfopped', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, halfop_flags: ['v'], enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'v', 'test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'Badguy', '#test', '-h', 'Alice');
      await tick(20);
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '+h' && m.args?.includes('Alice'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Rejoin window expiry reset (protection.ts line 86)
// ---------------------------------------------------------------------------
describe('chanmod plugin — rejoin window expiry reset', () => {
  it('resets the rejoin counter after the attempt window expires', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: false,
            max_rejoin_attempts: 1,
            rejoin_attempt_window_ms: 1000,
          },
        },
      });

      let now = 1_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

      // First kick: count reaches max_rejoin_attempts (1) — bot rejoins
      freshBot.client.simulateEvent('kick', {
        nick: 'Op',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      await tick(15);
      freshBot.client.clearMessages();

      // Advance past window expiry (1000ms)
      now += 2000;
      dateSpy.mockReturnValue(now);

      // Second kick: window has expired → counter resets → bot rejoins again
      freshBot.client.simulateEvent('kick', {
        nick: 'Op',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      await tick(15);
      expect(freshBot.client.messages.find((m) => m.type === 'join')).toBeDefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stopnethack split window expiry (protection.ts line 235)
// ---------------------------------------------------------------------------
describe('chanmod plugin — stopnethack split window expiry', () => {
  it('expires the split window and skips deop for +o events after split_timeout', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 1000, enforce_delay_ms: 10 },
        },
      });

      let now = 1_000_000_000;
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

      // Trigger split (3 split-quit messages)
      for (let i = 0; i < 3; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `leaf${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'hub.example.net leaf.example.net',
        });
        await flush();
      }

      // Advance Date.now past split_timeout_ms (1000ms)
      now += 2000;
      dateSpy.mockReturnValue(now);

      freshBot.permissions.addUser('noflag', '*!noflag@noflag.host', 'v', 'test');
      addToChannel(freshBot, 'noflag', 'noflag', 'noflag.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // +o during expired split window — should NOT deop (window expired → splitActive cleared)
      simulateMode(freshBot, 'server.net', '#test', '+o', 'noflag');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('noflag'),
        ),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// channel_modes timer skips when bot has no ops (auto-op.ts line 17)
// ---------------------------------------------------------------------------
describe('chanmod plugin — channel_modes skips when bot has no ops at timer fire', () => {
  it('does NOT set channel modes if bot has no ops when the timer fires', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_channel_modes: 'n', enforce_delay_ms: 5 } },
      });
      // Bot joins the channel but does NOT get +o (no giveBotOps call)
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#newchan',
      });
      freshBot.client.clearMessages();
      await tick(10);
      // Bot had no ops when timer fired — should skip applying modes
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.startsWith('MODE')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Mode enforcement skips when bot can't halfop (mode-enforce.ts line 192)
// ---------------------------------------------------------------------------
describe('chanmod plugin — halfop enforcement skips when bot has no halfop ability', () => {
  it('does NOT re-halfop when bot has no +h or +o in the channel', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      // Bot has NO ops — don't call giveBotOps
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, halfop_flags: ['v'], enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'v', 'test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      // Ensure bot is in channel but NOT opped
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'Badguy', '#test', '-h', 'Alice');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '+h'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Voice enforcement skips when bot has no ops (mode-enforce.ts line 203)
// ---------------------------------------------------------------------------
describe('chanmod plugin — voice enforcement skips when bot has no ops', () => {
  it('does NOT re-voice when bot has no ops when -v fires', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      // Bot has NO ops — don't call giveBotOps
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      freshBot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
      addToChannel(freshBot, 'Bob', 'bob', 'bob.host', '#test');
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'Badguy', '#test', '-v', 'Bob');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '+v'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Revenge skipped when kicker is no longer in the channel (protection.ts line 112)
// ---------------------------------------------------------------------------
describe('chanmod plugin — revenge skipped when kicker left the channel', () => {
  it('does NOT execute revenge when the kicker has left the channel before the timer fires', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      const result = await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_on_kick: true,
            revenge_action: 'deop',
            revenge_delay_ms: 100,
            revenge_exempt_flags: '',
            max_rejoin_attempts: 3,
            rejoin_attempt_window_ms: 300_000,
          },
        },
      });
      expect(result.status).toBe('ok');
      addToChannel(freshBot, 'Kicker', 'kicker', 'kicker.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Bot is kicked
      freshBot.client.simulateEvent('kick', {
        nick: 'Kicker',
        channel: '#test',
        kicked: 'hexbot',
        message: 'bye',
      });
      // Bot rejoins (rejoin_delay_ms = 10ms)
      await tick(10);
      giveBotOps(freshBot, '#test');

      // Kicker parts the channel before the revenge timer fires
      freshBot.client.simulateEvent('part', {
        nick: 'Kicker',
        channel: '#test',
        message: 'leaving',
      });
      freshBot.client.clearMessages();

      // Revenge timer fires (revenge_delay_ms = 100ms) — kicker not in channel → skip
      await tick(100);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stopnethack: non-+o mode and bot-target are ignored (protection.ts lines 230, 241)
// ---------------------------------------------------------------------------
describe('chanmod plugin — stopnethack mode-event guards', () => {
  const triggerSplit = async (freshBot: MockBot) => {
    for (let i = 0; i < 3; i++) {
      freshBot.client.simulateEvent('quit', {
        nick: `leaf${i}`,
        ident: 'u',
        hostname: 'h',
        message: 'hub.example.net leaf.example.net',
      });
      await flush();
    }
  };

  it('ignores non-+o mode events while split is active (line 230)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      await triggerSplit(freshBot);
      freshBot.permissions.addUser('alice', '*!alice@host', 'v', 'test');
      addToChannel(freshBot, 'alice', 'alice', 'host', '#test');
      freshBot.client.clearMessages();

      // Send +v (not +o) while split is active — should be ignored
      simulateMode(freshBot, 'server.net', '#test', '+v', 'alice');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('ignores +o targeting the bot itself while split is active (line 241)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      await triggerSplit(freshBot);
      freshBot.client.clearMessages();

      // Bot itself gets +o while split is active — should not deop itself
      simulateMode(freshBot, 'server.net', '#test', '+o', 'hexbot');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('hexbot'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stopnethack: non-split quit is ignored (protection.ts line 208)
// ---------------------------------------------------------------------------
describe('chanmod plugin — stopnethack ignores non-split quits', () => {
  it('does not count a normal quit towards the split threshold', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      // Fire non-split quits (normal "Quit: leaving" messages)
      for (let i = 0; i < 5; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `user${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'Quit: leaving', // NOT a split quit
        });
        await flush();
      }
      freshBot.permissions.addUser('noflag', '*!noflag@noflag.host', 'v', 'test');
      addToChannel(freshBot, 'noflag', 'noflag', 'noflag.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      // No split active — +o should not trigger deop
      simulateMode(freshBot, 'server.net', '#test', '+o', 'noflag');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ChanServ re-op: automatic when chanserv_access >= op (chanserv_op removed)
// ---------------------------------------------------------------------------
describe('chanmod plugin — ChanServ re-op on deop', () => {
  it('requests OP via ProtectionChain when chanserv_access >= op and bot is deopped', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { chanserv_nick: 'ChanServ', chanserv_op_delay_ms: 10 },
        },
      });
      freshBot.channelSettings.set('#test', 'chanserv_access', 'op');
      await tick(10);
      addToChannel(freshBot, 'ChanServ', 'ChanServ', 'services.', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'SomeOp', '#test', '-o', 'hexbot');
      await tick(50);
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP #test'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT request OP when chanserv_access is none', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { chanserv_nick: 'ChanServ', chanserv_op_delay_ms: 10 },
        },
      });
      // chanserv_access defaults to 'none' — no re-op
      addToChannel(freshBot, 'ChanServ', 'ChanServ', 'services.', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'SomeOp', '#test', '-o', 'hexbot');
      await tick(50);
      // Filter out FLAGS probes — only look for OP commands
      const opMsg = freshBot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.startsWith('OP '),
      );
      expect(opMsg).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Invite handling tests
// ---------------------------------------------------------------------------

describe('chanmod plugin — invite handling', () => {
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
    for (const user of bot.permissions.listUsers()) bot.permissions.removeUser(user.handle);
    bot.client.clearMessages();
  });

  it('should ignore invite when invite setting is off (default)', async () => {
    // No explicit channelSettings set — default is false
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    bot.client.simulateEvent('invite', {
      nick: 'Alice',
      ident: 'alice',
      hostname: 'alice.host',
      channel: '#invited',
    });

    await flush();

    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();
  });

  it('should ignore invite from unprivileged user (not in permissions DB)', async () => {
    bot.channelSettings.set('#invited', 'invite', true);

    bot.client.simulateEvent('invite', {
      nick: 'Stranger',
      ident: 'stranger',
      hostname: 'unknown.host',
      channel: '#invited',
    });

    await flush();

    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();

    bot.channelSettings.set('#invited', 'invite', false);
  });

  it('should accept invite from user with channel op flag', async () => {
    bot.channelSettings.set('#invited', 'invite', true);
    bot.permissions.addUser('alice', '*!alice@alice.host', '', 'test');
    bot.permissions.setChannelFlags('alice', '#invited', 'o');

    bot.client.simulateEvent('invite', {
      nick: 'Alice',
      ident: 'alice',
      hostname: 'alice.host',
      channel: '#invited',
    });

    await flush();

    expect(
      bot.client.messages.find((m) => m.type === 'join' && m.target === '#invited'),
    ).toBeDefined();

    bot.channelSettings.set('#invited', 'invite', false);
  });

  it('should accept invite from user with global master flag', async () => {
    bot.channelSettings.set('#invited', 'invite', true);
    bot.permissions.addUser('master', '*!master@master.host', 'm', 'test');

    bot.client.simulateEvent('invite', {
      nick: 'master',
      ident: 'master',
      hostname: 'master.host',
      channel: '#invited',
    });

    await flush();

    expect(
      bot.client.messages.find((m) => m.type === 'join' && m.target === '#invited'),
    ).toBeDefined();

    bot.channelSettings.set('#invited', 'invite', false);
  });

  it('should reject invite from user with only voice flag (no n/m/o)', async () => {
    bot.channelSettings.set('#invited', 'invite', true);
    // User is in DB but has only 'v' (voice) flag — not n/m/o
    bot.permissions.addUser('voicer', '*!voicer@voicer.host', 'v', 'test');

    bot.client.simulateEvent('invite', {
      nick: 'Voicer',
      ident: 'voicer',
      hostname: 'voicer.host',
      channel: '#invited',
    });

    await flush();

    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();

    bot.channelSettings.set('#invited', 'invite', false);
  });

  it('should skip join if already in the channel', async () => {
    bot.channelSettings.set('#test', 'invite', true);
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');

    // Bot is already in #test (addToChannel simulates a join)
    addToChannel(bot, 'hexbot', 'bot', 'bot.host', '#test');

    bot.client.clearMessages();

    bot.client.simulateEvent('invite', {
      nick: 'Alice',
      ident: 'alice',
      hostname: 'alice.host',
      channel: '#test',
    });

    await flush();

    expect(bot.client.messages.find((m) => m.type === 'join')).toBeUndefined();

    bot.channelSettings.set('#test', 'invite', false);
  });
});

// ---------------------------------------------------------------------------
// Channel key (+k) enforcement (mode-enforce.ts lines 60-78)
// ---------------------------------------------------------------------------

describe('chanmod plugin — channel key enforcement', () => {
  it('re-enforces +k when key is removed (-k)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      freshBot.channelSettings.set('#test', 'channel_key', 'secret');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone removes the key
      simulateMode(freshBot, 'EvilOp', '#test', '-k', '*');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +k secret'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('re-enforces +k when key is changed to wrong value (+k wrong)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      freshBot.channelSettings.set('#test', 'channel_key', 'secret');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone changes key to wrong value
      simulateMode(freshBot, 'EvilOp', '#test', '+k', 'wrongkey');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +k secret'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Channel limit (+l) enforcement (mode-enforce.ts lines 80-99)
// ---------------------------------------------------------------------------

describe('chanmod plugin — channel limit enforcement', () => {
  it('re-enforces +l when limit is removed (-l)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      freshBot.channelSettings.set('#test', 'channel_limit', 50);
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone removes the user limit
      simulateMode(freshBot, 'EvilOp', '#test', '-l', '');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +l 50'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('re-enforces +l when limit is changed to wrong value', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      freshBot.channelSettings.set('#test', 'channel_limit', 50);
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone changes limit to a different value
      simulateMode(freshBot, 'EvilOp', '#test', '+l', '100');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +l 50'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Unauthorized +k removal (no channel_key configured)
// ---------------------------------------------------------------------------

describe('chanmod plugin — unauthorized +k removal (no channel_key configured)', () => {
  it('removes +k when enforce_modes is on and no channel_key is configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'EvilOp', '#test', '+k', 'unauthorized');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -k unauthorized'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove +k when enforce_modes is OFF', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: false, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'EvilOp', '#test', '+k', 'allowed');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -k'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove +k set by the bot itself', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'hexbot', '#test', '+k', 'botkey');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -k'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove +k set by a nodesynch nick', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_delay_ms: 5, nodesynch_nicks: ['ChanServ'] },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'ChanServ', '#test', '+k', 'servicekey');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -k'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Unauthorized +l removal (no channel_limit configured)
// ---------------------------------------------------------------------------

describe('chanmod plugin — unauthorized +l removal (no channel_limit configured)', () => {
  it('removes +l when enforce_modes is on and no channel_limit is configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'EvilOp', '#test', '+l', '10');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -l'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove +l when enforce_modes is OFF', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: false, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'EvilOp', '#test', '+l', '10');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test -l'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Proactive removal of unauthorized modes on join (syncChannelModes via modesReady)
// ---------------------------------------------------------------------------

describe('chanmod plugin — proactive removal of unauthorized modes on join', () => {
  it('removes +k on join when channel has a key but no channel_key is configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_channel_modes: 'nt', enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#keyed');
      freshBot.channelSettings.set('#keyed', 'enforce_modes', true);
      freshBot.client.clearMessages();

      // Server reports channel has +ntk with key "oldkey"
      simulateChannelInfo(freshBot, '#keyed', '+ntk', ['oldkey']);
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #keyed -k oldkey'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('removes +l on join when channel has a limit but no channel_limit is configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_channel_modes: 'nt', enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#limited');
      freshBot.channelSettings.set('#limited', 'enforce_modes', true);
      freshBot.client.clearMessages();

      // Server reports channel has +ntl with limit 50
      simulateChannelInfo(freshBot, '#limited', '+ntl', ['50']);
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #limited -l'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('sets correct key on join when channel has wrong key and channel_key is configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_channel_modes: 'nt', enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#keyed');
      freshBot.channelSettings.set('#keyed', 'channel_key', 'correctkey');
      freshBot.client.clearMessages();

      // Server reports channel has +ntk with wrong key
      simulateChannelInfo(freshBot, '#keyed', '+ntk', ['wrongkey']);
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #keyed +k correctkey'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('skips redundant +k when channel key already matches configured key', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_channel_modes: 'nt', enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#keyed');
      freshBot.channelSettings.set('#keyed', 'channel_key', 'correct');
      freshBot.client.clearMessages();

      // Server reports channel already has the correct key
      simulateChannelInfo(freshBot, '#keyed', '+ntk', ['correct']);
      await tick(20);

      // No +k MODE should be sent since key already matches
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+k')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('skips redundant +l when channel limit already matches configured limit', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_modes: true, enforce_channel_modes: 'nt', enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#limited');
      freshBot.channelSettings.set('#limited', 'channel_limit', 50);
      freshBot.client.clearMessages();

      // Server reports channel already has the correct limit
      simulateChannelInfo(freshBot, '#limited', '+ntl', ['50']);
      await tick(20);

      // No +l MODE should be sent since limit already matches
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+l')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('removes modes in remove set on join', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: '+nt-si',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      // Server reports channel has +ntsi — 's' and 'i' are in the remove set
      simulateChannelInfo(freshBot, '#chan', '+ntsi');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #chan -si'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// enforce_modes:false — skips -v/-h enforcement (mode-enforce.ts line 202)
// ---------------------------------------------------------------------------

describe('chanmod plugin — enforce_modes:false skips -v enforcement', () => {
  it('does NOT re-voice a flagged user when enforce_modes is false', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: false, enforce_delay_ms: 5 } },
      });
      freshBot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
      addToChannel(freshBot, 'Bob', 'bob', 'bob.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'Badguy', '#test', '-v', 'Bob');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '+v'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// punish_deop: nodesynch setter is exempt (mode-enforce.ts line 237)
// ---------------------------------------------------------------------------

describe('chanmod plugin — punish_deop skips when setter is a nodesynch nick', () => {
  it('does NOT kick ChanServ when ChanServ deops a flagged op', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            punish_deop: true,
            punish_action: 'kick',
            nodesynch_nicks: ['ChanServ'],
            op_flags: ['o', 'n', 'm'],
            enforce_delay_ms: 5,
          },
        },
      });

      freshBot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      addToChannel(freshBot, 'ChanServ', 'ChanServ', 'services.', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // ChanServ deops Alice — nodesynch setter should be exempt from punishment
      simulateMode(freshBot, 'ChanServ', '#test', '-o', 'Alice');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) =>
            m.type === 'raw' && m.message?.startsWith('KICK') && m.message.includes('ChanServ'),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// stopnethack mode 2 — no snapshot for channel (protection.ts line 257)
// ---------------------------------------------------------------------------

describe('chanmod plugin — stopnethack mode 2 deops when no ops snapshot exists', () => {
  it('deops +o grant when channel had no ops at split time (snapshot?.has ?? false path)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 2, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });

      // Bot joins channel WITHOUT ops — so snapshotOps finds 0 ops in #test
      // and does NOT add an entry to splitOpsSnapshot
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      addToChannel(freshBot, 'eve', 'eve', 'eve.host', '#test');
      freshBot.client.clearMessages();

      // Trigger split — snapshot taken with no ops → no #test entry
      for (let i = 0; i < 3; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `srv${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'hub.net leaf.net',
        });
        await flush();
      }

      // Give bot ops AFTER snapshot (bot is excluded from deop by isBotNick guard)
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // eve gets +o during split — splitOpsSnapshot has no entry for #test
      // → snapshot = undefined → undefined?.has('eve') = undefined → undefined ?? false = false
      // → isLegitimate=false, botHasOps=true → deop fires
      simulateMode(freshBot, 'server.net', '#test', '+o', 'eve');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('eve'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Immediate mode enforcement on .chanset (syncChannelModes via onChange)
// ---------------------------------------------------------------------------

describe('chanmod plugin — immediate mode enforcement on .chanset', () => {
  it('applies modes immediately when channel_modes is set via channelSettings', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Simulate .chanset #test channel_modes +nti
      freshBot.channelSettings.set('#test', 'channel_modes', '+nti');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +nti'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('applies channel_key immediately when set via channelSettings', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      freshBot.channelSettings.set('#test', 'channel_key', 'secret123');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +k secret123'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('applies channel_limit immediately when set via channelSettings', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      freshBot.channelSettings.set('#test', 'channel_limit', 25);
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +l 25'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT apply modes when bot has no ops', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
      });
      // Bot is in channel but NOT opped
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      freshBot.client.clearMessages();

      freshBot.channelSettings.set('#test', 'channel_modes', '+nti');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.startsWith('MODE')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Unauthorized mode reversal (mode-enforce.ts — removes +X when X not in channel_modes)
// ---------------------------------------------------------------------------

describe('chanmod plugin — unauthorized mode reversal', () => {
  it('removes +i when i is in the remove set (+nt-i)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-i', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // User sets +i which is in the remove set
      simulateMode(freshBot, 'SomeOp', '#test', '+i', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -i'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove +t when channel_modes includes t', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // User sets +t which IS in the configured modes — should not be removed
      simulateMode(freshBot, 'SomeOp', '#test', '+t', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -t'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove modes with parameters (user modes like +o)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      addToChannel(freshBot, 'Alice', 'alice', 'alice.host', '#test');
      freshBot.client.clearMessages();

      // +o has a param (nick) — should NOT be treated as unauthorized channel mode
      simulateMode(freshBot, 'SomeOp', '#test', '+o', 'Alice');
      await tick(20);

      // Should not see a -o for the unauthorized mode check
      // (bitch mode is OFF by default, so no bitch deop either)
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove unauthorized modes when enforce_modes is false', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt', enforce_modes: false, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '+i', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -i'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove unauthorized modes when setter is nodesynch nick', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // ChanServ is in nodesynch_nicks by default
      simulateMode(freshBot, 'ChanServ', '#test', '+i', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -i'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT remove unauthorized modes when channel_modes is empty', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '+i', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -i'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// parseModesSet strips k/l parameter modes (helpers.ts)
// ---------------------------------------------------------------------------

describe('chanmod plugin — parameter modes stripped from channel_modes', () => {
  it('warns when channel_modes contains parameter modes (k/l) via syncChannelModes', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+ntk', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Trigger syncChannelModes via modesReady — channel_modes contains 'k' → warning
      simulateChannelInfo(freshBot, '#test', '+n');
      await tick(20);

      // The warning is logged, and +k is stripped (only +t applied since +n already present)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +t'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does NOT try to set +k without a key when k is in channel_modes string', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+ntk', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Remove +n — should re-enforce +n but NOT +k (k is stripped from the set)
      simulateMode(freshBot, 'EvilOp', '#test', '-n', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +n'),
      ).toBeDefined();
      // k should NOT appear in any re-enforcement
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('+k') && !m.message?.includes('+k '),
        ),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Channel key +k changed to wrong value (mode-enforce.ts line 201 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — +k changed to different value than configured', () => {
  it('re-enforces configured key when someone sets +k with a different key', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_delay_ms: 5,
            enforce_channel_key: 'correctkey',
          },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone sets +k with a different key than the configured one
      simulateMode(freshBot, 'EvilOp', '#test', '+k', 'badkey');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +k correctkey'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does not re-enforce key on unrelated mode change (else-if false branch)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_delay_ms: 5,
            enforce_channel_key: 'mykey',
          },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone sets +m — this enters the channelKey && canEnforce block but
      // modeStr is '+m' which is neither '-k' nor '+k', so the else-if at
      // line 201 evaluates to false (covering the false branch)
      simulateMode(freshBot, 'EvilOp', '#test', '+m', '');
      await tick(20);

      // No +k enforcement should fire (the mode change is unrelated to keys)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+k')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Channel limit +l changed to wrong value (mode-enforce.ts line 231 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — +l changed to different value than configured', () => {
  it('re-enforces configured limit when someone sets +l with a different value', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_delay_ms: 5,
            enforce_channel_limit: 25,
          },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone sets +l with a different limit than the configured one
      simulateMode(freshBot, 'EvilOp', '#test', '+l', '99');
      await tick(20);

      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #test +l 25'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does not re-enforce limit on unrelated mode change (else-if false branch)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_delay_ms: 5,
            enforce_channel_limit: 25,
          },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Someone sets +m — this enters the channelLimit > 0 && canEnforce block but
      // modeStr is '+m' which is neither '-l' nor '+l', so the else-if at
      // line 231 evaluates to false (covering the false branch)
      simulateMode(freshBot, 'EvilOp', '#test', '+m', '');
      await tick(20);

      // No +l enforcement should fire (the mode change is unrelated to limits)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('+l')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle on deop skipped when channel has +i (mode-enforce.ts line 276 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — cycle_on_deop skipped when channel is +i', () => {
  it('does NOT cycle when channel has invite-only mode (+i)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { cycle_on_deop: true, cycle_delay_ms: 10 },
        },
      });
      giveBotOps(freshBot, '#test');

      // Set the channel to invite-only (+i)
      simulateMode(freshBot, 'ChanServ', '#test', '+i', '');
      await tick(5);
      freshBot.client.clearMessages();

      // Three bot self-deops to reach MAX_ENFORCEMENTS (3)
      for (let i = 0; i < 3; i++) {
        simulateMode(freshBot, 'SomeOp', '#test', '-o', 'hexbot');
      }
      // Advance past cycle_delay_ms (10ms) + rejoin delay (2000ms)
      await tick(2200);

      // Bot should NOT have parted or rejoined because the channel is +i
      expect(
        freshBot.client.messages.find((m) => m.type === 'part' && m.target === '#test'),
      ).toBeUndefined();
      expect(
        freshBot.client.messages.find((m) => m.type === 'join' && m.target === '#test'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// isSplitQuit returns false for non-2-word input (protection.ts line 22 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — isSplitQuit rejects non-2-word quit messages', () => {
  it('does not count a single-word quit towards the split threshold', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      // Fire quits with a single word (1 part, not 2) — isSplitQuit returns false at line 22
      for (let i = 0; i < 5; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `user${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'Disconnected',
        });
        await flush();
      }
      freshBot.permissions.addUser('noflag', '*!noflag@noflag.host', 'v', 'test');
      addToChannel(freshBot, 'noflag', 'noflag', 'noflag.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      // No split active — +o should not trigger deop
      simulateMode(freshBot, 'server.net', '#test', '+o', 'noflag');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does not count a three-word quit towards the split threshold', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });
      // Fire quits with three words — isSplitQuit returns false at line 22
      for (let i = 0; i < 5; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `user${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'hub.net leaf.net extra.net',
        });
        await flush();
      }
      freshBot.permissions.addUser('noflag2', '*!noflag2@noflag2.host', 'v', 'test');
      addToChannel(freshBot, 'noflag2', 'noflag2', 'noflag2.host', '#test');
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();
      simulateMode(freshBot, 'server.net', '#test', '+o', 'noflag2');
      await tick(20);
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// snapshotOps when getChannel returns undefined (protection.ts line 32 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — snapshotOps handles missing channel gracefully', () => {
  it('skips channels where getChannel returns undefined during split snapshot', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      // Load plugin with stopnethack — bot does NOT join #test, so getChannel('#test') = undefined
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { stopnethack_mode: 1, split_timeout_ms: 60000, enforce_delay_ms: 10 },
        },
      });

      // Trigger split — snapshotOps iterates channels (['#test']) but getChannel returns
      // undefined because the bot hasn't joined → hits the `if (!ch) continue` branch
      for (let i = 0; i < 3; i++) {
        freshBot.client.simulateEvent('quit', {
          nick: `srv${i}`,
          ident: 'u',
          hostname: 'h',
          message: 'hub.net leaf.net',
        });
        await flush();
      }

      // Give bot ops AFTER the split snapshot
      giveBotOps(freshBot, '#test');
      freshBot.permissions.addUser('stranger', '*!stranger@stranger.host', 'v', 'test');
      addToChannel(freshBot, 'stranger', 'stranger', 'stranger.host', '#test');
      freshBot.client.clearMessages();

      // +o during split — no snapshot for #test → isLegitimate=false → deops
      simulateMode(freshBot, 'server.net', '#test', '+o', 'stranger');
      await tick(20);
      // Verify the split was still detected and acted upon (deop fires)
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('stranger'),
        ),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// parseKicker when neither regex matches (protection.ts line 51 branch)
// ---------------------------------------------------------------------------
describe('chanmod plugin — parseKicker with non-matching kick reason', () => {
  it('does not crash or revenge when kicker nick is empty (parseKicker returns empty)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            rejoin_on_kick: true,
            rejoin_delay_ms: 10,
            revenge_action: 'deop',
            revenge_delay_ms: 10,
          },
        },
      });
      freshBot.channelSettings.set('#test', 'revenge', true);
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      // Simulate bot being kicked with an empty kicker nick.
      // IRC bridge formats reason as "message (by )" when nick is empty — the regex
      // \(by ([^)]+)\)$ requires 1+ chars inside parens, so it fails. The fallback
      // regex ^by (.+)$ also fails. parseKicker returns '' (line 51 branch).
      freshBot.client.simulateEvent('kick', {
        nick: '',
        ident: '',
        hostname: '',
        channel: '#test',
        kicked: 'hexbot',
        message: 'some reason',
      });
      await tick(3500);

      // Bot should rejoin but NOT revenge (kickerNick is empty string)
      expect(
        freshBot.client.messages.find((m) => m.type === 'join' && m.target === '#test'),
      ).toBeDefined();
      // No deop should have been sent (no kicker to revenge against)
      expect(
        freshBot.client.messages.find((m) => m.type === 'mode' && m.message === '-o'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

describe('parseChannelModes()', () => {
  it('parses "+nt-s" into add: {n, t}, remove: {s}', () => {
    const result = parseChannelModes('+nt-s');
    expect(result.add).toEqual(new Set(['n', 't']));
    expect(result.remove).toEqual(new Set(['s']));
  });

  it('rejects unprefixed "nt" — returns empty sets', () => {
    const result = parseChannelModes('nt');
    expect(result.add).toEqual(new Set());
    expect(result.remove).toEqual(new Set());
  });

  it('parses "+nt" (explicit additive only)', () => {
    const result = parseChannelModes('+nt');
    expect(result.add).toEqual(new Set(['n', 't']));
    expect(result.remove).toEqual(new Set());
  });

  it('parses "-si" (remove only)', () => {
    const result = parseChannelModes('-si');
    expect(result.add).toEqual(new Set());
    expect(result.remove).toEqual(new Set(['s', 'i']));
  });

  it('parses "+nt-si+m" (mixed)', () => {
    const result = parseChannelModes('+nt-si+m');
    expect(result.add).toEqual(new Set(['n', 't', 'm']));
    expect(result.remove).toEqual(new Set(['s', 'i']));
  });

  it('handles conflict: "+n-n" — last wins (remove)', () => {
    const result = parseChannelModes('+n-n');
    expect(result.add).toEqual(new Set());
    expect(result.remove).toEqual(new Set(['n']));
  });

  it('handles conflict: "-n+n" — last wins (add)', () => {
    const result = parseChannelModes('-n+n');
    expect(result.add).toEqual(new Set(['n']));
    expect(result.remove).toEqual(new Set());
  });

  it('returns empty sets for empty string', () => {
    const result = parseChannelModes('');
    expect(result.add).toEqual(new Set());
    expect(result.remove).toEqual(new Set());
  });

  it('strips param modes from add set', () => {
    const result = parseChannelModes('+ntk');
    expect(result.add).toEqual(new Set(['n', 't']));
    expect(result.remove).toEqual(new Set());
  });

  it('strips param modes from remove set', () => {
    const result = parseChannelModes('-kl');
    expect(result.add).toEqual(new Set());
    expect(result.remove).toEqual(new Set());
  });

  it('uses custom paramModes set when provided', () => {
    const customParam = new Set(['b', 'e', 'I', 'k', 'l']);
    const result = parseChannelModes('+ntb-eI', customParam);
    expect(result.add).toEqual(new Set(['n', 't']));
    expect(result.remove).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// getParamModes() — dynamic ISUPPORT CHANMODES parsing
// ---------------------------------------------------------------------------

describe('getParamModes()', () => {
  it('parses CHANMODES ISUPPORT into param mode set', () => {
    const mockApi = createMockPluginAPI({
      getServerSupports: () => ({ CHANMODES: 'beI,k,l,imnpst' }),
    });
    const result = getParamModes(mockApi);
    expect(result.has('b')).toBe(true);
    expect(result.has('e')).toBe(true);
    expect(result.has('I')).toBe(true);
    expect(result.has('k')).toBe(true);
    expect(result.has('l')).toBe(true);
    // Category D (no-param) should NOT be included
    expect(result.has('i')).toBe(false);
    expect(result.has('n')).toBe(false);
  });

  it('handles short CHANMODES with missing categories', () => {
    const mockApi = createMockPluginAPI({
      getServerSupports: () => ({ CHANMODES: 'beI,k' }),
    });
    const result = getParamModes(mockApi);
    expect(result.has('b')).toBe(true);
    expect(result.has('e')).toBe(true);
    expect(result.has('I')).toBe(true);
    expect(result.has('k')).toBe(true);
    // Categories C and D missing — no crash
    expect(result.size).toBe(4);
  });

  it('falls back to PARAM_MODES when CHANMODES is unavailable', () => {
    const mockApi = createMockPluginAPI({
      getServerSupports: () => ({}),
    });
    const result = getParamModes(mockApi);
    expect(result).toBe(PARAM_MODES);
    expect(result.has('k')).toBe(true);
    expect(result.has('l')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additive/subtractive sync behavior tests
// ---------------------------------------------------------------------------

describe('chanmod plugin — additive/subtractive sync on join', () => {
  it('leaves unmentioned modes alone (channel has +ntsz, config "+nt-s")', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: '+nt-s',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      // Channel has +ntsz — should remove -s, leave z alone
      simulateChannelInfo(freshBot, '#chan', '+ntsz');
      await tick(20);

      // -s should be sent
      expect(
        freshBot.client.messages.find(
          (m) => m.type === 'raw' && m.message?.includes('MODE #chan -s'),
        ),
      ).toBeDefined();
      // -z should NOT be sent (not in remove set)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('-z')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('sends nothing when no modes to add or remove (+nt already set, -s not present)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: '+nt-s',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      simulateChannelInfo(freshBot, '#chan', '+nt');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('MODE #chan')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('adds missing mode from add set (+n present, +t missing)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: '+nt-s',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      simulateChannelInfo(freshBot, '#chan', '+n');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #chan +t'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('unprefixed channel_modes value is rejected — no enforcement runs', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: 'nt',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      // "nt" has no leading +/- — parser rejects it, so nothing is added or removed
      simulateChannelInfo(freshBot, '#chan', '+s');
      await tick(20);

      const modeMessages = freshBot.client.messages.filter(
        (m) => m.type === 'raw' && typeof m.message === 'string' && m.message.startsWith('MODE'),
      );
      expect(modeMessages).toEqual([]);
    } finally {
      freshBot.cleanup();
    }
  });

  it('additive-only config "+nt" leaves extra modes alone', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            enforce_modes: true,
            enforce_channel_modes: '+nt',
            enforce_delay_ms: 5,
          },
        },
      });
      giveBotOps(freshBot, '#chan');
      freshBot.channelSettings.set('#chan', 'enforce_modes', true);
      freshBot.client.clearMessages();

      simulateChannelInfo(freshBot, '#chan', '+nts');
      await tick(20);

      // s should NOT be removed (not in remove set)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.includes('-s')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Additive/subtractive reactive handler tests
// ---------------------------------------------------------------------------

describe('chanmod plugin — additive/subtractive reactive enforcement', () => {
  it('removes +s when s is in the remove set (+nt-s)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-s', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '+s', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -s'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('ignores +i when i is not mentioned in config (+nt-s)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-s', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '+i', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test -i'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('re-applies +t when removed (t is in add set)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-s', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '-t', '');
      await tick(20);

      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +t'),
      ).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does nothing when -s is removed (s is in remove set — removal is desired)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-s', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '-s', '');
      await tick(20);

      // Should NOT re-apply +s (s is in remove set, its removal is desired)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +s'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('does nothing when -i is removed (i is not mentioned)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt-s', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      giveBotOps(freshBot, '#test');
      freshBot.client.clearMessages();

      simulateMode(freshBot, 'SomeOp', '#test', '-i', '');
      await tick(20);

      // Should NOT re-apply +i (i is not mentioned at all)
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message === 'MODE #test +i'),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Bot join — chanserv_access sync (auto-op.ts lines 25-28)
// ---------------------------------------------------------------------------
describe('chanmod plugin — bot join chanserv_access sync', () => {
  it('skips mode enforcement when channel is parted before timer fires (race guard)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#race');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: { enforce_channel_modes: '+nt', enforce_modes: true, enforce_delay_ms: 5 },
        },
      });
      freshBot.channelSettings.set('#race', 'channel_modes', '+nti');

      // Remove the channel from state before the enforcement timer fires
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (freshBot.channelState as any).channels.delete('#race');

      freshBot.client.clearMessages();
      await tick(20);

      // No mode changes should have been sent — early return from null channel
      expect(
        freshBot.client.messages.find((m) => m.type === 'raw' && m.message?.startsWith('MODE')),
      ).toBeUndefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('sets backend access and verifies when bot joins a channel with chanserv_access configured', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            chanserv_services_type: 'atheme',
            chanserv_nick: 'ChanServ',
          },
        },
      });

      // Pre-configure chanserv_access for the channel BEFORE bot joins
      freshBot.channelSettings.set('#opchan', 'chanserv_access', 'op');
      freshBot.client.clearMessages();

      // Bot joins the channel — this should trigger access sync
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#opchan',
      });
      await tick(10);

      // The bot should have sent a FLAGS probe to verify access
      const flagsMsg = freshBot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('FLAGS #opchan'),
      );
      expect(flagsMsg).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });

  it('always sends FLAGS probe on join even when chanserv_access is none (auto-detect)', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            chanserv_services_type: 'atheme',
            chanserv_nick: 'ChanServ',
          },
        },
      });

      freshBot.channelSettings.set('#nochan', 'chanserv_access', 'none');
      freshBot.client.clearMessages();

      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#nochan',
      });
      await tick(10);

      // FLAGS probe is sent even when access is 'none' — auto-detect needs it
      const flagsMsg = freshBot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('FLAGS'),
      );
      expect(flagsMsg).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Config — chanserv_services_type selects Anope backend (state.ts line 185-188)
// ---------------------------------------------------------------------------
describe('chanmod plugin — chanserv_services_type selects Anope backend', () => {
  it('uses Anope backend (ACCESS LIST) when chanserv_services_type is set to anope', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            chanserv_services_type: 'anope',
          },
        },
      });

      // Set chanserv_access so verifyAccess fires on join
      freshBot.channelSettings.set('#anopechan', 'chanserv_access', 'op');
      freshBot.client.clearMessages();

      // Bot joins the channel — should trigger access sync via Anope backend
      freshBot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#anopechan',
      });
      await tick(10);

      // Anope backend sends ACCESS LIST (not FLAGS like Atheme)
      const accessMsg = freshBot.client.messages.find(
        (m) =>
          m.type === 'say' &&
          m.target === 'ChanServ' &&
          m.message?.includes('ACCESS #anopechan LIST'),
      );
      expect(accessMsg).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Immediate unban when bot is banned (mode-enforce.ts handleBotBannedThreat)
// ---------------------------------------------------------------------------
describe('chanmod plugin — immediate unban on bot ban', () => {
  it('requests ChanServ UNBAN when +b matching bot hostmask is set', async () => {
    const freshBot = createMockBot({ botNick: 'hexbot' });
    try {
      giveBotOps(freshBot, '#test');
      addToChannel(freshBot, 'Attacker', 'attacker', 'attacker.host', '#test');
      await freshBot.pluginLoader.load(PLUGIN_PATH, {
        chanmod: {
          enabled: true,
          config: {
            chanserv_services_type: 'anope',
            takeover_detection: true,
          },
        },
      });
      freshBot.channelSettings.set('#test', 'chanserv_access', 'op');
      freshBot.channelSettings.set('#test', 'takeover_detection', true);
      freshBot.client.clearMessages();

      // Attacker bans the bot
      simulateMode(freshBot, 'Attacker', '#test', '+b', '*!*bot@bot.host');
      await tick(50);

      // Bot should immediately request UNBAN via ChanServ
      const unbanMsg = freshBot.client.messages.find(
        (m) => m.type === 'say' && m.target === 'ChanServ' && m.message?.includes('UNBAN #test'),
      );
      expect(unbanMsg).toBeDefined();
    } finally {
      freshBot.cleanup();
    }
  });
});
