// HexBot — Bot Link Hub Server
// Accepts leaf connections, manages state sync, command relay, party line,
// relay routing, and heartbeat. Auth + IP ban management live in botlink-auth.ts.
// See docs/plans/bot-linking.md.
import { createServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';

import type { BotDatabase } from '../../database';
import type { BotEventBus, BotEvents } from '../../event-bus';
import type { LoggerLike } from '../../logger';
import type { BotlinkConfig } from '../../types';
import type { Permissions } from '../permissions';
import { type AuthBanEntry, BotLinkAuthManager } from './auth';
import { executeCmdFrame } from './cmd-exec.js';
import { FrameType } from './frame-types.js';
import { PendingRequestMap } from './pending';
import { BotLinkProtocol, HUB_ONLY_FRAMES } from './protocol';
import { RateCounter } from './rate-counter.js';
import { BotLinkRelayRouter } from './relay-router';
import { PermissionSyncer } from './sync';
import type { CommandRelay, LinkFrame, LinkPermissions, PartyLineUser } from './types.js';

// Re-export auth helpers/types so existing imports from './hub' keep working.
export { isValidIP, isWhitelisted } from './auth';
export type { AuthBanEntry, LinkBan } from './auth';

// ---------------------------------------------------------------------------
// Types
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

/**
 * Remove a listener from `bus` without re-declaring its per-event signature.
 * `BotEventBus.off`'s typed overload forces the listener's args tuple to
 * match the event name, but we store heterogeneous listeners in a single
 * array; all `off` actually needs is the original function reference.
 * The single cast is encapsulated here so grepping for listener-removal
 * casts across botlink produces one hit instead of two.
 */
function offBusListener(
  bus: BotEventBus,
  event: keyof BotEvents,
  fn: (...args: never[]) => void,
): void {
  (bus as unknown as { off: (e: string, f: (...args: never[]) => void) => void }).off(event, fn);
}

// ---------------------------------------------------------------------------
// BotLinkHub
// ---------------------------------------------------------------------------

export class BotLinkHub {
  private server: NetServer | null = null;
  private leaves: Map<string, LeafConnection> = new Map();
  /** Relay routing state owner. Public-readable so tests can seed sweep state. */
  readonly routes: BotLinkRelayRouter;
  /** Pending commands sent by the hub itself (from .bot). Key: ref. */
  private pendingCmds = new PendingRequestMap<string[]>();
  /**
   * Listeners we registered on `eventBus` so we can undo them on rewire /
   * close. Stored with the widened Node EventEmitter listener signature —
   * the original per-event types are preserved at the registration site;
   * detach only needs the shape that `EventEmitter.off` expects.
   */
  private eventBusListeners: Array<{
    event: keyof BotEvents;
    fn: (...args: never[]) => void;
  }> = [];
  private cmdRefCounter = 0;
  private config: BotlinkConfig;
  private version: string;
  private logger: LoggerLike | null;
  private eventBus: BotEventBus | null;
  /** Auth/ban state owner. Public-readable so tests can seed LRU/CIDR state. */
  readonly auth: BotLinkAuthManager;
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

  constructor(
    config: BotlinkConfig,
    version: string,
    logger?: LoggerLike | null,
    eventBus?: BotEventBus | null,
    db?: BotDatabase | null,
  ) {
    this.config = config;
    this.version = version;
    this.logger = logger?.child('botlink:hub') ?? null;
    this.eventBus = eventBus ?? null;
    this.pingIntervalMs = config.ping_interval_ms;
    this.linkTimeoutMs = config.link_timeout_ms;
    this.auth = new BotLinkAuthManager(config, this.logger, this.eventBus, db ?? null);
    this.routes = new BotLinkRelayRouter({
      botname: config.botname,
      logger: this.logger,
      send: (botname, frame) => this.send(botname, frame),
      deliverLocal: (frame) => this.onLeafFrame?.(this.config.botname, frame),
      hasLeaf: (botname) => this.leaves.has(botname),
      getLocalPartyUsers: () => this.getLocalPartyUsers?.() ?? [],
    });
  }

  /** Start listening for leaf connections. Uses config values when port/host not specified. */
  listen(
    port = this.config.listen?.port ?? 0,
    host = this.config.listen?.host ?? '0.0.0.0',
  ): Promise<void> {
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
    // Idempotent: drop any listeners registered by a previous call so we
    // don't stack duplicate broadcasts on re-wire.
    if (this.eventBusListeners.length > 0 && this.eventBus) {
      for (const { event, fn } of this.eventBusListeners) {
        offBusListener(this.eventBus, event, fn);
      }
      this.eventBusListeners = [];
    }

    this.cmdHandler = commandHandler;
    this.cmdPermissions = permissions;

    // Subscribe to permission mutation events — broadcast to all leaves.
    // Each handler takes the typed per-event payload; they are stored in a
    // single heterogeneous listener array via the variance trick in
    // `eventBusListeners` (see the field declaration).
    const broadcastUserSync = (handle: string): void => {
      const user = permissions.getUser(handle);
      if (user) {
        const frame = PermissionSyncer.buildSyncFrames(permissions).find(
          (f) => f.handle === handle,
        );
        if (frame) this.broadcast(frame);
      }
    };

    const onRemoved = (handle: string): void => {
      this.broadcast({ type: 'DELUSER', handle });
    };

    const onFlagsChanged = (
      handle: string,
      globalFlags: string,
      channelFlagsIn: Record<string, string>,
    ): void => {
      const channelFlags: Record<string, string> = { ...channelFlagsIn };
      const user = permissions.getUser(handle);
      if (user) {
        this.broadcast({
          type: 'SETFLAGS',
          handle,
          hostmasks: [...user.hostmasks],
          globalFlags,
          channelFlags,
        });
      }
    };

    eventBus.on('user:added', broadcastUserSync);
    eventBus.on('user:removed', onRemoved);
    eventBus.on('user:flagsChanged', onFlagsChanged);
    eventBus.on('user:hostmaskAdded', broadcastUserSync);
    eventBus.on('user:hostmaskRemoved', broadcastUserSync);

    this.eventBusListeners = [
      { event: 'user:added', fn: broadcastUserSync },
      { event: 'user:removed', fn: onRemoved },
      { event: 'user:flagsChanged', fn: onFlagsChanged },
      { event: 'user:hostmaskAdded', fn: broadcastUserSync },
      { event: 'user:hostmaskRemoved', fn: broadcastUserSync },
    ];
  }

  /** Handle an incoming CMD frame from a leaf. */
  private handleCmdRelay(fromBot: string, frame: LinkFrame): void {
    const cmdHandler = this.cmdHandler;
    const cmdPermissions = this.cmdPermissions;
    /* v8 ignore next -- defensive: handleCmdRelay is only called after setHandler */
    if (!cmdHandler || !cmdPermissions) return;

    const handle = String(frame.fromHandle ?? '');
    const ref = String(frame.ref ?? '');

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
      this.routes.trackCmdRoute(ref, fromBot);
      this.send(toBot, frame);
      return;
    }

    // Verify the handle has an active DCC session on the sending leaf.
    // This prevents a compromised leaf from forging commands as arbitrary handles.
    if (!this.routes.hasRemoteSession(handle, fromBot)) {
      this.send(fromBot, {
        type: 'CMD_RESULT',
        ref,
        output: [`No active session for "${handle}" on ${fromBot}.`],
      });
      return;
    }

    executeCmdFrame(frame, cmdHandler, cmdPermissions, (cmdRef, output) => {
      this.send(fromBot, { type: 'CMD_RESULT', ref: cmdRef, output });
    });
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
    return this.pendingCmds.create(ref, CMD_TIMEOUT_MS, ['Command relay timed out.']);
  }

  // -----------------------------------------------------------------------
  // BSAY routing
  // -----------------------------------------------------------------------

  /** Handle BSAY frame: route to target bot(s) and/or deliver locally. */
  private handleBsay(fromBot: string, frame: LinkFrame): void {
    const target = String(frame.target ?? '');
    const message = String(frame.message ?? '');
    const toBot = String(frame.toBot ?? '*');

    // TODO (Phase 3 audit): when BSAY frames gain a `fromHandle` field,
    // re-verify the sending handle has `+m` here before fanning out.
    // Today the only check is on the originating leaf; a compromised
    // leaf can craft a raw BSAY frame and bypass that gate. The fix is
    // a protocol addition (carry handle, verify on hub) and lives with
    // the broader botlink HELLO challenge-response migration in §11.

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
    return this.routes.getRemotePartyUsers();
  }

  /**
   * Register a relay that the hub itself originated (e.g. from a DCC .relay
   * command on this bot). The hub's routeRelayFrame only sees frames that
   * arrive from leaves, so hub-originated relays must be registered explicitly.
   */
  registerRelay(handle: string, targetBot: string): void {
    this.routes.registerHubRelay(handle, targetBot);
  }

  /** Remove a hub-originated relay (e.g. when the DCC user types .relay end). */
  unregisterRelay(handle: string): void {
    this.routes.unregisterHubRelay(handle);
  }

  /** Forcibly disconnect a single leaf by botname. Returns true if the leaf was found and disconnected. */
  disconnectLeaf(botname: string, reason = 'Disconnected by admin'): boolean {
    const conn = this.leaves.get(botname);
    if (!conn) return false;

    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = null;
    conn.protocol.onClose = null; // Prevent double-handling via onLeafClose
    conn.protocol.send({ type: 'ERROR', code: 'CLOSING', message: reason });
    conn.protocol.close();
    this.leaves.delete(botname);

    this.cleanupLeafState(botname);

    this.broadcast({ type: 'BOTPART', botname, reason });
    this.logger?.info(`Leaf "${botname}" disconnected: ${reason}`);
    this.onLeafDisconnected?.(botname, reason);
    return true;
  }

  // -----------------------------------------------------------------------
  // Link ban management — delegated to BotLinkAuthManager
  // -----------------------------------------------------------------------

  /** Get all active auth bans (auto + manual). */
  getAuthBans(): AuthBanEntry[] {
    return this.auth.getAuthBans();
  }

  /** Manually ban an IP or CIDR range. Persists to DB and loads into hot path. */
  manualBan(ip: string, durationMs: number, reason: string, setBy: string): void {
    this.auth.manualBan(ip, durationMs, reason, setBy);
  }

  /** Remove a ban (auto or manual) for an IP or CIDR. */
  unban(ip: string, by: string): void {
    this.auth.unban(ip, by);
  }

  /** Shut down the hub: close all leaf connections and the server. */
  close(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.pingTimer) clearInterval(leaf.pingTimer);
      leaf.protocol.onClose = null; // Prevent double-handling during shutdown
      leaf.protocol.send({ type: 'ERROR', code: 'CLOSING', message: 'Hub shutting down' });
      leaf.protocol.close(); // close() is idempotent
    }
    this.leaves.clear();

    // Resolve pending commands with error before clearing
    this.pendingCmds.drain(['Hub shutting down.']);
    this.routes.clear();

    // Remove eventBus listeners
    if (this.eventBus) {
      for (const { event, fn } of this.eventBusListeners) {
        offBusListener(this.eventBus, event, fn);
      }
      this.eventBusListeners = [];
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Dispose the auth manager — clears its sweep setInterval.
    this.auth.dispose();

    // Null callback fields so a stale closure from a prior lifecycle can't
    // fire if the hub instance is ever reused after close.
    this.onLeafConnected = null;
    this.onLeafDisconnected = null;
    this.onLeafFrame = null;
    this.onSyncRequest = null;
    this.onBsay = null;
    this.getLocalPartyUsers = null;

    this.logger?.info('Hub closed');
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const ip = socket.remoteAddress ?? 'unknown';
    this.logger?.debug(`New connection from ${ip}`);

    const admission = this.auth.admit(ip);
    if (!admission.allowed) {
      switch (admission.reason) {
        case 'banned':
          this.logger?.debug(`Rejected banned IP ${ip}`);
          break;
        case 'cidr-banned':
          this.logger?.debug(`Rejected IP ${ip} by CIDR ban`);
          break;
        case 'pending-limit':
          this.logger?.debug(`Pending handshake limit reached for ${ip}`);
          break;
        default:
          this.logger?.debug(`Rejected connection from ${ip}`);
      }
      socket.destroy();
      return;
    }

    // Past the early-reject gates — create the protocol wrapper (readline, frame parsing)
    const protocol = new BotLinkProtocol(socket, this.logger);
    this.beginHandshake(protocol, ip, admission.whitelisted);
  }

  /**
   * Drive the HELLO handshake for a freshly-admitted connection. All three
   * tear-down paths (timeout, protocol error, remote close) feed through a
   * single `finish()` closure so the timer clear and the `releasePending`
   * call live in one place instead of being sprinkled across three closures.
   */
  private beginHandshake(protocol: BotLinkProtocol, ip: string, whitelisted: boolean): void {
    // Handshake timeout — configurable, default 10s (was 30s)
    const timeoutMs = this.config.handshake_timeout_ms ?? 10_000;

    // Single-source-of-truth for handshake cleanup. `finish('ok')` is called
    // when HELLO arrives and the leaf is accepted; the other reasons are
    // tear-down paths that clear the timer and free the pending slot. After
    // the first call it's a no-op — makes double-dispatch from an onClose
    // racing the timer harmless.
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (reason: 'ok' | 'timeout' | 'protocol-error' | 'closed'): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (reason !== 'ok') this.auth.releasePending(ip, whitelisted);
    };

    timer = setTimeout(() => {
      /* v8 ignore next -- timer fires after fast handshake completes in tests; guards real-network timeouts */
      if (done) return;
      this.logger?.warn(`Handshake timeout from ${ip}`);
      protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Handshake timeout' });
      protocol.close();
      finish('timeout');
    }, timeoutMs);

    protocol.onFrame = (frame) => {
      /* v8 ignore next -- after HELLO is processed, onFrame is immediately replaced; second frame can't reach here */
      if (done) return;

      if (frame.type !== 'HELLO') {
        protocol.send({ type: 'ERROR', code: 'PROTOCOL', message: 'Expected HELLO' });
        protocol.close();
        finish('protocol-error');
        return;
      }

      // HELLO arrived — release the pending slot and either accept or reject.
      // We mark the handshake "done" _before_ verify/accept so any callback
      // firing re-entrantly (e.g. protocol.close() inside rejectHandshake
      // triggering onClose) sees `done === true` and skips.
      finish('ok');
      this.auth.releasePending(ip, whitelisted);
      this.acceptHandshake(protocol, frame, ip, whitelisted);
    };

    protocol.onClose = () => finish('closed');
    protocol.onError = () => {};
  }

  /**
   * Validate a HELLO frame and, on success, install the leaf as a connected
   * peer. Split out of the handshake driver so the accept/reject logic is
   * linear and doesn't have to re-thread the timer-cleanup state.
   */
  private acceptHandshake(
    protocol: BotLinkProtocol,
    frame: LinkFrame,
    ip: string,
    whitelisted: boolean,
  ): void {
    const botname = String(frame.botname ?? '');
    const password = String(frame.password ?? '');

    // Auth check — password field is NEVER logged
    if (!this.auth.verifyPassword(password)) {
      this.logger?.warn(`Auth failed for "${botname}" from ${ip}`);
      protocol.send({ type: 'ERROR', code: 'AUTH_FAILED', message: 'Bad password' });
      protocol.close();
      this.auth.noteFailure(ip, whitelisted);
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

    // Successful auth — clear failure count but preserve banCount for escalation
    this.auth.noteSuccess(ip, whitelisted);

    // Accept the leaf
    protocol.send({ type: 'WELCOME', botname: this.config.botname, version: this.version });

    // Notify existing leaves
    this.broadcast({ type: 'BOTJOIN', botname });

    // Create connection record.
    // Rate-limit windows: CMD 10/s (bursty admin use), PARTY_CHAT 5/s
    // (conversation), PROTECT_* 20/s (mass-deop recovery). Overflow is
    // dropped either with an ERROR frame (CMD) or silently. These are
    // intentionally per-leaf hot-path numbers — move to config only if we
    // start wanting per-deployment tuning.
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

    this.logger?.info(`Leaf "${botname}" connected from ${ip}`);
    this.onLeafConnected?.(botname);
  }

  // -----------------------------------------------------------------------
  // Steady state
  // -----------------------------------------------------------------------

  private onSteadyState(botname: string, frame: LinkFrame): void {
    const conn = this.leaves.get(botname);
    if (!conn) return;

    conn.lastMessageAt = Date.now();

    // Enforce authenticated identity — prevent a leaf from spoofing another leaf's name
    if ('fromBot' in frame) frame.fromBot = botname;

    // Heartbeat
    if (frame.type === FrameType.PONG) return;
    if (frame.type === FrameType.PING) {
      conn.protocol.send({ type: FrameType.PONG, seq: frame.seq });
      return;
    }

    // Rate limiting
    if (frame.type === FrameType.CMD && !conn.cmdRate.check()) {
      conn.protocol.send({
        type: FrameType.ERROR,
        code: 'RATE_LIMITED',
        message: 'CMD rate limit exceeded',
      });
      return;
    }
    if (frame.type === FrameType.PARTY_CHAT && !conn.partyRate.check()) {
      return; // Silently drop
    }
    if (frame.type.startsWith('PROTECT_') && frame.type !== FrameType.PROTECT_ACK) {
      if (!conn.protectRate.check()) return; // Silently drop
    }

    // Fan-out to other leaves (unless hub-only)
    if (!HUB_ONLY_FRAMES.has(frame.type)) {
      this.broadcast(frame, botname);
    }

    // Dispatch by frame type
    switch (frame.type) {
      case FrameType.CMD_RESULT: {
        const ref = String(frame.ref ?? '');
        const output = Array.isArray(frame.output)
          ? frame.output.filter((s): s is string => typeof s === 'string')
          : [];
        if (this.pendingCmds.resolve(ref, output)) return;
        const originBot = this.routes.popCmdRoute(ref);
        if (originBot) {
          this.send(originBot, frame);
          return;
        }
        break;
      }

      case FrameType.CMD:
        if (this.cmdHandler) this.handleCmdRelay(botname, frame);
        break;

      case FrameType.BSAY:
        this.handleBsay(botname, frame);
        break;

      case FrameType.PARTY_JOIN:
        this.routes.trackPartyJoin(botname, frame);
        break;

      case FrameType.PARTY_PART:
        this.routes.trackPartyPart(frame);
        break;

      case FrameType.PARTY_WHOM:
        this.routes.handlePartyWhom(botname, String(frame.ref ?? ''));
        break;

      case FrameType.PROTECT_ACK:
        this.routes.handleProtectAck(frame);
        break;

      default:
        // PROTECT_* requests (not ACK) — use raw startsWith since we don't
        // enumerate each PROTECT_* variant in the switch.
        if (frame.type.startsWith('PROTECT_')) {
          if (frame.ref) this.routes.trackProtectRequest(String(frame.ref), botname);
        }
        break;
    }

    // Relay routing applies to all RELAY_* frames. routeRelayFrame is
    // authoritative: it delivers locally via deliverLocal → onLeafFrame when
    // the hub itself is the relay origin/target, so skip the generic
    // notification below to avoid double-dispatching the same frame.
    if (frame.type.startsWith('RELAY_')) {
      this.routes.routeRelayFrame(botname, frame);
      return;
    }

    // Notify external handler
    this.onLeafFrame?.(botname, frame);
  }

  /** Clean up all hub-side state associated with a leaf (relays, routes, etc.). */
  private cleanupLeafState(botname: string): void {
    this.routes.cleanupLeafState(botname);
  }

  private onLeafClose(botname: string): void {
    const conn = this.leaves.get(botname);
    if (!conn) return;

    if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
    conn.pingTimer = null;
    this.leaves.delete(botname);

    this.cleanupLeafState(botname);

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
        if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
        conn.pingTimer = null;
        this.leaves.delete(conn.botname);
        this.cleanupLeafState(conn.botname);
        conn.protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Link timeout' });
        conn.protocol.close();
        this.broadcast({ type: 'BOTPART', botname: conn.botname, reason: 'Link timeout' });
        this.onLeafDisconnected?.(conn.botname, 'Link timeout');
        return;
      }

      conn.pingSeq++;
      conn.protocol.send({ type: 'PING', seq: conn.pingSeq });
      this.routes.sweepStaleRoutes();
    }, this.pingIntervalMs);
  }
}
