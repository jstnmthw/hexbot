// HexBot — SQLite database wrapper
// Namespaced key-value store + mod_log for moderation action tracking.
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

import type { BotEventBus } from './event-bus';
import type { LoggerLike } from './logger';
import { sanitize } from './utils/sanitize';
import { stripFormatting } from './utils/strip-formatting';

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
    const row = this.stmtGet.get(namespace, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Set a key in a namespace. Non-string values are JSON-stringified. */
  set(namespace: string, key: string, value: unknown): void {
    this.ensureOpen();
    const stored = typeof value === 'string' ? value : JSON.stringify(value);
    this.stmtSet.run(namespace, key, stored);
  }

  /** Delete a key from a namespace. */
  del(namespace: string, key: string): void {
    this.ensureOpen();
    this.stmtDel.run(namespace, key);
  }

  /** List keys in a namespace, optionally filtered by key prefix. */
  list(namespace: string, prefix?: string): Array<{ key: string; value: string }> {
    this.ensureOpen();
    if (prefix != null) {
      // Escape LIKE wildcards in the prefix, then append %
      const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      return this.stmtListPrefix.all(namespace, `${escaped}%`) as Array<{
        key: string;
        value: string;
      }>;
    }
    return this.stmtList.all(namespace) as Array<{ key: string; value: string }>;
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
    const result = this.stmtLogMod.run(
      action,
      source,
      scrubbedBy,
      scrubbedPlugin,
      scrubbedChannel,
      scrubbedTarget,
      outcome,
      scrubbedReason,
      metadataJson,
    );

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
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
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
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
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

  private pruneModLogIfConfigured(db: DatabaseType): void {
    if (this.modLogRetentionDays <= 0) return;
    const cutoff = Math.floor(Date.now() / 1000) - this.modLogRetentionDays * 86400;
    const result = db.prepare('DELETE FROM mod_log WHERE timestamp < ?').run(cutoff);
    if (result.changes > 0) {
      this.logger?.info(
        `Pruned ${result.changes} mod_log row(s) older than ${this.modLogRetentionDays} day(s)`,
      );
    }
  }

  private ensureOpen(): DatabaseType {
    if (!this.db) {
      throw new Error('[database] Database is not open. Call open() first.');
    }
    return this.db;
  }
}
