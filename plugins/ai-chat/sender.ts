// ai-chat — IRC send-side helpers
//
// Wraps the drip-feed send path from `assistant.ts` with the channel-gate
// re-check that has to run immediately before each line hits IRC. The gate
// lives in `index.ts` today (it reaches into ChanServ/channel state
// through the PluginAPI), so the wrapper takes it as an injected
// predicate rather than depending on index.ts directly — keeps this file
// reusable by future send paths and unit-testable in isolation.
//
// Why a per-line gate? `sendLines` uses `setTimeout` between lines, and
// ChanServ access can flip between ticks (services outage, ChanServ
// toggles access while the bot is mid-send). Re-checking per line is the
// last line of defence: a pipeline that passed the pre-send gate still
// loses remaining lines if the bot is demoted mid-batch.
import { sendLines } from './assistant';

/**
 * Predicate that returns `true` when the channel/cfg combination is
 * currently post-gated and the line must be dropped. `reason` is a short
 * tag included in the warn log the implementer emits on first drop (only
 * once per gated send, to avoid flooding).
 */
export type PostGateCheck = (reason: string) => boolean;

/**
 * Wrap a plain line-sender with a post-gate that fires at most once per
 * send (latches `dropped = true` on first rejection). Matches the
 * previous `gatedSender` behavior in index.ts; lifted so the send-side
 * plumbing stays in one file.
 */
export function gatedSender(
  postGate: PostGateCheck,
  reason: string,
  send: (line: string) => void,
): (line: string) => void {
  let dropped = false;
  return (line) => {
    if (dropped) return;
    if (postGate(reason)) {
      dropped = true;
      return;
    }
    send(line);
  };
}

/**
 * Convenience wrapper: gate + drip-feed send. Exists so the three pipeline
 * call sites stop repeating the same three-line pattern
 *   const g = gatedSender(...);
 *   await sendLines(lines, g, delayMs);
 * and instead state their intent directly. Returns the same Promise as
 * `sendLines`.
 */
export function sendLinesGated(
  lines: string[],
  postGate: PostGateCheck,
  reason: string,
  send: (line: string) => void,
  interLineDelayMs: number,
): Promise<void> {
  return sendLines(lines, gatedSender(postGate, reason, send), interLineDelayMs);
}
