// HexBot — Bot Link Hub Server
// Accepts leaf connections, manages state sync, command relay, party line,
// relay routing, and heartbeat. Auth + IP ban management live in botlink-auth.ts.
// See docs/BOTLINK.md for the operator-facing protocol overview.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';

import type { BotDatabase } from '../../database';
import type { BotEventBus, BotEvents } from '../../event-bus';
import type { LoggerLike } from '../../logger';
import type { BotlinkConfig } from '../../types';
import type { Permissions } from '../permissions';
import { type AuthBanEntry, BotLinkAuthManager, isPrivateOrLoopback } from './auth';
import { Heartbeat } from './heartbeat';
import { type HubFrameDispatchContext, dispatchSteadyStateFrame } from './hub-frame-dispatch.js';
import { PendingRequestMap } from './pending';
import { BotLinkProtocol } from './protocol';
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
  // Steady-state per-frame rate buckets — budgets chosen to match
  // chat-class (5/s), command-class (10/s), and relay-class (30/s)
  // posture so a compromised leaf cannot saturate any single fanout
  // path. The actual numeric arguments are passed in acceptHandshake().
  bsayRate: RateCounter;
  announceRate: RateCounter;
  relayInputRate: RateCounter;
  relayOutputRate: RateCounter;
  partyJoinRate: RateCounter;
  partyPartRate: RateCounter;
  /**
   * Once-per-connection log latch for BSAY drops. We warn on the first
   * overflow seen on the connection and stay silent for the rest of
   * its lifetime — a leaf that floods BSAY once will otherwise produce
   * a wall of warnings when the next batch hits the ceiling. The
   * comment used to claim this resets per rate-window; it does not.
   * Reconnecting the leaf is the only way to re-arm the latch.
   */
  bsayDropLogged: boolean;
  lastMessageAt: number;
  /**
   * Heartbeat driver — owns the PING interval, sequence counter, and
   * timeout detection. Replaces the old `pingTimer` + `pingSeq` pair so
   * cleanup is a single `.stop()` call. Lazily installed in
   * {@link BotLinkHub.acceptHandshake}.
   */
  heartbeat: Heartbeat | null;
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

