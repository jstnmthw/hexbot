import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import {
  BotLinkHub,
  BotLinkLeaf,
  BotLinkProtocol,
  type LinkFrame,
  MAX_FRAME_SIZE,
  RateCounter,
  type SocketFactory,
  computeHelloHmac,
  deriveLinkKey,
  sanitizeFrame,
  verifyHelloHmac,
} from '../../src/core/botlink';
import { Permissions } from '../../src/core/permissions';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';
import {
  TEST_LINK_SALT,
  answerHelloChallenge,
  createMockSocket,
  findFrame,
  parseWritten,
  pushFrame,
  testLinkKey,
} from '../helpers/mock-socket';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for async processing (microtasks). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
    ping_interval_ms: 60_000, // Long interval to avoid timer noise in tests
    link_timeout_ms: 120_000,
    ...overrides,
  };
}

function leafConfig(overrides?: Partial<BotlinkConfig>): BotlinkConfig {
  return {
    enabled: true,
    role: 'leaf',
    botname: 'leaf1',
    hub: { host: '127.0.0.1', port: 15051 },
    password: TEST_PASSWORD,
    link_salt: TEST_LINK_SALT,
    reconnect_delay_ms: 100,
    reconnect_max_delay_ms: 1000,
    ping_interval_ms: 60_000,
    link_timeout_ms: 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HELLO challenge-response helpers: deriveLinkKey / computeHelloHmac /
// verifyHelloHmac round-trips
// ---------------------------------------------------------------------------

describe('deriveLinkKey + computeHelloHmac round-trip', () => {
  const salt = TEST_LINK_SALT;

  it('returns 32-byte key and HMAC is deterministic for same inputs', () => {
    const key = deriveLinkKey('hello', salt);
    expect(key).toHaveLength(32);
    const nonce = Buffer.from('a'.repeat(64), 'hex');
    expect(computeHelloHmac(key, nonce)).toBe(computeHelloHmac(key, nonce));
  });

  it('different nonce produces different HMAC', () => {
    const key = deriveLinkKey('test', salt);
    const a = computeHelloHmac(key, Buffer.from('aa'.repeat(32), 'hex'));
    const b = computeHelloHmac(key, Buffer.from('bb'.repeat(32), 'hex'));
    expect(a).not.toBe(b);
  });

  it('different password produces different HMAC for same nonce', () => {
    const nonce = Buffer.from('c'.repeat(64), 'hex');
    const a = computeHelloHmac(deriveLinkKey('alpha', salt), nonce);
    const b = computeHelloHmac(deriveLinkKey('beta', salt), nonce);
    expect(a).not.toBe(b);
  });

  it('different salt produces different HMAC for same password + nonce', () => {
    const nonce = Buffer.from('d'.repeat(64), 'hex');
    const saltA = '00'.repeat(32);
    const saltB = 'ff'.repeat(32);
    const a = computeHelloHmac(deriveLinkKey('shared', saltA), nonce);
    const b = computeHelloHmac(deriveLinkKey('shared', saltB), nonce);
    expect(a).not.toBe(b);
  });

  it('verifyHelloHmac accepts matching HMAC and rejects a tampered one', () => {
    const key = deriveLinkKey('roundtrip', salt);
    const nonce = Buffer.from('e'.repeat(64), 'hex');
    const good = computeHelloHmac(key, nonce);
    expect(verifyHelloHmac(key, nonce, good)).toBe(true);
    expect(verifyHelloHmac(key, nonce, good.replace(/.$/, '0'))).toBe(false);
  });

  it('deriveLinkKey rejects short or non-hex salts', () => {
    expect(() => deriveLinkKey('pw', 'short')).toThrow(/hex/);
    expect(() => deriveLinkKey('pw', 'zz'.repeat(32))).toThrow(/hex/);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFrame
// ---------------------------------------------------------------------------

describe('sanitizeFrame', () => {
  it('strips \\r\\n from string values', () => {
    const frame: Record<string, unknown> = { type: 'TEST', message: 'hello\r\nworld' };
    sanitizeFrame(frame);
    expect(frame.message).toBe('helloworld');
  });

  it('strips \\0 from string values', () => {
    const frame: Record<string, unknown> = { type: 'TEST', data: 'foo\0bar' };
    sanitizeFrame(frame);
    expect(frame.data).toBe('foobar');
  });

  it('sanitizes nested objects', () => {
    const frame: Record<string, unknown> = { type: 'T', nested: { val: 'a\nb' } };
    sanitizeFrame(frame);
    expect((frame.nested as Record<string, string>).val).toBe('ab');
  });

  it('sanitizes arrays of strings', () => {
    const frame: Record<string, unknown> = { type: 'T', items: ['a\rb', 'c\nd'] };
    sanitizeFrame(frame);
    expect(frame.items).toEqual(['ab', 'cd']);
  });

  it('sanitizes objects inside arrays', () => {
    const frame: Record<string, unknown> = { type: 'T', users: [{ nick: 'a\r\nb' }] };
    sanitizeFrame(frame);
    expect((frame.users as Record<string, string>[])[0].nick).toBe('ab');
  });

  it('leaves numbers and booleans untouched', () => {
    const frame: Record<string, unknown> = { type: 'T', count: 42, flag: true };
    sanitizeFrame(frame);
    expect(frame.count).toBe(42);
    expect(frame.flag).toBe(true);
  });

  it('skips null elements in arrays', () => {
    const frame: Record<string, unknown> = { type: 'T', items: ['a\rb', null, 42, true] };
    sanitizeFrame(frame);
    expect(frame.items).toEqual(['ab', null, 42, true]);
  });
});

// ---------------------------------------------------------------------------
// RateCounter
// ---------------------------------------------------------------------------

describe('RateCounter', () => {
  it('allows up to the limit', () => {
    const counter = new RateCounter(3, 1_000);
    expect(counter.check()).toBe(true);
    expect(counter.check()).toBe(true);
    expect(counter.check()).toBe(true);
    expect(counter.check()).toBe(false);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    try {
      const counter = new RateCounter(2, 1_000);
      expect(counter.check()).toBe(true);
      expect(counter.check()).toBe(true);
      expect(counter.check()).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(counter.check()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() clears the counter', () => {
    const counter = new RateCounter(1, 1_000);
    expect(counter.check()).toBe(true);
    expect(counter.check()).toBe(false);
    counter.reset();
    expect(counter.check()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BotLinkProtocol
// ---------------------------------------------------------------------------

describe('BotLinkProtocol', () => {
  it('receives and parses a JSON frame', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    pushFrame(duplex, { type: 'PING', seq: 1 });
    await tick();

    expect(received).toEqual([{ type: 'PING', seq: 1 }]);
  });

  it('sends a JSON frame with \\r\\n terminator', () => {
    const { socket, written } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);

    protocol.send({ type: 'PONG', seq: 1 });

    const frames = parseWritten(written);
    expect(frames).toEqual([{ type: 'PONG', seq: 1 }]);
    // Check raw output has \r\n
    expect(written[0]).toContain('\r\n');
  });

  it('round-trips a frame', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    const original = { type: 'CHAN', channel: '#test', topic: 'Hello', users: [] };
    pushFrame(duplex, original);
    await tick();

    expect(received[0]).toEqual(original);
  });

  it('sanitizes string fields in incoming frames', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    // Push raw JSON with \r\n embedded in a string value (not in the frame delimiter).
    // Use a known frame type — the unknown-frame allowlist is verified
    // separately and would otherwise drop the test frame before we got
    // a chance to inspect the sanitized payload.
    const raw = JSON.stringify({ type: 'PARTY_CHAT', nick: 'evil\r\nPRIVMSG #hack :pwned' });
    duplex.push(raw + '\r\n');
    await tick();

    expect(received[0].nick).toBe('evilPRIVMSG #hack :pwned');
  });

  it('rejects frames exceeding 64KB', async () => {
    const { socket, written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    // Push a line that exceeds MAX_FRAME_SIZE
    const bigPayload = 'x'.repeat(MAX_FRAME_SIZE + 1);
    duplex.push(bigPayload + '\r\n');
    await tick();

    expect(received).toEqual([]); // Frame was rejected
    // Hub should have sent an ERROR frame
    const sent = parseWritten(written);
    expect(sent.some((f) => f.type === 'ERROR' && f.code === 'FRAME_TOO_LARGE')).toBe(true);
  });

  it('rejects outbound frames exceeding 64KB', () => {
    const { socket } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);

    const bigData = 'x'.repeat(MAX_FRAME_SIZE);
    const result = protocol.send({ type: 'TEST', data: bigData });
    expect(result).toBe(false);
  });

  it('ignores frames with no type field', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    duplex.push('{"noType": true}\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('ignores malformed JSON', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    duplex.push('not json at all\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('returns false from send() when closed', () => {
    const { socket } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    protocol.close();

    expect(protocol.send({ type: 'PING', seq: 1 })).toBe(false);
    expect(protocol.isClosed).toBe(true);
  });

  it('fires onClose when socket closes', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    let closed = false;
    protocol.onClose = () => {
      closed = true;
    };

    duplex.destroy();
    await tick();

    expect(closed).toBe(true);
    expect(protocol.isClosed).toBe(true);
  });

  it('exposes remoteAddress from the underlying socket', () => {
    const { socket } = createMockSocket();
    (socket as unknown as Record<string, unknown>).remoteAddress = '10.0.0.5';
    const protocol = new BotLinkProtocol(socket, null);

    expect(protocol.remoteAddress).toBe('10.0.0.5');
  });

  it('returns undefined remoteAddress when socket has none', () => {
    const { socket } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);

    expect(protocol.remoteAddress).toBeUndefined();
  });

  // onError is a trivial passthrough — not tested directly because
  // Duplex streams throw on emit('error') in unit test contexts.
});

// ---------------------------------------------------------------------------
// BotLinkHub — handshake
// ---------------------------------------------------------------------------

describe('BotLinkHub', () => {
  describe('handshake', () => {
    it('accepts a valid HELLO and sends WELCOME + SYNC_START/END', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const frames = parseWritten(written);
      const types = frames.map((f) => f.type);
      expect(types).toEqual(['HELLO_CHALLENGE', 'WELCOME', 'SYNC_START', 'SYNC_END']);
      expect(findFrame(written, 'WELCOME')?.botname).toBe('hub');
      expect(hub.getLeaves()).toEqual(['leaf1']);
    });

    it('fires onLeafConnected callback', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const connected: string[] = [];
      hub.onLeafConnected = (name) => connected.push(name);

      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      expect(connected).toEqual(['leaf1']);
    });

    it('rejects wrong HMAC with AUTH_FAILED', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      // Any 64-hex string that isn't the real HMAC for the issued nonce
      // is rejected. We don't look at the CHALLENGE — we just send a
      // syntactically valid HELLO with a wrong hmac.
      pushFrame(duplex, {
        type: 'HELLO',
        botname: 'leaf1',
        hmac: 'f'.repeat(64),
        version: '1.0',
      });
      await tick();

      expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'AUTH_FAILED' });
      expect(hub.getLeaves()).toEqual([]);
    });

    it('rejects pre-v2 HELLO that still carries `password`', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      pushFrame(duplex, {
        type: 'HELLO',
        botname: 'leaf1',
        password: 'scrypt:deadbeef',
        version: '1.0',
      });
      await tick();

      expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'PROTOCOL' });
    });

    it('rejects HELLO missing hmac with PROTOCOL', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      pushFrame(duplex, { type: 'HELLO', botname: 'leaf1', version: '1.0' });
      await tick();

      expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'PROTOCOL' });
    });

    it('rejects duplicate botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');

      // Connect first leaf
      const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
      hub.addConnection(socket1);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();

      // Try to connect with same botname
      const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
      hub.addConnection(socket2);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf1');
      await tick();

      expect(findFrame(written2, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'DUPLICATE' });
    });

    it('rejects when hub is at max capacity', async () => {
      const hub = new BotLinkHub(hubConfig({ max_leaves: 1 }), '1.0.0');

      const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
      hub.addConnection(socket1);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();

      const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
      hub.addConnection(socket2);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
      await tick();

      expect(findFrame(written2, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'FULL' });
    });

    it('rejects missing botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      answerHelloChallenge(written, duplex, TEST_LINK_KEY, '');
      await tick();

      expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'INVALID' });
    });

    it('rejects non-HELLO as first frame', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);

      pushFrame(duplex, { type: 'PING', seq: 1 });
      await tick();

      expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'PROTOCOL' });
    });

    it('times out if HELLO not received within 30s', async () => {
      vi.useFakeTimers();
      try {
        const hub = new BotLinkHub(hubConfig(), '1.0.0');
        const { socket, written } = createMockSocket();
        hub.addConnection(socket);

        await vi.advanceTimersByTimeAsync(30_001);

        expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'TIMEOUT' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('broadcasts BOTJOIN to existing leaves', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');

      // Connect leaf1
      const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
      hub.addConnection(socket1);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();
      written1.length = 0; // Clear initial frames

      // Connect leaf2
      const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
      hub.addConnection(socket2);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
      await tick();

      // leaf1 should have received BOTJOIN for leaf2
      const leaf1Frames = parseWritten(written1);
      expect(leaf1Frames.some((f) => f.type === 'BOTJOIN' && f.botname === 'leaf2')).toBe(true);
    });

    it('calls onSyncRequest during handshake', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      hub.onSyncRequest = (_botname, send) => {
        send({ type: 'ADDUSER', handle: 'admin', hostmasks: ['*!*@admin.host'] });
      };

      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const frames = parseWritten(written);
      const types = frames.map((f) => f.type);
      expect(types).toEqual(['HELLO_CHALLENGE', 'WELCOME', 'SYNC_START', 'ADDUSER', 'SYNC_END']);
    });
  });

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  describe('fan-out', () => {
    let hub: BotLinkHub;
    let written1: string[];
    let written2: string[];
    let written3: string[];
    let duplex1: Duplex;
    let duplex2: Duplex;
    let duplex3: Duplex;

    beforeEach(async () => {
      hub = new BotLinkHub(hubConfig(), '1.0.0');

      const m1 = createMockSocket();
      const m2 = createMockSocket();
      const m3 = createMockSocket();
      written1 = m1.written;
      written2 = m2.written;
      written3 = m3.written;
      duplex1 = m1.duplex;
      duplex2 = m2.duplex;
      duplex3 = m3.duplex;

      hub.addConnection(m1.socket);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();

      hub.addConnection(m2.socket);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
      await tick();

      hub.addConnection(m3.socket);
      answerHelloChallenge(written3, duplex3, TEST_LINK_KEY, 'leaf3');
      await tick();

      // Clear handshake frames
      written1.length = 0;
      written2.length = 0;
      written3.length = 0;
    });

    afterEach(() => {
      hub.close();
    });

    it('forwards a BOTJOIN frame from leaf1 to leaf2 and leaf3 but NOT back to leaf1', async () => {
      const joinFrame = { type: 'BOTJOIN', channel: '#test', nick: 'user1' };
      pushFrame(duplex1, joinFrame);
      await tick();

      expect(parseWritten(written1)).toEqual([]); // Not echoed back
      expect(parseWritten(written2)).toContainEqual(joinFrame);
      expect(parseWritten(written3)).toContainEqual(joinFrame);
    });

    it('forwards PARTY_CHAT to other leaves', async () => {
      const chat = { type: 'PARTY_CHAT', handle: 'admin', fromBot: 'leaf1', message: 'hello' };
      pushFrame(duplex1, chat);
      await tick();

      expect(parseWritten(written2)).toContainEqual(chat);
      expect(parseWritten(written3)).toContainEqual(chat);
      expect(parseWritten(written1)).toEqual([]);
    });

    it('does NOT fan-out CMD frames (hub-only)', async () => {
      pushFrame(duplex1, { type: 'CMD', command: '.users', args: '', fromHandle: 'admin' });
      await tick();

      expect(parseWritten(written2)).toEqual([]);
      expect(parseWritten(written3)).toEqual([]);
    });

    it('does NOT fan-out PROTECT_ACK frames (hub-routed)', async () => {
      pushFrame(duplex1, { type: 'PROTECT_ACK', ref: 'abc', success: true });
      await tick();

      expect(parseWritten(written2)).toEqual([]);
    });

    it('does NOT fan-out ADDUSER/SETFLAGS/DELUSER frames from leaves (privilege escalation prevention)', async () => {
      // A compromised leaf must not be able to inject permission records into other leaves
      pushFrame(duplex1, {
        type: 'ADDUSER',
        handle: 'backdoor',
        hostmasks: ['*!*@*'],
        globalFlags: 'n',
        channelFlags: {},
      });
      pushFrame(duplex1, {
        type: 'SETFLAGS',
        handle: 'existing',
        hostmasks: ['*!*@host'],
        globalFlags: 'n',
        channelFlags: {},
      });
      pushFrame(duplex1, { type: 'DELUSER', handle: 'admin' });
      await tick();

      const frames2 = parseWritten(written2);
      const frames3 = parseWritten(written3);
      expect(frames2.filter((f) => f.type === 'ADDUSER')).toEqual([]);
      expect(frames2.filter((f) => f.type === 'SETFLAGS')).toEqual([]);
      expect(frames2.filter((f) => f.type === 'DELUSER')).toEqual([]);
      expect(frames3.filter((f) => f.type === 'ADDUSER')).toEqual([]);
      expect(frames3.filter((f) => f.type === 'SETFLAGS')).toEqual([]);
      expect(frames3.filter((f) => f.type === 'DELUSER')).toEqual([]);
    });

    it('fans out PROTECT_OP to other leaves', async () => {
      const protectOp = {
        type: 'PROTECT_OP',
        channel: '#chan',
        nick: 'bot1',
        requestedBy: 'leaf1',
      };
      pushFrame(duplex1, protectOp);
      await tick();

      expect(parseWritten(written2)).toContainEqual(protectOp);
      expect(parseWritten(written3)).toContainEqual(protectOp);
    });

    it('notifies onLeafFrame for all steady-state frames', async () => {
      const received: Array<{ botname: string; frame: LinkFrame }> = [];
      hub.onLeafFrame = (botname, frame) => received.push({ botname, frame });

      pushFrame(duplex1, { type: 'BOTJOIN', channel: '#test', nick: 'u' });
      pushFrame(duplex2, { type: 'CMD', command: '.help', args: '', fromHandle: 'op' });
      await tick();

      expect(received).toHaveLength(2);
      expect(received[0].botname).toBe('leaf1');
      expect(received[1].botname).toBe('leaf2');
    });

    it('broadcasts BOTPART when a leaf disconnects', async () => {
      written2.length = 0;
      written3.length = 0;
      duplex1.destroy();
      await tick();

      const leaf2Frames = parseWritten(written2);
      const leaf3Frames = parseWritten(written3);
      expect(leaf2Frames.some((f) => f.type === 'BOTPART' && f.botname === 'leaf1')).toBe(true);
      expect(leaf3Frames.some((f) => f.type === 'BOTPART' && f.botname === 'leaf1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // disconnectLeaf
  // -------------------------------------------------------------------------

  describe('disconnectLeaf', () => {
    it('sends ERROR frame, closes connection, removes from leaves, and broadcasts BOTPART', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
      const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
      let disconnectedBot = '';
      let disconnectReason = '';
      hub.onLeafDisconnected = (botname, reason) => {
        disconnectedBot = botname;
        disconnectReason = reason;
      };

      hub.addConnection(socket1);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();
      hub.addConnection(socket2);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
      await tick();
      written1.length = 0;
      written2.length = 0;

      const result = hub.disconnectLeaf('leaf1');
      expect(result).toBe(true);

      // leaf1 should have received an ERROR frame
      const frames1 = parseWritten(written1);
      expect(frames1.some((f) => f.type === 'ERROR' && f.code === 'CLOSING')).toBe(true);

      // leaf2 should have received a BOTPART
      const frames2 = parseWritten(written2);
      expect(frames2.some((f) => f.type === 'BOTPART' && f.botname === 'leaf1')).toBe(true);

      // leaf1 should be removed from the hub
      expect(hub.getLeaves()).toEqual(['leaf2']);

      // Callback fired
      expect(disconnectedBot).toBe('leaf1');
      expect(disconnectReason).toBe('Disconnected by admin');

      hub.close();
    });

    it('returns false for unknown botname', () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      expect(hub.disconnectLeaf('nonexistent')).toBe(false);
      hub.close();
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('rate-limits CMD frames at 10/sec', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();
      written.length = 0;

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // Send 11 CMD frames rapidly
      for (let i = 0; i < 11; i++) {
        pushFrame(duplex, { type: 'CMD', command: '.help', args: '', fromHandle: 'admin' });
      }
      await tick();

      // 10 should go through, 11th should be rate-limited
      const cmdFrames = received.filter((f) => f.type === 'CMD');
      expect(cmdFrames).toHaveLength(10);

      // Leaf should receive ERROR for the rate-limited one
      const sent = parseWritten(written);
      expect(sent.some((f) => f.type === 'ERROR' && f.code === 'RATE_LIMITED')).toBe(true);

      hub.close();
    });

    it('rate-limits PARTY_CHAT at 5/sec and silently drops', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();
      written.length = 0;

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      for (let i = 0; i < 7; i++) {
        pushFrame(duplex, {
          type: 'PARTY_CHAT',
          handle: 'admin',
          fromBot: 'leaf1',
          message: `msg${i}`,
        });
      }
      await tick();

      const chatFrames = received.filter((f) => f.type === 'PARTY_CHAT');
      expect(chatFrames).toHaveLength(5);

      // No ERROR sent — silently dropped
      const sent = parseWritten(written);
      expect(sent.every((f) => f.type !== 'ERROR')).toBe(true);

      hub.close();
    });

    it('rate-limits PROTECT_* frames at 20/sec', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // Send 25 PROTECT_OP frames rapidly — first 20 pass, rest silently dropped
      for (let i = 0; i < 25; i++) {
        pushFrame(duplex, {
          type: 'PROTECT_OP',
          channel: '#chan',
          nick: 'bot',
          requestedBy: 'leaf1',
        });
      }
      await tick();

      expect(received.filter((f) => f.type === 'PROTECT_OP')).toHaveLength(20);

      hub.close();
    });
  });

  describe('identity enforcement', () => {
    it('hub overwrites fromBot with authenticated botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // Send a PARTY_CHAT with a spoofed fromBot
      pushFrame(duplex, {
        type: 'PARTY_CHAT',
        handle: 'admin',
        fromBot: 'spoofed-bot',
        message: 'hello',
      });
      await tick();

      // The hub should have overwritten fromBot to 'leaf1'
      const chat = received.find((f) => f.type === 'PARTY_CHAT');
      expect(chat).toBeDefined();
      expect(chat!.fromBot).toBe('leaf1');

      hub.close();
    });

    it('frames without fromBot are passed through unchanged', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // PROTECT_ACK has no fromBot field
      pushFrame(duplex, { type: 'PROTECT_ACK', ref: 'r1', success: true });
      await tick();

      const ack = received.find((f) => f.type === 'PROTECT_ACK');
      expect(ack).toBeDefined();
      expect(ack!.fromBot).toBeUndefined();

      hub.close();
    });
  });

  // -------------------------------------------------------------------------
  // Hub management
  // -------------------------------------------------------------------------

  describe('management', () => {
    it('send() delivers frame to a specific leaf', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
      const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();

      hub.addConnection(socket1);
      answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
      await tick();

      hub.addConnection(socket2);
      answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
      await tick();

      written1.length = 0;
      written2.length = 0;

      hub.send('leaf1', { type: 'CMD_RESULT', ref: 'r1', output: ['done'] });

      expect(parseWritten(written1)).toContainEqual({
        type: 'CMD_RESULT',
        ref: 'r1',
        output: ['done'],
      });
      expect(parseWritten(written2)).toEqual([]);

      hub.close();
    });

    it('send() returns false for unknown botname', () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      expect(hub.send('unknown', { type: 'PING', seq: 1 })).toBe(false);
      hub.close();
    });

    it('getLeafInfo() returns info or null', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      expect(hub.getLeafInfo('leaf1')).toBeNull();

      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      const info = hub.getLeafInfo('leaf1');
      expect(info).not.toBeNull();
      expect(info!.botname).toBe('leaf1');
      expect(info!.connectedAt).toBeGreaterThan(0);

      hub.close();
    });

    it('close() sends ERROR to all leaves and clears state', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();
      written.length = 0;

      hub.close();

      const frames = parseWritten(written);
      expect(frames.some((f) => f.type === 'ERROR' && f.code === 'CLOSING')).toBe(true);
      expect(hub.getLeaves()).toEqual([]);
    });

    it('fires onLeafDisconnected when a leaf closes', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const disconnected: Array<{ name: string; reason: string }> = [];
      hub.onLeafDisconnected = (name, reason) => disconnected.push({ name, reason });

      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();

      duplex.destroy();
      await tick();

      expect(disconnected).toEqual([{ name: 'leaf1', reason: 'Connection lost' }]);
      expect(hub.getLeaves()).toEqual([]);

      hub.close();
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat / timeout
  // -------------------------------------------------------------------------

  describe('heartbeat', () => {
    it('responds to PING from leaf with PONG', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      hub.addConnection(socket);
      answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
      await tick();
      written.length = 0;

      pushFrame(duplex, { type: 'PING', seq: 42 });
      await tick();

      const frames = parseWritten(written);
      expect(frames).toContainEqual({ type: 'PONG', seq: 42 });

      hub.close();
    });

    it('drops a leaf that exceeds link_timeout_ms', async () => {
      vi.useFakeTimers();
      try {
        const hub = new BotLinkHub(
          hubConfig({ ping_interval_ms: 100, link_timeout_ms: 300 }),
          '1.0.0',
        );
        const disconnected: string[] = [];
        hub.onLeafDisconnected = (name) => disconnected.push(name);

        const { socket, written, duplex } = createMockSocket();
        hub.addConnection(socket);
        answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
        await vi.advanceTimersByTimeAsync(0);

        // Advance past link_timeout_ms without any messages from leaf
        await vi.advanceTimersByTimeAsync(500);

        expect(disconnected).toContain('leaf1');
        expect(hub.getLeaves()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf
// ---------------------------------------------------------------------------

describe('BotLinkLeaf', () => {
  describe('handshake', () => {
    it('responds to HELLO_CHALLENGE with an HMAC HELLO and transitions on WELCOME', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();
      let connectedHub = '';
      leaf.onConnected = (hubName) => {
        connectedHub = hubName;
      };

      leaf.connectWithSocket(socket);
      await tick();

      // Leaf should not send HELLO until it receives a CHALLENGE.
      expect(parseWritten(written)).toEqual([]);

      // Push a CHALLENGE and assert the leaf responds with a valid HMAC.
      const nonceHex = 'ab'.repeat(32);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: nonceHex, hubBotname: 'hub' });
      await tick();

      const sent = parseWritten(written);
      expect(sent[0]).toMatchObject({ type: 'HELLO', botname: 'leaf1' });
      expect(typeof sent[0].hmac).toBe('string');
      const expectedHmac = computeHelloHmac(TEST_LINK_KEY, Buffer.from(nonceHex, 'hex'));
      expect(sent[0].hmac).toBe(expectedHmac);
      expect(sent[0].password).toBeUndefined();

      // Simulate hub WELCOME (CHALLENGE already delivered above).
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      expect(leaf.isConnected).toBe(true);
      expect(leaf.hubName).toBe('hub');
      expect(connectedHub).toBe('hub');
    });

    it('handles ERROR with AUTH_FAILED without reconnecting', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const { socket, written: _written, duplex } = createMockSocket();

        leaf.connectWithSocket(socket);
        await vi.advanceTimersByTimeAsync(0);

        pushFrame(duplex, { type: 'ERROR', code: 'AUTH_FAILED', message: 'Bad password' });
        await vi.advanceTimersByTimeAsync(0);

        expect(leaf.isConnected).toBe(false);

        // Wait beyond reconnect delay — should NOT reconnect
        await vi.advanceTimersByTimeAsync(10_000);
        // (no crash, no reconnect attempt)
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards steady-state frames via onFrame', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written: _written, duplex } = createMockSocket();
      const received: LinkFrame[] = [];
      leaf.onFrame = (frame) => received.push(frame);

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      pushFrame(duplex, { type: 'SYNC_START' });
      pushFrame(duplex, { type: 'ADDUSER', handle: 'admin', hostmasks: ['*!*@host'] });
      pushFrame(duplex, { type: 'SYNC_END' });
      pushFrame(duplex, { type: 'BOTJOIN', botname: 'leaf2' });
      await tick();

      const types = received.map((f) => f.type);
      expect(types).toEqual(['SYNC_START', 'ADDUSER', 'SYNC_END', 'BOTJOIN']);
    });

    it('responds to PING with PONG in steady state', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      written.length = 0;

      pushFrame(duplex, { type: 'PING', seq: 7 });
      await tick();

      const sent = parseWritten(written);
      expect(sent).toContainEqual({ type: 'PONG', seq: 7 });
    });

    it('does not forward PING/PONG to onFrame', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written: _written, duplex } = createMockSocket();
      const received: LinkFrame[] = [];
      leaf.onFrame = (frame) => received.push(frame);

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      pushFrame(duplex, { type: 'PING', seq: 1 });
      pushFrame(duplex, { type: 'PONG', seq: 1 });
      await tick();

      expect(received).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Send methods
  // -------------------------------------------------------------------------

  describe('send methods', () => {
    it('sendCommand sends a CMD frame', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      written.length = 0;

      leaf.sendCommand('.adduser', 'newuser *!*@host m', 'admin', null);

      const sent = parseWritten(written);
      expect(sent[0]).toMatchObject({
        type: 'CMD',
        command: '.adduser',
        args: 'newuser *!*@host m',
        fromHandle: 'admin',
        fromBot: 'leaf1',
        channel: null,
      });
    });

    it('sendProtect sends a PROTECT_* frame and resolves on ACK', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      written.length = 0;

      // Start protect request (don't await yet)
      const promise = leaf.sendProtect('PROTECT_OP', '#channel', 'leaf1');
      await tick();

      const sent = parseWritten(written);
      expect(sent[0]).toMatchObject({
        type: 'PROTECT_OP',
        channel: '#channel',
        nick: 'leaf1',
        requestedBy: 'leaf1',
      });

      // Send ACK back with the ref
      pushFrame(duplex, { type: 'PROTECT_ACK', ref: sent[0].ref, success: true });
      await tick();

      expect(await promise).toBe(true);
    });

    it('send returns false when not connected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      expect(leaf.send({ type: 'TEST' })).toBe(false);
      expect(leaf.sendCommand('.help', '', 'admin', null)).toBe(false);
      expect(await leaf.sendProtect('PROTECT_OP', '#chan', 'nick')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  describe('disconnect', () => {
    it('disconnect stops reconnecting', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const { socket, written: _written, duplex } = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
        pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);

        expect(leaf.isConnected).toBe(true);
        leaf.disconnect();
        expect(leaf.isConnected).toBe(false);

        // Wait a long time — no reconnect attempt
        await vi.advanceTimersByTimeAsync(120_000);
        // (no error, no crash — leaf stays disconnected)
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires onDisconnected when connection is lost unexpectedly', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written: _written, duplex } = createMockSocket();
      let disconnectReason = '';
      leaf.onDisconnected = (reason) => {
        disconnectReason = reason;
      };

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      duplex.destroy();
      await tick();

      expect(disconnectReason).toBe('Connection lost');
    });

    it('flushes pending whom and protect requests on disconnect', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const { socket, written: _written, duplex } = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
        pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Start pending whom + protect requests (they time out after 10s/5s normally)
        const whomPromise = leaf.requestWhom();
        const protectPromise = leaf.sendProtect('PROTECT_OP', '#test', 'alice');

        // Disconnect immediately — should resolve both promises
        leaf.disconnect();

        const whomResult = await whomPromise;
        const protectResult = await protectPromise;

        expect(whomResult).toEqual([]);
        expect(protectResult).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT fire onDisconnected on explicit disconnect', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written: _written, duplex } = createMockSocket();
      let disconnectFired = false;
      leaf.onDisconnected = () => {
        disconnectFired = true;
      };

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      leaf.disconnect();
      await tick();

      expect(disconnectFired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  describe('reconnect', () => {
    it('schedules reconnect with exponential backoff after connection loss', async () => {
      vi.useFakeTimers();
      try {
        const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
        const factory: SocketFactory = () => {
          const m = createMockSocket();
          mocks.push(m);
          // Simulate immediate connection by emitting 'connect' on next tick
          setImmediate(() => m.duplex.emit('connect'));
          return m.socket;
        };

        const leaf = new BotLinkLeaf(
          leafConfig({ reconnect_delay_ms: 100, reconnect_max_delay_ms: 1000 }),
          '1.0.0',
          null,
          factory,
        );

        // First connection
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        pushFrame(mocks[0].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });
        pushFrame(mocks[0].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Simulate disconnect
        mocks[0].duplex.destroy();
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(false);

        // Should reconnect after 100ms
        await vi.advanceTimersByTimeAsync(101);
        expect(mocks).toHaveLength(2);

        // Second connection succeeds
        pushFrame(mocks[1].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });
        pushFrame(mocks[1].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reconnect() resets backoff and connects immediately', async () => {
      vi.useFakeTimers();
      try {
        const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
        const factory: SocketFactory = () => {
          const m = createMockSocket();
          mocks.push(m);
          setImmediate(() => m.duplex.emit('connect'));
          return m.socket;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);

        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        pushFrame(mocks[0].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });
        pushFrame(mocks[0].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Force reconnect
        leaf.reconnect();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks).toHaveLength(2);

        pushFrame(mocks[1].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });

        pushFrame(mocks[1].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // connect() via socketFactory
  // -------------------------------------------------------------------------

  describe('connect() via socketFactory', () => {
    it('installs protocol after TCP connect and waits for HELLO_CHALLENGE', async () => {
      vi.useFakeTimers();
      try {
        const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
        const factory: SocketFactory = () => {
          const m = createMockSocket();
          mocks.push(m);
          setImmediate(() => m.duplex.emit('connect'));
          return m.socket;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);

        expect(mocks).toHaveLength(1);
        // No HELLO written until the hub (mock) delivers a CHALLENGE.
        expect(parseWritten(mocks[0].written)).toEqual([]);

        // Push CHALLENGE and verify the leaf replies with a valid HMAC.
        const nonceHex = 'cd'.repeat(32);
        pushFrame(mocks[0].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: nonceHex,
          hubBotname: 'hub',
        });
        await vi.advanceTimersByTimeAsync(0);

        const sent = parseWritten(mocks[0].written);
        expect(sent[0]).toMatchObject({ type: 'HELLO', botname: 'leaf1' });
        expect(sent[0].hmac).toBe(computeHelloHmac(TEST_LINK_KEY, Buffer.from(nonceHex, 'hex')));
        expect(sent[0].password).toBeUndefined();

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not connect if already connected', async () => {
      vi.useFakeTimers();
      try {
        const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
        const factory: SocketFactory = () => {
          const m = createMockSocket();
          mocks.push(m);
          setImmediate(() => m.duplex.emit('connect'));
          return m.socket;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        pushFrame(mocks[0].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });
        pushFrame(mocks[0].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Second call should be a no-op
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks).toHaveLength(1);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not connect if hub host/port is missing', async () => {
      const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
      const factory: SocketFactory = () => {
        const m = createMockSocket();
        mocks.push(m);
        return m.socket;
      };

      const leaf = new BotLinkLeaf(
        leafConfig({ hub: undefined as unknown as { host: string; port: number } }),
        '1.0.0',
        null,
        factory,
      );
      leaf.connect();
      await tick();

      expect(mocks).toHaveLength(0);
    });

    it('schedules reconnect on TCP connection error', async () => {
      vi.useFakeTimers();
      try {
        const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
        let callCount = 0;
        const factory: SocketFactory = () => {
          const m = createMockSocket();
          mocks.push(m);
          callCount++;
          if (callCount === 1) {
            // First attempt: emit error
            setImmediate(() => m.duplex.emit('error', new Error('ECONNREFUSED')));
          } else {
            // Second attempt: success
            setImmediate(() => m.duplex.emit('connect'));
          }
          return m.socket;
        };

        const leaf = new BotLinkLeaf(
          leafConfig({ reconnect_delay_ms: 100, reconnect_max_delay_ms: 1000 }),
          '1.0.0',
          null,
          factory,
        );

        leaf.connect();
        await vi.advanceTimersByTimeAsync(1); // Let error fire

        expect(leaf.isConnected).toBe(false);
        expect(mocks).toHaveLength(1);

        // After reconnect_delay_ms, should try again
        await vi.advanceTimersByTimeAsync(101);
        expect(mocks).toHaveLength(2);

        // Second socket succeeds
        pushFrame(mocks[1].duplex, {
          type: 'HELLO_CHALLENGE',
          nonce: 'a'.repeat(64),
          hubBotname: 'hub',
        });
        pushFrame(mocks[1].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // requestWhom timeout
  // -------------------------------------------------------------------------

  describe('requestWhom', () => {
    it('resolves with users from PARTY_WHOM_REPLY', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written, duplex } = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      written.length = 0;

      const promise = leaf.requestWhom();
      await tick();

      const sent = parseWritten(written);
      const whomFrame = sent.find((f) => f.type === 'PARTY_WHOM');
      expect(whomFrame).toBeDefined();

      pushFrame(duplex, {
        type: 'PARTY_WHOM_REPLY',
        ref: whomFrame!.ref,
        users: [{ handle: 'admin', nick: 'Admin', botname: 'hub', connectedAt: 1000, idle: 0 }],
      });
      await tick();

      const users = await promise;
      expect(users).toHaveLength(1);
      expect(users[0].handle).toBe('admin');

      leaf.disconnect();
    });

    it('resolves empty on timeout when no reply comes', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const { socket, written: _written, duplex } = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
        pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);

        const promise = leaf.requestWhom();
        await vi.advanceTimersByTimeAsync(0);

        // Don't send any reply — let it timeout (10s)
        await vi.advanceTimersByTimeAsync(10_001);

        const users = await promise;
        expect(users).toEqual([]);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns empty immediately when not connected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const users = await leaf.requestWhom();
      expect(users).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // sendProtect timeout
  // -------------------------------------------------------------------------

  describe('sendProtect timeout', () => {
    it('resolves false on timeout when no ACK arrives', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const { socket, written, duplex } = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
        pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        written.length = 0;

        const promise = leaf.sendProtect('PROTECT_OP', '#chan', 'bot1', 2_000);
        await vi.advanceTimersByTimeAsync(0);

        // Verify the frame was sent
        const sent = parseWritten(written);
        expect(sent[0]).toMatchObject({
          type: 'PROTECT_OP',
          channel: '#chan',
          nick: 'bot1',
        });

        // Don't send ACK — let it timeout
        await vi.advanceTimersByTimeAsync(2_001);

        expect(await promise).toBe(false);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Hub: setCommandRelay permission event broadcasting
// ---------------------------------------------------------------------------

describe('BotLinkHub setCommandRelay', () => {
  async function setupHubWithLeaf(): Promise<{
    hub: BotLinkHub;
    perms: Permissions;
    eventBus: BotEventBus;
    written: string[];
  }> {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);

    handler.registerCommand(
      'test',
      { flags: '-', description: 'Test', usage: '.test', category: 'test' },
      (_args, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    return { hub, perms, eventBus, written };
  }

  it('broadcasts ADDUSER when a user is added on the hub', async () => {
    const { hub, perms, written } = await setupHubWithLeaf();

    perms.addUser('newguy', '*!new@host', 'ov');
    await tick();

    const frames = parseWritten(written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('newguy');
    expect(addFrame!.hostmasks).toEqual(['*!new@host']);
    expect(addFrame!.globalFlags).toBe('ov');

    hub.close();
  });

  it('broadcasts ADDUSER when a hostmask is added', async () => {
    const { hub, perms, written } = await setupHubWithLeaf();

    perms.addUser('someone', '*!s@host1', 'v');
    written.length = 0;

    perms.addHostmask('someone', '*!s@host2');
    await tick();

    const frames = parseWritten(written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('someone');
    expect(addFrame!.hostmasks).toContain('*!s@host1');
    expect(addFrame!.hostmasks).toContain('*!s@host2');

    hub.close();
  });

  it('broadcasts ADDUSER when a hostmask is removed', async () => {
    const { hub, perms, written } = await setupHubWithLeaf();

    perms.addUser('multi', '*!m@host1', 'o');
    perms.addHostmask('multi', '*!m@host2');
    written.length = 0;

    perms.removeHostmask('multi', '*!m@host2');
    await tick();

    const frames = parseWritten(written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('multi');
    expect(addFrame!.hostmasks).toEqual(['*!m@host1']);

    hub.close();
  });

  it('broadcasts DELUSER when a user is removed on the hub', async () => {
    const { hub, perms, written } = await setupHubWithLeaf();

    perms.addUser('temp', '*!t@host', 'v');
    written.length = 0;

    perms.removeUser('temp');
    await tick();

    const frames = parseWritten(written);
    const delFrame = frames.find((f) => f.type === 'DELUSER');
    expect(delFrame).toBeDefined();
    expect(delFrame!.handle).toBe('temp');

    hub.close();
  });

  it('broadcasts SETFLAGS when flags change', async () => {
    const { hub, perms, written } = await setupHubWithLeaf();

    perms.addUser('flaguser', '*!f@host', 'v');
    written.length = 0;

    perms.setGlobalFlags('flaguser', 'ov');
    await tick();

    const frames = parseWritten(written);
    const flagsFrame = frames.find((f) => f.type === 'SETFLAGS');
    expect(flagsFrame).toBeDefined();
    expect(flagsFrame!.handle).toBe('flaguser');
    expect(flagsFrame!.globalFlags).toBe('ov');

    hub.close();
  });

  it('broadcasts to multiple connected leaves', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: 'Test', usage: '.test', category: 'test' },
      (_args, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket2);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    written1.length = 0;
    written2.length = 0;

    perms.addUser('broadcast', '*!b@host', 'o');
    await tick();

    const frames1 = parseWritten(written1);
    const frames2 = parseWritten(written2);
    expect(frames1.some((f) => f.type === 'ADDUSER' && f.handle === 'broadcast')).toBe(true);
    expect(frames2.some((f) => f.type === 'ADDUSER' && f.handle === 'broadcast')).toBe(true);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: handleCmdRelay — unknown command
// ---------------------------------------------------------------------------

describe('BotLinkHub handleCmdRelay edge cases', () => {
  it('returns Unknown command for unregistered commands', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);

    // Only register one command — "test"
    handler.registerCommand(
      'test',
      { flags: '-', description: 'Test', usage: '.test', category: 'test' },
      (_args, ctx) => ctx.reply('ok'),
    );

    perms.addUser('admin', '*!a@host', 'nmov');

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    // Register admin's party line session (required for CMD session verification)
    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
    await tick();
    written.length = 0;

    // Send CMD for a command that does not exist
    pushFrame(duplex, {
      type: 'CMD',
      command: 'nonexistent',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: null,
      ref: 'ref-unknown',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-unknown');
    expect((result!.output as string[])[0]).toMatch(/Unknown command/);

    hub.close();
  });

  it('relays CMD with channel field', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '' },
      (_a, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'CMD',
      command: 'test',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: '#ops',
      ref: 'ref-ch',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-ch');
    hub.close();
  });

  it('returns error message when command handler throws', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);

    handler.registerCommand(
      'boom',
      { flags: '-', description: 'Explodes', usage: '.boom', category: 'test' },
      () => {
        throw new Error('Kaboom');
      },
    );

    perms.addUser('admin', '*!a@host', 'nmov');

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'CMD',
      command: 'boom',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: null,
      ref: 'ref-boom',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-boom');
    expect((result!.output as string[])[0]).toMatch(/Error: Kaboom/);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: CMD routing between two leaves (cmdRoutes)
// ---------------------------------------------------------------------------

describe('BotLinkHub CMD routing between leaves', () => {
  it('routes CMD from leaf1 to leaf2 and CMD_RESULT back', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: 'test', usage: '.test', category: 'test' },
      (_a, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    // Connect leaf1
    const { socket: s1, written: w1, duplex: d1 } = createMockSocket();
    hub.addConnection(s1);
    answerHelloChallenge(w1, d1, TEST_LINK_KEY, 'leaf1');
    await tick();

    // Connect leaf2
    const { socket: s2, written: w2, duplex: d2 } = createMockSocket();
    hub.addConnection(s2);
    answerHelloChallenge(w2, d2, TEST_LINK_KEY, 'leaf2');
    await tick();

    w1.length = 0;
    w2.length = 0;

    // leaf1 sends CMD targeted at leaf2
    pushFrame(d1, {
      type: 'CMD',
      command: 'test',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      toBot: 'leaf2',
      channel: null,
      ref: 'ref-routed',
    });
    await tick();

    // Hub should have forwarded CMD to leaf2
    const toLeaf2 = parseWritten(w2);
    const fwdCmd = toLeaf2.find((f) => f.type === 'CMD' && f.ref === 'ref-routed');
    expect(fwdCmd).toBeDefined();

    // leaf2 responds with CMD_RESULT
    pushFrame(d2, { type: 'CMD_RESULT', ref: 'ref-routed', output: ['result from leaf2'] });
    await tick();

    // Hub should route CMD_RESULT back to leaf1
    const toLeaf1 = parseWritten(w1);
    const result = toLeaf1.find((f) => f.type === 'CMD_RESULT' && f.ref === 'ref-routed');
    expect(result).toBeDefined();
    expect((result!.output as string[])[0]).toBe('result from leaf2');

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: CMD relay timeout
// ---------------------------------------------------------------------------

describe('BotLinkHub CMD relay timeout', () => {
  it('resolves with timeout message when leaf does not respond', async () => {
    vi.useFakeTimers();
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'slow',
      { flags: '-', description: 'test', usage: '.slow', category: 'test' },
      () => {},
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await vi.advanceTimersByTimeAsync(0);

    const promise = hub.sendCommandToBot('leaf1', 'slow', '', 'admin', null);
    // Advance past the 10s CMD timeout
    await vi.advanceTimersByTimeAsync(11_000);

    const result = await promise;
    expect(result[0]).toMatch(/timed out/i);

    hub.close();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Hub: remote party user cleanup on leaf disconnect
// ---------------------------------------------------------------------------

describe('BotLinkHub remote party user cleanup', () => {
  it('removes remote party users when leaf is admin-disconnected', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    // Simulate a PARTY_JOIN from leaf1
    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'alice', nick: 'Alice', fromBot: 'leaf1' });
    await tick();
    expect(hub.getRemotePartyUsers().length).toBe(1);

    // Admin-disconnect leaf1 — remote party user should be cleaned up
    hub.disconnectLeaf('leaf1');
    expect(hub.getRemotePartyUsers().length).toBe(0);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: RELAY_* routing between two leaves
// ---------------------------------------------------------------------------

describe('BotLinkHub relay routing', () => {
  let hub: BotLinkHub;
  let written1: string[];
  let written2: string[];
  let duplex1: Duplex;
  let duplex2: Duplex;

  beforeEach(async () => {
    hub = new BotLinkHub(hubConfig(), '1.0.0');

    const m1 = createMockSocket();
    const m2 = createMockSocket();
    written1 = m1.written;
    written2 = m2.written;
    duplex1 = m1.duplex;
    duplex2 = m2.duplex;

    hub.addConnection(m1.socket);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    hub.addConnection(m2.socket);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    // RELAY_REQUEST is gated on a live DCC party session; fake one by
    // pumping a PARTY_JOIN for 'admin' from leaf1 so subsequent
    // RELAY_REQUESTs pass the hasRemoteSession check.
    pushFrame(duplex1, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
    await tick();

    written1.length = 0;
    written2.length = 0;
  });

  afterEach(() => {
    hub.close();
  });

  it('routes RELAY_REQUEST from leaf1 to leaf2', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();

    const frames2 = parseWritten(written2);
    expect(frames2.some((f) => f.type === 'RELAY_REQUEST' && f.handle === 'admin')).toBe(true);
    // leaf1 should NOT receive its own request back
    expect(parseWritten(written1).filter((f) => f.type === 'RELAY_REQUEST')).toEqual([]);
  });

  it('returns RELAY_END when target bot is not connected', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'nonexistent',
    });
    await tick();

    const frames1 = parseWritten(written1);
    const endFrame = frames1.find((f) => f.type === 'RELAY_END');
    expect(endFrame).toBeDefined();
    expect(endFrame!.handle).toBe('admin');
    expect(endFrame!.reason).toMatch(/not connected/);
  });

  it('routes RELAY_ACCEPT from target back to origin', async () => {
    // First set up the relay
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // leaf2 accepts
    pushFrame(duplex2, {
      type: 'RELAY_ACCEPT',
      handle: 'admin',
    });
    await tick();

    const frames1 = parseWritten(written1);
    expect(frames1.some((f) => f.type === 'RELAY_ACCEPT' && f.handle === 'admin')).toBe(true);
    // leaf2 should NOT get its own ACCEPT echoed
    expect(parseWritten(written2)).toEqual([]);
  });

  it('routes RELAY_INPUT from origin to target', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // origin sends input to target
    pushFrame(duplex1, {
      type: 'RELAY_INPUT',
      handle: 'admin',
      data: 'hello world',
    });
    await tick();

    const frames2 = parseWritten(written2);
    expect(frames2.some((f) => f.type === 'RELAY_INPUT' && f.data === 'hello world')).toBe(true);
    expect(parseWritten(written1)).toEqual([]);
  });

  it('routes RELAY_OUTPUT from target to origin', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // target sends output to origin
    pushFrame(duplex2, {
      type: 'RELAY_OUTPUT',
      handle: 'admin',
      data: 'response data',
    });
    await tick();

    const frames1 = parseWritten(written1);
    expect(frames1.some((f) => f.type === 'RELAY_OUTPUT' && f.data === 'response data')).toBe(true);
    expect(parseWritten(written2)).toEqual([]);
  });

  it('routes RELAY_END from origin to target and cleans up', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // origin ends the relay
    pushFrame(duplex1, {
      type: 'RELAY_END',
      handle: 'admin',
      reason: 'done',
    });
    await tick();

    const frames2 = parseWritten(written2);
    expect(frames2.some((f) => f.type === 'RELAY_END' && f.handle === 'admin')).toBe(true);

    // After cleanup, further input should not route
    written1.length = 0;
    written2.length = 0;
    pushFrame(duplex1, {
      type: 'RELAY_INPUT',
      handle: 'admin',
      data: 'after-end',
    });
    await tick();

    expect(parseWritten(written2)).toEqual([]);
  });

  it('delivers hub-origin RELAY_ACCEPT locally exactly once', async () => {
    // Regression: with the hub as origin, routeRelayFrame used to deliver
    // via deliverLocal → onLeafFrame, and then onSteadyState also dispatched
    // the same frame to onLeafFrame a second time, producing doubled output.
    hub.registerRelay('admin', 'leaf2');
    const received: LinkFrame[] = [];
    hub.onLeafFrame = (_botname, frame) => received.push(frame);

    pushFrame(duplex2, { type: 'RELAY_ACCEPT', handle: 'admin' });
    await tick();

    const accepts = received.filter((f) => f.type === 'RELAY_ACCEPT');
    expect(accepts).toHaveLength(1);
  });

  it('delivers hub-origin RELAY_OUTPUT locally exactly once', async () => {
    hub.registerRelay('admin', 'leaf2');
    const received: LinkFrame[] = [];
    hub.onLeafFrame = (_botname, frame) => received.push(frame);

    pushFrame(duplex2, { type: 'RELAY_OUTPUT', handle: 'admin', line: 'response' });
    await tick();

    const outputs = received.filter((f) => f.type === 'RELAY_OUTPUT');
    expect(outputs).toHaveLength(1);
  });

  it('routes RELAY_END from target back to origin', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // target ends the relay
    pushFrame(duplex2, {
      type: 'RELAY_END',
      handle: 'admin',
      reason: 'target closed',
    });
    await tick();

    const frames1 = parseWritten(written1);
    expect(frames1.some((f) => f.type === 'RELAY_END' && f.handle === 'admin')).toBe(true);
  });

  it('cleans up activeRelays and sends RELAY_END to other leaf on disconnect', async () => {
    // Establish a relay between leaf1 (origin) and leaf2 (target)
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // Disconnect leaf1 (origin) — leaf2 should receive RELAY_END
    duplex1.destroy();
    await tick();

    const frames2 = parseWritten(written2);
    const endFrame = frames2.find((f) => f.type === 'RELAY_END' && f.handle === 'admin');
    expect(endFrame).toBeDefined();
    expect(endFrame!.reason).toMatch(/leaf1 disconnected/);

    // After cleanup, relay input from leaf2 should not route anywhere
    written2.length = 0;
    pushFrame(duplex2, {
      type: 'RELAY_INPUT',
      handle: 'admin',
      data: 'stale-input',
    });
    await tick();
    // No crash, no routing — input is silently dropped
  });

  it('cleans up activeRelays when target leaf disconnects', async () => {
    // Establish a relay between leaf1 (origin) and leaf2 (target)
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    // Disconnect leaf2 (target) — leaf1 should receive RELAY_END
    duplex2.destroy();
    await tick();

    const frames1 = parseWritten(written1);
    const endFrame = frames1.find((f) => f.type === 'RELAY_END' && f.handle === 'admin');
    expect(endFrame).toBeDefined();
    expect(endFrame!.reason).toMatch(/leaf2 disconnected/);
  });

  it('cleans up activeRelays via disconnectLeaf', async () => {
    pushFrame(duplex1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    written1.length = 0;
    written2.length = 0;

    hub.disconnectLeaf('leaf1');

    const frames2 = parseWritten(written2);
    // leaf2 should get both RELAY_END (cleanup) and BOTPART (broadcast)
    const endFrame = frames2.find((f) => f.type === 'RELAY_END' && f.handle === 'admin');
    expect(endFrame).toBeDefined();
    expect(endFrame!.reason).toMatch(/leaf1 disconnected/);
  });
});

// ---------------------------------------------------------------------------
// Hub: leaf disconnect cleans up cmdRoutes and protectRequests
// ---------------------------------------------------------------------------

describe('BotLinkHub leaf disconnect map cleanup', () => {
  it('cleans up cmdRoutes when leaf disconnects', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    // Register a command that does nothing — we just need CMD routing
    handler.registerCommand(
      'slow',
      { flags: '-', description: '', usage: '', category: '' },
      () => {},
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket1);
    hub.addConnection(socket2);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();
    written1.length = 0;
    written2.length = 0;

    // leaf1 sends CMD with toBot targeting leaf2 — this stores a cmdRoute entry
    pushFrame(duplex1, {
      type: 'CMD',
      command: 'slow',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: null,
      ref: 'ref-cleanup-test',
      toBot: 'leaf2',
    });
    await tick();

    // Before leaf1 gets the response, disconnect leaf1
    duplex1.destroy();
    await tick();

    // Now leaf2 sends CMD_RESULT — it should NOT crash or route to dead leaf
    pushFrame(duplex2, {
      type: 'CMD_RESULT',
      ref: 'ref-cleanup-test',
      result: 'done',
    });
    await tick();

    // leaf1 is disconnected, so it should not receive any frames
    // The key assertion is that no error was thrown and the route was cleaned up
    hub.close();
  });

  it('cleans up protectRequests when leaf disconnects', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket2);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    written1.length = 0;
    written2.length = 0;

    // leaf1 sends a PROTECT_OP (request) with a ref — this stores a protectRequests entry
    pushFrame(duplex1, {
      type: 'PROTECT_OP',
      ref: 'prot-ref-1',
      channel: '#test',
      nick: 'someone',
    });
    await tick();

    // Disconnect leaf1 before PROTECT_ACK arrives
    duplex1.destroy();
    await tick();

    // Now leaf2 sends PROTECT_ACK — should NOT route to dead leaf1
    written2.length = 0;
    pushFrame(duplex2, {
      type: 'PROTECT_ACK',
      ref: 'prot-ref-1',
      success: true,
    });
    await tick();

    // leaf1 is gone — the ACK should have been silently dropped (request was cleaned up)
    // No crash means the cleanup worked
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: PROTECT_ACK routing
// ---------------------------------------------------------------------------

describe('BotLinkHub PROTECT_ACK routing', () => {
  it('routes PROTECT_ACK from responder back to requester', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket2);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    written1.length = 0;
    written2.length = 0;

    // leaf1 sends a PROTECT_OP (request) with a ref
    pushFrame(duplex1, {
      type: 'PROTECT_OP',
      channel: '#chan',
      nick: 'bot1',
      requestedBy: 'leaf1',
      ref: 'protect-ref-1',
    });
    await tick();

    // leaf2 should have received the PROTECT_OP (fan-out)
    const frames2 = parseWritten(written2);
    expect(frames2.some((f) => f.type === 'PROTECT_OP' && f.ref === 'protect-ref-1')).toBe(true);

    written1.length = 0;
    written2.length = 0;

    // leaf2 responds with PROTECT_ACK using the same ref
    pushFrame(duplex2, {
      type: 'PROTECT_ACK',
      ref: 'protect-ref-1',
      success: true,
    });
    await tick();

    // leaf1 should receive the ACK (routed back by hub)
    const frames1 = parseWritten(written1);
    const ack = frames1.find((f) => f.type === 'PROTECT_ACK');
    expect(ack).toBeDefined();
    expect(ack!.ref).toBe('protect-ref-1');
    expect(ack!.success).toBe(true);

    // leaf2 should NOT receive its own ACK
    expect(parseWritten(written2)).toEqual([]);

    hub.close();
  });

  it('does not route PROTECT_ACK for unknown ref', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    // Send ACK with ref that has no matching request
    pushFrame(duplex1, {
      type: 'PROTECT_ACK',
      ref: 'unknown-ref',
      success: true,
    });
    await tick();

    // No frames should be sent (no routing target)
    expect(parseWritten(written1)).toEqual([]);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: handlePartyWhom
// ---------------------------------------------------------------------------

describe('BotLinkHub handlePartyWhom', () => {
  it('responds with local and remote party users', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    // Set up local party user provider
    hub.getLocalPartyUsers = () => [
      { handle: 'localadmin', nick: 'Admin', botname: 'hub', connectedAt: 1000, idle: 0 },
    ];

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    // Inject a remote party user via PARTY_JOIN from leaf1
    pushFrame(duplex1, {
      type: 'PARTY_JOIN',
      handle: 'remoteuser',
      nick: 'RemoteNick',
      fromBot: 'leaf1',
    });
    await tick();
    written1.length = 0;

    // Now request .whom
    pushFrame(duplex1, { type: 'PARTY_WHOM', ref: 'whom-ref-1' });
    await tick();

    const frames = parseWritten(written1);
    const reply = frames.find((f) => f.type === 'PARTY_WHOM_REPLY');
    expect(reply).toBeDefined();
    expect(reply!.ref).toBe('whom-ref-1');

    const users = reply!.users as Array<{ handle: string; botname: string }>;
    expect(users.some((u) => u.handle === 'localadmin' && u.botname === 'hub')).toBe(true);
    expect(users.some((u) => u.handle === 'remoteuser')).toBe(true);

    hub.close();
  });

  it('responds with empty list when no party users exist', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, { type: 'PARTY_WHOM', ref: 'whom-ref-2' });
    await tick();

    const frames = parseWritten(written);
    const reply = frames.find((f) => f.type === 'PARTY_WHOM_REPLY');
    expect(reply).toBeDefined();
    expect(reply!.ref).toBe('whom-ref-2');
    expect(reply!.users).toEqual([]);

    hub.close();
  });

  it('cleans up remote party users on leaf disconnect', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    // Inject remote party user from leaf1
    pushFrame(duplex1, {
      type: 'PARTY_JOIN',
      handle: 'leafuser',
      nick: 'LeafNick',
      fromBot: 'leaf1',
    });
    await tick();

    // Connect leaf2 to query whom after leaf1 disconnects
    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket2);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    // Disconnect leaf1
    duplex1.destroy();
    await tick();

    written2.length = 0;
    pushFrame(duplex2, { type: 'PARTY_WHOM', ref: 'whom-ref-3' });
    await tick();

    const frames = parseWritten(written2);
    const reply = frames.find((f) => f.type === 'PARTY_WHOM_REPLY');
    expect(reply).toBeDefined();
    // Remote user from leaf1 should be cleaned up
    const users = reply!.users as Array<{ handle: string }>;
    expect(users.some((u) => u.handle === 'leafuser')).toBe(false);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// BotLinkHub — listen() with real TCP loopback
// ---------------------------------------------------------------------------

describe('BotLinkHub listen()', () => {
  it('binds to a real TCP port and accepts connections', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');
    hub.close();
  });

  it('hub close() with running server shuts it down', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');
    hub.close();
    expect(hub.getLeaves()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BotLinkProtocol — additional edge cases
// ---------------------------------------------------------------------------

describe('BotLinkProtocol edge cases', () => {
  it('ignores lines received after close', async () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    protocol.close();
    duplex.push(JSON.stringify({ type: 'LATE' }) + '\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('returns false from send() when socket is destroyed', () => {
    const { socket, written: _written, duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    duplex.destroy();
    expect(protocol.send({ type: 'TEST' })).toBe(false);
  });

  it('close() is idempotent (double-close does not throw)', () => {
    const { socket, written: _written, duplex: _duplex } = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    protocol.close();
    protocol.close(); // second call returns early
    expect(protocol.isClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BotLinkHub — steady-state edge cases
// ---------------------------------------------------------------------------

describe('BotLinkHub steady-state edge cases', () => {
  it('handles PONG from leaf silently (no onLeafFrame)', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const received: LinkFrame[] = [];
    hub.onLeafFrame = (_b, f) => received.push(f);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    pushFrame(duplex, { type: 'PONG', seq: 99 });
    await tick();

    expect(received.filter((f) => f.type === 'PONG')).toHaveLength(0);
    hub.close();
  });

  it('tracks PARTY_PART to remove remote users', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'user1', nick: 'U', fromBot: 'leaf1' });
    await tick();
    expect(hub.getRemotePartyUsers()).toHaveLength(1);

    pushFrame(duplex, { type: 'PARTY_PART', handle: 'user1', fromBot: 'leaf1' });
    await tick();
    expect(hub.getRemotePartyUsers()).toHaveLength(0);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf — heartbeat and timeouts
// ---------------------------------------------------------------------------

describe('BotLinkLeaf heartbeat', () => {
  it('sends PING and detects hub timeout', async () => {
    vi.useFakeTimers();
    try {
      const leaf = new BotLinkLeaf(
        leafConfig({ ping_interval_ms: 100, link_timeout_ms: 250 }),
        '1.0.0',
      );
      const { socket, written, duplex } = createMockSocket();
      let disconnected = false;
      leaf.onDisconnected = () => {
        disconnected = true;
      };

      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);
      written.length = 0;

      await vi.advanceTimersByTimeAsync(101);
      const sent = parseWritten(written);
      expect(sent.some((f) => f.type === 'PING')).toBe(true);

      await vi.advanceTimersByTimeAsync(300);
      expect(disconnected).toBe(true);
      leaf.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf — relay command timeout
// ---------------------------------------------------------------------------

describe('BotLinkLeaf relayCommand timeout', () => {
  it('resolves with timeout message when hub does not respond', async () => {
    vi.useFakeTimers();
    try {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const { socket, written: _written, duplex } = createMockSocket();
      leaf.connectWithSocket(socket);
      pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
      pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);

      const replies: string[] = [];
      const ctx = {
        source: 'dcc' as const,
        nick: 'admin',
        ident: 'admin',
        hostname: 'host',
        channel: null,
        reply: (msg: string) => replies.push(msg),
      };

      const promise = leaf.relayCommand('adduser', 'test *!*@h o', 'admin', ctx);
      await vi.advanceTimersByTimeAsync(10_001);
      await promise;

      expect(replies).toContain('Command relay timed out.');
      leaf.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf — disconnect clears reconnect timer
// ---------------------------------------------------------------------------

describe('BotLinkLeaf disconnect cleanup', () => {
  it('disconnect clears pending reconnect timer', async () => {
    vi.useFakeTimers();
    try {
      const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
      const factory: SocketFactory = () => {
        const m = createMockSocket();
        mocks.push(m);
        setImmediate(() => m.duplex.emit('connect'));
        return m.socket;
      };

      const leaf = new BotLinkLeaf(leafConfig({ reconnect_delay_ms: 100 }), '1.0.0', null, factory);
      leaf.connect();
      await vi.advanceTimersByTimeAsync(1);
      pushFrame(mocks[0].duplex, {
        type: 'HELLO_CHALLENGE',
        nonce: 'a'.repeat(64),
        hubBotname: 'hub',
      });
      pushFrame(mocks[0].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);

      mocks[0].duplex.destroy();
      await vi.advanceTimersByTimeAsync(0);

      leaf.disconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scheduleReconnect fires after connection lost', async () => {
    vi.useFakeTimers();
    try {
      const mocks: Array<import('../helpers/mock-socket').MockSocketResult> = [];
      const factory: SocketFactory = () => {
        const m = createMockSocket();
        mocks.push(m);
        setImmediate(() => m.duplex.emit('connect'));
        return m.socket;
      };

      const leaf = new BotLinkLeaf(leafConfig({ reconnect_delay_ms: 50 }), '1.0.0', null, factory);
      leaf.connect();
      await vi.advanceTimersByTimeAsync(1);
      pushFrame(mocks[0].duplex, {
        type: 'HELLO_CHALLENGE',
        nonce: 'a'.repeat(64),
        hubBotname: 'hub',
      });
      pushFrame(mocks[0].duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);

      mocks[0].duplex.destroy();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(51);
      expect(mocks).toHaveLength(2);
      leaf.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf — setCommandRelay hook guards
// ---------------------------------------------------------------------------

describe('BotLinkLeaf setCommandRelay guards', () => {
  it('hook returns false when not connected (executes locally)', async () => {
    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'testcmd',
      { flags: '+n', description: 'test', usage: '.testcmd', category: 'test', relayToHub: true },
      (_a, ctx) => ctx.reply('local'),
    );

    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    leaf.setCommandRelay(handler, perms);

    const replies: string[] = [];
    await handler.execute('.testcmd', {
      source: 'dcc',
      nick: 'admin',
      ident: 'admin',
      hostname: 'host',
      channel: null,
      reply: (m) => replies.push(m),
    });
    expect(replies).toEqual(['local']);
  });

  it('hook returns false when user not found by hostmask', async () => {
    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'testcmd',
      { flags: '-', description: 'test', usage: '.testcmd', category: 'test', relayToHub: true },
      (_a, ctx) => ctx.reply('local'),
    );

    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();
    leaf.setCommandRelay(handler, perms);

    const replies: string[] = [];
    await handler.execute('.testcmd', {
      source: 'dcc',
      nick: 'unknown',
      ident: 'x',
      hostname: 'y',
      channel: null,
      reply: (m) => replies.push(m),
    });
    expect(replies).toEqual(['local']);
    leaf.disconnect();
  });

  it('hook returns false for botlink source (prevents relay loop)', async () => {
    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'testcmd',
      { flags: '-', description: 'test', usage: '.testcmd', category: 'test', relayToHub: true },
      (_a, ctx) => ctx.reply('local'),
    );

    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();
    leaf.setCommandRelay(handler, perms);

    const replies: string[] = [];
    await handler.execute('.testcmd', {
      source: 'botlink',
      nick: 'admin',
      ident: 'admin',
      hostname: 'host',
      channel: null,
      reply: (m) => replies.push(m),
    });
    expect(replies).toEqual(['local']);
    leaf.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Edge cases: missing frame fields (covers ?? fallback branches)
// ---------------------------------------------------------------------------

describe('frame field fallback branches', () => {
  it('CMD frame with missing fields', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '' },
      (_a, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    // CMD with missing fields — uses ?? defaults
    pushFrame(duplex, { type: 'CMD' });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    hub.close();
  });

  it('PARTY_JOIN with missing nick/fromBot fields uses defaults', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'user1' });
    await tick();

    const users = hub.getRemotePartyUsers();
    expect(users).toHaveLength(1);
    expect(users[0].nick).toBe('user1'); // falls back to handle
    expect(users[0].botname).toBe('leaf1'); // falls back to sending botname
    hub.close();
  });

  it('PARTY_JOIN with all fields undefined uses empty-string defaults', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    // handle, nick, fromBot all undefined — exercises every ?? fallback
    pushFrame(duplex, { type: 'PARTY_JOIN' });
    await tick();

    const users = hub.getRemotePartyUsers();
    expect(users).toHaveLength(1);
    expect(users[0].handle).toBe('');
    expect(users[0].nick).toBe('');
    expect(users[0].botname).toBe('leaf1');
    hub.close();
  });

  it('RELAY_REQUEST with missing toBot rejects with error', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, { type: 'RELAY_REQUEST', handle: 'admin' });
    await tick();

    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'RELAY_END')).toBe(true);
    hub.close();
  });

  it('leaf config defaults used when optional fields are missing', () => {
    const minConfig: BotlinkConfig = {
      enabled: true,
      role: 'leaf',
      botname: 'test',
      password: 'p',
      link_salt: TEST_LINK_SALT,
      hub: { host: '127.0.0.1', port: 15051 },
      ping_interval_ms: 30_000,
      link_timeout_ms: 90_000,
    };
    // Should not throw — uses defaults for missing optional fields
    const leaf = new BotLinkLeaf(minConfig, '1.0.0');
    expect(leaf.isConnected).toBe(false);
  });

  it('leaf WELCOME with missing botname uses empty string', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    // Answer a CHALLENGE so the leaf is past the handshake gate that
    // requires CHALLENGE before WELCOME; the ensuing WELCOME with no
    // botname should still promote the leaf to connected with an empty
    // hubName fallback.
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    await tick();
    pushFrame(duplex, { type: 'WELCOME' });
    await tick();

    expect(leaf.isConnected).toBe(true);
    expect(leaf.hubName).toBe('');
    leaf.disconnect();
  });

  it('leaf returns Unknown command for unregistered CMD', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '' },
      () => {},
    );
    leaf.setCommandRelay(handler, perms);
    written.length = 0;

    pushFrame(duplex, {
      type: 'CMD',
      command: 'nonexistent',
      args: '',
      fromHandle: 'admin',
      fromBot: 'hub',
      channel: null,
      ref: 'ref-leaf-unknown',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-leaf-unknown');
    expect((result!.output as string[])[0]).toMatch(/Unknown command/);

    leaf.disconnect();
  });

  it('leaf CMD_RESULT with non-array output resolves empty', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '', relayToHub: true },
      () => {},
    );
    leaf.setCommandRelay(handler, perms);

    const replies: string[] = [];
    const ctx = {
      source: 'dcc' as const,
      nick: 'admin',
      ident: 'admin',
      hostname: 'host',
      channel: null,
      reply: (m: string) => replies.push(m),
    };
    const promise = leaf.relayCommand('test', '', 'admin', ctx);
    await tick();

    const sent = parseWritten(written);
    const cmd = sent.find((f) => f.type === 'CMD');
    pushFrame(duplex, { type: 'CMD_RESULT', ref: cmd!.ref, output: 'not-an-array' });
    await tick();
    await promise;

    expect(replies).toEqual([]);
    leaf.disconnect();
  });

  it('leaf PARTY_WHOM_REPLY with non-array users resolves empty', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const promise = leaf.requestWhom();
    await tick();

    const sent = parseWritten(written);
    const whom = sent.find((f) => f.type === 'PARTY_WHOM');
    pushFrame(duplex, { type: 'PARTY_WHOM_REPLY', ref: whom!.ref, users: 'bad' });
    await tick();

    expect(await promise).toEqual([]);
    leaf.disconnect();
  });

  it('HELLO with missing botname/hmac fields rejected with PROTOCOL', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);

    // Send HELLO with no botname and no hmac — hub rejects on missing hmac.
    pushFrame(duplex, { type: 'HELLO' });
    await tick();

    expect(findFrame(written, 'ERROR')).toMatchObject({ type: 'ERROR', code: 'PROTOCOL' });
    hub.close();
  });

  it('PARTY_WHOM with missing ref field exercises ?? coercion', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    // Send PARTY_WHOM without ref — ?? coerces to ''
    pushFrame(duplex, { type: 'PARTY_WHOM' });
    await tick();

    const frames = parseWritten(written);
    const reply = frames.find((f) => f.type === 'PARTY_WHOM_REPLY');
    expect(reply).toBeDefined();
    expect(reply!.ref).toBe('');
    hub.close();
  });

  it('leaf CMD_RESULT/WHOM_REPLY/PROTECT_ACK with missing ref exercises ?? coercion', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const frames: LinkFrame[] = [];
    leaf.onFrame = (f) => frames.push(f);

    // Send frames without ref — ?? coerces to '', no pending match, falls through to onFrame
    pushFrame(duplex, { type: 'CMD_RESULT', output: ['x'] });
    pushFrame(duplex, { type: 'PARTY_WHOM_REPLY', users: [] });
    pushFrame(duplex, { type: 'PROTECT_ACK', success: true });
    await tick();

    expect(frames).toHaveLength(3);
    leaf.disconnect();
  });

  it('leaf setCommandRelay exercises ident/hostname ?? coercion', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const perms = new Permissions();
    // Add user matching nick!@  (empty ident/hostname from ?? coercion)
    perms.addUser('admin', '*!*@*', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '', relayToHub: true },
      () => {},
    );
    leaf.setCommandRelay(handler, perms);

    const replies: string[] = [];
    // Context without ident and hostname — exercises the ?? '' fallback
    const ctx = {
      source: 'irc' as const,
      nick: 'admin',
      channel: null,
      reply: (m: string) => replies.push(m),
    };
    handler.execute('.test', ctx);
    await tick();

    leaf.disconnect();
  });

  it('hub handleConnection: second frame during handshake is ignored', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);

    // Send valid HELLO then immediately another frame
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    // Should only connect once
    expect(hub.getLeaves()).toEqual(['leaf1']);
    hub.close();
  });

  it('leaf ignores CMD_RESULT with unknown ref', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const frames: LinkFrame[] = [];
    leaf.onFrame = (f) => frames.push(f);

    // Send CMD_RESULT with a ref that has no pending command
    pushFrame(duplex, { type: 'CMD_RESULT', ref: 'nonexistent', output: ['hello'] });
    await tick();

    // Should fall through to onFrame since no pending cmd matched
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('CMD_RESULT');
    leaf.disconnect();
  });

  it('leaf ignores PARTY_WHOM_REPLY with unknown ref', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const frames: LinkFrame[] = [];
    leaf.onFrame = (f) => frames.push(f);

    pushFrame(duplex, { type: 'PARTY_WHOM_REPLY', ref: 'nonexistent', users: [] });
    await tick();

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('PARTY_WHOM_REPLY');
    leaf.disconnect();
  });

  it('leaf ignores PROTECT_ACK with unknown ref', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    const frames: LinkFrame[] = [];
    leaf.onFrame = (f) => frames.push(f);

    pushFrame(duplex, { type: 'PROTECT_ACK', ref: 'nonexistent', success: true });
    await tick();

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('PROTECT_ACK');
    leaf.disconnect();
  });

  it('leaf reconnect() when already disconnected (protocol null)', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    // Protocol is null — never connected
    leaf.reconnect();
    // Should not crash; leaf tries to connect
    expect(leaf.isConnected).toBe(false);
    leaf.disconnect();
  });

  it('leaf handles non-AUTH_FAILED ERROR during handshake (schedules reconnect)', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);

    pushFrame(duplex, { type: 'ERROR', code: 'DUPLICATE', message: 'Already connected' });
    await tick();

    expect(leaf.isConnected).toBe(false);
    // scheduleReconnect was called; clean up
    leaf.disconnect();
  });

  it('leaf ignores unknown frame type during handshake', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written: _written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);

    // Send an unrecognized frame during handshake — handler should ignore it
    pushFrame(duplex, { type: 'RANDOM_FRAME' });
    await tick();

    expect(leaf.isConnected).toBe(false);

    // Now send WELCOME — should still work
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();

    expect(leaf.isConnected).toBe(true);
    leaf.disconnect();
  });

  it('hub onSteadyState returns early when conn is null (race)', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    // Disconnect the leaf, then try to send a frame (race condition)
    duplex.destroy();
    await tick();

    // Send a frame on the destroyed socket — should not crash
    pushFrame(duplex, { type: 'JOIN', channel: '#test', nick: 'u' });
    await tick();

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Coverage: setCommandRelay event handler guard branches
// ---------------------------------------------------------------------------

describe('BotLinkHub setCommandRelay event handler guards', () => {
  it('user:added event for non-existent user does not broadcast', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    // Fire user:added for a handle that doesn't exist in permissions
    eventBus.emit('user:added', 'ghost');
    await tick();

    const frames = parseWritten(written);
    expect(frames.filter((f) => f.type === 'ADDUSER')).toEqual([]);
    hub.close();
  });

  it('user:flagsChanged event for non-existent user does not broadcast', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    eventBus.emit('user:flagsChanged', 'ghost', 'n', {});
    await tick();

    const frames = parseWritten(written);
    expect(frames.filter((f) => f.type === 'SETFLAGS')).toEqual([]);
    hub.close();
  });

  it('user:hostmaskAdded event for non-existent user does not broadcast', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    eventBus.emit('user:hostmaskAdded', 'ghost', '*!*@ghost');
    await tick();

    const frames = parseWritten(written);
    expect(frames.filter((f) => f.type === 'ADDUSER')).toEqual([]);
    hub.close();
  });

  it('user:hostmaskRemoved event for non-existent user does not broadcast', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    const handler = new CommandHandler(perms);
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    eventBus.emit('user:hostmaskRemoved', 'ghost', '*!*@ghost');
    await tick();

    const frames = parseWritten(written);
    expect(frames.filter((f) => f.type === 'ADDUSER')).toEqual([]);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Coverage: relay routing with no active relay
// ---------------------------------------------------------------------------

describe('BotLinkHub relay routing with no active relay', () => {
  it('RELAY_ACCEPT with unknown handle echoes RELAY_END back so the sender can clean up', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    pushFrame(duplex1, { type: 'RELAY_ACCEPT', handle: 'nobody' });
    await tick();

    const frames = parseWritten(written1);
    expect(frames.some((f) => f.type === 'RELAY_END' && f.handle === 'nobody')).toBe(true);
    hub.close();
  });

  it('RELAY_INPUT with unknown handle echoes RELAY_END back so the sender can clean up', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    pushFrame(duplex1, { type: 'RELAY_INPUT', handle: 'nobody', data: 'test' });
    await tick();

    const frames = parseWritten(written1);
    expect(frames.some((f) => f.type === 'RELAY_END' && f.handle === 'nobody')).toBe(true);
    hub.close();
  });

  it('RELAY_OUTPUT with unknown handle echoes RELAY_END back so the sender can clean up', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    pushFrame(duplex1, { type: 'RELAY_OUTPUT', handle: 'nobody', data: 'test' });
    await tick();

    const frames = parseWritten(written1);
    expect(frames.some((f) => f.type === 'RELAY_END' && f.handle === 'nobody')).toBe(true);
    hub.close();
  });

  it('RELAY_END with unknown handle is silently dropped', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();
    written1.length = 0;

    pushFrame(duplex1, { type: 'RELAY_END', handle: 'nobody' });
    await tick();

    expect(parseWritten(written1)).toEqual([]);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Coverage: onLeafClose with non-matching remote party users
// ---------------------------------------------------------------------------

describe('BotLinkHub onLeafClose remote user cleanup', () => {
  it('only removes party users from the disconnected leaf', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    hub.addConnection(socket1);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    await tick();

    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket2);
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();

    // Add party users from both leaves
    pushFrame(duplex1, { type: 'PARTY_JOIN', handle: 'user1', nick: 'User1', fromBot: 'leaf1' });
    pushFrame(duplex2, { type: 'PARTY_JOIN', handle: 'user2', nick: 'User2', fromBot: 'leaf2' });
    await tick();

    expect(hub.getRemotePartyUsers()).toHaveLength(2);

    // Disconnect leaf1 — user1 should be removed, user2 should remain
    duplex1.destroy();
    await tick();

    const remaining = hub.getRemotePartyUsers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].handle).toBe('user2');
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// CMD toBot routing (hub routes CMD to a specific leaf)
// ---------------------------------------------------------------------------

describe('BotLinkHub CMD toBot routing', () => {
  it('routes CMD with toBot to the target leaf', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'test',
      { flags: '-', description: '', usage: '', category: '' },
      (_a, ctx) => ctx.reply('ok'),
    );

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    // Connect two leaves
    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket1);
    hub.addConnection(socket2);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();
    written1.length = 0;
    written2.length = 0;

    // leaf1 sends CMD targeting leaf2
    pushFrame(duplex1, {
      type: 'CMD',
      command: 'test',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: null,
      ref: 'ref-route',
      toBot: 'leaf2',
    });
    await tick();

    // leaf2 should receive the CMD frame
    const leaf2Frames = parseWritten(written2);
    const cmd = leaf2Frames.find((f) => f.type === 'CMD');
    expect(cmd).toBeDefined();
    expect(cmd!.toBot).toBe('leaf2');
    expect(cmd!.command).toBe('test');

    hub.close();
  });

  it('returns error when toBot leaf is not connected', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'CMD',
      command: 'test',
      args: '',
      fromHandle: 'admin',
      fromBot: 'leaf1',
      channel: null,
      ref: 'ref-nobot',
      toBot: 'nonexistent',
    });
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect((result!.output as string[])[0]).toMatch(/not connected/);

    hub.close();
  });

  it('sendCommandToBot sends CMD and resolves on CMD_RESULT', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);

    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    hub.setCommandRelay(handler, perms, eventBus);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    // Start the async command
    const resultPromise = hub.sendCommandToBot('leaf1', 'status', '', 'admin', null);
    await tick();

    // leaf1 should have received the CMD
    const cmdFrames = parseWritten(written);
    const cmd = cmdFrames.find((f) => f.type === 'CMD');
    expect(cmd).toBeDefined();

    // Simulate leaf1 responding with CMD_RESULT
    pushFrame(duplex, { type: 'CMD_RESULT', ref: cmd!.ref, output: ['Bot status: ok'] });
    await tick();

    const result = await resultPromise;
    expect(result).toEqual(['Bot status: ok']);

    hub.close();
  });

  it('sendCommandToBot returns error for unknown bot', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const result = await hub.sendCommandToBot('unknown', 'status', '', 'admin', null);
    expect(result[0]).toMatch(/not connected/);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// BotLinkHub BSAY routing
// ---------------------------------------------------------------------------

describe('BotLinkHub BSAY routing', () => {
  /**
   * Set up a hub with a permissions adapter that grants `admin` the `+m`
   * flag globally and on every channel. The BSAY router re-checks `+m`
   * against the frame's fromHandle via this adapter; without it, every
   * BSAY drops with "[security] BSAY rejected".
   */
  function setupHubWithPerms(): {
    hub: BotLinkHub;
    handler: CommandHandler;
    perms: Permissions;
  } {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!admin@host.com', 'nm');
    const handler = new CommandHandler(perms);
    hub.setCommandRelay(handler, perms, eventBus);
    return { hub, handler, perms };
  }

  it('routes BSAY to specific leaf', async () => {
    const { hub } = setupHubWithPerms();
    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket1);
    hub.addConnection(socket2);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();
    written1.length = 0;
    written2.length = 0;

    // leaf1 sends BSAY targeting leaf2 with a valid fromHandle
    pushFrame(duplex1, {
      type: 'BSAY',
      target: '#chan',
      message: 'hello',
      toBot: 'leaf2',
      fromHandle: 'admin',
    });
    await tick();

    // leaf2 should receive it
    const leaf2Frames = parseWritten(written2);
    expect(leaf2Frames.some((f) => f.type === 'BSAY')).toBe(true);
    // Hub should NOT have executed onBsay
    expect(bsayCalls).toHaveLength(0);

    hub.close();
  });

  it('broadcasts BSAY with toBot=* and delivers locally', async () => {
    const { hub } = setupHubWithPerms();
    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket: socket1, written: written1, duplex: duplex1 } = createMockSocket();
    const { socket: socket2, written: written2, duplex: duplex2 } = createMockSocket();
    hub.addConnection(socket1);
    hub.addConnection(socket2);
    answerHelloChallenge(written1, duplex1, TEST_LINK_KEY, 'leaf1');
    answerHelloChallenge(written2, duplex2, TEST_LINK_KEY, 'leaf2');
    await tick();
    written1.length = 0;
    written2.length = 0;

    // leaf1 sends BSAY targeting all with a valid fromHandle
    pushFrame(duplex1, {
      type: 'BSAY',
      target: '#chan',
      message: 'hi',
      toBot: '*',
      fromHandle: 'admin',
    });
    await tick();

    // leaf2 should receive it (not leaf1 — exclude sender)
    const leaf2Frames = parseWritten(written2);
    expect(leaf2Frames.some((f) => f.type === 'BSAY')).toBe(true);
    const leaf1Frames = parseWritten(written1);
    expect(leaf1Frames.some((f) => f.type === 'BSAY')).toBe(false);
    // Hub should have executed onBsay locally
    expect(bsayCalls).toEqual([['#chan', 'hi']]);

    hub.close();
  });

  it('delivers BSAY targeting hub locally', async () => {
    const { hub } = setupHubWithPerms();
    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'BSAY',
      target: '#test',
      message: 'msg',
      toBot: 'hub',
      fromHandle: 'admin',
    });
    await tick();

    expect(bsayCalls).toEqual([['#test', 'msg']]);
    hub.close();
  });

  it('drops BSAY from leaf when fromHandle lacks +m', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    // `eve` exists but has no flags — BSAY hub gate must reject.
    perms.addUser('eve', '*!eve@host.com', '');
    const handler = new CommandHandler(perms);
    hub.setCommandRelay(handler, perms, eventBus);

    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'BSAY',
      target: '#ops',
      message: 'spoof',
      toBot: '*',
      fromHandle: 'eve',
    });
    await tick();

    expect(bsayCalls).toEqual([]);
    hub.close();
  });

  it('drops BSAY with missing fromHandle', async () => {
    const { hub } = setupHubWithPerms();
    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    pushFrame(duplex, { type: 'BSAY', target: '#ops', message: 'no-handle', toBot: '*' });
    await tick();

    expect(bsayCalls).toEqual([]);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// BotLinkHub stale relay/party TTL sweep (mem-leak audit 2026-04-13)
// ---------------------------------------------------------------------------

describe('BotLinkHub sweepStaleRoutes — relay & party TTL', () => {
  it('drops activeRelays older than 1h and remotePartyUsers older than 7d', () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const now = Date.now();

    // Reach into the router's private state to seed both kinds of stale
    // The hub owns a BotLinkRelayRouter that holds the four state maps as
    // public readonly fields — tests seed through them directly.
    const routes = hub.routes;

    // Stale + fresh protect request and cmd route — covers the SHORT_TTL branches.
    routes.protectRequests.set('stale-protect', { botname: 'leaf1', createdAt: now - 60_000 });
    routes.protectRequests.set('fresh-protect', { botname: 'leaf1', createdAt: now });
    routes.cmdRoutes.set('stale-route', { botname: 'leaf1', createdAt: now - 60_000 });
    routes.cmdRoutes.set('fresh-route', { botname: 'leaf1', createdAt: now });

    // Stale + fresh relay session
    routes.activeRelays.set('stale-relay', {
      originBot: 'leaf1',
      targetBot: 'leaf2',
      createdAt: now - 2 * 60 * 60_000, // 2h ago — past 1h TTL
    });
    routes.activeRelays.set('fresh-relay', {
      originBot: 'leaf1',
      targetBot: 'leaf2',
      createdAt: now - 60_000, // 1min ago — well under 1h
    });

    // Stale + fresh remote party user
    routes.remotePartyUsers.set('stale@leaf1', {
      handle: 'stale',
      nick: 'stale',
      botname: 'leaf1',
      connectedAt: now - 8 * 86_400_000, // 8 days ago — past 7d TTL
      idle: 0,
    });
    routes.remotePartyUsers.set('fresh@leaf1', {
      handle: 'fresh',
      nick: 'fresh',
      botname: 'leaf1',
      connectedAt: now - 60_000,
      idle: 0,
    });

    routes.sweepStaleRoutes();

    expect(routes.protectRequests.has('stale-protect')).toBe(false);
    expect(routes.protectRequests.has('fresh-protect')).toBe(true);
    expect(routes.cmdRoutes.has('stale-route')).toBe(false);
    expect(routes.cmdRoutes.has('fresh-route')).toBe(true);
    expect(routes.activeRelays.has('stale-relay')).toBe(false);
    expect(routes.activeRelays.has('fresh-relay')).toBe(true);
    expect(routes.remotePartyUsers.has('stale@leaf1')).toBe(false);
    expect(routes.remotePartyUsers.has('fresh@leaf1')).toBe(true);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// BotLinkLeaf incoming CMD execution
// ---------------------------------------------------------------------------

describe('BotLinkLeaf incoming CMD execution', () => {
  it('executes CMD received from hub and sends CMD_RESULT', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!a@host', 'nmov');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'status',
      { flags: '-', description: '', usage: '', category: '' },
      (_a, ctx) => ctx.reply('running'),
    );

    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    leaf.setCommandRelay(handler, perms);

    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);

    // Complete handshake
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();
    written.length = 0;

    // Hub sends CMD to leaf (routed from .bot command)
    pushFrame(duplex, {
      type: 'CMD',
      command: 'status',
      args: '',
      fromHandle: 'admin',
      fromBot: 'hub',
      channel: null,
      ref: 'ref-leaf-cmd',
      toBot: 'leaf1',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-leaf-cmd');
    expect(result!.output).toEqual(['running']);

    leaf.disconnect();
  });

  it('returns permission denied for unauthorized CMD', async () => {
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('viewer', '*!v@host', 'v');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'shutdown',
      { flags: '+n', description: '', usage: '', category: '' },
      (_a, ctx) => ctx.reply('no'),
    );

    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    leaf.setCommandRelay(handler, perms);

    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    pushFrame(duplex, { type: 'WELCOME', botname: '    ', version: '1.0' });
    await tick();
    written.length = 0;

    pushFrame(duplex, {
      type: 'CMD',
      command: 'shutdown',
      args: '',
      fromHandle: 'viewer',
      fromBot: 'hub',
      channel: null,
      ref: 'ref-denied',
    });
    await tick();
    await tick();

    const frames = parseWritten(written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect((result!.output as string[])[0]).toMatch(/Permission denied/);

    leaf.disconnect();
  });
});

// ---------------------------------------------------------------------------
// HELLO v2 security tests — replay + nonce guarantees on the HMAC handshake
// ---------------------------------------------------------------------------

describe('HELLO v2 — replay + nonce guarantees', () => {
  it('rejects a replayed HELLO (captured HMAC from a prior nonce)', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    // Connection A — capture its HELLO.
    const a = createMockSocket();
    hub.addConnection(a.socket);
    const replayedHello = answerHelloChallenge(a.written, a.duplex, TEST_LINK_KEY, 'leafA');
    await tick();
    expect(findFrame(a.written, 'WELCOME')).toBeDefined();

    // Connection B — gets a fresh nonce. Replaying A's HELLO must fail.
    const b = createMockSocket();
    hub.addConnection(b.socket);
    pushFrame(b.duplex, replayedHello);
    await tick();

    expect(findFrame(b.written, 'ERROR')).toMatchObject({
      type: 'ERROR',
      code: 'AUTH_FAILED',
    });
    hub.close();
  });

  it('emits a distinct nonce on every CHALLENGE', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const nonces = new Set<string>();
    const N = 100;
    for (let i = 0; i < N; i++) {
      const { socket, written } = createMockSocket();
      hub.addConnection(socket);
      const nonce = findFrame(written, 'HELLO_CHALLENGE')?.nonce;
      if (typeof nonce === 'string') nonces.add(nonce);
      socket.destroy();
    }
    expect(nonces.size).toBe(N);
    hub.close();
  });

  it('hub + leaf configured with different link_salt cannot auth', async () => {
    const hub = new BotLinkHub(hubConfig({ link_salt: 'aa'.repeat(32) }), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);

    // Use a link key derived from a DIFFERENT salt — same password,
    // different per-botnet value. Resulting HMAC should not match.
    const otherKey = testLinkKey(TEST_PASSWORD, 'bb'.repeat(32));
    answerHelloChallenge(written, duplex, otherKey, 'leafX');
    await tick();

    expect(findFrame(written, 'ERROR')).toMatchObject({
      type: 'ERROR',
      code: 'AUTH_FAILED',
    });
    hub.close();
  });

  it('leaf reconnects cleanly when hub sends a malformed nonce hex', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, {
      type: 'HELLO_CHALLENGE',
      nonce: 'zzz', // not hex
      hubBotname: 'evil-hub',
    });
    await tick();
    // Leaf should have closed the socket without throwing; connected is false.
    expect(leaf.isConnected).toBe(false);
    leaf.disconnect();
  });

  it('leaf replies PROTOCOL on unexpected handshake frame and does not connect', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'PING', seq: 1 });
    await tick();
    const sent = parseWritten(written);
    expect(sent.find((f) => f.type === 'ERROR')).toMatchObject({
      type: 'ERROR',
      code: 'PROTOCOL',
    });
    expect(leaf.isConnected).toBe(false);
    leaf.disconnect();
  });

  it('leaf refuses WELCOME that arrives before CHALLENGE', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
    await tick();
    expect(leaf.isConnected).toBe(false);
    leaf.disconnect();
  });

  it('leaf rejects a second HELLO_CHALLENGE after answering the first', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    await tick();
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'b'.repeat(64), hubBotname: 'hub' });
    await tick();
    expect(parseWritten(written).some((f) => f.type === 'ERROR' && f.code === 'PROTOCOL')).toBe(
      true,
    );
    leaf.disconnect();
  });

  it('leaf disconnect() clears the cached linkKey and blocks later CHALLENGE response', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    leaf.disconnect();
    // Construction auto-derives linkKey; disconnect zeroes it. A fresh
    // socket with a brand-new protocol shouldn't be able to answer a
    // CHALLENGE against the disconnected leaf.
    const fresh = createMockSocket();
    leaf.connectWithSocket(fresh.socket);
    pushFrame(fresh.duplex, {
      type: 'HELLO_CHALLENGE',
      nonce: 'a'.repeat(64),
      hubBotname: 'hub',
    });
    await tick();
    // Leaf has no linkKey after disconnect — CHALLENGE must fail closed.
    expect(parseWritten(fresh.written).some((f) => f.type === 'HELLO')).toBe(false);
    expect(leaf.isConnected).toBe(false);
    // silence unused var warning
    void written;
    void duplex;
  });
});

// ---------------------------------------------------------------------------
// Leaf-side inbound CMD rate-limit — protects each leaf from a malicious or
// runaway hub flooding command frames at it.
// ---------------------------------------------------------------------------

describe('leaf cmd_inbound_rate gate', () => {
  it('returns RATE_LIMITED CMD_RESULT once the window is exhausted', async () => {
    const leaf = new BotLinkLeaf(leafConfig({ cmd_inbound_rate: 2 }), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'hub' });
    await tick();
    pushFrame(duplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
    await tick();
    const perms = new Permissions();
    perms.addUser('admin', '*!admin@host', 'n');
    const handler = new CommandHandler(perms);
    handler.registerCommand(
      'ping',
      { flags: '-', description: '', usage: '', category: '' },
      (_a, c) => c.reply('pong'),
    );
    leaf.setCommandRelay(handler, perms);
    written.length = 0;

    for (let i = 0; i < 5; i++) {
      pushFrame(duplex, {
        type: 'CMD',
        command: 'ping',
        args: '',
        fromHandle: 'admin',
        fromBot: 'hub',
        channel: null,
        ref: `r${i}`,
      });
    }
    await tick();
    await tick();

    const results = parseWritten(written).filter((f) => f.type === 'CMD_RESULT');
    const rateLimited = results.filter(
      (r) => Array.isArray(r.output) && r.output[0] === 'Rate limit exceeded',
    );
    expect(rateLimited.length).toBeGreaterThan(0);
    leaf.disconnect();
  });
});

// ---------------------------------------------------------------------------
// BSAY re-permission-check at delivery time — channel BSAY uses channel
// flags, but a PM target falls back to the global +m flag because there is
// no channel context to evaluate against.
// ---------------------------------------------------------------------------

describe('BSAY re-check — PM target uses global +m', () => {
  it('admin with global +m can BSAY a PM target', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!admin@host.com', 'nm');
    const handler = new CommandHandler(perms);
    hub.setCommandRelay(handler, perms, eventBus);

    const bsayCalls: [string, string][] = [];
    hub.onBsay = (target, msg) => bsayCalls.push([target, msg]);

    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, TEST_LINK_KEY, 'leaf1');
    await tick();

    pushFrame(duplex, {
      type: 'BSAY',
      target: 'someNick',
      message: 'pm hi',
      toBot: 'hub',
      fromHandle: 'admin',
    });
    await tick();
    expect(bsayCalls).toEqual([['someNick', 'pm hi']]);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Per-frame-type rate buckets — separate token buckets for SAY, NOTICE,
// MODE etc. so that a flood of one type can't starve the others.
// ---------------------------------------------------------------------------

describe('Per-frame rate buckets', () => {
  function countForwarded(written: string[], type: string): number {
    return parseWritten(written).filter((f) => f.type === type).length;
  }

  async function setupPair(): Promise<{
    hub: BotLinkHub;
    d1: Duplex;
    w1: string[];
    w2: string[];
  }> {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const eventBus = new BotEventBus();
    const perms = new Permissions(null, null, eventBus);
    perms.addUser('admin', '*!admin@host.com', 'nm');
    const handler = new CommandHandler(perms);
    hub.setCommandRelay(handler, perms, eventBus);
    const a = createMockSocket();
    const b = createMockSocket();
    hub.addConnection(a.socket);
    answerHelloChallenge(a.written, a.duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    hub.addConnection(b.socket);
    answerHelloChallenge(b.written, b.duplex, TEST_LINK_KEY, 'leaf2');
    await tick();
    a.written.length = 0;
    b.written.length = 0;
    return { hub, d1: a.duplex, w1: a.written, w2: b.written };
  }

  it('BSAY flood caps fanout at 10 per second', async () => {
    const { hub, d1, w2 } = await setupPair();
    for (let i = 0; i < 20; i++) {
      pushFrame(d1, {
        type: 'BSAY',
        target: '#chan',
        message: `m${i}`,
        toBot: 'leaf2',
        fromHandle: 'admin',
      });
    }
    await tick();
    expect(countForwarded(w2, 'BSAY')).toBe(10);
    hub.close();
  });

  it('ANNOUNCE flood caps at 5 per second', async () => {
    const { hub, d1, w2 } = await setupPair();
    for (let i = 0; i < 20; i++) {
      pushFrame(d1, { type: 'ANNOUNCE', message: `a${i}`, fromBot: 'leaf1' });
    }
    await tick();
    expect(countForwarded(w2, 'ANNOUNCE')).toBe(5);
    hub.close();
  });

  it('PARTY_JOIN flood caps at 5 tracked per second', async () => {
    const { hub, d1 } = await setupPair();
    for (let i = 0; i < 20; i++) {
      pushFrame(d1, { type: 'PARTY_JOIN', handle: `user${i}`, nick: `n${i}`, fromBot: 'leaf1' });
    }
    await tick();
    expect(hub.getRemotePartyUsers().length).toBe(5);
    hub.close();
  });

  it('RELAY_INPUT flood caps routed frames at 30 per second', async () => {
    const { hub, d1, w2 } = await setupPair();
    // Seed a party join + an active relay so RELAY_INPUT can route.
    pushFrame(d1, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
    pushFrame(d1, { type: 'RELAY_REQUEST', handle: 'admin', toBot: 'leaf2' });
    await tick();
    w2.length = 0;

    for (let i = 0; i < 60; i++) {
      pushFrame(d1, { type: 'RELAY_INPUT', handle: 'admin', line: `l${i}` });
    }
    await tick();
    expect(countForwarded(w2, 'RELAY_INPUT')).toBe(30);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// RELAY_REQUEST hub-side gate — a leaf cannot ask the hub to forward relay
// frames into a party it never joined; PARTY_JOIN must precede RELAY_REQUEST.
// ---------------------------------------------------------------------------

describe('RELAY_REQUEST hub-side gate', () => {
  it('rejects RELAY_REQUEST when no PARTY_JOIN preceded it', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const a = createMockSocket();
    const b = createMockSocket();
    hub.addConnection(a.socket);
    answerHelloChallenge(a.written, a.duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    hub.addConnection(b.socket);
    answerHelloChallenge(b.written, b.duplex, TEST_LINK_KEY, 'leaf2');
    await tick();
    a.written.length = 0;
    b.written.length = 0;

    pushFrame(a.duplex, { type: 'RELAY_REQUEST', handle: 'eve', toBot: 'leaf2' });
    await tick();

    const end = findFrame(a.written, 'RELAY_END');
    expect(end).toMatchObject({ type: 'RELAY_END', handle: 'eve' });
    expect(String(end!.reason)).toMatch(/No active DCC party session/);
    // leaf2 never saw the REQUEST.
    expect(parseWritten(b.written).some((f) => f.type === 'RELAY_REQUEST')).toBe(false);
    hub.close();
  });

  it('forwards RELAY_REQUEST when PARTY_JOIN already occurred', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const a = createMockSocket();
    const b = createMockSocket();
    hub.addConnection(a.socket);
    answerHelloChallenge(a.written, a.duplex, TEST_LINK_KEY, 'leaf1');
    await tick();
    hub.addConnection(b.socket);
    answerHelloChallenge(b.written, b.duplex, TEST_LINK_KEY, 'leaf2');
    await tick();

    pushFrame(a.duplex, { type: 'PARTY_JOIN', handle: 'eve', fromBot: 'leaf1' });
    await tick();
    a.written.length = 0;
    b.written.length = 0;

    pushFrame(a.duplex, { type: 'RELAY_REQUEST', handle: 'eve', toBot: 'leaf2' });
    await tick();

    expect(parseWritten(b.written).some((f) => f.type === 'RELAY_REQUEST')).toBe(true);
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Non-loopback listen warning — botlink expects a loopback bind by default;
// listening on a public address (or 0.0.0.0) without the explicit override
// must surface a WARNING-level log so an operator notices.
// ---------------------------------------------------------------------------

describe('hub listen() non-loopback warning', () => {
  function mockLogger(warns: string[]): {
    child: () => {
      info: () => void;
      warn: (msg: string) => void;
      debug: () => void;
      error: () => void;
    };
  } {
    return {
      child: () => ({
        info: () => {},
        warn: (msg: string) => warns.push(msg),
        debug: () => {},
        error: () => {},
      }),
    };
  }

  it('warns [security] when bound to 0.0.0.0 (non-loopback, non-RFC1918)', async () => {
    const warns: string[] = [];
    const hub = new BotLinkHub(hubConfig(), '1.0.0', mockLogger(warns) as never);
    // 0.0.0.0 binds to every interface — available on the test host
    // unlike a truly public IP, and still non-loopback so the warning
    // path fires.
    await hub.listen(0, '0.0.0.0');
    expect(warns.some((w) => w.startsWith('[security]') && w.includes('0.0.0.0'))).toBe(true);
    hub.close();
  });

  it('does NOT warn when bound to 127.0.0.1', async () => {
    const warns: string[] = [];
    const hub = new BotLinkHub(hubConfig(), '1.0.0', mockLogger(warns) as never);
    await hub.listen(0, '127.0.0.1');
    expect(warns.some((w) => w.startsWith('[security]'))).toBe(false);
    hub.close();
  });

  it('does NOT warn when bound to RFC1918 (10.0.0.0/8)', async () => {
    const warns: string[] = [];
    const hub = new BotLinkHub(hubConfig(), '1.0.0', mockLogger(warns) as never);
    await hub.listen(0, '127.0.0.1'); // Bind loopback to succeed; assert directly on helper
    expect(warns.some((w) => w.startsWith('[security]'))).toBe(false);
    hub.close();
    // Separate assertion via the pure helper so we don't actually bind to 10.x.
    const { isPrivateOrLoopback } = await import('../../src/core/botlink');
    expect(isPrivateOrLoopback('10.0.0.5')).toBe(true);
    expect(isPrivateOrLoopback('172.16.5.1')).toBe(true);
    expect(isPrivateOrLoopback('192.168.100.10')).toBe(true);
    expect(isPrivateOrLoopback('::1')).toBe(true);
    expect(isPrivateOrLoopback('0.0.0.0')).toBe(false);
    expect(isPrivateOrLoopback('::')).toBe(false);
    expect(isPrivateOrLoopback('2001:db8::1')).toBe(false);
  });
});
