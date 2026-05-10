// Tests for BotLinkHub link ban management: getAuthBans, manualBan, unban, persistence, CIDR, events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotLinkHub, type LinkBan } from '../../src/core/botlink';
import { BotDatabase } from '../../src/database';
import { BotEventBus } from '../../src/event-bus';
import { createLogger } from '../../src/logger';
import type { BotlinkConfig } from '../../src/types';
import { TEST_LINK_SALT, createMockSocket } from '../helpers/mock-socket';

// Memoize deriveLinkKey across the file. scryptSync (~50ms) runs on every
// BotLinkHub construction; a single (password, salt) pair is reused across
// tests, so caching collapses repeated KDF cost. vi.mock is hoisted before
// any production import.
vi.mock('../../src/core/botlink/protocol', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/botlink/protocol')>(
    '../../src/core/botlink/protocol',
  );
  const cache = new Map<string, Buffer>();
  return {
    ...actual,
    deriveLinkKey(password: string, linkSaltHex: string): Buffer {
      const cacheKey = `${password}\0${linkSaltHex}`;
      let key = cache.get(cacheKey);
      if (!key) {
        key = actual.deriveLinkKey(password, linkSaltHex);
        cache.set(cacheKey, key);
      }
      return Buffer.from(key);
    },
  };
});

function makeConfig(overrides: Partial<BotlinkConfig> = {}): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'testhub',
    password: 'secret',
    link_salt: TEST_LINK_SALT,
    ping_interval_ms: 30_000,
    link_timeout_ms: 60_000,
    max_auth_failures: 3,
    auth_window_ms: 60_000,
    auth_ban_duration_ms: 300_000,
    auth_ip_whitelist: [],
    listen: { port: 0, host: '127.0.0.1' },
    ...overrides,
  } as BotlinkConfig;
}

