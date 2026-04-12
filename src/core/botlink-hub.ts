// HexBot — Bot Link Hub Server
// Accepts leaf connections, manages state sync, command relay, party line,
// relay routing, and heartbeat. Auth + IP ban management live in botlink-auth.ts.
// See docs/plans/bot-linking.md.
import { createServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';

import type { BotDatabase } from '../database';
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotlinkConfig } from '../types';
import { type AuthBanEntry, BotLinkAuthManager } from './botlink-auth';
import {
  BotLinkProtocol,
  type CommandRelay,
  HUB_ONLY_FRAMES,
  type LinkFrame,
  type LinkPermissions,
  type PartyLineUser,
  RateCounter,
  executeCmdFrame,
} from './botlink-protocol';
import { PermissionSyncer } from './botlink-sync';
import type { Permissions } from './permissions';

// Re-export auth helpers/types so existing imports from './botlink-hub' keep working.
export { isValidIP, isWhitelisted } from './botlink-auth';
export type { AuthBanEntry, LinkBan } from './botlink-auth';

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

// ---------------------------------------------------------------------------
// BotLinkHub
// ---------------------------------------------------------------------------

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
  private eventBus: BotEventBus | null;
  private auth: BotLinkAuthManager;
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
    logger?: Logger | null,
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
    this.cmdHandler = commandHandler;
    this.cmdPermissions = permissions;

    // Subscribe to permission mutation events — broadcast to all leaves
    const broadcastUserSync = (handle: string) => {
      const user = permissions.getUser(handle);
      if (user) {
        const frame = PermissionSyncer.buildSyncFrames(permissions).find(
          (f) => f.handle === handle,
        );
        if (frame) this.broadcast(frame);
      }
    };

    eventBus.on('user:added', broadcastUserSync);
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
    eventBus.on('user:hostmaskAdded', broadcastUserSync);
    eventBus.on('user:hostmaskRemoved', broadcastUserSync);
  }

  /** Handle an incoming CMD frame from a leaf. */
  private handleCmdRelay(fromBot: string, frame: LinkFrame): void {
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

    executeCmdFrame(frame, this.cmdHandler!, this.cmdPermissions!, (cmdRef, output) => {
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

  // -----------------------------------------------------------------------
  // BSAY routing
  // -----------------------------------------------------------------------

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

  /** Track a PARTY_JOIN: add user to remote party list. */
  private handlePartyJoin(botname: string, frame: LinkFrame): void {
    const key = `${frame.handle}@${frame.fromBot}`;
    this.remotePartyUsers.set(key, {
      handle: String(frame.handle ?? ''),
      nick: String(frame.nick ?? frame.handle ?? ''),
      botname: String(frame.fromBot ?? botname),
      connectedAt: Date.now(),
      idle: 0,
    });
  }

  /** Track a PARTY_PART: remove user from remote party list. */
  private handlePartyPart(frame: LinkFrame): void {
    this.remotePartyUsers.delete(`${frame.handle}@${frame.fromBot}`);
  }

  // -----------------------------------------------------------------------
  // Session relay routing (Phase 9)
  // -----------------------------------------------------------------------

  /**
   * Register a relay that the hub itself originated (e.g. from a DCC .relay
   * command on this bot).  The hub's routeRelayFrame only sees frames that
   * arrive from leaves, so hub-originated relays must be registered explicitly.
   */
  registerRelay(handle: string, targetBot: string): void {
    this.activeRelays.set(handle, { originBot: this.config.botname, targetBot });
  }

  /** Route RELAY_* frames between origin and target bots. */
  private routeRelayFrame(fromBot: string, frame: LinkFrame): void {
    const handle = String(frame.handle ?? '');

    if (frame.type === 'RELAY_REQUEST') {
      // Origin bot wants to relay to target bot
      const targetBot = String(frame.toBot ?? '');
      if (!this.leaves.has(targetBot)) {
        this.sendOrDeliver(fromBot, {
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
      if (relay) this.sendOrDeliver(relay.originBot, frame);
    } else if (frame.type === 'RELAY_INPUT') {
      const relay = this.activeRelays.get(handle);
      if (relay) this.send(relay.targetBot, frame);
    } else if (frame.type === 'RELAY_OUTPUT') {
      const relay = this.activeRelays.get(handle);
      if (relay) this.sendOrDeliver(relay.originBot, frame);
    } else if (frame.type === 'RELAY_END') {
      const relay = this.activeRelays.get(handle);
      if (relay) {
        // Forward to the other side
        const otherBot = fromBot === relay.originBot ? relay.targetBot : relay.originBot;
        this.sendOrDeliver(otherBot, frame);
        this.activeRelays.delete(handle);
      }
    }
  }

  /**
   * Send a frame to a bot.  If the target is the hub itself, deliver the frame
   * locally via onLeafFrame instead of trying to look it up in the leaves map.
   */
  private sendOrDeliver(botname: string, frame: LinkFrame): boolean {
    if (botname === this.config.botname) {
      this.onLeafFrame?.(botname, frame);
      return true;
    }
    return this.send(botname, frame);
  }

  /** Track a PROTECT_* request so the ACK can be routed back. */
  private handleProtectRequest(botname: string, frame: LinkFrame): void {
    if (frame.ref) {
      this.protectRequests.set(String(frame.ref), botname);
    }
  }

  /** Route a PROTECT_ACK back to the requesting leaf. */
  private handleProtectAck(frame: LinkFrame): void {
    if (!frame.ref) return;
    const requester = this.protectRequests.get(String(frame.ref));
    if (requester) {
      this.send(requester, frame);
      this.protectRequests.delete(String(frame.ref));
    }
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
  unban(ip: string): void {
    this.auth.unban(ip);
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
    const whitelisted = admission.whitelisted;

    // Past the early-reject gates — create the protocol wrapper (readline, frame parsing)
    const protocol = new BotLinkProtocol(socket, this.logger);
    let authenticated = false;

    // Handshake timeout — configurable, default 10s (was 30s)
    const timeoutMs = this.config.handshake_timeout_ms ?? 10_000;
    const timer = setTimeout(() => {
      /* v8 ignore next -- timer fires after fast handshake completes in tests; guards real-network timeouts */
      if (!authenticated) {
        this.logger?.warn(`Handshake timeout from ${ip}`);
        protocol.send({ type: 'ERROR', code: 'TIMEOUT', message: 'Handshake timeout' });
        protocol.close();
        this.auth.releasePending(ip, whitelisted);
      }
    }, timeoutMs);

    protocol.onFrame = (frame) => {
      /* v8 ignore next -- after HELLO is processed, onFrame is immediately replaced; second frame can't reach here */
      if (authenticated) return;

      if (frame.type !== 'HELLO') {
        protocol.send({ type: 'ERROR', code: 'PROTOCOL', message: 'Expected HELLO' });
        protocol.close();
        clearTimeout(timer);
        this.auth.releasePending(ip, whitelisted);
        return;
      }

      clearTimeout(timer);
      authenticated = true;
      this.auth.releasePending(ip, whitelisted);
      this.handleHello(protocol, frame, ip, whitelisted);
    };

    protocol.onClose = () => {
      clearTimeout(timer);
      if (!authenticated) this.auth.releasePending(ip, whitelisted);
    };
    protocol.onError = () => {};
  }

  private handleHello(
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

    // Dispatch by frame type
    switch (frame.type) {
      case 'CMD_RESULT': {
        const ref = String(frame.ref ?? '');
        const pending = this.pendingCmds.get(ref);
        if (pending) {
          this.pendingCmds.delete(ref);
          pending.resolve(
            Array.isArray(frame.output)
              ? frame.output.filter((s): s is string => typeof s === 'string')
              : [],
          );
          return;
        }
        const origin = this.cmdRoutes.get(ref);
        if (origin) {
          this.cmdRoutes.delete(ref);
          this.send(origin, frame);
          return;
        }
        break;
      }

      case 'CMD':
        if (this.cmdHandler) this.handleCmdRelay(botname, frame);
        break;

      case 'BSAY':
        this.handleBsay(botname, frame);
        break;

      case 'PARTY_JOIN':
        this.handlePartyJoin(botname, frame);
        break;

      case 'PARTY_PART':
        this.handlePartyPart(frame);
        break;

      case 'PARTY_WHOM':
        this.handlePartyWhom(botname, String(frame.ref ?? ''));
        break;

      case 'PROTECT_ACK':
        this.handleProtectAck(frame);
        break;

      default:
        // PROTECT_* requests (not ACK)
        if (frame.type.startsWith('PROTECT_')) {
          this.handleProtectRequest(botname, frame);
        }
        break;
    }

    // Relay routing applies to all RELAY_* frames
    this.routeRelayFrame(botname, frame);

    // Notify external handler
    this.onLeafFrame?.(botname, frame);
  }

  /** Clean up all hub-side state associated with a leaf (relays, routes, etc.). */
  private cleanupLeafState(botname: string): void {
    // Clean up remote party users from this leaf
    for (const key of this.remotePartyUsers.keys()) {
      if (key.endsWith(`@${botname}`)) this.remotePartyUsers.delete(key);
    }
    // Clean up active relays involving this leaf
    for (const [handle, relay] of this.activeRelays) {
      if (relay.originBot === botname || relay.targetBot === botname) {
        const otherBot = relay.originBot === botname ? relay.targetBot : relay.originBot;
        this.send(otherBot, { type: 'RELAY_END', handle, reason: `${botname} disconnected` });
        this.activeRelays.delete(handle);
      }
    }
    // Clean up pending CMD routes from this leaf
    for (const [ref, origin] of this.cmdRoutes) {
      if (origin === botname) this.cmdRoutes.delete(ref);
    }
    // Clean up pending protect requests from this leaf
    for (const [ref, requester] of this.protectRequests) {
      if (requester === botname) this.protectRequests.delete(ref);
    }
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
    }, this.pingIntervalMs);
  }
}
