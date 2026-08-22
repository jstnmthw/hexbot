// Tests for the BotREPL startup login-summary hook. The full readline
// lifecycle is heavy to stand up in a unit test — we construct the REPL
// without calling `start()`, which leaves `rl` null so `print()` falls
// through to `console.log`. The test only cares about the summary text,
// not the readline plumbing above it.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDatabase } from '../src/database';
import { BotREPL } from '../src/repl';

const BOOT_TS_SECONDS = 1_700_000_000;
const BOOT_TS_MS = BOOT_TS_SECONDS * 1000;

/** Insert a backdated mod_log row so the startup window sees it. */
function insertBackdated(
  db: BotDatabase,
  row: {
    action: string;
    source: string;
    target: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const handle = db.rawHandleForTests();
  handle
    .prepare(
      `INSERT INTO mod_log (timestamp, action, source, target, outcome, metadata)
       VALUES (?, ?, ?, ?, 'failure', ?)`,
    )
    .run(
      row.timestamp,
      row.action,
      row.source,
      row.target,
      row.metadata ? JSON.stringify(row.metadata) : null,
    );
}

function buildRepl(db: BotDatabase): BotREPL {
  const fakeBot = {
    db,
    startedAt: BOOT_TS_MS,
  } as unknown as ConstructorParameters<typeof BotREPL>[0];
  return new BotREPL(fakeBot);
}

describe('BotREPL.stop listener cleanup', () => {
  let db: BotDatabase;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it('removes every process-level and IRC listener it added', async () => {
    // stop() → rl.close() runs the REPL close handler, which calls
    // bot.shutdown() and then process.exit(0) — stub both.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const client = new EventEmitter();
    const fakeBot = {
      db,
      startedAt: BOOT_TS_MS,
      client,
      shutdown: async () => {},
    } as unknown as ConstructorParameters<typeof BotREPL>[0];
    const repl = new BotREPL(fakeBot);

    const before = {
      stdout: process.stdout.listenerCount('error'),
      stdin: process.stdin.listenerCount('error'),
      exit: process.listenerCount('exit'),
      notice: client.listenerCount('notice'),
      privmsg: client.listenerCount('privmsg'),
    };

    repl.start();

    expect(process.stdout.listenerCount('error')).toBe(before.stdout + 1);
    // readline installs its own 'error' listener on the input stream, so
    // the post-start count is ours plus readline's — assert growth only.
    expect(process.stdin.listenerCount('error')).toBeGreaterThan(before.stdin);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);

    repl.stop();
    // The close handler exits via shutdown().catch().finally(process.exit) —
    // let that chain settle while the exit spy is still installed.
    await new Promise((resolve) => setImmediate(resolve));
    exitSpy.mockRestore();

    expect(process.stdout.listenerCount('error')).toBe(before.stdout);
    expect(process.stdin.listenerCount('error')).toBe(before.stdin);
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(client.listenerCount('notice')).toBe(before.notice);
    expect(client.listenerCount('privmsg')).toBe(before.privmsg);
  });

  it('stays idempotent — a second stop() does not remove listeners it no longer owns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const client = new EventEmitter();
    const fakeBot = {
      db,
      startedAt: BOOT_TS_MS,
      client,
      shutdown: async () => {},
    } as unknown as ConstructorParameters<typeof BotREPL>[0];

    // A foreign listener that stop() must never touch.
    const foreign = (): void => {};
    process.stdout.on('error', foreign);
    try {
      const repl = new BotREPL(fakeBot);
      const before = process.stdout.listenerCount('error');
      repl.start();
      repl.stop();
      repl.stop();
      expect(process.stdout.listenerCount('error')).toBe(before);
      expect(process.stdout.listeners('error')).toContain(foreign);
    } finally {
      process.stdout.removeListener('error', foreign);
      // Let the close handler's shutdown().finally(process.exit) chain
      // settle while the exit spy is still installed.
      await new Promise((resolve) => setImmediate(resolve));
      exitSpy.mockRestore();
    }
  });
});

describe('BotREPL.printStartupLoginSummary', () => {
  let db: BotDatabase;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it('prints the summary line when auth failures exist after boot', () => {
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'alice',
      timestamp: BOOT_TS_SECONDS + 10,
      metadata: { peer: 'x!y@z' },
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'bob',
      timestamp: BOOT_TS_SECONDS + 20,
      metadata: { peer: 'a!b@c' },
    });

    const repl = buildRepl(db);
    // Private method — direct cast access is fine in unit tests.
    (repl as unknown as { printStartupLoginSummary(): void }).printStartupLoginSummary();

    const lines = logSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    const warning = lines.find((l: string) => l.includes('DCC auth failure(s)'));
    expect(warning).toBeDefined();
    expect(warning).toContain('2 DCC auth failure(s)');
    expect(warning).toContain('2 handle(s)');
    expect(warning).toContain('since bot start');
  });

  it('prints nothing when there are zero auth failures', () => {
    const repl = buildRepl(db);
    (repl as unknown as { printStartupLoginSummary(): void }).printStartupLoginSummary();
    const warningCalls = logSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes('DCC auth failure'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('appends the lockout tail when lockout rows are present', () => {
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'alice',
      timestamp: BOOT_TS_SECONDS + 10,
    });
    insertBackdated(db, {
      action: 'auth-lockout',
      source: 'dcc',
      target: 'alice',
      timestamp: BOOT_TS_SECONDS + 11,
    });

    const repl = buildRepl(db);
    (repl as unknown as { printStartupLoginSummary(): void }).printStartupLoginSummary();

    const lines = logSpy.mock.calls.map((args: unknown[]) => String(args[0]));
    const warning = lines.find((l: string) => l.includes('DCC auth failure(s)'));
    expect(warning).toMatch(/1 lockout\(s\)/);
  });
});
