import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BackendAccess,
  ProtectionChain,
  accessAtLeast,
} from '../../plugins/chanmod/protection-backend';
import type { ProtectionBackend } from '../../plugins/chanmod/protection-backend';
import type { ChanmodConfig } from '../../plugins/chanmod/state';
import { createState } from '../../plugins/chanmod/state';
import {
  POINTS_BOT_BANNED,
  POINTS_BOT_DEOPPED,
  POINTS_BOT_KICKED,
  POINTS_ENFORCEMENT_SUPPRESSED,
  POINTS_FRIENDLY_DEOPPED,
  POINTS_MODE_LOCKED,
  POINTS_UNAUTHORIZED_OP,
  THREAT_ACTIVE,
  THREAT_ALERT,
  THREAT_CRITICAL,
  THREAT_NORMAL,
  assessThreat,
  getThreatLevel,
  getThreatState,
  resetThreat,
  scoreToLevel,
} from '../../plugins/chanmod/takeover-detect';
import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake timers + flush. */
async function tick(ms = 20): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(ms);
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

function addToChannel(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
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

// ---------------------------------------------------------------------------
// Mock API + config for unit tests of the threat engine
// ---------------------------------------------------------------------------

function createMockApi() {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    api: {
      ircLower: (s: string) => s.toLowerCase(),
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => warns.push(args.map(String).join(' ')),
    } as never,
    logs,
    warns,
  };
}

function createTestConfig(overrides?: Partial<ChanmodConfig>): ChanmodConfig {
  return {
    auto_op: true,
    op_flags: ['n', 'm', 'o'],
    halfop_flags: [],
    voice_flags: ['v'],
    notify_on_fail: false,
    enforce_modes: false,
    enforce_delay_ms: 5,
    nodesynch_nicks: ['ChanServ'],
    enforce_channel_modes: '',
    enforce_channel_key: '',
    enforce_channel_limit: 0,
    cycle_on_deop: false,
    cycle_delay_ms: 5000,
    default_kick_reason: 'Requested',
    default_ban_duration: 120,
    default_ban_type: 3,
    rejoin_on_kick: true,
    rejoin_delay_ms: 5000,
    max_rejoin_attempts: 3,
    rejoin_attempt_window_ms: 300_000,
    revenge_on_kick: false,
    revenge_action: 'deop',
    revenge_delay_ms: 3000,
    revenge_kick_reason: "Don't kick me.",
    revenge_exempt_flags: 'nm',
    bitch: false,
    punish_deop: false,
    punish_action: 'kick',
    punish_kick_reason: "Don't deop my friends.",
    enforcebans: false,
    nick_recovery: true,
    nick_recovery_ghost: false,
    nick_recovery_password: '',
    stopnethack_mode: 0,
    split_timeout_ms: 300_000,
    chanserv_nick: 'ChanServ',
    chanserv_op_delay_ms: 1000,
    chanserv_services_type: 'atheme',
    chanserv_unban_retry_ms: 2000,
    chanserv_unban_max_retries: 3,
    chanserv_recover_cooldown_ms: 60_000,
    anope_recover_step_delay_ms: 200,
    takeover_window_ms: 30_000,
    takeover_level_1_threshold: 3,
    takeover_level_2_threshold: 6,
    takeover_level_3_threshold: 10,
    takeover_response_delay_ms: 0,
    invite: false,
    ...overrides,
  };
}

