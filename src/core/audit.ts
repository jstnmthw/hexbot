// HexBot — Audit actor helpers
// The enforcement point for mod_log attribution. Every core command handler
// should use `auditActor(ctx)` to derive the `{ by, source }` passed into
// `db.logModAction` and `IRCCommands` mutating methods, so reviewers can grep
// for raw `logModAction(` calls that bypass it.
import type { CommandContext } from '../command-handler';
import type { BotDatabase, LogModActionOptions, ModLogSource } from '../database';

/** Minimal logger surface used by the wrapper — only `warn` is required. */
interface AuditLogger {
  warn(...args: unknown[]): void;
}

/**
 * Who caused a mod_log row and through what transport. Threaded through
 * every mutating `IRCCommands` method and used as the `{ by, source, plugin }`
 * payload on `db.logModAction`.
 *
 * `plugin` is required when `source === 'plugin'` and forbidden otherwise —
 * the database writer enforces this invariant, but the type keeps it optional
 * so core sites don't need to deal with it.
 */
export interface ModActor {
  by: string;
  source: ModLogSource;
  plugin?: string;
}

/**
 * Derive a {@link ModActor} from a command context. `CommandContext.source`
 * is a strict subset of {@link ModLogSource}, so the mapping is direct — no
 * fallback logic needed. Use this instead of hand-rolling `{ by: ctx.nick,
 * source: ... }` so an audit review can grep for the helper as the single
 * call-site-to-actor translation.
 *
 * @example
 * handler.registerCommand('op', opts, (args, ctx) => {
 *   const [channel, nick] = args.split(/\s+/);
 *   // Pass ctx-derived actor to IRCCommands so mod_log gets `by`/`source` populated
 *   // automatically — no hand-rolled `{ by: ctx.nick, source: ctx.source }` required.
 *   ircCommands.op(channel, nick, auditActor(ctx));
 * });
 */
export function auditActor(ctx: CommandContext): ModActor {
  return { by: ctx.nick, source: ctx.source };
}

/**
 * Merge a command context's actor into a {@link LogModActionOptions} so
 * call sites don't hand-assemble the source/by pair. Preferred over raw
 * `db.logModAction` calls in core command handlers — the audit-coverage
 * review can grep for `logModAction(` and flag any site that bypasses
 * either {@link auditActor} or this helper.
 */
export function auditOptions(
  ctx: CommandContext,
  options: Omit<LogModActionOptions, 'source' | 'by' | 'plugin'>,
): LogModActionOptions {
  return { ...options, source: ctx.source, by: ctx.nick };
}

/**
 * The "log to mod_log, never throw" idiom every audit site uses. Wraps the
 * insert in try/catch so a failed audit write never blocks the mutation
 * that already happened in memory. Optional `logger` records the failure
 * at warn — pass `null` for sites that should swallow silently.
 *
 * Use {@link tryAudit} when you have a {@link CommandContext}; reach for
 * this raw form only when the caller is a class method or background task
 * that already has fully-built `LogModActionOptions`.
 */
export function tryLogModAction(
  db: BotDatabase | null,
  options: LogModActionOptions,
  logger?: AuditLogger | null,
): void {
  if (!db) return;
  try {
    db.logModAction(options);
  } catch (err) {
    logger?.warn(`Failed to record mod_log entry for ${options.action}:`, err);
  }
}

/**
 * Sugar over {@link tryLogModAction} for command handlers: derives `source`
 * and `by` from `ctx` via {@link auditOptions}, then runs the same try/catch
 * write. This is the single helper every core command file should call —
 * any direct `db.logModAction(` outside this file is a smell worth flagging
 * in review.
 */
export function tryAudit(
  db: BotDatabase | null,
  ctx: CommandContext,
  options: Omit<LogModActionOptions, 'source' | 'by' | 'plugin'>,
  logger?: AuditLogger | null,
): void {
  tryLogModAction(db, auditOptions(ctx, options), logger);
}
