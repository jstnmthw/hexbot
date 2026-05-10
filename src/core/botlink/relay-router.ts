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

/**
 * Delete entries from `map` whose timestamp (as extracted by `getTs`) is
 * older than `ttl` relative to `now`. Shared by the four routing maps on
 * BotLinkRelayRouter so the TTL loop lives in one place and the four call
 * sites stay readable — each line in the caller documents its own TTL and
 * timestamp field.
 */
function sweepExpired<V>(
  map: Map<string, V>,
  now: number,
  ttl: number,
  getTs: (v: V) => number,
): void {
  for (const [key, value] of map) {
    if (now - getTs(value) > ttl) map.delete(key);
  }
}

// CMD/PROTECT request lifetime: well above the 10s pendingCmds and 5s
// pendingProtect timeouts on either side of the link, but short enough
// that a wedged peer's stale entries clear within one heartbeat tick.
const SHORT_TTL = 30_000; // 30 seconds — request/reply cycles
// Relay sessions stay live for as long as the user is interacting with a
// remote bot. 1h is a soft fallback for the case where neither side
// emits RELAY_END (network split before clean shutdown).
const RELAY_TTL = 60 * 60_000; // 1 hour — live relay sessions
// Remote DCC party members can sit idle but logged-in for days. We sweep
// after a week as a hard backstop; PARTY_PART normally clears them sooner.
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
 */
const MAX_REMOTE_PARTY_USERS = 512;

/**
 * Cap on concurrent active relay sessions. Sibling routing maps already
 * cap at 4096 (CMD/PROTECT requests) and 512 (remote party users); without
 * this, `activeRelays` only relies on the 1-hour RELAY_TTL sweep, which is
 * heartbeat-driven and stops if all leaves disconnect. Hitting the cap
 * means either a leaf is misbehaving or the sweeper has stalled.
 */
const MAX_ACTIVE_RELAYS = 256;

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

/**
 * Hub-side routing tables for cross-bot relay traffic. Holds the four
 * Maps the hub consults to forward CMD_RESULT, PROTECT_ACK, RELAY_*, and
 * PARTY_* frames between leaves; the hub itself only knows about
 * connection lifecycle. All entries are TTL-swept by {@link sweepStaleRoutes},
 * called once per heartbeat tick — losing the matching END/ACK frame in
 * transit therefore self-heals within `RELAY_TTL` / `SHORT_TTL` / `PARTY_TTL`.
 *
 * Per-map size caps (`MAX_*`) are the second line of defense against a
 * compromised leaf flooding a routing table; the trusted-peer model is
 * the first.
 */
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
  registerHubRelay(handle: string, targetBot: string): boolean {
    if (!this.activeRelays.has(handle) && this.activeRelays.size >= MAX_ACTIVE_RELAYS) {
      this.deps.logger?.warn(
        `[botlink-router] dropping hub relay ${handle}->${targetBot}: activeRelays at cap (${MAX_ACTIVE_RELAYS})`,
      );
      return false;
    }
    this.activeRelays.set(handle, {
      originBot: this.deps.botname,
      targetBot,
      createdAt: Date.now(),
    });
    return true;
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
      // Hub-side gate: only register a relay when the originating leaf has a
      // live DCC party session for `handle`. A compromised leaf can
      // otherwise craft RELAY_REQUEST for any handle the target bot knows
      // and execute commands under that handle's identity. Mirrors the
      // same hasRemoteSession gate the CMD relay applies at
      // hub-cmd-relay.ts (see `handleCmdRelay`).
      if (!this.hasRemoteSession(handle, fromBot)) {
        this.deps.logger?.warn(
          `[security] RELAY_REQUEST from "${fromBot}" for handle "${handle}" rejected: no active DCC party session`,
        );
        this.sendToBot(fromBot, {
          type: 'RELAY_END',
          handle,
          reason: `No active DCC party session for "${handle}" on ${fromBot}`,
        });
        return;
      }
      if (!this.activeRelays.has(handle) && this.activeRelays.size >= MAX_ACTIVE_RELAYS) {
        this.deps.logger?.warn(
          `[botlink-router] dropping RELAY_REQUEST from "${fromBot}" handle "${handle}": activeRelays at cap (${MAX_ACTIVE_RELAYS})`,
        );
        this.sendToBot(fromBot, {
          type: 'RELAY_END',
          handle,
          reason: `Hub relay table full (cap ${MAX_ACTIVE_RELAYS})`,
        });
        return;
      }
      this.activeRelays.set(handle, { originBot: fromBot, targetBot, createdAt: Date.now() });
      this.deps.send(targetBot, frame);
      return;
    }

    const relay = this.activeRelays.get(handle);
    if (!relay) {
      // Unified behavior: if we don't know the relay any more (already ended,
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
   * normal path. Each line names its own TTL so the numbers stay visible —
   * the repetition here is shallow (`age > ttl`) and doesn't merit
   * hiding behind a `RoutingMap<T>` abstraction.
   */
  sweepStaleRoutes(): void {
    const now = Date.now();
    sweepExpired(this.protectRequests, now, SHORT_TTL, (e) => e.createdAt);
    sweepExpired(this.cmdRoutes, now, SHORT_TTL, (e) => e.createdAt);
    sweepExpired(this.activeRelays, now, RELAY_TTL, (e) => e.createdAt);
    sweepExpired(this.remotePartyUsers, now, PARTY_TTL, (u) => u.connectedAt);
  }

  /** Drop every routing entry — called from hub.close(). */
  clear(): void {
    this.activeRelays.clear();
    this.protectRequests.clear();
    this.cmdRoutes.clear();
    this.remotePartyUsers.clear();
  }
}
