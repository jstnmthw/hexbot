// HexBot — Bot Link BSAY routing
//
// Extracted from `hub.ts` per the 2026-04-19 quality audit. BSAY carries an
// IRC message that should be delivered by one or more bots; this handler
// decides whether to broadcast, dispatch locally, forward to a single leaf,
// or drop.
import type { LinkFrame } from './types.js';

/** Narrow facade over the hub's state used by {@link handleBsay}. */
export interface HubBsayContext {
  /** Local bot's own name — a frame whose `toBot` equals this delivers here. */
  botname: string;
  /** Send a frame to a specific connected leaf. */
  send: (botname: string, frame: LinkFrame) => boolean;
  /** Broadcast a frame to all leaves, optionally excluding one. */
  broadcast: (frame: LinkFrame, excludeBot?: string) => void;
  /** Is `botname` currently connected as a leaf? */
  hasLeaf: (botname: string) => boolean;
  /**
   * Deliver a BSAY payload to the local IRC layer. Matches the hub's
   * `onBsay` callback; may be null before the bot wires it up.
   */
  deliverLocal: ((target: string, message: string) => void) | null;
}

/**
 * Route a BSAY frame: broadcast, deliver locally, forward to a single
 * leaf, or drop. Mirrors the old `BotLinkHub.handleBsay` exactly.
 */
export function handleBsay(ctx: HubBsayContext, fromBot: string, frame: LinkFrame): void {
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
    ctx.broadcast(frame, fromBot);
    ctx.deliverLocal?.(target, message);
  } else if (toBot === ctx.botname) {
    ctx.deliverLocal?.(target, message);
  } else if (ctx.hasLeaf(toBot)) {
    ctx.send(toBot, frame);
  }
}