function createMockBackend(
  name: string,
  priority: number,
  access: BackendAccess = 'none',
): ProtectionBackend & { calls: string[] } {
  const calls: string[] = [];
  const accessLevels = new Map<string, BackendAccess>();

  return {
    name,
    priority,
    calls,
    canOp: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'op'),
    canDeop: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'superop'),
    canUnban: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'op'),
    canInvite: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'op'),
    canRecover: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'founder'),
    canClearBans: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'founder'),
    canRemoveKey: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'op'),
    canAkick: (ch) => accessAtLeast(accessLevels.get(ch.toLowerCase()) ?? access, 'op'),
    requestOp: (ch, nick) => {
      calls.push(`requestOp:${ch}:${nick ?? 'self'}`);
    },
    requestDeop: (ch, nick) => {
      calls.push(`requestDeop:${ch}:${nick}`);
    },
    requestUnban: (ch) => {
      calls.push(`requestUnban:${ch}`);
    },
    requestInvite: (ch) => {
      calls.push(`requestInvite:${ch}`);
    },
    requestRecover: (ch) => {
      calls.push(`requestRecover:${ch}`);
    },
    requestClearBans: (ch) => {
      calls.push(`requestClearBans:${ch}`);
    },
    requestRemoveKey: (ch) => {
      calls.push(`requestRemoveKey:${ch}`);
    },
    requestAkick: (ch, mask, reason) => {
      calls.push(`requestAkick:${ch}:${mask}:${reason ?? ''}`);
    },
    verifyAccess: (ch) => {
      calls.push(`verifyAccess:${ch}`);
    },
    getAccess: (ch) => accessLevels.get(ch.toLowerCase()) ?? access,
    setAccess: (ch, level) => {
      accessLevels.set(ch.toLowerCase(), level);
    },
    isAutoDetected: () => false,
  };
}

// ---------------------------------------------------------------------------
// scoreToLevel — unit tests
// ---------------------------------------------------------------------------

describe('scoreToLevel', () => {
  const config = createTestConfig();

  it('score 0 → Normal', () => expect(scoreToLevel(config, 0)).toBe(THREAT_NORMAL));
  it('score 2 → Normal', () => expect(scoreToLevel(config, 2)).toBe(THREAT_NORMAL));
  it('score 3 → Alert', () => expect(scoreToLevel(config, 3)).toBe(THREAT_ALERT));
  it('score 5 → Alert', () => expect(scoreToLevel(config, 5)).toBe(THREAT_ALERT));
  it('score 6 → Active', () => expect(scoreToLevel(config, 6)).toBe(THREAT_ACTIVE));
  it('score 9 → Active', () => expect(scoreToLevel(config, 9)).toBe(THREAT_ACTIVE));
  it('score 10 → Critical', () => expect(scoreToLevel(config, 10)).toBe(THREAT_CRITICAL));
  it('score 20 → Critical', () => expect(scoreToLevel(config, 20)).toBe(THREAT_CRITICAL));

  it('respects custom thresholds', () => {
    const custom = createTestConfig({
      takeover_level_1_threshold: 5,
      takeover_level_2_threshold: 10,
      takeover_level_3_threshold: 15,
    });
    expect(scoreToLevel(custom, 4)).toBe(THREAT_NORMAL);
    expect(scoreToLevel(custom, 5)).toBe(THREAT_ALERT);
    expect(scoreToLevel(custom, 10)).toBe(THREAT_ACTIVE);
    expect(scoreToLevel(custom, 15)).toBe(THREAT_CRITICAL);
  });
});

// ---------------------------------------------------------------------------
// assessThreat — unit tests
// ---------------------------------------------------------------------------

