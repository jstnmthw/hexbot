// HexBot — Database error classes
// Extracted into their own module so both `database.ts` and `core/mod-log.ts`
// can import them without a circular dependency.
import { SqliteError } from 'better-sqlite3';

/** Instance type of the runtime `SqliteError` class from better-sqlite3. */
type SqliteErrorInstance = InstanceType<typeof SqliteError>;

/**
 * Thrown when SQLite returns SQLITE_BUSY/SQLITE_LOCKED after the pragma-
 * level busy_timeout (5s) has expired. Callers — typically command handlers
 * and audit paths — should degrade: reply to the user that the database is
 * busy and skip the mutation, keeping the rest of the bot alive.
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
 * clear error before SQLite itself has to re-fail them.
 */
export class DatabaseFullError extends Error {
  constructor(opName: string, cause: SqliteErrorInstance) {
    super(`database storage is full during ${opName}: ${cause.message}`);
    this.name = 'DatabaseFullError';
    this.cause = cause;
  }
}
