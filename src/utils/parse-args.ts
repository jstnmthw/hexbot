// HexBot — Shared arg-parsing helpers for command handlers.
//
// Most command handlers need one of a few shapes:
//   - split into N whitespace-separated tokens
//   - "target message" where target is a single token and message is the rest
//
// `parseTargetMessage` runs the target through `sanitize()` before returning
// so CR/LF/NUL/Unicode line separators can never reach the IRC transport even
// if the caller forgets the validator. The message portion is still the
// caller's responsibility — sanitize/format as appropriate for the command.
import { sanitize } from './sanitize';

/** Defensive upper bound on a single parsed args string — IRC line limit is ~450 bytes so anything larger is either a plugin bug or a malicious input. */
const MAX_ARGS_LENGTH = 8192;

/**
 * Split `args` into at most `n` space/tab-separated tokens. The final token
 * keeps any remaining text verbatim — including embedded `\r` / `\n`, which
 * are *not* treated as separators so that control characters land either in
 * the target (where a validator can reject them) or in the message (where
 * `sanitize()` will strip them).
 *
 * Returns `[]` for empty input.
 *
 * @example
 *   splitN('#chan hello world', 2) // ['#chan', 'hello world']
 *   splitN('#chan', 2)              // ['#chan']
 *   splitN('', 2)                   // []
 */
export function splitN(args: string, n: number): string[] {
  if (args.length > MAX_ARGS_LENGTH) return [];
  // Strip only leading/trailing spaces and tabs — keep embedded control chars.
  const trimmed = args.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!trimmed) return [];
  if (n <= 1) return [trimmed];

  const parts: string[] = [];
  let remaining = trimmed;
  for (let i = 0; i < n - 1; i++) {
    // Find the first SPACE or TAB separator. Don't use regex `\s+` — that
    // would treat embedded `\r`/`\n` as separators and split a target
    // containing control chars (which we want the validator to catch).
    let sep = -1;
    for (let j = 0; j < remaining.length; j++) {
      const ch = remaining[j];
      if (ch === ' ' || ch === '\t') {
        sep = j;
        break;
      }
    }
    if (sep === -1) {
      parts.push(remaining);
      return parts;
    }
    parts.push(remaining.slice(0, sep));
    // Skip any run of spaces/tabs before the next token.
    let next = sep + 1;
    while (next < remaining.length && (remaining[next] === ' ' || remaining[next] === '\t')) {
      next++;
    }
    remaining = remaining.slice(next);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Parse a "target message" pair from command args. Used by `.say`, `.msg`,
 * `.notice`, `.bsay`, and the like. The target is a single token (channel or
 * nick); the message is everything after the first whitespace, trimmed.
 *
 * The returned `target` is already sanitized (CR/LF/NUL/Unicode line
 * separators stripped) — defense in depth so callers that skip
 * `isValidCommandTarget` can't smuggle control characters into the IRC
 * transport via the target field. If the token contained any line-separator
 * characters, we return `null` rather than silently cleaning and forwarding
 * the mangled target: the sanitize contract is "strip-and-pass" for message
 * bodies, but a target with embedded control characters is almost certainly
 * an injection attempt and the caller should see the failure. The `message`
 * is NOT sanitized; callers should run it through `sanitize()` before
 * handing it to `raw()` or interpolating into IRC strings.
 *
 * @returns `{ target, message }` on success, or `null` if args are empty,
 * the target contained control characters, or there's no whitespace
 * separator.
 */
export function parseTargetMessage(args: string): { target: string; message: string } | null {
  const parts = splitN(args, 2);
  if (parts.length !== 2) return null;
  const [rawTarget, message] = parts;
  if (!rawTarget || !message) return null;
  // Sanitize at the parse boundary so a forgotten `sanitize(target)` at the
  // call site can never leak control characters into IRC output. If the
  // token changed during sanitize, the caller meant to send to an invalid
  // target — return `null` rather than silently rewriting it so the
  // existing "Invalid target." error path still fires.
  const target = sanitize(rawTarget);
  if (target !== rawTarget) return null;
  if (!target) return null;
  return { target, message };
}

/**
 * Validate a target as either a channel (`#`/`&`-prefixed) or a bare nick.
 * Does NOT accept arbitrary targets with embedded whitespace or control chars.
 */
export function isValidCommandTarget(target: string): boolean {
  return !!target && /^[#&]?[^\s\r\n]+$/.test(target);
}
