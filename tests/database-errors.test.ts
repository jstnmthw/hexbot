// HexBot — DatabaseBusyError / DatabaseFullError construction
//
// The classifier in src/database.ts re-throws SqliteError as one of these
// custom subclasses so command handlers can decide whether to degrade
// (busy) or hard-fail with operator notification (full). The shape of the
// error — name, message format, and `cause` linkage — is part of that
// contract: audit-log writers and the REPL inspect `error.name` to choose
// a recovery path.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DatabaseBusyError, DatabaseFullError } from '../src/database-errors';

function makeSqliteError(): InstanceType<typeof import('better-sqlite3').SqliteError> {
  // Provoke a real SqliteError so we exercise the actual class hierarchy
  // — synthesizing one by hand would let a future module rename slip
  // through without the test noticing.
  const db = new Database(':memory:');
  try {
    db.exec('this is not valid sql');
    throw new Error('expected SqliteError');
  } catch (err) {
    db.close();
    return err as InstanceType<typeof import('better-sqlite3').SqliteError>;
  }
}

describe('DatabaseBusyError', () => {
  it('formats name, message, and cause', () => {
    const cause = makeSqliteError();
    const err = new DatabaseBusyError('kv.set', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseBusyError);
    expect(err.name).toBe('DatabaseBusyError');
    expect(err.message).toContain('database busy during kv.set');
    expect(err.message).toContain(cause.message);
    expect(err.cause).toBe(cause);
  });
});

describe('DatabaseFullError', () => {
  it('formats name, message, and cause', () => {
    const cause = makeSqliteError();
    const err = new DatabaseFullError('mod_log.insert', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseFullError);
    expect(err.name).toBe('DatabaseFullError');
    expect(err.message).toContain('database storage is full during mod_log.insert');
    expect(err.message).toContain(cause.message);
    expect(err.cause).toBe(cause);
  });

  it('is not confused with DatabaseBusyError', () => {
    // The classifier in database.ts uses `instanceof` to decide degrade vs.
    // hard-fail — a regression where one inherits from the other would
    // misroute SQLITE_FULL to the "just retry" path.
    const cause = makeSqliteError();
    const full = new DatabaseFullError('op', cause);
    const busy = new DatabaseBusyError('op', cause);
    expect(full).not.toBeInstanceOf(DatabaseBusyError);
    expect(busy).not.toBeInstanceOf(DatabaseFullError);
  });
});
