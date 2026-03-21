import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { createMockBot, type MockBot } from '../helpers/mock-bot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_PATH = resolve('./plugins/chanop/index.ts');

function simulateJoin(bot: MockBot, nick: string, ident: string, hostname: string, channel: string): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

function simulatePrivmsg(bot: MockBot, nick: string, ident: string, hostname: string, channel: string, message: string): void {
  bot.client.simulateEvent('privmsg', { nick, ident, hostname, target: channel, message });
}

function simulateMode(bot: MockBot, setter: string, channel: string, mode: string, param: string): void {
  bot.client.simulateEvent('mode', {
    nick: setter,
    ident: 'ident',
    hostname: 'host',
    target: channel,
    modes: [{ mode, param }],
  });
}

/** Wait for async handlers to fire. */
async function tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** Add a user to channel-state so getUserHostmask works. */
function addToChannel(bot: MockBot, nick: string, ident: string, hostname: string, channel: string): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

// ---------------------------------------------------------------------------
// Auto-op tests
// ---------------------------------------------------------------------------

describe('chanop plugin — auto-op', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
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

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should voice a user with +v flag on join', async () => {
    bot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');

    simulateJoin(bot, 'Bob', 'bob', 'bob.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should op a user with +n flag (owner implies op)', async () => {
    bot.permissions.addUser('owner', '*!owner@owner.host', 'n', 'test');

    simulateJoin(bot, 'Owner', 'owner', 'owner.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Owner')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should do nothing for unknown user', async () => {
    simulateJoin(bot, 'Stranger', 'stranger', 'unknown.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should not op user with flags for different channel only', async () => {
    bot.permissions.addUser('channeluser', '*!cu@cu.host', '', 'test');
    bot.permissions.setChannelFlags('channeluser', '#other', 'o', 'test');

    simulateJoin(bot, 'ChannelUser', 'cu', 'cu.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should op user with channel-specific +o flag', async () => {
    bot.permissions.addUser('chanop', '*!cop@cop.host', '', 'test');
    bot.permissions.setChannelFlags('chanop', '#test', 'o', 'test');

    simulateJoin(bot, 'ChanOp', 'cop', 'cop.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('ChanOp')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should not op/voice the bot itself', async () => {
    bot.permissions.addUser('botuser', '*!n0xb0t@bot.host', 'o', 'test');

    simulateJoin(bot, 'n0xb0t', 'n0xb0t', 'bot.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });

  it('should not auto-op when auto_op is disabled', async () => {
    bot.cleanup();

    bot = createMockBot({ botNick: 'n0xb0t' });
    // Load with auto_op disabled via plugins config override
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanop: { enabled: true, config: { auto_op: false } },
    });
    expect(result.status).toBe('ok');

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    simulateJoin(bot, 'Alice', 'alice', 'alice.host', '#test');
    await tick();

    const modeMsg = bot.client.messages.find((m) => m.type === 'mode');
    expect(modeMsg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mode enforcement tests
// ---------------------------------------------------------------------------

describe('chanop plugin — mode enforcement', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanop: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5 } },
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

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should re-voice a user with +v flags when devoiced externally', async () => {
    bot.permissions.addUser('bob', '*!bob@bob.host', 'v', 'test');
    addToChannel(bot, 'Bob', 'bob', 'bob.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-v', 'Bob');
    await tick(50);

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should NOT re-op when the bot itself set -o', async () => {
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'n0xb0t', '#test', '-o', 'Alice');
    await tick(50);

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeUndefined();
  });

  it('should NOT re-op after an intentional !deop command', async () => {
    bot.permissions.addUser('admin', '*!admin@admin.host', 'no', 'test');
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');

    // Admin issues !deop Alice
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop Alice');
    await tick();
    bot.client.clearMessages();

    // Simulate the resulting mode change (from someone other than the bot for this test,
    // but the intentional marker should still prevent re-enforcement)
    simulateMode(bot, 'SomeOp', '#test', '-o', 'Alice');
    await tick(50);

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeUndefined();
  });

  it('should NOT enforce when enforce_modes is disabled', async () => {
    bot.cleanup();

    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanop: { enabled: true, config: { enforce_modes: false } },
    });
    expect(result.status).toBe('ok');

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    await tick(50);

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeUndefined();
  });

  it('should suppress enforcement after repeated deops (rate limit)', async () => {
    // Use a fresh bot with auto_op disabled to avoid interference
    bot.cleanup();
    bot = createMockBot({ botNick: 'n0xb0t' });
    const res = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanop: { enabled: true, config: { enforce_modes: true, enforce_delay_ms: 5, auto_op: false } },
    });
    expect(res.status).toBe('ok');

    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    bot.client.clearMessages();

    // Trigger 5 deops rapidly — only the first 3 should be re-enforced
    for (let i = 0; i < 5; i++) {
      simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    }
    await tick(50);

    const reOps = bot.client.messages.filter(
      (m) => m.message === '+o' && m.args?.includes('Alice')
    );
    expect(reOps).toHaveLength(3);
  });

  it('should NOT enforce for user without flags', async () => {
    addToChannel(bot, 'Rando', 'rando', 'rando.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'SomeOp', '#test', '-o', 'Rando');
    await tick(50);

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Rando')
    );
    expect(modeMsg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !op, !deop, !voice, !devoice
// ---------------------------------------------------------------------------

describe('chanop plugin — mode commands', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');

    // Add an opped user for command tests
    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterEach(() => {
    bot.cleanup();
  });

  it('!op nick — should op the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op Alice');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeDefined();
  });

  it('!op with no args — should op the caller', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Admin')
    );
    expect(modeMsg).toBeDefined();
  });

  it('!op from unauthorized user — should not send mode', async () => {
    simulatePrivmsg(bot, 'Nobody', 'nobody', 'nobody.host', '#test', '!op Alice');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o'
    );
    expect(modeMsg).toBeUndefined();
  });

  it('!deop nick — should deop the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop Alice');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Alice')
    );
    expect(modeMsg).toBeDefined();
  });

  it('!deop bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!deop n0xb0t');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '-o'
    );
    expect(modeMsg).toBeUndefined();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('cannot deop myself')
    );
    expect(reply).toBeDefined();
  });

  it('!voice nick — should voice the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!voice Bob');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+v' && m.args?.includes('Bob')
    );
    expect(modeMsg).toBeDefined();
  });

  it('!devoice nick — should devoice the target', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!devoice Bob');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '-v' && m.args?.includes('Bob')
    );
    expect(modeMsg).toBeDefined();
  });

  it('should sanitize nick with newline injection (bridge strips \\r\\n)', async () => {
    // The IRC bridge sanitizes \r\n before it reaches the plugin,
    // so "bad\r\nnick" becomes "badnick" — the mode is sent with the clean nick
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!op bad\r\nnick');
    await tick();

    const modeMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('badnick')
    );
    expect(modeMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !kick
// ---------------------------------------------------------------------------

describe('chanop plugin — kick command', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');

    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterEach(() => {
    bot.cleanup();
  });

  it('!kick nick reason — should kick with reason', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick BadUser spamming the channel');
    await tick();

    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser')
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('spamming the channel');
  });

  it('!kick nick — should kick with default reason', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick BadUser');
    await tick();

    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser')
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('Requested');
  });

  it('!kick with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Usage')
    );
    expect(reply).toBeDefined();
  });

  it('!kick bot — should refuse', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kick n0xb0t');
    await tick();

    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('KICK')
    );
    expect(kickMsg).toBeUndefined();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('cannot kick myself')
    );
    expect(reply).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Command tests: !ban, !unban, !kickban
