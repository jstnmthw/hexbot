import type { Socket } from 'node:net';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandExecutor } from '../../src/command-handler';
import {
  DCCAuthTracker,
  DCCManager,
  DCCSession,
  RangePortAllocator,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from '../../src/core/dcc';
import type {
  DCCIRCClient,
  DCCSessionEntry,
  DCCSessionManager,
  PendingDCC,
} from '../../src/core/dcc';
import { hashPassword } from '../../src/core/password';
import type { BindRegistrar } from '../../src/dispatcher';
import type {
  DccConfig,
  HandlerContext,
  PluginPermissions,
  PluginServices,
  UserRecord,
} from '../../src/types';
import { createMockLogger } from '../helpers/mock-logger';
import { createMockSocket } from '../helpers/mock-socket';

// Shared valid password for prompt-phase tests. Hashed once via beforeAll so
// scrypt cost isn't paid per test.
const TEST_PASSWORD = 'testpassword1';
let TEST_PASSWORD_HASH = '';

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

  it('returns 0 when a byte exceeds 255', () => {
    expect(ipToDecimal('1.2.3.256')).toBe(0);
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

  it('returns null when ip or port is not a number', () => {
    expect(parseDccChatPayload('CHAT chat notanumber 50000')).toBeNull();
    expect(parseDccChatPayload('CHAT chat 16909060 notaport')).toBeNull();
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
  ctcpMessages: Array<{ target: string; type: string; params: string[] }> = [];
  ctcpResponses: Array<{ target: string; type: string; params: string[] }> = [];

  notice(target: string, message: string): void {
    this.notices.push({ target, message });
  }

  ctcpRequest(target: string, type: string, ...params: string[]): void {
    this.ctcpMessages.push({ target, type, params });
  }

  ctcpResponse(target: string, type: string, ...params: string[]): void {
    this.ctcpResponses.push({ target, type, params });
  }

  on(_event: string, _listener: (...args: unknown[]) => void): void {}
  removeListener(_event: string, _listener: (...args: unknown[]) => void): void {}
}

function makePermissions(user: UserRecord | null): PluginPermissions {
  return {
    findByHostmask: vi.fn().mockReturnValue(user),
    checkFlags: vi.fn().mockReturnValue(true),
  };
}

function makeServices(verified = true): PluginServices {
  return {
    verifyUser: vi.fn().mockResolvedValue({ verified, account: 'testaccount' }),
    isAvailable: vi.fn().mockReturnValue(true),
    isNickServVerificationReply: vi.fn().mockReturnValue(false),
    isBotIdentified: vi.fn().mockReturnValue(true),
  };
}

function makeDispatcher(): BindRegistrar {
  return {
    bind: vi.fn(),
    unbind: vi.fn(),
    unbindAll: vi.fn(),
  };
}

function makeCommandHandler(): CommandExecutor {
  return {
    execute: vi.fn(),
  };
}

function mockSession(
  overrides: Partial<DCCSessionEntry> & { handle: string; nick: string },
): DCCSessionEntry {
  return {
    connectedAt: Date.now(),
    isRelaying: false,
    relayTarget: null,
    handleFlags: 'nm',
    rateLimitKey: `${overrides.nick}!ident@host`,
    isClosed: false,
    isStale: false,
    writeLine: vi.fn(),
    close: vi.fn(),
    enterRelay: vi.fn(),
    exitRelay: vi.fn(),
    confirmRelay: vi.fn(),
    getConsoleFlags: vi.fn().mockReturnValue('mojw'),
    setConsoleFlags: vi.fn(),
    receiveLog: vi.fn(),
    ...overrides,
  };
}

describe('DCCManager', () => {
  let client: MockIRCClient;
  let manager: DCCManager;
  let sessions: Map<string, DCCSessionEntry>;

  beforeEach(() => {
    client = new MockIRCClient();
    sessions = new Map<string, DCCSessionEntry>();
    manager = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions,
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

  it('ignores non-CHAT DCC CTCP subtype (covers lines 474-476)', async () => {
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
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    // Non-CHAT DCC types (SEND, FILE) — parseDccChatPayload returns null → ignored
    await handler(makeCtx('nick', 'SEND foo.txt 0 0'));
    expect(client.notices).toHaveLength(0);
    await handler(makeCtx('nick', 'FILE bar.txt 16909060 50000'));
    expect(client.notices).toHaveLength(0);
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
    expect(client.notices[0].message).toContain('request denied');
  });

  it('rejects insufficient flags', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const perms = makePermissions(makeUser('voiceonly', 'v'));
    (perms.checkFlags as ReturnType<typeof vi.fn>).mockReturnValue(false); // voice flag fails 'm' check
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: perms,
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ require_flags: 'm' }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    await handler(makeCtx());
    expect(client.notices[0].message).toContain('request denied');
  });

  it('getSessionList returns empty when no sessions', () => {
    expect(manager.getSessionList()).toEqual([]);
  });

  it('broadcast sends to all sessions except sender', () => {
    const writeA = vi.fn();
    const writeB = vi.fn();
    const sessionA = mockSession({ handle: 'alice', nick: 'alice', writeLine: writeA });
    const sessionB = mockSession({ handle: 'bob', nick: 'bob', writeLine: writeB });

    // Inject sessions for testing broadcast
    sessions.set('alice', sessionA);
    sessions.set('bob', sessionB);

    manager.broadcast('alice', 'hello');

    expect(writeA).not.toHaveBeenCalled();
    expect(writeB).toHaveBeenCalledWith('<alice> hello');
  });

  it('announce sends to all sessions', () => {
    const writeA = vi.fn();
    const writeB = vi.fn();
    const sessionA = mockSession({ handle: 'alice', nick: 'alice', writeLine: writeA });
    const sessionB = mockSession({ handle: 'bob', nick: 'bob', writeLine: writeB });

    sessions.set('alice', sessionA);
    sessions.set('bob', sessionB);

    manager.announce('*** bot is shutting down');

    expect(writeA).toHaveBeenCalledWith('*** bot is shutting down');
    expect(writeB).toHaveBeenCalledWith('*** bot is shutting down');
  });

  it('allocatePort returns null when range is exhausted', () => {
    const portAllocator = new RangePortAllocator([50000, 50000]);
    portAllocator.markUsed(50000);
    expect(portAllocator.allocate()).toBeNull();
  });

  it('RangePortAllocator.release frees a port', () => {
    const portAllocator = new RangePortAllocator([50000, 50000]);
    portAllocator.markUsed(50000);
    expect(portAllocator.allocate()).toBeNull();
    portAllocator.release(50000);
    expect(portAllocator.allocate()).toBe(50000);
  });

  it('respects max_sessions limit', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const localSessions = new Map<string, DCCSessionEntry>();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ max_sessions: 1 }),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions: localSessions,
    });
    m.attach();

    // Fill the session map
    const fakeSession = mockSession({ handle: 'other', nick: 'other' });
    localSessions.set('other', fakeSession);

    await handler(makeCtx('testnick'));
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(true);
  });

  it('rejects already-connected nick', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const localSessions = new Map<string, DCCSessionEntry>();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions: localSessions,
    });
    m.attach();

    const fakeSession = mockSession({ handle: 'testuser', nick: 'testnick' });
    localSessions.set('testnick', fakeSession);

    await handler(makeCtx('testnick'));
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(true);
  });

  it('evicts a stale session and lets a reconnect through', async () => {
    // Zombie scenario: the old socket is dead (NAT/firewall dropped state)
    // but the 'close' event hasn't fired yet, so isClosed is false. The
    // reconnect must evict it instead of reporting "already connected".
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const localSessions = new Map<string, DCCSessionEntry>();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions: localSessions,
    });
    m.attach();

    const staleSession = mockSession({
      handle: 'testuser',
      nick: 'testnick',
      isClosed: false,
      isStale: true,
    });
    localSessions.set('testnick', staleSession);

    await handler(makeCtx('testnick'));
    // The old session was closed for replacement, and the reconnect was
    // NOT rejected — the stale session was evicted and replaced.
    expect(staleSession.close).toHaveBeenCalledWith('Stale session replaced.');
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(false);
  });

  it('clears an already-closed session entry so the reconnect passes through', async () => {
    // Covers the branch where onClose already fired (isClosed=true) but the
    // manager map still has the stale entry — checkNotAlreadyConnected
    // should delete it and let the new offer proceed.
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const localSessions = new Map<string, DCCSessionEntry>();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions: localSessions,
    });
    m.attach();

    const closedSession = mockSession({
      handle: 'testuser',
      nick: 'testnick',
      isClosed: true,
      isStale: true,
    });
    localSessions.set('testnick', closedSession);

    await handler(makeCtx('testnick'));
    // Closed sessions are cleaned up in-place (not re-closed) and the
    // reconnect is not rejected.
    expect(closedSession.close).not.toHaveBeenCalled();
    expect(localSessions.has('testnick')).toBe(false);
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(false);
  });

  it('rejects nick with a pending connection', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const pendingMap = new Map<number, PendingDCC>();
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      pending: pendingMap,
    });
    m.attach();

    // Inject a fake pending entry for this nick
    pendingMap.set(50001, { nick: 'testnick' } as PendingDCC);

    await handler(makeCtx('testnick'));
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(true);
  });

  it('rejects when port range is exhausted (in handler)', async () => {
    const dispatcher = makeDispatcher();
    let handler!: (ctx: HandlerContext) => Promise<void>;
    (dispatcher.bind as ReturnType<typeof vi.fn>).mockImplementation(
      (_t: string, _f: string, _m: string, fn: (ctx: HandlerContext) => Promise<void>) => {
        handler = fn;
      },
    );
    const portAllocator = new RangePortAllocator([50000, 50000]);
    portAllocator.markUsed(50000);
    const m = new DCCManager({
      client,
      dispatcher,
      permissions: makePermissions(makeUser()),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ port_range: [50000, 50000] }),
      version: '1.0.0',
      botNick: 'hexbot',
      portAllocator,
    });
    m.attach();

    await handler(makeCtx());
    expect(client.notices.some((n) => n.message.includes('request denied'))).toBe(true);
  });

  it('detach closes all active sessions', () => {
    const closeSpy = vi.fn();
    const fakeSession = mockSession({ handle: 'alice', nick: 'alice', close: closeSpy });
    sessions.set('alice', fakeSession);

    manager.detach('test shutdown');
    expect(closeSpy).toHaveBeenCalledWith('test shutdown');
  });

  it('removeSession deletes by nick', () => {
    const fakeSession = mockSession({ handle: 'alice', nick: 'alice' });
    sessions.set('alice', fakeSession);
    expect(manager.getSessionList().length).toBe(1);
    manager.removeSession('alice');
    expect(manager.getSessionList().length).toBe(0);
  });

  it('setCasemapping changes session key lookup', () => {
    manager.setCasemapping('ascii');
    const fakeSession = mockSession({ handle: 'bob', nick: 'bob' });
    sessions.set('bob', fakeSession);
    manager.removeSession('bob');
    expect(manager.getSessionList().length).toBe(0);
  });

  describe('notice/privmsg mirror', () => {
    function makeMirrorManager(servicesOverride?: PluginServices): {
      m: DCCManager;
      write: ReturnType<typeof vi.fn>;
    } {
      const write = vi.fn();
      const session = mockSession({ handle: 'alice', nick: 'alice', writeLine: write });
      const sessMap = new Map<string, DCCSessionEntry>();
      sessMap.set('alice', session);
      const m = new DCCManager({
        client: new MockIRCClient(),
        dispatcher: makeDispatcher(),
        permissions: makePermissions(makeUser()),
        services: servicesOverride ?? makeServices(),
        commandHandler: makeCommandHandler(),
        config: makeConfig(),
        version: '1.0.0',
        botNick: 'hexbot',
        sessions: sessMap,
      });
      return { m, write };
    }

    it('forwards a ChanServ notice to all sessions', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorNotice({ nick: 'ChanServ', target: 'hexbot', message: 'Access granted.' });
      expect(write).toHaveBeenCalledWith('-ChanServ- Access granted.');
    });

    it('forwards a MemoServ notice to all sessions', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorNotice({ nick: 'MemoServ', target: 'hexbot', message: 'You have 1 new memo.' });
      expect(write).toHaveBeenCalledWith('-MemoServ- You have 1 new memo.');
    });

    it('skips channel notices', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorNotice({ nick: 'someone', target: '#hexbot', message: 'hi channel' });
      expect(write).not.toHaveBeenCalled();
    });

    it('suppresses NickServ STATUS replies', () => {
      const services = makeServices();
      (services.isNickServVerificationReply as ReturnType<typeof vi.fn>).mockImplementation(
        (nick: string, msg: string) =>
          nick.toLowerCase() === 'nickserv' && /^STATUS\s+\S+\s+\d+/i.test(msg),
      );
      const { m, write } = makeMirrorManager(services);
      m.mirrorNotice({ nick: 'NickServ', target: 'hexbot', message: 'STATUS alice 3' });
      expect(write).not.toHaveBeenCalled();
    });

    it('suppresses NickServ ACC replies', () => {
      const services = makeServices();
      (services.isNickServVerificationReply as ReturnType<typeof vi.fn>).mockImplementation(
        (nick: string, msg: string) =>
          nick.toLowerCase() === 'nickserv' && /^\S+\s+ACC\s+\d+/i.test(msg),
      );
      const { m, write } = makeMirrorManager(services);
      m.mirrorNotice({ nick: 'NickServ', target: 'hexbot', message: 'alice ACC 3' });
      expect(write).not.toHaveBeenCalled();
    });

    it('does NOT suppress a non-NickServ sender using a STATUS-shaped message', () => {
      const services = makeServices();
      // Real filter would also match nick, so simulate that behavior.
      (services.isNickServVerificationReply as ReturnType<typeof vi.fn>).mockImplementation(
        (nick: string, msg: string) =>
          nick.toLowerCase() === 'nickserv' && /^STATUS\s+\S+\s+\d+/i.test(msg),
      );
      const { m, write } = makeMirrorManager(services);
      m.mirrorNotice({ nick: 'SomeBot', target: 'hexbot', message: 'STATUS foo 3' });
      expect(write).toHaveBeenCalledWith('-SomeBot- STATUS foo 3');
    });

    it('forwards PRIVMSGs from services', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorPrivmsg({ nick: 'LimitServ', target: 'hexbot', message: 'limit updated' });
      expect(write).toHaveBeenCalledWith('<LimitServ> limit updated');
    });

    it('skips channel PRIVMSGs', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorPrivmsg({ nick: 'alice', target: '#foo', message: 'hi' });
      expect(write).not.toHaveBeenCalled();
    });

    it('defaults missing notice fields to empty strings', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorNotice({});
      expect(write).toHaveBeenCalledWith('-- ');
    });

    it('defaults missing privmsg fields to empty strings', () => {
      const { m, write } = makeMirrorManager();
      m.mirrorPrivmsg({});
      expect(write).toHaveBeenCalledWith('<> ');
    });
  });
});