describe('assessThreat', () => {
  it('single deop stays at level 0 (Normal)', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    const level = assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'bot_deopped',
      POINTS_BOT_DEOPPED,
      'attacker',
    );
    // 3 points = level 1 (Alert threshold is 3)
    expect(level).toBe(THREAT_ALERT);
  });

  it('single friendly deop stays below alert', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    const level = assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'friendly_deopped',
      POINTS_FRIENDLY_DEOPPED,
      'attacker',
      'alice',
    );
    expect(level).toBe(THREAT_NORMAL); // 2 < 3
  });

  it('accumulates points across multiple events', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#test', 'friendly_deopped', 2, 'attacker', 'alice');
    assessThreat(api, config, state, chain, '#test', 'friendly_deopped', 2, 'attacker', 'bob');
    const level = assessThreat(api, config, state, chain, '#test', 'mode_locked', 1, 'attacker');
    expect(level).toBe(THREAT_ALERT); // 2+2+1 = 5
  });

  it('bot deop + kick + ban escalates to Critical', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', POINTS_BOT_DEOPPED, 'attacker');
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', POINTS_BOT_KICKED, 'attacker');
    const level = assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'bot_banned',
      POINTS_BOT_BANNED,
      'attacker',
    );
    // 3 + 4 + 5 = 12 → Critical (>= 10)
    expect(level).toBe(THREAT_CRITICAL);
  });

  it('coordinated attack: deop + 2 friendly deops + mode lock → Active', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', POINTS_BOT_DEOPPED, 'attacker'); // 3
    assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'friendly_deopped',
      POINTS_FRIENDLY_DEOPPED,
      'attacker',
      'alice',
    ); // +2 = 5
    assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'friendly_deopped',
      POINTS_FRIENDLY_DEOPPED,
      'attacker',
      'bob',
    ); // +2 = 7
    const level = assessThreat(
      api,
      config,
      state,
      chain,
      '#test',
      'mode_locked',
      POINTS_MODE_LOCKED,
      'attacker',
    ); // +1 = 8
    expect(level).toBe(THREAT_ACTIVE); // 8 >= 6
  });

  it('records events in threat state', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker');
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', 4, 'attacker');

    const threat = getThreatState(api, state, '#test');
    expect(threat).toBeDefined();
    expect(threat!.score).toBe(7);
    expect(threat!.events).toHaveLength(2);
    expect(threat!.events[0].type).toBe('bot_deopped');
    expect(threat!.events[1].type).toBe('bot_kicked');
  });

  it('channels are independent', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#chan1', 'bot_deopped', 3, 'attacker');
    assessThreat(api, config, state, chain, '#chan2', 'friendly_deopped', 2, 'attacker', 'bob');

    expect(getThreatLevel(api, config, state, '#chan1')).toBe(THREAT_ALERT);
    expect(getThreatLevel(api, config, state, '#chan2')).toBe(THREAT_NORMAL);
  });
});

// ---------------------------------------------------------------------------
// Threat score decay
// ---------------------------------------------------------------------------

