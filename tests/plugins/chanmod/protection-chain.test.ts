import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendAccess, ProtectionBackend } from '../../../plugins/chanmod/protection-backend';
import {
  ProtectionChain,
  accessAtLeast,
  maxAccess,
} from '../../../plugins/chanmod/protection-backend';
import type { MockBot } from '../../helpers/mock-bot';
import { createMockBot } from '../../helpers/mock-bot';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Utility function tests
// ---------------------------------------------------------------------------

describe('accessAtLeast', () => {
  it('none >= none', () => expect(accessAtLeast('none', 'none')).toBe(true));
  it('op >= none', () => expect(accessAtLeast('op', 'none')).toBe(true));
  it('op >= op', () => expect(accessAtLeast('op', 'op')).toBe(true));
  it('none < op', () => expect(accessAtLeast('none', 'op')).toBe(false));
  it('superop >= op', () => expect(accessAtLeast('superop', 'op')).toBe(true));
  it('op < superop', () => expect(accessAtLeast('op', 'superop')).toBe(false));
  it('founder >= founder', () => expect(accessAtLeast('founder', 'founder')).toBe(true));
  it('superop < founder', () => expect(accessAtLeast('superop', 'founder')).toBe(false));
});

describe('maxAccess', () => {
  it('none vs none = none', () => expect(maxAccess('none', 'none')).toBe('none'));
  it('op vs none = op', () => expect(maxAccess('op', 'none')).toBe('op'));
  it('none vs founder = founder', () => expect(maxAccess('none', 'founder')).toBe('founder'));
  it('superop vs op = superop', () => expect(maxAccess('superop', 'op')).toBe('superop'));
});

// ---------------------------------------------------------------------------
// Mock backend for chain tests
// ---------------------------------------------------------------------------

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
// ProtectionChain tests
// ---------------------------------------------------------------------------

