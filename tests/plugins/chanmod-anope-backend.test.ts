import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnopeBackend } from '../../plugins/chanmod/anope-backend';
import { createProbeState } from '../../plugins/chanmod/chanserv-notice';
import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Anope backend — command format
// ---------------------------------------------------------------------------

describe('AnopeBackend — command format', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH);
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  function createBackend(): AnopeBackend {
    const shim = {
      say: (target: string, message: string) => bot.client.say(target, message),
      log: (...args: unknown[]) => bot.logger.info('[test]', ...args),
      warn: (...args: unknown[]) => bot.logger.warn('[test]', ...args),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AnopeBackend(shim as never, 'ChanServ', 5);
  }

  it('requestOp sends correct PRIVMSG format', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    b.requestOp('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'OP #test hexbot',
    });
  });

  it('requestOp with explicit nick', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    b.requestOp('#test', 'alice');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'OP #test alice',
    });
  });

  it('requestDeop sends correct format', () => {
    const b = createBackend();
    b.setAccess('#test', 'superop');
    b.requestDeop('#test', 'hostile');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'DEOP #test hostile',
    });
  });

  it('requestUnban sends correct format', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    b.requestUnban('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'UNBAN #test',
    });
  });

  it('requestInvite sends correct format', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    b.requestInvite('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'INVITE #test',
    });
  });

  it('requestClearBans sends MODE CLEAR bans', () => {
    const b = createBackend();
    b.setAccess('#test', 'founder');
    b.requestClearBans('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'MODE #test CLEAR bans',
    });
  });

  it('requestAkick sends AKICK ADD + ENFORCE', () => {
    const b = createBackend();
    b.setAccess('#test', 'superop');
    b.requestAkick('#test', '*!*@evil.host', 'Bad actor');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ADD *!*@evil.host Bad actor',
    });
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ENFORCE',
    });
  });

  it('requestAkick without reason still sends ENFORCE', () => {
    const b = createBackend();
    b.setAccess('#test', 'superop');
    b.requestAkick('#test', '*!*@evil.host');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ADD *!*@evil.host',
    });
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ENFORCE',
    });
  });

  it('verifyAccess sends ACCESS LIST', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    b.verifyAccess('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'ACCESS #test LIST',
    });
  });
});

// ---------------------------------------------------------------------------
// Anope backend — synthetic RECOVER sequence
// ---------------------------------------------------------------------------

