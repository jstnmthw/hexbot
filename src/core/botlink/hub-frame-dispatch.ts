// HexBot — Bot Link steady-state frame dispatch
//
// Registry mapping each steady-state `FrameType` to a handler function.
// Extracted from the 98-line switch that lived inside
// `BotLinkHub.onSteadyState` so adding a new frame type is a one-line
// registry edit rather than a hunt into the hub's internals.
//
// Rules of this file:
//  - Handlers return `true` if they fully handled the frame and no further
//    dispatch should run; they return `false` to let the caller fall
//    through to relay routing + the external `onLeafFrame` notification.
//  - Heartbeat (PING/PONG) and the three rate-limit gates are applied by
//    `dispatchSteadyStateFrame` before the registry is consulted — they
//    short-circuit on pathological input, not on legitimate frame types.
//  - Handlers only touch hub state through the explicit
//    {@link HubFrameDispatchContext} facade. This keeps the frame registry
//    independent of hub private fields, so hub internals can evolve
//    without touching the dispatch table.
import { FrameType } from './frame-types.js';
import { handleBsay } from './hub-bsay-router.js';
import { handleCmdRelay } from './hub-cmd-relay.js';
import type { PendingRequestMap } from './pending';
import { HUB_ONLY_FRAMES } from './protocol';
import type { RateCounter } from './rate-counter.js';
import type { BotLinkRelayRouter } from './relay-router';
import type { CommandRelay, LinkFrame, LinkPermissions } from './types.js';

/**
 * Per-leaf connection state the dispatcher needs. Mirrors the shape held
 * by `BotLinkHub.leaves` but typed here so the dispatch module doesn't
 * need to import from `hub.ts` (which would create a cycle).
 */
export interface LeafLike {
  botname: string;
  send: (frame: LinkFrame) => boolean;
  cmdRate: RateCounter;
  partyRate: RateCounter;
  protectRate: RateCounter;
  bsayRate: RateCounter;
  announceRate: RateCounter;
  relayInputRate: RateCounter;
  relayOutputRate: RateCounter;
  partyJoinRate: RateCounter;
  partyPartRate: RateCounter;
  /** Called on first BSAY drop in a window — latched by the hub so a
   *  flood produces one warning line instead of N. */
  noteBsayDrop: () => void;
}

/**
 * Facade over the hub's state the dispatcher needs. Kept intentionally
 * narrow: new frame handlers should not widen this without a design
 * conversation — the point of the split is that the dispatch module
 * doesn't reach into hub internals.
 */
export interface HubFrameDispatchContext {
  /** Local bot's own name. Used by bsay / cmd-relay routing. */
  botname: string;
  /** Relay routing state owner (shared with the hub). */
  routes: BotLinkRelayRouter;
  /** Pending commands the hub itself sent (from `.bot`). */
  pendingCmds: PendingRequestMap<string[]>;
  /** Wired command relay (null until `setCommandRelay` runs). */
  cmdHandler: CommandRelay | null;
  /** Wired permissions adapter (null until `setCommandRelay` runs). */
  cmdPermissions: LinkPermissions | null;
  /** Send a frame to a specific connected leaf. */
  send: (botname: string, frame: LinkFrame) => boolean;
  /** Broadcast a frame to all leaves, optionally excluding one. */
  broadcast: (frame: LinkFrame, excludeBot?: string) => void;
  /** Is `botname` currently connected as a leaf? */
  hasLeaf: (botname: string) => boolean;
  /** External notification callback (null if no consumer wired it up). */
  onLeafFrame: ((botname: string, frame: LinkFrame) => void) | null;
  /** Local BSAY sink (null if no consumer wired it up). */
  onBsay: ((target: string, message: string) => void) | null;
  /**
   * Re-check that `handle` has `flags` on `channel` (null = global) — used
   * by BSAY fanout to validate the claimed sender handle after it arrives
   * across the link. Null until the hub wires its permissions adapter.
   */
  checkFlags: ((handle: string, flags: string, channel: string | null) => boolean) | null;
  /** Optional logger plumbed through from the hub for `[security]` lines. */
  logger: import('../../logger').LoggerLike | null;
}

/**
 * A single frame handler. Return `true` to stop further dispatch (the
 * frame has been fully consumed); `false` to let the caller fall through
 * to relay routing and `onLeafFrame` notification.
 */
export type FrameHandler = (
  ctx: HubFrameDispatchContext,
  leaf: LeafLike,
  frame: LinkFrame,
) => boolean;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const handleCmdResult: FrameHandler = (ctx, _leaf, frame) => {
  const ref = String(frame.ref ?? '');
  const output = Array.isArray(frame.output)
    ? frame.output.filter((s): s is string => typeof s === 'string')
    : [];
  if (ctx.pendingCmds.resolve(ref, output)) return true;
  const originBot = ctx.routes.popCmdRoute(ref);
  if (originBot) {
    ctx.send(originBot, frame);
    return true;
  }
  return false;
};

const handleCmd: FrameHandler = (ctx, leaf, frame) => {
  if (ctx.cmdHandler) {
    handleCmdRelay(
      {
        botname: ctx.botname,
        cmdHandler: ctx.cmdHandler,
        cmdPermissions: ctx.cmdPermissions,
        routes: ctx.routes,
        send: ctx.send,
        hasLeaf: ctx.hasLeaf,
      },
      leaf.botname,
      frame,
    );
  }
  return false;
};

