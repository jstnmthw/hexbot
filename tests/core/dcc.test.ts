import { Duplex } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DCCManager,
  DCCSession,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from '../../src/core/dcc';
import type { DCCIRCClient } from '../../src/core/dcc';
import type { Logger } from '../../src/logger';
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

  it('rejects already-connected nick', async () => {
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

    const fakeSession = {
      handle: 'testuser',
      nick: 'testnick',
      writeLine: vi.fn(),
      close: vi.fn(),
    } as unknown as DCCSession;
    (m as unknown as { sessions: Map<string, DCCSession> }).sessions.set('testnick', fakeSession);

    await handler(makeCtx('testnick'));
    expect(client.notices.some((n) => n.message.includes('active session'))).toBe(true);
  });

  it('proceeds past NickServ verify when verification succeeds', async () => {
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
      services: makeServices(true), // verification succeeds
      commandHandler: makeCommandHandler(),
      config: makeConfig({ nickserv_verify: true, port_range: [50000, 50000] }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();
    // Exhaust the port range so we bail before real TCP
    (m as unknown as { allocatedPorts: Set<number> }).allocatedPorts.add(50000);

    await handler(makeCtx());
    // Port exhausted → notice (proves the NickServ check passed without rejecting)
    expect(client.notices.some((n) => n.message.includes('no ports available'))).toBe(true);
  });

  it('rejects when NickServ verification fails', async () => {
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
      services: makeServices(false), // verification fails
      commandHandler: makeCommandHandler(),
      config: makeConfig({ nickserv_verify: true }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();

    await handler(makeCtx());
    expect(client.notices.some((n) => n.message.includes('NickServ verification failed'))).toBe(
      true,
    );
  });

  it('rejects when port range is exhausted (in handler)', async () => {
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
      config: makeConfig({ port_range: [50000, 50000] }),
      version: '1.0.0',
      botNick: 'hexbot',
    });
    m.attach();
    (m as unknown as { allocatedPorts: Set<number> }).allocatedPorts.add(50000);

    await handler(makeCtx());
    expect(client.notices.some((n) => n.message.includes('no ports available'))).toBe(true);
  });

  it('detach closes all active sessions', () => {
    const closeSpy = vi.fn();
    const fakeSession = {
      handle: 'alice',
      nick: 'alice',
      writeLine: vi.fn(),
      close: closeSpy,
    } as unknown as DCCSession;
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set(
      'alice',
      fakeSession,
    );

    manager.detach('test shutdown');
    expect(closeSpy).toHaveBeenCalledWith('test shutdown');
  });

  it('removeSession deletes by nick', () => {
    const fakeSession = {
      handle: 'alice',
      nick: 'alice',
      writeLine: vi.fn(),
      connectedAt: Date.now(),
    } as unknown as DCCSession;
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set(
      'alice',
      fakeSession,
    );
    expect(manager.getSessionList().length).toBe(1);
    manager.removeSession('alice');
    expect(manager.getSessionList().length).toBe(0);
  });

  it('setCasemapping changes session key lookup', () => {
    manager.setCasemapping('ascii');
    const fakeSession = {
      handle: 'bob',
      nick: 'bob',
      writeLine: vi.fn(),
      connectedAt: Date.now(),
    } as unknown as DCCSession;
    (manager as unknown as { sessions: Map<string, DCCSession> }).sessions.set('bob', fakeSession);
    manager.removeSession('bob');
    expect(manager.getSessionList().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DCCSession — unit tests using a mock Duplex socket
// ---------------------------------------------------------------------------

function makeMockSocket(): {
  socket: import('node:net').Socket;
  written: string[];
  duplex: Duplex;
} {
  const written: string[] = [];
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      cb();
    },
  });
  return { socket: duplex as unknown as import('node:net').Socket, written, duplex };
}

function makeMockManagerForSession(
  overrides: Partial<{
    sessionList: Array<{ handle: string; nick: string; connectedAt: number }>;
  }> = {},
) {
  return {
    getSessionList: vi.fn().mockReturnValue(overrides.sessionList ?? []),
    broadcast: vi.fn(),
    removeSession: vi.fn(),
    announce: vi.fn(),
  } as unknown as DCCManager;
}