// ---------------------------------------------------------------------------
// DCCSession — unit tests using a mock Duplex socket
// ---------------------------------------------------------------------------

function makeMockSocket() {
  return createMockSocket();
}

function makeMockManagerForSession(
  overrides: Partial<{
    sessionList: Array<{ handle: string; nick: string; connectedAt: number }>;
  }> = {},
): DCCSessionManager {
  return {
    getSessionList: vi.fn().mockReturnValue(overrides.sessionList ?? []),
    broadcast: vi.fn(),
    removeSession: vi.fn(),
    announce: vi.fn(),
    notifyPartyPart: vi.fn(),
    getBotName: vi.fn().mockReturnValue('hexbot'),
    getStats: vi.fn().mockReturnValue({
      channels: ['#test', '#dev'],
      pluginCount: 3,
      bindCount: 12,
      userCount: 2,
      uptime: 3600000,
    }),
    onRelayEnd: null,
  };
}

function buildSession(
  socket: Socket,
  overrides: {
    manager?: DCCSessionManager;
    commandHandler?: CommandExecutor;
    idleTimeoutMs?: number;
    user?: UserRecord;
    passwordHash?: string;
  } = {},
): DCCSession {
  return new DCCSession({
    manager: overrides.manager ?? makeMockManagerForSession(),
    user: overrides.user ?? makeUser(),
    passwordHash: overrides.passwordHash ?? 'scrypt$teststub$teststub',
    nick: 'testnick',
    ident: 'test',
    hostname: 'test.host',
    socket,
    commandHandler: overrides.commandHandler ?? makeCommandHandler(),
    idleTimeoutMs: overrides.idleTimeoutMs ?? 60000,
  });
}

