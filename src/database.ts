// HexBot — SQLite database wrapper
// Namespaced key-value store; mod_log is owned by `core/mod-log.ts` and
// delegated to from here so the existing BotDatabase public API is preserved.
import Database, { SqliteError } from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

import {
  type LogModActionOptions,
  ModLog,
  type ModLogEntry,
  type ModLogFilter,
} from './core/mod-log';
import { DatabaseBusyError, DatabaseFatalError, DatabaseFullError } from './database-errors';
import type { BotEventBus } from './event-bus';
import type { LoggerLike } from './logger';
import { escapeLikePattern } from './utils/sql';

// Re-export the shared SQL helper through the database module so existing
// `import { escapeLikePattern } from '../database'` call sites keep
// compiling — utils/sql.ts is the canonical source.
export { escapeLikePattern } from './utils/sql';

/** Instance type of the runtime `SqliteError` class from better-sqlite3. */
type SqliteErrorInstance = InstanceType<typeof SqliteError>;

// Re-export error classes so existing `import { DatabaseBusyError } from
// '../database'` call sites keep compiling after the split.
export { DatabaseBusyError, DatabaseFatalError, DatabaseFullError } from './database-errors';

// Re-export mod_log types from their new home so existing
// `import { ModLogSource, ... } from '../database'` sites keep compiling.
export type {
  LogModActionOptions,
  ModLogEntry,
  ModLogFilter,
  ModLogOutcome,
  ModLogSource,
} from './core/mod-log';

// ---------------------------------------------------------------------------
// Error classification helpers (used by the KV paths in this module)
// ---------------------------------------------------------------------------

/** Return true if the error is a SqliteError with a BUSY/LOCKED code. */
function isSqliteBusy(err: unknown): err is SqliteErrorInstance {
  return err instanceof SqliteError && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED');
}

/** Return true if the error is a SqliteError with a FULL code. */
function isSqliteFull(err: unknown): err is SqliteErrorInstance {
  return err instanceof SqliteError && err.code === 'SQLITE_FULL';
}