const handleBsayFrame: FrameHandler = (ctx, leaf, frame) => {
  handleBsay(
    {
      botname: ctx.botname,
      send: ctx.send,
      broadcast: ctx.broadcast,
      hasLeaf: ctx.hasLeaf,
      deliverLocal: ctx.onBsay,
      checkFlags: ctx.checkFlags,
      logger: ctx.logger,
    },
    leaf.botname,
    frame,
  );
  return false;
};

const handlePartyJoin: FrameHandler = (ctx, leaf, frame) => {
  ctx.routes.trackPartyJoin(leaf.botname, frame);
  return false;
};

const handlePartyPart: FrameHandler = (ctx, _leaf, frame) => {
  ctx.routes.trackPartyPart(frame);
  return false;
};

const handlePartyWhom: FrameHandler = (ctx, leaf, frame) => {
  ctx.routes.handlePartyWhom(leaf.botname, String(frame.ref ?? ''));
  return false;
};

const handleProtectAck: FrameHandler = (ctx, _leaf, frame) => {
  ctx.routes.handleProtectAck(frame);
  return false;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Frame-type -> handler map. Only frames that need type-specific logic
 * appear here; PROTECT_* requests (non-ACK) and RELAY_* frames are handled
 * by the fallback logic in {@link dispatchSteadyStateFrame}.
 */
const FRAME_HANDLERS: Record<string, FrameHandler> = {
  [FrameType.CMD_RESULT]: handleCmdResult,
  [FrameType.CMD]: handleCmd,
  [FrameType.BSAY]: handleBsayFrame,
  [FrameType.PARTY_JOIN]: handlePartyJoin,
  [FrameType.PARTY_PART]: handlePartyPart,
  [FrameType.PARTY_WHOM]: handlePartyWhom,
  [FrameType.PROTECT_ACK]: handleProtectAck,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply the full steady-state dispatch pipeline to a single frame. Mirrors
 * the old {@link BotLinkHub.onSteadyState} body exactly — any behavior
 * change here is a visible test diff. Returns nothing; all side effects
 * flow through `ctx`.
 */
export function dispatchSteadyStateFrame(
  ctx: HubFrameDispatchContext,
  leaf: LeafLike,
  frame: LinkFrame,
): void {
  // Heartbeat — handled before rate limits and registry lookup.
  if (frame.type === FrameType.PONG) return;
  if (frame.type === FrameType.PING) {
    leaf.send({ type: FrameType.PONG, seq: frame.seq });
    return;
  }

  // Rate limiting — per-frame gates. CMD is the only gate that talks
  // back (pending-reply semantics); everything else silently drops to
  // avoid leaking the ceiling to a misbehaving or compromised leaf.
  if (frame.type === FrameType.CMD && !leaf.cmdRate.check()) {
    leaf.send({
      type: FrameType.ERROR,
      code: 'RATE_LIMITED',
      message: 'CMD rate limit exceeded',
    });
    return;
  }
  if (frame.type === FrameType.PARTY_CHAT && !leaf.partyRate.check()) {
    return; // Silently drop
  }
  if (frame.type.startsWith('PROTECT_') && frame.type !== FrameType.PROTECT_ACK) {
    if (!leaf.protectRate.check()) return; // Silently drop
  }
  if (frame.type === FrameType.BSAY && !leaf.bsayRate.check()) {
    leaf.noteBsayDrop();
    return;
  }
  if (frame.type === FrameType.ANNOUNCE && !leaf.announceRate.check()) {
    return;
  }
  if (frame.type === FrameType.RELAY_INPUT && !leaf.relayInputRate.check()) {
    return;
  }
  if (frame.type === FrameType.RELAY_OUTPUT && !leaf.relayOutputRate.check()) {
    return;
  }
  if (frame.type === FrameType.PARTY_JOIN && !leaf.partyJoinRate.check()) {
    return;
  }
  if (frame.type === FrameType.PARTY_PART && !leaf.partyPartRate.check()) {
    return;
  }

  // Fan-out to other leaves (unless hub-only).
  if (!HUB_ONLY_FRAMES.has(frame.type)) {
    ctx.broadcast(frame, leaf.botname);
  }

  // Dispatch by frame type via registry.
  const handler = FRAME_HANDLERS[frame.type];
  if (handler) {
    if (handler(ctx, leaf, frame)) return;
  } else if (frame.type.startsWith('PROTECT_')) {
    // PROTECT_* requests (not ACK — ACK has its own handler). Use raw
    // startsWith since we don't enumerate each PROTECT_* variant in the
    // registry.
    if (frame.ref) ctx.routes.trackProtectRequest(String(frame.ref), leaf.botname);
  }

  // Relay routing applies to all RELAY_* frames. routeRelayFrame is
  // authoritative: it delivers locally via deliverLocal → onLeafFrame when
  // the hub itself is the relay origin/target, so skip the generic
  // notification below to avoid double-dispatching the same frame.
  if (frame.type.startsWith('RELAY_')) {
    ctx.routes.routeRelayFrame(leaf.botname, frame);
    return;
  }

  // Notify external handler.
  ctx.onLeafFrame?.(leaf.botname, frame);
}