// ---------------------------------------------------------------------------

describe('chanop plugin — ban commands', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'n0xb0t' });
    const result = await bot.pluginLoader.load(PLUGIN_PATH);
    expect(result.status).toBe('ok');

    bot.permissions.addUser('admin', '*!admin@admin.host', 'o', 'test');
  });

  afterEach(() => {
    bot.cleanup();
  });

  it('!ban nick — should ban with *!*@host mask', async () => {
    // Add target to channel so hostmask is known
    addToChannel(bot, 'BadUser', 'bad', 'evil.host.com', '#test');
    bot.client.clearMessages();

    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban BadUser');
    await tick();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@evil.host.com')
    );
    expect(banMsg).toBeDefined();
  });

  it('!ban nick — should error when hostmask unknown', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban GhostUser');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Cannot resolve hostmask')
    );
    expect(reply).toBeDefined();
  });

  it('!ban explicit mask — should ban with that mask directly', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban *!*@bad.host.net');
    await tick();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@bad.host.net')
    );
    expect(banMsg).toBeDefined();
  });

  it('!ban bot — should refuse', async () => {
    addToChannel(bot, 'n0xb0t', 'n0xb0t', 'bot.host', '#test');
    bot.client.clearMessages();

    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!ban n0xb0t');
    await tick();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b'
    );
    expect(banMsg).toBeUndefined();
  });

  it('!unban mask — should remove ban', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban *!*@bad.host.net');
    await tick();

    const rawMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.includes('MODE #test -b *!*@bad.host.net')
    );
    expect(rawMsg).toBeDefined();
  });

  it('!unban with no args — should show usage', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!unban');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Usage')
    );
    expect(reply).toBeDefined();
  });

  it('!kickban nick reason — should ban then kick', async () => {
    addToChannel(bot, 'BadUser', 'bad', 'evil.host.com', '#test');
    bot.client.clearMessages();

    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban BadUser being terrible');
    await tick();

    const banMsg = bot.client.messages.find(
      (m) => m.type === 'mode' && m.message === '+b' && m.args?.includes('*!*@evil.host.com')
    );
    expect(banMsg).toBeDefined();

    const kickMsg = bot.client.messages.find(
      (m) => m.type === 'raw' && m.message?.startsWith('KICK #test BadUser')
    );
    expect(kickMsg).toBeDefined();
    expect(kickMsg!.message).toContain('being terrible');
  });

  it('!kickban with unknown hostmask — should error', async () => {
    simulatePrivmsg(bot, 'Admin', 'admin', 'admin.host', '#test', '!kickban GhostUser');
    await tick();

    const reply = bot.client.messages.find(
      (m) => m.type === 'say' && m.message?.includes('Cannot resolve hostmask')
    );
    expect(reply).toBeDefined();
  });
});
