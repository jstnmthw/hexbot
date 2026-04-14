// HexBot — Bot Link shared command-execution glue.
//
// Extracted from `protocol.ts` so framing concerns stay separate from the
// command-handler plumbing. Used by both hub (when executing a CMD frame
// locally) and leaf (when a CMD frame routed via the hub targets this bot).
import type { CommandContext } from '../../command-handler';
import type { CommandRelay, LinkFrame, LinkPermissions } from './types.js';

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

  cmdHandler
    .execute(`.${command} ${args}`.trim(), ctx)
    .then(() => {
      sendResult(ref, output);
    })
    /* v8 ignore start -- .catch only fires if command handler throws */
    .catch((err) => {
      sendResult(ref, [`Error: ${err instanceof Error ? err.message : String(err)}`]);
    });
  /* v8 ignore stop */
}
