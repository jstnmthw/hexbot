// HexBot — Shared permission/transport guards for core command handlers.
//
// Command-side counterparts to `requireEnabled`/`requireHub`/`requireLeaf` in
// botlink-commands.ts — same shape (reply + early-return sentinel), lifted so
// other command groups can reuse them without reimplementing the
// `source`-check pattern. Keep this file small; each helper must be used by
// at least two call sites before it lives here.
import type { CommandContext } from '../../command-handler';

/** Transport tags understood by `CommandContext['source']`. */
export type TransportSource = CommandContext['source'];

/**
 * Transport allowlist check. Emits `message` to `ctx.reply()` and returns
 * `false` when `ctx.source` is not in `allowed`. Used by commands that
 * traffic in material that must not cross certain transports — passwords
 * over IRC PRIVMSG, DCC-only admin mutations, etc. Keep the message
 * specific to the command: a generic "not allowed here" is unhelpful.
 *
 * Callers that also want to write a `mod_log` row on rejection must do so
 * after this returns `false` — the helper intentionally stays quiet on the
 * audit path so each command can choose its own `reason`.
 */
export function requireTransport(
  ctx: CommandContext,
  allowed: readonly TransportSource[],
  message: string,
): boolean {
  if (!allowed.includes(ctx.source)) {
    ctx.reply(message);
    return false;
  }
  return true;
}
