// HexBot — Bot Link Protocol Layer
// Hub-and-leaf bot linking: frame serialization, connection management,
// handshake, rate limiting, heartbeat. See docs/plans/bot-linking.md.
import { scryptSync } from 'node:crypto';
import { connect, createServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { createInterface as createReadline } from 'node:readline';

import type { CommandContext, CommandEntry, PreExecuteHook } from '../command-handler';
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotlinkConfig, UserRecord } from '../types';
import { sanitize } from '../utils/sanitize';
import { PermissionSyncer } from './botlink-sync';
import type { Permissions } from './permissions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum frame size in bytes. Frames exceeding this are protocol errors. */
export const MAX_FRAME_SIZE = 64 * 1024;

/** Handshake timeout: close if HELLO not received within this window. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Frames handled exclusively by the hub — never fanned out to other leaves.
 *  SECURITY: Permission-mutation frames (ADDUSER, SETFLAGS, DELUSER) MUST be
 *  hub-only. The hub is the single source of truth for permissions and broadcasts
 *  these via setCommandRelay event subscriptions. If a leaf could fan out these
 *  frames, a compromised leaf could inject owner-level permissions across the
 *  entire botnet. */
const HUB_ONLY_FRAMES = new Set([
  'CMD',
  'CMD_RESULT',
  'BSAY',
  'PARTY_WHOM',
  'PROTECT_ACK',
  'RELAY_REQUEST',
  'RELAY_INPUT',
  'RELAY_END',
  'ADDUSER',
  'SETFLAGS',
  'DELUSER',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash a password for link authentication. Never send plaintext over the wire.
 *  Uses scrypt (memory-hard KDF) to resist brute-force attacks on intercepted hashes. */
export function hashPassword(password: string): string {
  const key = scryptSync(password, 'hexbot-botlink-v1', 32);
  return 'scrypt:' + key.toString('hex');
}

/** Recursively sanitize all string values in a frame (strip \r\n\0). */
export function sanitizeFrame(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = sanitize(val);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          (val as unknown[])[i] = sanitize(val[i] as string);
        } else if (val[i] !== null && typeof val[i] === 'object') {
          sanitizeFrame(val[i] as Record<string, unknown>);
        }
      }
    } else if (val !== null && typeof val === 'object') {
      sanitizeFrame(val as Record<string, unknown>);
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A link protocol frame — JSON object with a `type` discriminator. */
export interface LinkFrame {
  type: string;
  [key: string]: unknown;
}

/** A user on the cross-bot party line (used in PARTY_WHOM_REPLY). */
export interface PartyLineUser {
  handle: string;
  nick: string;
  botname: string;
  connectedAt: number;
  idle: number;
}

/** Minimal permissions interface needed by BotLink for command relay flag checks. */
export interface LinkPermissions {
  getUser(handle: string): UserRecord | null;
  findByHostmask(fullHostmask: string): UserRecord | null;
  checkFlagsByHandle(requiredFlags: string, handle: string, channel: string | null): boolean;
}

/** Minimal command handler interface needed by BotLink for command relay. */
export interface CommandRelay {
  execute(commandString: string, ctx: CommandContext): Promise<void>;
  getCommand(name: string): CommandEntry | undefined;
  setPreExecuteHook(hook: PreExecuteHook | null): void;
}

/** Factory for creating TCP connections (override in tests). */
export type SocketFactory = (port: number, host: string) => Socket;

// ---------------------------------------------------------------------------
// RateCounter — sliding window rate limiter
// ---------------------------------------------------------------------------

export class RateCounter {
  private timestamps: number[] = [];
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if the action is allowed (under the rate limit). */
  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

// ---------------------------------------------------------------------------
// BotLinkProtocol — socket wrapper with JSON frame serialization
// ---------------------------------------------------------------------------

export class BotLinkProtocol {
  private socket: Socket;
  private logger: Logger | null;
  private closed = false;

  /** Fired when a valid frame is received. */
  onFrame: ((frame: LinkFrame) => void) | null = null;
  /** Fired when the connection closes (explicit or remote). */
  onClose: (() => void) | null = null;
  /** Fired on socket error. */
  onError: ((err: Error) => void) | null = null;

  constructor(socket: Socket, logger?: Logger | null) {
    this.socket = socket;
    this.logger = logger ?? null;

    const rl = createReadline({ input: socket, crlfDelay: Infinity });

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
    this.socket.destroy(); // destroy() is idempotent
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ---------------------------------------------------------------------------
// BotLinkHub — hub server
// ---------------------------------------------------------------------------

interface LeafConnection {
  botname: string;
  protocol: BotLinkProtocol;
  connectedAt: number;
  cmdRate: RateCounter;
  partyRate: RateCounter;
  protectRate: RateCounter;
  lastMessageAt: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  pingSeq: number;
}

export class BotLinkHub {
  private server: NetServer | null = null;
  private leaves: Map<string, LeafConnection> = new Map();
  /** Remote party line users tracked from PARTY_JOIN/PARTY_PART frames. Key: `handle@botname`. */
  private remotePartyUsers: Map<string, PartyLineUser> = new Map();
  /** Active relay sessions. Key: handle. Value: { originBot, targetBot }. */
  private activeRelays: Map<string, { originBot: string; targetBot: string }> = new Map();
  /** Pending protect requests. Key: ref. Value: requesting botname. */
  private protectRequests: Map<string, string> = new Map();
  /** CMD routing table — tracks toBot-routed commands for CMD_RESULT forwarding. Key: ref. Value: originating leaf botname. */
  private cmdRoutes: Map<string, string> = new Map();
  /** Pending commands sent by the hub itself (from .bot). Key: ref. */
  private pendingCmds: Map<string, { resolve: (output: string[]) => void }> = new Map();
  private cmdRefCounter = 0;
  private config: BotlinkConfig;
  private version: string;
  private logger: Logger | null;
  private expectedHash: string;
  private pingIntervalMs: number;
  private linkTimeoutMs: number;

  /** Fired when a leaf completes handshake. */
  onLeafConnected: ((botname: string) => void) | null = null;
  /** Fired when a leaf disconnects. */
  onLeafDisconnected: ((botname: string, reason: string) => void) | null = null;
  /** Fired for every non-heartbeat frame from a leaf in steady state. */
  onLeafFrame: ((botname: string, frame: LinkFrame) => void) | null = null;
  /** Called during handshake to populate sync frames (between SYNC_START and SYNC_END). */
  onSyncRequest: ((botname: string, send: (frame: LinkFrame) => void) => void) | null = null;
  /** Called when a BSAY frame targets this hub — the bot should send the IRC message. */
  onBsay: ((target: string, message: string) => void) | null = null;

  constructor(config: BotlinkConfig, version: string, logger?: Logger | null) {
    this.config = config;
    this.version = version;
    this.logger = logger?.child('botlink:hub') ?? null;
    this.expectedHash = hashPassword(config.password);
    this.pingIntervalMs = config.ping_interval_ms;
    this.linkTimeoutMs = config.link_timeout_ms;
  }

  /** Start listening for leaf connections. Uses config values when port/host not specified. */
  listen(port = this.config.listen!.port, host = this.config.listen!.host): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        this.logger?.info(`Listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  /** Inject a socket connection directly (for testing without TCP). */
  addConnection(socket: Socket): void {
    this.handleConnection(socket);
  }

  /** Send a frame to a specific leaf by botname. */
  send(botname: string, frame: LinkFrame): boolean {
    const leaf = this.leaves.get(botname);
    if (!leaf) return false;
    return leaf.protocol.send(frame);
  }

  /** Broadcast a frame to all leaves, optionally excluding one. */
  broadcast(frame: LinkFrame, excludeBot?: string): void {
    for (const [name, leaf] of this.leaves) {
      if (name !== excludeBot) {
        leaf.protocol.send(frame);
      }
    }
  }

  /** Get connected leaf botnames. */
  getLeaves(): string[] {
    return Array.from(this.leaves.keys());
  }

  /** Get info about a specific leaf. */
  getLeafInfo(botname: string): { botname: string; connectedAt: number } | null {
    const leaf = this.leaves.get(botname);
    if (!leaf) return null;
    return { botname: leaf.botname, connectedAt: leaf.connectedAt };
  }

  // -----------------------------------------------------------------------
  // Command relay wiring (Phase 5)
  // -----------------------------------------------------------------------

  private cmdHandler: CommandRelay | null = null;
  private cmdPermissions: LinkPermissions | null = null;

  /** Wire command relay: hub executes CMD frames and broadcasts permission changes. */
  setCommandRelay(
    commandHandler: CommandRelay,
    permissions: Permissions,
    eventBus: BotEventBus,
  ): void {
    this.cmdHandler = commandHandler;
    this.cmdPermissions = permissions;

    // Subscribe to permission mutation events — broadcast to all leaves
    eventBus.on('user:added', (handle) => {
      const user = permissions.getUser(handle);
      if (user) {
        this.broadcast(
          PermissionSyncer.buildSyncFrames(permissions).find((f) => f.handle === handle)!,
        );
      }
    });
    eventBus.on('user:removed', (handle) => {
      this.broadcast({ type: 'DELUSER', handle });
    });
    eventBus.on('user:flagsChanged', (handle, globalFlags, channelFlags) => {
      const user = permissions.getUser(handle);
      if (user) {
        this.broadcast({
          type: 'SETFLAGS',
          handle,
          hostmasks: [...user.hostmasks],
          globalFlags,
          channelFlags: { ...channelFlags },
        });
      }
    });
    eventBus.on('user:hostmaskAdded', (handle) => {
      const user = permissions.getUser(handle);
      if (user) {
        this.broadcast({
          type: 'ADDUSER',
          handle,
          hostmasks: [...user.hostmasks],
          globalFlags: user.global,
          channelFlags: { ...user.channels },
        });
      }
    });
    eventBus.on('user:hostmaskRemoved', (handle) => {
      const user = permissions.getUser(handle);
      if (user) {
        this.broadcast({
          type: 'ADDUSER',
          handle,
          hostmasks: [...user.hostmasks],
          globalFlags: user.global,
          channelFlags: { ...user.channels },
        });
      }
    });
  }

  /** Handle an incoming CMD frame from a leaf. */
  private handleCmdRelay(fromBot: string, frame: LinkFrame): void {
    const handle = String(frame.fromHandle ?? '');
    const ref = String(frame.ref ?? '');
    const command = String(frame.command ?? '');
    const args = String(frame.args ?? '');
    const channel =
      frame.channel !== null && frame.channel !== undefined ? String(frame.channel) : null;

    // Route to a specific target bot if toBot is set and not this hub
    const toBot = frame.toBot != null ? String(frame.toBot) : null;
    if (toBot && toBot !== this.config.botname) {
      if (!this.leaves.has(toBot)) {
        this.send(fromBot, {
          type: 'CMD_RESULT',
          ref,
          output: [`Bot "${toBot}" is not connected.`],
        });
        return;
      }
      this.cmdRoutes.set(ref, fromBot);
      this.send(toBot, frame);
      return;
    }

    // Verify the handle has an active DCC session on the sending leaf.
    // This prevents a compromised leaf from forging commands as arbitrary handles.
    const sessionKey = `${handle}@${fromBot}`;
    if (!this.remotePartyUsers.has(sessionKey)) {
      this.send(fromBot, {
        type: 'CMD_RESULT',
        ref,
        output: [`No active session for "${handle}" on ${fromBot}.`],
      });
      return;
    }

    // Look up the command to get required flags
    const entry = this.cmdHandler!.getCommand(command);
    if (!entry) {
      this.send(fromBot, { type: 'CMD_RESULT', ref, output: [`Unknown command: .${command}`] });
      return;
    }

    // Verify user's flags on the hub's permission database
    if (!this.cmdPermissions!.checkFlagsByHandle(entry.options.flags, handle, channel)) {
      this.send(fromBot, { type: 'CMD_RESULT', ref, output: ['Permission denied.'] });
      return;
    }

    // Execute and capture output
    const output: string[] = [];
    const ctx: CommandContext = {
      source: 'botlink',
      nick: handle,
      ident: 'botlink',
      hostname: 'botlink',
      channel,
      reply: (msg: string) => {
        for (const line of msg.split('\n')) {
          output.push(line);
        }
      },
    };

    this.cmdHandler!.execute(`.${command} ${args}`.trim(), ctx)
      .then(() => {
        this.send(fromBot, { type: 'CMD_RESULT', ref, output });
      })
      /* v8 ignore start -- .catch only fires if command handler throws; tested commands always succeed */
      .catch((err) => {
        this.send(fromBot, {
          type: 'CMD_RESULT',
          ref,
          output: [`Error: ${err instanceof Error ? err.message : String(err)}`],
        });
      });
    /* v8 ignore stop */
  }

  /** Send a command to a specific leaf and await the result. Used by .bot command. */
  async sendCommandToBot(
    botname: string,
    command: string,
    args: string,
    fromHandle: string,
    channel: string | null,
  ): Promise<string[]> {
    if (!this.leaves.has(botname)) return [`Bot "${botname}" is not connected.`];
    const ref = `hubcmd:${++this.cmdRefCounter}`;
    this.send(botname, {
      type: 'CMD',
      command,
      args,
      fromHandle,
      fromBot: this.config.botname,
      channel,
      ref,
      toBot: botname,
    });

    const CMD_TIMEOUT_MS = 10_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(ref);
        resolve(['Command relay timed out.']);
      }, CMD_TIMEOUT_MS);
      this.pendingCmds.set(ref, {
        resolve: (output) => {
          clearTimeout(timer);
          resolve(output);
        },
      });
    });
  }

  /** Handle BSAY frame: route to target bot(s) and/or deliver locally. */
  private handleBsay(fromBot: string, frame: LinkFrame): void {
    const target = String(frame.target ?? '');
    const message = String(frame.message ?? '');
    const toBot = String(frame.toBot ?? '*');

    if (toBot === '*') {
      this.broadcast(frame, fromBot);
      this.onBsay?.(target, message);
    } else if (toBot === this.config.botname) {
      this.onBsay?.(target, message);
    } else if (this.leaves.has(toBot)) {
      this.send(toBot, frame);
    }
  }

  // -----------------------------------------------------------------------
  // Party line (Phase 7)
  // -----------------------------------------------------------------------

  /** Callback to get local DCC party users. Set by bot.ts. */
  getLocalPartyUsers: (() => PartyLineUser[]) | null = null;

  /** Get all remote party users tracked by the hub. */
  getRemotePartyUsers(): PartyLineUser[] {
    return Array.from(this.remotePartyUsers.values());
  }

  /** Handle PARTY_WHOM request: respond with all known users. */
  private handlePartyWhom(fromBot: string, ref: string): void {
    const local = this.getLocalPartyUsers?.() ?? [];
    const remote = this.getRemotePartyUsers();
    this.send(fromBot, {
      type: 'PARTY_WHOM_REPLY',
      ref,
      users: [...local, ...remote],
    });
  }

  // -----------------------------------------------------------------------
  // Session relay routing (Phase 9)
  // -----------------------------------------------------------------------

  /** Route RELAY_* frames between origin and target bots. */
  private routeRelayFrame(fromBot: string, frame: LinkFrame): void {
    const handle = String(frame.handle ?? '');

    if (frame.type === 'RELAY_REQUEST') {
      // Origin bot wants to relay to target bot
      const targetBot = String(frame.toBot ?? '');
      if (!this.leaves.has(targetBot)) {
        this.send(fromBot, {
          type: 'RELAY_END',
          handle,
          reason: `Bot "${targetBot}" not connected`,
        });
        return;
      }
      this.activeRelays.set(handle, { originBot: fromBot, targetBot });
      this.send(targetBot, frame);
    } else if (frame.type === 'RELAY_ACCEPT') {
      const relay = this.activeRelays.get(handle);
      if (relay) this.send(relay.originBot, frame);
    } else if (frame.type === 'RELAY_INPUT') {
      const relay = this.activeRelays.get(handle);
      if (relay) this.send(relay.targetBot, frame);
    } else if (frame.type === 'RELAY_OUTPUT') {
      const relay = this.activeRelays.get(handle);
      if (relay) this.send(relay.originBot, frame);
    } else if (frame.type === 'RELAY_END') {
      const relay = this.activeRelays.get(handle);
      if (relay) {
        // Forward to the other side
        const otherBot = fromBot === relay.originBot ? relay.targetBot : relay.originBot;
        this.send(otherBot, frame);
        this.activeRelays.delete(handle);
      }
    }
  }

  /** Forcibly disconnect a single leaf by botname. Returns true if the leaf was found and disconnected. */
  disconnectLeaf(botname: string, reason = 'Disconnected by admin'): boolean {
    const conn = this.leaves.get(botname);
    if (!conn) return false;

    clearInterval(conn.pingTimer!);
    conn.pingTimer = null;
    conn.protocol.onClose = null; // Prevent double-handling via onLeafClose
    conn.protocol.send({ type: 'ERROR', code: 'CLOSING', message: reason });
    conn.protocol.close();
    this.leaves.delete(botname);

    // Clean up remote party users from this leaf
    for (const key of this.remotePartyUsers.keys()) {
      if (key.endsWith(`@${botname}`)) this.remotePartyUsers.delete(key);
    }

    this.broadcast({ type: 'BOTPART', botname, reason });
    this.logger?.info(`Leaf "${botname}" disconnected: ${reason}`);
    this.onLeafDisconnected?.(botname, reason);
    return true;
  }

  /** Shut down the hub: close all leaf connections and the server. */
  close(): void {
    for (const leaf of this.leaves.values()) {
      clearInterval(leaf.pingTimer!); // clearInterval(null) is a no-op
      leaf.protocol.onClose = null; // Prevent double-handling during shutdown
      leaf.protocol.send({ type: 'ERROR', code: 'CLOSING', message: 'Hub shutting down' });
      leaf.protocol.close(); // close() is idempotent
    }
    this.leaves.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.logger?.info('Hub closed');
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const protocol = new BotLinkProtocol(socket, this.logger);
    let authenticated = false;

    // Handshake timeout
    const timer = setTimeout(() => {
      /* v8 ignore next -- timer fires after fast handshake completes in tests; guards real-network timeouts */
      if (!authenticated) {
        this.logger?.warn('Handshake timeout');
        protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Handshake timeout' });
        protocol.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    protocol.onFrame = (frame) => {
      /* v8 ignore next -- after HELLO is processed, onFrame is immediately replaced; second frame can't reach here */
      if (authenticated) return;

      if (frame.type !== 'HELLO') {
        protocol.send({ type: 'ERROR', code: 'PROTOCOL', message: 'Expected HELLO' });
        protocol.close();
        clearTimeout(timer);
        return;
      }

      clearTimeout(timer);
      authenticated = true;
      this.handleHello(protocol, frame);
    };

    protocol.onClose = () => clearTimeout(timer);
    protocol.onError = () => {};
  }

  private handleHello(protocol: BotLinkProtocol, frame: LinkFrame): void {
    const botname = String(frame.botname ?? '');
    const password = String(frame.password ?? '');

    // Auth check — password field is NEVER logged
    if (password !== this.expectedHash) {
      this.logger?.warn(`Auth failed for "${botname}"`);
      protocol.send({ type: 'ERROR', code: 'AUTH_FAILED', message: 'Bad password' });
      protocol.close();
      return;
    }

    if (!botname) {
      protocol.send({ type: 'ERROR', code: 'INVALID', message: 'Missing botname' });
      protocol.close();
      return;
    }

    if (this.leaves.has(botname)) {
      protocol.send({
        type: 'ERROR',
        code: 'DUPLICATE',
        message: `"${botname}" already connected`,
      });
      protocol.close();
      return;
    }

    const maxLeaves = this.config.max_leaves ?? 10;
    if (this.leaves.size >= maxLeaves) {
      protocol.send({ type: 'ERROR', code: 'FULL', message: 'Hub at max capacity' });
      protocol.close();
      return;
    }

    // Accept the leaf
    protocol.send({ type: 'WELCOME', botname: this.config.botname, version: this.version });

    // Notify existing leaves
    this.broadcast({ type: 'BOTJOIN', botname });

    // Create connection record
    const conn: LeafConnection = {
      botname,
      protocol,
      connectedAt: Date.now(),
      cmdRate: new RateCounter(10, 1_000),
      partyRate: new RateCounter(5, 1_000),
      protectRate: new RateCounter(20, 1_000),
      lastMessageAt: Date.now(),
      pingTimer: null,
      pingSeq: 0,
    };
    this.leaves.set(botname, conn);

    // State sync (Phase 4 populates this via onSyncRequest)
    protocol.send({ type: 'SYNC_START' });
    this.onSyncRequest?.(botname, (f) => protocol.send(f));
    protocol.send({ type: 'SYNC_END' });

    // Switch to steady-state frame handling
    protocol.onFrame = (f) => this.onSteadyState(botname, f);
    protocol.onClose = () => this.onLeafClose(botname);
    /* v8 ignore next -- socket error callback; only fires on real TCP errors */
    protocol.onError = (err) => this.logger?.debug(`Leaf ${botname}: ${err.message}`);

    // Start heartbeat
    this.startHeartbeat(conn);

    this.logger?.info(`Leaf "${botname}" connected`);
    this.onLeafConnected?.(botname);
  }

  // -----------------------------------------------------------------------
  // Steady state
  // -----------------------------------------------------------------------

  private onSteadyState(botname: string, frame: LinkFrame): void {
    const conn = this.leaves.get(botname)!;

    conn.lastMessageAt = Date.now();

    // Enforce authenticated identity — prevent a leaf from spoofing another leaf's name
    if ('fromBot' in frame) frame.fromBot = botname;

    // Heartbeat — handled internally
    if (frame.type === 'PONG') return;
    if (frame.type === 'PING') {
      conn.protocol.send({ type: 'PONG', seq: frame.seq });
      return;
    }

    // Rate limiting
    if (frame.type === 'CMD' && !conn.cmdRate.check()) {
      conn.protocol.send({
        type: 'ERROR',
        code: 'RATE_LIMITED',
        message: 'CMD rate limit exceeded',
      });
      return;
    }
    if (frame.type === 'PARTY_CHAT' && !conn.partyRate.check()) {
      return; // Silently drop
    }
    if (frame.type.startsWith('PROTECT_') && frame.type !== 'PROTECT_ACK') {
      if (!conn.protectRate.check()) return; // Silently drop
    }

    // Fan-out to other leaves (unless hub-only)
    if (!HUB_ONLY_FRAMES.has(frame.type)) {
      this.broadcast(frame, botname);
    }

    // Route CMD_RESULT back to originating bot (for toBot-routed commands)
    if (frame.type === 'CMD_RESULT') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingCmds.get(ref);
      if (pending) {
        this.pendingCmds.delete(ref);
        pending.resolve(Array.isArray(frame.output) ? (frame.output as string[]) : []);
        return;
      }
      const origin = this.cmdRoutes.get(ref);
      if (origin) {
        this.cmdRoutes.delete(ref);
        this.send(origin, frame);
        return;
      }
    }

    // Handle CMD frames internally (command relay)
    if (frame.type === 'CMD' && this.cmdHandler) {
      this.handleCmdRelay(botname, frame);
    }

    // Route BSAY to target bot(s)
    if (frame.type === 'BSAY') {
      this.handleBsay(botname, frame);
    }

    // Track remote party line users
    if (frame.type === 'PARTY_JOIN') {
      const key = `${frame.handle}@${frame.fromBot}`;
      this.remotePartyUsers.set(key, {
        handle: String(frame.handle ?? ''),
        nick: String(frame.nick ?? frame.handle ?? ''),
        botname: String(frame.fromBot ?? botname),
        connectedAt: Date.now(),
        idle: 0,
      });
    }
    if (frame.type === 'PARTY_PART') {
      this.remotePartyUsers.delete(`${frame.handle}@${frame.fromBot}`);
    }

    // Handle PARTY_WHOM: respond with all known party users
    if (frame.type === 'PARTY_WHOM') {
      this.handlePartyWhom(botname, String(frame.ref ?? ''));
    }

    // Route RELAY_* frames between origin and target bots
    this.routeRelayFrame(botname, frame);

    // Track PROTECT_* requests and route ACKs back to requester
    if (frame.type.startsWith('PROTECT_') && frame.type !== 'PROTECT_ACK' && frame.ref) {
      this.protectRequests.set(String(frame.ref), botname);
    }
    if (frame.type === 'PROTECT_ACK' && frame.ref) {
      const requester = this.protectRequests.get(String(frame.ref));
      if (requester) {
        this.send(requester, frame);
        this.protectRequests.delete(String(frame.ref));
      }
    }

    // Notify external handler
    this.onLeafFrame?.(botname, frame);
  }

  private onLeafClose(botname: string): void {
    const conn = this.leaves.get(botname);
    if (!conn) return;

    clearInterval(conn.pingTimer!); // clearInterval(null) is a no-op
    conn.pingTimer = null;
    this.leaves.delete(botname);

    // Clean up remote party users from this leaf
    for (const key of this.remotePartyUsers.keys()) {
      if (key.endsWith(`@${botname}`)) this.remotePartyUsers.delete(key);
    }

    this.broadcast({ type: 'BOTPART', botname, reason: 'Connection lost' });
    this.logger?.info(`Leaf "${botname}" disconnected`);
    this.onLeafDisconnected?.(botname, 'Connection lost');
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(conn: LeafConnection): void {
    conn.pingTimer = setInterval(() => {
      // Check for link timeout
      if (Date.now() - conn.lastMessageAt > this.linkTimeoutMs) {
        this.logger?.warn(`Leaf "${conn.botname}" timed out`);
        clearInterval(conn.pingTimer!);
        conn.pingTimer = null;
        this.leaves.delete(conn.botname);
        conn.protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Link timeout' });
        conn.protocol.close();
        this.broadcast({ type: 'BOTPART', botname: conn.botname, reason: 'Link timeout' });
        this.onLeafDisconnected?.(conn.botname, 'Link timeout');
        return;
      }

      conn.pingSeq++;
      conn.protocol.send({ type: 'PING', seq: conn.pingSeq });
    }, this.pingIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// BotLinkLeaf — leaf client
// ---------------------------------------------------------------------------

export class BotLinkLeaf {
  private config: BotlinkConfig;
  private version: string;
  private logger: Logger | null;
  private socketFactory: SocketFactory;
  private protocol: BotLinkProtocol | null = null;
  private connected = false;
  private connecting = false;
  private disconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private hubBotname = '';
  private pingSeq = 0;
  private pingIntervalMs: number;
  private linkTimeoutMs: number;
  private reconnectDelayMs: number;
  private reconnectMaxDelayMs: number;
  private pendingCmds: Map<string, { resolve: (output: string[]) => void }> = new Map();
  private pendingWhom: Map<string, { resolve: (users: PartyLineUser[]) => void }> = new Map();
  private pendingProtect: Map<string, { resolve: (success: boolean) => void }> = new Map();
  private cmdRefCounter = 0;
  private cmdHandler: CommandRelay | null = null;
  private cmdPermissions: LinkPermissions | null = null;

  /** Fired when handshake completes. */
  onConnected: ((hubBotname: string) => void) | null = null;
  /** Fired when connection is lost (not on explicit disconnect). */
  onDisconnected: ((reason: string) => void) | null = null;
  /** Fired for every non-heartbeat frame from the hub. */
  onFrame: ((frame: LinkFrame) => void) | null = null;

  constructor(
    config: BotlinkConfig,
    version: string,
    logger?: Logger | null,
    socketFactory?: SocketFactory,
  ) {
    this.config = config;
    this.version = version;
    this.logger = logger?.child('botlink:leaf') ?? null;
    this.socketFactory = socketFactory ?? ((p, h) => connect(p, h));
    this.reconnectDelayMs = config.reconnect_delay_ms ?? 5_000;
    this.reconnectMaxDelayMs = config.reconnect_max_delay_ms ?? 60_000;
    this.reconnectDelay = this.reconnectDelayMs;
    this.pingIntervalMs = config.ping_interval_ms;
    this.linkTimeoutMs = config.link_timeout_ms;
  }

  /** Connect to the hub via TCP. */
  connect(): void {
    if (this.connected || this.connecting || this.disconnecting) return;

    const hubHost = this.config.hub?.host;
    const hubPort = this.config.hub?.port;
    if (!hubHost || !hubPort) {
      this.logger?.error('Hub host/port not configured');
      return;
    }

    this.connecting = true;
    this.logger?.info(`Connecting to hub at ${hubHost}:${hubPort}`);

    const socket = this.socketFactory(hubPort, hubHost);

    const onConnect = () => {
      socket.removeListener('error', onError);
      this.connecting = false;
      this.initProtocol(socket);
    };
    const onError = (err: Error) => {
      socket.removeListener('connect', onConnect);
      this.connecting = false;
      socket.destroy();
      this.logger?.warn(`Connection failed: ${err.message}`);
      this.scheduleReconnect();
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  }

  /** Connect using an existing socket (for testing without TCP). */
  connectWithSocket(socket: Socket): void {
    this.initProtocol(socket);
  }

  /** Send a raw frame to the hub. Returns false if not connected. */
  send(frame: LinkFrame): boolean {
    if (!this.protocol || !this.connected) return false;
    return this.protocol.send(frame);
  }

  /** Send a command relay frame to the hub (Phase 5). */
  sendCommand(command: string, args: string, fromHandle: string, channel: string | null): boolean {
    return this.send({
      type: 'CMD',
      command,
      args,
      fromHandle,
      fromBot: this.config.botname,
      channel,
    });
  }

  /**
   * Send a protection request and wait for an ACK from any peer.
   * Returns true if a peer successfully acted, false on timeout or failure.
   */
  async sendProtect(
    protectType: string,
    channel: string,
    nick: string,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    if (!this.isConnected) return false;
    const ref = `protect:${++this.cmdRefCounter}`;

    this.send({
      type: protectType,
      channel,
      nick,
      requestedBy: this.config.botname,
      ref,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProtect.delete(ref);
        resolve(false);
      }, timeoutMs);

      this.pendingProtect.set(ref, {
        resolve: (success: boolean) => {
          clearTimeout(timer);
          resolve(success);
        },
      });
    });
  }

  // -----------------------------------------------------------------------
  // Command relay wiring (Phase 5)
  // -----------------------------------------------------------------------

  /** Wire command relay: relayToHub commands are sent to hub instead of executing locally. */
  setCommandRelay(commandHandler: CommandRelay, permissions: LinkPermissions): void {
    this.cmdHandler = commandHandler;
    this.cmdPermissions = permissions;
    commandHandler.setPreExecuteHook(async (entry, args, ctx) => {
      if (!entry.options.relayToHub || !this.isConnected || ctx.source === 'botlink') return false;
      const hostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
      const user = permissions.findByHostmask(hostmask);
      if (!user) return false;
      return this.relayCommand(entry.name, args, user.handle, ctx);
    });
  }

  /** Relay a command to the hub and display the result. Returns true when handled. */
  async relayCommand(
    name: string,
    args: string,
    handle: string,
    ctx: CommandContext,
    toBot?: string,
  ): Promise<boolean> {
    const ref = String(++this.cmdRefCounter);

    this.send({
      type: 'CMD',
      command: name,
      args,
      fromHandle: handle,
      fromBot: this.config.botname,
      channel: ctx.channel,
      ref,
      ...(toBot ? { toBot } : {}),
    });

    const CMD_TIMEOUT_MS = 10_000;
    const output = await new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(ref);
        resolve(['Command relay timed out.']);
      }, CMD_TIMEOUT_MS);

      this.pendingCmds.set(ref, {
        resolve: (lines: string[]) => {
          clearTimeout(timer);
          resolve(lines);
        },
      });
    });

    for (const line of output) {
      ctx.reply(line);
    }
    return true;
  }

  /** Request the full party line user list from the hub. */
  async requestWhom(): Promise<PartyLineUser[]> {
    if (!this.isConnected) return [];
    const ref = String(++this.cmdRefCounter);
    this.send({ type: 'PARTY_WHOM', ref });

    const WHOM_TIMEOUT_MS = 10_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWhom.delete(ref);
        resolve([]);
      }, WHOM_TIMEOUT_MS);

      this.pendingWhom.set(ref, {
        resolve: (users) => {
          clearTimeout(timer);
          resolve(users);
        },
      });
    });
  }

  /** Disconnect from the hub and stop reconnecting. */
  disconnect(): void {
    this.disconnecting = true;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.connected = false;
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
  }

  /** Force a reconnect to the hub. */
  reconnect(): void {
    this.disconnecting = false;
    this.connecting = false;
    this.stopHeartbeat();
    this.connected = false;
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
    this.reconnectDelay = this.reconnectDelayMs;
    this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get hubName(): string {
    return this.hubBotname;
  }

  // -----------------------------------------------------------------------
  // Protocol init
  // -----------------------------------------------------------------------

  private initProtocol(socket: Socket): void {
    this.protocol = new BotLinkProtocol(socket, this.logger);

    // Send HELLO — password hash, NEVER plaintext
    this.protocol.send({
      type: 'HELLO',
      botname: this.config.botname,
      password: hashPassword(this.config.password),
      version: this.version,
    });

    // Handshake phase — wait for WELCOME or ERROR
    this.protocol.onFrame = (frame) => {
      if (frame.type === 'WELCOME') {
        this.hubBotname = String(frame.botname ?? '');
        this.connected = true;
        this.reconnectDelay = this.reconnectDelayMs; // Reset backoff
        this.lastMessageAt = Date.now();

        // Switch to steady state
        this.protocol!.onFrame = (f) => this.onSteadyState(f);
        this.startHeartbeat();

        this.logger?.info(`Connected to hub "${this.hubBotname}"`);
        this.onConnected?.(this.hubBotname);
      } else if (frame.type === 'ERROR') {
        this.logger?.error(`Hub rejected: [${frame.code}] ${frame.message}`);
        this.protocol?.close();
        this.protocol = null;
        // Don't auto-reconnect on auth failure
        if (frame.code === 'AUTH_FAILED') return;
        this.scheduleReconnect();
      }
    };

    this.protocol.onClose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      this.protocol = null;

      if (wasConnected) {
        this.logger?.warn('Connection to hub lost');
        this.onDisconnected?.('Connection lost');
      }

      if (!this.disconnecting) {
        this.scheduleReconnect();
      }
    };

    /* v8 ignore next 3 -- socket error callback; only fires on real TCP errors */
    this.protocol.onError = (err) => {
      this.logger?.debug(`Socket error: ${err.message}`);
    };
  }

  // -----------------------------------------------------------------------
  // Steady state
  // -----------------------------------------------------------------------

  private onSteadyState(frame: LinkFrame): void {
    this.lastMessageAt = Date.now();

    if (frame.type === 'PING') {
      this.protocol?.send({ type: 'PONG', seq: frame.seq });
      return;
    }
    if (frame.type === 'PONG') return;

    // Resolve pending command relays
    if (frame.type === 'CMD_RESULT') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingCmds.get(ref);
      if (pending) {
        this.pendingCmds.delete(ref);
        pending.resolve(Array.isArray(frame.output) ? (frame.output as string[]) : []);
        return;
      }
    }

    // Resolve pending PARTY_WHOM requests
    if (frame.type === 'PARTY_WHOM_REPLY') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingWhom.get(ref);
      if (pending) {
        this.pendingWhom.delete(ref);
        pending.resolve(Array.isArray(frame.users) ? (frame.users as PartyLineUser[]) : []);
        return;
      }
    }

    // Resolve pending PROTECT_ACK
    if (frame.type === 'PROTECT_ACK') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingProtect.get(ref);
      if (pending) {
        this.pendingProtect.delete(ref);
        pending.resolve(frame.success === true);
        return;
      }
    }

    // Execute incoming CMD frames locally (from .bot command routed via hub)
    if (frame.type === 'CMD' && this.cmdHandler) {
      this.handleIncomingCmd(frame);
      return;
    }

    this.onFrame?.(frame);
  }

  /** Handle a CMD frame received from the hub (routed via .bot command). */
  private handleIncomingCmd(frame: LinkFrame): void {
    const handle = String(frame.fromHandle ?? '');
    const ref = String(frame.ref ?? '');
    const command = String(frame.command ?? '');
    const args = String(frame.args ?? '');
    const channel =
      frame.channel !== null && frame.channel !== undefined ? String(frame.channel) : null;

    const entry = this.cmdHandler!.getCommand(command);
    if (!entry) {
      this.send({ type: 'CMD_RESULT', ref, output: [`Unknown command: .${command}`] });
      return;
    }

    if (!this.cmdPermissions!.checkFlagsByHandle(entry.options.flags, handle, channel)) {
      this.send({ type: 'CMD_RESULT', ref, output: ['Permission denied.'] });
      return;
    }

    const output: string[] = [];
    const ctx: CommandContext = {
      source: 'botlink',
      nick: handle,
      ident: 'botlink',
      hostname: 'botlink',
      channel,
      reply: (msg: string) => {
        for (const line of msg.split('\n')) output.push(line);
      },
    };

    this.cmdHandler!.execute(`.${command} ${args}`.trim(), ctx)
      .then(() => {
        this.send({ type: 'CMD_RESULT', ref, output });
      })
      /* v8 ignore next 5 -- .catch only fires if command handler throws */
      .catch((err) => {
        this.send({
          type: 'CMD_RESULT',
          ref,
          output: [`Error: ${err instanceof Error ? err.message : String(err)}`],
        });
      });
  }

  // -----------------------------------------------------------------------
  // Reconnect with exponential backoff
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.disconnecting || this.reconnectTimer || this.connecting) return;

    this.logger?.info(`Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxDelayMs);
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.linkTimeoutMs) {
        this.logger?.warn('Hub timed out');
        this.protocol?.close();
        return;
      }
      this.pingSeq++;
      this.protocol?.send({ type: 'PING', seq: this.pingSeq });
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
