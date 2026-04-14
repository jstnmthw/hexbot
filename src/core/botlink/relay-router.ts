// HexBot — Bot Link relay routing
//
// Owns the four routing Maps that the hub uses to stitch together cross-bot
// traffic: active session relays, in-flight PROTECT_* requests, CMD
// routing, and the remote party-line user table. Factoring these out of
// `BotLinkHub` lets the hub focus on connection lifecycle while relay
// bookkeeping (including the TTL sweep) lives in one place.
import type { LoggerLike } from '../../logger';
import type { LinkFrame, PartyLineUser } from './types.js';

interface RelayEntry {
  originBot: string;
  targetBot: string;
  createdAt: number;
}

interface PendingEntry {
  botname: string;
  createdAt: number;
}

const SHORT_TTL = 30_000; // 30 seconds — request/reply cycles
const RELAY_TTL = 60 * 60_000; // 1 hour — live relay sessions
const PARTY_TTL = 7 * 86_400_000; // 7 days — remote DCC party members

/**
 * Cap on the number of in-flight CMD and PROTECT_* routing entries. Normal
 * operation clears these within SHORT_TTL, so hitting the cap is a strong
 * signal that either the TTL sweeper failed or an attacker is planting
 * entries faster than they can age out. Dropping new requests past the cap
 * is preferable to unbounded Map growth over long uptimes.
 */
const MAX_PENDING_ROUTES = 4096;

/**
 * Cap on the remote party-user table. The 7-day PARTY_TTL means a leaf that
 * floods PARTY_JOIN frames can grow this map arbitrarily between sweeps.
 * Dropping new joins past the cap (with a warn) bounds worst-case growth.
 * See memleak audit 2026-04-14 INFO note.
 */
const MAX_REMOTE_PARTY_USERS = 512;

export interface RelayRouterDeps {
  botname: string;
  logger: LoggerLike | null;
  /** Forward a frame to a connected leaf over TCP. */
  send: (botname: string, frame: LinkFrame) => boolean;
  /**
   * Deliver a frame locally on the hub side — used when the router is
   * routing back to the hub's own `botname` (relay origin/target was the
   * hub). The hub wires this to its `onLeafFrame` callback so the local
   * DCC layer sees the frame as if it arrived from a leaf.
   */
  deliverLocal: (frame: LinkFrame) => void;
  hasLeaf: (botname: string) => boolean;
  getLocalPartyUsers: () => PartyLineUser[];
}

export class BotLinkRelayRouter {
  /** Active relay sessions. Key: handle. Exposed `readonly` so tests can seed sweep state. */
  readonly activeRelays = new Map<string, RelayEntry>();
  /** Pending protect requests keyed by ref, waiting for PROTECT_ACK. */
  readonly protectRequests = new Map<string, PendingEntry>();
  /** CMD routing table — tracks toBot-routed commands for CMD_RESULT forwarding. */
  readonly cmdRoutes = new Map<string, PendingEntry>();
  /** Remote party line users tracked from PARTY_JOIN/PARTY_PART frames. Key: `handle@botname`. */
  readonly remotePartyUsers = new Map<string, PartyLineUser>();

  constructor(private readonly deps: RelayRouterDeps) {}

  /**
   * Route a frame whose target bot may be the hub itself. Inlined at every
   * relay call site below so the hub-self branch is visible in the routing
   * logic instead of being hidden behind a "sendOrDeliver" name.
   */
  private sendToBot(botname: string, frame: LinkFrame): void {
    if (botname === this.deps.botname) {
      this.deps.deliverLocal(frame);
      return;
    }
    this.deps.send(botname, frame);
  }

  // ---------------------------------------------------------------------
  // Public API used by the hub
  // ---------------------------------------------------------------------

  /** Number of currently active relay sessions. */
  get relayCount(): number {
    return this.activeRelays.size;
  }

  /** All remote party users tracked by the hub. */
  getRemotePartyUsers(): PartyLineUser[] {
    return Array.from(this.remotePartyUsers.values());
  }

