// Transforms LLM text into IRC-safe, properly-split messages.
// Strips markdown, normalizes whitespace, splits at sentence/word boundaries,
// truncates to a maximum number of lines, and detects ChanServ fantasy command
// prefixes (see docs/audits/security-ai-injection-threat-2026-04-16.md).

/**
 * Characters that, when they appear at position 0 of a channel PRIVMSG, can be
 * parsed by IRC services (ChanServ fantasy commands) and executed against the
 * bot's ACL. An LLM that is prompt-injected to emit `.deop admin` or similar
 * would otherwise have ChanServ act on the bot's behalf.
 *
 * The set covers the prefixes used by Atheme (`.`, `!`), Anope BotServ (`!`),
 * slash-style fantasy (`/`), and non-standard triggers used by various networks
 * (`~`, `@`, `%`, `$`, `&`, `+`).
 *
 * NOTE: The previous defence (prepending a space) was found to be ineffective
 * against Atheme's `strtok(msg, " ")` parser, which skips leading spaces.
 * The fix is to drop the entire response if any line matches.
 * See docs/audits/security-ai-injection-threat-2026-04-16.md.
 */
const FANTASY_PREFIXES = /^[.!/~@%$&+]/;

/**
 * Check if a line would be parsed as a fantasy command by IRC services.
 *
 * Normalises the line with NFKC before the prefix test so fullwidth / halfwidth /
 * compatibility lookalikes (`！` U+FF01, `．` U+FF0E, `／` U+FF0F, `․` U+2024,
 * `⁄` U+2044, `｡` U+FF61) fold back to their ASCII counterparts and are caught.
 * The normalised form is used only for the check — not persisted to the output.
 */
export function isFantasyLine(line: string): boolean {
  return FANTASY_PREFIXES.test(line.normalize('NFKC'));
}

/** Strip characters that could inject IRC protocol lines or IRC formatting control codes. */
function stripProtocolUnsafe(text: string): string {
  // Drop IRC color/formatting sequences first (including their fg/bg digit parameters).
  // Matches \x03 color, \x04 hex color, and bare \x02/\x0F/\x11/\x16/\x1D/\x1E/\x1F formatting bytes.
  /* eslint-disable no-control-regex -- IRC formatting codes are intentional control characters */
  const out = text
    .replace(
      /\x03(\d{1,2}(,\d{1,2})?)?|\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?|[\x02\x0F\x11\x16\x1D\x1E\x1F]/g,
      '',
    )
    // Then drop remaining unsafe control bytes (NUL, BEL, backspace, etc.)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    // Strip Unicode format characters (Cf): ZWSP, ZWJ, ZWNJ, BOM, bidi overrides,
    // soft hyphen, word joiner, etc. These are invisible but can hide a
    // fantasy-command prefix (e.g. `\u200b.deop admin`) from the position-0
    // check in isFantasyLine(). Stripping them makes the first VISIBLE
    // character also the first byte inspected.
    .replace(/\p{Cf}/gu, '')
    // Strip combining marks (\p{M} = Mn + Mc + Me). A leading combining mark
    // would defeat the isFantasyLine check (e.g. "\u0301.deop admin" — the
    // acute accent is the first code point, `.` is second). Strip them so the
    // first surviving code point is the one Atheme/Anope would also dispatch on.
    .replace(/\p{M}/gu, '')
    // Normalise Unicode line-separator characters (U+2028 / U+2029 / U+0085 NEL)
    // to LF so the downstream split('\n') sees them as real breaks. Some IRC
    // clients render these as newlines — without this, an attacker could hide
    // a fantasy-prefix line behind a U+2028 separator on line 1.
    .replace(/[\u2028\u2029\u0085]/g, '\n');
  /* eslint-enable no-control-regex */
  return out;
}

