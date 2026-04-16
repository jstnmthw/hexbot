import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import type { CommandPermissionsProvider } from '../../src/command-handler';
import { registerDccConsoleCommands } from '../../src/core/commands/dcc-console-commands';
import {
  type ConsoleFlagStore,
  DCCManager,
  type DCCSessionEntry,
  createInMemoryConsoleFlagStore,
  formatFlags,
  parseCanonicalFlags,
  shouldDeliverToSession,
} from '../../src/core/dcc';
import { BotDatabase } from '../../src/database';
import { type LogRecord, Logger, createLogger } from '../../src/logger';
import type { DccConfig, PluginServices } from '../../src/types';

const allowAll: CommandPermissionsProvider = {
  checkFlags: () => true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): DccConfig {
  return {
    enabled: true,
    ip: '127.0.0.1',
    port_range: [50000, 50001],
    require_flags: 'm',
    max_sessions: 4,
    idle_timeout_ms: 300000,
  };
}

function makeServices(): PluginServices {
  return {
    verifyUser: vi.fn().mockResolvedValue({ verified: true, account: 'x' }),
    isAvailable: vi.fn().mockReturnValue(true),
    isNickServVerificationReply: vi.fn().mockReturnValue(false),
  };
}

class StubIrcClient {
  on() {}
  removeListener() {}
  notice() {}
  ctcpRequest() {}
  ctcpResponse() {}
}

function fakeSession(
  handle: string,
  flags: string,
  handleFlags = 'nm',
): DCCSessionEntry & { received: LogRecord[]; writes: string[] } {
  const received: LogRecord[] = [];
  const writes: string[] = [];
  let consoleFlags = parseCanonicalFlags(flags);
  return {
    handle,
    nick: handle,
    connectedAt: Date.now(),
    isRelaying: false,
    relayTarget: null,
    handleFlags,
    rateLimitKey: `${handle}!ident@host`,
    isClosed: false,
    isStale: false,
    received,
    writes,
    writeLine(line: string) {
      writes.push(line);
    },
    close: vi.fn(),
    enterRelay: vi.fn(),
    exitRelay: vi.fn(),
    confirmRelay: vi.fn(),
    getConsoleFlags() {
      return formatFlags(consoleFlags);
    },
    setConsoleFlags(next) {
      consoleFlags = new Set(next);
    },
    receiveLog(record) {
      if (!shouldDeliverToSession(record, consoleFlags)) return;
      received.push(record);
      writes.push(record.formatted);
    },
  };
}

function makeManager(sessions: Map<string, DCCSessionEntry>, store?: ConsoleFlagStore): DCCManager {
  return new DCCManager({
    client: new StubIrcClient() as never,
    dispatcher: { bind: vi.fn(), unbind: vi.fn(), unbindAll: vi.fn() },
    permissions: { findByHostmask: vi.fn(), checkFlags: vi.fn() } as never,
    services: makeServices(),
    commandHandler: { execute: vi.fn() },
    config: makeConfig(),
    version: '0.0.0',
    botNick: 'hexbot',
    sessions,
    consoleFlagStore: store,
  });
}

// ---------------------------------------------------------------------------
// Log sink wiring
// ---------------------------------------------------------------------------

describe('DCCManager log sink', () => {
  beforeEach(() => {
    Logger.clearSinks();
  });

  it('installs a LogSink on attach that fans records out to sessions', () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    mgr.attach();

    const logger = createLogger('info');
    const child = logger.child('plugin:chanmod');
    child.info('voiced bob');

    expect(session.received.length).toBe(1);
    expect(session.received[0].source).toBe('plugin:chanmod');
    expect(session.received[0].formatted).toContain('voiced bob');

    mgr.detach();
  });

  it('createInMemoryConsoleFlagStore supports get/set/delete', () => {
    const store = createInMemoryConsoleFlagStore();
    expect(store.get('alice')).toBeNull();
    store.set('alice', 'mojw');
    expect(store.get('alice')).toBe('mojw');
    store.delete('alice');
    expect(store.get('alice')).toBeNull();
  });

  it('removes the sink on detach so later logs do not hit stale sessions', () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    mgr.attach();
    mgr.detach();

    const logger = createLogger('info');
    logger.child('plugin:chanmod').info('after detach');

    expect(session.received.length).toBe(0);
  });

  it('delivers operator actions to sessions with default flags but drops dispatcher debug', () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const defaultSession = fakeSession('alice', 'mojw');
    sessions.set('alice', defaultSession);
    const mgr = makeManager(sessions);
    mgr.attach();

    const logger = createLogger('debug');
    logger.child('plugin:chanmod').info('voice');
    logger.child('dispatcher').debug('running handler');

    expect(defaultSession.received.map((r) => r.source)).toEqual(['plugin:chanmod']);
    mgr.detach();
  });

  it('delivers dispatcher debug lines once +d is set', () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojwd');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    mgr.attach();

    createLogger('debug').child('dispatcher').debug('inside handler');

    expect(session.received.length).toBe(1);
    expect(session.received[0].source).toBe('dispatcher');
    mgr.detach();
  });

  it('delivers warn records to sessions that have w set, regardless of category', () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'w');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    mgr.attach();

    createLogger('debug').child('plugin:chanmod').warn('heads up');
    expect(session.received.length).toBe(1);
    mgr.detach();
  });
});

// ---------------------------------------------------------------------------
// .console dot-command
// ---------------------------------------------------------------------------

