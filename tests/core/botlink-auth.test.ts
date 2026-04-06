// Auth brute-force protection tests for BotLinkHub.
// Separate file to avoid test contamination from botlink.test.ts timer interactions.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotLinkHub, isWhitelisted } from '../../src/core/botlink-hub';
import { hashPassword } from '../../src/core/botlink-protocol';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';
import { createMockSocket, parseWritten, pushFrame } from '../helpers/mock-socket';

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
const TEST_HASH = hashPassword(TEST_PASSWORD);

function hubConfig(overrides?: Partial<BotlinkConfig>): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'hub',
    listen: { host: '0.0.0.0', port: 15051 },
    password: TEST_PASSWORD,
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
  pushFrame(duplex, {
    type: 'HELLO',
    botname: 'scanner',
    password: 'scrypt:wrong',
    version: '1.0',
  });
  await tick();
  return { socket, written, duplex };
}

async function sendGoodAuth(hub: BotLinkHub, ip: string, botname: string, tick = realTick) {
  const { socket, written, duplex } = createMockSocketWithIP(ip);
  hub.addConnection(socket);
  pushFrame(duplex, { type: 'HELLO', botname, password: TEST_HASH, version: '1.0' });
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
    const hub = new BotLinkHub(hubConfig({ max_auth_failures: 5 }), '1.0.0');
    const ip = '10.99.0.1';

    for (let i = 0; i < 4; i++) {
      await sendBadAuth(hub, ip);
    }

    // 5th triggers ban, but this connection still gets AUTH_FAILED
    const { written } = await sendBadAuth(hub, ip);
    const frames = parseWritten(written);
    expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'AUTH_FAILED' });
  });

  it('bans after max_auth_failures and immediately drops next connection', async () => {
    const hub = new BotLinkHub(hubConfig({ max_auth_failures: 3 }), '1.0.0');
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
    const hub = new BotLinkHub(
      hubConfig({ max_auth_failures: 3, auth_ban_duration_ms: 10_000 }),
      '1.0.0',
    );
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
    const frames = parseWritten(written);
    expect(frames[0]).toMatchObject({ type: 'WELCOME' });
  });

  it('escalates ban duration: doubles each time, caps at 24h', async () => {
    vi.useFakeTimers();
    const eventBus = new BotEventBus();
    const bans: number[] = [];
    eventBus.on('auth:ban', (_ip, _failures, duration) => bans.push(duration));

    const hub = new BotLinkHub(
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

    // Verify cap at 24h
    const MAX_BAN = 86_400_000;
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(MAX_BAN + 1);
      await sendBadAuth(hub, ip, fakeTick);
    }
    expect(bans[bans.length - 1]).toBe(MAX_BAN);
  });

  it('whitelisted IPs are never tracked or banned', async () => {
    const hub = new BotLinkHub(
      hubConfig({ max_auth_failures: 1, auth_ip_whitelist: ['10.0.0.0/8'] }),
      '1.0.0',
    );
    const ip = '10.0.0.50';

    for (let i = 0; i < 10; i++) {
      await sendBadAuth(hub, ip);
    }

    const { written } = await sendGoodAuth(hub, ip, 'trusted-leaf');
    const frames = parseWritten(written);
    expect(frames[0]).toMatchObject({ type: 'WELCOME' });
  });

  it('emits auth:ban event with correct data', async () => {
    const eventBus = new BotEventBus();
    const events: Array<{ ip: string; failures: number; duration: number }> = [];
    eventBus.on('auth:ban', (ip, failures, duration) => events.push({ ip, failures, duration }));

    const hub = new BotLinkHub(
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
    const hub = new BotLinkHub(hubConfig({ max_auth_failures: 2 }), '1.0.0');
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
    const hub = new BotLinkHub(hubConfig({ max_auth_failures: 3, auth_window_ms: 5000 }), '1.0.0');
    const ip = '10.99.0.8';

    await sendBadAuth(hub, ip, fakeTick);
    await sendBadAuth(hub, ip, fakeTick);

    vi.advanceTimersByTime(5001);

    await sendBadAuth(hub, ip, fakeTick);
    await sendBadAuth(hub, ip, fakeTick);

    // Not banned (only 2 in current window)
    const { written } = await sendGoodAuth(hub, ip, 'leaf-window', fakeTick);
    const frames = parseWritten(written);
    expect(frames[0]).toMatchObject({ type: 'WELCOME' });
  });

  it('enforces per-IP pending handshake limit', async () => {
    const hub = new BotLinkHub(hubConfig({ max_pending_handshakes: 2 }), '1.0.0');
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
    const hub = new BotLinkHub(hubConfig({ handshake_timeout_ms: 2000 }), '1.0.0');
    const { socket, written } = createMockSocketWithIP('10.99.0.10');
    hub.addConnection(socket);

    await vi.advanceTimersByTimeAsync(2001);

    const frames = parseWritten(written);
    expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'TIMEOUT' });
  });

  it('sweeps stale non-escalated tracker entries', async () => {
    vi.useFakeTimers();
    const hub = new BotLinkHub(
      hubConfig({ max_auth_failures: 3, auth_ban_duration_ms: 5000 }),
      '1.0.0',
    );

    await sendBadAuth(hub, '10.99.1.1', fakeTick);

    vi.advanceTimersByTime(60_001);

    // Sweep runs on next connection
    const { written } = await sendGoodAuth(hub, '10.99.1.2', 'leaf-sweep', fakeTick);
    expect(parseWritten(written)[0]).toMatchObject({ type: 'WELCOME' });

    // Stale entry swept — failures start fresh
    await sendBadAuth(hub, '10.99.1.1', fakeTick);
    await sendBadAuth(hub, '10.99.1.1', fakeTick);
    // 2 < 3 — not banned
    const { written: w2 } = await sendGoodAuth(hub, '10.99.1.1', 'leaf-sweep2', fakeTick);
    expect(parseWritten(w2)[0]).toMatchObject({ type: 'WELCOME' });
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

    const hub = new BotLinkHub(hubConfig(), '1.0.0', mockLogger as never);
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

    const hub = new BotLinkHub(hubConfig(), '1.0.0', mockLogger as never);
    await sendGoodAuth(hub, '10.99.0.12', 'leaf-log');

    expect(infos.some((i) => i.includes('10.99.0.12'))).toBe(true);
  });
});
