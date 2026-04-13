// HexBot — DCC console flag commands
// Registers the `.console` dot-command for managing per-session DCC log
// subscription flags. Eggdrop-style `+mojkpbsdw` letters are parsed and
// persisted per handle via the manager's ConsoleFlagStore.
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { DCCManager, DCCSessionEntry } from '../dcc';
import {
  CONSOLE_FLAG_DESCRIPTIONS,
  CONSOLE_FLAG_LETTERS,
  DEFAULT_CONSOLE_FLAGS,
  formatFlags,
  parseCanonicalFlags,
  parseFlagsMutation,
} from '../dcc-console-flags';

/**
 * Register the `.console` command on the given command handler. The
 * command is DCC-only — REPL and IRC callers receive a clear error.
 */
export function registerDccConsoleCommands(handler: CommandHandler, dccManager: DCCManager): void {
  handler.registerCommand(
    'console',
    {
      flags: '+m',
      description: 'View or modify per-session DCC console flags',
      usage: '.console [+flags|-flags] | .console <handle> +flags',
      category: 'dcc',
    },
    (args, ctx) => {
      handleConsoleCommand(args, ctx, dccManager);
    },
  );
}

function handleConsoleCommand(args: string, ctx: CommandContext, dccManager: DCCManager): void {
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
    mutateOwnFlags(trimmed, ctx, ctx.dccSession);
    return;
  }

  mutateOtherHandleFlags(trimmed, ctx, dccManager);
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

function mutateOwnFlags(input: string, ctx: CommandContext, session: DCCSessionEntry): void {
  const current = parseCanonicalFlags(session.getConsoleFlags());
  const result = parseFlagsMutation(input, current);
  if ('error' in result) {
    ctx.reply(result.error);
    return;
  }
  session.setConsoleFlags(result.flags);
  const canonical = formatFlags(result.flags);
  ctx.reply(`Console flags: ${canonical.length > 0 ? `+${canonical}` : '+-'}`);
}

function mutateOtherHandleFlags(input: string, ctx: CommandContext, dccManager: DCCManager): void {
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

  if (!ctx.dccSession || !ctx.dccSession.handleFlags.includes('n')) {
    ctx.reply('Only owners (+n) can set console flags for another handle.');
    return;
  }

  const store = dccManager.getConsoleFlagStore();
  const current = parseCanonicalFlags(store.get(handle) ?? DEFAULT_CONSOLE_FLAGS);
  const result = parseFlagsMutation(mutation, current);
  if ('error' in result) {
    ctx.reply(result.error);
    return;
  }
  const canonical = formatFlags(result.flags);
  store.set(handle, canonical);
  ctx.reply(`Console flags for ${handle}: ${canonical.length > 0 ? `+${canonical}` : '+-'}`);
}
