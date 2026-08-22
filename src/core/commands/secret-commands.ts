// HexBot — secret-bearing command redaction
//
// Some commands carry secrets in their positional arguments (passwords,
// primarily). Those arguments must never reach a durable sink: the console
// log, the botnet ANNOUNCE stream, or a `mod_log` row (retention is
// unbounded and the audit store is not a password vault). This module is the
// single source of truth for which command verbs are secret-bearing and how
// to mask a full command line before logging it.

/**
 * Command verbs (without the leading `.`) whose positional arguments carry
 * secrets and must be redacted before any command line containing them is
 * logged, announced, or audited. Compared case-insensitively.
 *
 * `.chpass <handle> <newpass>` / `.chpass <newpass>` — the argument is a
 * plaintext password destined for scrypt hashing. Logging it defeats the
 * hashing entirely.
 */
export const SECRET_COMMANDS: ReadonlySet<string> = new Set(['chpass']);

/**
 * Redact the arguments of a secret-bearing command line for safe logging.
 *
 * Recognizes a leading `.` (dot-command form) and a bare form. When the
 * first token names a {@link SECRET_COMMANDS} verb and arguments follow, the
 * arguments are replaced with `[redacted]`, preserving the verb so the audit
 * trail still records *that* a password rotation happened. Any other line is
 * returned unchanged.
 */
export function redactCommandLine(line: string): string {
  const trimmed = line.trim();
  const hasDot = trimmed.startsWith('.');
  const body = hasDot ? trimmed.slice(1) : trimmed;
  const firstSpace = body.search(/\s/);
  const verb = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  if (!SECRET_COMMANDS.has(verb)) return line;
  const prefix = hasDot ? '.' : '';
  // No arguments — nothing secret to hide, keep the verb as typed.
  if (firstSpace === -1) return `${prefix}${verb}`;
  return `${prefix}${verb} [redacted]`;
}