describe('.console command', () => {
  beforeEach(() => {
    Logger.clearSinks();
  });

  it('rejects REPL callers with a DCC-only error', async () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console +d', {
      source: 'repl',
      nick: 'REPL',
      channel: null,
      reply: (m) => replies.push(m),
    });

    expect(replies.some((r) => r.includes('DCC-only'))).toBe(true);
  });

  it('prints current flags when called with no args', async () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console', {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      dccSession: session,
      reply: (m) => replies.push(m),
    });

    expect(replies[0]).toContain('+mojw');
  });

  it('applies a mutation and persists via setConsoleFlags', async () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console +d', {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      dccSession: session,
      reply: (m) => replies.push(m),
    });

    // setConsoleFlags stores alphabetically on the fake session; the
    // command uses canonical letter order instead. Just check membership.
    expect(session.getConsoleFlags()).toContain('d');
    expect(session.getConsoleFlags()).toContain('m');
    expect(replies.some((r) => r.includes('d'))).toBe(true);
  });

  it('rejects unknown flag letters', async () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console +z', {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      dccSession: session,
      reply: (m) => replies.push(m),
    });

    expect(replies.some((r) => r.toLowerCase().includes('unknown'))).toBe(true);
  });

  it('allows an owner to set flags for another handle via the store', async () => {
    const store = createInMemoryConsoleFlagStore();
    const sessions = new Map<string, DCCSessionEntry>();
    const owner = fakeSession('admin', 'mojw', 'nm');
    sessions.set('admin', owner);
    const mgr = makeManager(sessions, store);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console bob +b', {
      source: 'dcc',
      nick: 'admin',
      channel: null,
      dccSession: owner,
      reply: (m) => replies.push(m),
    });

    expect(store.get('bob')).toContain('b');
  });

  it('rejects cross-handle edits when mutation tokens are missing', async () => {
    const store = createInMemoryConsoleFlagStore();
    const sessions = new Map<string, DCCSessionEntry>();
    const owner = fakeSession('admin', 'mojw', 'nm');
    sessions.set('admin', owner);
    const mgr = makeManager(sessions, store);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console bob', {
      source: 'dcc',
      nick: 'admin',
      channel: null,
      dccSession: owner,
      reply: (m) => replies.push(m),
    });

    expect(replies.some((r) => r.toLowerCase().includes('usage'))).toBe(true);
  });

  it('rejects unknown flag letters when targeting another handle', async () => {
    const store = createInMemoryConsoleFlagStore();
    const sessions = new Map<string, DCCSessionEntry>();
    const owner = fakeSession('admin', 'mojw', 'nm');
    sessions.set('admin', owner);
    const mgr = makeManager(sessions, store);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console bob +z', {
      source: 'dcc',
      nick: 'admin',
      channel: null,
      dccSession: owner,
      reply: (m) => replies.push(m),
    });

    expect(replies.some((r) => r.toLowerCase().includes('unknown'))).toBe(true);
    expect(store.get('bob')).toBeNull();
  });

  it('supports the -all sugar to clear every flag', async () => {
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console -all', {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      dccSession: session,
      reply: (m) => replies.push(m),
    });

    expect(session.getConsoleFlags()).toBe('');
    expect(replies.some((r) => r.includes('+-'))).toBe(true);
  });

  it('rejects cross-handle edits from non-owner callers', async () => {
    const store = createInMemoryConsoleFlagStore();
    const sessions = new Map<string, DCCSessionEntry>();
    const master = fakeSession('master', 'mojw', 'm'); // master flag only, no n
    sessions.set('master', master);
    const mgr = makeManager(sessions, store);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, null);

    const replies: string[] = [];
    await handler.execute('.console bob +b', {
      source: 'dcc',
      nick: 'master',
      channel: null,
      dccSession: master,
      reply: (m) => replies.push(m),
    });

    expect(replies.some((r) => r.toLowerCase().includes('owner'))).toBe(true);
    expect(store.get('bob')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Phase 4 — audit coverage for .console flag mutations
  // -------------------------------------------------------------------------

  it('writes a console-set audit row for own-flag mutation', async () => {
    const db = new BotDatabase(':memory:');
    db.open();
    const sessions = new Map<string, DCCSessionEntry>();
    const session = fakeSession('alice', 'mojw');
    sessions.set('alice', session);
    const mgr = makeManager(sessions);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, db);

    await handler.execute('.console +d', {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      dccSession: session,
      reply: () => {},
    });

    const [row] = db.getModLog({ action: 'console-set' });
    expect(row).toBeDefined();
    expect(row.target).toBe('alice');
    expect(row.source).toBe('dcc');
    expect(row.metadata).toBeDefined();
    db.close();
  });

  it('writes a console-set audit row for cross-handle mutation', async () => {
    const db = new BotDatabase(':memory:');
    db.open();
    const store = createInMemoryConsoleFlagStore();
    const sessions = new Map<string, DCCSessionEntry>();
    const owner = fakeSession('admin', 'mojw', 'nm');
    sessions.set('admin', owner);
    const mgr = makeManager(sessions, store);
    const handler = new CommandHandler(allowAll);
    registerDccConsoleCommands(handler, mgr, db);

    await handler.execute('.console bob +b', {
      source: 'dcc',
      nick: 'admin',
      channel: null,
      dccSession: owner,
      reply: () => {},
    });

    const [row] = db.getModLog({ action: 'console-set' });
    expect(row).toBeDefined();
    expect(row.target).toBe('bob');
    expect(row.by).toBe('admin');
    db.close();
  });
});
