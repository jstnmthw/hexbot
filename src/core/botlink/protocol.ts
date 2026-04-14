// HexBot — Bot Link Protocol Layer
// Frame serialization, socket wrapper, and authentication helpers.
// Shared by both BotLinkHub and BotLinkLeaf.
//
// Type declarations live in `./types.ts`. Rate limiting lives in
// `./rate-counter.ts`. Command-execution glue lives in `./cmd-exec.ts`.
import { scryptSync } from 'node:crypto';
import type { Socket } from 'node:net';
import { createInterface as createReadline } from 'node:readline';

import type { LoggerLike } from '../../logger';
import { sanitize } from '../../utils/sanitize';
import type { LinkFrame } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum frame size in bytes. Frames exceeding this are protocol errors. */
export const MAX_FRAME_SIZE = 64 * 1024;

/** Frames handled exclusively by the hub — never fanned out to other leaves.
 *  SECURITY: Permission-mutation frames (ADDUSER, SETFLAGS, DELUSER) MUST be
 *  hub-only. The hub is the single source of truth for permissions and broadcasts
 *  these via setCommandRelay event subscriptions. If a leaf could fan out these
 *  frames, a compromised leaf could inject owner-level permissions across the
 *  entire botnet. */
export const HUB_ONLY_FRAMES = new Set([
  'CMD',
  'CMD_RESULT',
  'BSAY',
  'PARTY_WHOM',
  'PROTECT_ACK',
  'RELAY_REQUEST',
  'RELAY_ACCEPT',
  'RELAY_INPUT',
  'RELAY_OUTPUT',
  'RELAY_END',
  'ADDUSER',
  'SETFLAGS',
  'DELUSER',
]);

/**
 * Every frame `type` the bot link protocol speaks. Inbound frames whose
 * type is not in this set are dropped at decode time without dispatching
 * — closes the "send a 60 KB junk type to walk hot paths" oracle and
 * keeps `frame.type.startsWith('PROTECT_')` checks from running against
 * arbitrarily long attacker-supplied strings.
 */
export const KNOWN_FRAME_TYPES = new Set([
  // Handshake + heartbeat
  'HELLO',
  'WELCOME',
  'AUTH_OK',
  'AUTH_FAILED',
  'ERROR',
  'PING',
  'PONG',
  // Permission sync
  'ADDUSER',
  'SETFLAGS',
  'DELUSER',
  'SYNC_START',
  'SYNC_END',
  // Channel state sync
  'BOTJOIN',
  'BOTPART',
  'CHAN',
  // Ban / exempt list sync
  'CHAN_BAN_ADD',
  'CHAN_BAN_DEL',
  'CHAN_BAN_SYNC',
  'CHAN_EXEMPT_SYNC',
  // Command / message relay
  'CMD',
  'CMD_RESULT',
  'BSAY',
  'ANNOUNCE',
  // Party line
  'PARTY_JOIN',
  'PARTY_PART',
  'PARTY_CHAT',
  'PARTY_WHOM',
  'PARTY_WHOM_REPLY',
  // Protection requests
  'PROTECT_OP',
  'PROTECT_DEOP',
  'PROTECT_KICK',
  'PROTECT_UNBAN',
  'PROTECT_INVITE',
  'PROTECT_TAKEOVER',
  'PROTECT_REGAIN',
  'PROTECT_ACK',
  // Console relay
  'RELAY_REQUEST',
  'RELAY_ACCEPT',
  'RELAY_INPUT',
  'RELAY_OUTPUT',
  'RELAY_END',
]);

