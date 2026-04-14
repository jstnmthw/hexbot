// HexBot — SQLite database wrapper
// Namespaced key-value store + mod_log for moderation action tracking.
import Database, { SqliteError } from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

import type { BotEventBus } from './event-bus';
import type { LoggerLike } from './logger';
import { sanitize } from './utils/sanitize';
import { stripFormatting } from './utils/strip-formatting';

/** Instance type of the runtime `SqliteError` class from better-sqlite3. */
type SqliteErrorInstance = InstanceType<typeof SqliteError>;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Thrown when SQLite returns SQLITE_BUSY/SQLITE_LOCKED after the pragma-
 * level busy_timeout (5s) has expired. Callers — typically command handlers
 * and audit paths — should degrade: reply to the user that the database is
 * busy and skip the mutation, keeping the rest of the bot alive. See
 * stability audit 2026-04-14.
 */
export class DatabaseBusyError extends Error {
  constructor(opName: string, cause: SqliteErrorInstance) {
    super(`database busy during ${opName}: ${cause.message}`);
    this.name = 'DatabaseBusyError';
    this.cause = cause;
  }
}

/**
 * Thrown when SQLite returns SQLITE_FULL (out of disk, or attempt to write
 * to a read-only DB). The database layer also flips an internal
 * `writesDisabled` flag so subsequent mutating calls short-circuit with a
 * clear error before SQLite itself has to re-fail them. See stability
 * audit 2026-04-14.
 */
export class DatabaseFullError extends Error {
  constructor(opName: string, cause: SqliteErrorInstance) {
    super(`database storage is full during ${opName}: ${cause.message}`);
    this.name = 'DatabaseFullError';
    this.cause = cause;
  }
}

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

/**
 * Strip IRC control codes and `\r\n\0` from a display-bound mod_log field
 * before persisting it. SQL itself is parameterized so injection is
 * impossible, but an operator console (DCC, REPL, tail plugin) will
 * render whatever bytes are in the row — a crafted nick that embeds
 * `\x03` or CRLF can still poison the viewer if we don't scrub on write.
 */
function scrubModLogField(value: string | null | undefined): string | null {
  if (value == null) return null;
  return stripFormatting(sanitize(value));
}

/**
 * Parse a mod_log `metadata` JSON blob, returning null on failure instead of
 * throwing. A single corrupted row (interrupted write, manual edit, bad
 * botlink relay) would otherwise poison every `.modlog` query that touches
 * it. See stability audit 2026-04-14.
 */
