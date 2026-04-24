// HexBot — Wildcard pattern matching + IRC case mapping utilities
// Shared by the dispatcher (mask matching) and permissions (hostmask matching).
// Supports `*` (match any string, including empty) and `?` (match exactly one character).
import type { Casemapping } from '../types';

export type { Casemapping };

/**
 * IRC-aware lowercase using the specified CASEMAPPING.
 * Defaults to 'rfc1459' — the most common mapping on legacy networks.
 */
export function ircLower(text: string, casemapping: Casemapping = 'rfc1459'): string {
  if (casemapping === 'ascii') {
    return text.toLowerCase();
  }

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
        // strict-rfc1459 does NOT fold ~ to ^
        result += casemapping === 'strict-rfc1459' ? '~' : '^';
        break;
      default:
        result += ch.toLowerCase();
        break;
    }
  }
  return result;
}

/**
 * Case-insensitive string equality using the specified CASEMAPPING.
 * Defaults to 'rfc1459'.
 */
export function caseCompare(a: string, b: string, casemapping: Casemapping = 'rfc1459'): boolean {
  return ircLower(a, casemapping) === ircLower(b, casemapping);
}

/**
 * Maximum pattern byte length accepted by {@link wildcardMatch}. The DP
 * algorithm is O(pattern * text) in the worst case; capping both sides
 * protects against a plugin persisting a pathological pattern that would
 * burn CPU on every message.
 */
const MAX_PATTERN_LEN = 512;

/**
 * Maximum text byte length accepted by {@link wildcardMatch}. 4 KiB
 * comfortably covers any IRC-sourced string (hostmask, channel, message)
 * while refusing plugin-supplied multi-MB inputs.
 */
const MAX_TEXT_LEN = 4096;

/**
 * Match a string against a wildcard pattern.
 *
 * @param pattern  - Wildcard pattern (`*` = any string, `?` = any single char)
 * @param text     - The string to test
 * @param caseInsensitive - When true, matching uses IRC-aware case folding (default: false)
 * @param casemapping - Which IRC CASEMAPPING to use when caseInsensitive is true (default: 'rfc1459')
 * @returns true if the text matches the pattern
 *
 * Inputs exceeding {@link MAX_PATTERN_LEN} or {@link MAX_TEXT_LEN} return
 * `false` immediately — no partial match is attempted.
 */
export function wildcardMatch(
  pattern: string,
  text: string,
  caseInsensitive = false,
  casemapping: Casemapping = 'rfc1459',
): boolean {
  if (pattern.length > MAX_PATTERN_LEN || text.length > MAX_TEXT_LEN) return false;
  if (caseInsensitive) {
    pattern = ircLower(pattern, casemapping);
    text = ircLower(text, casemapping);
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
