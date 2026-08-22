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
import type { LoggerLike } from '../../logger';
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
  /** Optional logger for `[security]` rejection lines. */
  logger?: LoggerLike | null;
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

    // Hub-authoritative authorization BEFORE forwarding to a sibling leaf.
    // The frame's `fromHandle` is attacker-controlled on a compromised leaf;
    // forwarding it verbatim previously let a hostile leaf run any synced
    // handle's privileged commands on a sibling — the CMD analog of the
    // BSAY forgery the hub already re-checks against (hub-bsay-router.ts).
    // Re-check the relayed command's required flags against the hub's own
    // authoritative permission DB (exactly as executeCmdFrame does on the
    // hub-local path), refuse unknown or unauthorized commands, and fail
    // closed when the permissions adapter is not yet wired. See SECURITY.md
    // §11. This does not require `hasRemoteSession`: a `+m` operator issuing
    // `.bot <leaf> <cmd>` from pub/msg has no DCC party session, so that
    // gate (correct for the hub-local / RELAY paths) cannot apply here.
    const command = String(frame.command ?? '');
    const channel =
      frame.channel !== null && frame.channel !== undefined ? String(frame.channel) : null;
    const entry = cmdHandler.getCommand(command);
    if (!entry) {
      ctx.send(fromBot, { type: 'CMD_RESULT', ref, output: [`Unknown command: .${command}`] });
      return;
    }
    if (!cmdPermissions.checkFlagsByHandle(entry.options.flags, handle, channel)) {
      ctx.logger?.warn(
        `[security] cross-leaf CMD from "${fromBot}" rejected: handle="${handle}" lacks ${entry.options.flags} for .${command} on ${channel ?? '(global)'} -> ${toBot}`,
      );
      ctx.send(fromBot, { type: 'CMD_RESULT', ref, output: ['Permission denied.'] });
      return;
    }

    // Record `toBot` as the expected responder so only that leaf's CMD_RESULT
    // can be routed back to `fromBot` — a different leaf can't forge the reply.
    ctx.routes.trackCmdRoute(ref, fromBot, toBot);
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
