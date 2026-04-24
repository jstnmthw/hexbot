// Shared mock socket for botlink/DCC protocol tests.
// Centralizes the Duplex-as-Socket test double so individual test files
// don't each need their own double-cast helpers.
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import { type LinkFrame, computeHelloHmac, deriveLinkKey } from '../../src/core/botlink';

export interface MockSocketResult {
  /** Typed as Socket for passing to production code that expects net.Socket. */
  socket: Socket;
  /** Array capturing all data written to the socket. */
  written: string[];
  /** The underlying Duplex — use for .push() / .destroy() in tests. */
  duplex: Duplex;
}

/**
 * Create a mock socket that captures writes and allows pushing data.
 *
 * Returns three handles so callers never need to cast:
 * - `socket` (Socket) — pass to production code
 * - `written` (string[]) — inspect captured output
 * - `duplex` (Duplex) — push incoming data or destroy
 *
 * The single `as unknown as Socket` cast lives here instead of in every test file.
 * It is safe because our protocol code only uses stream-level methods that Duplex provides.
 */
export function createMockSocket(): MockSocketResult {
  const written: string[] = [];
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      cb();
    },
  });
  // Stub Socket-only methods that Duplex lacks — production code calls
  // setKeepAlive() on accepted DCC sockets; the mock just needs a no-op.
  (duplex as unknown as { setKeepAlive: (enable?: boolean, delay?: number) => void }).setKeepAlive =
    () => {};
  // Test double: Duplex implements the stream methods our protocol code uses on Socket
  return { socket: duplex as unknown as Socket, written, duplex };
}

/** Push a JSON link frame into a mock socket (simulating incoming data). */
export function pushFrame(duplex: Duplex, frame: LinkFrame): void {
  duplex.push(JSON.stringify(frame) + '\r\n');
}

/** Parse all JSON frames from the written buffer. */
export function parseWritten(written: string[]): LinkFrame[] {
  const frames: LinkFrame[] = [];
  for (const chunk of written) {
    for (const line of chunk.split('\r\n')) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  return frames;
}

/**
 * All botlink tests use the same per-botnet salt (64 zeros = 32 bytes). Not
 * secret — a deterministic value keeps the HMAC in fixtures reproducible and
 * matches what the example configs ship.
 */
export const TEST_LINK_SALT = '0000000000000000000000000000000000000000000000000000000000000000';

/** Derive the HMAC key for a test password. Mirrors the production path. */
export function testLinkKey(password: string, salt = TEST_LINK_SALT): Buffer {
  return deriveLinkKey(password, salt);
}

/**
 * Read the HELLO_CHALLENGE frame the hub wrote after `addConnection`. The
 * hub emits CHALLENGE synchronously during `handleConnection`, so callers
 * do not need to `await tick()` before reading the buffer.
 */
export function getChallengeNonce(written: string[]): string {
  for (const frame of parseWritten(written)) {
    if (frame.type === 'HELLO_CHALLENGE') return String(frame.nonce);
  }
  throw new Error('No HELLO_CHALLENGE found in written frames');
}

/**
 * Find the first frame of a given type in the written buffer. Tests used to
 * pin `frames[0]` to the first post-handshake reply, but the hub now writes
 * HELLO_CHALLENGE before WELCOME / ERROR, so assertions need a lookup
 * that skips the challenge frame.
 */
export function findFrame(written: string[], type: string): LinkFrame | undefined {
  return parseWritten(written).find((f) => f.type === type);
}

/**
 * Compute the HELLO reply for the hub's latest CHALLENGE and push it onto
 * the duplex so the hub's onFrame handler processes it on the next tick.
 * Returns the sent frame for assertion convenience.
 */
export function answerHelloChallenge(
  written: string[],
  duplex: Duplex,
  linkKey: Buffer,
  botname: string,
  extra: Partial<LinkFrame> = {},
): LinkFrame {
  const nonceHex = getChallengeNonce(written);
  const hmac = computeHelloHmac(linkKey, Buffer.from(nonceHex, 'hex'));
  const frame: LinkFrame = { type: 'HELLO', botname, hmac, version: '1.0', ...extra };
  pushFrame(duplex, frame);
  return frame;
}
