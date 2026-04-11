// HexBot — Shared arg-parsing helpers for command handlers.
//
// Most command handlers need one of a few shapes:
//   - split into N whitespace-separated tokens
//   - "target message" where target is a single token and message is the rest
//
// These helpers parse only — they do NOT sanitize. Callers should run the
// message portion through `sanitize()` and validate the target with
// `isValidCommandTarget()` (or a stricter regex) before using the values.

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
 * @returns `{ target, message }` on success, or `null` if args are empty or
 * don't contain at least one whitespace separator.
 */
export function parseTargetMessage(args: string): { target: string; message: string } | null {
  const parts = splitN(args, 2);
  if (parts.length !== 2) return null;
  const [target, message] = parts;
  if (!target || !message) return null;
  return { target, message };
}

/**
 * Validate a target as either a channel (`#`/`&`-prefixed) or a bare nick.
 * Does NOT accept arbitrary targets with embedded whitespace or control chars.
 */
export function isValidCommandTarget(target: string): boolean {
  return !!target && /^[#&]?[^\s\r\n]+$/.test(target);
}
