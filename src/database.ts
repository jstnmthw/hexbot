// n0xb0t — SQLite database wrapper
// Namespaced key-value store + mod_log for moderation action tracking.

import Database from 'better-sqlite3';
import type { Statement, Database as DatabaseType } from 'better-sqlite3';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModLogEntry {
  id: number;
  timestamp: number;
  action: string;
  channel: string | null;
  target: string | null;
  by: string | null;
  reason: string | null;
}

export interface ModLogFilter {
  action?: string;
  channel?: string;
  target?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class BotDatabase {
  private db: DatabaseType | null = null;
  private readonly path: string;
  private logger: Logger | null;

  // Prepared statements (initialized on open)
  private stmtGet!: Statement;
  private stmtSet!: Statement;
  private stmtDel!: Statement;
  private stmtList!: Statement;
  private stmtListPrefix!: Statement;
  private stmtLogMod!: Statement;

  constructor(path: string, logger?: Logger | null) {
    this.path = path;
    this.logger = logger?.child('database') ?? null;
  }

  /** Open the database connection and initialize schema. */
  open(): void {
    this.db = new Database(this.path);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT,
        updated   INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE IF NOT EXISTS mod_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (unixepoch()),
        action    TEXT NOT NULL,
        channel   TEXT,
        target    TEXT,
        by_user   TEXT,
        reason    TEXT
      );
    `);

    // Prepare statements for the KV store
    this.stmtGet = this.db.prepare(
      'SELECT value FROM kv WHERE namespace = ? AND key = ?'
    );
    this.stmtSet = this.db.prepare(
      `INSERT INTO kv (namespace, key, value, updated)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated = excluded.updated`
    );
    this.stmtDel = this.db.prepare(
      'DELETE FROM kv WHERE namespace = ? AND key = ?'
    );
    this.stmtList = this.db.prepare(
      'SELECT key, value FROM kv WHERE namespace = ?'
    );
    this.stmtListPrefix = this.db.prepare(
      'SELECT key, value FROM kv WHERE namespace = ? AND key LIKE ? ESCAPE \'\\\''
    );
    this.stmtLogMod = this.db.prepare(
      'INSERT INTO mod_log (action, channel, target, by_user, reason) VALUES (?, ?, ?, ?, ?)'
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
      return this.stmtListPrefix.all(namespace, `${escaped}%`) as Array<{ key: string; value: string }>;
    }
    return this.stmtList.all(namespace) as Array<{ key: string; value: string }>;
  }

  // ---------------------------------------------------------------------------
  // Mod log
  // ---------------------------------------------------------------------------

  /** Log a moderation action. */
  logModAction(
    action: string,
    channel: string | null,
    target: string | null,
    by: string | null,
    reason?: string | null
  ): void {
    this.ensureOpen();
    this.stmtLogMod.run(action, channel, target, by, reason ?? null);
  }

  /** Query the mod log with optional filters. */
  getModLog(filter?: ModLogFilter): ModLogEntry[] {
    const db = this.ensureOpen();
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ? `LIMIT ?` : '';
    if (filter?.limit) params.push(filter.limit);

    const sql = `SELECT id, timestamp, action, channel, target, by_user AS "by", reason FROM mod_log ${where} ORDER BY id DESC ${limit}`;
    return db.prepare(sql).all(...params) as ModLogEntry[];
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
}
