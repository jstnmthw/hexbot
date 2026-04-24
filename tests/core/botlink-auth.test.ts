// Auth brute-force protection tests for BotLinkHub.
// Separate file to avoid test contamination from botlink.test.ts timer interactions.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotLinkHub, isWhitelisted } from '../../src/core/botlink';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';
import {
  TEST_LINK_SALT,
  answerHelloChallenge,
  createMockSocket,
  findFrame,
  pushFrame,
  testLinkKey,
} from '../helpers/mock-socket';

// Track hubs so afterEach can close() them — otherwise BotLinkAuthManager's
// 5-minute sweepTimer leaks across the test run (unref'd so process still exits).
const _createdHubs: BotLinkHub[] = [];
function makeHub(...args: ConstructorParameters<typeof BotLinkHub>): BotLinkHub {
  const h = new BotLinkHub(...args);
  _createdHubs.push(h);
  return h;
}
afterEach(() => {
  while (_createdHubs.length) _createdHubs.pop()?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for async processing. Use realTick for real timers, fakeTick for vi.useFakeTimers(). */
async function realTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
async function fakeTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const TEST_PASSWORD = 'test-secret-password';
const TEST_LINK_KEY = testLinkKey(TEST_PASSWORD);

function hubConfig(overrides?: Partial<BotlinkConfig>): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'hub',
    listen: { host: '127.0.0.1', port: 15051 },
    password: TEST_PASSWORD,
    link_salt: TEST_LINK_SALT,
    ping_interval_ms: 60_000,
    link_timeout_ms: 120_000,
    ...overrides,
  };
}

function createMockSocketWithIP(ip: string) {
  const result = createMockSocket();
  (result.socket as unknown as Record<string, unknown>).remoteAddress = ip;
  return result;
}

async function sendBadAuth(hub: BotLinkHub, ip: string, tick = realTick) {
  const { socket, written, duplex } = createMockSocketWithIP(ip);
  hub.addConnection(socket);
  // Any 64-hex string that doesn't match the real HMAC will fail auth.
  pushFrame(duplex, {
    type: 'HELLO',
    botname: 'scanner',
    hmac: 'f'.repeat(64),
    version: '1.0',
  });
  await tick();
  return { socket, written, duplex };
}

async function sendGoodAuth(hub: BotLinkHub, ip: string, botname: string, tick = realTick) {
  const { socket, written, duplex } = createMockSocketWithIP(ip);
  hub.addConnection(socket);
  answerHelloChallenge(written, duplex, TEST_LINK_KEY, botname);
  await tick();
  return { socket, written, duplex };
}

// ---------------------------------------------------------------------------
// isWhitelisted (CIDR)
// ---------------------------------------------------------------------------

