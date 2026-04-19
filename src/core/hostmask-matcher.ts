// HexBot — Hostmask / account-pattern matcher with specificity scoring
//
// Owns the wildcard matching + specificity scoring that Permissions uses to
// pick the single most specific user record for a given hostmask/account
// pair. Extracted from permissions.ts so the scoring contract lives in one
// place and can be unit-tested in isolation.
//
// Specificity invariant (SECURITY.md §3.3): when multiple user records
// have overlapping patterns, the match with the highest specificity score
// wins — first-match-wins would race on Map iteration order and let an
// unprivileged pattern eclipse a privileged one.
import type { Casemapping } from '../types';
import { wildcardMatch } from '../utils/wildcard';

/**
 * Pattern prefix for services-account-based matches. A record whose
 * hostmask list contains `$a:alice` matches any sender whose services
 * account is (case-insensitively) `alice`, regardless of nick or host —
 * the critical property for a post-cloak world where hostmask matching
 * alone is not strong enough.
 */
export const ACCOUNT_PATTERN_PREFIX = '$a:';

/**
 * Specificity bonus added on top of `patternSpecificity` when an
 * authoritative account pattern matches. Pushes account matches above
 * every hostmask pattern so a `$a:alice` record never loses to a
 * `*!*@somehost` record, even though the latter may have more literal
 * characters.
 */
const ACCOUNT_MATCH_BONUS = 1_000_000;

/**
 * Rank a wildcard pattern by how specific it is. Higher score = more
 * specific = preferred when multiple records match the same identity.
 *
 * Heuristic: count literal (non-wildcard) characters and subtract a small
 * penalty per wildcard. This keeps `alice!*@host.isp.net` ahead of
 * `*!*@host.isp.net` and keeps a literal hostmask ahead of either.
 */
export function patternSpecificity(pattern: string): number {
  let literal = 0;
  let wildcards = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?') wildcards++;
    else literal++;
  }
  return literal * 10 - wildcards;
}

/**
 * Scores a single user pattern against the caller's identity. Separate
 * from the user-map iteration in `Permissions.findByHostmask` so the
 * scoring contract is unit-testable without standing up a full
 * Permissions instance.
 */
export class HostmaskMatcher {
  constructor(private casemapping: Casemapping = 'rfc1459') {}

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /**
   * Score `pattern` against the caller's `fullHostmask` and (optionally)
   * `account`. Returns the specificity score on match, or `null` when
   * the pattern doesn't apply — account-pattern misses, empty account
   * pattern, or no hostmask match.
   */
  scorePattern(
    pattern: string,
    fullHostmask: string,
    account: string | null | undefined,
  ): number | null {
    if (pattern.startsWith(ACCOUNT_PATTERN_PREFIX)) {
      return this.scoreAccountPattern(pattern, account);
    }
    return this.scoreHostmaskPattern(pattern, fullHostmask);
  }

  /**
   * Score a `$a:<accountpattern>` pattern against the caller's services
   * account. Returns `ACCOUNT_MATCH_BONUS + specificity` when matched,
   * or `null` when the pattern doesn't apply (no account available,
   * empty pattern, or miss). Authoritative account matches are scored
   * in a higher tier than any hostmask match.
   */
  private scoreAccountPattern(pattern: string, account: string | null | undefined): number | null {
    if (account == null) return null;
    const accountPattern = pattern.substring(ACCOUNT_PATTERN_PREFIX.length);
    if (accountPattern.length === 0) return null;
    if (!wildcardMatch(accountPattern, account, true, this.casemapping)) return null;
    return ACCOUNT_MATCH_BONUS + patternSpecificity(accountPattern);
  }

  /**
   * Score a hostmask wildcard pattern against the caller's full hostmask.
   * Returns the specificity score on match, or `null` on miss.
   */
  private scoreHostmaskPattern(pattern: string, fullHostmask: string): number | null {
    if (!wildcardMatch(pattern, fullHostmask, true, this.casemapping)) return null;
    return patternSpecificity(pattern);
  }
}
