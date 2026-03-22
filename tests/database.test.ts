import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotDatabase } from '../src/database.js';

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
  // Mod log
  // -------------------------------------------------------------------------

  describe('mod log', () => {
    it('should log and retrieve a mod action', () => {
      db.logModAction('kick', '#test', 'baduser', 'admin', 'spamming');
      const logs = db.getModLog();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('kick');
      expect(logs[0].channel).toBe('#test');
      expect(logs[0].target).toBe('baduser');
      expect(logs[0].by).toBe('admin');
      expect(logs[0].reason).toBe('spamming');
      expect(logs[0].id).toBe(1);
      expect(typeof logs[0].timestamp).toBe('number');
    });

    it('should allow null reason', () => {
      db.logModAction('op', '#test', 'user', 'admin');
      const logs = db.getModLog();
      expect(logs[0].reason).toBeNull();
    });

    it('should filter by action', () => {
      db.logModAction('kick', '#test', 'u1', 'admin');
      db.logModAction('ban', '#test', 'u2', 'admin');
      db.logModAction('kick', '#test', 'u3', 'admin');

      const kicks = db.getModLog({ action: 'kick' });
      expect(kicks).toHaveLength(2);
      expect(kicks.every((e) => e.action === 'kick')).toBe(true);
    });

    it('should filter by channel', () => {
      db.logModAction('kick', '#a', 'u1', 'admin');
      db.logModAction('kick', '#b', 'u2', 'admin');

      const logs = db.getModLog({ channel: '#a' });
      expect(logs).toHaveLength(1);
      expect(logs[0].channel).toBe('#a');
    });

    it('should filter by target', () => {
      db.logModAction('kick', '#a', 'alice', 'admin');
      db.logModAction('kick', '#a', 'bob', 'admin');

      const logs = db.getModLog({ target: 'alice' });
      expect(logs).toHaveLength(1);
      expect(logs[0].target).toBe('alice');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        db.logModAction('kick', '#test', `u${i}`, 'admin');
      }
      const logs = db.getModLog({ limit: 3 });
      expect(logs).toHaveLength(3);
    });

    it('should return results in descending order (newest first)', () => {
      db.logModAction('kick', '#a', 'first', 'admin');
      db.logModAction('ban', '#b', 'second', 'admin');
      const logs = db.getModLog();
      expect(logs[0].target).toBe('second');
      expect(logs[1].target).toBe('first');
    });

    it('should combine multiple filters', () => {
      db.logModAction('kick', '#a', 'alice', 'admin');
      db.logModAction('ban', '#a', 'alice', 'admin');
      db.logModAction('kick', '#b', 'alice', 'admin');
      db.logModAction('kick', '#a', 'bob', 'admin');

      const logs = db.getModLog({ action: 'kick', channel: '#a' });
      expect(logs).toHaveLength(2);
    });
  });
});