/**
 * Inbound side of the bot-link protocol — accepts leaf connections,
 * drives the per-connection HMAC handshake, and dispatches steady-state
 * frames. Co-owners of state surfaces:
 *
 *   - {@link BotLinkAuthManager} ({@link auth}): admission / ban / failure tracking
 *   - {@link BotLinkRelayRouter} ({@link routes}): cross-bot routing tables
 *   - {@link PendingRequestMap} (`pendingCmds`): hub-originated CMDs awaiting reply
 *
 * A single hub instance handles up to `config.max_leaves` simultaneous
 * leaves. The hub is also a regular peer in the botnet — `config.botname`
 * appears in BOTJOIN and is reachable by `.bot <name>` like any leaf.
 *
 * Callback fields (`onLeafConnected`, `onSyncRequest`, `onBsay`, etc.)
 * are wired by the bot orchestrator post-construction; until they are
 * set, frames that depend on them are silently dropped.
 */
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
    this.pingIntervalMs = config.ping_interval_ms ?? 30_000;
    this.linkTimeoutMs = config.link_timeout_ms ?? 90_000;
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
    host = this.config.listen?.host ?? '127.0.0.1',
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.logger?.info(`Listening on ${host}:${port}`);
        // Loud warning when the hub is bound to a publicly-reachable
        // interface. `isPrivateOrLoopback` covers 127.0.0.0/8, ::1,
        // and the three RFC1918 ranges; anything else — including
        // `0.0.0.0` and `::` — triggers the warning because the HELLO
        // handshake is authenticated but not encrypted, and operators
        // must front the port with a tunnel (WireGuard / SSH / etc).
        if (!isPrivateOrLoopback(host)) {
          this.logger?.warn(
            `[security] botlink listening on non-loopback, non-RFC1918 address ${host}:${port} — front it with a tunnel (WireGuard / SSH) or bind to 127.0.0.1`,
          );
        }
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

  /**
   * Broadcast a frame to all leaves, optionally excluding one.
   *
   * Per-leaf error containment: a `send()` that returns false (write
   * buffer full, socket half-open) or throws is logged and the
   * remaining leaves still receive the frame. A subsequent bootstrap
   * or heartbeat round-trip will detect the divergence and either
   * resync or disconnect the stuck leaf.
   */
  broadcast(frame: LinkFrame, excludeBot?: string): void {
    for (const [name, leaf] of this.leaves) {
      if (name === excludeBot) continue;
      let delivered = false;
      try {
        delivered = leaf.protocol.send(frame);
      } catch (err) {
        this.logger?.warn(`Broadcast ${frame.type} to "${name}" threw:`, err);
      }
      if (!delivered) {
        this.logger?.warn(
          `Broadcast ${frame.type} to "${name}" failed (write buffer full or socket half-open); state may diverge until next heartbeat/resync`,
        );
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
  /**
   * Bus reference that the current `eventBusListeners` are attached to.
   * Tracked separately from the constructor's `this.eventBus` so a re-wire
   * with a different bus reference still detaches from the right bus
   * (W2.5).
   */
  private wiredEventBus: BotEventBus | null = null;

  /** Wire command relay: hub executes CMD frames and broadcasts permission changes. */
  setCommandRelay(
    commandHandler: CommandRelay,
    permissions: Permissions,
    eventBus: BotEventBus,
  ): void {
    // Idempotent: drop any listeners registered by a previous call so we
    // don't stack duplicate broadcasts on re-wire. Detach from whichever
    // bus we last attached to — `wiredEventBus` may not equal the new
    // `eventBus` arg or `this.eventBus` if callers wired against a
    // different bus instance previously.
    if (this.eventBusListeners.length > 0 && this.wiredEventBus) {
      for (const { event, fn } of this.eventBusListeners) {
        offBusListener(this.wiredEventBus, event, fn);
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
    this.wiredEventBus = eventBus;
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
    // The `hubcmd:` prefix distinguishes hub-originated CMDs (waiting on
    // pendingCmds here) from leaf-originated CMDs the hub re-routes via
    // `routes.trackCmdRoute()` — both share the ref namespace on the wire.
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

    // 10s — the same ceiling DCC operators see for any single command they
    // run via `.bot`. Long enough to cover a network blip + a slow command
    // executing on the remote leaf, short enough that an unresponsive leaf
    // doesn't pin the IRC user's session forever.
    const CMD_TIMEOUT_MS = 10_000;
    return this.pendingCmds.create(ref, CMD_TIMEOUT_MS, ['Command relay timed out.']);
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
   * Returns false when the active-relay cap is reached.
   */
  registerRelay(handle: string, targetBot: string): boolean {
    return this.routes.registerHubRelay(handle, targetBot);
  }

  /** Remove a hub-originated relay (e.g. when the DCC user types .relay end). */
  unregisterRelay(handle: string): void {
    this.routes.unregisterHubRelay(handle);
  }

  /** Forcibly disconnect a single leaf by botname. Returns true if the leaf was found and disconnected. */
  disconnectLeaf(botname: string, reason = 'Disconnected by admin'): boolean {
    const conn = this.leaves.get(botname);
    if (!conn) return false;

    conn.heartbeat?.stop();
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
      leaf.heartbeat?.stop();
      leaf.protocol.onClose = null; // Prevent double-handling during shutdown
      leaf.protocol.send({ type: 'ERROR', code: 'CLOSING', message: 'Hub shutting down' });
      leaf.protocol.close(); // close() is idempotent
    }
    this.leaves.clear();

    // Resolve pending commands with error before clearing
    this.pendingCmds.drain(['Hub shutting down.']);
    this.routes.clear();

    // Remove eventBus listeners. Detach from `wiredEventBus` (the bus
    // they were actually attached to via `setCommandRelay`) rather than
    // `this.eventBus`, which may differ if a caller re-wired with a new
    // bus reference (W2.5).
    if (this.wiredEventBus) {
      for (const { event, fn } of this.eventBusListeners) {
        offBusListener(this.wiredEventBus, event, fn);
      }
      this.eventBusListeners = [];
      this.wiredEventBus = null;
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

    // Past the early-reject gates — create the protocol wrapper (readline,
    // frame parsing). Construction shouldn't throw under normal conditions,
    // but if it does we must still release the pending-handshake slot we
    // just admitted; otherwise the per-IP cap leaks one slot per failure
    // and a repeated construction error locks the IP out at
    // `max_pending_handshakes`.
    let protocol: BotLinkProtocol;
    try {
      protocol = new BotLinkProtocol(socket, this.logger);
    } catch (err) {
      this.logger?.error(`BotLinkProtocol construction threw for ${ip}:`, err);
      this.auth.releasePending(ip, admission.whitelisted);
      socket.destroy();
      return;
    }
    this.beginHandshake(protocol, ip, admission.whitelisted);
  }

  /**
   * Drive the HELLO handshake for a freshly-admitted connection. All three
   * tear-down paths (timeout, protocol error, remote close) feed through a
   * single `finish()` closure so the timer clear and the `releasePending`
   * call live in one place instead of being sprinkled across three closures.
   *
   * Flow: hub sends HELLO_CHALLENGE { nonce } immediately; leaf replies
   * with HELLO { hmac } computed over the nonce with the shared link key.
   * The nonce lives in this closure — no cache, no cross-connection
   * state — so a captured HELLO cannot be replayed against a fresh
   * connection, whose nonce differs.
   */
  private beginHandshake(protocol: BotLinkProtocol, ip: string, whitelisted: boolean): void {
    // Handshake timeout — configurable, default 10s (was 30s)
    const timeoutMs = this.config.handshake_timeout_ms ?? 10_000;

    // Per-connection nonce — fresh random bytes, used once, discarded on
    // finish. Emitted hex on the wire so the leaf can read it without
    // binary escaping; verification HMACs over the raw bytes.
    const nonce = randomBytes(32);

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

    // Emit the challenge BEFORE wiring onFrame so a malicious leaf can't
    // ship a pre-emptive HELLO before we've decided on a nonce.
    protocol.send({
      type: 'HELLO_CHALLENGE',
      nonce: nonce.toString('hex'),
      hubBotname: this.config.botname,
    });

    protocol.onFrame = (frame) => {
      /* v8 ignore next -- after HELLO is processed, onFrame is immediately replaced; second frame can't reach here */
      if (done) return;

      if (frame.type !== 'HELLO') {
        protocol.send({ type: 'ERROR', code: 'PROTOCOL', message: 'Expected HELLO' });
        protocol.close();
        finish('protocol-error');
        return;
      }

      // HELLO arrived — mark the handshake "done" so re-entrant
      // onClose from a rejectHandshake sees `done === true` and skips.
      // We run `acceptHandshake` BEFORE releasing the pending slot —
      // if accept synchronously rejects (auth failure, duplicate
      // botname) the slot is still held, preventing the same IP from
      // immediately opening a second handshake before the first
      // rejection propagates.
      finish('ok');
      try {
        this.acceptHandshake(protocol, frame, ip, whitelisted, nonce);
      } finally {
        this.auth.releasePending(ip, whitelisted);
      }
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
    nonce: Buffer,
  ): void {
    const botname = String(frame.botname ?? '');

    // Reject pre-v2 leaves that still ship a `password` field. Loud
    // PROTOCOL error so an operator who forgot to upgrade one side of
    // the botnet sees the mismatch immediately instead of an opaque
    // AUTH_FAILED. No failure count — this is a misconfiguration, not
    // a brute-force attempt.
    if ('password' in frame) {
      this.logger?.warn(
        `Pre-v2 HELLO from "${botname || ip}" (contains "password" field) — upgrade required`,
      );
      protocol.send({
        type: 'ERROR',
        code: 'PROTOCOL',
        message: 'HELLO v2 required: update this bot to the matching botlink version',
      });
      protocol.close();
      return;
    }

    if (typeof frame.hmac !== 'string' || frame.hmac.length === 0) {
      protocol.send({ type: 'ERROR', code: 'PROTOCOL', message: 'HELLO missing hmac' });
      protocol.close();
      return;
    }

    // Auth check — hmac is never logged.
    if (!this.auth.verifyHelloHmac(nonce, frame.hmac)) {
      this.logger?.warn(`Auth failed for "${botname}" from ${ip}`);
      protocol.send({ type: 'ERROR', code: 'AUTH_FAILED', message: 'Bad HMAC' });
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
      bsayRate: new RateCounter(10, 1_000),
      announceRate: new RateCounter(5, 1_000),
      relayInputRate: new RateCounter(30, 1_000),
      relayOutputRate: new RateCounter(30, 1_000),
      partyJoinRate: new RateCounter(5, 1_000),
      partyPartRate: new RateCounter(5, 1_000),
      bsayDropLogged: false,
      lastMessageAt: Date.now(),
      heartbeat: null,
    };
    this.leaves.set(botname, conn);

    // State sync (Phase 4 populates this via onSyncRequest).
    //
    // Always send SYNC_END even if the sync-request callback throws —
    // without this guarantee, a single permissions-undefined error
    // would leave the leaf stuck in sync phase while the hub has
    // moved on to steady state (asymmetric state is worse than no
    // state). On throw, we additionally send an ERROR frame with
    // code=SYNC_FAILED so the leaf's sync-complete listener sees a
    // deterministic signal.
    protocol.send({ type: 'SYNC_START' });
    try {
      this.onSyncRequest?.(botname, (f) => protocol.send(f));
    } catch (err) {
      this.logger?.error(`onSyncRequest threw while syncing "${botname}":`, err);
      protocol.send({
        type: 'ERROR',
        code: 'SYNC_FAILED',
        message: 'Sync request failed — hub will proceed to steady state anyway',
      });
    }
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

  /**
   * Build the context object passed to the extracted frame dispatcher.
   * Done once per steady-state frame so the dispatcher sees current
   * `cmdHandler` / callback state without reaching into hub internals.
   */
  private frameDispatchContext(): HubFrameDispatchContext {
    // `checkFlags` delegates to the wired permissions adapter when
    // available; if `cmdPermissions` is null (pre-wire during startup),
    // return null so hub-bsay-router fails closed on BSAY fanout rather
    // than silently bypassing the +m re-check.
    const perms = this.cmdPermissions;
    const checkFlags = perms
      ? (handle: string, flags: string, channel: string | null): boolean =>
          perms.checkFlagsByHandle(flags, handle, channel)
      : null;
    return {
      botname: this.config.botname,
      routes: this.routes,
      pendingCmds: this.pendingCmds,
      cmdHandler: this.cmdHandler,
      cmdPermissions: this.cmdPermissions,
      send: (bot, frame) => this.send(bot, frame),
      broadcast: (frame, excludeBot) => this.broadcast(frame, excludeBot),
      hasLeaf: (bot) => this.leaves.has(bot),
      onLeafFrame: this.onLeafFrame,
      onBsay: this.onBsay,
      checkFlags,
      logger: this.logger,
    };
  }

  private onSteadyState(botname: string, frame: LinkFrame): void {
    const conn = this.leaves.get(botname);
    // Race guard: socket may deliver one buffered frame after onLeafClose
    // already removed the leaf entry. Drop silently.
    if (!conn) return;

    conn.lastMessageAt = Date.now();

    // Authenticated identity overwrite — the leaf's botname was fixed at
    // handshake-accept; trust that, not whatever the wire says. A
    // compromised leaf could otherwise stamp `fromBot: "other-bot"` onto
    // BSAY/CMD frames and impersonate a sibling. Only overwrite when the
    // field is already present so this stays a wire normalization rather
    // than an unconditional injection.
    if ('fromBot' in frame) frame.fromBot = botname;

    dispatchSteadyStateFrame(
      this.frameDispatchContext(),
      {
        botname,
        send: (f) => conn.protocol.send(f),
        cmdRate: conn.cmdRate,
        partyRate: conn.partyRate,
        protectRate: conn.protectRate,
        bsayRate: conn.bsayRate,
        announceRate: conn.announceRate,
        relayInputRate: conn.relayInputRate,
        relayOutputRate: conn.relayOutputRate,
        partyJoinRate: conn.partyJoinRate,
        partyPartRate: conn.partyPartRate,
        noteBsayDrop: () => {
          if (conn.bsayDropLogged) return;
          conn.bsayDropLogged = true;
          this.logger?.warn(
            `[security] BSAY rate-limit exceeded from "${conn.botname}" — dropping until next window`,
          );
        },
      },
      frame,
    );
  }

  /** Clean up all hub-side state associated with a leaf (relays, routes, etc.). */
  private cleanupLeafState(botname: string): void {
    this.routes.cleanupLeafState(botname);
  }

  private onLeafClose(botname: string): void {
    const conn = this.leaves.get(botname);
    // Idempotent: a heartbeat-timeout teardown and the socket-close event
    // can both reach here for the same connection; second call is a no-op.
    if (!conn) return;

    conn.heartbeat?.stop();
    this.leaves.delete(botname);

    this.cleanupLeafState(botname);

    this.broadcast({ type: 'BOTPART', botname, reason: 'Connection lost' });
    this.logger?.info(`Leaf "${botname}" disconnected`);
    this.onLeafDisconnected?.(botname, 'Connection lost');
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  /**
   * Install a per-leaf {@link Heartbeat}. `onTimeout` tears the leaf down
   * the same way {@link onLeafClose} would — Heartbeat.stop() already
   * fired before this callback runs, so we only handle the state
   * cleanup and broadcast path.
   */
  private startHeartbeat(conn: LeafConnection): void {
    conn.heartbeat = new Heartbeat({
      intervalMs: this.pingIntervalMs,
      timeoutMs: this.linkTimeoutMs,
      getLastMessageAt: () => conn.lastMessageAt,
      sendPing: (seq) => conn.protocol.send({ type: 'PING', seq }),
      onTimeout: () => {
        this.logger?.warn(`Leaf "${conn.botname}" timed out`);
        this.leaves.delete(conn.botname);
        this.cleanupLeafState(conn.botname);
        conn.protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Link timeout' });
        conn.protocol.close();
        this.broadcast({ type: 'BOTPART', botname: conn.botname, reason: 'Link timeout' });
        this.onLeafDisconnected?.(conn.botname, 'Link timeout');
      },
      onTick: () => this.routes.sweepStaleRoutes(),
    });
    conn.heartbeat.start();
  }
}
