// HexBot — Bot Link shared command-execution glue.
//
// Extracted from `protocol.ts` so framing concerns stay separate from the
// command-handler plumbing. Used by both hub (when executing a CMD frame
// locally) and leaf (when a CMD frame routed via the hub targets this bot).
import type { CommandContext } from '../../command-handler';
import type { CommandRelay, LinkFrame, LinkPermissions } from './types.js';

/**
 * Executor-side deadline for a relayed command handler. Matches the
 * requester's 10s ceiling (`CMD_TIMEOUT_MS` in hub.ts / leaf.ts): by the
 * time this fires the requesting side has already given up, so the only
 * job left is to release the frame/output/ctx closures a never-settling
 * handler would otherwise retain forever.
 */
export const CMD_EXEC_TIMEOUT_MS = 10_000;

/**
 * Execute an incoming CMD frame and return the output via a callback.
 * Shared between BotLinkHub.handleCmdRelay and BotLinkLeaf.handleIncomingCmd
 * to avoid duplicating the parse->lookup->check->execute->respond pattern.
 */
export function executeCmdFrame(
  frame: LinkFrame,
  cmdHandler: CommandRelay,
  permissions: LinkPermissions,
  sendResult: (ref: string, output: string[]) => void,
): void {
  const handle = String(frame.fromHandle ?? '');
  const ref = String(frame.ref ?? '');
  const command = String(frame.command ?? '');
  const args = String(frame.args ?? '');
  // Preserve a wire-side `null` distinctly from "channel field omitted":
  // both flow through to the handler ctx as `null`, but `String(null)`
  // would otherwise coerce to the literal "null" and look like a real
  // channel name to the permissions layer.
  const channel =
    frame.channel !== null && frame.channel !== undefined ? String(frame.channel) : null;

  const entry = cmdHandler.getCommand(command);
  if (!entry) {
    sendResult(ref, [`Unknown command: .${command}`]);
    return;
  }

  if (!permissions.checkFlagsByHandle(entry.options.flags, handle, channel)) {
    sendResult(ref, ['Permission denied.']);
    return;
  }

  const output: string[] = [];
  const ctx: CommandContext = {
    source: 'botlink',
    nick: handle,
    ident: 'botlink',
    hostname: 'botlink',
    channel,
    reply: (msg: string) => {
      for (const line of msg.split('\n')) {
        output.push(line);
      }
    },
  };

  // Race the handler against a deadline so a never-settling handler (e.g.
  // a plugin awaiting an outbound fetch with no timeout) can't retain the
  // frame/output/ctx/sendResult closure set forever. `finished` guards
  // sendResult to at-most-once: a handler settling after the deadline must
  // become a no-op, not a second CMD_RESULT.
  let finished = false;
  const finishOnce = (lines: string[]): void => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    sendResult(ref, lines);
  };
  const deadline = setTimeout(() => {
    finishOnce(['Command timed out.']);
  }, CMD_EXEC_TIMEOUT_MS);

  cmdHandler
    .execute(`.${command} ${args}`.trim(), ctx)
    .then(() => {
      finishOnce(output);
    })
    .catch((err) => {
      finishOnce([`Error: ${err instanceof Error ? err.message : String(err)}`]);
    });
}
