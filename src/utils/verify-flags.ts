// HexBot — Flag-level verification utility
// Determines whether a bind's required flags meet the NickServ ACC threshold.
import { VALID_FLAGS } from '../core/permissions';
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
 * Fail-closed invariant: this function does NOT rely on unknown flags being
 * rejected upstream (they are not — `bind()`/`registerCommand()`/`api.bind()`
 * accept any flag string). Instead, any character outside {@link VALID_FLAGS}
 * is treated as potentially privileged and forces verification on: an
 * uppercase typo (`'O'` for `'o'`) or a stray `'z'` must not silently drop
 * the ACC gate the operator was trying to enable. Recognized-but-privilege-
 * neutral flags (e.g. `'d'`, which restricts rather than grants) map to
 * level 0 and correctly do not trip the gate on their own.
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

  // Fail closed on any unrecognized flag character. We can't know the
  // privilege level of a flag we don't recognize, so — with require_acc_for
  // active — assume it's privileged and require verification rather than
  // treating it as level 0 and skipping the gate.
  for (const ch of normalized) {
    if (!VALID_FLAGS.includes(ch)) return true;
  }

  // Find the highest flag level among the bind's required flags
  const bindLevel = Math.max(...[...normalized].map((f) => FLAG_LEVEL[f] ?? 0));
  return bindLevel >= minThreshold;
}