async function flushAsync(ticks = 2): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('DCCSession', () => {
  it('writeLine appends CRLF', () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket);
    session.writeLine('hello');
    expect(written.join('')).toContain('hello\r\n');
  });

  it('isStale is false for a fresh session', () => {
    const { socket } = makeMockSocket();
    const session = buildSession(socket);
    expect(session.isStale).toBe(false);
  });

  it('isStale becomes true when the socket is destroyed', () => {
    const { socket, duplex } = makeMockSocket();
    const session = buildSession(socket);
    duplex.destroy();
    expect(session.isStale).toBe(true);
  });

  it('isStale becomes true when the session is closed', () => {
    const { socket } = makeMockSocket();
    const session = buildSession(socket);
    session.close();
    expect(session.isStale).toBe(true);
    expect(session.isClosed).toBe(true);
  });

  it('writeLine is a no-op after socket is destroyed', () => {
    const { socket, written, duplex } = makeMockSocket();
    duplex.destroy();
    const session = buildSession(socket);
    session.writeLine('should not appear');
    expect(written.join('')).not.toContain('should not appear');
  });

  it('close sends reason line and destroys socket', () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.close('Goodbye');
    expect(written.join('')).toContain('*** Goodbye');
    expect(duplex.destroyed).toBe(true);
  });

  it('close without reason destroys socket without extra write', () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    const before = written.length;
    session.close();
    expect(duplex.destroyed).toBe(true);
    expect(written.length).toBe(before);
  });

  it('close logs with "unknown" fallback when no reason is given (with a logger)', () => {
    const { socket } = makeMockSocket();
    const logger = createMockLogger();
    const session = new DCCSession({
      manager: makeMockManagerForSession(),
      user: makeUser(),
      passwordHash: 'scrypt$teststub$teststub',
      nick: 'testnick',
      ident: 'test',
      hostname: 'test.host',
      socket,
      commandHandler: makeCommandHandler(),
      idleTimeoutMs: 60000,
      logger,
    });
    session.close(); // no reason → reason ?? 'unknown'
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });

  it('close skips write and destroy when socket is already destroyed', () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    duplex.destroy(); // destroy before close; no start() so no close-listener
    const before = written.length;
    session.close('reason');
    // No additional writes because socket was already destroyed
    expect(written.length).toBe(before);
  });

  it('close is idempotent', () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket);
    session.close('first');
    const len = written.length;
    session.close('second');
    expect(written.length).toBe(len);
  });

  it('start sends banner including bot name (no prompt)', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket);
    session.startActiveForTesting('1.0.0', 'hexbot');
    await flushAsync();
    const output = written.join('');
    expect(output).toContain('hexbot');
    expect(output).toContain('testuser');
    expect(output).not.toContain('hexbot>');
    session.close();
  });

  it('start shows owner-only message for +n flag', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket, { user: makeUser('owner', 'nm') });
    session.startActiveForTesting('1.0.0', 'hexbot');
    await flushAsync();
    expect(written.join('')).toContain('owner of this bot');
    session.close();
  });

  it('start does not show owner-only message for non-owner flags', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket, { user: makeUser('admin', 'm') });
    session.startActiveForTesting('1.0.0', 'hexbot');
    await flushAsync();
    const output = written.join('');
    expect(output).not.toContain('owner of this bot');
    expect(output).toContain('+m');
    session.close();
  });

  it('start shows +- for user with no flags', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket, { user: makeUser('nobody', '') });
    session.startActiveForTesting('1.0.0', 'hexbot');
    await flushAsync();
    expect(written.join('')).toContain('+-');
    session.close();
  });

  it('.quit closes the session', async () => {
    const { socket, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.quit\n');
    await flushAsync(3);
    expect(duplex.destroyed).toBe(true);
  });

  it('.exit closes the session', async () => {
    const { socket, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.exit\n');
    await flushAsync(3);
    expect(duplex.destroyed).toBe(true);
  });

  it('.who with no sessions reports empty', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.who\n');
    await flushAsync(3);
    expect(written.join('')).toContain('No users on the console');
    session.close();
  });

  it('.who shows (you) marker for the current user', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession({
      sessionList: [{ handle: 'testuser', nick: 'testnick', connectedAt: Date.now() - 5000 }],
    });
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.who\n');
    await flushAsync(3);
    expect(written.join('')).toContain('(you)');
    session.close();
  });

  it('.who with other sessions lists them', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession({
      sessionList: [{ handle: 'alice', nick: 'alice', connectedAt: Date.now() - 5000 }],
    });
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.who\n');
    await flushAsync(3);
    const output = written.join('');
    expect(output).toContain('Console (1)');
    expect(output).toContain('alice');
    session.close();
  });

  it('bot command routes to commandHandler', async () => {
    const { socket, duplex } = makeMockSocket();
    const cmdHandler = makeCommandHandler();
    const session = buildSession(socket, { commandHandler: cmdHandler });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.help\n');
    await flushAsync(3);
    expect(cmdHandler.execute).toHaveBeenCalledWith(
      '.help',
      expect.objectContaining({ source: 'dcc', nick: 'testnick' }),
    );
    session.close();
  });

  it('commandHandler reply callback splits on newlines', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const cmdHandler = makeCommandHandler();
    (cmdHandler.execute as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, ctx: { reply: (m: string) => void }) => {
        ctx.reply('line1\nline2');
      },
    );
    const session = buildSession(socket, { commandHandler: cmdHandler });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('.test\n');
    await flushAsync(3);
    const output = written.join('');
    expect(output).toContain('line1');
    expect(output).toContain('line2');
    session.close();
  });

  it('plain text broadcasts to the party line', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('hello world\n');
    await flushAsync(3);
    expect(mgr.broadcast).toHaveBeenCalledWith('testuser', 'hello world');
    session.close();
  });

  it('empty / whitespace-only line does not broadcast', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.push('   \n');
    await flushAsync(3);
    expect(mgr.broadcast).not.toHaveBeenCalled();
    session.close();
  });

  it('socket close event triggers session cleanup', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');
    duplex.destroy();
    await flushAsync(3);
    expect(mgr.removeSession).toHaveBeenCalledWith('testnick');
    expect(mgr.announce).toHaveBeenCalledWith(expect.stringContaining('has left the console'));
  });

  it('idle timeout fires and closes session', () => {
    vi.useFakeTimers();
    try {
      const { socket, duplex } = makeMockSocket();
      const session = buildSession(socket, { idleTimeoutMs: 1000 });
      session.startActiveForTesting('1.0.0', 'hexbot');
      vi.advanceTimersByTime(1001);
      expect(duplex.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('console flags + log sink', () => {
    it('handleFlags alias returns the user flag string', () => {
      const { socket } = makeMockSocket();
      const session = buildSession(socket, { user: makeUser('boss', 'nm') });
      expect(session.handleFlags).toBe('nm');
    });

    it('getConsoleFlags returns the default string on first connect', () => {
      const { socket } = makeMockSocket();
      const session = buildSession(socket);
      expect(session.getConsoleFlags()).toBe('mojw');
    });

    it('setConsoleFlags persists the canonical flag string', () => {
      const { socket } = makeMockSocket();
      const session = buildSession(socket);
      session.setConsoleFlags(new Set(['m', 'w']));
      expect(session.getConsoleFlags()).toBe('mw');
    });

    it('receiveLog drops records while the session is in the password-prompt phase', () => {
      const { socket, written } = makeMockSocket();
      const session = buildSession(socket);
      // Session has not been started — phase is still awaiting_password.
      session.receiveLog({
        level: 'info',
        timestamp: new Date(),
        source: 'plugin:chanmod',
        formatted: '[plugin:chanmod] voiced alice',
        plain: '[plugin:chanmod] voiced alice',
        dccFormatted: '[plugin:chanmod] voiced alice',
      });
      expect(written.join('')).not.toContain('voiced alice');
    });

    it('receiveLog delivers matching records once the session is active', () => {
      const { socket, written } = makeMockSocket();
      const session = buildSession(socket);
      session.startActiveForTesting('1.0.0', 'hexbot');
      // Default flags mojw include 'o', which plugin:chanmod maps to.
      session.receiveLog({
        level: 'info',
        timestamp: new Date(),
        source: 'plugin:chanmod',
        formatted: '[plugin:chanmod] voiced alice',
        plain: '[plugin:chanmod] voiced alice',
        dccFormatted: '[plugin:chanmod] voiced alice',
      });
      expect(written.join('')).toContain('voiced alice');
    });

    it('receiveLog drops records filtered out by the current flag set', () => {
      const { socket, written } = makeMockSocket();
      const session = buildSession(socket);
      session.startActiveForTesting('1.0.0', 'hexbot');
      session.setConsoleFlags(new Set(['w'])); // only warnings/errors
      session.receiveLog({
        level: 'info',
        timestamp: new Date(),
        source: 'plugin:chanmod',
        formatted: '[plugin:chanmod] voiced alice',
        plain: '[plugin:chanmod] voiced alice',
        dccFormatted: '[plugin:chanmod] voiced alice',
      });
      expect(written.join('')).not.toContain('voiced alice');
    });

    it('receiveLog is a no-op after the session is closed', () => {
      const { socket, written } = makeMockSocket();
      const session = buildSession(socket);
      session.startActiveForTesting('1.0.0', 'hexbot');
      session.close('done');
      session.receiveLog({
        level: 'info',
        timestamp: new Date(),
        source: 'plugin:chanmod',
        formatted: '[plugin:chanmod] post-close',
        plain: '[plugin:chanmod] post-close',
        dccFormatted: '[plugin:chanmod] post-close',
      });
      expect(written.join('')).not.toContain('post-close');
    });
  });
});

// ---------------------------------------------------------------------------
// DCCSession — relay mode
// ---------------------------------------------------------------------------

describe('DCCSession relay mode', () => {
  it('enterRelay forwards input to callback', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    const relayed: string[] = [];
    session.enterRelay('leaf1', (line) => relayed.push(line));

    expect(session.isRelaying).toBe(true);
    expect(session.relayTarget).toBe('leaf1');

    duplex.push('hello world\r\n');
    await flushAsync();

    expect(relayed).toEqual(['hello world']);
    // broadcast should NOT be called — we're in relay mode
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('.relay end exits relay mode', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    (mgr.getBotName as ReturnType<typeof vi.fn>).mockReturnValue('mybot');
    mgr.onRelayEnd = vi.fn();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    session.enterRelay('leaf1', () => {});
    duplex.push('.relay end\r\n');
    await flushAsync();

    expect(session.isRelaying).toBe(false);
    expect(session.relayTarget).toBeNull();
    expect(written.join('')).toContain('Relay ended');
  });

  it('nested .relay is rejected locally with a helpful message', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    (mgr.getBotName as ReturnType<typeof vi.fn>).mockReturnValue('HEX');
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    const forwarded: string[] = [];
    session.enterRelay('BlueAngel', (line) => forwarded.push(line));

    duplex.push('.relay neo\r\n');
    await flushAsync();

    expect(forwarded).not.toContain('.relay neo');
    const output = written.join('');
    expect(output).toContain('Relay already in progress to BlueAngel');
    expect(output).toContain('.relay end');
    expect(output).toContain('HEX');
    expect(session.isRelaying).toBe(true);
    expect(session.relayTarget).toBe('BlueAngel');
  });

  it('.quit is forwarded in relay mode (does NOT exit)', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    (mgr.getBotName as ReturnType<typeof vi.fn>).mockReturnValue('mybot');
    mgr.onRelayEnd = vi.fn();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    const forwarded: string[] = [];
    session.enterRelay('leaf1', (line) => forwarded.push(line));
    duplex.push('.quit\r\n');
    await flushAsync();

    expect(session.isRelaying).toBe(true);
    expect(forwarded).toContain('.quit');
    expect(mgr.onRelayEnd).not.toHaveBeenCalled();
  });

  it('exitRelay returns to normal mode', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    session.enterRelay('leaf1', () => {});
    session.exitRelay();

    expect(session.isRelaying).toBe(false);
    expect(session.relayTarget).toBeNull();

    // Normal input should now go to broadcast
    duplex.push('normal text\r\n');
    await flushAsync();
    expect(mgr.broadcast).toHaveBeenCalled();
  });

  it('confirmRelay writes the "Now relaying" line and clears the pending timer', async () => {
    vi.useFakeTimers();
    try {
      const { socket, written } = makeMockSocket();
      const mgr = makeMockManagerForSession();
      const session = buildSession(socket, { manager: mgr });
      session.startActiveForTesting('1.0.0', 'hexbot');

      const onTimeout = vi.fn();
      session.enterRelay('leaf1', () => {}, { timeoutMs: 3000, onTimeout });
      session.confirmRelay();

      expect(written.join('')).toContain('Now relaying to leaf1');

      // Advance past the original timeout — it should be canceled
      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(session.isRelaying).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending relay timeout exits relay and fires onTimeout', async () => {
    vi.useFakeTimers();
    try {
      const { socket, written } = makeMockSocket();
      const mgr = makeMockManagerForSession();
      const session = buildSession(socket, { manager: mgr });
      session.startActiveForTesting('1.0.0', 'hexbot');

      const onTimeout = vi.fn();
      session.enterRelay('leaf1', () => {}, { timeoutMs: 3000, onTimeout });
      vi.advanceTimersByTime(3000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(session.isRelaying).toBe(false);
      expect(written.join('')).toContain('Relay request to leaf1 timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirmRelay is a no-op when not in relay mode', () => {
    const { socket, written } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.startActiveForTesting('1.0.0', 'hexbot');

    session.confirmRelay();
    expect(written.join('')).not.toContain('Now relaying');
  });

  it('exitRelay clears a pending timer set by enterRelay options', () => {
    vi.useFakeTimers();
    try {
      const { socket } = makeMockSocket();
      const mgr = makeMockManagerForSession();
      const session = buildSession(socket, { manager: mgr });
      session.startActiveForTesting('1.0.0', 'hexbot');

      const onTimeout = vi.fn();
      session.enterRelay('leaf1', () => {}, { timeoutMs: 3000, onTimeout });
      session.exitRelay();
      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enterRelay clears a previous pending timer when re-entered', () => {
    vi.useFakeTimers();
    try {
      const { socket } = makeMockSocket();
      const mgr = makeMockManagerForSession();
      const session = buildSession(socket, { manager: mgr });
      session.startActiveForTesting('1.0.0', 'hexbot');

      const onTimeout1 = vi.fn();
      const onTimeout2 = vi.fn();
      session.enterRelay('leafA', () => {}, { timeoutMs: 3000, onTimeout: onTimeout1 });
      // Re-enter for a different target — first timer must be canceled
      session.enterRelay('leafB', () => {}, { timeoutMs: 3000, onTimeout: onTimeout2 });
      vi.advanceTimersByTime(3000);
      expect(onTimeout1).not.toHaveBeenCalled();
      expect(onTimeout2).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// DCCManager — new methods
// ---------------------------------------------------------------------------

describe('DCCManager new methods', () => {
  it('getSession returns undefined for unknown nick', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ ip: '127.0.0.1', port_range: [50000, 50010] }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    expect(mgr.getSession('nobody')).toBeUndefined();
    expect(mgr.getBotName()).toBe('hexbot');
  });

  it('onPartyChat callback fires on broadcast', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ ip: '127.0.0.1', port_range: [50000, 50010] }),
      version: '1.0.0',
      botNick: 'hexbot',
    });

    const chats: string[] = [];
    mgr.onPartyChat = (handle, msg) => chats.push(`${handle}: ${msg}`);
    mgr.broadcast('admin', 'hello');
    expect(chats).toEqual(['admin: hello']);
  });

  it('getStats returns null when no stats provider was injected', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ ip: '127.0.0.1', port_range: [50000, 50010] }),
      version: '1.0.0',
      botNick: 'hexbot',
      // no getStats
    });
    expect(mgr.getStats()).toBeNull();
  });

  it('notifyPartyPart calls onPartyPart callback', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig({ ip: '127.0.0.1', port_range: [50000, 50010] }),
      version: '1.0.0',
      botNick: 'hexbot',
    });

    const parts: string[] = [];
    mgr.onPartyPart = (handle, nick) => parts.push(`${handle}:${nick}`);
    mgr.notifyPartyPart('admin', 'AdminNick');
    expect(parts).toEqual(['admin:AdminNick']);
  });
});

