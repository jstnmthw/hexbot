// HexBot — SQL helpers shared across the data layer.
//
// These helpers live in `utils/` (not `database.ts`) so `core/mod-log.ts`
// can import them without creating a database.ts <-> mod-log.ts cycle.

/**
 * Escape the SQL LIKE metacharacters `%`, `_`, and `\` so a user-supplied
 * substring can be used as a literal prefix/substring in a `LIKE ? ESCAPE
 * '\'` clause without letting unchecked wildcards widen the match (which
 * can turn a targeted search into a full-table scan or leak rows the caller
 * didn't intend to touch).
 *
 * Order matters: escape backslashes FIRST so the `\` we then prepend to `%`
 * and `_` isn't itself re-escaped on the next pass. The returned string is
 * safe to interpolate directly into a LIKE pattern; callers still need to
 * add their own `%` anchors (prefix, suffix, or both) and a matching
 * `ESCAPE '\'` clause in the query.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