function parseMetadataSafe(
  raw: string | null,
  rowId: number,
  logger: LoggerLike | null,
): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger?.warn(
      `mod_log row ${rowId} has malformed metadata JSON; returning null (${(err as Error).message})`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Source category for a mod_log row — the transport or subsystem that caused
 * the action. `'unknown'` is reserved for historical rows migrated from the
 * pre-Phase-1 schema and must never appear on new writes.
 */
export type ModLogSource = 'repl' | 'irc' | 'dcc' | 'botlink' | 'plugin' | 'config' | 'system';

export type ModLogOutcome = 'success' | 'failure';

const WRITE_SOURCES: ReadonlySet<ModLogSource> = new Set([
  'repl',
  'irc',
  'dcc',
  'botlink',
  'plugin',
  'config',
  'system',
]);

function validateModActionOptions(
  source: ModLogSource,
  plugin: string | null | undefined,
  outcome: ModLogOutcome,
): void {
  if (!WRITE_SOURCES.has(source)) {
    throw new Error(`logModAction: invalid source "${source}"`);
  }
  if ((source === 'plugin') !== (plugin != null)) {
    throw new Error(
      `logModAction: plugin must be set iff source === 'plugin' (got source="${source}", plugin=${plugin == null ? 'null' : `"${plugin}"`})`,
    );
  }
  if (outcome !== 'success' && outcome !== 'failure') {
    throw new Error(`logModAction: invalid outcome "${outcome}"`);
  }
}

/** Options object accepted by {@link BotDatabase.logModAction}. */
export interface LogModActionOptions {
  /** Short action name — `kick`, `ban`, `chanset-set`, `auth-fail`, ... */
  action: string;
  /** Transport/subsystem the action was driven from. */
  source: ModLogSource;
  /** Actor handle (user handle or `'bot'`); null if not applicable. */
  by?: string | null;
  /**
   * Plugin name. Required iff `source === 'plugin'`; forbidden otherwise.
   * Enforced at write time so plugins cannot spoof `source` and core sites
   * cannot accidentally claim to be a plugin.
   */
  plugin?: string | null;
  channel?: string | null;
  target?: string | null;
  /** `'success'` (default) or `'failure'` for denials/rejections. */
  outcome?: ModLogOutcome;
  reason?: string | null;
  /** Structured payload — serialized to JSON on write. */
  metadata?: Record<string, unknown> | null;
}

export interface ModLogEntry {
  id: number;
  timestamp: number;
  action: string;
  /** `ModLogSource` on new rows; may be `'unknown'` for legacy rows. */
  source: string;
  by: string | null;
  plugin: string | null;
  channel: string | null;
  target: string | null;
  outcome: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ModLogFilter {
  action?: string;
  channel?: string;
  target?: string;
  source?: string;
  plugin?: string;
  outcome?: string;
  by?: string;
  /** Only rows with `timestamp >= sinceTimestamp` (unix seconds). */
  sinceTimestamp?: number;
  /** LIKE match against reason + metadata. */
  grep?: string;
  /**
   * Restrict to rows whose `channel` is in this set. Used by the `.modlog`
   * permission matrix so a master-flagged user can only see audit data for
   * channels they have `o` on. Empty array → no rows match. Undefined →
   * no restriction.
   */
  channelsIn?: ReadonlyArray<string>;
  /**
   * Cursor: only return rows with `id < beforeId`. Pairs with the descending
   * `id` ordering for O(log n) deep pagination through the `mod_log_ts` index
   * — no `OFFSET`, so adding new rows mid-browse never makes the cursor jump.
   */
  beforeId?: number;
  limit?: number;
}

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
  private readonly modLogEnabled: boolean;
  private readonly modLogRetentionDays: number;
  private eventBus: BotEventBus | null = null;
  /**
   * Flipped once SQLITE_FULL is observed on any write. While set, the
   * database degrades to read-only: all writes throw
   * {@link DatabaseFullError} immediately without re-hitting SQLite, and
   * read paths stay available so operators can still run diagnostic
   * commands. See stability audit 2026-04-14.
   */
  private writesDisabled = false;
  /**
   * Optional sink for audit writes that failed with a degradable error.
   * Wired by `Bot` so `.status` can show queued rows and an operator can
   * recover the log tail after the DB comes back.
   */
  private auditFallback: ((options: LogModActionOptions) => void) | null = null;

  // Prepared statements (initialized on open)
  private stmtGet!: Statement;
  private stmtSet!: Statement;
  private stmtDel!: Statement;
  private stmtList!: Statement;
  private stmtListPrefix!: Statement;
  private stmtLogMod!: Statement;

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
  }

  /**
   * Attach a fallback sink for audit writes that failed at the SQLite
   * layer (busy, full). Lets the bot spill the row somewhere durable
   * instead of dropping it entirely. See stability audit 2026-04-14.
   */
  setAuditFallback(sink: ((options: LogModActionOptions) => void) | null): void {
    this.auditFallback = sink;
  }

  /** True once SQLITE_FULL has been observed on any write. */
  get areWritesDisabled(): boolean {
    return this.writesDisabled;
  }

  /**
   * Wrap a DB operation so SqliteError codes are classified into the
   * three tiers the audit calls for: transient busy → throw
   * {@link DatabaseBusyError}; FULL → set read-only flag and throw
   * {@link DatabaseFullError}; IOERR/CORRUPT/NOTADB → log CRITICAL and
   * exit(2) so the supervisor restarts cleanly. The pragma-level
   * `busy_timeout = 5000` means transient contention only surfaces here
   * after 5s of SQLite-internal retry.
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
        this.logger?.error(
          `[database] FATAL ${opName}: ${err.code} — cannot continue, exiting with code 2 so the supervisor restarts us`,
          err,
        );
        process.exit(2);
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
   * @throws if the database has not been opened.
   */
  rawHandleForTests(): DatabaseType {
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
    // happened to touch the DB. See stability audit 2026-04-14.
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

    this.initModLogSchema(db);
    this.initModLogIndexes(db);
    this.pruneModLogIfConfigured(db);

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
    this.stmtLogMod = db.prepare(
      `INSERT INTO mod_log
         (action, source, by_user, plugin, channel, target, outcome, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.logger?.info('Opened:', this.path);
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
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
        // Escape LIKE wildcards in the prefix, then append %
        const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        return this.stmtListPrefix.all(namespace, `${escaped}%`) as Array<{
          key: string;
          value: string;
        }>;
      }
      return this.stmtList.all(namespace) as Array<{ key: string; value: string }>;
    });
  }

  // ---------------------------------------------------------------------------
  // Mod log
  // ---------------------------------------------------------------------------

  /**
   * Write a mod_log row. Options object — positional call sites from the
   * pre-Phase-1 signature no longer compile; every caller threads `source`
   * explicitly. When the db was opened with `modLogEnabled: false`, the
   * insert is skipped silently.
   */
  logModAction(options: LogModActionOptions): void {
    this.ensureOpen();
    if (!this.modLogEnabled) return;
    if (this.writesDisabled) {
      // Spill to the operator-visible fallback sink rather than dropping
      // the row silently. See stability audit 2026-04-14.
      this.auditFallback?.(options);
      return;
    }

    const {
      action,
      source,
      by = null,
      plugin = null,
      channel = null,
      target = null,
      outcome = 'success',
      reason = null,
      metadata = null,
    } = options;

    validateModActionOptions(source, plugin, outcome);

    // Scrub every display-bound text field on write. SQL injection is not
    // possible (parameters are bound), but a crafted nick that embeds
    // `\x03` / `\r\n` / IRC mirc colors can still poison an audit
    // viewer at read time if we don't strip here.
    const scrubbedBy = scrubModLogField(by);
    const scrubbedPlugin = scrubModLogField(plugin);
    const scrubbedChannel = scrubModLogField(channel);
    const scrubbedTarget = scrubModLogField(target);
    const scrubbedReason = scrubModLogField(reason);
    // Cap metadata at 8 KiB. Operators and plugin authors stuff debug
    // payloads into metadata; without a cap a single misbehaving
    // plugin can balloon the mod_log table. The truncated marker keeps
    // queries that scan for `truncated:true` discoverable.
    let metadataJson = metadata == null ? null : JSON.stringify(metadata);
    if (metadataJson != null && metadataJson.length > 8192) {
      metadataJson = JSON.stringify({
        truncated: true,
        original_bytes: metadataJson.length,
        head: metadataJson.slice(0, 1024),
      });
    }
    let result;
    try {
      result = this.runClassified('logModAction', () =>
        this.stmtLogMod.run(
          action,
          source,
          scrubbedBy,
          scrubbedPlugin,
          scrubbedChannel,
          scrubbedTarget,
          outcome,
          scrubbedReason,
          metadataJson,
        ),
      );
    } catch (err) {
      if (err instanceof DatabaseBusyError || err instanceof DatabaseFullError) {
        // Degrade: spill the row to the fallback sink and return
        // without emitting audit:log — the subscriber will see the
        // fallback row when the sink reports on .status.
        this.auditFallback?.(options);
        return;
      }
      throw err;
    }

    // Fire the audit:log event so subscribers (Phase 6 `.audit-tail`,
    // future audit-stream plugins) can react without polling the table.
    // The id/timestamp are reconstructed here rather than re-queried so the
    // hot path stays a single round-trip; timestamp matches what the row
    // ended up with because the DB default is `unixepoch()` at insert time.
    if (this.eventBus) {
      this.eventBus.emit('audit:log', {
        id: Number(result.lastInsertRowid),
        timestamp: Math.floor(Date.now() / 1000),
        action,
        source,
        by: scrubbedBy,
        plugin: scrubbedPlugin,
        channel: scrubbedChannel,
        target: scrubbedTarget,
        outcome,
        reason: scrubbedReason,
        metadata,
      });
    }
  }

  /** Query the mod log with optional filters. */
  getModLog(filter?: ModLogFilter): ModLogEntry[] {
    const db = this.ensureOpen();
    const built = this.buildModLogWhere(filter);
    if (built === null) return []; // empty channelsIn — short-circuit

    const limit = filter?.limit ? `LIMIT ?` : '';
    const params = [...built.params];
    if (filter?.limit) params.push(filter.limit);

    const sql = `
      SELECT id, timestamp, action, source, by_user AS "by", plugin, channel, target,
             outcome, reason, metadata
      FROM mod_log
      ${built.where}
      ORDER BY id DESC
      ${limit}
    `;
    const rows = db.prepare(sql).all(...params) as Array<
      Omit<ModLogEntry, 'metadata'> & {
        metadata: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      metadata: parseMetadataSafe(row.metadata, row.id, this.logger),
    }));
  }

  /**
   * Count rows matching a filter — used by the `.modlog` pager to snapshot
   * the total once on the first page so pagination labels stay stable as
   * new rows land mid-browse. Mirrors `getModLog`'s WHERE construction so
   * callers get a consistent count for any given filter.
   */
  countModLog(filter?: ModLogFilter): number {
    const db = this.ensureOpen();
    const built = this.buildModLogWhere(filter);
    if (built === null) return 0;
    const sql = `SELECT COUNT(*) AS n FROM mod_log ${built.where}`;
    const row = db.prepare(sql).get(...built.params) as { n: number };
    return row.n;
  }

  /** Fetch a single mod_log row by id, or null if missing. */
  getModLogById(id: number): ModLogEntry | null {
    const db = this.ensureOpen();
    const sql = `
      SELECT id, timestamp, action, source, by_user AS "by", plugin, channel, target,
             outcome, reason, metadata
      FROM mod_log
      WHERE id = ?
    `;
    const row = db.prepare(sql).get(id) as
      | (Omit<ModLogEntry, 'metadata'> & { metadata: string | null })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      metadata: parseMetadataSafe(row.metadata, row.id, this.logger),
    };
  }

  /**
   * Shared WHERE-clause builder for {@link getModLog} and {@link countModLog}.
   * Returns `null` when an empty `channelsIn` short-circuits the query —
   * caller skips the SQL entirely.
   */
  private buildModLogWhere(filter?: ModLogFilter): { where: string; params: unknown[] } | null {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.action) {
      conditions.push('action = ?');
      params.push(filter.action);
    }
    if (filter?.channel) {
      conditions.push('channel = ?');
      params.push(filter.channel);
    }
    if (filter?.target) {
      conditions.push('target = ?');
      params.push(filter.target);
    }
    if (filter?.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    if (filter?.plugin) {
      conditions.push('plugin = ?');
      params.push(filter.plugin);
    }
    if (filter?.outcome) {
      conditions.push('outcome = ?');
      params.push(filter.outcome);
    }
    if (filter?.by) {
      conditions.push('by_user = ?');
      params.push(filter.by);
    }
    if (filter?.sinceTimestamp != null) {
      conditions.push('timestamp >= ?');
      params.push(filter.sinceTimestamp);
    }
    if (filter?.grep) {
      const escaped = filter.grep.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const like = `%${escaped}%`;
      conditions.push("(reason LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (filter?.channelsIn !== undefined) {
      if (filter.channelsIn.length === 0) return null;
      const placeholders = filter.channelsIn.map(() => '?').join(', ');
      conditions.push(`channel IN (${placeholders})`);
      params.push(...filter.channelsIn);
    }
    if (filter?.beforeId != null) {
      conditions.push('id < ?');
      params.push(filter.beforeId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Create or migrate the `mod_log` table to the Phase 1 schema. If a pre-
   * Phase-1 `mod_log` exists (no `source` column), copy its rows into the
   * new shape in a transaction and drop the old table. Historical rows get
   * `source = 'unknown'`, `plugin = NULL`, `outcome = 'success'`.
   */
  private initModLogSchema(db: DatabaseType): void {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('mod_log')`).all() as Array<{
      name: string;
    }>;
    const hasTable = cols.length > 0;
    const hasSourceColumn = cols.some((c) => c.name === 'source');

    if (hasTable && hasSourceColumn) {
      return; // Already on the new schema.
    }

    if (hasTable && !hasSourceColumn) {
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE mod_log_new (
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
          INSERT INTO mod_log_new
            (id, timestamp, action, source, by_user, plugin, channel, target, outcome, reason, metadata)
          SELECT id, timestamp, action, 'unknown', by_user, NULL, channel, target, 'success', reason, NULL
          FROM mod_log;
          DROP TABLE mod_log;
          ALTER TABLE mod_log_new RENAME TO mod_log;
        `);
      });
      migrate();

      const { n } = db.prepare('SELECT COUNT(*) AS n FROM mod_log').get() as { n: number };
      this.logger?.info(`Migrated mod_log to Phase 1 schema: ${n} row(s) copied`);
      return;
    }

    // Fresh database — create the final shape directly.
    db.exec(`
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
  }

  private initModLogIndexes(db: DatabaseType): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS mod_log_ts         ON mod_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS mod_log_target     ON mod_log(target);
      CREATE INDEX IF NOT EXISTS mod_log_channel_ts ON mod_log(channel, timestamp DESC);
      CREATE INDEX IF NOT EXISTS mod_log_source     ON mod_log(source);
    `);
  }

  /**
   * Prune mod_log rows past the retention window. Runs in bounded
   * batches (`DELETE ... LIMIT 10000`) so an operator flipping
   * retention from infinite to 30 days after years of uptime does
   * not block `open()` for minutes on a single massive DELETE
   * holding the write lock. The first batch runs synchronously so
   * a small prune completes before open() returns; subsequent
   * batches are scheduled on setImmediate so the event loop can
   * handle other work (IRC registration, plugin loads). See
   * stability audit 2026-04-14.
   */
  private pruneModLogIfConfigured(db: DatabaseType): void {
    if (this.modLogRetentionDays <= 0) return;
    const cutoff = Math.floor(Date.now() / 1000) - this.modLogRetentionDays * 86400;
    const BATCH_SIZE = 10_000;
    // SQLite doesn't support LIMIT on DELETE unless compiled with
    // SQLITE_ENABLE_UPDATE_DELETE_LIMIT. better-sqlite3 ships that
    // option enabled; fall back to a sub-select if the prepared
    // statement throws.
    let totalPruned = 0;
    const pruneBatch = (): number => {
      try {
        const result = db
          .prepare(
            'DELETE FROM mod_log WHERE id IN (SELECT id FROM mod_log WHERE timestamp < ? ORDER BY id LIMIT ?)',
          )
          .run(cutoff, BATCH_SIZE);
        return Number(result.changes);
      } catch (err) {
        this.logger?.error('[database] mod_log prune batch failed:', err);
        return 0;
      }
    };

    const initial = pruneBatch();
    totalPruned += initial;
    if (initial < BATCH_SIZE) {
      if (totalPruned > 0) {
        this.logger?.info(
          `Pruned ${totalPruned} mod_log row(s) older than ${this.modLogRetentionDays} day(s)`,
        );
      }
      return;
    }

    // More work remains — schedule in the background so startup
    // doesn't block. Unref'd so pending batches don't keep the
    // process alive during shutdown.
    const scheduleNext = (): void => {
      const t = setImmediate(() => {
        const changes = pruneBatch();
        totalPruned += changes;
        if (changes >= BATCH_SIZE) {
          scheduleNext();
        } else {
          this.logger?.info(
            `Pruned ${totalPruned} mod_log row(s) older than ${this.modLogRetentionDays} day(s) (background)`,
          );
        }
      });
      // Node's setImmediate handle supports unref — don't keep the
      // process alive for the trailing prune work.
      if (typeof (t as { unref?: unknown }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
    };
    scheduleNext();
  }

  private ensureOpen(): DatabaseType {
    if (!this.db) {
      throw new Error('[database] Database is not open. Call open() first.');
    }
    return this.db;
  }
}