function buildSession(
  socket: import('node:net').Socket,
  overrides: {
    manager?: DCCManager;
    commandHandler?: import('../../src/command-handler.js').CommandHandler;
    idleTimeoutMs?: number;
    user?: UserRecord;
  } = {},
): DCCSession {
  return new DCCSession({
    manager: overrides.manager ?? makeMockManagerForSession(),
    user: overrides.user ?? makeUser(),
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
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;
    const session = new DCCSession({
      manager: makeMockManagerForSession(),
      user: makeUser(),
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
    session.start('1.0.0', 'hexbot');
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
    session.start('1.0.0', 'hexbot');
    await flushAsync();
    expect(written.join('')).toContain('owner of this bot');
    session.close();
  });

  it('start does not show owner-only message for non-owner flags', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket, { user: makeUser('admin', 'm') });
    session.start('1.0.0', 'hexbot');
    await flushAsync();
    const output = written.join('');
    expect(output).not.toContain('owner of this bot');
    expect(output).toContain('+m');
    session.close();
  });

  it('start shows +- for user with no flags', async () => {
    const { socket, written } = makeMockSocket();
    const session = buildSession(socket, { user: makeUser('nobody', '') });
    session.start('1.0.0', 'hexbot');
    await flushAsync();
    expect(written.join('')).toContain('+-');
    session.close();
  });

  it('.quit closes the session', async () => {
    const { socket, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.start('1.0.0', 'hexbot');
    duplex.push('.quit\n');
    await flushAsync(3);
    expect(duplex.destroyed).toBe(true);
  });

  it('.exit closes the session', async () => {
    const { socket, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.start('1.0.0', 'hexbot');
    duplex.push('.exit\n');
    await flushAsync(3);
    expect(duplex.destroyed).toBe(true);
  });

  it('.console with no sessions reports empty', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.start('1.0.0', 'hexbot');
    duplex.push('.console\n');
    await flushAsync(3);
    expect(written.join('')).toContain('No users on the console');
    session.close();
  });

  it('.who is an alias for .console', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const session = buildSession(socket);
    session.start('1.0.0', 'hexbot');
    duplex.push('.who\n');
    await flushAsync(3);
    expect(written.join('')).toContain('No users on the console');
    session.close();
  });

  it('.console shows (you) marker for the current user', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession({
      sessionList: [{ handle: 'testuser', nick: 'testnick', connectedAt: Date.now() - 5000 }],
    });
    const session = buildSession(socket, { manager: mgr });
    session.start('1.0.0', 'hexbot');
    duplex.push('.console\n');
    await flushAsync(3);
    expect(written.join('')).toContain('(you)');
    session.close();
  });

  it('.console with other sessions lists them', async () => {
    const { socket, written, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession({
      sessionList: [{ handle: 'alice', nick: 'alice', connectedAt: Date.now() - 5000 }],
    });
    const session = buildSession(socket, { manager: mgr });
    session.start('1.0.0', 'hexbot');
    duplex.push('.console\n');
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
    session.start('1.0.0', 'hexbot');
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
    session.start('1.0.0', 'hexbot');
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
    session.start('1.0.0', 'hexbot');
    duplex.push('hello world\n');
    await flushAsync(3);
    expect(mgr.broadcast).toHaveBeenCalledWith('testuser', 'hello world');
    session.close();
  });

  it('empty / whitespace-only line does not broadcast', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.start('1.0.0', 'hexbot');
    duplex.push('   \n');
    await flushAsync(3);
    expect(mgr.broadcast).not.toHaveBeenCalled();
    session.close();
  });

  it('socket close event triggers session cleanup', async () => {
    const { socket, duplex } = makeMockSocket();
    const mgr = makeMockManagerForSession();
    const session = buildSession(socket, { manager: mgr });
    session.start('1.0.0', 'hexbot');
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
      session.start('1.0.0', 'hexbot');
      vi.advanceTimersByTime(1001);
      expect(duplex.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
