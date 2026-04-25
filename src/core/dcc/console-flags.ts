// HexBot — DCC console flag model
// Per-session filtering for the DCC log sink. Maps log-record sources to
// single-letter categories and provides parse/format helpers for the
// `.console` dot-command. Flag letters mirror Eggdrop's partyline console
// mode — operators moving over from Eggdrop should recognize the set.
//
// kv keys:
//   namespace = "dcc"
//   key       = "console_flags:<handle>"
//   value     = canonical flag string, e.g. "mojw"
//
// Default flags for a new session: see `DEFAULT_CONSOLE_FLAGS` below.
import type { LogLevel, LogRecord } from '../../logger';

// ---------------------------------------------------------------------------
// Flag letters
// ---------------------------------------------------------------------------

/** The full set of valid console flag letters. */
export const CONSOLE_FLAG_LETTERS = ['m', 'o', 'j', 'k', 'p', 'b', 's', 'd', 'w'] as const;
export type ConsoleFlagLetter = (typeof CONSOLE_FLAG_LETTERS)[number];

/** Default flags applied to any new DCC session (messages, ops, joins, warnings). */
export const DEFAULT_CONSOLE_FLAGS = 'mojw';

/** Human-friendly description of each category, used by `.console` help. */
export const CONSOLE_FLAG_DESCRIPTIONS: Record<ConsoleFlagLetter, string> = {
  m: 'bot messages / services / memo',
  o: 'operator actions / mode changes',
  k: 'kicks / bans / channel protection',
  j: 'joins / parts / signoffs / nicks',
  p: 'public chat / command dispatch',
  b: 'botnet / botlink',
  s: 'server / connection',
  d: 'debug / dispatcher',
  w: 'warnings and errors',
};

/**
 * Default source-prefix → category table. The first matching entry wins.
 * Prefixes that need finer control (e.g. chanmod emitting both operator
 * and protection log lines) can override by passing an explicit
 * `{ category }` option to `logger.child(...)`, which embeds the letter
 * into `LogRecord.source` as a trailing `#<letter>` marker.
 */
const SOURCE_CATEGORY_TABLE: Array<{ prefix: string; letter: ConsoleFlagLetter }> = [
  // Bot messages / services / memo
  { prefix: 'bot', letter: 'm' },
  { prefix: 'dcc', letter: 'm' },
  { prefix: 'services', letter: 'm' },
  { prefix: 'memo', letter: 'm' },
  { prefix: 'database', letter: 'm' },
  // Operator actions
  { prefix: 'plugin:chanmod', letter: 'o' },
  { prefix: 'plugin:chanset', letter: 'o' },
  { prefix: 'irc-commands', letter: 'o' },
  { prefix: 'ban-store', letter: 'o' },
  // Channel protection / kicks / bans
  { prefix: 'channel-protection', letter: 'k' },
  // Joins / parts
  { prefix: 'channel-state', letter: 'j' },
  { prefix: 'plugin:greeter', letter: 'j' },
  { prefix: 'plugin:seen', letter: 'j' },
  // Public chat / command dispatch
  { prefix: 'command-handler', letter: 'p' },
  { prefix: 'plugin-loader', letter: 'p' },
  // Botnet / botlink
  { prefix: 'botlink', letter: 'b' },
  { prefix: 'dcc-relay', letter: 'b' },
  // Server / connection
  { prefix: 'connection', letter: 's' },
  { prefix: 'reconnect', letter: 's' },
  { prefix: 'irc-bridge', letter: 's' },
  { prefix: 'sts', letter: 's' },
  // Dispatcher
  { prefix: 'dispatcher', letter: 'd' },
];

/** Fallback category for sources that don't match any entry in the table. */
const FALLBACK_CATEGORY: ConsoleFlagLetter = 'm';

// ---------------------------------------------------------------------------
// Parse / format
// ---------------------------------------------------------------------------

/** True if `letter` is a known console flag letter. */
export function isConsoleFlagLetter(letter: string): letter is ConsoleFlagLetter {
  return (CONSOLE_FLAG_LETTERS as readonly string[]).includes(letter);
}

/**
 * Convert a flag-set string (e.g. `"moj"`, `"+all"`, `"-all +mw"`) into a
 * canonical sorted flag set. Accepts multiple whitespace-separated tokens;
 * each token may start with `+` (add) or `-` (remove) and contain any
 * number of flag letters. The literal tokens `+all` / `-all` expand to
 * every known letter.
 *
 * Returns either `{ flags: Set<ConsoleFlagLetter> }` on success or
 * `{ error: string }` on the first invalid letter. `base` seeds the
 * result; omit it for an empty starting set (useful for display).
 */
