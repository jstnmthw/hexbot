// HexBot — Bot Link relay routing
//
// Owns the four routing Maps that the hub uses to stitch together cross-bot
// traffic: active session relays, in-flight PROTECT_* requests, CMD
// routing, and the remote party-line user table. Factoring these out of
// `BotLinkHub` lets the hub focus on connection lifecycle while relay
// bookkeeping (including the TTL sweep) lives in one place.
import type { LoggerLike } from '../../logger';
import type { LinkFrame, PartyLineUser } from './protocol';

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

export interface RelayRouterDeps {
  botname: string;
  logger: LoggerLike | null;
  send: (botname: string, frame: LinkFrame) => boolean;
  /**
   * Deliver a frame locally when the target is the hub itself, otherwise
   * forward it over TCP to the matching leaf. Mirrors the behaviour of
   * `BotLinkHub.sendOrDeliver` so relay end-state updates can reach both
   * hub-originated and leaf-originated sessions.
   */
  sendOrDeliver: (botname: string, frame: LinkFrame) => boolean;
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
  trackCmdRoute(ref: string, fromBot: string): void {
    this.cmdRoutes.set(ref, { botname: fromBot, createdAt: Date.now() });
  }

  /** Resolve a CMD_RESULT frame to its origin leaf, returning that bot's name if known. */
  popCmdRoute(ref: string): string | null {
    const origin = this.cmdRoutes.get(ref);
    if (!origin) return null;
    this.cmdRoutes.delete(ref);
    return origin.botname;
  }

  /** Track a PROTECT_* request so its ACK can be routed back to the requesting leaf. */
  trackProtectRequest(ref: string, fromBot: string): void {
    this.protectRequests.set(ref, { botname: fromBot, createdAt: Date.now() });
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
        this.deps.sendOrDeliver(fromBot, {
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
    if (!relay) return;

    if (frame.type === 'RELAY_ACCEPT') {
      this.deps.sendOrDeliver(relay.originBot, frame);
    } else if (frame.type === 'RELAY_INPUT') {
      this.deps.send(relay.targetBot, frame);
    } else if (frame.type === 'RELAY_OUTPUT') {
      this.deps.sendOrDeliver(relay.originBot, frame);
    } else if (frame.type === 'RELAY_END') {
      const otherBot = fromBot === relay.originBot ? relay.targetBot : relay.originBot;
      this.deps.sendOrDeliver(otherBot, frame);
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
