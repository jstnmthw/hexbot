// HexBot — Password management commands (.chpass)
//
// Implements `.chpass` for setting and rotating per-user DCC passwords.
// Allowed transports: REPL (implicit owner) and DCC (owner can rotate any
// user's password; anyone can rotate their own). IRC PRIVMSG is explicitly
// rejected to keep plaintext passwords off the wire.
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { tryAudit } from '../audit';
import { getAuditSource, parseCommandArgs } from '../command-helpers';
import { hashPassword } from '../password';
import { OWNER_FLAG, type Permissions } from '../permissions';
import { requireTransport } from './permission-helpers';

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
 * `relayToHub` flag is intentionally omitted so a leaf's `.chpass` stays
 * local — relaying would put the plaintext on the inter-bot link and
 * reduce every leaf's password store to "as secure as the link cipher".
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
      // Transport allowlist — passwords may travel over REPL (local stdin) or
      // DCC CHAT (TLS-equivalent per-user console) only. IRC PRIVMSG is the
      // obvious plaintext leak; `botlink` would pipe the password over the
      // hub/leaf TCP link (plaintext) and is also refused. Any future
      // transport added to `CommandContext['source']` must be explicitly
      // allowlisted here rather than implicitly permitted.
      if (
        !requireTransport(
          ctx,
          ['repl', 'dcc'],
          'chpass: passwords must be set from the bot console (DCC) or REPL only.',
        )
      ) {
        failure(ctx, `rejected: ${ctx.source} transport`);
        return;
      }

      const parts = parseCommandArgs(
        args,
        1,
        'Usage: .chpass <handle> <newpass> | .chpass <newpass>',
        ctx,
      );
      if (!parts) return;

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
        const callerIsOwner = caller.global.includes(OWNER_FLAG);
        if (!isSelfRotation && !callerIsOwner) {
          ctx.reply('chpass: only owners (+n) can rotate another user\u2019s password.');
          failure(ctx, 'denied: non-owner cross-handle rotation', targetHandle);
          return;
        }
        /* v8 ignore start -- defense in depth: isSelfRotation is only set when caller.handle === targetHandle upstream, so this branch is unreachable from resolveCallerAndTarget */
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

      const source = getAuditSource(ctx);
      permissions.setPasswordHash(targetHandle, hash, source, ctx.source);

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
  // `--self` sentinel: explicit self-rotation. Prevents the ambiguity in
  // `.chpass myhandle hunter2 extra` where the user's intent could be
  // "rotate my own password to 'hunter2 extra'" or "rotate myhandle's
  // password to 'hunter2 extra'" depending on interpretation. Requiring
  // the sentinel makes the choice explicit and eliminates the quiet
  // whitespace collapse below from becoming a credential-assignment bug.
  if (parts[0] === '--self') {
    if (parts.length < 2) {
      return { error: 'chpass: usage: .chpass --self <new-password>' };
    }
    const callerHandle = resolveCallerHandle(ctx, permissions);
    if (!callerHandle) {
      return {
        error:
          'chpass: could not resolve your user handle. Provide <handle> explicitly or ask an owner.',
      };
    }
    return {
      targetHandle: callerHandle,
      newpass: parts.slice(1).join(' '),
      isSelfRotation: true,
    };
  }

  if (parts.length === 1) {
    // Legacy single-arg path — self-rotation with no sentinel. Kept for
    // ergonomics (the common case: a DCC-authed user typing one arg).
    const callerHandle = resolveCallerHandle(ctx, permissions);
    if (!callerHandle) {
      return {
        error:
          'chpass: could not resolve your user handle. Provide <handle> explicitly or ask an owner.',
      };
    }
    return { targetHandle: callerHandle, newpass: parts[0], isSelfRotation: true };
  }

  // parts.length >= 2 — two-arg form is explicit-target: `.chpass <handle> <newpass>`.
  // Refuse passwords containing whitespace in this shape; the caller should
  // use `.chpass --self ...` to disambiguate, or quote-strip upstream.
  const [handle, ...rest] = parts;
  if (rest.length > 1) {
    return {
      error:
        'chpass: password contains whitespace — use `.chpass --self <password>` for self-rotation ' +
        'or ensure the explicit-target form passes exactly two arguments.',
    };
  }
  return {
    targetHandle: handle,
    newpass: rest[0],
    isSelfRotation: resolveCallerHandle(ctx, permissions)?.toLowerCase() === handle.toLowerCase(),
  };
}

/**
 * Best-effort resolution of a CommandContext's caller handle. Returns the
 * caller's user-record handle for `dcc` callers (the only path that has
 * both a hostmask and a path through the permissions store), and `null`
 * for every other transport. REPL callers must pass an explicit `<handle>`
 * because the REPL has no hostmask to match against; `irc` is hard-rejected
 * upstream so it never reaches this helper.
 */
function resolveCallerHandle(ctx: CommandContext, permissions: Permissions): string | null {
  if (ctx.source !== 'dcc') return null;
  const fullHostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
  const caller = permissions.findByHostmask(fullHostmask);
  return caller?.handle ?? null;
}