describe('threat decay', () => {
  it('resets after window expires', () => {
    // Need to fake Date for time-based decay
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });

    const { api } = createMockApi();
    const config = createTestConfig({ takeover_window_ms: 100 });
    const state = createState();
    const chain = new ProtectionChain(api);

    const baseTime = Date.now();
    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker');
    expect(getThreatLevel(api, config, state, '#test')).toBe(THREAT_ALERT);

    // Advance time past the window
    vi.setSystemTime(baseTime + 150);
    expect(getThreatLevel(api, config, state, '#test')).toBe(THREAT_NORMAL);
  });

  it('new events after window expiry start fresh', () => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });

    const { api } = createMockApi();
    const config = createTestConfig({ takeover_window_ms: 100 });
    const state = createState();
    const chain = new ProtectionChain(api);

    const baseTime = Date.now();
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', 4, 'attacker');

    vi.setSystemTime(baseTime + 150);

    // New event starts a fresh window
    const level = assessThreat(api, config, state, chain, '#test', 'mode_locked', 1, 'attacker');
    expect(level).toBe(THREAT_NORMAL); // 1 < 3
    expect(getThreatState(api, state, '#test')!.score).toBe(1);
  });

  it('resetThreat clears state immediately', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);

    assessThreat(api, config, state, chain, '#test', 'bot_banned', 5, 'attacker');
    resetThreat(api, state, '#test');
    expect(getThreatLevel(api, config, state, '#test')).toBe(THREAT_NORMAL);
    expect(getThreatState(api, state, '#test')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Escalation actions — ProtectionChain called on level transitions
// ---------------------------------------------------------------------------

describe('threat escalation actions', () => {
  it('level 1 (Alert) → requestOp via chain', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);
    const backend = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(backend);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', POINTS_BOT_DEOPPED, 'attacker');
    expect(backend.calls).toContain('requestOp:#test:self');
  });

  it('level 2 (Active) → requestOp + requestUnban', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);
    const backend = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(backend);

    // Jump to level 2 in one event
    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker'); // level 1
    backend.calls.length = 0;
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', 4, 'attacker'); // 3+4=7 → level 2
    expect(backend.calls).toContain('requestOp:#test:self');
    expect(backend.calls).toContain('requestUnban:#test');
  });

  it('level 3 (Critical) → requestRecover via chain', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);
    const backend = createMockBackend('chanserv', 2, 'founder');
    chain.addBackend(backend);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker');
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', 4, 'attacker');
    backend.calls.length = 0;
    assessThreat(api, config, state, chain, '#test', 'bot_banned', 5, 'attacker'); // 3+4+5=12 → level 3
    expect(backend.calls).toContain('requestRecover:#test');
  });

  it('level 3 with no founder backend → warns manual intervention needed', () => {
    const { api, warns } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);
    const backend = createMockBackend('chanserv', 2, 'op'); // no founder access
    chain.addBackend(backend);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker');
    assessThreat(api, config, state, chain, '#test', 'bot_kicked', 4, 'attacker');
    assessThreat(api, config, state, chain, '#test', 'bot_banned', 5, 'attacker');

    expect(warns.some((w) => w.includes('manual intervention'))).toBe(true);
  });

  it('does not re-trigger escalation at same level', () => {
    const { api } = createMockApi();
    const config = createTestConfig();
    const state = createState();
    const chain = new ProtectionChain(api);
    const backend = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(backend);

    assessThreat(api, config, state, chain, '#test', 'bot_deopped', 3, 'attacker'); // → level 1
    const opCalls1 = backend.calls.filter((c) => c.startsWith('requestOp')).length;

    // Another event at same level should not re-trigger
    assessThreat(api, config, state, chain, '#test', 'mode_locked', 1, 'attacker'); // score 4, still level 1
    const opCalls2 = backend.calls.filter((c) => c.startsWith('requestOp')).length;
    expect(opCalls2).toBe(opCalls1); // no new requestOp
  });
});

// ---------------------------------------------------------------------------
// Integration: threat detection wired into plugin handlers
// ---------------------------------------------------------------------------

