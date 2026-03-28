import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DCCManager,
  DCCSession,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from '../../src/core/dcc';
import type { DCCIRCClient } from '../../src/core/dcc';
import type { DccConfig, HandlerContext, UserRecord } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers — unit tests
// ---------------------------------------------------------------------------

describe('ipToDecimal', () => {
  it('converts a standard IP', () => {
    expect(ipToDecimal('1.2.3.4')).toBe(16909060);
  });

  it('converts 0.0.0.0', () => {
    expect(ipToDecimal('0.0.0.0')).toBe(0);
  });

  it('converts 255.255.255.255', () => {
    expect(ipToDecimal('255.255.255.255')).toBe(4294967295);
  });

  it('returns 0 for invalid input', () => {
    expect(ipToDecimal('not.an.ip')).toBe(0);
    expect(ipToDecimal('')).toBe(0);
  });
});

describe('parseDccChatPayload', () => {
  it('parses a passive DCC request', () => {
    const result = parseDccChatPayload('CHAT chat 0 0 12345');
    expect(result).toEqual({ subtype: 'CHAT', ip: 0, port: 0, token: 12345 });
  });

  it('parses an active DCC request (no token)', () => {
    const result = parseDccChatPayload('CHAT chat 16909060 50000');
    expect(result).toEqual({ subtype: 'CHAT', ip: 16909060, port: 50000, token: 0 });
  });

  it('returns null for non-CHAT subtype', () => {
    expect(parseDccChatPayload('FILE foo.txt 0 0')).toBeNull();
    expect(parseDccChatPayload('SEND foo.txt 0 0')).toBeNull();
  });

  it('returns null for empty or malformed input', () => {
    expect(parseDccChatPayload('')).toBeNull();
    expect(parseDccChatPayload('CHAT')).toBeNull();
    expect(parseDccChatPayload('CHAT chat')).toBeNull();
  });

  it('is case-insensitive for the subtype word', () => {
    const result = parseDccChatPayload('chat chat 0 0 9999');
    expect(result).toEqual({ subtype: 'CHAT', ip: 0, port: 0, token: 9999 });
  });
});

