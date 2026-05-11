// HexBot — Mod log persistence layer
// Extracted from src/database.ts to keep BotDatabase focused on the KV store.
// BotDatabase owns an instance of this class and delegates its mod_log public
// API to it; no caller needs to change because the BotDatabase signatures are
// preserved.
import { SqliteError } from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';

import { DatabaseBusyError, DatabaseFatalError, DatabaseFullError } from '../database-errors';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import { sanitize } from '../utils/sanitize';
import { escapeLikePattern } from '../utils/sql';
import { stripFormatting } from '../utils/strip-formatting';

/** Instance type of the runtime `SqliteError` class from better-sqlite3. */
type SqliteErrorInstance = InstanceType<typeof SqliteError>;

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
 * it.
 */
function parseMetadataSafe(
  raw: string | null,
  rowId: number,
  logger: LoggerLike | null,
): Record<string, unknown> | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger?.warn(
      `mod_log row ${rowId} has malformed metadata JSON; returning null (${(err as Error).message})`,
    );
    return null;
  }
  // `JSON.parse` happily returns scalars/arrays/`null` — none are valid
  // metadata payloads. Reject anything that isn't a plain object so a
  // corrupt row (or a downstream consumer that wrote `JSON.stringify(42)`
  // by mistake) doesn't poison every `.modlog` query that touches it.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger?.warn(`mod_log row ${rowId} metadata is not a plain object; returning null`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Match `LogModActionOptions.action`. Documented vocabulary is short
 * lower-kebab tokens (`kick`, `ban`, `chanset-set`, `auth-fail`, ...);
 * limit to that shape so a typo at a call site (`'KICK'`, `'kick:bad'`)
 * fails fast instead of producing rows that never match `.modlog action`
 * filters.
 */
const VALID_ACTION_RE = /^[a-z][a-z0-9-]{0,63}$/;