/** Strip common markdown syntaxes the LLM may produce. */
function stripMarkdown(text: string): string {
  let out = text;
  // Code fences ``` … ```
  out = out.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  // Bold **x**, __x__
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  // Italic *x*, _x_  (avoid munging legitimate asterisks/underscores in code/ids)
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1');
  out = out.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1');
  // Inline code `x`
  out = out.replace(/`([^`\n]+)`/g, '$1');
  // Headers
  out = out.replace(/^ {0,3}#{1,6}\s+/gm, '');
  // Block quotes
  out = out.replace(/^ {0,3}>\s?/gm, '');
  // Bullet points and numbered lists — keep a "- " marker but drop markdown "*" / "1."
  out = out.replace(/^ {0,3}[*+]\s+/gm, '- ');
  out = out.replace(/^ {0,3}\d+\.\s+/gm, '- ');
  // Links [text](url) → "text (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return out;
}

/** Collapse runs of whitespace (except newlines) to single spaces. */
function collapseWhitespace(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

/** Split a single long line at sentence/word boundaries to fit maxLineLength. */
function splitLongLine(line: string, maxLineLength: number): string[] {
  if (line.length <= maxLineLength) return [line];
  const out: string[] = [];
  let remaining = line;

  while (remaining.length > maxLineLength) {
    const slice = remaining.substring(0, maxLineLength + 1);
    // Prefer a sentence boundary, then fall back to word boundary.
    let cut = findLastMatch(slice, /[.!?](\s|$)/g);
    if (cut === -1 || cut < maxLineLength / 2) {
      // Sentence break too early — use last space.
      cut = slice.lastIndexOf(' ', maxLineLength);
    }
    if (cut <= 0) cut = maxLineLength; // hard cut — no usable break
    out.push(remaining.substring(0, cut).trimEnd());
    remaining = remaining.substring(cut).trimStart();
  }

  if (remaining) out.push(remaining);
  return out;
}

/** Return the index of the last full regex match in `text`, or -1. */
function findLastMatch(text: string, re: RegExp): number {
  let idx = -1;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    idx = m.index + 1; // split AFTER the punctuation
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return idx;
}

/**
 * Convert raw LLM output into an array of IRC-safe lines.
 *
 * @param text           — raw LLM response
 * @param maxLines       — maximum number of PRIVMSG lines to emit
 * @param maxLineLength  — max bytes per line
 */
/** Character style overrides applied after formatResponse(). */
export interface CharacterStyleOptions {
  casing: 'normal' | 'lowercase' | 'uppercase';
  verbosity: 'terse' | 'normal' | 'verbose';
}

/**
 * Apply character-specific style overrides to already-formatted lines. Runs
 * AFTER `formatResponse()` so the fantasy-prefix / markdown / protocol-unsafe
 * scrubs have already fired — transforming text here (e.g. lowercasing) will
 * never re-introduce a fantasy prefix, since those pass on NFKC-normalised
 * first-char matching which is case-insensitive for the punctuation set.
 *
 * - `verbosity: 'terse'`    — keep only the first line.
 * - `verbosity: 'verbose'`  — cap at 6 lines (may exceed caller's maxLines).
 * - `casing: 'lowercase' | 'uppercase'` — mapped per-line.
 */
export function applyCharacterStyle(lines: string[], style: CharacterStyleOptions): string[] {
  if (lines.length === 0) return lines;

  let result = lines;

  // Enforce verbosity limits
  if (style.verbosity === 'terse' && result.length > 1) {
    result = [result[0]];
  } else if (style.verbosity === 'verbose') {
    // Allow up to 6 lines (caller's maxLines may be higher)
    result = result.slice(0, 6);
  }

  // Apply casing
  if (style.casing === 'lowercase') {
    result = result.map((l) => l.toLowerCase());
  } else if (style.casing === 'uppercase') {
    result = result.map((l) => l.toUpperCase());
  }

  return result;
}

/** Optional hook invoked when the entire response is dropped due to a fantasy-prefix line. */
export type FantasyDropHook = (info: { index: number; line: string }) => void;

export function formatResponse(
  text: string,
  maxLines: number,
  maxLineLength: number,
  onDropFantasy?: FantasyDropHook,
): string[] {
  if (!text) return [];

  const cleaned = stripMarkdown(stripProtocolUnsafe(text));

  // Split at original newlines, clean each line, drop empties.
  const rawLines = cleaned.split('\n');
  const lines: string[] = [];

  for (const raw of rawLines) {
    const line = collapseWhitespace(raw);
    if (!line) continue;
    for (const chunk of splitLongLine(line, maxLineLength)) {
      if (chunk) lines.push(chunk);
    }
  }

  if (lines.length === 0) return [];

  // SECURITY: If ANY line starts with a fantasy-command prefix, drop the entire
  // response. A single fantasy line means the LLM output is compromised (likely
  // prompt injection). Dropping the whole response is intentionally aggressive —
  // partial responses from a compromised generation are not trustworthy.
  const fantasyIdx = lines.findIndex((l) => isFantasyLine(l));
  if (fantasyIdx !== -1) {
    onDropFantasy?.({ index: fantasyIdx, line: lines[fantasyIdx] });
    return [];
  }

  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    // Append ellipsis marker to the final kept line.
    const last = truncated[truncated.length - 1];
    const suffix = ' …';
    if (last.length + suffix.length <= maxLineLength) {
      truncated[truncated.length - 1] = `${last}${suffix}`;
    } else {
      truncated[truncated.length - 1] =
        `${last.substring(0, maxLineLength - suffix.length)}${suffix}`;
    }
    return truncated;
  }

  return lines;
}
