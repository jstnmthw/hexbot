import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AthemeBackend } from '../../plugins/chanmod/atheme-backend';
import { makeChanmodPluginOverrides } from '../helpers/chanmod-plugin-config';
import type { MockBot } from '../helpers/mock-bot';
import { createMockBot } from '../helpers/mock-bot';
import { giveBotOps } from '../helpers/plugin-test-helpers';

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Atheme backend — unit tests
// ---------------------------------------------------------------------------

describe('AthemeBackend — command format', () => {
  let bot: MockBot;

  beforeAll(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
  });

  afterAll(() => {
    bot.cleanup();
  });

  beforeEach(() => {
    bot.client.clearMessages();
  });

  function createBackend(): AthemeBackend {
    const shim = {
      say: (target: string, message: string) => bot.client.say(target, message),
      log: (...args: unknown[]) => bot.logger.info('[test]', ...args),
      warn: (...args: unknown[]) => bot.logger.warn('[test]', ...args),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AthemeBackend(shim as never, 'ChanServ');
  }

  it('requestOp sends correct PRIVMSG format', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestOp('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'OP #test hexbot',
    });
  });

  it('requestOp with explicit nick', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestOp('#test', 'alice');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'OP #test alice',
    });
  });

  it('requestDeop sends correct format', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'superop');
    backend.requestDeop('#test', 'hostile');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'DEOP #test hostile',
    });
  });

  it('requestUnban sends correct format', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestUnban('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'UNBAN #test',
    });
  });

  it('requestInvite sends correct format', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestInvite('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'INVITE #test',
    });
  });

  it('requestRecover sends RECOVER command', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'founder');
    backend.requestRecover('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'RECOVER #test',
    });
  });

  it('requestClearBans sends CLEAR BANS', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'founder');
    backend.requestClearBans('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'CLEAR #test BANS',
    });
  });

  it('requestAkick sends AKICK ADD with reason', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestAkick('#test', '*!*@evil.host', 'Takeover attempt');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ADD *!*@evil.host Takeover attempt',
    });
  });

  it('requestAkick sends AKICK ADD without reason', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.requestAkick('#test', '*!*@evil.host');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'AKICK #test ADD *!*@evil.host',
    });
  });

  it('verifyAccess sends FLAGS probe', () => {
    const backend = createBackend();
    backend.setAccess('#test', 'op');
    backend.verifyAccess('#test');
    expect(bot.client.messages).toContainEqual({
      type: 'say',
      target: 'ChanServ',
      message: 'FLAGS #test hexbot',
    });
  });
});

// ---------------------------------------------------------------------------
// Atheme backend — access gating
// ---------------------------------------------------------------------------

describe('AthemeBackend — access gating', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  function createBackend(): AthemeBackend {
    const shim = {
      say: (_t: string, _m: string) => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AthemeBackend(shim as never, 'ChanServ');
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

  it('access=op — can OP/UNBAN/INVITE/AKICK but not DEOP/RECOVER/CLEAR', () => {
    const b = createBackend();
    b.setAccess('#test', 'op');
    expect(b.canOp('#test')).toBe(true);
    expect(b.canUnban('#test')).toBe(true);
    expect(b.canInvite('#test')).toBe(true);
    expect(b.canAkick('#test')).toBe(true);
    expect(b.canDeop('#test')).toBe(false);
    expect(b.canRecover('#test')).toBe(false);
    expect(b.canClearBans('#test')).toBe(false);
  });

  it('access=superop — can DEOP but not RECOVER/CLEAR', () => {
    const b = createBackend();
    b.setAccess('#test', 'superop');
    expect(b.canOp('#test')).toBe(true);
    expect(b.canDeop('#test')).toBe(true);
    expect(b.canUnban('#test')).toBe(true);
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
// Atheme backend — FLAGS response parsing
// ---------------------------------------------------------------------------

describe('AthemeBackend — flagsToTier', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  function createBackend(): AthemeBackend {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    return new AthemeBackend(shim as never, 'ChanServ');
  }

  it('maps +AFORaefhioqrstv to founder', () => {
    expect(createBackend().flagsToTier('+AFORaefhioqrstv')).toBe('founder');
  });

  it('maps +R alone to founder', () => {
    expect(createBackend().flagsToTier('+R')).toBe('founder');
  });

  it('maps +F alone to founder', () => {
    expect(createBackend().flagsToTier('+F')).toBe('founder');
  });

  it('maps +AOaefhiorstv (SOP without +R) to superop', () => {
    expect(createBackend().flagsToTier('+AOaefhiorstv')).toBe('superop');
  });

  it('maps +f alone to superop', () => {
    expect(createBackend().flagsToTier('+f')).toBe('superop');
  });

  it('maps +AOehiortv (AOP) to op', () => {
    expect(createBackend().flagsToTier('+AOehiortv')).toBe('op');
  });

  it('maps +o alone to op', () => {
    expect(createBackend().flagsToTier('+o')).toBe('op');
  });

  it('maps +AV (VOP) to none — no op capability', () => {
    expect(createBackend().flagsToTier('+AV')).toBe('none');
  });

  it('maps empty string to none', () => {
    expect(createBackend().flagsToTier('')).toBe('none');
  });

  it('maps (none) to none', () => {
    expect(createBackend().flagsToTier('(none)')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Atheme backend — verify access downgrade
// ---------------------------------------------------------------------------

describe('AthemeBackend — handleFlagsResponse', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  it('downgrades configured founder to op when FLAGS show only +o', () => {
    const warnings: string[] = [];
    const shim = {
      say: () => {},
      log: () => {},
      warn: (...args: unknown[]) => warnings.push(String(args[0])),
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AthemeBackend(shim as never, 'ChanServ');
    b.setAccess('#test', 'founder');
    b.handleFlagsResponse('#test', '+AOehiortv');
    expect(b.getAccess('#test')).toBe('op');
    expect(warnings.some((w) => w.includes('downgrading'))).toBe(true);
  });

  it('does not downgrade when actual meets or exceeds configured', () => {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AthemeBackend(shim as never, 'ChanServ');
    b.setAccess('#test', 'op');
    b.handleFlagsResponse('#test', '+AFORaefhioqrstv');
    // Should not downgrade — actual (founder) exceeds configured (op)
    expect(b.getAccess('#test')).toBe('op');
  });

  it('auto-detects access when configured is none and flags show real access', () => {
    const logs: string[] = [];
    const shim = {
      say: () => {},
      log: (...args: unknown[]) => logs.push(String(args[0])),
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AthemeBackend(shim as never, 'ChanServ');
    // Don't set access — defaults to 'none'
    b.handleFlagsResponse('#test', '+o');
    expect(b.getAccess('#test')).toBe('op');
    expect(b.isAutoDetected('#test')).toBe(true);
    expect(logs.some((l) => l.includes('auto-detected'))).toBe(true);
  });

  it('does not auto-detect when flags show no access', () => {
    const shim = {
      say: () => {},
      log: () => {},
      warn: () => {},
      ircLower: (s: string) => s.toLowerCase(),
      botConfig: bot.botConfig,
    };
    const b = new AthemeBackend(shim as never, 'ChanServ');
    b.handleFlagsResponse('#test', '(none)');
    expect(b.getAccess('#test')).toBe('none');
    expect(b.isAutoDetected('#test')).toBe(false);
  });
});