  /** Register a hub-originated relay (e.g. from a local DCC `.relay` command). */
  registerHubRelay(handle: string, targetBot: string): void {
    this.activeRelays.set(handle, {
      originBot: this.deps.botname,
      targetBot,
      createdAt: Date.now(),
    });
  }

  /** Remove a hub-originated relay. */
  unregisterHubRelay(handle: string): void {
    this.activeRelays.delete(handle);
  }

  /** Track a pending CMD being forwarded to another leaf so CMD_RESULT can be returned. */
  trackCmdRoute(ref: string, fromBot: string): boolean {
    if (this.cmdRoutes.size >= MAX_PENDING_ROUTES) {
      this.deps.logger?.warn(
        `cmdRoutes at cap (${MAX_PENDING_ROUTES}) — dropping CMD ref ${ref} from ${fromBot}`,
      );
      return false;
    }
    this.cmdRoutes.set(ref, { botname: fromBot, createdAt: Date.now() });
    return true;
  }

  /** Resolve a CMD_RESULT frame to its origin leaf, returning that bot's name if known. */
  popCmdRoute(ref: string): string | null {
    const origin = this.cmdRoutes.get(ref);
    if (!origin) return null;
    this.cmdRoutes.delete(ref);
    return origin.botname;
  }

  /** Track a PROTECT_* request so its ACK can be routed back to the requesting leaf. */
  trackProtectRequest(ref: string, fromBot: string): boolean {
    if (this.protectRequests.size >= MAX_PENDING_ROUTES) {
      this.deps.logger?.warn(
        `protectRequests at cap (${MAX_PENDING_ROUTES}) — dropping ref ${ref} from ${fromBot}`,
      );
      return false;
    }
    this.protectRequests.set(ref, { botname: fromBot, createdAt: Date.now() });
    return true;
  }

  /** Forward a PROTECT_ACK back to the originating leaf. */
  handleProtectAck(frame: LinkFrame): void {
    if (!frame.ref) return;
    const ref = String(frame.ref);
    const entry = this.protectRequests.get(ref);
    if (!entry) return;
    this.deps.send(entry.botname, frame);
    this.protectRequests.delete(ref);
  }

  /** Add a remote party user seen via PARTY_JOIN. */
  trackPartyJoin(fallbackBotname: string, frame: LinkFrame): void {
    const key = `${frame.handle}@${frame.fromBot}`;
    if (!this.remotePartyUsers.has(key) && this.remotePartyUsers.size >= MAX_REMOTE_PARTY_USERS) {
      this.deps.logger?.warn(
        `[botlink-router] dropping PARTY_JOIN for ${key}: remotePartyUsers at cap (${MAX_REMOTE_PARTY_USERS})`,
      );
      return;
    }
    this.remotePartyUsers.set(key, {
      handle: String(frame.handle ?? ''),
      nick: String(frame.nick ?? frame.handle ?? ''),
      botname: String(frame.fromBot ?? fallbackBotname),
      connectedAt: Date.now(),
      idle: 0,
    });
  }

  /** Remove a remote party user seen via PARTY_PART. */
  trackPartyPart(frame: LinkFrame): void {
    this.remotePartyUsers.delete(`${frame.handle}@${frame.fromBot}`);
  }

  /** Respond to a PARTY_WHOM query with the merged local + remote party list. */
  handlePartyWhom(fromBot: string, ref: string): void {
    const local = this.deps.getLocalPartyUsers();
    const remote = this.getRemotePartyUsers();
    this.deps.send(fromBot, {
      type: 'PARTY_WHOM_REPLY',
      ref,
      users: [...local, ...remote],
    });
  }

  /** Is `handle` currently in the remote party table for the given bot? */
  hasRemoteSession(handle: string, botname: string): boolean {
    return this.remotePartyUsers.has(`${handle}@${botname}`);
  }

