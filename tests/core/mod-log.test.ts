// Targeted coverage for src/core/mod-log.ts paths that the existing
// BotDatabase / .modlog command tests don't reach: the pre-Phase-1 schema
// migration (legacy rows mapped to source='unknown') and the
// retention-prune setImmediate batching loop.
import Database, {
  type Database as DatabaseType,
  SqliteError,
  type Statement,
} from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LogModActionOptions, ModLog } from '../../src/core/mod-log';
import { DatabaseBusyError, DatabaseFullError } from '../../src/database-errors';
import type { LoggerLike } from '../../src/logger';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordingLogger extends LoggerLike {
  debugCalls: unknown[][];
  infoCalls: unknown[][];
  warnCalls: unknown[][];
  errorCalls: unknown[][];
}

function makeLogger(): RecordingLogger {
  const debugCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];
  const logger: RecordingLogger = {
    debug: (...args: unknown[]) => {
      debugCalls.push(args);
    },
    info: (...args: unknown[]) => {
      infoCalls.push(args);
    },
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: (...args: unknown[]) => {
      errorCalls.push(args);
    },
    child: () => logger,
    setLevel: () => {},
    getLevel: () => 'info',
    debugCalls,
    infoCalls,
    warnCalls,
    errorCalls,
  };
  return logger;
}

/**
 * Create a raw better-sqlite3 handle holding the pre-Phase-1 mod_log shape.
 * No `source`/`plugin`/`outcome`/`metadata` columns — the schema BotDatabase
 * shipped with before the audit Phase 1 rewrite. The table is intentionally
 * empty so individual tests can seed exactly the rows they need.
 */
function makeLegacyDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mod_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER DEFAULT (unixepoch()),
      action    TEXT NOT NULL,
      channel   TEXT,
      target    TEXT,
      by_user   TEXT,
      reason    TEXT
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe('ModLog schema migration (pre-Phase-1 → Phase 1)', () => {
  it('copies legacy rows verbatim and stamps source="unknown"', () => {
    const raw = makeLegacyDb();
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('kick', '#old', 'spammer', 'oldadmin', 'flooding');
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('op', null, null, 'oldadmin', null);

    const logger = makeLogger();
    const modLog = new ModLog(raw, logger);
    const rows = modLog.getModLog();

    expect(rows).toHaveLength(2);
    // newest-first → the `op` row (id 2) leads
    const opRow = rows.find((r) => r.action === 'op')!;
    const kickRow = rows.find((r) => r.action === 'kick')!;

    // Legacy rows: source filled in with 'unknown', plugin defaulted to NULL,
    // outcome defaulted to 'success', metadata NULL — these are the
    // historical-row markers downstream filters look for.
    expect(kickRow.source).toBe('unknown');
    expect(kickRow.plugin).toBeNull();
    expect(kickRow.outcome).toBe('success');
    expect(kickRow.metadata).toBeNull();
    expect(kickRow.by).toBe('oldadmin');
    expect(kickRow.channel).toBe('#old');
    expect(kickRow.target).toBe('spammer');
    expect(kickRow.reason).toBe('flooding');

    expect(opRow.source).toBe('unknown');
    expect(opRow.channel).toBeNull();
    expect(opRow.target).toBeNull();
    expect(opRow.reason).toBeNull();

    raw.close();
  });

  it('preserves auto-increment ids across the migration', () => {
    // If the migration loses ids, audit-log cross-references and the .modlog
    // pager `beforeId` cursor break. The migration is a SELECT … with
    // explicit `id`, so the new rows must come back with the same ids.
    const raw = makeLegacyDb();
    const insert = raw.prepare(
      `INSERT INTO mod_log (action, channel, target, by_user, reason)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('a', null, null, null, null);
    insert.run('b', null, null, null, null);
    insert.run('c', null, null, null, null);
    // Force a non-contiguous id by deleting then re-inserting.
    raw.prepare('DELETE FROM mod_log WHERE action = ?').run('b');
    insert.run('d', null, null, null, null);

    const modLog = new ModLog(raw, null);
    const ids = modLog
      .getModLog()
      .map((r) => r.id)
      .sort((x, y) => x - y);
    // id 2 was deleted before the migration; the new row 'd' got id 4.
    expect(ids).toEqual([1, 3, 4]);

    raw.close();
  });

  it('logs the migrated row count via the logger', () => {
    const raw = makeLegacyDb();
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('kick', '#a', 'spammer', 'admin', null);
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('ban', '#b', 'troll', 'admin', null);

    const logger = makeLogger();
    new ModLog(raw, logger);

    const migrationLog = logger.infoCalls.find(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('Migrated mod_log to Phase 1 schema'),
    );
    expect(migrationLog).toBeDefined();
    expect(migrationLog?.[0]).toContain('2 row(s) copied');

    raw.close();
  });

  it('runs the migration inside a transaction (no half-migrated state)', () => {
    // Smoke check that after construction, the legacy table no longer
    // exists under the old shape — the rename to `mod_log` must have
    // happened atomically.
    const raw = makeLegacyDb();
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('kick', '#a', 'spammer', 'admin', null);

    new ModLog(raw, null);

    const cols = raw.prepare(`SELECT name FROM pragma_table_info('mod_log')`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('source');
    expect(names).toContain('plugin');
    expect(names).toContain('outcome');
    expect(names).toContain('metadata');

    // The temp `mod_log_new` shouldn't be sitting around either.
    const stale = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mod_log_new'`)
      .all();
    expect(stale).toHaveLength(0);

    raw.close();
  });

  it('is idempotent: opening an already-migrated db is a no-op', () => {
    const raw = makeLegacyDb();
    raw
      .prepare(
        `INSERT INTO mod_log (action, channel, target, by_user, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('kick', '#a', 'spammer', 'admin', null);

    // First pass — migrates legacy → Phase 1.
    new ModLog(raw, null);
    // Second pass on the same handle — should detect the new schema and
    // return early without re-running the migration.
    const logger = makeLogger();
    const modLog2 = new ModLog(raw, logger);
    expect(modLog2.getModLog()).toHaveLength(1);
    // No second "Migrated" log line on the no-op pass.
    expect(
      logger.infoCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('Migrated mod_log'),
      ),
    ).toBe(false);

    raw.close();
  });
});

// ---------------------------------------------------------------------------
// Retention pruning — setImmediate batching loop
// ---------------------------------------------------------------------------

describe('ModLog retention pruning', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
    vi.useRealTimers();
  });

  /**
   * Seed `count` mod_log rows backdated to `cutoffOffsetSec` seconds before
   * the current time. Bypasses the public API because we want explicit
   * control over the timestamp column. Done in a single transaction so a
   * 25k-row seed completes in milliseconds rather than minutes.
   */
  function seedBackdatedRows(modLog: ModLog, count: number, cutoffOffsetSec: number): void {
    const ts = Math.floor(Date.now() / 1000) - cutoffOffsetSec;
    const insert = raw.prepare(
      `INSERT INTO mod_log (timestamp, action, source, by_user, target, outcome)
       VALUES (?, 'old', 'irc', 'a', 'b', 'success')`,
    );
    const batch = raw.transaction(() => {
      for (let i = 0; i < count; i++) insert.run(ts);
    });
    batch();
    // Sanity: the seed should have landed without tripping the writes-disabled
    // flag or any other ModLog guard.
    expect(modLog.areWritesDisabled).toBe(false);
  }

  it('prunes nothing and logs nothing when no rows are old', () => {
    // Initialize with a 30-day window, then add rows that are well within it.
    const logger = makeLogger();
    const modLog = new ModLog(raw, logger, { modLogRetentionDays: 30 });
    // Insert via the public API — these rows are stamped with `unixepoch()`.
    for (let i = 0; i < 5; i++) {
      modLog.logModAction({ action: 'fresh', source: 'irc', by: 'a', target: `t${i}` });
    }
    // Re-trigger the prune; nothing should change and no log line should
    // be emitted (only the initial migration "Pruned 0" path is suppressed
    // by the `if (totalPruned > 0)` guard).
    modLog.pruneOldModLogRows();
    expect(modLog.getModLog()).toHaveLength(5);
    expect(
      logger.infoCalls.some((args) => typeof args[0] === 'string' && args[0].includes('Pruned')),
    ).toBe(false);
  });

  it('prunes synchronously and logs the count when batch fits in one DELETE', () => {
    // Bootstrap WITHOUT retention so the seed survives, then re-attach a
    // ModLog instance with a tighter window — the constructor's prune sweep
    // is what we're exercising.
    const bootstrap = new ModLog(raw, null);
    seedBackdatedRows(bootstrap, 50, 10 * 86400); // 10 days old
    // Add a row inside the window so we can prove the prune is selective.
    bootstrap.logModAction({ action: 'fresh', source: 'irc', by: 'a', target: 't' });

    const logger = makeLogger();
    const modLog = new ModLog(raw, logger, { modLogRetentionDays: 5 });
    const remaining = modLog.getModLog();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].action).toBe('fresh');

    const prunedLog = logger.infoCalls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('Pruned 50'),
    );
    expect(prunedLog).toBeDefined();
    expect(prunedLog?.[0]).toContain('older than 5 day(s)');
    // Synchronous path → no `(background)` suffix.
    expect(prunedLog?.[0]).not.toContain('(background)');
  });

  it('chains multi-batch prunes via setImmediate and logs the total when done', async () => {
    // The internal BATCH_SIZE is 10_000; seed > 2 batches so we exercise
    // the synchronous-first-batch + setImmediate-driven-tail loop. This is
    // the path where an operator flipping retention from infinite to
    // 30 days after years of uptime would otherwise hold the write lock
    // for minutes — see the comment on pruneModLogIfConfigured.
    const BATCH_SIZE = 10_000;
    const totalSeed = BATCH_SIZE * 2 + 250; // 20,250 rows
    const bootstrap = new ModLog(raw, null);
    seedBackdatedRows(bootstrap, totalSeed, 30 * 86400);

    // Fake setImmediate so we can assert each batch lands in lockstep
    // rather than racing the test runner.
    vi.useFakeTimers({ toFake: ['setImmediate'] });
    const logger = makeLogger();
    // Construction kicks off the prune; we keep the instance reachable so
    // GC doesn't release it mid-test, but only the logger is asserted on.
    const _modLog = new ModLog(raw, logger, { modLogRetentionDays: 7 });
    void _modLog;

    // First batch ran synchronously inside the constructor. Total rows
    // remaining should be totalSeed - BATCH_SIZE.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM mod_log').get() as { n: number }).n).toBe(
      totalSeed - BATCH_SIZE,
    );
    // No completion log yet — the setImmediate tail hasn't fired.
    expect(
      logger.infoCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('(background)'),
      ),
    ).toBe(false);

    // Run the queued setImmediate(s). Each tick prunes another BATCH_SIZE
    // (or the tail-end remainder) and may schedule the next.
    await vi.runAllTimersAsync();

    // All old rows gone, completion log emitted with the (background) marker
    // and the total count across every batch.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM mod_log').get() as { n: number }).n).toBe(0);
    const bgLog = logger.infoCalls.find(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('(background)') &&
        args[0].includes(`Pruned ${totalSeed}`),
    );
    expect(bgLog).toBeDefined();
    expect(bgLog?.[0]).toContain('older than 7 day(s)');
  });

  it('does not crash and logs each failed prune batch via the logger', () => {
    // Drop the table out from under the prune so the inner `.run()` throws.
    // The catch block should log and return 0 rather than propagating —
    // a transient prune failure must never abort `open()`.
    new ModLog(raw, null); // create the schema
    raw.exec('DROP TABLE mod_log');

    const logger = makeLogger();
    // Construct directly so we don't hit the missing-table during schema init.
    // We reset the schema first, then yank it before the prune sweep:
    raw.exec(`
      CREATE TABLE mod_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        action    TEXT    NOT NULL,
        source    TEXT    NOT NULL,
        by_user   TEXT,
        plugin    TEXT,
        channel   TEXT,
        target    TEXT,
        outcome   TEXT    NOT NULL DEFAULT 'success',
        reason    TEXT,
        metadata  TEXT
      );
    `);
    const modLog = new ModLog(raw, logger, { modLogRetentionDays: 1 });
    // Now break the table and trigger another prune. The synchronous batch
    // should swallow the error after logging it.
    raw.exec('DROP TABLE mod_log');
    expect(() => modLog.pruneOldModLogRows()).not.toThrow();
    expect(
      logger.errorCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('mod_log prune batch failed'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// logModAction — error tier handling and audit fallback
// ---------------------------------------------------------------------------
//
// Covers mod-log.ts lines 309-311 (fallback when writesDisabled is already
// set), lines 364-369 (catch around runClassified for busy/full degrade), and
// the mirror callback path that would otherwise leave the parent BotDatabase
// flag stale.

describe('ModLog.logModAction error handling', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  /** Replace the prepared INSERT so the next logModAction throws `err`. */
  function stubInsert(modLog: ModLog, err: Error): void {
    const internal = modLog as unknown as { stmtLogMod: Statement };
    internal.stmtLogMod = {
      run: () => {
        throw err;
      },
    } as unknown as Statement;
  }

  it('returns null and routes to auditFallback when SQLITE_FULL fires on insert', () => {
    // Path: runClassified throws DatabaseFullError → outer catch at line 365
    // calls auditFallback and returns null. Mirrors the BotDatabase behavior
    // so neither layer drops the audit row silently.
    const modLog = new ModLog(raw, null);
    const fallback = vi.fn<(opts: LogModActionOptions) => void>();
    modLog.setAuditFallback(fallback);

    stubInsert(modLog, new SqliteError('disk full', 'SQLITE_FULL'));

    const result = modLog.logModAction({
      action: 'kick',
      source: 'irc',
      by: 'a',
      target: 'b',
    });

    expect(result).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toMatchObject({ action: 'kick', source: 'irc' });
    expect(modLog.areWritesDisabled).toBe(true);
  });

  it('returns null and routes to auditFallback when SQLITE_BUSY fires on insert', () => {
    // Busy is degradable: the audit row spills to fallback and the bot
    // keeps running, in contrast to the FULL path which also flips the
    // global writesDisabled flag.
    const modLog = new ModLog(raw, null);
    const fallback = vi.fn<(opts: LogModActionOptions) => void>();
    modLog.setAuditFallback(fallback);

    stubInsert(modLog, new SqliteError('lock contention', 'SQLITE_BUSY'));

    const result = modLog.logModAction({
      action: 'ban',
      source: 'irc',
      by: 'a',
      target: 'b',
    });

    expect(result).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
    // BUSY is transient — writes should NOT be permanently disabled.
    expect(modLog.areWritesDisabled).toBe(false);
  });

  it('routes SQLITE_CORRUPT through the fatal tier — process.exit(2)', () => {
    // Mirrors the BotDatabase parallel: ModLog's runClassified at lines
    // 292-297 must hand off CORRUPT/NOTADB/IOERR to the supervisor rather
    // than swallow them as audit-fallback. We stub process.exit so the
    // test process survives.
    const logger = makeLogger();
    const modLog = new ModLog(raw, logger);
    const fallback = vi.fn<(opts: LogModActionOptions) => void>();
    modLog.setAuditFallback(fallback);

    stubInsert(modLog, new SqliteError('corrupted', 'SQLITE_CORRUPT'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
    try {
      expect(() =>
        modLog.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' }),
      ).toThrow('process.exit(2)');
      expect(exitSpy).toHaveBeenCalledWith(2);
      // Fatal tier never spills to fallback — the row goes nowhere because
      // the supervisor is about to restart us.
      expect(fallback).not.toHaveBeenCalled();
      expect(
        logger.errorCalls.some((args) => typeof args[0] === 'string' && args[0].includes('FATAL')),
      ).toBe(true);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('rethrows non-degradable errors instead of swallowing them', () => {
    // The catch at line 365 only consumes Busy/Full. A SQLITE_CORRUPT —
    // routed via runClassified to process.exit — still terminates. Any
    // other oddball error (e.g. a programmer bug) must propagate so it
    // surfaces in tests / supervisor logs rather than being silently
    // dropped on the audit floor.
    const modLog = new ModLog(raw, null);
    const fallback = vi.fn<(opts: LogModActionOptions) => void>();
    modLog.setAuditFallback(fallback);

    stubInsert(modLog, new TypeError('not a SqliteError at all'));

    expect(() =>
      modLog.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' }),
    ).toThrow(TypeError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the insert and routes to auditFallback when writes are already disabled', () => {
    // Path: line 309-311 — writesDisabled already true (e.g. an earlier
    // FULL on a sibling write). logModAction must NOT re-hit SQLite; it
    // should fall straight through to the fallback sink with the original
    // options object so the operator can replay it after recovery.
    const modLog = new ModLog(raw, null);
    const fallback = vi.fn<(opts: LogModActionOptions) => void>();
    modLog.setAuditFallback(fallback);

    // Force the flag without going through a real FULL.
    (modLog as unknown as { writesDisabled: boolean }).writesDisabled = true;

    // Tripwire: if the short-circuit fails, this would surface instead of
    // a clean fallback dispatch.
    stubInsert(modLog, new Error('short-circuit failed: SQLite was re-invoked'));

    const result = modLog.logModAction({
      action: 'kick',
      source: 'irc',
      by: 'a',
      target: 'b',
      reason: 'test',
    });

    expect(result).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toMatchObject({ action: 'kick', reason: 'test' });
  });

  it('returns null silently when writesDisabled is set and no fallback is wired', () => {
    // The fallback is optional. With it absent, the insert is still skipped
    // — there must be no thrown error and no row written.
    const modLog = new ModLog(raw, null);
    (modLog as unknown as { writesDisabled: boolean }).writesDisabled = true;
    expect(modLog.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' })).toBeNull();
    expect(modLog.getModLog()).toHaveLength(0);
  });

  it('fires the onWritesDisabled observer exactly once on the FULL transition', () => {
    // BotDatabase relies on this callback to mirror the read-only state.
    // It should be called when the flag flips, not on every subsequent
    // failed write.
    const modLog = new ModLog(raw, null);
    const observer = vi.fn();
    modLog.setOnWritesDisabled(observer);

    stubInsert(modLog, new SqliteError('disk full', 'SQLITE_FULL'));

    modLog.logModAction({ action: 'a', source: 'irc', by: 'x', target: 't' });
    expect(observer).toHaveBeenCalledTimes(1);

    // A second attempt short-circuits at line 309 BEFORE runClassified is
    // re-entered, so the observer must not fire again.
    modLog.logModAction({ action: 'b', source: 'irc', by: 'x', target: 't' });
    expect(observer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// logModAction — metadata size cap (mod-log.ts:343)
// ---------------------------------------------------------------------------

describe('ModLog.logModAction metadata cap', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  it('preserves metadata under the 8 KiB cap verbatim', () => {
    const modLog = new ModLog(raw, null);
    const small = { note: 'x'.repeat(100), n: 1 };
    modLog.logModAction({
      action: 'a',
      source: 'irc',
      by: 'u',
      target: 't',
      metadata: small,
    });
    const [row] = modLog.getModLog();
    expect(row.metadata).toEqual(small);
  });

  it('truncates metadata over 8 KiB and stamps the marker shape', () => {
    // The truncation marker shape — { truncated: true, original_bytes, head }
    // is part of the audit contract: operators grep for `truncated:true`
    // and the head field gives them the first 1 KiB to triage from. Drift
    // here would silently break those review tools.
    const modLog = new ModLog(raw, null);
    const huge = { blob: 'A'.repeat(20_000) };
    const originalJsonLength = JSON.stringify(huge).length;
    expect(originalJsonLength).toBeGreaterThan(8192);

    modLog.logModAction({
      action: 'oversize',
      source: 'irc',
      by: 'u',
      target: 't',
      metadata: huge,
    });

    const [row] = modLog.getModLog();
    expect(row.metadata).not.toBeNull();
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.truncated).toBe(true);
    expect(meta.original_bytes).toBe(originalJsonLength);
    expect(typeof meta.head).toBe('string');
    expect((meta.head as string).length).toBe(1024);
    // The truncated payload itself must be small enough that a viewer can
    // render it; sanity-check that it fits in well under 4 KiB.
    const storedRaw = raw.prepare('SELECT metadata FROM mod_log WHERE id = ?').get(row.id) as {
      metadata: string;
    };
    expect(storedRaw.metadata.length).toBeLessThan(4096);
  });
});

// ---------------------------------------------------------------------------
// Read-side: filter coverage for buildModLogWhere branches not exercised
// elsewhere (channelsIn empty short-circuit, beforeId cursor, grep, multi-AND)
// ---------------------------------------------------------------------------

describe('ModLog read-side filter branches', () => {
  let raw: DatabaseType;
  let modLog: ModLog;

  beforeEach(() => {
    raw = new Database(':memory:');
    modLog = new ModLog(raw, null);
    modLog.logModAction({
      action: 'kick',
      source: 'irc',
      by: 'admin',
      channel: '#a',
      target: 'u1',
      reason: 'spam',
    });
    modLog.logModAction({
      action: 'ban',
      source: 'irc',
      by: 'admin',
      channel: '#b',
      target: 'u2',
      reason: 'flood',
    });
    modLog.logModAction({
      action: 'kick',
      source: 'plugin',
      plugin: 'flood',
      channel: '#c',
      target: 'u3',
      reason: 'rate',
    });
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  it('channelsIn=[] short-circuits getModLog to an empty result without running SQL', () => {
    // Permission-matrix path: a master user with `o` on no channels gets
    // no rows. The implementation returns null from buildModLogWhere and
    // skips the query entirely — verified by the empty result.
    expect(modLog.getModLog({ channelsIn: [] })).toEqual([]);
  });

  it('channelsIn=[] short-circuits countModLog to 0', () => {
    expect(modLog.countModLog({ channelsIn: [] })).toBe(0);
  });

  it('channelsIn restricts to listed channels using SQL IN', () => {
    const rows = modLog.getModLog({ channelsIn: ['#a', '#c'] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['#a', '#c']);
  });

  it('beforeId acts as a strict-less-than cursor for descending pagination', () => {
    const all = modLog.getModLog();
    // Ask for rows strictly older than the newest one — should drop it.
    const older = modLog.getModLog({ beforeId: all[0].id });
    expect(older).toHaveLength(all.length - 1);
    expect(older.every((r) => r.id < all[0].id)).toBe(true);
  });

  it('grep escapes LIKE wildcards so a literal underscore does not match everything', () => {
    modLog.logModAction({
      action: 'note',
      source: 'irc',
      by: 'admin',
      target: 't',
      reason: 'a_b',
    });
    modLog.logModAction({
      action: 'note',
      source: 'irc',
      by: 'admin',
      target: 't',
      reason: 'aXb',
    });
    // Without escaping, `a_b` would match `aXb` too. With proper escaping,
    // only the literal `a_b` row matches.
    const rows = modLog.getModLog({ grep: 'a_b' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('a_b');
  });

  it('combines AND filters across action + channel + by', () => {
    const rows = modLog.getModLog({ action: 'kick', channel: '#a', by: 'admin' });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// Read-side: malformed metadata JSON is logged and returned as null
// (parseMetadataSafe — defensive against poisoned rows)
// ---------------------------------------------------------------------------

describe('ModLog malformed metadata handling', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  it('returns metadata=null and logs a warning when the JSON is corrupted', () => {
    // Stability audit 2026-04-14: a single bad row must not poison the
    // entire .modlog query.
    const modLog = new ModLog(raw, makeLogger());
    modLog.logModAction({
      action: 'a',
      source: 'irc',
      by: 'x',
      target: 't',
      metadata: { ok: true },
    });
    // Now manually corrupt the metadata column on the row we just wrote.
    raw.prepare("UPDATE mod_log SET metadata = '{not valid json' WHERE id = 1").run();

    const logger = makeLogger();
    const reader = new ModLog(raw, logger);
    const rows = reader.getModLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toBeNull();
    expect(
      logger.warnCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('malformed metadata'),
      ),
    ).toBe(true);
  });

  it('getModLogById also recovers from malformed metadata', () => {
    const modLog = new ModLog(raw, null);
    modLog.logModAction({
      action: 'a',
      source: 'irc',
      by: 'x',
      target: 't',
      metadata: { ok: true },
    });
    raw.prepare("UPDATE mod_log SET metadata = 'NOT JSON' WHERE id = 1").run();

    const row = modLog.getModLogById(1);
    expect(row).not.toBeNull();
    expect(row?.metadata).toBeNull();
  });

  it('getModLogById returns null when no row has that id', () => {
    const modLog = new ModLog(raw, null);
    expect(modLog.getModLogById(999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source/plugin invariants — both branches of the iff at line 104
// ---------------------------------------------------------------------------

describe('ModLog.logModAction source/plugin invariant', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  it("accepts source='plugin' with a plugin name", () => {
    const modLog = new ModLog(raw, null);
    expect(() =>
      modLog.logModAction({
        action: 'auto',
        source: 'plugin',
        plugin: 'flood',
        target: 'u',
      }),
    ).not.toThrow();
  });

  it("rejects source='plugin' without a plugin name", () => {
    const modLog = new ModLog(raw, null);
    expect(() =>
      modLog.logModAction({
        action: 'auto',
        source: 'plugin',
        target: 'u',
      }),
    ).toThrow(/plugin must be set iff source === 'plugin'/);
  });

  it("rejects a plugin name when source is not 'plugin'", () => {
    const modLog = new ModLog(raw, null);
    expect(() =>
      modLog.logModAction({
        action: 'auto',
        source: 'irc',
        plugin: 'flood',
        target: 'u',
      }),
    ).toThrow(/plugin must be set iff source === 'plugin'/);
  });

  it('rejects an invalid outcome string', () => {
    const modLog = new ModLog(raw, null);
    expect(() =>
      modLog.logModAction({
        action: 'a',
        source: 'irc',
        outcome: 'maybe' as never,
        target: 'u',
      }),
    ).toThrow(/invalid outcome/);
  });

  it('rejects an unknown source', () => {
    const modLog = new ModLog(raw, null);
    expect(() =>
      modLog.logModAction({
        action: 'a',
        source: 'wat' as never,
        target: 'u',
      }),
    ).toThrow(/invalid source/);
  });
});

// ---------------------------------------------------------------------------
// audit:log event emission on successful writes
// ---------------------------------------------------------------------------

describe('ModLog audit:log event bus emission', () => {
  let raw: DatabaseType;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed
    }
  });

  it('emits audit:log with the persisted row snapshot after a successful insert', () => {
    const modLog = new ModLog(raw, null);
    // Use a minimal stand-in for BotEventBus — we only assert the emit call.
    const calls: Array<[string, unknown]> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        calls.push([event, payload]);
        return true;
      },
    } as unknown as Parameters<typeof modLog.setEventBus>[0];
    modLog.setEventBus(bus);

    const id = modLog.logModAction({
      action: 'kick',
      source: 'irc',
      by: 'admin',
      channel: '#x',
      target: 'troll',
      reason: 'spamming',
      metadata: { score: 7 },
    });

    expect(id).not.toBeNull();
    const audit = calls.find(([e]) => e === 'audit:log');
    expect(audit).toBeDefined();
    const payload = audit![1] as Record<string, unknown>;
    expect(payload.id).toBe(id);
    expect(payload.action).toBe('kick');
    expect(payload.source).toBe('irc');
    expect(payload.by).toBe('admin');
    expect(payload.channel).toBe('#x');
    expect(payload.target).toBe('troll');
    expect(payload.reason).toBe('spamming');
    expect(payload.metadata).toEqual({ score: 7 });
  });

  it('does not emit audit:log when the write is suppressed by modLogEnabled=false', () => {
    const modLog = new ModLog(raw, null, { modLogEnabled: false });
    const calls: Array<[string, unknown]> = [];
    const bus = {
      emit: (event: string, payload: unknown) => {
        calls.push([event, payload]);
        return true;
      },
    } as unknown as Parameters<typeof modLog.setEventBus>[0];
    modLog.setEventBus(bus);

    expect(modLog.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('scrubs IRC control codes (CR/LF/color) from display fields before persisting', () => {
    // Audit-viewer hardening: a crafted nick with \x03 / CRLF must not
    // poison the operator's terminal when the row is rendered later.
    const modLog = new ModLog(raw, null);
    modLog.logModAction({
      action: 'kick',
      source: 'irc',
      by: 'evil\r\nnick\x03',
      channel: '#x',
      target: 'troll\x03,4',
      reason: 'reason\nwith\nnewlines',
    });
    const [row] = modLog.getModLog();
    expect(row.by).not.toContain('\r');
    expect(row.by).not.toContain('\n');
    expect(row.by).not.toContain('\x03');
    expect(row.target).not.toContain('\x03');
    expect(row.reason).not.toContain('\n');
  });
});

// Verify the unused-import linter doesn't object to the imports we only use
// for type narrowing.
void DatabaseBusyError;
void DatabaseFullError;
