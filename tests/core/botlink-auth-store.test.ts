// BotLinkAuthStore persistence-bound tests: DB writes gated by the CIDR cap,
// capped startup load, and the expired-row sweep on load.
import { type Mock, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminListStore } from '../../src/core/admin-list-store';
import { BotLinkAuthStore, type LinkBan, MAX_CIDR_BANS } from '../../src/core/botlink/auth-store';
import { BotDatabase } from '../../src/database';
import { createMockLogger } from '../helpers/mock-logger';

function makeBan(ip: string, overrides?: Partial<LinkBan>): LinkBan {
  return {
    ip,
    bannedUntil: 0,
    reason: 'test',
    setBy: 'admin',
    setAt: Date.now(),
    ...overrides,
  };
}

/** Direct handle on the `_linkbans` namespace for seeding/inspecting rows. */
function rawBanStore(db: BotDatabase): AdminListStore<LinkBan> {
  return new AdminListStore<LinkBan>(db, {
    namespace: '_linkbans',
    keyFn: (ban) => ban.ip,
  });
}

describe('BotLinkAuthStore persistence', () => {
  let db: BotDatabase;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  describe('addManualBan', () => {
    it('persists accepted CIDR and single-IP bans to the DB', () => {
      const store = new BotLinkAuthStore(db, createMockLogger());
      expect(store.addManualBan(makeBan('203.0.113.0/24'))).toBe(true);
      expect(store.addManualBan(makeBan('198.51.100.7'))).toBe(true);

      const raw = rawBanStore(db);
      expect(raw.has('203.0.113.0/24')).toBe(true);
      expect(raw.has('198.51.100.7')).toBe(true);
    });

    it('does not write a DB row for a CIDR ban rejected by the cap', () => {
      const store = new BotLinkAuthStore(db, createMockLogger());
      // Seed the in-memory map directly to the cap, skipping DB round-trips.
      for (let i = 0; i < MAX_CIDR_BANS; i++) {
        store.manualCidrBans.set(
          `10.${Math.floor(i / 256)}.${i % 256}.0/24`,
          makeBan(`10.${Math.floor(i / 256)}.${i % 256}.0/24`),
        );
      }

      expect(store.addManualBan(makeBan('192.168.99.0/24'))).toBe(false);
      expect(store.manualCidrBans.has('192.168.99.0/24')).toBe(false);
      expect(rawBanStore(db).has('192.168.99.0/24')).toBe(false);
    });

    it('still allows updating an existing CIDR ban at the cap', () => {
      const store = new BotLinkAuthStore(db, createMockLogger());
      for (let i = 0; i < MAX_CIDR_BANS; i++) {
        store.manualCidrBans.set(
          `10.${Math.floor(i / 256)}.${i % 256}.0/24`,
          makeBan(`10.${Math.floor(i / 256)}.${i % 256}.0/24`),
        );
      }

      // Re-banning an existing range is an upsert, not a new entry.
      expect(store.addManualBan(makeBan('10.0.0.0/24', { reason: 'updated' }))).toBe(true);
      expect(rawBanStore(db).get('10.0.0.0/24')?.reason).toBe('updated');
    });
  });

  describe('loadPersistedBans', () => {
    it('caps CIDR loads at MAX_CIDR_BANS and warns once with the skip count', () => {
      const raw = rawBanStore(db);
      const extra = 5;
      for (let i = 0; i < MAX_CIDR_BANS + extra; i++) {
        raw.set(makeBan(`10.${Math.floor(i / 256)}.${i % 256}.0/24`));
      }

      const logger = createMockLogger();
      const store = new BotLinkAuthStore(db, logger);

      expect(store.manualCidrBans.size).toBe(MAX_CIDR_BANS);
      const warnCalls = (logger.warn as Mock).mock.calls;
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0][0])).toContain(`skipped ${extra} persisted CIDR ban(s)`);
    });

    it('deletes expired timed rows from the DB while keeping permanent and unexpired rows', () => {
      const now = Date.now();
      const raw = rawBanStore(db);
      raw.set(makeBan('203.0.113.0/24', { bannedUntil: now - 1000 })); // expired CIDR
      raw.set(makeBan('198.51.100.7', { bannedUntil: now - 1000 })); // expired single IP
      raw.set(makeBan('192.0.2.0/24', { bannedUntil: 0 })); // permanent CIDR
      raw.set(makeBan('192.0.2.9', { bannedUntil: 0 })); // permanent single IP
      raw.set(makeBan('10.9.9.0/24', { bannedUntil: now + 60_000 })); // unexpired timed

      const store = new BotLinkAuthStore(db, createMockLogger());

      // Expired rows are swept from the DB and never loaded.
      expect(raw.has('203.0.113.0/24')).toBe(false);
      expect(raw.has('198.51.100.7')).toBe(false);
      expect(store.manualCidrBans.has('203.0.113.0/24')).toBe(false);
      expect(store.authTracker.get('198.51.100.7')).toBeUndefined();

      // Permanent and unexpired rows survive in DB and memory.
      expect(raw.has('192.0.2.0/24')).toBe(true);
      expect(raw.has('192.0.2.9')).toBe(true);
      expect(raw.has('10.9.9.0/24')).toBe(true);
      expect(store.manualCidrBans.has('192.0.2.0/24')).toBe(true);
      expect(store.manualCidrBans.has('10.9.9.0/24')).toBe(true);
      expect(store.authTracker.get('192.0.2.9')?.bannedUntil).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});