function validateAction(action: string): void {
  if (!VALID_ACTION_RE.test(action)) {
    throw new Error(
      `logModAction: invalid action "${action}" — must match ${VALID_ACTION_RE.source}`,
    );
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

/**
 * The set of sources accepted on `logModAction` writes. Mirrors
 * {@link ModLogSource} minus `'unknown'` — that label is reserved for
 * historical rows migrated from the pre-Phase-1 schema and must never
 * appear on a new write. Validated explicitly so a typo at a call site
 * surfaces as a thrown error rather than a silent invalid row.
 */
const WRITE_SOURCES: ReadonlySet<ModLogSource> = new Set([
  'repl',
  'irc',
  'dcc',
  'botlink',
  'plugin',
  'config',
  'system',
]);

/**
 * Validate the discriminator fields on a {@link LogModActionOptions} payload
 * before insert. Enforces three invariants used by audit review:
 *
 *   1. `source` is one of the seven write-time labels.
 *   2. `plugin` is set iff `source === 'plugin'` — so plugins can't pose as
 *      `'system'` and core sites can't claim to be plugins.
 *   3. `outcome` is one of the two well-defined labels (no rogue values).
 *
 * Throws on any violation rather than logging-and-continuing — a silent
 * bypass would corrupt the audit trail's discriminator semantics.
 */
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

/** Options object accepted by {@link ModLog.logModAction}. */
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

export interface ModLogOptions {
  /**
   * Whether to write mod_log rows. Wired from `logging.mod_actions`. When
   * false, {@link ModLog.logModAction} returns without writing.
   */
  modLogEnabled?: boolean;
  /**
   * Retention window for mod_log rows, in days. 0/undefined = unlimited.
   * On open, rows older than the cutoff are deleted in a single DELETE.
   */
  modLogRetentionDays?: number;
}

// ---------------------------------------------------------------------------
// ModLog class
// ---------------------------------------------------------------------------

/**
 * Owns all mod_log persistence: schema migration, indexes, retention prune,
 * and the read/write/query surface. BotDatabase instantiates this in its
 * constructor so the migration runs during `open()`; public methods on
 * BotDatabase delegate here to preserve the existing API.
 */
export class ModLog {
  private readonly db: DatabaseType;
  private readonly logger: LoggerLike | null;
  // Mutable so the BotDatabase forwarders for `core.logging.mod_actions`
  // and `core.logging.mod_log_retention_days` can flip them at runtime.
  // Initial value seeded from constructor options; thereafter the setters
  // own the field.
  private modLogEnabled: boolean;
  private modLogRetentionDays: number;
  private eventBus: BotEventBus | null = null;
  /**
   * Flipped once SQLITE_FULL is observed on any write. While set, writes
   * throw {@link DatabaseFullError} immediately without re-hitting SQLite.
   * BotDatabase consults the same flag on its own writes — they share state
   * via a setter call from the parent on transition.
   */
  private writesDisabled = false;
  /** External observer hook — BotDatabase uses this to mirror the flag. */
  private onWritesDisabled: (() => void) | null = null;
  /**
   * Flipped once SQLITE_CORRUPT / SQLITE_NOTADB / SQLITE_IOERR* surfaces.
   * Mirrors {@link BotDatabase.fatal} so the audit log path degrades the
   * same way the KV path does.
   */
  private fatal = false;
  /** External observer fired when writes become fatally unavailable. */
  private onFatal: (() => void) | null = null;
  /** Optional sink for audit writes that failed with a degradable error. */
  private auditFallback: ((options: LogModActionOptions) => void) | null = null;

  private stmtLogMod!: Statement;

  constructor(db: DatabaseType, logger: LoggerLike | null, options?: ModLogOptions) {
    this.db = db;
    this.logger = logger;
    this.modLogEnabled = options?.modLogEnabled ?? true;
    this.modLogRetentionDays = options?.modLogRetentionDays ?? 0;

    // Schema migration + indexes + retention prune all happen here so the
    // ModLog instance is fully usable as soon as the constructor returns.
    this.initModLogSchema();
    this.initModLogIndexes();
    this.pruneModLogIfConfigured();

    this.stmtLogMod = db.prepare(
      `INSERT INTO mod_log
         (action, source, by_user, plugin, channel, target, outcome, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Wire up event bus for `audit:log` emissions after successful writes. */
  setEventBus(eventBus: BotEventBus | null): void {
    this.eventBus = eventBus;
  }

  /** Attach a fallback sink for audit writes that failed at the SQLite layer. */
  setAuditFallback(sink: ((options: LogModActionOptions) => void) | null): void {
    this.auditFallback = sink;
  }

  /**
   * Register an observer that fires when writes transition to disabled.
   * BotDatabase uses this to mirror the read-only flag on its own KV writes
   * so every mutating path short-circuits consistently.
   */
  setOnWritesDisabled(cb: (() => void) | null): void {
    this.onWritesDisabled = cb;
  }

  /** True once SQLITE_FULL has been observed on any write. */
  get areWritesDisabled(): boolean {
    return this.writesDisabled;
  }

  /**
   * Register a one-shot observer fired when the mod_log path hits a fatal
   * SQLite condition. BotDatabase forwards its own observer so a fatal in
   * either path triggers the same Bot.shutdown() flow.
   */
  setOnFatal(cb: (() => void) | null): void {
    this.onFatal = cb;
  }

  /** True once a fatal SQLite error has been observed on the mod_log path. */
  get isFatal(): boolean {
    return this.fatal;
  }

  /**
   * Classify SQLite errors into three tiers. Mirrors the logic in
   * BotDatabase.runClassified so the ModLog write path degrades identically.
   * Fatal errors fire `onFatal` and throw {@link DatabaseFatalError} instead
   * of `process.exit(2)` so the bot's `shutdown()` harness can drive a
   * graceful exit.
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
        if (!this.writesDisabled) {
          this.logger?.error(
            `[database] CRITICAL ${opName}: SQLITE_FULL — writes are now disabled until restart. Check disk space.`,
          );
        }
        this.writesDisabled = true;
        this.onWritesDisabled?.();
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
   * Write a mod_log row. See {@link LogModActionOptions}. Returns the row
   * id or null when the write was skipped/degraded.
   */
  logModAction(options: LogModActionOptions): number | null {
    if (!this.modLogEnabled) return null;
    if (this.writesDisabled) {
      this.auditFallback?.(options);
      return null;
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

    validateAction(action);
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
    //
    // Wrap the stringify in try/catch so a circular reference, BigInt,
    // or other non-serializable value can't kill the audit row entirely
    // — we coerce to a marker shape that's still valid JSON instead. This
    // also keeps the audit:log event payload in lockstep with what
    // `parseMetadataSafe` would yield on read: both produce a plain
    // object (or null) so botlink relay observers see exactly what a
    // follow-up `getModLogById` would return.
    let metadataJson: string | null = null;
    let emittedMetadata: Record<string, unknown> | null = null;
    if (metadata != null) {
      try {
        metadataJson = JSON.stringify(metadata);
      } catch (err) {
        this.logger?.warn(
          `logModAction: metadata for action "${action}" is not JSON-serializable (${(err as Error).message}); persisting marker shape`,
        );
        metadataJson = JSON.stringify({
          unserializable: true,
          reason: (err as Error).message,
        });
      }
      if (metadataJson != null && metadataJson.length > 8192) {
        metadataJson = JSON.stringify({
          truncated: true,
          original_bytes: metadataJson.length,
          head: metadataJson.slice(0, 1024),
        });
      }
      // Mirror the read-side validation: only a plain object (not array,
      // not scalar) survives `parseMetadataSafe`. The TS type already
      // narrows `metadata` to `Record<string, unknown>`, but we re-parse
      // the canonical JSON we just produced so the emit payload is
      // exactly what a `getModLogById` would return on the same row —
      // any truncation/coercion above is reflected in the event.
      try {
        const parsed: unknown = metadataJson == null ? null : JSON.parse(metadataJson);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          emittedMetadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Should be unreachable — we just stringified this — but if
        // the JSON.parse round-trips fails for any reason we drop the
        // event metadata to null rather than emitting an inconsistent
        // payload.
        emittedMetadata = null;
      }
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
        this.auditFallback?.(options);
        return null;
      }
      throw err;
    }

    const id = Number(result.lastInsertRowid);

    if (this.eventBus) {
      this.eventBus.emit('audit:log', {
        id,
        timestamp: Math.floor(Date.now() / 1000),
        action,
        source,
        by: scrubbedBy,
        plugin: scrubbedPlugin,
        channel: scrubbedChannel,
        target: scrubbedTarget,
        outcome,
        reason: scrubbedReason,
        metadata: emittedMetadata,
      });
    }

    return id;
  }

  /** Query the mod log with optional filters. */
  getModLog(filter?: ModLogFilter): ModLogEntry[] {
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
    const rows = this.db.prepare(sql).all(...params) as Array<
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
   * new rows land mid-browse.
   */
  countModLog(filter?: ModLogFilter): number {
    const built = this.buildModLogWhere(filter);
    if (built === null) return 0;
    const sql = `SELECT COUNT(*) AS n FROM mod_log ${built.where}`;
    const row = this.db.prepare(sql).get(...built.params) as { n: number };
    return row.n;
  }

  /** Fetch a single mod_log row by id, or null if missing. */
  getModLogById(id: number): ModLogEntry | null {
    const sql = `
      SELECT id, timestamp, action, source, by_user AS "by", plugin, channel, target,
             outcome, reason, metadata
      FROM mod_log
      WHERE id = ?
    `;
    const row = this.db.prepare(sql).get(id) as
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
      const like = `%${escapeLikePattern(filter.grep)}%`;
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
  // Schema / migration / retention prune
  // ---------------------------------------------------------------------------

  /**
   * Create or migrate the `mod_log` table to the Phase 1 schema. If a pre-
   * Phase-1 `mod_log` exists (no `source` column), copy its rows into the
   * new shape in a transaction and drop the old table. Historical rows get
   * `source = 'unknown'`, `plugin = NULL`, `outcome = 'success'`.
   */
  private initModLogSchema(): void {
    const db = this.db;
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

  /**
   * Indexes that back the `.modlog` query patterns:
   *  - `mod_log_ts`         — the default tail-DESC view + cursor pagination
   *                           (`id` and `timestamp` are correlated; ordering
   *                           by timestamp uses this index, ordering by id
   *                           uses the implicit primary key).
   *  - `mod_log_target`     — `.modlog target <name>` filters
   *  - `mod_log_channel_ts` — per-channel views (master flag, channel-scoped
   *                           audit reads from chanmod) — composite on
   *                           `(channel, timestamp DESC)` so the channel-scope
   *                           filter and the descending sort share one index.
   *  - `mod_log_source`     — partition view by `repl|irc|dcc|botlink|plugin|…`
   */
  private initModLogIndexes(): void {
    this.db.exec(`
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
   * handle other work (IRC registration, plugin loads).
   */
  pruneOldModLogRows(): void {
    this.pruneModLogIfConfigured();
  }

  /**
   * Runtime toggles invoked by `BotDatabase` setters when the operator
   * flips `core.logging.mod_actions` or changes
   * `core.logging.mod_log_retention_days`. Past rows aren't affected by
   * the enable flip; the new retention value applies on the next prune.
   */
  setModLogEnabled(enabled: boolean): void {
    this.modLogEnabled = enabled;
  }

  setModLogRetentionDays(days: number): void {
    this.modLogRetentionDays = days;
  }

  private pruneModLogIfConfigured(): void {
    if (this.modLogRetentionDays <= 0) return;
    const db = this.db;
    const cutoff = Math.floor(Date.now() / 1000) - this.modLogRetentionDays * 86400;
    const BATCH_SIZE = 10_000;
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
      if (typeof (t as { unref?: unknown }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
    };
    scheduleNext();
  }
}
