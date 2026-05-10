// HexBot — Flag-level verification utility
// Determines whether a bind's required flags meet the NickServ ACC threshold.
import type { LoggerLike } from '../logger';
import type { IdentityConfig } from '../types';

/**
 * Flag hierarchy for `require_acc_for` checking. Higher number = more
 * privileged. Used as a partial order: a bind tagged `n` (level 4) trips
 * the ACC gate when `require_acc_for` lists *any* flag at level ≤ 4.
 *
 * - `n` — owner / network admin
 * - `m` — master / global moderator
 * - `o` — channel operator
 * - `v` — voiced / trusted user
 *
 * Unknown flags resolve to level 0 (= disabled). See {@link requiresVerificationForFlags}
 * for the fail-closed invariant that compensates for the level-0 default.
 */
export const FLAG_LEVEL: Record<string, number> = { n: 4, m: 3, o: 2, v: 1 };

/**
 * Validate `identity.require_acc_for` at config load and warn on any entry
 * whose flag isn't in {@link FLAG_LEVEL}. An unknown flag silently defaults
 * to level 0, which disables the verification gate — exactly the thing an
 * operator was trying to enable.
 *
 * Returns the filtered list of recognized entries (unknown ones are
 * dropped) so callers can surface the real intent rather than the typo.
 */
export function validateRequireAccFor(
  requireAccFor: IdentityConfig['require_acc_for'] | undefined,
  logger: LoggerLike | null,
): string[] {
  if (!requireAccFor || requireAccFor.length === 0) return [];
  const result: string[] = [];
  for (const entry of requireAccFor) {
    const raw = entry.replace('+', '');
    if (FLAG_LEVEL[raw] === undefined) {
      logger?.warn(
        `identity.require_acc_for entry "${entry}" references unknown flag "${raw}"; ` +
          `known flags: ${Object.keys(FLAG_LEVEL).join(', ')}. Entry ignored — ACC gate NOT active for this flag.`,
      );
      continue;
    }
    result.push(entry);
  }
  return result;
}

/**
 * Determine whether the bind's required flags are at or above any threshold
 * in `config.identity.require_acc_for`. Used by the VerificationProvider.
 *
 * Invariant: unknown flags resolve to level 0. Taken in isolation that's a
 * fail-open shape ("treat the unknown flag as not meeting the threshold"),
 * but every upstream caller already rejects unknown flags before this point
 * (binds reject at registration, command flags reject at parse). The net
 * behavior is fail-closed — verify this holds before relaxing either path.
 */
export function requiresVerificationForFlags(
  bindFlags: string,
  requireAccFor: IdentityConfig['require_acc_for'],
): boolean {
  if (bindFlags === '-' || bindFlags === '') return false;
  if (!requireAccFor || requireAccFor.length === 0) return false;

  // Find the minimum threshold flag level from require_acc_for (e.g. ["+o", "+n"] → 2)
  const thresholds = requireAccFor
    .map((f) => f.replace('+', ''))
    .map((f) => FLAG_LEVEL[f] ?? 0)
    .filter((l) => l > 0);
  if (thresholds.length === 0) return false;
  const minThreshold = Math.min(...thresholds);

  // Strip flag-syntax punctuation explicitly before iterating each char
  // so a future bind-flag extension (e.g. group syntax `n|m`, negation
  // `!o`) doesn't accidentally produce a `FLAG_LEVEL[char]` match for the
  // punctuation. Today no punctuation lands in `bindFlags` at runtime,
  // but this insulates the lookup from the syntax surface.
  const normalized = bindFlags.replace(/[+\-|!]/g, '');
  if (normalized.length === 0) return false;

  // Find the highest flag level among the bind's required flags
  const bindLevel = Math.max(...[...normalized].map((f) => FLAG_LEVEL[f] ?? 0));
  return bindLevel >= minThreshold;
}