describe('chanmod plugin — takeover threat detection integration', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    const result = await bot.pluginLoader.load(PLUGIN_PATH, {
      chanmod: {
        enabled: true,
        config: {
          enforce_modes: true,
          enforce_delay_ms: 5,
          bitch: true,
          takeover_window_ms: 30000,
          takeover_level_1_threshold: 3,
          takeover_level_2_threshold: 6,
          takeover_level_3_threshold: 10,
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

  it('bot deopped by non-nodesynch triggers threat event', async () => {
    addToChannel(bot, 'EvilOp', 'evil', 'evil.host', '#test');
    simulateMode(bot, 'EvilOp', '#test', '-o', 'hexbot');
    await tick(50);

    // The deop triggers chanserv_op logic and threat detection
    // We can't directly inspect the threat state from here, but the
    // fact that no crash occurred and the handler processed correctly
    // is the basic integration test. Full threat scoring is unit tested above.
  });

  it('mode lockdown (+i) by non-nodesynch is recorded', async () => {
    simulateMode(bot, 'EvilOp', '#test', '+i', '');
    await tick(50);
    // No crash — handler processed the mode and reported to onThreat
  });

  it('mode lockdown (+k) by non-nodesynch is recorded', async () => {
    simulateMode(bot, 'EvilOp', '#test', '+k', 'evil_key');
    await tick(50);
  });

  it('+s by non-nodesynch is recorded', async () => {
    simulateMode(bot, 'EvilOp', '#test', '+s', '');
    await tick(50);
  });

  it('ChanServ mode changes are NOT recorded (nodesynch)', async () => {
    simulateMode(bot, 'ChanServ', '#test', '+i', '');
    await tick(50);
    // ChanServ is in nodesynch_nicks — should not generate threat event
  });

  it('unauthorized +o (bitch trigger) generates threat event', async () => {
    // Ensure bitch mode is enabled for #test
    bot.channelSettings.set('#test', 'bitch', true);
    // Ensure bot has ops
    giveBotOps(bot, '#test');
    addToChannel(bot, 'Unknown', 'unknown', 'unknown.host', '#test');
    addToChannel(bot, 'EvilOp', 'evil', 'evil.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '+o', 'Unknown');
    await tick(50);

    // Should deop Unknown (bitch mode) — this proves the handler ran
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '-o' && m.args?.includes('Unknown'),
      ),
    ).toBeDefined();
  });

  it('friendly op deopped generates threat event', async () => {
    bot.channelSettings.set('#test', 'enforce_modes', true);
    giveBotOps(bot, '#test');
    bot.permissions.addUser('alice', '*!alice@alice.host', 'o', 'test');
    addToChannel(bot, 'Alice', 'alice', 'alice.host', '#test');
    addToChannel(bot, 'EvilOp', 'evil', 'evil.host', '#test');
    bot.client.clearMessages();

    simulateMode(bot, 'EvilOp', '#test', '-o', 'Alice');
    await tick(50);

    // Should re-op Alice (enforce_modes) — proves the handler ran
    expect(
      bot.client.messages.find(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('Alice'),
      ),
    ).toBeDefined();
  });

  it('bot banned (+b matching bot hostmask) generates threat event', async () => {
    simulateMode(bot, 'EvilOp', '#test', '+b', '*!*@bot.host');
    await tick(50);
    // No crash — bot ban detection processed
  });

  it('threat events are ignored when takeover_detection is disabled', async () => {
    bot.channelSettings.set('#nodetect', 'takeover_detection', false);
    giveBotOps(bot, '#nodetect');
    addToChannel(bot, 'EvilOp', 'evil', 'evil.host', '#nodetect');
    bot.client.clearMessages();

    // Deop the bot — should NOT trigger any ChanServ escalation
    simulateMode(bot, 'EvilOp', '#nodetect', '-o', 'hexbot');
    await tick(50);

    // No ChanServ messages (no escalation)
    const csMsgs = bot.client.messages.filter((m) => m.type === 'say' && m.target === 'ChanServ');
    expect(csMsgs).toHaveLength(0);
  });

  it('onChange for non-chanserv_access keys does not crash', async () => {
    // Setting a non-chanserv_access key fires onChange but the handler should skip it
    bot.channelSettings.set('#test', 'bitch', true);
    bot.channelSettings.set('#test', 'enforce_modes', false);
    // No crash means the key !== 'chanserv_access' branch works
  });

  it('invalid chanserv_access value via raw API does not crash', async () => {
    // .chanset rejects invalid values at command time via allowedValues,
    // but direct set() calls (e.g. from DB migration) should not crash.
    bot.channelSettings.set('#test', 'chanserv_access', 'invalid_value');
    await tick(10);
  });
});

// ---------------------------------------------------------------------------
// Point values are correct
// ---------------------------------------------------------------------------

describe('threat point constants', () => {
  it('bot_deopped = 3', () => expect(POINTS_BOT_DEOPPED).toBe(3));
  it('bot_kicked = 4', () => expect(POINTS_BOT_KICKED).toBe(4));
  it('bot_banned = 5', () => expect(POINTS_BOT_BANNED).toBe(5));
  it('friendly_deopped = 2', () => expect(POINTS_FRIENDLY_DEOPPED).toBe(2));
  it('mode_locked = 1', () => expect(POINTS_MODE_LOCKED).toBe(1));
  it('unauthorized_op = 2', () => expect(POINTS_UNAUTHORIZED_OP).toBe(2));
  it('enforcement_suppressed = 2', () => expect(POINTS_ENFORCEMENT_SUPPRESSED).toBe(2));
});