describe('BotLinkHub — link ban management', () => {
  let db: BotDatabase;
  let eventBus: BotEventBus;
  let hub: BotLinkHub;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    eventBus = new BotEventBus();
    hub = new BotLinkHub(makeConfig(), '1.0.0', createLogger('error'), eventBus, db);
  });

  afterEach(() => {
    hub.close();
    db.close();
  });

  // -------------------------------------------------------------------------
  // getAuthBans
  // -------------------------------------------------------------------------

  describe('getAuthBans', () => {
    it('returns empty array when no bans exist', () => {
      expect(hub.getAuthBans()).toEqual([]);
    });

    it('returns manual bans', () => {
      hub.manualBan('10.0.0.1', 0, 'test', 'admin');
      const bans = hub.getAuthBans();
      expect(bans).toHaveLength(1);
      expect(bans[0].ip).toBe('10.0.0.1');
      expect(bans[0].manual).toBe(true);
    });

    it('includes CIDR manual bans', () => {
      hub.manualBan('172.16.0.0/24', 0, 'compromised range', 'admin');
      const bans = hub.getAuthBans();
      expect(bans).toHaveLength(1);
      expect(bans[0].ip).toBe('172.16.0.0/24');
      expect(bans[0].manual).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // manualBan
  // -------------------------------------------------------------------------

  describe('manualBan', () => {
    it('persists a permanent ban to DB', () => {
      hub.manualBan('10.0.0.99', 0, 'decommissioned', 'admin');
      const raw = db.get('_linkbans', '10.0.0.99');
      expect(raw).not.toBeNull();
      const ban = JSON.parse(raw!) as LinkBan;
      expect(ban.bannedUntil).toBe(0);
      expect(ban.reason).toBe('decommissioned');
    });

    it('persists a timed ban to DB', () => {
      hub.manualBan('10.0.0.99', 300_000, 'suspicious', 'admin');
      const raw = db.get('_linkbans', '10.0.0.99');
      expect(raw).not.toBeNull();
      const ban = JSON.parse(raw!) as LinkBan;
      expect(ban.bannedUntil).toBeGreaterThan(Date.now());
    });

    it('emits auth:ban event', () => {
      const spy = vi.fn();
      eventBus.on('auth:ban', spy);
      hub.manualBan('10.0.0.99', 300_000, 'test', 'admin');
      expect(spy).toHaveBeenCalledWith('10.0.0.99', 0, 300_000);
    });

    it('CIDR ban is stored in manualCidrBans (reflected in getAuthBans)', () => {
      hub.manualBan('192.168.0.0/16', 0, 'block range', 'admin');
      const bans = hub.getAuthBans();
      expect(bans.find((b) => b.ip === '192.168.0.0/16')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // unban
  // -------------------------------------------------------------------------

  describe('unban', () => {
    it('removes a manual single IP ban', () => {
      hub.manualBan('10.0.0.99', 0, 'test', 'admin');
      hub.unban('10.0.0.99', 'admin');
      expect(hub.getAuthBans()).toHaveLength(0);
      expect(db.get('_linkbans', '10.0.0.99')).toBeNull();
    });

    it('removes a manual CIDR ban', () => {
      hub.manualBan('172.16.0.0/24', 0, 'test', 'admin');
      hub.unban('172.16.0.0/24', 'admin');
      expect(hub.getAuthBans()).toHaveLength(0);
      expect(db.get('_linkbans', '172.16.0.0/24')).toBeNull();
    });

    it('emits auth:unban event', () => {
      const spy = vi.fn();
      eventBus.on('auth:unban', spy);
      hub.manualBan('10.0.0.99', 0, 'test', 'admin');
      hub.unban('10.0.0.99', 'admin');
      expect(spy).toHaveBeenCalledWith('10.0.0.99');
    });
  });

  // -------------------------------------------------------------------------
  // Persistence across restart
  // -------------------------------------------------------------------------

  describe('persistence', () => {
    it('manual bans survive simulated restart', () => {
      hub.manualBan('10.0.0.99', 0, 'permanent', 'admin');
      hub.manualBan('172.16.0.0/24', 0, 'cidr range', 'admin');
      hub.close();

      // Create a new hub with the same DB
      const hub2 = new BotLinkHub(makeConfig(), '1.0.0', createLogger('error'), eventBus, db);
      const bans = hub2.getAuthBans();
      expect(bans).toHaveLength(2);
      expect(bans.find((b) => b.ip === '10.0.0.99')).toBeDefined();
      expect(bans.find((b) => b.ip === '172.16.0.0/24')).toBeDefined();
      hub2.close();
    });

    it('expired timed bans are not loaded on restart', () => {
      // Manually insert an expired ban in the DB
      db.set(
        '_linkbans',
        '10.0.0.50',
        JSON.stringify({
          ip: '10.0.0.50',
          bannedUntil: Date.now() - 1000,
          reason: 'expired',
          setBy: 'admin',
          setAt: Date.now() - 60_000,
        }),
      );
      hub.close();

      const hub2 = new BotLinkHub(makeConfig(), '1.0.0', createLogger('error'), eventBus, db);
      expect(hub2.getAuthBans()).toHaveLength(0);
      hub2.close();
    });
  });

  // -------------------------------------------------------------------------
  // handleConnection rejection
  // -------------------------------------------------------------------------

  describe('handleConnection — manual ban rejection', () => {
    it('rejects manually-banned IPs', async () => {
      await hub.listen(0, '127.0.0.1');
      hub.manualBan('10.0.0.1', 0, 'blocked', 'admin');

      const { socket, duplex } = createMockSocket();
      // Simulate the socket.remoteAddress
      Object.defineProperty(socket, 'remoteAddress', { value: '10.0.0.1' });
      hub.addConnection(socket);
      // Socket should be destroyed immediately
      expect(duplex.destroyed).toBe(true);
    });

    it('rejects IPs matching a CIDR manual ban', async () => {
      await hub.listen(0, '127.0.0.1');
      hub.manualBan('10.0.0.0/24', 0, 'blocked range', 'admin');

      const { socket, duplex } = createMockSocket();
      Object.defineProperty(socket, 'remoteAddress', { value: '10.0.0.50' });
      hub.addConnection(socket);
      expect(duplex.destroyed).toBe(true);
    });

    it('whitelisted IPs bypass manual bans', async () => {
      hub.close();
      db.close();
      // Recreate with whitelist
      db = new BotDatabase(':memory:');
      db.open();
      hub = new BotLinkHub(
        makeConfig({ auth_ip_whitelist: ['10.0.0.0/24'] }),
        '1.0.0',
        createLogger('error'),
        eventBus,
        db,
      );
      await hub.listen(0, '127.0.0.1');
      hub.manualBan('10.0.0.1', 0, 'blocked', 'admin');

      const { socket, duplex } = createMockSocket();
      Object.defineProperty(socket, 'remoteAddress', { value: '10.0.0.1' });
      hub.addConnection(socket);
      // Should NOT be destroyed — whitelisted
      expect(duplex.destroyed).toBe(false);
    });
  });
});
