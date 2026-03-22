import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type MockBot, createMockBot } from '../helpers/mock-bot.js';

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

/** Wait for real timers (enforcement delays, async handlers). */
async function tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
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

/** Simulate the bot joining a channel with ops (via userlist). */
function giveBotOps(bot: MockBot, channel: string): void {
  const nick = (bot.client.user as { nick: string }).nick;
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

// ---------------------------------------------------------------------------
// Auto-op tests
// ---------------------------------------------------------------------------

describe('chanmod plugin — auto-op', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');
  });

  afterEach(() => {
    bot.cleanup();
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
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { auto_op: false } },
    });
    expect(result.status).toBe('ok');

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    simulateJoin(bot, 'Alice', 'alice', 'alice.host', '#test');
    await tick();
    expect(bot.client.messages.find((m) => m.type === 'mode')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mode enforcement tests (need per-test setup due to mutable enforcement state)
// ---------------------------------------------------------------------------

describe('chanmod plugin — mode enforcement', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
    });
    expect(result.status).toBe('ok');
  });

  afterEach(() => {
    bot.cleanup();
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
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: { enabled: true, config: { enforce_modes: false } },
    });

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    await tick(50);

    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeUndefined();
  });

  it('should suppress enforcement after repeated deops (rate limit)', async () => {
    bot.cleanup();
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { enforce_modes: true, enforce_delay_ms: 5, auto_op: false },
      },
    });

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    for (let i = 0; i < 5; i++) {
      simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    }
    await tick(50);

    const reOps = bot.client.messages.filter(
      (m) => m.message === '+o' && m.args?.includes('Alice'),
    );
    expect(reOps).toHaveLength(3);
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
        channel: null as unknown as string,
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
    const entry = bot.db.get('chanmod', 'ban:#test:*!*@timed.host');
    expect(entry).toBeDefined();
    const record = JSON.parse(entry!) as { mask: string; expires: number };
    expect(record.mask).toBe('*!*@timed.host');
    expect(record.expires).toBeGreaterThan(Date.now());
  });

  it('!ban with 0 duration stores permanent record (expires=0)', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban *!*@perm.host 0');
    await flush();
    const entry = bot.db.get('chanmod', 'ban:#test:*!*@perm.host');
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
    const entry = bot.db.get('chanmod', 'ban:#test:*!*@timed.host');
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Channel mode enforcement
// ---------------------------------------------------------------------------

describe('chanmod plugin — channel mode enforcement', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: { enforce_channel_modes: '+nt', enforce_delay_ms: 5 },
      },
    });
  });

  afterEach(() => {
    bot.cleanup();
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
