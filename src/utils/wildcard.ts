// n0xb0t — Wildcard pattern matching + IRC case mapping utilities
// Shared by the dispatcher (mask matching) and permissions (hostmask matching).
// Supports `*` (match any string, including empty) and `?` (match exactly one character).

/**
 * IRC-aware lowercase per RFC 1459 CASEMAPPING.
 * In addition to standard ASCII lowercasing:
 *   [ → {   ] → }   \ → |   ~ → ^
 *
 * This is the most common CASEMAPPING on IRC networks.
 */
export function ircLower(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    switch (ch) {
      case '[':
        result += '{';
        break;
      case ']':
        result += '}';
        break;
      case '\\':
        result += '|';
        break;
      case '~':
        result += '^';
        break;
      default:
        result += ch.toLowerCase();
        break;
    }
  }
  return result;
}

/**
 * Match a string against a wildcard pattern.
 *
 * @param pattern  - Wildcard pattern (`*` = any string, `?` = any single char)
 * @param text     - The string to test
 * @param caseInsensitive - When true, matching uses IRC-aware case folding (default: false)
 * @returns true if the text matches the pattern
 */
export function wildcardMatch(pattern: string, text: string, caseInsensitive = false): boolean {
  if (caseInsensitive) {
    pattern = ircLower(pattern);
    text = ircLower(text);
  }

  // Dynamic programming approach — track positions in the pattern.
  // pi = current position in pattern, ti = current position in text.
  let pi = 0;
  let ti = 0;
  let starPi = -1; // position in pattern after last `*`
  let starTi = -1; // position in text when last `*` was hit

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
      // Exact char or single-char wildcard — advance both
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      // Star wildcard — record position, try matching zero characters first
      starPi = pi;
      starTi = ti;
      pi++;
    } else if (starPi !== -1) {
      // Mismatch but we have a prior star — backtrack and consume one more text char
      pi = starPi + 1;
      starTi++;
      ti = starTi;
    } else {
      return false;
    }
  }

  // Consume any remaining `*` in the pattern (they match empty strings)
  while (pi < pattern.length && pattern[pi] === '*') {
    pi++;
  }

  return pi === pattern.length;
}