/** True if `type` is a known protocol frame name. */
export function isKnownFrameType(type: unknown): type is string {
  return typeof type === 'string' && type.length <= 64 && KNOWN_FRAME_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash a password for link authentication. Never send plaintext over the wire.
 *  Uses scrypt (memory-hard KDF) to resist brute-force attacks on intercepted hashes. */
export function hashPassword(password: string): string {
  const key = scryptSync(password, 'hexbot-botlink-v1', 32);
  return 'scrypt:' + key.toString('hex');
}

/**
 * Maximum recursion depth for {@link sanitizeFrame}. Caps the cost of
 * walking deeply nested JSON so a hostile leaf cannot trigger a stack
 * overflow by sending a 64 KB frame whose payload is a 16 000-deep
 * `{a:{a:{a:...}}}` chain. 16 levels is well above any legitimate
 * frame shape — relay frames are 2-3 deep, party-line frames 1.
 */
const SANITIZE_FRAME_MAX_DEPTH = 16;

/** Recursively sanitize all string values in a frame (strip \r\n\0). */
export function sanitizeFrame(obj: Record<string, unknown>, depth = 0): void {
  if (depth > SANITIZE_FRAME_MAX_DEPTH) return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = sanitize(val);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          (val as unknown[])[i] = sanitize(val[i] as string);
        } else if (val[i] !== null && typeof val[i] === 'object') {
          sanitizeFrame(val[i] as Record<string, unknown>, depth + 1);
        }
      }
    } else if (val !== null && typeof val === 'object') {
      sanitizeFrame(val as Record<string, unknown>, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// BotLinkProtocol — socket wrapper with JSON frame serialization
// ---------------------------------------------------------------------------

export class BotLinkProtocol {
  private socket: Socket;
  private rl: import('readline').Interface | null = null;
  private logger: LoggerLike | null;
  private closed = false;

  /** Fired when a valid frame is received. */
  onFrame: ((frame: LinkFrame) => void) | null = null;
  /** Fired when the connection closes (explicit or remote). */
  onClose: (() => void) | null = null;
  /** Fired on socket error. */
  onError: ((err: Error) => void) | null = null;

  constructor(socket: Socket, logger?: LoggerLike | null) {
    this.socket = socket;
    this.logger = logger ?? null;

    this.rl = createReadline({ input: socket, crlfDelay: Infinity });
    const rl = this.rl;

    rl.on('line', (line: string) => {
      /* v8 ignore next -- race guard: socket may deliver buffered lines after close */
      if (this.closed) return;

      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_SIZE) {
        this.logger?.error('Frame exceeds 64KB limit, dropping connection');
        this.send({ type: 'ERROR', code: 'FRAME_TOO_LARGE', message: 'Frame exceeds 64KB limit' });
        this.close();
        return;
      }

      try {
        const frame = JSON.parse(line) as LinkFrame;
        if (!frame.type || typeof frame.type !== 'string') {
          this.logger?.warn('Frame missing type field');
          return;
        }
        // Drop unknown frame types early — closes the
        // `frame.type.startsWith('PROTECT_')` cycle-burning oracle and
        // means downstream switch statements never branch on
        // attacker-supplied strings. ERROR is the only frame type we
        // accept implicitly because it's emitted by older peers and
        // carries no behaviour.
        if (frame.type !== 'ERROR' && !isKnownFrameType(frame.type)) {
          this.logger?.warn(`Unknown frame type "${frame.type}" — dropping`);
          return;
        }
        sanitizeFrame(frame);
        this.onFrame?.(frame);
      } catch {
        this.logger?.warn('Malformed JSON frame');
      }
    });

    socket.on('close', () => {
      this.closed = true;
      this.onClose?.();
    });

    /* v8 ignore next 3 -- socket error event only fires on real TCP errors; Duplex mocks don't trigger it */
    socket.on('error', (err) => {
      this.onError?.(err);
    });
  }

  /** Send a frame. Returns false if the connection is closed or the frame is too large. */
  send(frame: LinkFrame): boolean {
    if (this.closed || this.socket.destroyed) return false;

    // Symmetry with the inbound path: scrub control chars from every
    // string field on the way out too. Without this an audit log line
    // or plugin-emitted message that landed in our local state with
    // formatting still in it could ride out across the link and
    // poison a peer's audit log on the other side.
    // `LinkFrame` declares `[key: string]: unknown`, so it is directly
    // assignable to `Record<string, unknown>` — no cast required.
    sanitizeFrame(frame);

    const json = JSON.stringify(frame);
    if (Buffer.byteLength(json, 'utf8') > MAX_FRAME_SIZE) {
      this.logger?.error('Outbound frame too large, not sent');
      return false;
    }

    this.socket.write(json + '\r\n');
    return true;
  }

  /** Close the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    this.socket.destroy(); // destroy() is idempotent
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }
}
