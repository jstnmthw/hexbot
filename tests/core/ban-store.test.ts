import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BanRecord, BanStore } from '../../src/core/ban-store';
import { BotDatabase } from '../../src/database';

describe('BanStore', () => {
  let db: BotDatabase;
  let store: BanStore;
  const ircLower = (s: string) => s.toLowerCase();

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    store = new BanStore(db, ircLower);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  describe('storeBan / getBan', () => {
    it('stores and retrieves a ban', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 1_800_000);
      const ban = store.getBan('#test', '*!*@evil.com');
      expect(ban).not.toBeNull();
      expect(ban!.mask).toBe('*!*@evil.com');
      expect(ban!.channel).toBe('#test');
      expect(ban!.by).toBe('admin');
      expect(ban!.expires).toBeGreaterThan(0);
    });

    it('stores a permanent ban (duration 0)', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 0);
      const ban = store.getBan('#test', '*!*@evil.com');
      expect(ban!.expires).toBe(0);
    });

    it('returns null for non-existent ban', () => {
      expect(store.getBan('#test', '*!*@nope')).toBeNull();
    });

    it('lowercases channel name for storage', () => {
      store.storeBan('#TEST', '*!*@evil.com', 'admin', 0);
      expect(store.getBan('#test', '*!*@evil.com')).not.toBeNull();
      expect(store.getBan('#TEST', '*!*@evil.com')).not.toBeNull();
    });

    it('preserves sticky flag on overwrite', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 1_800_000);
      store.setSticky('#test', '*!*@evil.com', true);
      store.storeBan('#test', '*!*@evil.com', 'admin', 3_600_000);
      expect(store.getBan('#test', '*!*@evil.com')!.sticky).toBe(true);
    });
  });

  describe('removeBan', () => {
    it('removes an existing ban', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 0);
      store.removeBan('#test', '*!*@evil.com');
      expect(store.getBan('#test', '*!*@evil.com')).toBeNull();
    });

    it('removing non-existent ban is a no-op', () => {
      store.removeBan('#test', '*!*@nope');
      expect(store.getBan('#test', '*!*@nope')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  describe('getChannelBans', () => {
    it('lists bans for a specific channel', () => {
      store.storeBan('#test', '*!*@a.com', 'admin', 0);
      store.storeBan('#test', '*!*@b.com', 'admin', 0);
      store.storeBan('#other', '*!*@c.com', 'admin', 0);

      const bans = store.getChannelBans('#test');
      expect(bans).toHaveLength(2);
      expect(bans.map((b) => b.mask)).toEqual(expect.arrayContaining(['*!*@a.com', '*!*@b.com']));
    });

    it('is case-insensitive on channel name', () => {
      store.storeBan('#Test', '*!*@a.com', 'admin', 0);
      expect(store.getChannelBans('#TEST')).toHaveLength(1);
    });

    it('returns empty array when no bans exist', () => {
      expect(store.getChannelBans('#empty')).toEqual([]);
    });
  });

  describe('getAllBans', () => {
    it('lists bans across all channels', () => {
      store.storeBan('#a', '*!*@a.com', 'admin', 0);
      store.storeBan('#b', '*!*@b.com', 'admin', 0);
      expect(store.getAllBans()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Sticky
  // -------------------------------------------------------------------------

  describe('setSticky', () => {
    it('sets sticky flag on existing ban', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 0);
      expect(store.setSticky('#test', '*!*@evil.com', true)).toBe(true);
      expect(store.getBan('#test', '*!*@evil.com')!.sticky).toBe(true);
    });

    it('clears sticky flag', () => {
      store.storeBan('#test', '*!*@evil.com', 'admin', 0);
      store.setSticky('#test', '*!*@evil.com', true);
      store.setSticky('#test', '*!*@evil.com', false);
      expect(store.getBan('#test', '*!*@evil.com')!.sticky).toBe(false);
    });

    it('returns false for non-existent ban', () => {
      expect(store.setSticky('#test', '*!*@nope', true)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  describe('liftExpiredBans', () => {
    it('lifts expired bans where bot has ops', () => {
      // Store a ban that expires in the past
      store.storeBan('#test', '*!*@old.com', 'admin', 60_000);
      // Manually backdate expiry
      const ban = store.getBan('#test', '*!*@old.com')!;
      ban.expires = Date.now() - 1000;
      db.set('_bans', `ban:#test:*!*@old.com`, JSON.stringify(ban));

      const mode = vi.fn();
      const lifted = store.liftExpiredBans(() => true, mode);

      expect(lifted).toBe(1);
      expect(mode).toHaveBeenCalledWith('#test', '-b', '*!*@old.com');
      expect(store.getBan('#test', '*!*@old.com')).toBeNull();
    });

    it('skips expired bans when bot has no ops', () => {
      store.storeBan('#test', '*!*@old.com', 'admin', 60_000);
      const ban = store.getBan('#test', '*!*@old.com')!;
      ban.expires = Date.now() - 1000;
      db.set('_bans', `ban:#test:*!*@old.com`, JSON.stringify(ban));

      const mode = vi.fn();
      const lifted = store.liftExpiredBans(() => false, mode);

      expect(lifted).toBe(0);
      expect(mode).not.toHaveBeenCalled();
      expect(store.getBan('#test', '*!*@old.com')).not.toBeNull();
    });

    it('does not lift permanent bans', () => {
      store.storeBan('#test', '*!*@perm.com', 'admin', 0);
      const mode = vi.fn();
      const lifted = store.liftExpiredBans(() => true, mode);
      expect(lifted).toBe(0);
    });

    it('does not lift unexpired bans', () => {
      store.storeBan('#test', '*!*@future.com', 'admin', 3_600_000);
      const mode = vi.fn();
      const lifted = store.liftExpiredBans(() => true, mode);
      expect(lifted).toBe(0);
    });

    it('drops orphaned records past the 24h grace window even without ops', () => {
      // Long-expired record (more than 24h past expiry) in a channel where
      // the bot can't send -b. Should be removed regardless.
      store.storeBan('#abandoned', '*!*@stale.com', 'admin', 60_000);
      const ban = store.getBan('#abandoned', '*!*@stale.com')!;
      ban.expires = Date.now() - 25 * 60 * 60_000; // 25h ago
      db.set('_bans', `ban:#abandoned:*!*@stale.com`, JSON.stringify(ban));

      const mode = vi.fn();
      const lifted = store.liftExpiredBans(() => false, mode);

      // Not "lifted" on IRC, but the record is gone.
      expect(lifted).toBe(0);
      expect(mode).not.toHaveBeenCalled();
      expect(store.getBan('#abandoned', '*!*@stale.com')).toBeNull();
    });

    it('drops orphaned records when the channel is no longer tracked', () => {
      store.storeBan('#abandoned', '*!*@stale.com', 'admin', 60_000);
      const ban = store.getBan('#abandoned', '*!*@stale.com')!;
      ban.expires = Date.now() - 1000; // just expired, well under the 24h grace
      db.set('_bans', `ban:#abandoned:*!*@stale.com`, JSON.stringify(ban));

      const mode = vi.fn();
      const lifted = store.liftExpiredBans(
        () => false,
        mode,
        () => false, // channel is no longer tracked
      );

      expect(lifted).toBe(0);
      expect(store.getBan('#abandoned', '*!*@stale.com')).toBeNull();
    });

    it('keeps recently-expired records when the channel is still tracked', () => {
      store.storeBan('#test', '*!*@stale.com', 'admin', 60_000);
      const ban = store.getBan('#test', '*!*@stale.com')!;
      ban.expires = Date.now() - 1000; // just expired
      db.set('_bans', `ban:#test:*!*@stale.com`, JSON.stringify(ban));

      const mode = vi.fn();
      const lifted = store.liftExpiredBans(
        () => false,
        mode,
        () => true, // tracked, but no ops
      );

      // Bot can't lift it AND the channel is still alive AND we're inside
      // the 24h grace window — leave the record alone.
      expect(lifted).toBe(0);
      expect(store.getBan('#test', '*!*@stale.com')).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Migration
  // -------------------------------------------------------------------------

  describe('migrateFromPluginNamespace', () => {
    /** Create a PluginDB-compatible wrapper around a real DB namespace. */
    function makeChanmodDb() {
      return {
        get: (key: string) => db.get('chanmod', key) ?? undefined,
        set: (key: string, value: string) => db.set('chanmod', key, value),
        del: (key: string) => db.del('chanmod', key),
        list: (prefix?: string) => db.list('chanmod', prefix),
      };
    }

    it('migrates ban records from plugin namespace', () => {
      // Simulate old chanmod-style ban storage in plugin namespace
      const record: BanRecord = {
        mask: '*!*@evil.com',
        channel: '#test',
        by: 'admin',
        ts: Date.now(),
        expires: 0,
      };
      db.set('chanmod', 'ban:#test:*!*@evil.com', JSON.stringify(record));

      const count = store.migrateFromPluginNamespace(makeChanmodDb());
      expect(count).toBe(1);
      expect(store.getBan('#test', '*!*@evil.com')).not.toBeNull();
      // Old key should be deleted
      expect(db.get('chanmod', 'ban:#test:*!*@evil.com')).toBeNull();
    });

    it('is idempotent — skips already-migrated keys', () => {
      const record: BanRecord = {
        mask: '*!*@evil.com',
        channel: '#test',
        by: 'admin',
        ts: Date.now(),
        expires: 0,
      };
      // Store in both old and new locations
      db.set('chanmod', 'ban:#test:*!*@evil.com', JSON.stringify(record));
      store.storeBan('#test', '*!*@evil.com', 'admin', 0);

      const count = store.migrateFromPluginNamespace(makeChanmodDb());
      expect(count).toBe(0); // skipped because _bans already has it
      // Old key still cleaned up
      expect(db.get('chanmod', 'ban:#test:*!*@evil.com')).toBeNull();
    });

    it('handles empty plugin namespace', () => {
      const emptyDb = {
        get: () => undefined,
        set: () => {},
        del: vi.fn(),
        list: () => [] as Array<{ key: string; value: string }>,
      };
      const count = store.migrateFromPluginNamespace(emptyDb);
      expect(count).toBe(0);
    });
  });
});
