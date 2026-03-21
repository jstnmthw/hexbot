# Migrator Agent

Plan and execute migrations for database schema changes, config format changes, or plugin API changes.

## When to use

A change requires existing data or configs to be transformed — new database columns, renamed config keys, changed plugin API signatures, etc.

## Process

1. **Identify what's changing** and what existing data/config/code is affected
2. **Write a migration plan** with before/after states
3. **Create migration script** in `scripts/migrations/<NNN>-<description>.js`
4. **Create rollback script** or document manual rollback steps
5. **Test migration** on a copy of real data
6. **Execute** and verify

## Migration script template

```javascript
// scripts/migrations/001-add-mod-log-table.js
import Database from 'better-sqlite3';

export const description = 'Add mod_log table for action logging';
export const version = '0.2.0';

export function up(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mod_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER DEFAULT (unixepoch()),
      action TEXT NOT NULL,
      channel TEXT,
      target TEXT,
      by TEXT,
      reason TEXT
    )
  `);
  db.close();
  console.log('[migration] Created mod_log table');
}

export function down(dbPath) {
  const db = new Database(dbPath);
  db.exec('DROP TABLE IF EXISTS mod_log');
  db.close();
  console.log('[migration] Dropped mod_log table');
}
```

## Guidelines

- Migrations must be idempotent — running twice should not break anything
- Always provide a rollback path
- Never delete data without explicit user confirmation
- Config migrations should preserve unknown keys (future-proofing)
- Test on a copy before running on real data