describe('isWhitelisted', () => {
  it('matches IP within CIDR range', () => {
    expect(isWhitelisted('10.0.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(isWhitelisted('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
  });

  it('rejects IP outside CIDR range', () => {
    expect(isWhitelisted('192.168.1.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('handles /32 exact host match', () => {
    expect(isWhitelisted('10.0.0.5', ['10.0.0.5/32'])).toBe(true);
    expect(isWhitelisted('10.0.0.6', ['10.0.0.5/32'])).toBe(false);
  });

  it('normalizes IPv6-mapped IPv4', () => {
    expect(isWhitelisted('::ffff:10.0.0.1', ['10.0.0.0/8'])).toBe(true);
  });

  it('returns false for empty whitelist', () => {
    expect(isWhitelisted('10.0.0.1', [])).toBe(false);
  });

  it('returns false for non-IPv4 addresses', () => {
    expect(isWhitelisted('::1', ['10.0.0.0/8'])).toBe(false);
  });

  it('handles multiple CIDRs', () => {
    expect(isWhitelisted('172.16.0.1', ['10.0.0.0/8', '172.16.0.0/12'])).toBe(true);
    expect(isWhitelisted('192.168.1.1', ['10.0.0.0/8', '172.16.0.0/12'])).toBe(false);
  });

  it('ignores malformed CIDRs', () => {
    expect(isWhitelisted('10.0.0.1', ['not-a-cidr', '10.0.0.0/8'])).toBe(true);
    expect(isWhitelisted('10.0.0.1', ['bad'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth brute-force protection
// ---------------------------------------------------------------------------

describe('auth brute-force protection', () => {
  afterEach(() => vi.useRealTimers());

  it('does not ban after fewer than max_auth_failures', async () => {
    const hub = makeHub(hubConfig({ max_auth_failures: 5 }), '1.0.0');
    const ip = '10.99.0.1';

    for (let i = 0; i < 4; i++) {
      await sendBadAuth(hub, ip);
    }

    // 5th triggers ban, but this connection still gets AUTH_FAILED
    const { written } = await sendBadAuth(hub, ip);
    expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'AUTH_FAILED' });
  });

  it('bans after max_auth_failures and immediately drops next connection', async () => {
    const hub = makeHub(hubConfig({ max_auth_failures: 3 }), '1.0.0');
    const ip = '10.99.0.2';

    for (let i = 0; i < 3; i++) {
      await sendBadAuth(hub, ip);
    }

    const { socket, written } = createMockSocketWithIP(ip);
    hub.addConnection(socket);
    await realTick();
    expect(written).toHaveLength(0);
    expect(socket.destroyed).toBe(true);
  });

  it('allows connections again after ban expires', async () => {
    vi.useFakeTimers();
    const hub = makeHub(hubConfig({ max_auth_failures: 3, auth_ban_duration_ms: 10_000 }), '1.0.0');
    const ip = '10.99.0.3';

    for (let i = 0; i < 3; i++) {
      await sendBadAuth(hub, ip, fakeTick);
    }

    // Banned
    const { socket: s1 } = createMockSocketWithIP(ip);
    hub.addConnection(s1);
    expect(s1.destroyed).toBe(true);

    // Advance past ban
    vi.advanceTimersByTime(10_001);

    // Allowed now
    const { written } = await sendGoodAuth(hub, ip, 'leaf-after-ban', fakeTick);
    expect(findFrame(written, 'WELCOME')).toBeDefined();
  });

  it('escalates ban duration: doubles each time, caps at 24h', async () => {
    vi.useFakeTimers();
    const eventBus = new BotEventBus();
    const bans: number[] = [];
    eventBus.on('auth:ban', (_ip, _failures, duration) => bans.push(duration));

    const hub = makeHub(
      hubConfig({ max_auth_failures: 1, auth_ban_duration_ms: 1000 }),
      '1.0.0',
      null,
      eventBus,
    );
    const ip = '10.99.0.4';

    await sendBadAuth(hub, ip, fakeTick);
    vi.advanceTimersByTime(1001);

    await sendBadAuth(hub, ip, fakeTick);
    vi.advanceTimersByTime(2001);

    await sendBadAuth(hub, ip, fakeTick);
    expect(bans).toEqual([1000, 2000, 4000]);

    // Stability audit 2026-04-14: `banCount` is now hard-capped at
    // 8 (and decays by one half-step per hour since last failure).
    // With the test's baseBanMs=1000, the effective ceiling is
    // 1000 * 2^8 = 256_000 ms — NOT the absolute 24h ceiling from
    // the MAX_BAN_MS safety rail. Both caps coexist: banCount
    // limits escalation; MAX_BAN_MS limits absolute duration for
    // production baseBanMs values. Advance time just past each
    // ban's expiry but well under 1h so decay doesn't reset us.
    let expectedBan = 4000;
    for (let i = 0; i < 12; i++) {
      const advance = Math.min(expectedBan + 500, 3_500_000);
      vi.advanceTimersByTime(advance);
      await sendBadAuth(hub, ip, fakeTick);
      expectedBan = Math.min(expectedBan * 2, 256_000);
    }
    // Plateau at the banCount=8 ceiling.
    expect(bans[bans.length - 1]).toBe(256_000);
  });

  it('whitelisted IPs are never tracked or banned', async () => {
    const hub = makeHub(
      hubConfig({ max_auth_failures: 1, auth_ip_whitelist: ['10.0.0.0/8'] }),
      '1.0.0',
    );
    const ip = '10.0.0.50';

    for (let i = 0; i < 10; i++) {
      await sendBadAuth(hub, ip);
    }

    const { written } = await sendGoodAuth(hub, ip, 'trusted-leaf');
    expect(findFrame(written, 'WELCOME')).toBeDefined();
  });

  it('emits auth:ban event with correct data', async () => {
    const eventBus = new BotEventBus();
    const events: Array<{ ip: string; failures: number; duration: number }> = [];
    eventBus.on('auth:ban', (ip, failures, duration) => events.push({ ip, failures, duration }));

    const hub = makeHub(
      hubConfig({ max_auth_failures: 2, auth_ban_duration_ms: 60_000 }),
      '1.0.0',
      null,
      eventBus,
    );
    const ip = '10.99.0.6';

    await sendBadAuth(hub, ip);
    await sendBadAuth(hub, ip);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ ip, failures: 2, duration: 60_000 });
  });

  it('respects custom max_auth_failures config', async () => {
    const hub = makeHub(hubConfig({ max_auth_failures: 2 }), '1.0.0');
    const ip = '10.99.0.7';

    await sendBadAuth(hub, ip);
    await sendBadAuth(hub, ip);

    const { socket } = createMockSocketWithIP(ip);
    hub.addConnection(socket);
    await realTick();
    expect(socket.destroyed).toBe(true);
  });

  it('resets failure count when auth_window_ms expires', async () => {
    vi.useFakeTimers();
    const hub = makeHub(hubConfig({ max_auth_failures: 3, auth_window_ms: 5000 }), '1.0.0');
    const ip = '10.99.0.8';

    await sendBadAuth(hub, ip, fakeTick);
    await sendBadAuth(hub, ip, fakeTick);

    vi.advanceTimersByTime(5001);

    await sendBadAuth(hub, ip, fakeTick);
    await sendBadAuth(hub, ip, fakeTick);

    // Not banned (only 2 in current window)
    const { written } = await sendGoodAuth(hub, ip, 'leaf-window', fakeTick);
    expect(findFrame(written, 'WELCOME')).toBeDefined();
  });

  it('enforces per-IP pending handshake limit', async () => {
    const hub = makeHub(hubConfig({ max_pending_handshakes: 2 }), '1.0.0');
    const ip = '10.99.0.9';

    const s1 = createMockSocketWithIP(ip);
    hub.addConnection(s1.socket);
    const s2 = createMockSocketWithIP(ip);
    hub.addConnection(s2.socket);

    // 3rd should be rejected
    const s3 = createMockSocketWithIP(ip);
    hub.addConnection(s3.socket);
    await realTick();

    expect(s3.socket.destroyed).toBe(true);
    expect(s1.socket.destroyed).toBe(false);
    expect(s2.socket.destroyed).toBe(false);
  });

  it('fires handshake timeout at configured duration', async () => {
    vi.useFakeTimers();
    const hub = makeHub(hubConfig({ handshake_timeout_ms: 2000 }), '1.0.0');
    const { socket, written } = createMockSocketWithIP('10.99.0.10');
    hub.addConnection(socket);

    await vi.advanceTimersByTimeAsync(2001);

    expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'TIMEOUT' });
  });

  it('sweeps stale non-escalated tracker entries', async () => {
    vi.useFakeTimers();
    const hub = makeHub(hubConfig({ max_auth_failures: 3, auth_ban_duration_ms: 5000 }), '1.0.0');

    await sendBadAuth(hub, '10.99.1.1', fakeTick);

    vi.advanceTimersByTime(60_001);

    // Sweep runs on next connection
    const { written } = await sendGoodAuth(hub, '10.99.1.2', 'leaf-sweep', fakeTick);
    expect(findFrame(written, 'WELCOME')).toBeDefined();

    // Stale entry swept — failures start fresh
    await sendBadAuth(hub, '10.99.1.1', fakeTick);
    await sendBadAuth(hub, '10.99.1.1', fakeTick);
    // 2 < 3 — not banned
    const { written: w2 } = await sendGoodAuth(hub, '10.99.1.1', 'leaf-sweep2', fakeTick);
    expect(findFrame(w2, 'WELCOME')).toBeDefined();
  });

  it('includes IP in auth failure log', async () => {
    const warnings: string[] = [];
    const mockLogger = {
      child: () => ({
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        debug: () => {},
        error: () => {},
      }),
    };

    const hub = makeHub(hubConfig(), '1.0.0', mockLogger as never);
    await sendBadAuth(hub, '10.99.0.11');

    expect(warnings.some((w) => w.includes('10.99.0.11'))).toBe(true);
  });

  it('includes IP in auth success log', async () => {
    const infos: string[] = [];
    const mockLogger = {
      child: () => ({
        info: (msg: string) => infos.push(msg),
        warn: () => {},
        debug: () => {},
        error: () => {},
      }),
    };

    const hub = makeHub(hubConfig(), '1.0.0', mockLogger as never);
    await sendGoodAuth(hub, '10.99.0.12', 'leaf-log');

    expect(infos.some((i) => i.includes('10.99.0.12'))).toBe(true);
  });

  it('sweeps escalated tracker entries 24h after ban expiry', async () => {
    vi.useFakeTimers();
    const hub = makeHub(
      hubConfig({ max_auth_failures: 1, auth_ban_duration_ms: 1000, auth_window_ms: 1000 }),
      '1.0.0',
    );
    const ip = '10.99.2.1';

    // Trigger a ban (banCount becomes 1)
    await sendBadAuth(hub, ip, fakeTick);

    // Advance past the ban (1s) + auth window (1s)
    vi.advanceTimersByTime(2001);

    // Trigger sweep by connecting from a different IP — escalated entry NOT swept yet
    await sendGoodAuth(hub, '10.99.2.2', 'leaf-sweep-a', fakeTick);

    // Same IP fails again — should escalate (banCount was preserved)
    await sendBadAuth(hub, ip, fakeTick);

    // Ban duration is now 2000ms (doubled). Advance past it.
    vi.advanceTimersByTime(2001);

    // Now advance 24 hours past the ban expiry — escalated entry should be swept
    vi.advanceTimersByTime(86_400_001);

    // Trigger sweep
    await sendGoodAuth(hub, '10.99.2.3', 'leaf-sweep-b', fakeTick);

    // Same IP fails again — should start fresh (banCount reset by sweep)
    const eventBus = new BotEventBus();
    const bans: number[] = [];
    eventBus.on('auth:ban', (_ip, _f, dur) => bans.push(dur));

    // We need a new hub for event tracking, but we can verify the behavior:
    // After sweep, the IP should be able to fail without immediately escalating.
    // The entry was cleared, so 1 failure = ban at base duration (1000ms, not 2000ms).
    await sendBadAuth(hub, ip, fakeTick);

    // If the escalation info was preserved, the ban would be 4000ms.
    // If swept (fresh counter), the ban is 1000ms. We can't directly check
    // the ban duration without an event bus, but we can verify the IP
    // isn't immediately rejected (ban is fresh, not a stale escalated one).
    vi.advanceTimersByTime(1001);

    const { written } = await sendGoodAuth(hub, ip, 'leaf-after-sweep', fakeTick);
    expect(findFrame(written, 'WELCOME')).toBeDefined();
  });

  it('promotes touched authTracker entries to most-recently-used (LRU)', async () => {
    const hub = makeHub(hubConfig({ max_auth_failures: 99 }), '1.0.0');
    const auth = hub.auth;

    await sendBadAuth(hub, '10.50.0.1');
    await sendBadAuth(hub, '10.50.0.2');
    await sendBadAuth(hub, '10.50.0.3');
    expect(Array.from(auth.authTracker.keys())).toEqual(['10.50.0.1', '10.50.0.2', '10.50.0.3']);

    // Touch the first IP again — it should be promoted to the end.
    await sendBadAuth(hub, '10.50.0.1');
    expect(Array.from(auth.authTracker.keys())).toEqual(['10.50.0.2', '10.50.0.3', '10.50.0.1']);
  });

  it('LRU-evicts the oldest authTracker entry when the hard cap is hit', async () => {
    const hub = makeHub(hubConfig({ max_auth_failures: 99 }), '1.0.0');
    const auth = hub.auth;

    // Seed 10_000 entries directly to fill the cap, then trigger one more
    // failure — the oldest seeded entry should be evicted.
    const now = Date.now();
    for (let i = 0; i < 10_000; i++) {
      auth.authTracker.set(`10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`, {
        failures: 0,
        firstFailure: now,
        bannedUntil: 0,
        banCount: 0,
        lastFailure: now,
      });
    }
    const oldestKey = auth.authTracker.keys().next().value!;
    expect(auth.authTracker.size).toBe(10_000);

    // A brand-new IP triggers eviction of the oldest seeded entry.
    await sendBadAuth(hub, '192.0.2.123');
    expect(auth.authTracker.has(oldestKey)).toBe(false);
    expect(auth.authTracker.has('192.0.2.123')).toBe(true);
    expect(auth.authTracker.size).toBe(10_000);
  });

  it('sweeps expired CIDR manual bans on connection-driven sweep', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const auth = hub.auth;

    // Seed an expired CIDR ban directly, then trigger sweep via a connection.
    auth.manualCidrBans.set('203.0.113.0/24', {
      ip: '203.0.113.0/24',
      bannedUntil: Date.now() - 1000, // expired 1s ago
      reason: 'old',
      setBy: 'test',
      setAt: Date.now() - 60_000,
    });

    // Any new connection drives `admit()` which calls `sweepStaleTrackers()`.
    await sendGoodAuth(hub, '198.51.100.1', 'leaf-sweep-cidr');

    expect(auth.manualCidrBans.has('203.0.113.0/24')).toBe(false);
  });

  it('rejects new CIDR bans once MAX_CIDR_BANS is reached', () => {
    const warnings: string[] = [];
    const mockLogger = {
      child: () => ({
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        debug: () => {},
        error: () => {},
      }),
    };
    const hub = makeHub(hubConfig(), '1.0.0', mockLogger as never);

    // Seed the manualCidrBans map directly to skip 500 round-trips.
    const auth = hub.auth;
    for (let i = 0; i < 500; i++) {
      auth.manualCidrBans.set(`10.${Math.floor(i / 256)}.${i % 256}.0/24`, {
        ip: `10.${Math.floor(i / 256)}.${i % 256}.0/24`,
        bannedUntil: 0,
        reason: 'seed',
        setBy: 'test',
        setAt: Date.now(),
      });
    }

    // The 501st should be rejected with a warning.
    hub.manualBan('192.168.99.0/24', 0, 'overflow', 'admin');
    expect(warnings.some((w) => w.includes('CIDR ban limit'))).toBe(true);
    expect(auth.manualCidrBans.has('192.168.99.0/24')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-ban audit row
// ---------------------------------------------------------------------------

describe('botlink auto-ban audit', () => {
  it('writes a botlink-autoban row when noteFailure escalates to a ban', async () => {
    const { BotDatabase } = await import('../../src/database');
    const { BotLinkAuthManager } = await import('../../src/core/botlink');
    const db = new BotDatabase(':memory:');
    db.open();

    const auth = new BotLinkAuthManager(
      hubConfig({ max_auth_failures: 2, auth_ban_duration_ms: 5000 }),
      null,
      null,
      db,
    );

    auth.noteFailure('10.99.99.1', false);
    auth.noteFailure('10.99.99.1', false); // triggers the auto-ban

    const rows = db.getModLog({ action: 'botlink-autoban' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('botlink');
    expect(rows[0].target).toBe('10.99.99.1');
    expect(rows[0].outcome).toBe('failure');
    expect(rows[0].reason).toContain('2 auth failures');
    expect(rows[0].metadata).toMatchObject({ banDurationMs: 5000, escalationTier: 1 });

    auth.dispose();
    db.close();
  });

  it('escalates the tier on repeat auto-bans', async () => {
    const { BotDatabase } = await import('../../src/database');
    const { BotLinkAuthManager } = await import('../../src/core/botlink');
    vi.useFakeTimers();
    const db = new BotDatabase(':memory:');
    db.open();

    const auth = new BotLinkAuthManager(
      hubConfig({ max_auth_failures: 1, auth_ban_duration_ms: 1000 }),
      null,
      null,
      db,
    );

    auth.noteFailure('10.99.99.2', false);
    vi.advanceTimersByTime(60_001); // window expires
    auth.noteFailure('10.99.99.2', false);

    const rows = db.getModLog({ action: 'botlink-autoban' });
    expect(rows).toHaveLength(2);
    // newest-first ordering
    expect(rows[0].metadata).toMatchObject({ escalationTier: 2 });
    expect(rows[1].metadata).toMatchObject({ escalationTier: 1 });

    auth.dispose();
    db.close();
  });
});
