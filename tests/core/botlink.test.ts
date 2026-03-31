import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import {
  BotLinkHub,
  BotLinkLeaf,
  BotLinkProtocol,
  MAX_FRAME_SIZE,
  RateCounter,
  hashPassword,
  sanitizeFrame,
} from '../../src/core/botlink';
import type { LinkFrame, SocketFactory } from '../../src/core/botlink';
import { Permissions } from '../../src/core/permissions';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock socket that captures writes and allows pushing data. */
function createMockSocket(): Socket & { written: string[] } {
  const written: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  (socket as unknown as { written: string[] }).written = written;
  return socket as unknown as Socket & { written: string[] };
}

/** Push a JSON frame into a mock socket (simulating incoming data). */
function pushFrame(socket: Socket, frame: LinkFrame): void {
  (socket as unknown as Duplex).push(JSON.stringify(frame) + '\r\n');
}

/** Parse all JSON frames from the written buffer. */
function parseWritten(written: string[]): LinkFrame[] {
  const frames: LinkFrame[] = [];
  for (const chunk of written) {
    for (const line of chunk.split('\r\n')) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        // not JSON
      }
    }
  }
  return frames;
}

/** Wait for async processing (microtasks). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const TEST_PASSWORD = 'test-secret-password';
const TEST_HASH = hashPassword(TEST_PASSWORD);

function hubConfig(overrides?: Partial<BotlinkConfig>): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'hub',
    listen: { host: '0.0.0.0', port: 5051 },
    password: TEST_PASSWORD,
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
    hub: { host: '127.0.0.1', port: 5051 },
    password: TEST_PASSWORD,
    reconnect_delay_ms: 100,
    reconnect_max_delay_ms: 1000,
    ping_interval_ms: 60_000,
    link_timeout_ms: 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hashPassword
// ---------------------------------------------------------------------------

describe('hashPassword', () => {
  it('returns sha256: prefixed hex digest', () => {
    const hash = hashPassword('hello');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('produces consistent output', () => {
    expect(hashPassword('test')).toBe(hashPassword('test'));
  });

  it('produces different output for different inputs', () => {
    expect(hashPassword('a')).not.toBe(hashPassword('b'));
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
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    pushFrame(socket, { type: 'PING', seq: 1 });
    await tick();

    expect(received).toEqual([{ type: 'PING', seq: 1 }]);
  });

  it('sends a JSON frame with \\r\\n terminator', () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);

    protocol.send({ type: 'PONG', seq: 1 });

    const frames = parseWritten(socket.written);
    expect(frames).toEqual([{ type: 'PONG', seq: 1 }]);
    // Check raw output has \r\n
    expect(socket.written[0]).toContain('\r\n');
  });

  it('round-trips a frame', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    const original = { type: 'CHAN', channel: '#test', topic: 'Hello', users: [] };
    pushFrame(socket, original);
    await tick();

    expect(received[0]).toEqual(original);
  });

  it('sanitizes string fields in incoming frames', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    // Push raw JSON with \r\n embedded in a string value (not in the frame delimiter)
    const raw = JSON.stringify({ type: 'TEST', nick: 'evil\r\nPRIVMSG #hack :pwned' });
    (socket as unknown as Duplex).push(raw + '\r\n');
    await tick();

    expect(received[0].nick).toBe('evilPRIVMSG #hack :pwned');
  });

  it('rejects frames exceeding 64KB', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    // Push a line that exceeds MAX_FRAME_SIZE
    const bigPayload = 'x'.repeat(MAX_FRAME_SIZE + 1);
    (socket as unknown as Duplex).push(bigPayload + '\r\n');
    await tick();

    expect(received).toEqual([]); // Frame was rejected
    // Hub should have sent an ERROR frame
    const sent = parseWritten(socket.written);
    expect(sent.some((f) => f.type === 'ERROR' && f.code === 'FRAME_TOO_LARGE')).toBe(true);
  });

  it('rejects outbound frames exceeding 64KB', () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);

    const bigData = 'x'.repeat(MAX_FRAME_SIZE);
    const result = protocol.send({ type: 'TEST', data: bigData });
    expect(result).toBe(false);
  });

  it('ignores frames with no type field', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    (socket as unknown as Duplex).push('{"noType": true}\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('ignores malformed JSON', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    (socket as unknown as Duplex).push('not json at all\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('returns false from send() when closed', () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    protocol.close();

    expect(protocol.send({ type: 'PING', seq: 1 })).toBe(false);
    expect(protocol.isClosed).toBe(true);
  });

  it('fires onClose when socket closes', async () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    let closed = false;
    protocol.onClose = () => {
      closed = true;
    };

    socket.destroy();
    await tick();

    expect(closed).toBe(true);
    expect(protocol.isClosed).toBe(true);
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
      const socket = createMockSocket();
      hub.addConnection(socket);

      pushFrame(socket, {
        type: 'HELLO',
        botname: 'leaf1',
        password: TEST_HASH,
        version: '1.0.0',
      });
      await tick();

      const frames = parseWritten(socket.written);
      const types = frames.map((f) => f.type);
      expect(types).toEqual(['WELCOME', 'SYNC_START', 'SYNC_END']);
      expect(frames[0].botname).toBe('hub');
      expect(hub.getLeaves()).toEqual(['leaf1']);
    });

    it('fires onLeafConnected callback', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const connected: string[] = [];
      hub.onLeafConnected = (name) => connected.push(name);

      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();

      expect(connected).toEqual(['leaf1']);
    });

    it('rejects wrong password with AUTH_FAILED', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);

      pushFrame(socket, {
        type: 'HELLO',
        botname: 'leaf1',
        password: 'sha256:wrong',
        version: '1.0',
      });
      await tick();

      const frames = parseWritten(socket.written);
      expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'AUTH_FAILED' });
      expect(hub.getLeaves()).toEqual([]);
    });

    it('rejects duplicate botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');

      // Connect first leaf
      const socket1 = createMockSocket();
      hub.addConnection(socket1);
      pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();

      // Try to connect with same botname
      const socket2 = createMockSocket();
      hub.addConnection(socket2);
      pushFrame(socket2, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();

      const frames = parseWritten(socket2.written);
      expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'DUPLICATE' });
    });

    it('rejects when hub is at max capacity', async () => {
      const hub = new BotLinkHub(hubConfig({ max_leaves: 1 }), '1.0.0');

      const socket1 = createMockSocket();
      hub.addConnection(socket1);
      pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();

      const socket2 = createMockSocket();
      hub.addConnection(socket2);
      pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1.0' });
      await tick();

      const frames = parseWritten(socket2.written);
      expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'FULL' });
    });

    it('rejects missing botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);

      pushFrame(socket, { type: 'HELLO', botname: '', password: TEST_HASH, version: '1.0' });
      await tick();

      const frames = parseWritten(socket.written);
      expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'INVALID' });
    });

    it('rejects non-HELLO as first frame', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);

      pushFrame(socket, { type: 'PING', seq: 1 });
      await tick();

      const frames = parseWritten(socket.written);
      expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'PROTOCOL' });
    });

    it('times out if HELLO not received within 30s', async () => {
      vi.useFakeTimers();
      try {
        const hub = new BotLinkHub(hubConfig(), '1.0.0');
        const socket = createMockSocket();
        hub.addConnection(socket);

        await vi.advanceTimersByTimeAsync(30_001);

        const frames = parseWritten(socket.written);
        expect(frames[0]).toMatchObject({ type: 'ERROR', code: 'TIMEOUT' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('broadcasts BOTJOIN to existing leaves', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');

      // Connect leaf1
      const socket1 = createMockSocket();
      hub.addConnection(socket1);
      pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();
      socket1.written.length = 0; // Clear initial frames

      // Connect leaf2
      const socket2 = createMockSocket();
      hub.addConnection(socket2);
      pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1.0' });
      await tick();

      // leaf1 should have received BOTJOIN for leaf2
      const leaf1Frames = parseWritten(socket1.written);
      expect(leaf1Frames.some((f) => f.type === 'BOTJOIN' && f.botname === 'leaf2')).toBe(true);
    });

    it('calls onSyncRequest during handshake', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      hub.onSyncRequest = (_botname, send) => {
        send({ type: 'ADDUSER', handle: 'admin', hostmasks: ['*!*@admin.host'] });
      };

      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
      await tick();

      const frames = parseWritten(socket.written);
      const types = frames.map((f) => f.type);
      expect(types).toEqual(['WELCOME', 'SYNC_START', 'ADDUSER', 'SYNC_END']);
    });
  });

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  describe('fan-out', () => {
    let hub: BotLinkHub;
    let socket1: Socket & { written: string[] };
    let socket2: Socket & { written: string[] };
    let socket3: Socket & { written: string[] };

    beforeEach(async () => {
      hub = new BotLinkHub(hubConfig(), '1.0.0');

      socket1 = createMockSocket();
      socket2 = createMockSocket();
      socket3 = createMockSocket();

      hub.addConnection(socket1);
      pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();

      hub.addConnection(socket2);
      pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
      await tick();

      hub.addConnection(socket3);
      pushFrame(socket3, { type: 'HELLO', botname: 'leaf3', password: TEST_HASH, version: '1' });
      await tick();

      // Clear handshake frames
      socket1.written.length = 0;
      socket2.written.length = 0;
      socket3.written.length = 0;
    });

    afterEach(() => {
      hub.close();
    });

    it('forwards a JOIN frame from leaf1 to leaf2 and leaf3 but NOT back to leaf1', async () => {
      const joinFrame = { type: 'JOIN', channel: '#test', nick: 'user1' };
      pushFrame(socket1, joinFrame);
      await tick();

      expect(parseWritten(socket1.written)).toEqual([]); // Not echoed back
      expect(parseWritten(socket2.written)).toContainEqual(joinFrame);
      expect(parseWritten(socket3.written)).toContainEqual(joinFrame);
    });

    it('forwards PARTY_CHAT to other leaves', async () => {
      const chat = { type: 'PARTY_CHAT', handle: 'admin', fromBot: 'leaf1', message: 'hello' };
      pushFrame(socket1, chat);
      await tick();

      expect(parseWritten(socket2.written)).toContainEqual(chat);
      expect(parseWritten(socket3.written)).toContainEqual(chat);
      expect(parseWritten(socket1.written)).toEqual([]);
    });

    it('does NOT fan-out CMD frames (hub-only)', async () => {
      pushFrame(socket1, { type: 'CMD', command: '.users', args: '', fromHandle: 'admin' });
      await tick();

      expect(parseWritten(socket2.written)).toEqual([]);
      expect(parseWritten(socket3.written)).toEqual([]);
    });

    it('does NOT fan-out PROTECT_ACK frames (hub-routed)', async () => {
      pushFrame(socket1, { type: 'PROTECT_ACK', ref: 'abc', success: true });
      await tick();

      expect(parseWritten(socket2.written)).toEqual([]);
    });

    it('fans out PROTECT_OP to other leaves', async () => {
      const protectOp = {
        type: 'PROTECT_OP',
        channel: '#chan',
        nick: 'bot1',
        requestedBy: 'leaf1',
      };
      pushFrame(socket1, protectOp);
      await tick();

      expect(parseWritten(socket2.written)).toContainEqual(protectOp);
      expect(parseWritten(socket3.written)).toContainEqual(protectOp);
    });

    it('notifies onLeafFrame for all steady-state frames', async () => {
      const received: Array<{ botname: string; frame: LinkFrame }> = [];
      hub.onLeafFrame = (botname, frame) => received.push({ botname, frame });

      pushFrame(socket1, { type: 'JOIN', channel: '#test', nick: 'u' });
      pushFrame(socket2, { type: 'CMD', command: '.help', args: '', fromHandle: 'op' });
      await tick();

      expect(received).toHaveLength(2);
      expect(received[0].botname).toBe('leaf1');
      expect(received[1].botname).toBe('leaf2');
    });

    it('broadcasts BOTPART when a leaf disconnects', async () => {
      socket2.written.length = 0;
      socket3.written.length = 0;
      socket1.destroy();
      await tick();

      const leaf2Frames = parseWritten(socket2.written);
      const leaf3Frames = parseWritten(socket3.written);
      expect(leaf2Frames.some((f) => f.type === 'BOTPART' && f.botname === 'leaf1')).toBe(true);
      expect(leaf3Frames.some((f) => f.type === 'BOTPART' && f.botname === 'leaf1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('rate-limits CMD frames at 10/sec', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();
      socket.written.length = 0;

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // Send 11 CMD frames rapidly
      for (let i = 0; i < 11; i++) {
        pushFrame(socket, { type: 'CMD', command: '.help', args: '', fromHandle: 'admin' });
      }
      await tick();

      // 10 should go through, 11th should be rate-limited
      const cmdFrames = received.filter((f) => f.type === 'CMD');
      expect(cmdFrames).toHaveLength(10);

      // Leaf should receive ERROR for the rate-limited one
      const sent = parseWritten(socket.written);
      expect(sent.some((f) => f.type === 'ERROR' && f.code === 'RATE_LIMITED')).toBe(true);

      hub.close();
    });

    it('rate-limits PARTY_CHAT at 5/sec and silently drops', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();
      socket.written.length = 0;

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      for (let i = 0; i < 7; i++) {
        pushFrame(socket, {
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
      const sent = parseWritten(socket.written);
      expect(sent.every((f) => f.type !== 'ERROR')).toBe(true);

      hub.close();
    });

    it('does NOT rate-limit PROTECT_* frames', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();

      const received: LinkFrame[] = [];
      hub.onLeafFrame = (_b, f) => received.push(f);

      // Send 20 PROTECT_OP frames rapidly
      for (let i = 0; i < 20; i++) {
        pushFrame(socket, {
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

  // -------------------------------------------------------------------------
  // Hub management
  // -------------------------------------------------------------------------

  describe('management', () => {
    it('send() delivers frame to a specific leaf', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      hub.addConnection(socket1);
      pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();

      hub.addConnection(socket2);
      pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
      await tick();

      socket1.written.length = 0;
      socket2.written.length = 0;

      hub.send('leaf1', { type: 'CMD_RESULT', ref: 'r1', output: ['done'] });

      expect(parseWritten(socket1.written)).toContainEqual({
        type: 'CMD_RESULT',
        ref: 'r1',
        output: ['done'],
      });
      expect(parseWritten(socket2.written)).toEqual([]);

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

      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();

      const info = hub.getLeafInfo('leaf1');
      expect(info).not.toBeNull();
      expect(info!.botname).toBe('leaf1');
      expect(info!.connectedAt).toBeGreaterThan(0);

      hub.close();
    });

    it('close() sends ERROR to all leaves and clears state', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();
      socket.written.length = 0;

      hub.close();

      const frames = parseWritten(socket.written);
      expect(frames.some((f) => f.type === 'ERROR' && f.code === 'CLOSING')).toBe(true);
      expect(hub.getLeaves()).toEqual([]);
    });

    it('fires onLeafDisconnected when a leaf closes', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const disconnected: Array<{ name: string; reason: string }> = [];
      hub.onLeafDisconnected = (name, reason) => disconnected.push({ name, reason });

      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();

      socket.destroy();
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
      const socket = createMockSocket();
      hub.addConnection(socket);
      pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
      await tick();
      socket.written.length = 0;

      pushFrame(socket, { type: 'PING', seq: 42 });
      await tick();

      const frames = parseWritten(socket.written);
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

        const socket = createMockSocket();
        hub.addConnection(socket);
        pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
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
    it('sends HELLO and transitions to connected on WELCOME', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const socket = createMockSocket();
      let connectedHub = '';
      leaf.onConnected = (hubName) => {
        connectedHub = hubName;
      };

      leaf.connectWithSocket(socket);
      await tick();

      // Check HELLO was sent
      const sent = parseWritten(socket.written);
      expect(sent[0]).toMatchObject({ type: 'HELLO', botname: 'leaf1' });
      expect(sent[0].password).toBe(TEST_HASH); // Hash, not plaintext

      // Simulate hub WELCOME
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0.0' });
      await tick();

      expect(leaf.isConnected).toBe(true);
      expect(leaf.hubName).toBe('hub');
      expect(connectedHub).toBe('hub');
    });

    it('handles ERROR with AUTH_FAILED without reconnecting', async () => {
      vi.useFakeTimers();
      try {
        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
        const socket = createMockSocket();

        leaf.connectWithSocket(socket);
        await vi.advanceTimersByTimeAsync(0);

        pushFrame(socket, { type: 'ERROR', code: 'AUTH_FAILED', message: 'Bad password' });
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
      const socket = createMockSocket();
      const received: LinkFrame[] = [];
      leaf.onFrame = (frame) => received.push(frame);

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      pushFrame(socket, { type: 'SYNC_START' });
      pushFrame(socket, { type: 'ADDUSER', handle: 'admin', hostmasks: ['*!*@host'] });
      pushFrame(socket, { type: 'SYNC_END' });
      pushFrame(socket, { type: 'BOTJOIN', botname: 'leaf2' });
      await tick();

      const types = received.map((f) => f.type);
      expect(types).toEqual(['SYNC_START', 'ADDUSER', 'SYNC_END', 'BOTJOIN']);
    });

    it('responds to PING with PONG in steady state', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const socket = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      socket.written.length = 0;

      pushFrame(socket, { type: 'PING', seq: 7 });
      await tick();

      const sent = parseWritten(socket.written);
      expect(sent).toContainEqual({ type: 'PONG', seq: 7 });
    });

    it('does not forward PING/PONG to onFrame', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const socket = createMockSocket();
      const received: LinkFrame[] = [];
      leaf.onFrame = (frame) => received.push(frame);

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      pushFrame(socket, { type: 'PING', seq: 1 });
      pushFrame(socket, { type: 'PONG', seq: 1 });
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
      const socket = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      socket.written.length = 0;

      leaf.sendCommand('.adduser', 'newuser *!*@host m', 'admin', null);

      const sent = parseWritten(socket.written);
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
      const socket = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      socket.written.length = 0;

      // Start protect request (don't await yet)
      const promise = leaf.sendProtect('PROTECT_OP', '#channel', 'leaf1');
      await tick();

      const sent = parseWritten(socket.written);
      expect(sent[0]).toMatchObject({
        type: 'PROTECT_OP',
        channel: '#channel',
        nick: 'leaf1',
        requestedBy: 'leaf1',
      });

      // Send ACK back with the ref
      pushFrame(socket, { type: 'PROTECT_ACK', ref: sent[0].ref, success: true });
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
        const socket = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
      const socket = createMockSocket();
      let disconnectReason = '';
      leaf.onDisconnected = (reason) => {
        disconnectReason = reason;
      };

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();

      socket.destroy();
      await tick();

      expect(disconnectReason).toBe('Connection lost');
    });

    it('does NOT fire onDisconnected on explicit disconnect', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const socket = createMockSocket();
      let disconnectFired = false;
      leaf.onDisconnected = () => {
        disconnectFired = true;
      };

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
        const sockets: Array<Socket & { written: string[] }> = [];
        const factory: SocketFactory = () => {
          const s = createMockSocket();
          sockets.push(s);
          // Simulate immediate connection by emitting 'connect' on next tick
          setImmediate(() => s.emit('connect'));
          return s;
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
        const sock1 = sockets[0];
        pushFrame(sock1, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Simulate disconnect
        sock1.destroy();
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(false);

        // Should reconnect after 100ms
        await vi.advanceTimersByTimeAsync(101);
        expect(sockets).toHaveLength(2);

        // Second connection succeeds
        const sock2 = sockets[1];
        pushFrame(sock2, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
        const sockets: Array<Socket & { written: string[] }> = [];
        const factory: SocketFactory = () => {
          const s = createMockSocket();
          sockets.push(s);
          setImmediate(() => s.emit('connect'));
          return s;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);

        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        pushFrame(sockets[0], { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Force reconnect
        leaf.reconnect();
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(2);

        pushFrame(sockets[1], { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
    it('sends HELLO after TCP connect event fires', async () => {
      vi.useFakeTimers();
      try {
        const sockets: Array<Socket & { written: string[] }> = [];
        const factory: SocketFactory = () => {
          const s = createMockSocket();
          sockets.push(s);
          setImmediate(() => s.emit('connect'));
          return s;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);

        expect(sockets).toHaveLength(1);
        const sent = parseWritten(sockets[0].written);
        expect(sent[0]).toMatchObject({ type: 'HELLO', botname: 'leaf1' });
        expect(sent[0].password).toBe(TEST_HASH);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not connect if already connected', async () => {
      vi.useFakeTimers();
      try {
        const sockets: Array<Socket & { written: string[] }> = [];
        const factory: SocketFactory = () => {
          const s = createMockSocket();
          sockets.push(s);
          setImmediate(() => s.emit('connect'));
          return s;
        };

        const leaf = new BotLinkLeaf(leafConfig(), '1.0.0', null, factory);
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        pushFrame(sockets[0], { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.isConnected).toBe(true);

        // Second call should be a no-op
        leaf.connect();
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(1);

        leaf.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not connect if hub host/port is missing', async () => {
      const sockets: Array<Socket & { written: string[] }> = [];
      const factory: SocketFactory = () => {
        const s = createMockSocket();
        sockets.push(s);
        return s;
      };

      const leaf = new BotLinkLeaf(
        leafConfig({ hub: undefined as unknown as { host: string; port: number } }),
        '1.0.0',
        null,
        factory,
      );
      leaf.connect();
      await tick();

      expect(sockets).toHaveLength(0);
    });

    it('schedules reconnect on TCP connection error', async () => {
      vi.useFakeTimers();
      try {
        const sockets: Array<Socket & { written: string[] }> = [];
        let callCount = 0;
        const factory: SocketFactory = () => {
          const s = createMockSocket();
          sockets.push(s);
          callCount++;
          if (callCount === 1) {
            // First attempt: emit error
            setImmediate(() => s.emit('error', new Error('ECONNREFUSED')));
          } else {
            // Second attempt: success
            setImmediate(() => s.emit('connect'));
          }
          return s;
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
        expect(sockets).toHaveLength(1);

        // After reconnect_delay_ms, should try again
        await vi.advanceTimersByTimeAsync(101);
        expect(sockets).toHaveLength(2);

        // Second socket succeeds
        pushFrame(sockets[1], { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
      const socket = createMockSocket();

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await tick();
      socket.written.length = 0;

      const promise = leaf.requestWhom();
      await tick();

      const sent = parseWritten(socket.written);
      const whomFrame = sent.find((f) => f.type === 'PARTY_WHOM');
      expect(whomFrame).toBeDefined();

      pushFrame(socket, {
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
        const socket = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
        const socket = createMockSocket();

        leaf.connectWithSocket(socket);
        pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
        await vi.advanceTimersByTimeAsync(0);
        socket.written.length = 0;

        const promise = leaf.sendProtect('PROTECT_OP', '#chan', 'bot1', 2_000);
        await vi.advanceTimersByTimeAsync(0);

        // Verify the frame was sent
        const sent = parseWritten(socket.written);
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
    socket: Socket & { written: string[] };
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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1.0' });
    await tick();
    socket.written.length = 0;

    return { hub, perms, eventBus, socket };
  }

  it('broadcasts ADDUSER when a user is added on the hub', async () => {
    const { hub, perms, socket } = await setupHubWithLeaf();

    perms.addUser('newguy', '*!new@host', 'ov');
    await tick();

    const frames = parseWritten(socket.written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('newguy');
    expect(addFrame!.hostmasks).toEqual(['*!new@host']);
    expect(addFrame!.globalFlags).toBe('ov');

    hub.close();
  });

  it('broadcasts ADDUSER when a hostmask is added', async () => {
    const { hub, perms, socket } = await setupHubWithLeaf();

    perms.addUser('someone', '*!s@host1', 'v');
    socket.written.length = 0;

    perms.addHostmask('someone', '*!s@host2');
    await tick();

    const frames = parseWritten(socket.written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('someone');
    expect(addFrame!.hostmasks).toContain('*!s@host1');
    expect(addFrame!.hostmasks).toContain('*!s@host2');

    hub.close();
  });

  it('broadcasts ADDUSER when a hostmask is removed', async () => {
    const { hub, perms, socket } = await setupHubWithLeaf();

    perms.addUser('multi', '*!m@host1', 'o');
    perms.addHostmask('multi', '*!m@host2');
    socket.written.length = 0;

    perms.removeHostmask('multi', '*!m@host2');
    await tick();

    const frames = parseWritten(socket.written);
    const addFrame = frames.find((f) => f.type === 'ADDUSER');
    expect(addFrame).toBeDefined();
    expect(addFrame!.handle).toBe('multi');
    expect(addFrame!.hostmasks).toEqual(['*!m@host1']);

    hub.close();
  });

  it('broadcasts DELUSER when a user is removed on the hub', async () => {
    const { hub, perms, socket } = await setupHubWithLeaf();

    perms.addUser('temp', '*!t@host', 'v');
    socket.written.length = 0;

    perms.removeUser('temp');
    await tick();

    const frames = parseWritten(socket.written);
    const delFrame = frames.find((f) => f.type === 'DELUSER');
    expect(delFrame).toBeDefined();
    expect(delFrame!.handle).toBe('temp');

    hub.close();
  });

  it('broadcasts SETFLAGS when flags change', async () => {
    const { hub, perms, socket } = await setupHubWithLeaf();

    perms.addUser('flaguser', '*!f@host', 'v');
    socket.written.length = 0;

    perms.setGlobalFlags('flaguser', 'ov');
    await tick();

    const frames = parseWritten(socket.written);
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

    const socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    const socket2 = createMockSocket();
    hub.addConnection(socket2);
    pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
    await tick();

    socket1.written.length = 0;
    socket2.written.length = 0;

    perms.addUser('broadcast', '*!b@host', 'o');
    await tick();

    const frames1 = parseWritten(socket1.written);
    const frames2 = parseWritten(socket2.written);
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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket.written.length = 0;

    // Send CMD for a command that does not exist
    pushFrame(socket, {
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

    const frames = parseWritten(socket.written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-unknown');
    expect((result!.output as string[])[0]).toMatch(/Unknown command/);

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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket.written.length = 0;

    pushFrame(socket, {
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

    const frames = parseWritten(socket.written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    expect(result!.ref).toBe('ref-boom');
    expect((result!.output as string[])[0]).toMatch(/Error: Kaboom/);

    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Hub: RELAY_* routing between two leaves
// ---------------------------------------------------------------------------

describe('BotLinkHub relay routing', () => {
  let hub: BotLinkHub;
  let socket1: Socket & { written: string[] };
  let socket2: Socket & { written: string[] };

  beforeEach(async () => {
    hub = new BotLinkHub(hubConfig(), '1.0.0');

    socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    socket2 = createMockSocket();
    hub.addConnection(socket2);
    pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
    await tick();

    socket1.written.length = 0;
    socket2.written.length = 0;
  });

  afterEach(() => {
    hub.close();
  });

  it('routes RELAY_REQUEST from leaf1 to leaf2', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();

    const frames2 = parseWritten(socket2.written);
    expect(frames2.some((f) => f.type === 'RELAY_REQUEST' && f.handle === 'admin')).toBe(true);
    // leaf1 should NOT receive its own request back
    expect(parseWritten(socket1.written).filter((f) => f.type === 'RELAY_REQUEST')).toEqual([]);
  });

  it('returns RELAY_END when target bot is not connected', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'nonexistent',
    });
    await tick();

    const frames1 = parseWritten(socket1.written);
    const endFrame = frames1.find((f) => f.type === 'RELAY_END');
    expect(endFrame).toBeDefined();
    expect(endFrame!.handle).toBe('admin');
    expect(endFrame!.reason).toMatch(/not connected/);
  });

  it('routes RELAY_ACCEPT from target back to origin', async () => {
    // First set up the relay
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    socket1.written.length = 0;
    socket2.written.length = 0;

    // leaf2 accepts
    pushFrame(socket2, {
      type: 'RELAY_ACCEPT',
      handle: 'admin',
    });
    await tick();

    const frames1 = parseWritten(socket1.written);
    expect(frames1.some((f) => f.type === 'RELAY_ACCEPT' && f.handle === 'admin')).toBe(true);
    // leaf2 should NOT get its own ACCEPT echoed
    expect(parseWritten(socket2.written)).toEqual([]);
  });

  it('routes RELAY_INPUT from origin to target', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    socket1.written.length = 0;
    socket2.written.length = 0;

    // origin sends input to target
    pushFrame(socket1, {
      type: 'RELAY_INPUT',
      handle: 'admin',
      data: 'hello world',
    });
    await tick();

    const frames2 = parseWritten(socket2.written);
    expect(frames2.some((f) => f.type === 'RELAY_INPUT' && f.data === 'hello world')).toBe(true);
    expect(parseWritten(socket1.written)).toEqual([]);
  });

  it('routes RELAY_OUTPUT from target to origin', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    socket1.written.length = 0;
    socket2.written.length = 0;

    // target sends output to origin
    pushFrame(socket2, {
      type: 'RELAY_OUTPUT',
      handle: 'admin',
      data: 'response data',
    });
    await tick();

    const frames1 = parseWritten(socket1.written);
    expect(frames1.some((f) => f.type === 'RELAY_OUTPUT' && f.data === 'response data')).toBe(true);
    expect(parseWritten(socket2.written)).toEqual([]);
  });

  it('routes RELAY_END from origin to target and cleans up', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    socket1.written.length = 0;
    socket2.written.length = 0;

    // origin ends the relay
    pushFrame(socket1, {
      type: 'RELAY_END',
      handle: 'admin',
      reason: 'done',
    });
    await tick();

    const frames2 = parseWritten(socket2.written);
    expect(frames2.some((f) => f.type === 'RELAY_END' && f.handle === 'admin')).toBe(true);

    // After cleanup, further input should not route
    socket1.written.length = 0;
    socket2.written.length = 0;
    pushFrame(socket1, {
      type: 'RELAY_INPUT',
      handle: 'admin',
      data: 'after-end',
    });
    await tick();

    expect(parseWritten(socket2.written)).toEqual([]);
  });

  it('routes RELAY_END from target back to origin', async () => {
    pushFrame(socket1, {
      type: 'RELAY_REQUEST',
      handle: 'admin',
      toBot: 'leaf2',
    });
    await tick();
    socket1.written.length = 0;
    socket2.written.length = 0;

    // target ends the relay
    pushFrame(socket2, {
      type: 'RELAY_END',
      handle: 'admin',
      reason: 'target closed',
    });
    await tick();

    const frames1 = parseWritten(socket1.written);
    expect(frames1.some((f) => f.type === 'RELAY_END' && f.handle === 'admin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hub: PROTECT_ACK routing
// ---------------------------------------------------------------------------

describe('BotLinkHub PROTECT_ACK routing', () => {
  it('routes PROTECT_ACK from responder back to requester', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    const socket2 = createMockSocket();
    hub.addConnection(socket2);
    pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
    await tick();

    socket1.written.length = 0;
    socket2.written.length = 0;

    // leaf1 sends a PROTECT_OP (request) with a ref
    pushFrame(socket1, {
      type: 'PROTECT_OP',
      channel: '#chan',
      nick: 'bot1',
      requestedBy: 'leaf1',
      ref: 'protect-ref-1',
    });
    await tick();

    // leaf2 should have received the PROTECT_OP (fan-out)
    const frames2 = parseWritten(socket2.written);
    expect(frames2.some((f) => f.type === 'PROTECT_OP' && f.ref === 'protect-ref-1')).toBe(true);

    socket1.written.length = 0;
    socket2.written.length = 0;

    // leaf2 responds with PROTECT_ACK using the same ref
    pushFrame(socket2, {
      type: 'PROTECT_ACK',
      ref: 'protect-ref-1',
      success: true,
    });
    await tick();

    // leaf1 should receive the ACK (routed back by hub)
    const frames1 = parseWritten(socket1.written);
    const ack = frames1.find((f) => f.type === 'PROTECT_ACK');
    expect(ack).toBeDefined();
    expect(ack!.ref).toBe('protect-ref-1');
    expect(ack!.success).toBe(true);

    // leaf2 should NOT receive its own ACK
    expect(parseWritten(socket2.written)).toEqual([]);

    hub.close();
  });

  it('does not route PROTECT_ACK for unknown ref', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket1.written.length = 0;

    // Send ACK with ref that has no matching request
    pushFrame(socket1, {
      type: 'PROTECT_ACK',
      ref: 'unknown-ref',
      success: true,
    });
    await tick();

    // No frames should be sent (no routing target)
    expect(parseWritten(socket1.written)).toEqual([]);

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

    const socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket1.written.length = 0;

    // Inject a remote party user via PARTY_JOIN from leaf1
    pushFrame(socket1, {
      type: 'PARTY_JOIN',
      handle: 'remoteuser',
      nick: 'RemoteNick',
      fromBot: 'leaf1',
    });
    await tick();
    socket1.written.length = 0;

    // Now request .whom
    pushFrame(socket1, { type: 'PARTY_WHOM', ref: 'whom-ref-1' });
    await tick();

    const frames = parseWritten(socket1.written);
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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket.written.length = 0;

    pushFrame(socket, { type: 'PARTY_WHOM', ref: 'whom-ref-2' });
    await tick();

    const frames = parseWritten(socket.written);
    const reply = frames.find((f) => f.type === 'PARTY_WHOM_REPLY');
    expect(reply).toBeDefined();
    expect(reply!.ref).toBe('whom-ref-2');
    expect(reply!.users).toEqual([]);

    hub.close();
  });

  it('cleans up remote party users on leaf disconnect', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');

    const socket1 = createMockSocket();
    hub.addConnection(socket1);
    pushFrame(socket1, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    // Inject remote party user from leaf1
    pushFrame(socket1, {
      type: 'PARTY_JOIN',
      handle: 'leafuser',
      nick: 'LeafNick',
      fromBot: 'leaf1',
    });
    await tick();

    // Connect leaf2 to query whom after leaf1 disconnects
    const socket2 = createMockSocket();
    hub.addConnection(socket2);
    pushFrame(socket2, { type: 'HELLO', botname: 'leaf2', password: TEST_HASH, version: '1' });
    await tick();

    // Disconnect leaf1
    socket1.destroy();
    await tick();

    socket2.written.length = 0;
    pushFrame(socket2, { type: 'PARTY_WHOM', ref: 'whom-ref-3' });
    await tick();

    const frames = parseWritten(socket2.written);
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
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    const received: LinkFrame[] = [];
    protocol.onFrame = (frame) => received.push(frame);

    protocol.close();
    (socket as unknown as Duplex).push(JSON.stringify({ type: 'LATE' }) + '\r\n');
    await tick();

    expect(received).toEqual([]);
  });

  it('returns false from send() when socket is destroyed', () => {
    const socket = createMockSocket();
    const protocol = new BotLinkProtocol(socket, null);
    (socket as unknown as Duplex).destroy();
    expect(protocol.send({ type: 'TEST' })).toBe(false);
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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    pushFrame(socket, { type: 'PONG', seq: 99 });
    await tick();

    expect(received.filter((f) => f.type === 'PONG')).toHaveLength(0);
    hub.close();
  });

  it('tracks PARTY_PART to remove remote users', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    pushFrame(socket, { type: 'PARTY_JOIN', handle: 'user1', nick: 'U', fromBot: 'leaf1' });
    await tick();
    expect(hub.getRemotePartyUsers()).toHaveLength(1);

    pushFrame(socket, { type: 'PARTY_PART', handle: 'user1', fromBot: 'leaf1' });
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
      const socket = createMockSocket();
      let disconnected = false;
      leaf.onDisconnected = () => {
        disconnected = true;
      };

      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);
      socket.written.length = 0;

      await vi.advanceTimersByTimeAsync(101);
      const sent = parseWritten(socket.written);
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
      const socket = createMockSocket();
      leaf.connectWithSocket(socket);
      pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
      const sockets: Array<Socket & { written: string[] }> = [];
      const factory: SocketFactory = () => {
        const s = createMockSocket();
        sockets.push(s);
        setImmediate(() => s.emit('connect'));
        return s;
      };

      const leaf = new BotLinkLeaf(leafConfig({ reconnect_delay_ms: 100 }), '1.0.0', null, factory);
      leaf.connect();
      await vi.advanceTimersByTimeAsync(1);
      pushFrame(sockets[0], { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);

      sockets[0].destroy();
      await vi.advanceTimersByTimeAsync(0);

      leaf.disconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scheduleReconnect fires after connection lost', async () => {
    vi.useFakeTimers();
    try {
      const sockets: Array<Socket & { written: string[] }> = [];
      const factory: SocketFactory = () => {
        const s = createMockSocket();
        sockets.push(s);
        setImmediate(() => s.emit('connect'));
        return s;
      };

      const leaf = new BotLinkLeaf(leafConfig({ reconnect_delay_ms: 50 }), '1.0.0', null, factory);
      leaf.connect();
      await vi.advanceTimersByTimeAsync(1);
      pushFrame(sockets[0], { type: 'WELCOME', botname: 'hub', version: '1.0' });
      await vi.advanceTimersByTimeAsync(0);

      sockets[0].destroy();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(51);
      expect(sockets).toHaveLength(2);
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
    const socket = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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
    const socket = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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

    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket.written.length = 0;

    // CMD with missing fields — uses ?? defaults
    pushFrame(socket, { type: 'CMD' });
    await tick();
    await tick();

    const frames = parseWritten(socket.written);
    const result = frames.find((f) => f.type === 'CMD_RESULT');
    expect(result).toBeDefined();
    hub.close();
  });

  it('PARTY_JOIN with missing nick/fromBot fields uses defaults', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    pushFrame(socket, { type: 'PARTY_JOIN', handle: 'user1' });
    await tick();

    const users = hub.getRemotePartyUsers();
    expect(users).toHaveLength(1);
    expect(users[0].nick).toBe('user1'); // falls back to handle
    expect(users[0].botname).toBe('leaf1'); // falls back to sending botname
    hub.close();
  });

  it('RELAY_REQUEST with missing toBot rejects with error', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();
    socket.written.length = 0;

    pushFrame(socket, { type: 'RELAY_REQUEST', handle: 'admin' });
    await tick();

    const frames = parseWritten(socket.written);
    expect(frames.some((f) => f.type === 'RELAY_END')).toBe(true);
    hub.close();
  });

  it('leaf config defaults used when optional fields are missing', () => {
    const minConfig: BotlinkConfig = {
      enabled: true,
      role: 'leaf',
      botname: 'test',
      password: 'p',
      hub: { host: '127.0.0.1', port: 5051 },
    };
    // Should not throw — uses defaults for missing optional fields
    const leaf = new BotLinkLeaf(minConfig, '1.0.0');
    expect(leaf.isConnected).toBe(false);
  });

  it('leaf WELCOME with missing botname uses empty string', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const socket = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(socket, { type: 'WELCOME' });
    await tick();

    expect(leaf.isConnected).toBe(true);
    expect(leaf.hubName).toBe('');
    leaf.disconnect();
  });

  it('leaf CMD_RESULT with non-array output resolves empty', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const socket = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
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

    const sent = parseWritten(socket.written);
    const cmd = sent.find((f) => f.type === 'CMD');
    pushFrame(socket, { type: 'CMD_RESULT', ref: cmd!.ref, output: 'not-an-array' });
    await tick();
    await promise;

    expect(replies).toEqual([]);
    leaf.disconnect();
  });

  it('leaf PARTY_WHOM_REPLY with non-array users resolves empty', async () => {
    const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
    const socket = createMockSocket();
    leaf.connectWithSocket(socket);
    pushFrame(socket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
    await tick();

    const promise = leaf.requestWhom();
    await tick();

    const sent = parseWritten(socket.written);
    const whom = sent.find((f) => f.type === 'PARTY_WHOM');
    pushFrame(socket, { type: 'PARTY_WHOM_REPLY', ref: whom!.ref, users: 'bad' });
    await tick();

    expect(await promise).toEqual([]);
    leaf.disconnect();
  });

  it('hub handleConnection: second frame during handshake is ignored', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const socket = createMockSocket();
    hub.addConnection(socket);

    // Send valid HELLO then immediately another frame
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    // Should only connect once
    expect(hub.getLeaves()).toEqual(['leaf1']);
    hub.close();
  });

  it('hub onSteadyState returns early when conn is null (race)', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, { type: 'HELLO', botname: 'leaf1', password: TEST_HASH, version: '1' });
    await tick();

    // Disconnect the leaf, then try to send a frame (race condition)
    socket.destroy();
    await tick();

    // Send a frame on the destroyed socket — should not crash
    pushFrame(socket, { type: 'JOIN', channel: '#test', nick: 'u' });
    await tick();

    hub.close();
  });
});