/** Return true if the error is a SqliteError for IOERR/CORRUPT/NOTADB. */
function isSqliteFatal(err: unknown): err is SqliteErrorInstance {
  if (!(err instanceof SqliteError)) return false;
  const c = err.code;
  return (
    c === 'SQLITE_CORRUPT' ||
    c === 'SQLITE_NOTADB' ||
    (typeof c === 'string' && c.startsWith('SQLITE_IOERR'))
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BotDatabaseOptions {
  /**
   * Whether to write mod_log rows. Wired from `logging.mod_actions`. When
   * false, {@link BotDatabase.logModAction} returns without writing.
   */
  modLogEnabled?: boolean;
  /**
   * Retention window for mod_log rows, in days. 0/undefined = unlimited.
   * On open, rows older than the cutoff are deleted in a single DELETE.
   */
  modLogRetentionDays?: number;
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class BotDatabase {
  private db: DatabaseType | null = null;
  private readonly path: string;
  private logger: LoggerLike | null;
  private modLogEnabled: boolean;
  private modLogRetentionDays: number;
  private eventBus: BotEventBus | null = null;
  /** Owns mod_log persistence — created during `open()`. */
  private modLog: ModLog | null = null;
  /**
   * Flipped once SQLITE_FULL is observed on any write. While set, the
   * database degrades to read-only: all writes throw
   * {@link DatabaseFullError} immediately without re-hitting SQLite, and
   * read paths stay available so operators can still run diagnostic
   * commands.
   */
  private writesDisabled = false;
  /**
   * Flipped once SQLITE_CORRUPT / SQLITE_NOTADB / SQLITE_IOERR* surfaces.
   * Subsequent reads and writes throw {@link DatabaseFatalError} immediately;
   * the `onFatal` observer (registered by `Bot`) drives an orderly
   * `shutdown()` then `process.exit(2)` instead of bailing mid-tick.
   */
  private fatal = false;
  /**
   * Optional sink for audit writes that failed with a degradable error.
   * Wired by `Bot` so `.status` can show queued rows and an operator can
   * recover the log tail after the DB comes back.
   */
  private auditFallback: ((options: LogModActionOptions) => void) | null = null;
  /**
   * Fired once when the database transitions to fatal. Bot uses it to start
   * graceful shutdown — the listener must not throw and must be re-entrant
   * safe (we may emit it multiple times but the listener should no-op after
   * the first call).
   */
  private onFatal: (() => void) | null = null;

  // Prepared statements for the KV store (initialized on open)
  private stmtGet!: Statement;
  private stmtSet!: Statement;
  private stmtDel!: Statement;
  private stmtList!: Statement;
  private stmtListPrefix!: Statement;

  constructor(path: string, logger?: LoggerLike | null, options?: BotDatabaseOptions) {
    this.path = path;
    this.logger = logger?.child('database') ?? null;
    this.modLogEnabled = options?.modLogEnabled ?? true;
    this.modLogRetentionDays = options?.modLogRetentionDays ?? 0;
  }

  /**
   * Wire up an event bus so successful `mod_log` writes emit `audit:log`.
   * Set after construction (Bot wires it during startup) — the database
   * itself doesn't depend on the event bus to function.
   */
  setEventBus(eventBus: BotEventBus | null): void {
    this.eventBus = eventBus;
    this.modLog?.setEventBus(eventBus);
  }

  /**
   * Attach a fallback sink for audit writes that failed at the SQLite
   * layer (busy, full). Lets the bot spill the row somewhere durable
   * instead of dropping it entirely.
   */
  setAuditFallback(sink: ((options: LogModActionOptions) => void) | null): void {
    this.auditFallback = sink;
    this.modLog?.setAuditFallback(sink);
  }

  /** True once SQLITE_FULL has been observed on any write. */
  get areWritesDisabled(): boolean {
    return this.writesDisabled || (this.modLog?.areWritesDisabled ?? false);
  }

  /**
   * Register a one-shot observer fired when the database hits a fatal
   * condition (SQLITE_CORRUPT / NOTADB / IOERR*). `Bot` wires this so a
   * fatal DB error triggers `shutdown()` instead of the prior `process.exit(2)`
   * that bypassed every teardown step.
   */
  setOnFatal(cb: (() => void) | null): void {
    this.onFatal = cb;
    this.modLog?.setOnFatal(cb);
  }

  /** True once a fatal SQLite error has been observed. */
  get isFatal(): boolean {
    return this.fatal || (this.modLog?.isFatal ?? false);
  }

  /**
   * Wrap a DB operation so SqliteError codes are classified into the
   * three tiers the audit calls for: transient busy → throw
   * {@link DatabaseBusyError}; FULL → set read-only flag and throw
   * {@link DatabaseFullError}; IOERR/CORRUPT/NOTADB → set the fatal flag,
   * disable writes, fire `onFatal` to start graceful shutdown, and throw
   * {@link DatabaseFatalError}. The pragma-level `busy_timeout = 5000` means
   * transient contention only surfaces here after 5s of SQLite-internal retry.
   *
   * Fatal errors used to call `process.exit(2)` directly from this point —
   * which bypassed every teardown step (IRC QUIT, message-queue flush,
   * plugin teardown) and could leave the WAL inconsistent. The new flow
   * lets `Bot.shutdown()` drive the orderly exit while still terminating
   * the process with the same code 2 so supervisors restart us.
   */
  private runClassified<T>(opName: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (isSqliteBusy(err)) {
        this.logger?.warn(
          `[database] ${opName}: SQLite reported ${err.code} after the 5s busy_timeout — command will degrade`,
        );
        throw new DatabaseBusyError(opName, err);
      }
      if (isSqliteFull(err)) {
        // Don't log multiple times on every subsequent write — one
        // CRITICAL entry at the transition is enough. Flip the read-only
        // flag so subsequent writes short-circuit cleanly.
        if (!this.writesDisabled) {
          this.logger?.error(
            `[database] CRITICAL ${opName}: SQLITE_FULL — writes are now disabled until restart. Check disk space.`,
          );
        }
        this.writesDisabled = true;
        throw new DatabaseFullError(opName, err);
      }
      if (isSqliteFatal(err)) {
        if (!this.fatal) {
          this.logger?.error(
            `[database] FATAL ${opName}: ${err.code} — starting graceful shutdown so the supervisor restarts us`,
            err,
          );
        }
        this.fatal = true;
        this.writesDisabled = true;
        try {
          this.onFatal?.();
        } catch (cbErr) {
          this.logger?.error('[database] onFatal observer threw', cbErr);
        }
        throw new DatabaseFatalError(opName, err);
      }
      throw err;
    }
  }

  /**
   * Run `fn` inside a SQLite transaction. Used by callers that need
   * multi-statement atomicity (e.g. permissions full-namespace replace).
   * SQLite transactions don't nest, so don't call transactional methods
   * from inside `fn`.
   */
  transaction<T>(fn: () => T): T {
    const db = this.ensureOpen();
    return this.runClassified('transaction', () => db.transaction(fn)());
  }

  /**
   * Test-only escape hatch to the underlying `better-sqlite3` handle so
   * integration tests can inspect schema state (index creation checks)
   * or seed backdated rows for retention tests. Production code must
   * never call this — all runtime reads/writes go through the typed
   * methods on this class.
   *
   * Guarded at runtime by a `NODE_ENV === 'test'` / `VITEST === 'true'`
   * check so a production build cannot accidentally hand out the raw
   * SQLite handle even if somebody imports this method elsewhere. Vitest
   * sets both env vars automatically, so tests pass without changes.
   *
   * @throws if the database has not been opened or the current process is
   *         not running under a recognized test harness.
   */
  rawHandleForTests(): DatabaseType {
    if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
      throw new Error(
        'rawHandleForTests() is only callable under a test harness (NODE_ENV=test or VITEST=true)',
      );
    }
    if (!this.db) throw new Error('Database not open');
    return this.db;
  }

  /** Open the database connection and initialize schema. */
  open(): void {
    const db = new Database(this.path);
    this.db = db;

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');

    // Let SQLite retry internally for up to 5s when the database is
    // momentarily locked (e.g. a concurrent reader holds the WAL, or a
    // checkpoint is running). Without this, a transient lock surfaces
    // as a synchronous SQLITE_BUSY and aborts whichever handler
    // happened to touch the DB.
    db.pragma('busy_timeout = 5000');

    // KV store — unchanged by the Phase 1 rewrite
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT,
        updated   INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (namespace, key)
      );
    `);

    // Hand the raw handle to ModLog — it runs the mod_log migrations,
    // creates its indexes, and prunes according to retention.
    this.modLog = new ModLog(db, this.logger, {
      modLogEnabled: this.modLogEnabled,
      modLogRetentionDays: this.modLogRetentionDays,
    });
    // Mirror the writesDisabled flag: if ModLog observes SQLITE_FULL first,
    // the KV writes here should degrade just as aggressively.
    this.modLog.setOnWritesDisabled(() => {
      this.writesDisabled = true;
    });
    // Propagate any pre-open event bus / fallback sink wiring.
    if (this.eventBus) this.modLog.setEventBus(this.eventBus);
    if (this.auditFallback) this.modLog.setAuditFallback(this.auditFallback);

    // Prepare statements for the KV store
    this.stmtGet = db.prepare('SELECT value FROM kv WHERE namespace = ? AND key = ?');
    this.stmtSet = db.prepare(
      `INSERT INTO kv (namespace, key, value, updated)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated = excluded.updated`,
    );
    this.stmtDel = db.prepare('DELETE FROM kv WHERE namespace = ? AND key = ?');
    this.stmtList = db.prepare('SELECT key, value FROM kv WHERE namespace = ?');
    this.stmtListPrefix = db.prepare(
      "SELECT key, value FROM kv WHERE namespace = ? AND key LIKE ? ESCAPE '\\'",
    );

    this.logger?.info('Opened:', this.path);
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.modLog = null;
      this.logger?.info('Closed');
    }
  }

  // ---------------------------------------------------------------------------
  // KV store — all operations are namespace-scoped
  // ---------------------------------------------------------------------------

  /** Get a value by namespace and key. Returns the string value or null. */
  get(namespace: string, key: string): string | null {
    this.ensureOpen();
    return this.runClassified('get', () => {
      const row = this.stmtGet.get(namespace, key) as { value: string } | undefined;
      return row?.value ?? null;
    });
  }

  /**
   * Set a key in a namespace. Non-string values are JSON-stringified.
   *
   * @throws {@link DatabaseFullError} — cleanly when writes have been
   *   previously disabled by a SQLITE_FULL observation; callers should
   *   handle this and degrade gracefully.
   */
  set(namespace: string, key: string, value: unknown): void {
    this.ensureOpen();
    if (this.writesDisabled) {
      throw new DatabaseFullError('set', new SqliteError('writes disabled', 'SQLITE_FULL'));
    }
    const stored = typeof value === 'string' ? value : JSON.stringify(value);
    this.runClassified('set', () => this.stmtSet.run(namespace, key, stored));
  }

  /** Delete a key from a namespace. */
  del(namespace: string, key: string): void {
    this.ensureOpen();
    if (this.writesDisabled) {
      throw new DatabaseFullError('del', new SqliteError('writes disabled', 'SQLITE_FULL'));
    }
    this.runClassified('del', () => this.stmtDel.run(namespace, key));
  }

  /** List keys in a namespace, optionally filtered by key prefix. */
  list(namespace: string, prefix?: string): Array<{ key: string; value: string }> {
    this.ensureOpen();
    return this.runClassified('list', () => {
      if (prefix != null) {
        // Paired with the `ESCAPE '\'` clause in `stmtListPrefix`. See
        // `escapeLikePattern` for the escape order rationale.
        const escaped = escapeLikePattern(prefix);
        return this.stmtListPrefix.all(namespace, `${escaped}%`) as Array<{
          key: string;
          value: string;
        }>;
      }
      return this.stmtList.all(namespace) as Array<{ key: string; value: string }>;
    });
  }

  /**
   * Prune rows in `namespace` whose `updated` column is older than the
   * given number of days. Returns the number of rows deleted. Callers
   * are responsible for picking a sensible TTL — long-uptime invariants
   * vary by namespace (a `seen` row is happy to live a month; a
   * short-lived rate-limit counter wants days).
   *
   * Skipped silently when `writesDisabled` — a degraded database should
   * stay readable, not be re-pruned.
   */
  pruneOlderThan(namespace: string, days: number): number {
    this.ensureOpen();
    if (this.writesDisabled) return 0;
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
    return this.runClassified('pruneOlderThan', () => {
      const result = this.db!.prepare('DELETE FROM kv WHERE namespace = ? AND updated < ?').run(
        namespace,
        cutoff,
      );
      return Number(result.changes);
    });
  }

  /**
   * Run `VACUUM` to reclaim space after long retention prunes. Cheap on
   * an idle database; expensive while writes are landing because VACUUM
   * holds an exclusive lock for the duration. Bot wires this on a
   * once-per-month tick — outside the critical path.
   *
   * No-op when `writesDisabled` — VACUUM itself writes a new file.
   */
  vacuum(): void {
    this.ensureOpen();
    if (this.writesDisabled) return;
    this.runClassified('vacuum', () => this.db!.exec('VACUUM'));
  }

  // ---------------------------------------------------------------------------
  // Mod log — thin delegates to core/mod-log.ts
  // ---------------------------------------------------------------------------

  /**
   * Write a mod_log row. Options object — positional call sites from the
   * pre-Phase-1 signature no longer compile; every caller threads `source`
   * explicitly. When the db was opened with `modLogEnabled: false`, the
   * insert is skipped silently.
   *
   * Returns the `lastInsertRowid` of the written row so callers that need
   * to reference it later (e.g. cursor filter `beforeId`) can capture it,
   * or `null` when the write was skipped/degraded.
   */
  logModAction(options: LogModActionOptions): number | null {
    return this.ensureModLog().logModAction(options);
  }

  /** Query the mod log with optional filters. */
  getModLog(filter?: ModLogFilter): ModLogEntry[] {
    return this.ensureModLog().getModLog(filter);
  }

  /** Toggle persistence of `logModAction` writes at runtime — used by
   *  `core.logging.mod_actions` onChange. Past rows are not affected.
   *  Forwards to the underlying ModLog so its own check at write time
   *  reflects the new value (the BotDatabase mirror is kept in sync for
   *  any caller that reads `db.modLogEnabled` directly). */
  setModLogEnabled(enabled: boolean): void {
    this.modLogEnabled = enabled;
    this.modLog?.setModLogEnabled(enabled);
  }

  /** Update the retention window in days. `0` or unset means unlimited.
   *  Forwards to the underlying ModLog so the next `pruneOldModLogRows()`
   *  call uses the new window. */
  setModLogRetentionDays(days: number): void {
    this.modLogRetentionDays = days;
    this.modLog?.setModLogRetentionDays(days);
  }

  /**
   * Count rows matching a filter — used by the `.modlog` pager to snapshot
   * the total once on the first page so pagination labels stay stable as
   * new rows land mid-browse.
   */
  countModLog(filter?: ModLogFilter): number {
    return this.ensureModLog().countModLog(filter);
  }

  /** Fetch a single mod_log row by id, or null if missing. */
  getModLogById(id: number): ModLogEntry | null {
    return this.ensureModLog().getModLogById(id);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureOpen(): DatabaseType {
    if (!this.db) {
      throw new Error('[database] Database is not open. Call open() first.');
    }
    return this.db;
  }

  private ensureModLog(): ModLog {
    this.ensureOpen();
    if (!this.modLog) {
      throw new Error('[database] ModLog is not initialized. Call open() first.');
    }
    return this.modLog;
  }
}
