// HexBot — Bot Link Protocol Layer
// Frame serialization, socket wrapper, and HMAC handshake helpers.
// Shared by both BotLinkHub and BotLinkLeaf.
//
// Type declarations live in `./types.ts`. Rate limiting lives in
// `./rate-counter.ts`. Command-execution glue lives in `./cmd-exec.ts`.
// HELLO challenge-response helpers: deriveLinkKey, computeHelloHmac,
// verifyHelloHmac — fresh per-connection nonce defeats HELLO replay,
// link_salt makes the derived key per-deployment so a wordlist cannot
// reuse hashes across botnets.
import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
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

/**
 * Per-frame cap during the pre-handshake window. A hostile peer cannot
 * otherwise drive `JSON.parse` + `sanitizeFrame` on 64 KB junk for the
 * full handshake-timeout duration — at line rate this is unbounded CPU
 * before any authentication has occurred. 4 KB is far above any
 * legitimate HELLO_CHALLENGE / HELLO frame (~ a few hundred bytes).
 */
export const MAX_PRE_HANDSHAKE_FRAME_SIZE = 4096;

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
  'HELLO_CHALLENGE',
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
// Handshake helpers — HMAC challenge-response
// ---------------------------------------------------------------------------
//
// The hub sends HELLO_CHALLENGE { nonce } on every accepted connection. The
// leaf HMAC-signs the nonce with a key derived from (password, link_salt)
// and replies with HELLO { hmac }. The hub re-derives the same key from its
// own config and verifies. A captured HELLO is useless on a fresh
// connection because the nonce differs.
//
// `link_salt` is a per-botnet hex string; it is not secret by itself, but
// combined with the password it produces a per-deployment key that a
// canned wordlist cannot reuse across botnets.

/**
 * Derive the per-botnet HMAC key from the shared password + per-botnet salt.
 * The same function runs on both hub and leaf — both must see identical
 * `password` and `linkSaltHex` to produce a matching key.
 *
 * @param password plaintext shared secret (from config)
 * @param linkSaltHex hex string ≥ 32 characters (≥ 16 bytes decoded)
 * @returns 32-byte HMAC key
 */
export function deriveLinkKey(password: string, linkSaltHex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(linkSaltHex) || linkSaltHex.length < 32) {
    throw new Error('link_salt must be a hex string of at least 32 characters (16 bytes)');
  }
  const saltBytes = Buffer.from(linkSaltHex, 'hex');
  return scryptSync(password, saltBytes, 32);
}

/** Compute HMAC-SHA256(key, nonce) and return the hex digest. */
export function computeHelloHmac(key: Buffer, nonce: Buffer): string {
  return createHmac('sha256', key).update(nonce).digest('hex');
}

/**
 * Verify a received HELLO HMAC against the expected value for this nonce.
 * Length-checked first — `timingSafeEqual` throws on mismatched buffer
 * lengths and this input is attacker-controlled wire data.
 */
