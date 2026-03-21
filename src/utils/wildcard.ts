// n0xb0t — Wildcard pattern matching utility
// Shared by the dispatcher (mask matching) and permissions (hostmask matching).
// Supports `*` (match any string, including empty) and `?` (match exactly one character).

/**
 * Match a string against a wildcard pattern.
 *
 * @param pattern  - Wildcard pattern (`*` = any string, `?` = any single char)
 * @param text     - The string to test
 * @param caseInsensitive - When true, matching ignores case (default: false)
 * @returns true if the text matches the pattern
 */
export function wildcardMatch(
  pattern: string,
  text: string,
  caseInsensitive = false
): boolean {
  if (caseInsensitive) {
    pattern = pattern.toLowerCase();
    text = text.toLowerCase();
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
