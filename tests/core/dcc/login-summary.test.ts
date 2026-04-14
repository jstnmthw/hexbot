// Tests for the DCC login-summary helpers. Uses a real BotDatabase on a
// `:memory:` SQLite so the queries exercise the same index paths the
// production helper will use in the banner.
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildLoginSummary,
  buildReplStartupLine,
  buildReplStartupSummary,
} from '../../../src/core/dcc/login-summary';
import { BotDatabase } from '../../../src/database';

const BOOT_TS = 1_700_000_000; // arbitrary unix seconds
const HANDLE = 'alice';

function openDb(): BotDatabase {
  const db = new BotDatabase(':memory:');
  db.open();
  return db;
}

/**
 * Insert a mod_log row with a backdated `timestamp`. The default DB
 * writer stamps `unixepoch()` at insert time, so tests that care about
 * ordering across a window have to poke the row via the raw handle.
 */
function insertBackdated(
  db: BotDatabase,
  row: {
    action: string;
    source: string;
    by?: string;
    target?: string;
    outcome: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  },
): number {
  const handle = db.rawHandleForTests();
  const stmt = handle.prepare(
    `INSERT INTO mod_log (timestamp, action, source, by_user, target, outcome, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    row.timestamp,
    row.action,
    row.source,
    row.by ?? null,
    row.target ?? null,
    row.outcome,
    row.metadata ? JSON.stringify(row.metadata) : null,
  );
  return Number(info.lastInsertRowid);
}

describe('buildLoginSummary', () => {
  let db: BotDatabase;

  beforeEach(() => {
    db = openDb();
  });

  it('returns an empty summary with the boot fallback when mod_log is empty', () => {
    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, null);
    expect(summary).toEqual({
      failedSince: 0,
      mostRecent: null,
      lockoutsSince: 0,
      prevLoginTs: null,
      usedBootFallback: true,
    });
    db.close();
  });

  it('counts failures and lockouts in the window since the previous login', () => {
    // Prior login at T0 (well before the current window)
    insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 100,
    });
    // Three failures between the prior login and now, one lockout
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 200,
      metadata: { peer: 'evil!eve@host:1001' },
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 210,
      metadata: { peer: 'evil!eve@host:1002' },
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 220,
      metadata: { peer: 'evil!eve@host:1003' },
    });
    insertBackdated(db, {
      action: 'auth-lockout',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 221,
    });
    // The login row we "just wrote" — must not appear as "previous login".
    const justWritten = insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 300,
    });

    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, justWritten);
    expect(summary.failedSince).toBe(3);
    expect(summary.lockoutsSince).toBe(1);
    expect(summary.usedBootFallback).toBe(false);
    expect(summary.prevLoginTs).toBe(BOOT_TS + 100);
    expect(summary.mostRecent).toEqual({
      timestamp: BOOT_TS + 220,
      peer: 'evil!eve@host:1003',
    });
    db.close();
  });

  it('excludes failures that predate the previous login', () => {
    // Ancient failures from before T0
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 50,
      metadata: { peer: 'old!foe@host' },
    });
    // Previous login at T0 — anchor
    insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 100,
    });
    const justWritten = insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 200,
    });

    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, justWritten);
    expect(summary.failedSince).toBe(0);
    expect(summary.mostRecent).toBeNull();
    expect(summary.prevLoginTs).toBe(BOOT_TS + 100);
    db.close();
  });

  it('excludes failures against a different handle', () => {
    insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 100,
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'bob',
      outcome: 'failure',
      timestamp: BOOT_TS + 150,
      metadata: { peer: 'x!y@z' },
    });
    const justWritten = insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 200,
    });

    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, justWritten);
    expect(summary.failedSince).toBe(0);
    db.close();
  });

  it('falls back to bootTs when mod_log has no prior login row', () => {
    // Only failures exist — e.g. a retention-swept history
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: HANDLE,
      outcome: 'failure',
      timestamp: BOOT_TS + 50,
      metadata: { peer: 'only!one@host' },
    });
    const justWritten = insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 100,
    });

    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, justWritten);
    expect(summary.usedBootFallback).toBe(true);
    expect(summary.prevLoginTs).toBeNull();
    expect(summary.failedSince).toBe(1);
    expect(summary.mostRecent?.peer).toBe('only!one@host');
    db.close();
  });

  it('uses beforeId to exclude the just-written login row from the prev lookup', () => {
    // Single login row — without the beforeId cursor this would be
    // returned as "previous login" even though it's the one we just wrote.
    const justWritten = insertBackdated(db, {
      action: 'login',
      source: 'dcc',
      by: HANDLE,
      target: HANDLE,
      outcome: 'success',
      timestamp: BOOT_TS + 500,
    });

    const summary = buildLoginSummary(db, HANDLE, BOOT_TS, justWritten);
    expect(summary.prevLoginTs).toBeNull();
    expect(summary.usedBootFallback).toBe(true);
    db.close();
  });
});

describe('buildReplStartupSummary', () => {
  let db: BotDatabase;

  beforeEach(() => {
    db = openDb();
  });

  it('reports zeros when nothing happened since boot', () => {
    const summary = buildReplStartupSummary(db, BOOT_TS);
    expect(summary.failures).toBe(0);
    expect(summary.lockouts).toBe(0);
    expect(summary.handles.size).toBe(0);
    db.close();
  });

  it('aggregates failures and lockouts across every handle since boot', () => {
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'alice',
      outcome: 'failure',
      timestamp: BOOT_TS + 10,
      metadata: { peer: 'x' },
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'bob',
      outcome: 'failure',
      timestamp: BOOT_TS + 20,
      metadata: { peer: 'y' },
    });
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'alice',
      outcome: 'failure',
      timestamp: BOOT_TS + 30,
      metadata: { peer: 'z' },
    });
    insertBackdated(db, {
      action: 'auth-lockout',
      source: 'dcc',
      target: 'alice',
      outcome: 'failure',
      timestamp: BOOT_TS + 31,
    });

    const summary = buildReplStartupSummary(db, BOOT_TS);
    expect(summary.failures).toBe(3);
    expect(summary.lockouts).toBe(1);
    expect(new Set(summary.handles)).toEqual(new Set(['alice', 'bob']));
    db.close();
  });

  it('ignores failures that happened before boot', () => {
    insertBackdated(db, {
      action: 'auth-fail',
      source: 'dcc',
      target: 'alice',
      outcome: 'failure',
      timestamp: BOOT_TS - 100,
      metadata: { peer: 'old' },
    });
    const summary = buildReplStartupSummary(db, BOOT_TS);
    expect(summary.failures).toBe(0);
    db.close();
  });
});

describe('buildReplStartupLine', () => {
  it('returns null for an empty summary', () => {
    expect(buildReplStartupLine({ failures: 0, lockouts: 0, handles: new Set() })).toBeNull();
  });

  it('renders failure count without a lockout tail when lockouts=0', () => {
    const line = buildReplStartupLine({
      failures: 3,
      lockouts: 0,
      handles: new Set(['alice', 'bob']),
    });
    expect(line).toBe('⚠ 3 DCC auth failure(s) across 2 handle(s) since bot start');
  });

  it('appends the lockout count when lockouts > 0', () => {
    const line = buildReplStartupLine({
      failures: 5,
      lockouts: 2,
      handles: new Set(['alice']),
    });
    expect(line).toBe('⚠ 5 DCC auth failure(s) across 1 handle(s) since bot start — 2 lockout(s)');
  });
});