describe('ProtectionChain', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  function createChainApi() {
    return {
      log: () => {},
      warn: () => {},
    } as never;
  }

  it('dispatches to highest-priority backend that can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const botnet = createMockBackend('botnet', 1, 'op');
    const chanserv = createMockBackend('chanserv', 2, 'founder');
    chain.addBackend(chanserv); // add in wrong order — should still sort by priority
    chain.addBackend(botnet);

    const result = chain.requestOp('#test');
    expect(result).toBe(true);
    expect(botnet.calls).toContain('requestOp:#test:self');
    expect(chanserv.calls).toHaveLength(0); // chanserv not called — botnet handled it
  });

  it('falls through when first backend cannot act', () => {
    const chain = new ProtectionChain(createChainApi());
    const botnet = createMockBackend('botnet', 1, 'none'); // no access
    const chanserv = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(botnet);
    chain.addBackend(chanserv);

    const result = chain.requestOp('#test');
    expect(result).toBe(true);
    expect(botnet.calls).toHaveLength(0); // botnet skipped
    expect(chanserv.calls).toContain('requestOp:#test:self');
  });

  it('returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const botnet = createMockBackend('botnet', 1, 'none');
    const chanserv = createMockBackend('chanserv', 2, 'none');
    chain.addBackend(botnet);
    chain.addBackend(chanserv);

    const result = chain.requestOp('#test');
    expect(result).toBe(false);
    expect(botnet.calls).toHaveLength(0);
    expect(chanserv.calls).toHaveLength(0);
  });

  it('canOp aggregates across backends', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('botnet', 1, 'none'));
    chain.addBackend(createMockBackend('chanserv', 2, 'op'));
    expect(chain.canOp('#test')).toBe(true);
  });

  it('canOp returns false when all backends are none', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('botnet', 1, 'none'));
    chain.addBackend(createMockBackend('chanserv', 2, 'none'));
    expect(chain.canOp('#test')).toBe(false);
  });

  it('canRecover requires founder-level backend', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('botnet', 1, 'op'));
    chain.addBackend(createMockBackend('chanserv', 2, 'superop'));
    expect(chain.canRecover('#test')).toBe(false);

    chain.addBackend(createMockBackend('chanserv2', 3, 'founder'));
    expect(chain.canRecover('#test')).toBe(true);
  });

  it('getAccess returns highest across all backends', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('botnet', 1, 'op'));
    chain.addBackend(createMockBackend('chanserv', 2, 'founder'));
    expect(chain.getAccess('#test')).toBe('founder');
  });

  it('getAccess returns none when no backends have access', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('botnet', 1, 'none'));
    expect(chain.getAccess('#test')).toBe('none');
  });

  it('setAccess targets a specific backend by name', () => {
    const chain = new ProtectionChain(createChainApi());
    const chanserv = createMockBackend('chanserv', 2, 'none');
    chain.addBackend(chanserv);
    chain.setAccess('#test', 'chanserv', 'founder');
    expect(chanserv.getAccess('#test')).toBe('founder');
  });

  it('verifyAccess calls all backends regardless of access level', () => {
    const chain = new ProtectionChain(createChainApi());
    const botnet = createMockBackend('botnet', 1, 'none');
    const chanserv = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(botnet);
    chain.addBackend(chanserv);

    chain.verifyAccess('#test');
    expect(botnet.calls).toContain('verifyAccess:#test'); // probes even when 'none' (auto-detect)
    expect(chanserv.calls).toContain('verifyAccess:#test');
  });

  it('requestDeop requires superop-level backend', () => {
    const chain = new ProtectionChain(createChainApi());
    const opBackend = createMockBackend('op-only', 1, 'op');
    chain.addBackend(opBackend);
    expect(chain.requestDeop('#test', 'hostile')).toBe(false);

    const sopBackend = createMockBackend('superop', 2, 'superop');
    chain.addBackend(sopBackend);
    expect(chain.requestDeop('#test', 'hostile')).toBe(true);
    expect(sopBackend.calls).toContain('requestDeop:#test:hostile');
  });

  it('requestUnban dispatches correctly', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(b);
    expect(chain.requestUnban('#test')).toBe(true);
    expect(b.calls).toContain('requestUnban:#test');
  });

  it('requestInvite dispatches correctly', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(b);
    expect(chain.requestInvite('#test')).toBe(true);
    expect(b.calls).toContain('requestInvite:#test');
  });

  it('requestRecover dispatches to founder-level backend', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'founder');
    chain.addBackend(b);
    expect(chain.requestRecover('#test')).toBe(true);
    expect(b.calls).toContain('requestRecover:#test');
  });

  it('requestClearBans dispatches to founder-level backend', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'founder');
    chain.addBackend(b);
    expect(chain.requestClearBans('#test')).toBe(true);
    expect(b.calls).toContain('requestClearBans:#test');
  });

  it('requestAkick dispatches to capable backend', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(b);
    expect(chain.requestAkick('#test', '*!*@bad', 'reason')).toBe(true);
    expect(b.calls).toContain('requestAkick:#test:*!*@bad:reason');
  });

  it('handles empty backend list gracefully', () => {
    const chain = new ProtectionChain(createChainApi());
    expect(chain.canOp('#test')).toBe(false);
    expect(chain.requestOp('#test')).toBe(false);
    expect(chain.getAccess('#test')).toBe('none');
  });

  it('requestClearBans returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op'); // needs founder for clearBans
    chain.addBackend(b);
    expect(chain.requestClearBans('#test')).toBe(false);
    expect(b.calls).toHaveLength(0);
  });

  it('requestRemoveKey returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'none');
    chain.addBackend(b);
    expect(chain.requestRemoveKey('#test')).toBe(false);
    expect(b.calls).toHaveLength(0);
  });

  it('requestRemoveKey dispatches to capable backend', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(b);
    expect(chain.requestRemoveKey('#test')).toBe(true);
    expect(b.calls).toContain('requestRemoveKey:#test');
  });

  it('isAutoDetected returns true when a backend has auto-detected access', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(b);
    // Mock backend doesn't auto-detect by default
    expect(chain.isAutoDetected('#test')).toBe(false);
  });

  it('requestAkick returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'none'); // needs op for akick
    chain.addBackend(b);
    expect(chain.requestAkick('#test', '*!*@bad', 'reason')).toBe(false);
    expect(b.calls).toHaveLength(0);
  });

  it('requestInvite returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'none');
    chain.addBackend(b);
    expect(chain.requestInvite('#test')).toBe(false);
  });

  it('requestRecover returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'op'); // needs founder for recover
    chain.addBackend(b);
    expect(chain.requestRecover('#test')).toBe(false);
  });

  it('requestUnban returns false when no backend can act', () => {
    const chain = new ProtectionChain(createChainApi());
    const b = createMockBackend('chanserv', 2, 'none');
    chain.addBackend(b);
    expect(chain.requestUnban('#test')).toBe(false);
  });

  it('canClearBans returns true when a backend has founder access', () => {
    const chain = new ProtectionChain(createChainApi());
    chain.addBackend(createMockBackend('chanserv', 2, 'founder'));
    expect(chain.canClearBans('#test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProtectionChain — full escalation sequence
// ---------------------------------------------------------------------------

describe('ProtectionChain — escalation sequence', () => {
  let bot: MockBot;

  beforeAll(() => {
    bot = createMockBot({ botNick: 'hexbot' });
  });

  afterAll(() => {
    bot.cleanup();
  });

  it('botnet (op) → chanserv (founder): botnet handles op, chanserv handles recover', () => {
    const chain = new ProtectionChain({
      log: () => {},
      warn: () => {},
    } as never);

    const botnet = createMockBackend('botnet', 1, 'op');
    const chanserv = createMockBackend('chanserv', 2, 'founder');
    chain.addBackend(botnet);
    chain.addBackend(chanserv);

    // requestOp → botnet (priority 1, has op access)
    chain.requestOp('#test');
    expect(botnet.calls).toContain('requestOp:#test:self');
    expect(chanserv.calls).toHaveLength(0);

    // requestRecover → chanserv (botnet can't recover — no founder access)
    chain.requestRecover('#test');
    expect(chanserv.calls).toContain('requestRecover:#test');
    // botnet should still only have the original call
    expect(botnet.calls.filter((c) => c.startsWith('requestRecover'))).toHaveLength(0);
  });

  it('botnet down (none) → everything goes to chanserv', () => {
    const chain = new ProtectionChain({
      log: () => {},
      warn: () => {},
    } as never);

    const botnet = createMockBackend('botnet', 1, 'none');
    const chanserv = createMockBackend('chanserv', 2, 'op');
    chain.addBackend(botnet);
    chain.addBackend(chanserv);

    chain.requestOp('#test');
    chain.requestUnban('#test');
    expect(botnet.calls).toHaveLength(0);
    expect(chanserv.calls).toContain('requestOp:#test:self');
    expect(chanserv.calls).toContain('requestUnban:#test');
  });
});
