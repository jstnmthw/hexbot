// HexBot — Small shared helpers for core command handlers.
//
// These exist to stamp out patterns that appeared three or more times across
// `src/core/commands/*` (see audit 2026-04-14, Phase M2). Each helper is a
// few lines but extracting them keeps the command files focused on intent
// rather than argument-parsing boilerplate.
import type { CommandContext } from '../command-handler';
import type { BotDatabase, LogModActionOptions } from '../database';
import { tryAudit } from './audit';

/**
 * Derive the `source` string used when writing a `mod_log` row for a
 * permission mutation. REPL has no nick, so we substitute the literal
 * `'REPL'` marker; every other transport uses the triggering nick.
 *
 * This is distinct from `auditActor(ctx)` — that helper populates the
 * {@link ModActor} `by`/`source` pair on mutating `IRCCommands` methods.
 * `getAuditSource()` returns the legacy string passed to
 * `Permissions.addUser`/`removeUser`/`setChannelFlags` which predates the
 * ModActor plumbing. Both helpers must stay in step; if you find yourself
 * migrating a legacy `permissions.*` call to the new ModActor pathway,
 * replace `getAuditSource(ctx)` with `auditActor(ctx)` at the same time.
 */
export function getAuditSource(ctx: CommandContext): string {
  return ctx.source === 'repl' ? 'REPL' : ctx.nick;
}

/**
 * Split an args string on whitespace, discard empty tokens, and enforce a
 * minimum arity. When the result has fewer than `minParts` tokens, emits
 * `usage` to `ctx.reply()` and returns `null` so the caller can `return`
 * without repeating the reply line.
 *
 * Not every command can use this — some strip control characters before
 * splitting, some delegate to `parseTargetMessage`, some need a bespoke
 * split rule — but it collapses the most common "split + arity + usage"
 * pattern used across the command modules.
 */
export function parseCommandArgs(
  args: string,
  minParts: number,
  usage: string,
  ctx: CommandContext,
): string[] | null {
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length < minParts) {
    ctx.reply(usage);
    return null;
  }
  return parts;
}

/**
 * Parse the common `<#channel> <mask>` shape used by ban/unban/stick/unstick
 * and return the trimmed parts plus any trailing tokens. Returns `null` when
 * either the channel or mask is missing so the caller can emit its usage
 * reply. Does not validate mask length or content — that's caller policy.
 */
export function parseBanArgs(
  args: string,
): { channel: string; mask: string; rest: string[] } | null {
  const parts = args.trim().split(/\s+/);
  const channel = parts[0];
  const mask = parts[1];
  if (!channel || !channel.startsWith('#') || !mask) return null;
  return { channel, mask, rest: parts.slice(2) };
}

/**
 * Validate a single-token `<#channel>` argument. Returns the trimmed
 * channel on success or `null` if the arg is missing or doesn't match
 * the defense-in-depth shape from SECURITY.md §2.2. Used by `.join`,
 * `.part`, `.invite`, and anywhere else a channel is the sole required
 * argument.
 *
 * The regex accepts `&` in addition to `#` (RFC 1459 &-channels still
 * exist on legacy networks), a leading channel char, then 1–49 of the
 * permitted RFC nick / channel byte set. Rejects whitespace, `,`, `:`
 * (IRC trailing-arg sentinel), and control bytes outright.
 */
const CHANNEL_SHAPE_RE = /^[#&][\w\-[\]\\`^{}]{1,49}$/;
export function validateChannel(arg: string): string | null {
  const channel = arg.trim();
  if (!channel) return null;
  if (!CHANNEL_SHAPE_RE.test(channel)) return null;
  return channel;
}

/**
 * Emit a user-facing "Failed to <verb> <name>" reply and audit the failure
 * in one call. Collapses the repeated `ctx.reply(...) + tryAudit(...)`
 * pairs in `plugin-commands.ts` load/unload/reload error branches.
 *
 * The audit row always carries `outcome: 'failure'` and `reason: error` so
 * the caller never has to spell those out — they're the defining features
 * of the pattern.
 */
export function replyFailure(
  db: BotDatabase | null,
  ctx: CommandContext,
  verb: string,
  name: string,
  error: string,
  action: LogModActionOptions['action'],
): void {
  ctx.reply(`Failed to ${verb} "${name}": ${error}`);
  tryAudit(db, ctx, {
    action,
    target: name,
    outcome: 'failure',
    reason: error,
  });
}
