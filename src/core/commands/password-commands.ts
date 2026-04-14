// HexBot — Password management commands (.chpass)
//
// Implements `.chpass` for setting and rotating per-user DCC passwords.
// Allowed transports: REPL (implicit owner) and DCC (owner can rotate any
// user's password; anyone can rotate their own). IRC PRIVMSG is explicitly
// rejected to keep plaintext passwords off the wire.
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { tryAudit } from '../audit';
import { hashPassword } from '../password';
import type { Permissions } from '../permissions';

export interface PasswordCommandDeps {
  handler: CommandHandler;
  permissions: Permissions;
  /**
   * Database used to write `chpass` failure rows. The success path is
   * already logged by `Permissions.setPasswordHash`; the rejection path
   * (IRC transport, denied permission, validation failure, missing user)
   * was previously silent and is now mirrored into mod_log so password-
   * change attempts are queryable end-to-end.
   */
  db?: BotDatabase | null;
}

/**
 * Register `.chpass` on the given command handler.
 *
 * Syntax:
 *   `.chpass <handle> <newpass>` — rotate another user's password (owner only)
 *   `.chpass <newpass>`          — rotate your own password
 *
 * The command never relays to a hub: passwords are per-bot secrets. The
 * `relayToHub` flag is intentionally omitted so a leaf's `.chpass` stays local.
 * The mod_log row is written by {@link Permissions.setPasswordHash} so every
 * password rotation — regardless of caller — lands in the audit trail.
 */
export function registerPasswordCommands(deps: PasswordCommandDeps): void {
  const { handler, permissions, db = null } = deps;
  // Local sugar so each rejection branch stays a single line. Target may be
  // null when the failure occurs before the target handle is parsed.
  const failure = (ctx: CommandContext, reason: string, target: string | null = null): void => {
    tryAudit(db, ctx, {
      action: 'chpass',
      target,
      outcome: 'failure',
      reason,
    });
  };

  handler.registerCommand(
    'chpass',
    {
      // Permission is enforced inside the handler rather than via `flags`
      // because the policy differs by transport (REPL vs DCC) and by whether
      // the caller is rotating their own password or someone else's.
      flags: '-',
      description: 'Set or rotate a user password for DCC CHAT',
      usage: '.chpass <handle> <newpass> | .chpass <newpass>',
      category: 'permissions',
    },
    async (args, ctx) => {
      // Transport check — passwords must never travel over IRC PRIVMSG.
      if (ctx.source === 'irc') {
        ctx.reply(
          'chpass: passwords must not be sent over IRC. Use the bot console (DCC) or REPL.',
        );
        failure(ctx, 'rejected: irc transport');
        return;
      }

      const parts = args.split(/\s+/).filter((p) => p.length > 0);
      if (parts.length === 0) {
        ctx.reply('Usage: .chpass <handle> <newpass> | .chpass <newpass>');
        return;
      }

      // Resolve caller and target handle.
      const resolved = resolveCallerAndTarget(parts, ctx, permissions);
      if ('error' in resolved) {
        ctx.reply(resolved.error);
        failure(ctx, 'rejected: caller resolution failed');
        return;
      }
      const { targetHandle, newpass, isSelfRotation } = resolved;

      // Permission check for the non-REPL path.
      if (ctx.source !== 'repl') {
        const callerHostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
        const caller = permissions.findByHostmask(callerHostmask);
        if (!caller) {
          ctx.reply('chpass: permission denied.');
          failure(ctx, 'denied: caller hostmask unmatched', targetHandle);
          return;
        }
        const callerIsOwner = caller.global.includes('n');
        if (!isSelfRotation && !callerIsOwner) {
          ctx.reply('chpass: only owners (+n) can rotate another user\u2019s password.');
          failure(ctx, 'denied: non-owner cross-handle rotation', targetHandle);
          return;
        }
        /* v8 ignore start -- defence in depth: isSelfRotation is only set when caller.handle === targetHandle upstream, so this branch is unreachable from resolveCallerAndTarget */
        if (isSelfRotation && caller.handle !== targetHandle) {
          ctx.reply('chpass: permission denied.');
          failure(ctx, 'denied: self-rotation handle mismatch', targetHandle);
          return;
        }
        /* v8 ignore stop */
      }

      // Target-record checks.
      const target = permissions.getUser(targetHandle);
      if (!target) {
        ctx.reply(`chpass: user "${targetHandle}" not found.`);
        failure(ctx, 'rejected: user not found', targetHandle);
        return;
      }
      if (target.hostmasks.length === 0) {
        ctx.reply(
          `chpass: user "${targetHandle}" has no hostmask patterns — add one with .adduser/.addhost first.`,
        );
        failure(ctx, 'rejected: target has no hostmask patterns', targetHandle);
        return;
      }

      // Length validation is enforced by hashPassword() — catching its throw
      // here also covers any unexpected scrypt failure. We use a single error
      // handler for both cases so the user sees a consistent `chpass: …`
      // reply regardless of which side the failure came from.
      let hash: string;
      try {
        hash = await hashPassword(newpass);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : /* v8 ignore next -- defensive */ String(err);
        ctx.reply(`chpass: ${message}`);
        failure(ctx, `rejected: ${message}`, targetHandle);
        return;
      }

      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;
      permissions.setPasswordHash(targetHandle, hash, source);

      if (isSelfRotation) {
        ctx.reply(`chpass: your password has been updated.`);
      } else {
        ctx.reply(`chpass: password for "${targetHandle}" has been updated.`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ResolvedCall =
  | { targetHandle: string; newpass: string; isSelfRotation: boolean }
  | { error: string };

/**
 * Decide whether `.chpass <arg1> [arg2]` is a self-rotation or a rotation of
 * another user, and return the target handle + plaintext. Returns an
 * `{ error }` shape on ambiguous or invalid input so the handler can send a
 * clear message.
 */
function resolveCallerAndTarget(
  parts: string[],
  ctx: CommandContext,
  permissions: Permissions,
): ResolvedCall {
  if (parts.length === 1) {
    // Self-rotation — resolve the caller to a handle.
    const callerHandle = resolveCallerHandle(ctx, permissions);
    if (!callerHandle) {
      return {
        error:
          'chpass: could not resolve your user handle. Provide <handle> explicitly or ask an owner.',
      };
    }
    return { targetHandle: callerHandle, newpass: parts[0], isSelfRotation: true };
  }

  // parts.length >= 2 — split produced multiple segments. Passwords may
  // contain spaces if the transport preserves them, but `.split` above already
  // dropped empty segments; rejoin the rest with single spaces. This is the
  // documented behavior — nested whitespace is collapsed.
  const [handle, ...rest] = parts;
  return {
    targetHandle: handle,
    newpass: rest.join(' '),
    isSelfRotation: resolveCallerHandle(ctx, permissions)?.toLowerCase() === handle.toLowerCase(),
  };
}

/** Best-effort resolution of a CommandContext's caller handle. */
function resolveCallerHandle(ctx: CommandContext, permissions: Permissions): string | null {
  // REPL has no hostmask — we cannot resolve an implicit caller, so
  // self-rotation from the REPL is rejected and the user must pass an
  // explicit handle argument. `irc` is hard-rejected upstream. That leaves
  // `dcc` as the only path that can self-resolve a handle.
  if (ctx.source !== 'dcc') return null;
  const fullHostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
  const caller = permissions.findByHostmask(fullHostmask);
  return caller?.handle ?? null;
}
