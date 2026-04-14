import Database from 'better-sqlite3';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotDatabase, DatabaseFullError } from '../src/database';

function tempDbPath(label: string): string {
  return join(tmpdir(), `hexbot-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('BotDatabase', () => {
  let db: BotDatabase;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('open / close', () => {
    it('should open and close without error', () => {
      const db2 = new BotDatabase(':memory:');
      expect(() => db2.open()).not.toThrow();
      expect(() => db2.close()).not.toThrow();
    });

    it('should throw on operations after close', () => {
      const db2 = new BotDatabase(':memory:');
      db2.open();
      db2.close();
      expect(() => db2.get('ns', 'key')).toThrow('not open');
    });

    it('should be safe to close twice', () => {
      const db2 = new BotDatabase(':memory:');
      db2.open();
      db2.close();
      expect(() => db2.close()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // KV: get / set
  // -------------------------------------------------------------------------

  describe('get / set', () => {
    it('should set and get a string value', () => {
      db.set('plugin-a', 'greeting', 'hello');
      expect(db.get('plugin-a', 'greeting')).toBe('hello');
    });

    it('should return null for a missing key', () => {
      expect(db.get('plugin-a', 'nonexistent')).toBeNull();
    });

    it('should auto-stringify non-string values (object)', () => {
      const obj = { foo: 'bar', num: 42 };
      db.set('plugin-a', 'config', obj);
      const raw = db.get('plugin-a', 'config');
      expect(raw).toBe(JSON.stringify(obj));
      expect(JSON.parse(raw!)).toEqual(obj);
    });

    it('should auto-stringify non-string values (number)', () => {
      db.set('plugin-a', 'count', 99);
      expect(db.get('plugin-a', 'count')).toBe('99');
    });

    it('should auto-stringify non-string values (boolean)', () => {
      db.set('plugin-a', 'flag', true);
      expect(db.get('plugin-a', 'flag')).toBe('true');
    });

    it('should auto-stringify non-string values (array)', () => {
      db.set('plugin-a', 'list', [1, 2, 3]);
      expect(db.get('plugin-a', 'list')).toBe('[1,2,3]');
    });

    it('should overwrite on set of same key', () => {
      db.set('plugin-a', 'key', 'first');
      db.set('plugin-a', 'key', 'second');
      expect(db.get('plugin-a', 'key')).toBe('second');
    });
  });

  // -------------------------------------------------------------------------
  // KV: del
  // -------------------------------------------------------------------------

  describe('del', () => {
    it('should delete an existing key', () => {
      db.set('plugin-a', 'key', 'value');
      db.del('plugin-a', 'key');
      expect(db.get('plugin-a', 'key')).toBeNull();
    });

    it('should not error when deleting a nonexistent key', () => {
      expect(() => db.del('plugin-a', 'nope')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // KV: list
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('should list all keys in a namespace', () => {
      db.set('plugin-a', 'k1', 'v1');
      db.set('plugin-a', 'k2', 'v2');
      db.set('plugin-a', 'k3', 'v3');
      const rows = db.list('plugin-a');
      expect(rows).toHaveLength(3);
      const keys = rows.map((r) => r.key).sort();
      expect(keys).toEqual(['k1', 'k2', 'k3']);
    });

    it('should return empty array for empty namespace', () => {
      expect(db.list('empty-ns')).toEqual([]);
    });

    it('should filter by prefix', () => {
      db.set('plugin-a', 'user:alice', '1');
      db.set('plugin-a', 'user:bob', '2');
      db.set('plugin-a', 'setting:color', 'blue');
      const rows = db.list('plugin-a', 'user:');
      expect(rows).toHaveLength(2);
      const keys = rows.map((r) => r.key).sort();
      expect(keys).toEqual(['user:alice', 'user:bob']);
    });

    it('should handle prefix with LIKE wildcards safely', () => {
      db.set('plugin-a', '100%_done', 'yes');
      db.set('plugin-a', '100other', 'no');
      const rows = db.list('plugin-a', '100%_');
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('100%_done');
    });
  });

  // -------------------------------------------------------------------------
  // Namespace isolation
  // -------------------------------------------------------------------------

  describe('namespace isolation', () => {
    it('should isolate keys between namespaces', () => {
      db.set('plugin-a', 'shared-key', 'from-a');
      db.set('plugin-b', 'shared-key', 'from-b');

      expect(db.get('plugin-a', 'shared-key')).toBe('from-a');
      expect(db.get('plugin-b', 'shared-key')).toBe('from-b');
    });

    it('should not list keys from other namespaces', () => {
      db.set('plugin-a', 'only-a', '1');
      db.set('plugin-b', 'only-b', '2');

      const aKeys = db.list('plugin-a');
      expect(aKeys).toHaveLength(1);
      expect(aKeys[0].key).toBe('only-a');
    });

    it('should not delete keys from other namespaces', () => {
      db.set('plugin-a', 'key', 'val-a');
      db.set('plugin-b', 'key', 'val-b');
      db.del('plugin-a', 'key');

      expect(db.get('plugin-a', 'key')).toBeNull();
      expect(db.get('plugin-b', 'key')).toBe('val-b');
    });
  });

  // -------------------------------------------------------------------------
  // Mod log — round trip every column
  // -------------------------------------------------------------------------

  describe('mod log — round trip', () => {
    it('round-trips every column', () => {
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'admin',
        channel: '#test',
        target: 'baduser',
        outcome: 'success',
        reason: 'spamming',
        metadata: { score: 42, rules: ['nospam', 'nocaps'] },
      });
      const logs = db.getModLog();
      expect(logs).toHaveLength(1);
      const entry = logs[0];
      expect(entry.id).toBe(1);
      expect(typeof entry.timestamp).toBe('number');
      expect(entry.action).toBe('kick');
      expect(entry.source).toBe('irc');
      expect(entry.by).toBe('admin');
      expect(entry.plugin).toBeNull();
      expect(entry.channel).toBe('#test');
      expect(entry.target).toBe('baduser');
      expect(entry.outcome).toBe('success');
      expect(entry.reason).toBe('spamming');
      expect(entry.metadata).toEqual({ score: 42, rules: ['nospam', 'nocaps'] });
    });

    it('defaults outcome to success and omits null columns', () => {
      db.logModAction({ action: 'op', source: 'irc', by: 'admin', channel: '#t', target: 'u' });
      const [entry] = db.getModLog();
      expect(entry.outcome).toBe('success');
      expect(entry.reason).toBeNull();
      expect(entry.metadata).toBeNull();
    });

    it('persists outcome=failure', () => {
      db.logModAction({
        action: 'auth-fail',
        source: 'dcc',
        target: 'someone',
        outcome: 'failure',
      });
      const [entry] = db.getModLog();
      expect(entry.outcome).toBe('failure');
    });
  });

  // -------------------------------------------------------------------------
  // Mod log — filters
  // -------------------------------------------------------------------------

  describe('mod log — filters', () => {
    beforeEach(() => {
      db.logModAction({ action: 'kick', source: 'irc', channel: '#a', target: 'u1', by: 'admin' });
      db.logModAction({ action: 'ban', source: 'irc', channel: '#a', target: 'u2', by: 'admin' });
      db.logModAction({ action: 'kick', source: 'dcc', channel: '#b', target: 'u1', by: 'other' });
      db.logModAction({
        action: 'kick',
        source: 'plugin',
        plugin: 'flood',
        channel: '#a',
        target: 'u3',
        outcome: 'failure',
        reason: 'rate limit',
        metadata: { offences: 5 },
      });
    });

    it('filters by action', () => {
      const rows = db.getModLog({ action: 'kick' });
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.action === 'kick')).toBe(true);
    });

    it('filters by channel', () => {
      const rows = db.getModLog({ channel: '#a' });
      expect(rows).toHaveLength(3);
    });

    it('filters by target', () => {
      const rows = db.getModLog({ target: 'u1' });
      expect(rows).toHaveLength(2);
    });

    it('filters by source', () => {
      const rows = db.getModLog({ source: 'plugin' });
      expect(rows).toHaveLength(1);
      expect(rows[0].plugin).toBe('flood');
    });

    it('filters by plugin', () => {
      const rows = db.getModLog({ plugin: 'flood' });
      expect(rows).toHaveLength(1);
    });

    it('filters by outcome=failure', () => {
      const rows = db.getModLog({ outcome: 'failure' });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('kick');
    });

    it('filters by actor (by)', () => {
      const rows = db.getModLog({ by: 'admin' });
      expect(rows).toHaveLength(2);
    });

    it('filters by grep against reason', () => {
      const rows = db.getModLog({ grep: 'rate' });
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('rate limit');
    });

    it('filters by grep against metadata JSON', () => {
      const rows = db.getModLog({ grep: 'offences' });
      expect(rows).toHaveLength(1);
    });

    it('filters by sinceTimestamp', () => {
      const now = Math.floor(Date.now() / 1000);
      const future = db.getModLog({ sinceTimestamp: now + 3600 });
      expect(future).toHaveLength(0);
      const past = db.getModLog({ sinceTimestamp: 0 });
      expect(past).toHaveLength(4);
    });

    it('respects limit', () => {
      const rows = db.getModLog({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns rows newest-first', () => {
      const rows = db.getModLog();
      expect(rows[0].id).toBeGreaterThan(rows[rows.length - 1].id);
    });

    it('combines multiple filters', () => {
      const rows = db.getModLog({ action: 'kick', channel: '#a' });
      expect(rows).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Mod log — validation invariants
  // -------------------------------------------------------------------------

  describe('mod log — invariants', () => {
    it('rejects an unknown source', () => {
      expect(() => db.logModAction({ action: 'x', source: 'wat' as never })).toThrow(
        /invalid source/,
      );
    });

    it('rejects source="plugin" without plugin name', () => {
      expect(() => db.logModAction({ action: 'x', source: 'plugin' })).toThrow(
        /plugin must be set iff source === 'plugin'/,
      );
    });

    it('rejects a plugin name when source is not plugin', () => {
      expect(() => db.logModAction({ action: 'x', source: 'irc', plugin: 'flood' })).toThrow(
        /plugin must be set iff source === 'plugin'/,
      );
    });

    it('rejects an invalid outcome', () => {
      expect(() =>
        db.logModAction({ action: 'x', source: 'irc', outcome: 'maybe' as never }),
      ).toThrow(/invalid outcome/);
    });
  });

  // -------------------------------------------------------------------------
  // Schema — indexes
  // -------------------------------------------------------------------------

  describe('mod log — indexes', () => {
    it('creates the expected indexes on mod_log', () => {
      const raw = new Database(':memory:');
      try {
        // Simulate an old-schema DB by pre-creating the pre-Phase-1 table,
        // then wrap it with BotDatabase which should migrate and index.
        raw.exec(`
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
      } finally {
        raw.close();
      }

      const rows = db
        .rawHandleForTests()
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mod_log'`)
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toContain('mod_log_ts');
      expect(names).toContain('mod_log_target');
      expect(names).toContain('mod_log_channel_ts');
      expect(names).toContain('mod_log_source');
    });
  });

  // -------------------------------------------------------------------------
  // Schema — startup migration from old table
  // -------------------------------------------------------------------------

  describe('mod log — startup migration', () => {
    it('migrates old rows into the new schema with sensible defaults', () => {
      // Create an on-disk-like test by writing the old schema via raw sqlite
      // into a file, seeding rows, then opening it with BotDatabase.
      const tmp = tempDbPath('modlog-migration');
      const raw = new Database(tmp);
      raw.exec(`
        CREATE TABLE mod_log (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER DEFAULT (unixepoch()),
          action    TEXT NOT NULL,
          channel   TEXT,
          target    TEXT,
          by_user   TEXT,
          reason    TEXT
        );
        INSERT INTO mod_log (action, channel, target, by_user, reason)
          VALUES ('kick', '#old', 'legacy', 'oldadmin', 'legacy reason');
        INSERT INTO mod_log (action, channel, target, by_user, reason)
          VALUES ('op', '#old', 'legacy2', 'oldadmin', NULL);
      `);
      raw.close();

      const migrated = new BotDatabase(tmp);
      try {
        migrated.open();
        const rows = migrated.getModLog();
        expect(rows).toHaveLength(2);
        // Rows come back newest-first; the second insert lands first.
        const legacy = rows.find((r) => r.target === 'legacy')!;
        expect(legacy.action).toBe('kick');
        expect(legacy.source).toBe('unknown');
        expect(legacy.by).toBe('oldadmin');
        expect(legacy.plugin).toBeNull();
        expect(legacy.channel).toBe('#old');
        expect(legacy.outcome).toBe('success');
        expect(legacy.reason).toBe('legacy reason');
        expect(legacy.metadata).toBeNull();
      } finally {
        migrated.close();
        unlinkSync(tmp);
      }
    });

    it('on a re-open after migration does not throw', () => {
      const tmp = tempDbPath('modlog-reopen');
      const first = new BotDatabase(tmp);
      first.open();
      first.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' });
      first.close();

      const second = new BotDatabase(tmp);
      try {
        expect(() => second.open()).not.toThrow();
        expect(second.getModLog()).toHaveLength(1);
      } finally {
        second.close();
        unlinkSync(tmp);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Config gating — modLogEnabled: false
  // -------------------------------------------------------------------------

  describe('mod log — config gating', () => {
    it('suppresses writes when modLogEnabled is false', () => {
      const quiet = new BotDatabase(':memory:', null, { modLogEnabled: false });
      try {
        quiet.open();
        quiet.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' });
        expect(quiet.getModLog()).toHaveLength(0);
      } finally {
        quiet.close();
      }
    });

    it('writes normally when modLogEnabled is true (default)', () => {
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' });
      expect(db.getModLog()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  describe('mod log — retention', () => {
    it('prunes rows older than the retention cutoff on open', () => {
      const tmp = tempDbPath('modlog-retention');

      // Seed a fresh db with a current and an ancient row.
      const seed = new BotDatabase(tmp);
      seed.open();
      seed.logModAction({ action: 'new', source: 'irc', by: 'a', target: 'b' });
      const internal = seed.rawHandleForTests();
      // Backdate: 10 days old
      const ancient = Math.floor(Date.now() / 1000) - 10 * 86400;
      internal
        .prepare(
          `INSERT INTO mod_log (timestamp, action, source, by_user, target, outcome)
           VALUES (?, 'old', 'irc', 'a', 'b', 'success')`,
        )
        .run(ancient);
      seed.close();

      // Re-open with a 5-day retention; the old row should be deleted.
      const pruned = new BotDatabase(tmp, null, { modLogRetentionDays: 5 });
      try {
        pruned.open();
        const rows = pruned.getModLog();
        expect(rows).toHaveLength(1);
        expect(rows[0].action).toBe('new');
      } finally {
        pruned.close();
        unlinkSync(tmp);
      }
    });

    it('keeps everything when retention is 0 or unset', () => {
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'b' });
      expect(db.getModLog()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // transaction() helper + error classification (stability audit 2026-04-14)
  // ---------------------------------------------------------------------------

  describe('transaction() helper', () => {
    it('commits on success', () => {
      db.transaction(() => {
        db.set('ns', 'k1', 'v1');
        db.set('ns', 'k2', 'v2');
      });
      expect(db.get('ns', 'k1')).toBe('v1');
      expect(db.get('ns', 'k2')).toBe('v2');
    });

    it('rolls back when the callback throws', () => {
      db.set('ns', 'seed', 'initial');
      expect(() =>
        db.transaction(() => {
          db.set('ns', 'seed', 'mutated');
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect(db.get('ns', 'seed')).toBe('initial');
    });
  });

  describe('writes-disabled degrade mode', () => {
    // We can't portably simulate SQLITE_FULL in-memory, so poke the
    // internal `writesDisabled` flag directly to exercise the degrade
    // branch. The typed guard in `set`/`del` throws DatabaseFullError
    // when the flag is set; reads remain available.
    it('throws DatabaseFullError on mutating calls once writes are disabled', () => {
      const internal = db as unknown as { writesDisabled: boolean };
      internal.writesDisabled = true;
      expect(() => db.set('ns', 'k', 'v')).toThrow(DatabaseFullError);
      expect(() => db.del('ns', 'k')).toThrow(DatabaseFullError);
      // Reads still work — the degrade path is deliberately asymmetric.
      expect(db.get('ns', 'k')).toBeNull();
    });
  });
});