export function parseFlagsMutation(
  input: string,
  base: Iterable<ConsoleFlagLetter> = [],
): { flags: Set<ConsoleFlagLetter> } | { error: string } {
  const result = new Set<ConsoleFlagLetter>(base);
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { flags: result };
  }

  for (const token of tokens) {
    let op: '+' | '-' = '+';
    let body = token;
    if (body.startsWith('+') || body.startsWith('-')) {
      op = body[0] as '+' | '-';
      body = body.slice(1);
    }
    if (body === 'all') {
      if (op === '+') {
        for (const l of CONSOLE_FLAG_LETTERS) result.add(l);
      } else {
        result.clear();
      }
      continue;
    }
    for (const ch of body) {
      if (!isConsoleFlagLetter(ch)) {
        return { error: `Unknown console flag: ${ch}` };
      }
      if (op === '+') result.add(ch);
      else result.delete(ch);
    }
  }
  return { flags: result };
}

/**
 * Parse a canonical flag string (as stored in kv, e.g. `"mojw"`) into a
 * Set. Silently drops any unknown letters so a stale row written by a
 * future version cannot trap an older session.
 */
export function parseCanonicalFlags(stored: string | null | undefined): Set<ConsoleFlagLetter> {
  const result = new Set<ConsoleFlagLetter>();
  if (!stored) return result;
  for (const ch of stored) {
    if (isConsoleFlagLetter(ch)) result.add(ch);
  }
  return result;
}

/**
 * Format a flag set as its canonical string — letters in the order listed
 * by {@link CONSOLE_FLAG_LETTERS}, no leading `+`. Used for storage and
 * for `.console` display (the command prepends `+` itself).
 */
export function formatFlags(flags: Iterable<ConsoleFlagLetter>): string {
  const set = new Set(flags);
  return CONSOLE_FLAG_LETTERS.filter((l) => set.has(l)).join('');
}

// ---------------------------------------------------------------------------
// Categorisation
// ---------------------------------------------------------------------------

/**
 * Extract the explicit category letter from a source string like
 * `"plugin:chanmod#k"`, or null if the source carries no override.
 */
export function extractExplicitCategory(source: string | null): ConsoleFlagLetter | null {
  if (!source) return null;
  const hashIdx = source.lastIndexOf('#');
  if (hashIdx === -1) return null;
  const candidate = source.slice(hashIdx + 1);
  return isConsoleFlagLetter(candidate) ? candidate : null;
}

/** Strip an explicit `#<category>` suffix so we can look up the base prefix. */
function stripCategory(source: string | null): string | null {
  if (!source) return null;
  const hashIdx = source.lastIndexOf('#');
  return hashIdx === -1 ? source : source.slice(0, hashIdx);
}

/**
 * Map a {@link LogRecord} to the console flag letter it belongs to.
 * Precedence:
 *   1. Explicit `#<letter>` suffix on the source (opt-in via child logger).
 *   2. Debug-level records always map to `d`.
 *   3. Source-prefix lookup table.
 *   4. Fallback `m`.
 *
 * Warn/error routing via the `w` flag is handled separately by
 * {@link shouldDeliverToSession}; categorise does not special-case them.
 */
export function categorize(source: string | null, level: LogLevel): ConsoleFlagLetter {
  const explicit = extractExplicitCategory(source);
  if (explicit) return explicit;
  if (level === 'debug') return 'd';
  const base = stripCategory(source);
  if (base) {
    for (const entry of SOURCE_CATEGORY_TABLE) {
      if (base === entry.prefix) return entry.letter;
    }
  }
  return FALLBACK_CATEGORY;
}

// ---------------------------------------------------------------------------
// Delivery decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a given log record should be delivered to a session
 * holding `flags`. Rules (in order):
 *   1. `warn` / `error` records are delivered when `w` is set, regardless
 *      of category.
 *   2. `debug` records are dropped unless `d` is set.
 *   3. Otherwise we compute the category via {@link categorize} and
 *      deliver iff the session holds that flag.
 */
export function shouldDeliverToSession(record: LogRecord, flags: Set<ConsoleFlagLetter>): boolean {
  if ((record.level === 'warn' || record.level === 'error') && flags.has('w')) {
    return true;
  }
  if (record.level === 'debug' && !flags.has('d')) {
    return false;
  }
  const letter = categorize(record.source, record.level);
  return flags.has(letter);
}

// ---------------------------------------------------------------------------
// Kv helpers
// ---------------------------------------------------------------------------

/** kv namespace used by all DCC console flag rows. */
export const CONSOLE_FLAG_KV_NAMESPACE = 'dcc';

/** kv key for a given handle's stored console flags. */
export function consoleFlagKey(handle: string): string {
  return `console_flags:${handle}`;
}

/**
 * A narrow storage interface so DCC code doesn't need to import the full
 * database. Tests can supply an in-memory implementation.
 */
export interface ConsoleFlagStore {
  get(handle: string): string | null;
  set(handle: string, canonicalFlags: string): void;
  delete(handle: string): void;
}
