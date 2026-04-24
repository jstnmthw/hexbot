/**
 * Strip line separators and NUL from text before handing it to the IRC
 * transport. Coerces non-string inputs via `String(text ?? '')` so a
 * stray number or undefined never throws — the IRC path is hot and the
 * cost of one defensive coercion is trivial compared to a crashed handler.
 *
 * Strips (beyond the obvious CR/LF/NUL):
 *   - U+0085 NEL  — treated as a line terminator by some parsers
 *   - U+2028 LS   — Unicode line separator
 *   - U+2029 PS   — Unicode paragraph separator
 *
 * These aren't line terminators in the IRC RFC itself, but several
 * downstream consumers (log viewers, web clients, services bots) split
 * on them and a crafted message could still smuggle an extra "line" into
 * the wire-level transcript. See SECURITY.md §2.3.
 */
export function sanitize(text: string): string {
  return String(text ?? '').replace(/[\r\n\0\x85\u2028\u2029]/g, '');
}