describe('isPassiveDcc', () => {
  it('returns true when ip=0 and port=0 (standard passive)', () => {
    expect(isPassiveDcc(0, 0)).toBe(true);
  });

  it('returns true when ip is real but port=0 (mIRC-style passive)', () => {
    expect(isPassiveDcc(16909060, 0)).toBe(true);
  });

  it('returns false for active DCC (non-zero port)', () => {
    expect(isPassiveDcc(16909060, 50000)).toBe(false);
    expect(isPassiveDcc(0, 50000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DCCManager — unit tests (no real TCP)
// ---------------------------------------------------------------------------

function makeUser(handle = 'testuser', flags = 'nm'): UserRecord {
  return { handle, hostmasks: ['*!test@test.host'], global: flags, channels: {} };
}

function makeConfig(overrides: Partial<DccConfig> = {}): DccConfig {
  return {
    enabled: true,
    ip: '1.2.3.4',
    port_range: [50000, 50002],
    require_flags: 'm',
    max_sessions: 2,
    idle_timeout_ms: 300000,
    nickserv_verify: false,
    ...overrides,
  };
}

function makeCtx(nick = 'testnick', args = 'CHAT chat 0 0 42'): HandlerContext {
  return {
    nick,
    ident: 'test',
    hostname: 'test.host',
    channel: null,
    text: args,
    command: 'DCC',
    args,
    reply: vi.fn(),
    replyPrivate: vi.fn(),
  };
}

class MockIRCClient implements DCCIRCClient {
  notices: Array<{ target: string; message: string }> = [];
  ctcpResponses: Array<{ target: string; type: string; params: string[] }> = [];

  notice(target: string, message: string): void {
    this.notices.push({ target, message });
  }

  ctcpResponse(target: string, type: string, ...params: string[]): void {
    this.ctcpResponses.push({ target, type, params });
  }
}

function makePermissions(user: UserRecord | null) {
  return {
    findByHostmask: vi.fn().mockReturnValue(user),
    checkFlags: vi.fn().mockReturnValue(true),
  } as unknown as import('../../src/core/permissions.js').Permissions;
}

function makeServices(verified = true) {
  return {
    verifyUser: vi.fn().mockResolvedValue({ verified, account: 'testaccount' }),
    isAvailable: vi.fn().mockReturnValue(true),
  } as unknown as import('../../src/core/services.js').Services;
}

function makeDispatcher() {
  return {
    bind: vi.fn(),
    unbindAll: vi.fn(),
  } as unknown as import('../../src/dispatcher.js').EventDispatcher;
}

function makeCommandHandler() {
  return {
    execute: vi.fn(),
  } as unknown as import('../../src/command-handler.js').CommandHandler;
}

describe('DCCManager', () => {
  let client: MockIRCClient;
  let manager: DCCManager;

  beforeEach(() => {
    client = new MockIRCClient();
    manager = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
  });

  it('attach() registers a ctcp DCC bind', () => {
    const dispatcher = makeDispatcher();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();
    expect(dispatcher.bind).toHaveBeenCalledWith(
      'ctcp',
      '-',
      'DCC',
      expect.any(Function),
      'core:dcc',
    );
  });

  it('detach() unbinds and closes sessions', () => {
    const dispatcher = makeDispatcher();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();
    m.detach();
    expect(dispatcher.unbindAll).toHaveBeenCalledWith('core:dcc');
  });

  it('rejects non-passive DCC (active, real ip/port)', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (
        _type: string,
        _flags: string,
        _mask: string,
        fn: (ctx: HandlerContext) => Promise<void>,
      ) => {
        handler = fn;
      },
    );
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    await handler(makeCtx('nick', 'CHAT chat 16909060 50000'));
    expect(client.notices.length).toBe(1);
    expect(client.notices[0].message).toContain('passive');
  });

  it('rejects unknown hostmask', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(null), // unknown hostmask
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    await handler(makeCtx());
    expect(client.notices[0].message).toContain('user database');
  });

  it('rejects insufficient flags', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser('voiceonly', 'v')), // only voice flag
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ require_flags: 'm' }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    await handler(makeCtx());
    expect(client.notices[0].message).toContain('insufficient flags');
  });

  it('getSessionList returns empty when no sessions', () => {
    expect(manager.getSessionList()).toEqual([]);
  });

  it('broadcast sends to all sessions except sender', () => {
    const writeA = vi.fn();
    const writeB = vi.fn();
    const sessionA = { handle: 'alice', nick: 'alice', writeLine: writeA } as unknown as DCCSession;
    const sessionB = { handle: 'bob', nick: 'bob', writeLine: writeB } as unknown as DCCSession;

    // Manually inject sessions for testing broadcast
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set('alice', sessionA);
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set('bob', sessionB);

    manager.broadcast('alice', 'hello');

    expect(writeA).not.toHaveBeenCalled();
    expect(writeB).toHaveBeenCalledWith('<alice> hello');
  });

  it('announce sends to all sessions', () => {
    const writeA = vi.fn();
    const writeB = vi.fn();
    const sessionA = { handle: 'alice', nick: 'alice', writeLine: writeA } as unknown as DCCSession;
    const sessionB = { handle: 'bob', nick: 'bob', writeLine: writeB } as unknown as DCCSession;

    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set('alice', sessionA);
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set('bob', sessionB);

    manager.announce('*** bot is shutting down');

    expect(writeA).toHaveBeenCalledWith('*** bot is shutting down');
    expect(writeB).toHaveBeenCalledWith('*** bot is shutting down');
  });

  it('allocatePort returns null when range is exhausted', () => {
    const m = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ port_range: [50000, 50000] }), // only one port
      version: '1.0.0',
      botNick: 'hexbot',
    });
    // Mark the only port as in use
    (m as unknown as { allocatedPorts: Set<number> }).allocatedPorts.add(50000);
    const port = (m as unknown as { allocatePort: () => number | null }).allocatePort();
    expect(port).toBeNull();
  });

  it('respects max_sessions limit', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ max_sessions: 1 }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    // Fill the session map
    const fakeSession = {
      handle: 'other',
      nick: 'other',
      writeLine: vi.fn(),
    } as unknown as DCCSession;
    (m as unknown as { sessions: Map<string, DCCSession> }).sessions.set('other', fakeSession);

    await handler(makeCtx('testnick'));
    expect(client.notices.some((n) => n.message.includes('maximum sessions'))).toBe(true);
  });
});
