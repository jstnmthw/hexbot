// HexBot — DCC console flag commands
// Registers the `.console` dot-command for managing per-session DCC log
// subscription flags. Flags `+mojkpbsdw` letters are parsed and
// persisted per handle via the manager's ConsoleFlagStore.
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { tryAudit } from '../audit';
import {
  CONSOLE_FLAG_DESCRIPTIONS,
  CONSOLE_FLAG_LETTERS,
  type DCCManager,
  type DCCSessionEntry,
  DEFAULT_CONSOLE_FLAGS,
  formatFlags,
  parseCanonicalFlags,
  parseFlagsMutation,
} from '../dcc';

/**
 * Minimal read surface a live permissions lookup needs to expose for the
 * cross-handle `.console` gate. `getUser` returns the authoritative
 * {@link UserRecord}; we call it on every cross-handle mutation so a `+n`
 * revoked mid-session takes effect immediately rather than on next login.
 */
export interface ConsolePermissionsProvider {
  getUser(handle: string): { global: string } | null;
}

export interface DccConsoleCommandsDeps {
  handler: CommandHandler;
  dccManager: DCCManager;
  db: BotDatabase | null;
  permissions: ConsolePermissionsProvider;
}

/**
 * Register the `.console` command on the given command handler. The
 * command is DCC-only — REPL and IRC callers receive a clear error.
 *
 * `db` is used to record `console-set` rows when a handle's console flag
 * subscription changes — this is privacy-relevant since the flags decide
 * which log streams a DCC session sees, and cross-handle edits give an
 * owner the ability to silently pipe another user's traffic into their
 * own console.
 */
export function registerDccConsoleCommands(deps: DccConsoleCommandsDeps): void {
  const { handler, dccManager, db, permissions } = deps;
  handler.registerCommand(
    'console',
    {
      flags: '+m',
      description: 'View or modify per-session DCC console flags',
      usage: '.console [+flags|-flags] | .console <handle> +flags',
      category: 'dcc',
    },
    (args, ctx) => {
      handleConsoleCommand(args, ctx, dccManager, db, permissions);
    },
  );
}

function handleConsoleCommand(
  args: string,
  ctx: CommandContext,
  dccManager: DCCManager,
  db: BotDatabase | null,
  permissions: ConsolePermissionsProvider,
): void {
  if (!ctx.dccSession) {
    ctx.reply('This command is DCC-only.');
    return;
  }

  const trimmed = args.trim();

  if (trimmed === '') {
    replyWithCurrentFlags(ctx, ctx.dccSession);
    return;
  }

  // Distinguish `.console <handle> +flags` from `.console +flags`. A
  // leading `+` or `-` means "mutate my own flags"; anything else is
  // interpreted as a target handle followed by the mutation tokens.
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    mutateOwnFlags(trimmed, ctx, ctx.dccSession, db);
    return;
  }

  mutateOtherHandleFlags(trimmed, ctx, dccManager, db, permissions);
}

function recordConsoleAudit(
  db: BotDatabase | null,
  ctx: CommandContext,
  target: string,
  before: string,
  after: string,
): void {
  // Action-specific wrapper kept because the metadata shape (before/after
  // flag strings) is identical across both the own-flag and cross-handle
  // paths — folding it inline would duplicate the formatter.
  tryAudit(db, ctx, {
    action: 'console-set',
    target,
    reason: `+${after || '-'}`,
    metadata: { before: `+${before || '-'}`, after: `+${after || '-'}` },
  });
}

function replyWithCurrentFlags(ctx: CommandContext, session: DCCSessionEntry): void {
  const flags = session.getConsoleFlags();
  const shown = flags.length > 0 ? `+${flags}` : '+-';
  ctx.reply(`Console flags: ${shown}`);
  ctx.reply('Categories:');
  for (const letter of CONSOLE_FLAG_LETTERS) {
    const marker = flags.includes(letter) ? '*' : ' ';
    ctx.reply(`  ${marker} ${letter}  ${CONSOLE_FLAG_DESCRIPTIONS[letter]}`);
  }
  ctx.reply(`Default: +${DEFAULT_CONSOLE_FLAGS}. Use .console +x / -x to toggle.`);
}

/**
 * Apply a `+flags`/`-flags` mutation to a stored flag string and return the
 * before/after canonical forms, or an error message if the mutation didn't
 * parse. Shared by both the own-flag and cross-handle paths so canonical
 * formatting is computed in exactly one place.
 */
function applyFlagMutation(
  stored: string,
  mutation: string,
):
  | { before: string; after: string; flags: Set<import('../dcc').ConsoleFlagLetter> }
  | { error: string } {
  const current = parseCanonicalFlags(stored);
  const before = formatFlags(current);
  const result = parseFlagsMutation(mutation, current);
  if ('error' in result) return { error: result.error };
  return { before, after: formatFlags(result.flags), flags: result.flags };
}

function mutateOwnFlags(
  input: string,
  ctx: CommandContext,
  session: DCCSessionEntry,
  db: BotDatabase | null,
): void {
  const result = applyFlagMutation(session.getConsoleFlags(), input);
  if ('error' in result) {
    ctx.reply(result.error);
    return;
  }
  session.setConsoleFlags(result.flags);
  ctx.reply(`Console flags: ${result.after.length > 0 ? `+${result.after}` : '+-'}`);
  recordConsoleAudit(db, ctx, session.handle, result.before, result.after);
}

function mutateOtherHandleFlags(
  input: string,
  ctx: CommandContext,
  dccManager: DCCManager,
  db: BotDatabase | null,
  permissions: ConsolePermissionsProvider,
): void {
  // Split off the first token as the target handle; the rest is the
  // mutation body. The permission flag on registerCommand already
  // required `+m`; extend to require `+n` (owner) for cross-handle
  // edits by checking here, since the same command supports both forms.
  const [handle, ...rest] = input.split(/\s+/);
  const mutation = rest.join(' ').trim();
  if (!mutation) {
    ctx.reply('Usage: .console <handle> +flags');
    return;
  }

  if (!ctx.dccSession) {
    ctx.reply('This command is DCC-only.');
    return;
  }
  // Re-resolve the caller's flags from the live permissions store instead
  // of trusting the session-opened `handleFlags` snapshot. A `+n` revoked
  // mid-session would otherwise keep passing the gate until the session
  // closes — giving an owner-since-demoted user time to silently rewire
  // another handle's console subscriptions.
  const liveCaller = permissions.getUser(ctx.dccSession.handle);
  if (!liveCaller || !liveCaller.global.includes('n')) {
    ctx.reply('Only owners (+n) can set console flags for another handle.');
    return;
  }

  const store = dccManager.getConsoleFlagStore();
  const stored = store.get(handle) ?? DEFAULT_CONSOLE_FLAGS;
  const result = applyFlagMutation(stored, mutation);
  if ('error' in result) {
    ctx.reply(result.error);
    return;
  }
  store.set(handle, result.after);
  ctx.reply(`Console flags for ${handle}: ${result.after.length > 0 ? `+${result.after}` : '+-'}`);
  recordConsoleAudit(db, ctx, handle, result.before, result.after);
}