// ---------------------------------------------------------------------------
// DCCSession — password prompt phase
// ---------------------------------------------------------------------------

describe('DCCSession password prompt', () => {
  beforeAll(async () => {
    TEST_PASSWORD_HASH = await hashPassword(TEST_PASSWORD);
  });

  /**
   * Wait until the session's phase changes (or the timeout elapses). scrypt
   * runs on libuv threads so a few microtask ticks aren't enough — we have
   * to yield real wall-clock time before the verifyPassword callback fires.
   */
  async function waitForPhaseChange(
    session: DCCSession,
    from: 'awaiting_password' | 'active',
    timeoutMs = 2000,
  ): Promise<void> {
    const start = Date.now();
    while (session.currentPhase === from && Date.now() - start < timeoutMs) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  }

  async function waitForClosed(duplex: { destroyed: boolean }, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!duplex.destroyed && Date.now() - start < timeoutMs) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  }

  /** Short helper: yields a few microtasks to drain pending listeners. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  function buildPromptSession(opts: {
    passwordHash: string;
    user?: UserRecord;
    manager?: DCCSessionManager;
  }) {
    const mock = createMockSocket();
    const manager = opts.manager ?? makeMockManagerForSession();
    const session = new DCCSession({
      manager,
      user: opts.user ?? makeUser('alice', 'nm'),
      passwordHash: opts.passwordHash,
      nick: 'AliceNick',
      ident: 'alice',
      hostname: 'alice.host',
      socket: mock.socket,
      commandHandler: makeCommandHandler(),
      idleTimeoutMs: 60_000,
    });
    return { session, manager, ...mock };
  }

  it('start() sends the password prompt (no banner yet)', () => {
    const { session, written } = buildPromptSession({ passwordHash: TEST_PASSWORD_HASH });
    session.start('1.0.0', 'hexbot');
    const output = written.join('');
    expect(output).toContain('Enter your password:');
    expect(output).not.toContain('HexBot'); // banner art should be suppressed
    expect(session.currentPhase).toBe('awaiting_password');
    session.close();
  });

  it('correct password advances to active and renders banner', async () => {
    const { session, written, duplex, manager } = buildPromptSession({
      passwordHash: TEST_PASSWORD_HASH,
    });
    const onAuthSuccess = vi.fn();
    manager.onAuthSuccess = onAuthSuccess;

    session.start('1.0.0', 'hexbot');
    duplex.push(`${TEST_PASSWORD}\r\n`);
    await waitForPhaseChange(session, 'awaiting_password');

    expect(session.currentPhase).toBe('active');
    expect(onAuthSuccess).toHaveBeenCalledWith(session);
    expect(written.join('')).toContain('alice');
    session.close();
  });

  it('wrong password rejects, notifies onAuthFailure, and closes', async () => {
    const { session, written, duplex, manager } = buildPromptSession({
      passwordHash: TEST_PASSWORD_HASH,
    });
    const onAuthFailure = vi.fn();
    manager.onAuthFailure = onAuthFailure;

    session.start('1.0.0', 'hexbot');
    duplex.push('wrongpassword\r\n');
    await waitForClosed(duplex);

    expect(onAuthFailure).toHaveBeenCalledWith('AliceNick!alice@alice.host', 'alice');
    expect(written.join('')).toContain('bad password');
    expect(duplex.destroyed).toBe(true);
  });

  it('empty line during prompt re-prompts rather than counting as a failure', async () => {
    const { session, written, duplex, manager } = buildPromptSession({
      passwordHash: TEST_PASSWORD_HASH,
    });
    const onAuthFailure = vi.fn();
    manager.onAuthFailure = onAuthFailure;

    session.start('1.0.0', 'hexbot');
    duplex.push('\r\n');
    await flush();

    expect(session.currentPhase).toBe('awaiting_password');
    expect(onAuthFailure).not.toHaveBeenCalled();
    const output = written.join('');
    // Both the initial 'Password:' and the re-prompt 'Enter your password:'
    // should appear — case-insensitive to span both phrasings.
    const occurrences = output.match(/password:/gi) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);

    // Subsequent correct password still works
    duplex.push(`${TEST_PASSWORD}\r\n`);
    await waitForPhaseChange(session, 'awaiting_password');
    expect(session.currentPhase).toBe('active');
    session.close();
  });

  it('does not broadcast to party line while awaiting password', async () => {
    const { session, duplex, manager } = buildPromptSession({ passwordHash: TEST_PASSWORD_HASH });
    const broadcast = manager.broadcast as ReturnType<typeof vi.fn>;

    session.start('1.0.0', 'hexbot');
    // A non-password line before auth should NOT reach party line
    duplex.push('hello world\r\n');
    await waitForClosed(duplex); // wrong password → session is destroyed after the failure

    expect(broadcast).not.toHaveBeenCalled();
    // Session was never in active phase — it went from prompt straight to closed.
  });

  it('does not run commands while awaiting password', async () => {
    const cmdHandler = makeCommandHandler();
    const mock = createMockSocket();
    const session = new DCCSession({
      manager: makeMockManagerForSession(),
      user: makeUser('alice', 'nm'),
      passwordHash: TEST_PASSWORD_HASH,
      nick: 'AliceNick',
      ident: 'alice',
      hostname: 'alice.host',
      socket: mock.socket,
      commandHandler: cmdHandler,
      idleTimeoutMs: 60_000,
    });

    session.start('1.0.0', 'hexbot');
    mock.duplex.push('.help\r\n');
    await waitForClosed(mock.duplex);

    expect(cmdHandler.execute).not.toHaveBeenCalled();
  });

  it('prompt idle timer closes the session after 30s of silence', () => {
    vi.useFakeTimers();
    try {
      const { session, duplex } = buildPromptSession({ passwordHash: TEST_PASSWORD_HASH });
      session.start('1.0.0', 'hexbot');
      // No input — the short prompt timer should fire and close the session.
      vi.advanceTimersByTime(30_001);
      expect(duplex.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renderBannerPreview renders the banner without going through the prompt', () => {
    // Back door used by scripts/preview-banner.ts — render the welcome banner
    // directly so the preview script can capture it without scrypt overhead.
    const { session, written } = buildPromptSession({ passwordHash: TEST_PASSWORD_HASH });
    session.renderBannerPreview('1.0.0', 'hexbot');
    const output = written.join('');
    // Banner should contain the bot name and handle but NOT the password prompt.
    expect(output).toContain('hexbot');
    expect(output).toContain('alice');
    expect(output).not.toContain('Enter your password:');
    expect(session.currentPhase).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// DCCAuthTracker — per-hostmask failure counter with exponential backoff
// ---------------------------------------------------------------------------

describe('DCCAuthTracker', () => {
  it('starts unlocked for an unknown key', () => {
    const tracker = new DCCAuthTracker();
    expect(tracker.check('some!ident@host').locked).toBe(false);
  });

  it('records failures and does not lock before the threshold', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 3 });
    tracker.recordFailure('some!ident@host');
    tracker.recordFailure('some!ident@host');
    expect(tracker.check('some!ident@host').locked).toBe(false);
  });

  it('locks out after reaching the failure threshold', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 3, baseLockMs: 1000 });
    tracker.recordFailure('some!ident@host');
    tracker.recordFailure('some!ident@host');
    const last = tracker.recordFailure('some!ident@host');
    expect(last.locked).toBe(true);
    expect(tracker.check('some!ident@host').locked).toBe(true);
  });

  it('exponential backoff doubles each re-ban', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 2, baseLockMs: 1000 });
    // First lock
    tracker.recordFailure('k');
    const first = tracker.recordFailure('k');
    const firstDuration = first.lockedUntil - Date.now();

    // Fast-forward: pretend the first lock has expired and trigger a re-lock.
    // Use the injected `now` parameter so we don't need fake timers.
    const later = first.lockedUntil + 1_000;
    tracker.recordFailure('k', later);
    const second = tracker.recordFailure('k', later);
    const secondDuration = second.lockedUntil - later;

    expect(secondDuration).toBeGreaterThan(firstDuration);
    expect(secondDuration).toBe(2 * firstDuration);
  });

  it('success zeroes the failure counter but preserves banCount', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 3, baseLockMs: 1000 });
    tracker.recordFailure('k');
    tracker.recordFailure('k');
    tracker.recordSuccess('k');
    expect(tracker.check('k').failures).toBe(0);
  });

  it('sweep removes stale entries with no bans', () => {
    const tracker = new DCCAuthTracker({ windowMs: 1000 });
    tracker.recordFailure('k', 1000);
    tracker.sweep(1_000_000); // far in the future
    expect(tracker.check('k').failures).toBe(0);
  });

  it('failure counter resets when a failure arrives after the window expires', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 5, windowMs: 1000 });
    tracker.recordFailure('k', 1000);
    tracker.recordFailure('k', 1500);
    expect(tracker.check('k').failures).toBe(2);
    // Record a failure after the window has elapsed — counter resets to 1
    const status = tracker.recordFailure('k', 3000);
    expect(status.failures).toBe(1);
  });

  it('sweep removes escalated entries once the 24h stale window has passed', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 1, baseLockMs: 1000, windowMs: 1000 });
    // Trip the tracker — banCount becomes 1 (first lock duration = 1000 * 2^0 = 1000ms)
    tracker.recordFailure('k', 1000);
    // Sweep long after — entry should be pruned (banCount > 0 branch + STALE_MS elapsed).
    tracker.sweep(2_000 + 86_400_001);
    // Recording a new failure against the same key should start as if no prior
    // history existed. If the escalated entry had *not* been pruned, the second
    // lock would use banCount=1 (2x base lock); after pruning, banCount=0 again.
    const fresh = tracker.recordFailure('k', 1_000_000_000);
    const freshLockDuration = fresh.lockedUntil - 1_000_000_000;
    expect(freshLockDuration).toBe(1000); // == baseLockMs * 2^0, proving banCount reset
  });
});

// ---------------------------------------------------------------------------
// DCCManager.openSession — prompt integration (migration, lockout)
// ---------------------------------------------------------------------------

describe('DCCManager.openSession prompt integration', () => {
  beforeAll(async () => {
    if (!TEST_PASSWORD_HASH) {
      TEST_PASSWORD_HASH = await hashPassword(TEST_PASSWORD);
    }
  });

  function buildManager(overrides: Partial<DCCManager> = {}): DCCManager {
    const client = new MockIRCClient();
    const sessions = new Map<string, DCCSessionEntry>();
    const mgr = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      sessions,
    });
    Object.assign(mgr, overrides);
    return mgr;
  }

  function buildPending(user: UserRecord) {
    return {
      nick: 'AliceNick',
      user,
      ident: 'alice',
      hostname: 'alice.host',
      server: undefined as unknown as import('node:net').Server,
      port: 0,
      timer: setTimeout(() => {}, 0),
    };
  }

  it('rejects a user with no password_hash with the migration notice', () => {
    const mgr = buildManager();
    const user: UserRecord = {
      handle: 'alice',
      hostmasks: ['*!alice@alice.host'],
      global: 'nm',
      channels: {},
      // no password_hash
    };
    const pending = buildPending(user);
    const { socket, written, duplex } = createMockSocket();

    mgr.openSession(pending, socket);

    expect(duplex.destroyed).toBe(true);
    expect(written.join('')).toContain('no password set');
    expect(written.join('')).toContain('.chpass');
    clearTimeout(pending.timer);
  });

  it('creates a session and prompts when password_hash is present', () => {
    const mgr = buildManager();
    const user: UserRecord = {
      handle: 'alice',
      hostmasks: ['*!alice@alice.host'],
      global: 'nm',
      channels: {},
      password_hash: TEST_PASSWORD_HASH,
    };
    const pending = buildPending(user);
    const { socket, written, duplex } = createMockSocket();

    mgr.openSession(pending, socket);

    expect(duplex.destroyed).toBe(false);
    expect(written.join('')).toContain('Enter your password:');
    expect(written.join('')).not.toContain('no password set');
    // Clean up — session is still awaiting input
    duplex.destroy();
    clearTimeout(pending.timer);
  });

  it('early error handler catches socket errors before DCCSession starts', () => {
    // Guarantees the guard between accept and DCCSession.start() — an error
    // fired on the reject path (no password_hash) must hit the early handler,
    // not surface as uncaught. Uses the no-password rejection so the flow
    // exits openSession without creating a session whose own handlers would
    // mask the early one.
    const logger = createMockLogger();
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      logger,
    });
    const user: UserRecord = {
      handle: 'alice',
      hostmasks: ['*!alice@alice.host'],
      global: 'nm',
      channels: {},
      // no password_hash — triggers early reject path
    };
    const pending = buildPending(user);
    const { socket, duplex } = createMockSocket();

    mgr.openSession(pending, socket);

    // The socket is destroyed on the reject path, but the early error
    // listener remains attached — emitting an error must not throw and
    // must route to the debug logger.
    expect(() => duplex.emit('error', new Error('boom'))).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
    clearTimeout(pending.timer);
  });

  it('rejects a currently-locked-out identity without prompting', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 1, baseLockMs: 60_000 });
    tracker.recordFailure('AliceNick!alice@alice.host');

    const client = new MockIRCClient();
    const mgr = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      authTracker: tracker,
    });

    const user: UserRecord = {
      handle: 'alice',
      hostmasks: ['*!alice@alice.host'],
      global: 'nm',
      channels: {},
      password_hash: TEST_PASSWORD_HASH,
    };
    const pending = buildPending(user);
    const { socket, written, duplex } = createMockSocket();

    mgr.openSession(pending, socket);

    expect(duplex.destroyed).toBe(true);
    expect(written.join('')).toContain('too many failed');
    clearTimeout(pending.timer);
  });

  it('onAuthFailure escalates the tracker until lockout', async () => {
    const tracker = new DCCAuthTracker({ maxFailures: 3, baseLockMs: 60_000 });
    const client = new MockIRCClient();
    const mgr = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      authTracker: tracker,
    });

    const key = 'Eve!eve@evil.host';
    mgr.onAuthFailure(key, 'eve');
    mgr.onAuthFailure(key, 'eve');
    mgr.onAuthFailure(key, 'eve');

    expect(tracker.check(key).locked).toBe(true);
  });

  it('onAuthFailure writes an auth-fail mod_log row on every attempt', async () => {
    const { BotDatabase } = await import('../../src/database');
    const db = new BotDatabase(':memory:');
    db.open();
    const tracker = new DCCAuthTracker({ maxFailures: 3, baseLockMs: 60_000 });
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      authTracker: tracker,
      db,
    });

    mgr.onAuthFailure('Eve!eve@evil.host', 'eve');

    const rows = db.getModLog({ action: 'auth-fail' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('dcc');
    expect(rows[0].target).toBe('eve');
    expect(rows[0].outcome).toBe('failure');
    expect(rows[0].metadata).toMatchObject({ peer: 'Eve!eve@evil.host', failures: 1 });
    // Critical: never log the attempted password — the helper has no
    // access to it, but a sanity check that nothing leaks via metadata.
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toMatch(/password|secret|hunter2/i);
    db.close();
  });

  it('onAuthFailure writes a distinct auth-lockout row when the tracker locks', async () => {
    const { BotDatabase } = await import('../../src/database');
    const db = new BotDatabase(':memory:');
    db.open();
    const tracker = new DCCAuthTracker({ maxFailures: 2, baseLockMs: 60_000 });
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      authTracker: tracker,
      db,
    });

    mgr.onAuthFailure('Eve!eve@evil.host', 'eve');
    mgr.onAuthFailure('Eve!eve@evil.host', 'eve');

    expect(db.getModLog({ action: 'auth-fail' })).toHaveLength(2);
    const lockoutRows = db.getModLog({ action: 'auth-lockout' });
    expect(lockoutRows).toHaveLength(1);
    expect(lockoutRows[0].target).toBe('eve');
    expect(lockoutRows[0].outcome).toBe('failure');
    expect(lockoutRows[0].metadata).toMatchObject({ peer: 'Eve!eve@evil.host' });
    db.close();
  });

  it('onAuthSuccess clears the failure counter and registers the session', () => {
    const tracker = new DCCAuthTracker({ maxFailures: 5 });
    const client = new MockIRCClient();
    const localSessions = new Map<string, DCCSessionEntry>();
    const mgr = new DCCManager({
      client,
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      authTracker: tracker,
      sessions: localSessions,
    });

    // Seed a failure so recordSuccess has something to clear
    tracker.recordFailure('AliceNick!alice@alice.host');
    const fakeSession: DCCSessionEntry = {
      handle: 'alice',
      nick: 'AliceNick',
      connectedAt: Date.now(),
      isRelaying: false,
      relayTarget: null,
      handleFlags: 'nm',
      rateLimitKey: 'AliceNick!alice@alice.host',
      isClosed: false,
      isStale: false,
      writeLine: vi.fn(),
      close: vi.fn(),
      enterRelay: vi.fn(),
      exitRelay: vi.fn(),
      confirmRelay: vi.fn(),
      getConsoleFlags: () => '',
      setConsoleFlags: vi.fn(),
      receiveLog: vi.fn(),
    };

    mgr.onAuthSuccess(fakeSession);

    expect(tracker.check('AliceNick!alice@alice.host').failures).toBe(0);
    expect(localSessions.size).toBe(1);
  });

  it('onAuthSuccess writes a login/success mod_log row and returns its id', async () => {
    const { BotDatabase } = await import('../../src/database');
    const db = new BotDatabase(':memory:');
    db.open();
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      db,
    });

    const fakeSession: DCCSessionEntry = {
      handle: 'alice',
      nick: 'AliceNick',
      connectedAt: Date.now(),
      isRelaying: false,
      relayTarget: null,
      handleFlags: 'nm',
      rateLimitKey: 'AliceNick!alice@alice.host',
      isClosed: false,
      isStale: false,
      writeLine: vi.fn(),
      close: vi.fn(),
      enterRelay: vi.fn(),
      exitRelay: vi.fn(),
      confirmRelay: vi.fn(),
      getConsoleFlags: () => '',
      setConsoleFlags: vi.fn(),
      receiveLog: vi.fn(),
    };

    const id = mgr.onAuthSuccess(fakeSession);

    expect(typeof id).toBe('number');
    const rows = db.getModLog({ action: 'login' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].source).toBe('dcc');
    expect(rows[0].by).toBe('alice');
    expect(rows[0].target).toBe('alice');
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].metadata).toMatchObject({ peer: 'AliceNick!alice@alice.host' });
    db.close();
  });

  it('onAuthSuccess returns null and writes nothing when db is absent', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      // no db
    });

    const fakeSession: DCCSessionEntry = {
      handle: 'alice',
      nick: 'AliceNick',
      connectedAt: Date.now(),
      isRelaying: false,
      relayTarget: null,
      handleFlags: 'nm',
      rateLimitKey: 'AliceNick!alice@alice.host',
      isClosed: false,
      isStale: false,
      writeLine: vi.fn(),
      close: vi.fn(),
      enterRelay: vi.fn(),
      exitRelay: vi.fn(),
      confirmRelay: vi.fn(),
      getConsoleFlags: () => '',
      setConsoleFlags: vi.fn(),
      receiveLog: vi.fn(),
    };

    expect(mgr.onAuthSuccess(fakeSession)).toBeNull();
  });

  it('getLoginSummaryForHandle returns null without a db', () => {
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    expect(mgr.getLoginSummaryForHandle('alice', null)).toBeNull();
  });

  it('onAuthFailure still writes a login row for a subsequent success', async () => {
    // Integration sanity: the login-row path and the auth-fail path coexist
    // so the banner's "since your last login" window has both anchors to work with.
    const { BotDatabase } = await import('../../src/database');
    const db = new BotDatabase(':memory:');
    db.open();
    const mgr = new DCCManager({
      client: new MockIRCClient(),
      dispatcher: makeDispatcher(),
      permissions: makePermissions(null),
      services: makeServices(),
      commandHandler: makeCommandHandler(),
      config: makeConfig(),
      version: '1.0.0',
      botNick: 'hexbot',
      db,
      getBootTs: () => 1_000_000,
    });

    mgr.onAuthFailure('Eve!eve@evil.host', 'alice');
    const fakeSession: DCCSessionEntry = {
      handle: 'alice',
      nick: 'AliceNick',
      connectedAt: Date.now(),
      isRelaying: false,
      relayTarget: null,
      handleFlags: 'nm',
      rateLimitKey: 'AliceNick!alice@alice.host',
      isClosed: false,
      isStale: false,
      writeLine: vi.fn(),
      close: vi.fn(),
      enterRelay: vi.fn(),
      exitRelay: vi.fn(),
      confirmRelay: vi.fn(),
      getConsoleFlags: () => '',
      setConsoleFlags: vi.fn(),
      receiveLog: vi.fn(),
    };
    const id = mgr.onAuthSuccess(fakeSession);

    const summary = mgr.getLoginSummaryForHandle('alice', id);
    expect(summary).not.toBeNull();
    // The one failure pre-dates the login row we just wrote — surface it.
    expect(summary?.failedSince).toBe(1);
    expect(summary?.mostRecent?.peer).toBe('Eve!eve@evil.host');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// renderBanner — failed-login warning block
// ---------------------------------------------------------------------------

describe('renderBanner login summary', () => {
  const rb = async () => (await import('../../src/core/dcc/banner')).renderBanner;
  const strip = async () => (await import('../../src/utils/strip-formatting')).stripFormatting;

  const baseOpts = {
    handle: 'alice',
    flags: '',
    nick: 'AliceNick',
    ident: 'alice',
    hostname: 'alice.host',
    consoleFlags: new Set<never>(),
    version: '1.0.0',
    botNick: 'hexbot',
    stats: null,
    otherSessions: [] as string[],
  };

  it('renders no warning block when loginSummary is null', async () => {
    const renderBanner = await rb();
    const stripFormatting = await strip();
    const lines: string[] = [];
    renderBanner({ ...baseOpts, loginSummary: null }, (line) => lines.push(line));
    const output = stripFormatting(lines.join('\n'));
    expect(output).not.toMatch(/failed login attempt/);
    expect(output).not.toMatch(/rate-limit/);
  });

  it('renders a single-line count and most-recent line when failures exist', async () => {
    const renderBanner = await rb();
    const stripFormatting = await strip();
    const lines: string[] = [];
    renderBanner(
      {
        ...baseOpts,
        loginSummary: {
          failedSince: 3,
          mostRecent: { timestamp: 1_700_000_000, peer: '198.51.100.7:53214' },
          lockoutsSince: 0,
          usedBootFallback: false,
        },
      },
      (line) => lines.push(line),
    );
    const output = stripFormatting(lines.join('\n'));
    expect(output).toMatch(/3 failed login attempts since your last login/);
    expect(output).toMatch(/most recent: .* from 198\.51\.100\.7:53214/);
    expect(output).not.toMatch(/rate-limit/);
  });

  it('renders both lines when lockoutsSince > 0', async () => {
    const renderBanner = await rb();
    const stripFormatting = await strip();
    const lines: string[] = [];
    renderBanner(
      {
        ...baseOpts,
        loginSummary: {
          failedSince: 5,
          mostRecent: { timestamp: 1_700_000_000, peer: 'foe!eve@host:1' },
          lockoutsSince: 2,
          usedBootFallback: false,
        },
      },
      (line) => lines.push(line),
    );
    const output = stripFormatting(lines.join('\n'));
    expect(output).toMatch(/5 failed login attempts/);
    expect(output).toMatch(/rate-limit triggered 2 times/);
  });

  it('switches phrasing to "since bot start" when usedBootFallback is true', async () => {
    const renderBanner = await rb();
    const stripFormatting = await strip();
    const lines: string[] = [];
    renderBanner(
      {
        ...baseOpts,
        loginSummary: {
          failedSince: 1,
          mostRecent: { timestamp: 1_700_000_000, peer: 'x!y@z' },
          lockoutsSince: 0,
          usedBootFallback: true,
        },
      },
      (line) => lines.push(line),
    );
    const output = stripFormatting(lines.join('\n'));
    expect(output).toMatch(/1 failed login attempt since bot start/);
    expect(output).not.toMatch(/since your last login/);
  });

  it('truncates overly long peer strings', async () => {
    const renderBanner = await rb();
    const stripFormatting = await strip();
    const longPeer = 'very.long.hostname.example.com:65535/with/extra/bits/that/overflow';
    const lines: string[] = [];
    renderBanner(
      {
        ...baseOpts,
        loginSummary: {
          failedSince: 1,
          mostRecent: { timestamp: 1_700_000_000, peer: longPeer },
          lockoutsSince: 0,
          usedBootFallback: false,
        },
      },
      (line) => lines.push(line),
    );
    const output = stripFormatting(lines.join('\n'));
    expect(output).toContain('…');
    expect(output).not.toContain(longPeer);
  });
});