describe('AnopeBackend — synthetic RECOVER', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  function createBackend(): AnopeBackend {
    const shim = {
      say: (target: string, message: string) => bot.client.say(target, message),
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AnopeBackend(shim as never, 'ChanServ', 5); // 5ms step delay for fast tests
  }

  it('sends 4-step sequence: MODE CLEAR → UNBAN + INVITE → OP', async () => {
    const b = createBackend();
    b.setAccess('#test', 'founder');
    b.requestRecover('#test');

    // Step 1: MODE CLEAR ops (immediate)
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'MODE #test CLEAR ops',
    });
    expect(bot.client.messages).toHaveLength(1);

    // Step 2-3: After delay → UNBAN + INVITE
    await tick(10);
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'UNBAN #test',
    });
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'INVITE #test',
    });

    // Step 4: After another delay → OP
    await tick(10);
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'OP #test',
    });

    b.clearTimers();
  });

  it('clearTimers cancels pending recover steps', async () => {
    const b = createBackend();
    b.setAccess('#test', 'founder');
    b.requestRecover('#test');

    // Immediately clear — no further messages should arrive
    b.clearTimers();
    const count = bot.client.messages.length;
    await tick(100);
    expect(bot.client.messages).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// Anope backend — access gating
// ---------------------------------------------------------------------------

describe('AnopeBackend — access gating', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  function createBackend(): AnopeBackend {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AnopeBackend(shim as never, 'ChanServ');
  }

  it('access=none — all capabilities false', () => {
    const b = createBackend();
    b.setAccess('#test', 'none');
    expect(b.canOp('#test')).toBe(false);
    expect(b.canDeop('#test')).toBe(false);
    expect(b.canUnban('#test')).toBe(false);
    expect(b.canInvite('#test')).toBe(false);
    expect(b.canRecover('#test')).toBe(false);
    expect(b.canClearBans('#test')).toBe(false);
    expect(b.canAkick('#test')).toBe(false);
  });

  it('access=op — can OP/UNBAN/INVITE but not DEOP/AKICK/RECOVER', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    expect(b.canOp('#test')).toBe(true);
    expect(b.canUnban('#test')).toBe(true);
    expect(b.canInvite('#test')).toBe(true);
    // Anope AKICK requires SOP (superop)
    expect(b.canAkick('#test')).toBe(false);
    expect(b.canDeop('#test')).toBe(false);
    expect(b.canRecover('#test')).toBe(false);
    expect(b.canClearBans('#test')).toBe(false);
  });

  it('access=superop — can DEOP/AKICK but not RECOVER/CLEAR', () => {
    const b = createBackend();
    b.setAccess('#test', 'superop');
    expect(b.canOp('#test')).toBe(true);
    expect(b.canDeop('#test')).toBe(true);
    expect(b.canAkick('#test')).toBe(true);
    expect(b.canRecover('#test')).toBe(false);
    expect(b.canClearBans('#test')).toBe(false);
  });

  it('access=founder — all capabilities true', () => {
    const b = createBackend();
    b.setAccess('#test', 'founder');
    expect(b.canOp('#test')).toBe(true);
    expect(b.canDeop('#test')).toBe(true);
    expect(b.canUnban('#test')).toBe(true);
    expect(b.canInvite('#test')).toBe(true);
    expect(b.canRecover('#test')).toBe(true);
    expect(b.canClearBans('#test')).toBe(true);
    expect(b.canAkick('#test')).toBe(true);
  });

  it('unconfigured channel defaults to none', () => {
    const b = createBackend();
    expect(b.getAccess('#unknown')).toBe('none');
    expect(b.canOp('#unknown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Anope backend — levelToTier
// ---------------------------------------------------------------------------

describe('AnopeBackend — levelToTier', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  function createBackend(): AnopeBackend {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AnopeBackend(shim as never, 'ChanServ');
  }

  it('level 10000 → founder', () => {
    expect(createBackend().levelToTier(10000)).toBe('founder');
  });

  it('level 99999 → founder', () => {
    expect(createBackend().levelToTier(99999)).toBe('founder');
  });

  it('level 10 → superop (SOP)', () => {
    expect(createBackend().levelToTier(10)).toBe('superop');
  });

  it('level 9999 → superop (QOP)', () => {
    expect(createBackend().levelToTier(9999)).toBe('superop');
  });

  it('level 5 → op (AOP)', () => {
    expect(createBackend().levelToTier(5)).toBe('op');
  });

  it('level 9 → op', () => {
    expect(createBackend().levelToTier(9)).toBe('op');
  });

  it('level 4 → none (HOP)', () => {
    expect(createBackend().levelToTier(4)).toBe('none');
  });

  it('level 3 → none (VOP)', () => {
    expect(createBackend().levelToTier(3)).toBe('none');
  });

  it('level 0 → none', () => {
    expect(createBackend().levelToTier(0)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Anope backend — handleAccessResponse
// ---------------------------------------------------------------------------

describe('AnopeBackend — handleAccessResponse', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  it('downgrades configured founder to op when level is 5', () => {
    const warnings: string[] = [];
    const shim = {
      say: () => {},
      log: () => {},
      warn: (...args: unknown[]) => warnings.push(String(args[0])),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    b.setAccess('#test', 'founder');
    b.handleAccessResponse('#test', 5);
    expect(b.getAccess('#test')).toBe('op');
    expect(warnings.some((w) => w.includes('downgrading'))).toBe(true);
  });

  it('does not downgrade when actual meets configured', () => {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    b.setAccess('#test', 'op');
    b.handleAccessResponse('#test', 10000);
    expect(b.getAccess('#test')).toBe('op');
  });

  it('auto-detects access when configured is none and level shows real access', () => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const shim = {
      say: () => {},
      log: (...args: unknown[]) => logs.push(String(args[0])),
      warn: (...args: unknown[]) => warnings.push(String(args[0])),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    // Don't set any access — defaults to 'none'
    b.handleAccessResponse('#test', 10000);
    // Should auto-detect as founder
    expect(warnings).toHaveLength(0);
    expect(b.getAccess('#test')).toBe('founder');
    expect(b.isAutoDetected('#test')).toBe(true);
    expect(logs.some((l) => l.includes('auto-detected'))).toBe(true);
  });

  it('does not auto-detect when level shows no access', () => {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    b.handleAccessResponse('#test', 0);
    expect(b.getAccess('#test')).toBe('none');
    expect(b.isAutoDetected('#test')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requestRemoveKey — GETKEY
// ---------------------------------------------------------------------------

describe('Anope backend — requestRemoveKey (GETKEY)', () => {
  it('sends GETKEY and registers a pending callback', () => {
    const messages: string[] = [];
    const shim = {
      say: (_t: string, m: string) => messages.push(m),
      log: () => {},
      debug: () => {},
      warn: () => {},
      join: vi.fn(),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: { irc: { nick: 'hexbot' } },
    };
    const probeState = createProbeState();
    const b = new AnopeBackend(shim as never, 'ChanServ', undefined, probeState);
    b.setAccess('#test', 'op');

    expect(b.canRemoveKey('#test')).toBe(true);
    b.requestRemoveKey('#test');

    expect(messages).toContain('GETKEY #test');
    expect(probeState.pendingGetKey.has('#test')).toBe(true);

    // Simulate GETKEY response — callback fires join
    const callback = probeState.pendingGetKey.get('#test')!;
    callback('secretkey');
    expect(shim.join).toHaveBeenCalledWith('#test', 'secretkey');
  });

  it('callback with null key does not join', () => {
    const shim = {
      say: () => {},
      log: () => {},
      debug: () => {},
      warn: () => {},
      join: vi.fn(),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: { irc: { nick: 'hexbot' } },
    };
    const probeState = createProbeState();
    const b = new AnopeBackend(shim as never, 'ChanServ', undefined, probeState);
    b.setAccess('#test', 'op');
    b.requestRemoveKey('#test');

    const callback = probeState.pendingGetKey.get('#test')!;
    callback(null);
    expect(shim.join).not.toHaveBeenCalled();
  });

  it('canRemoveKey returns false when access is none', () => {
    const shim = {
      say: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: { irc: { nick: 'hexbot' } },
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    expect(b.canRemoveKey('#test')).toBe(false);
  });

  it('setAccess clears auto-detected flag when value changes', () => {
    const shim = {
      say: () => {},
      log: () => {},
      debug: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: { irc: { nick: 'hexbot' } },
    };
    const b = new AnopeBackend(shim as never, 'ChanServ');
    // Simulate auto-detection
    b.handleAccessResponse('#test', 10);
    expect(b.isAutoDetected('#test')).toBe(true);
    // Change access — should clear auto-detected flag
    b.setAccess('#test', 'founder');
    expect(b.isAutoDetected('#test')).toBe(false);
  });
});
