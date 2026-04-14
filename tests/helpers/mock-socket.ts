// Shared mock socket for botlink/DCC protocol tests.
// Centralizes the Duplex-as-Socket test double so individual test files
// don't each need their own double-cast helpers.
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import type { LinkFrame } from '../../src/core/botlink';

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
