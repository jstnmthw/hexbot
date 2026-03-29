// HexBot — Flag-level verification utility
// Determines whether a bind's required flags meet the NickServ ACC threshold.
import type { IdentityConfig } from '../types';

/** Flag hierarchy for require_acc_for checking. */
export const FLAG_LEVEL: Record<string, number> = { n: 4, m: 3, o: 2, v: 1 };

/**
 * Determine whether the bind's required flags are at or above any threshold
 * in `config.identity.require_acc_for`. Used by the VerificationProvider.
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

  // Find the highest flag level among the bind's required flags
  const bindLevel = Math.max(...[...bindFlags].map((f) => FLAG_LEVEL[f] ?? 0));
  return bindLevel >= minThreshold;
}