export function verifyHelloHmac(key: Buffer, nonce: Buffer, sentHex: string): boolean {
  const expectedHex = computeHelloHmac(key, nonce);
  const sentBuf = Buffer.from(sentHex, 'utf8');
  const expectedBuf = Buffer.from(expectedHex, 'utf8');
  if (sentBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sentBuf, expectedBuf);
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

/**
 * Soft cap on frames in flight per protocol instance. Inbound frames past
 * this depth are dropped with a warn log until the in-flight count drains.
 * Protects against a peer (or a slow consumer) that produces frames faster
 * than they can be handled — without this the readline `'line'` queue
 * grows unbounded inside Node's internal buffers and the closed-side cleanup
 * path takes longer to converge.
 */
const MAX_PENDING_FRAMES = 1000;

export class BotLinkProtocol {
  private socket: Socket;
  private rl: import('readline').Interface | null = null;
  private logger: LoggerLike | null;
  private closed = false;
  /**
   * True from construction until the handshake accepts. While set, an
   * inbound line — or a newline-free stream (see {@link attachFrameLengthGuard})
   * — larger than {@link MAX_PRE_HANDSHAKE_FRAME_SIZE} destroys the socket
   * and fires {@link onPreHandshakeOversize}, holding an unauthenticated
   * peer to the tight 4 KB budget a legitimate HELLO never exceeds. Lifted
   * via {@link clearPreHandshake} once the peer authenticates, after which
   * the standard 64 KB {@link MAX_FRAME_SIZE} cap takes over.
   */
  private preHandshake = true;
  /**
   * In-flight inbound frames — incremented on enqueue (before onFrame
   * runs), decremented on dispatch completion. Goes to zero between
   * synchronous consumers; an async (Promise-returning) `onFrame` keeps
   * the counter raised until the Promise settles, providing real
   * back-pressure once any consumer takes work off-thread.
   */
  private pendingFrames = 0;
  /**
   * Once-per-overflow latch. We warn when the cap is first exceeded and
   * stay silent for the rest of the overflow burst — under sustained
   * overload an unlatched warn would itself flood the logs. Cleared when
   * the in-flight count drains back below the cap.
   */
  private overflowLogged = false;
  /**
   * Running byte count of the current inbound line — bytes seen on the
   * socket since the last LF. Tracked by {@link attachFrameLengthGuard} so
   * the "never send a newline" flood is caught before node:readline buffers
   * it without bound. Reset to the trailing partial-line length on every
   * chunk that carries a newline.
   */
  private pendingLineBytes = 0;
  /**
   * Named reference to the 'data' listener installed by
   * {@link attachFrameLengthGuard}. Stored so the teardown paths can
   * `socket.off()` it — without this the closure (which captures `this`)
   * lives until the socket itself is destroyed and GC'd. Mirrors the DCC
   * session's line-length guard hygiene.
   */
  private dataGuard: ((chunk: Buffer) => void) | null = null;

  /** Fired when a valid frame is received. */
  // Return type is `unknown` so synchronous handlers that incidentally
  // return a value (e.g. `push()`'s number) still type-check; the only
  // shape the queue logic actually inspects is `Promise`-shape via a
  // duck-typed `.then` check.
  onFrame: ((frame: LinkFrame) => unknown) | null = null;
  /** Fired when the connection closes (explicit or remote). */
  onClose: (() => void) | null = null;
  /** Fired on socket error. */
  onError: ((err: Error) => void) | null = null;
  /**
   * Fired once, just before the socket is destroyed, when an inbound frame
   * — or a newline-free stream (see {@link attachFrameLengthGuard}) —
   * exceeds the pre-handshake cap. The hub feeds this into its per-IP
   * auth-failure tracker so a peer that floods the unauthenticated window
   * escalates toward an auto-ban like any other brute-force source; the
   * connection has no botname yet, so escalation keys on the IP. `bytes`
   * is the offending line/stream length.
   */
  onPreHandshakeOversize: ((bytes: number) => void) | null = null;

  constructor(socket: Socket, logger?: LoggerLike | null) {
    this.socket = socket;
    this.logger = logger ?? null;

    this.rl = createReadline({ input: socket, crlfDelay: Infinity });
    const rl = this.rl;

    rl.on('line', (line: string) => {
      /* v8 ignore next -- race guard: socket may deliver buffered lines after close */
      if (this.closed) return;

      const lineBytes = Buffer.byteLength(line, 'utf8');

      // Pre-handshake cap (4 KB). Any frame this size before authentication
      // is either malformed or hostile — destroy immediately so we don't
      // burn CPU on JSON.parse + sanitizeFrame for an attacker streaming
      // junk during the handshake-timeout window.
      if (this.preHandshake && lineBytes > MAX_PRE_HANDSHAKE_FRAME_SIZE) {
        this.logger?.warn(
          `Pre-handshake frame exceeds ${MAX_PRE_HANDSHAKE_FRAME_SIZE}B — destroying socket`,
        );
        this.onPreHandshakeOversize?.(lineBytes);
        this.close();
        return;
      }

      // Per-line cap before JSON.parse — keeps a hostile peer from forcing
      // us to allocate (and walk) a multi-MB string just to reject it as
      // oversized. Matches the outbound cap below so both sides agree on
      // the wire-level frame ceiling.
      if (lineBytes > MAX_FRAME_SIZE) {
        this.logger?.error('Frame exceeds 64KB limit, dropping connection');
        this.send({ type: 'ERROR', code: 'FRAME_TOO_LARGE', message: 'Frame exceeds 64KB limit' });
        this.close();
        return;
      }

      // Pending-frame queue cap. With a synchronous `onFrame` consumer
      // the counter only ever sits at 1; with an async consumer it
      // climbs while Promises are in flight. Either way, dropping past
      // 1000 in-flight frames keeps a slow consumer or a hostile peer
      // from growing the readline-internal queue past a sane bound.
      if (this.pendingFrames >= MAX_PENDING_FRAMES) {
        if (!this.overflowLogged) {
          this.overflowLogged = true;
          this.logger?.warn(
            `Pending-frame queue exceeded ${MAX_PENDING_FRAMES} — dropping inbound frames until drained`,
          );
        }
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
        // carries no behavior.
        if (frame.type !== 'ERROR' && !isKnownFrameType(frame.type)) {
          this.logger?.warn(`Unknown frame type "${frame.type}" — dropping`);
          return;
        }
        sanitizeFrame(frame);
        const handler = this.onFrame;
        if (!handler) return;
        this.pendingFrames++;
        const decrement = (): void => {
          this.pendingFrames = Math.max(0, this.pendingFrames - 1);
          if (this.pendingFrames < MAX_PENDING_FRAMES) this.overflowLogged = false;
        };
        let result: unknown;
        try {
          result = handler(frame);
        } catch (err) {
          // Synchronous throw: decrement immediately and re-throw so the
          // caller's catch (above) can log it as malformed.
          decrement();
          throw err;
        }
        // Duck-typed Promise check: if `onFrame` is async, await the
        // settle to keep `pendingFrames` raised for the in-flight work.
        const maybePromise = result as { then?: unknown; finally?: (cb: () => void) => unknown };
        if (
          maybePromise &&
          typeof maybePromise === 'object' &&
          typeof maybePromise.then === 'function' &&
          typeof maybePromise.finally === 'function'
        ) {
          maybePromise.finally(decrement);
        } else {
          decrement();
        }
      } catch {
        this.logger?.warn('Malformed JSON frame');
      }
    });

    // Byte-count guard for the newline-withholding OOM: the size caps in
    // the 'line' handler above only fire once readline sees an LF, so a
    // peer that streams bytes and never sends one grows readline's internal
    // buffer without bound. This catches it at the socket level.
    this.attachFrameLengthGuard();

    socket.on('close', () => {
      this.closed = true;
      if (this.dataGuard !== null) {
        this.socket.off('data', this.dataGuard);
        this.dataGuard = null;
      }
      this.onClose?.();
      // Drop callback refs now that the final close notification has
      // fired — see comment in close(). Nulling here (rather than in
      // close()) keeps the close-event path working for explicit
      // teardown callers that rely on onClose firing exactly once.
      this.onFrame = null;
      this.onClose = null;
      this.onError = null;
    });

    /* v8 ignore next 3 -- socket error event only fires on real TCP errors; Duplex mocks don't trigger it */
    socket.on('error', (err) => {
      this.onError?.(err);
    });
  }

  /**
   * Install the inbound byte-count guard. node:readline (created in the
   * constructor with `crlfDelay: Infinity`) accumulates an incomplete line
   * in its internal buffer with no limit, so {@link MAX_PRE_HANDSHAKE_FRAME_SIZE}
   * and {@link MAX_FRAME_SIZE} — both enforced only inside the 'line'
   * handler, which fires only after a newline — never see a peer that
   * streams bytes while withholding the LF. This 'data' listener counts
   * bytes since the last newline and destroys the socket the instant a
   * single un-terminated line crosses the active cap (the 4 KB
   * pre-handshake cap while {@link preHandshake}, else the 64 KB steady
   * cap). Mirrors the DCC session's line-length guard.
   */
  private attachFrameLengthGuard(): void {
    this.dataGuard = (chunk: Buffer) => {
      /* v8 ignore next -- race guard: buffered chunks can arrive after close */
      if (this.closed) return;

      // 0x0a = LF. Extend the running count on a newline-free chunk; on a
      // chunk that contains one, reset to the bytes after the LAST LF —
      // the partial trailing line readline will keep buffering.
      const newlineIdx = chunk.lastIndexOf(0x0a);
      if (newlineIdx === -1) {
        this.pendingLineBytes += chunk.length;
      } else {
        this.pendingLineBytes = chunk.length - newlineIdx - 1;
      }

      const cap = this.preHandshake ? MAX_PRE_HANDSHAKE_FRAME_SIZE : MAX_FRAME_SIZE;
      if (this.pendingLineBytes <= cap) return;

      if (this.preHandshake) {
        this.logger?.warn(
          `Pre-handshake stream exceeded ${cap}B without a newline — destroying socket`,
        );
        this.onPreHandshakeOversize?.(this.pendingLineBytes);
      } else {
        this.logger?.error(
          `Inbound stream exceeded ${cap}B without a newline — dropping connection`,
        );
      }
      this.close();
    };
    this.socket.on('data', this.dataGuard);
  }

  /**
   * Lift the pre-handshake frame cap once the peer has authenticated, so
   * steady-state frames (channel-state syncs run up to the full
   * {@link MAX_FRAME_SIZE}) are no longer held to the tight 4 KB
   * unauthenticated budget. Idempotent. The hub calls this when it admits a
   * leaf; the leaf calls it when it receives WELCOME.
   */
  clearPreHandshake(): void {
    this.preHandshake = false;
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
    // Release the 'data' guard closure now so it's GC-eligible on close
    // rather than waiting for socket destruction — mirrors DCC hygiene.
    if (this.dataGuard !== null) {
      this.socket.off('data', this.dataGuard);
      this.dataGuard = null;
    }
    this.rl?.close();
    this.socket.destroy(); // destroy() is idempotent
    // Callback refs are released by the socket 'close' listener, not
    // here — that path fires onClose one last time before nulling, so
    // explicit-close callers (hub/leaf teardown) still get their
    // notification. Nulling synchronously here would suppress it.
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }
}
