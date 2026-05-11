// HexBot — Bot Link CMD relay handler
//
// Extracted from `hub.ts`. A single pure function that validates an
// incoming CMD frame against hub state (target bot connected? handle has
// an active remote session?) and either forwards, rejects, or executes
// it locally.
//
// The handler receives a small {@link HubCmdRelayContext} facade rather
// than the whole `BotLinkHub` — this keeps the hub's private fields
// private and documents exactly which pieces of hub state command relay
// actually needs.
import { executeCmdFrame } from './cmd-exec.js';
import type { BotLinkRelayRouter } from './relay-router';
import type { CommandRelay, LinkFrame, LinkPermissions } from './types.js';

/** Narrow facade over the hub's state used by {@link handleCmdRelay}. */
export interface HubCmdRelayContext {
  /** Local bot's own name — a frame addressed to this name runs locally. */
  botname: string;
  /** Wired command relay, or null if the hub has not been wired yet. */
  cmdHandler: CommandRelay | null;
  /** Wired permissions adapter, or null if the hub has not been wired yet. */
  cmdPermissions: LinkPermissions | null;
  /** Relay routing state (cmd route bookkeeping, remote session table). */
  routes: BotLinkRelayRouter;
  /** Send a frame to a specific connected leaf. */
  send: (botname: string, frame: LinkFrame) => boolean;
  /** Is `botname` currently connected as a leaf? */
  hasLeaf: (botname: string) => boolean;
}

/**
 * Handle an incoming CMD frame from a leaf. Mirrors the old
 * `BotLinkHub.handleCmdRelay` exactly — any behavior change here will
 * surface as a test diff.
 */
export function handleCmdRelay(ctx: HubCmdRelayContext, fromBot: string, frame: LinkFrame): void {
  const cmdHandler = ctx.cmdHandler;
  const cmdPermissions = ctx.cmdPermissions;
  /* v8 ignore next -- defensive: handleCmdRelay is only called after setHandler */
  if (!cmdHandler || !cmdPermissions) return;

  const handle = String(frame.fromHandle ?? '');
  const ref = String(frame.ref ?? '');

  // Route to a specific target bot if toBot is set and not this hub
  const toBot = frame.toBot != null ? String(frame.toBot) : null;
  if (toBot && toBot !== ctx.botname) {
    if (!ctx.hasLeaf(toBot)) {
      ctx.send(fromBot, {
        type: 'CMD_RESULT',
        ref,
        output: [`Bot "${toBot}" is not connected.`],
      });
      return;
    }
    ctx.routes.trackCmdRoute(ref, fromBot);
    ctx.send(toBot, frame);
    return;
  }

  // Verify the handle has an active DCC session on the sending leaf.
  // This prevents a compromised leaf from forging commands as arbitrary handles.
  if (!ctx.routes.hasRemoteSession(handle, fromBot)) {
    ctx.send(fromBot, {
      type: 'CMD_RESULT',
      ref,
      output: [`No active session for "${handle}" on ${fromBot}.`],
    });
    return;
  }

  executeCmdFrame(frame, cmdHandler, cmdPermissions, (cmdRef, output) => {
    ctx.send(fromBot, { type: 'CMD_RESULT', ref: cmdRef, output });
  });
}
