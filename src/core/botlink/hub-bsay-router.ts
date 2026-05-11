// HexBot — Bot Link BSAY routing
//
// Extracted from `hub.ts`. BSAY carries an IRC message that should be
// delivered by one or more bots; this handler decides whether to broadcast,
// dispatch locally, forward to a single leaf, or drop.
import type { LoggerLike } from '../../logger';
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
  /**
   * Re-check that `handle` has `flags` on `channel` (null = global).
   * The hub calls this before fanout so a compromised leaf cannot craft
   * a raw BSAY under another user's authority. Null means the hub has
   * not yet wired its permissions adapter — fail closed in that case.
   */
  checkFlags: ((handle: string, flags: string, channel: string | null) => boolean) | null;
  /** Optional logger for `[security]` rejection lines. */
  logger?: LoggerLike | null;
}

/**
 * Route a BSAY frame: broadcast, deliver locally, forward to a single
 * leaf, or drop. Re-verifies `+m` on the claimed sender handle before any
 * fanout — a compromised leaf can assemble a raw BSAY frame and bypass
 * the originating-leaf flag check otherwise.
 */
export function handleBsay(ctx: HubBsayContext, fromBot: string, frame: LinkFrame): void {
  const target = String(frame.target ?? '');
  const message = String(frame.message ?? '');
  const toBot = String(frame.toBot ?? '*');
  const fromHandle = typeof frame.fromHandle === 'string' ? frame.fromHandle : '';

  if (!fromHandle) {
    ctx.logger?.warn(
      `[security] BSAY from "${fromBot}" missing fromHandle — dropping (target=${target})`,
    );
    return;
  }

  // Channel-scoped `+m` when the BSAY target is a channel, global `+m`
  // when it is a PM nick. startsWith('#') or '&' catches the two common
  // channel prefixes on the networks we target.
  const isChannel = target.startsWith('#') || target.startsWith('&');
  const channel = isChannel ? target : null;

  if (!ctx.checkFlags || !ctx.checkFlags(fromHandle, 'm', channel)) {
    ctx.logger?.warn(
      `[security] BSAY from "${fromBot}" rejected: handle="${fromHandle}" lacks +m on ${
        channel ?? '(global)'
      } (target=${target})`,
    );
    return;
  }

  if (toBot === '*') {
    ctx.broadcast(frame, fromBot);
    ctx.deliverLocal?.(target, message);
  } else if (toBot === ctx.botname) {
    ctx.deliverLocal?.(target, message);
  } else if (ctx.hasLeaf(toBot)) {
    ctx.send(toBot, frame);
  }
}