  /** Route RELAY_* frames between origin and target bots. */
  routeRelayFrame(fromBot: string, frame: LinkFrame): void {
    const handle = String(frame.handle ?? '');

    if (frame.type === 'RELAY_REQUEST') {
      const targetBot = String(frame.toBot ?? '');
      if (!this.deps.hasLeaf(targetBot)) {
        this.sendToBot(fromBot, {
          type: 'RELAY_END',
          handle,
          reason: `Bot "${targetBot}" not connected`,
        });
        return;
      }
      this.activeRelays.set(handle, { originBot: fromBot, targetBot, createdAt: Date.now() });
      this.deps.send(targetBot, frame);
      return;
    }

    const relay = this.activeRelays.get(handle);
    if (!relay) {
      // Unified behaviour: if we don't know the relay any more (already ended,
      // never existed, TTL-swept), echo a RELAY_END back to the sender so its
      // state machine can clean up. Previously these three frame types
      // silently dropped, leaving originators waiting on a dead session.
      // Skip RELAY_END itself to avoid a ping-pong loop.
      if (frame.type !== 'RELAY_END') {
        this.sendToBot(fromBot, {
          type: 'RELAY_END',
          handle,
          reason: `Relay "${handle}" not active`,
        });
      }
      return;
    }

    if (frame.type === 'RELAY_ACCEPT') {
      this.sendToBot(relay.originBot, frame);
    } else if (frame.type === 'RELAY_INPUT') {
      this.sendToBot(relay.targetBot, frame);
    } else if (frame.type === 'RELAY_OUTPUT') {
      this.sendToBot(relay.originBot, frame);
    } else if (frame.type === 'RELAY_END') {
      const otherBot = fromBot === relay.originBot ? relay.targetBot : relay.originBot;
      this.sendToBot(otherBot, frame);
      this.activeRelays.delete(handle);
    }
  }

  /**
   * Clean up every state entry associated with a disconnected leaf. Sends
   * RELAY_END notifications to the other side of any relay this leaf was
   * participating in so neither bot is left in a half-open session.
   */
  cleanupLeafState(botname: string): void {
    for (const key of this.remotePartyUsers.keys()) {
      if (key.endsWith(`@${botname}`)) this.remotePartyUsers.delete(key);
    }
    for (const [handle, relay] of this.activeRelays) {
      if (relay.originBot === botname || relay.targetBot === botname) {
        const otherBot = relay.originBot === botname ? relay.targetBot : relay.originBot;
        this.deps.send(otherBot, {
          type: 'RELAY_END',
          handle,
          reason: `${botname} disconnected`,
        });
        this.activeRelays.delete(handle);
      }
    }
    for (const [ref, entry] of this.cmdRoutes) {
      if (entry.botname === botname) this.cmdRoutes.delete(ref);
    }
    for (const [ref, entry] of this.protectRequests) {
      if (entry.botname === botname) this.protectRequests.delete(ref);
    }
  }

  /**
   * TTL sweep across all four maps. Covers the case where the matching
   * END/PART frame is lost in transit so the Map never gets cleaned via its
   * normal path.
   */
  sweepStaleRoutes(): void {
    const now = Date.now();
    for (const [ref, entry] of this.protectRequests) {
      if (now - entry.createdAt > SHORT_TTL) this.protectRequests.delete(ref);
    }
    for (const [ref, entry] of this.cmdRoutes) {
      if (now - entry.createdAt > SHORT_TTL) this.cmdRoutes.delete(ref);
    }
    for (const [handle, entry] of this.activeRelays) {
      if (now - entry.createdAt > RELAY_TTL) this.activeRelays.delete(handle);
    }
    for (const [key, user] of this.remotePartyUsers) {
      if (now - user.connectedAt > PARTY_TTL) this.remotePartyUsers.delete(key);
    }
  }

  /** Drop every routing entry — called from hub.close(). */
  clear(): void {
    this.activeRelays.clear();
    this.protectRequests.clear();
    this.cmdRoutes.clear();
    this.remotePartyUsers.clear();
  }
}
