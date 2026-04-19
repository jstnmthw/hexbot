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

/**
 * Strip common markdown syntaxes the LLM may produce. IRC has no rendering for
 * markdown; left in, asterisks/underscores/backticks become visible noise that
 * also confuses downstream tooling (clients that parse `*emphasis*` as IRC
 * action wrapping). Each pattern targets one syntax in turn — order matters
 * so code fences are removed before italic/bold (`**` inside ``` would
 * otherwise get partially stripped).
 */
function stripMarkdown(text: string): string {
  let out = text;
  // Code fences ``` … ```  — strip the optional language tag and trailing
  // newline that follow the opening fence, then strip any remaining bare ```.
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

/**
 * Encoder reused across calls — TextEncoder is stateless and per-spec safe to
 * share. Allocating one per `formatResponse` call adds noticeable GC pressure
 * on chatty channels.
 */
const UTF8 = new TextEncoder();

/** UTF-8 byte length of a string. */
function utf8ByteLen(s: string): number {
  return UTF8.encode(s).length;
}

/**
 * Split `s` so that the head fits within `maxBytes` of UTF-8 without splitting
 * a multi-byte code point. Iterates by code point (for…of yields full code
 * points, including surrogate pairs for emoji ≥ U+10000) and stops as soon as
 * the next character would push over the cap. Returns both halves so callers
 * can keep slicing the tail.
 */
function sliceByBytes(s: string, maxBytes: number): { head: string; tail: string } {
  if (maxBytes <= 0) return { head: '', tail: s };
  let bytes = 0;
  let cuCount = 0; // code-unit count → use to slice on string position
  for (const ch of s) {
    const b = UTF8.encode(ch).length;
    if (bytes + b > maxBytes) break;
    bytes += b;
    cuCount += ch.length;
  }
  return { head: s.slice(0, cuCount), tail: s.slice(cuCount) };
}

/**
 * Split a single long line at sentence/word boundaries to fit `maxByteLen`
 * UTF-8 bytes per line. Multibyte content (emoji, CJK) is measured in bytes,
 * not JS code units, so a line of CJK that fits the char cap but blows the
 * 510-byte IRC line limit gets split before the server truncates it.
 */
function splitLongLine(line: string, maxByteLen: number): string[] {
  if (utf8ByteLen(line) <= maxByteLen) return [line];
  const out: string[] = [];
  let remaining = line;

  while (utf8ByteLen(remaining) > maxByteLen) {
    // Take a search window slightly larger than the cap — gives the boundary
    // search a sentence break that lands at or just past the cap.
    const { head: window } = sliceByBytes(remaining, maxByteLen + 4);
    // Prefer a sentence boundary, then fall back to word boundary.
    let cut = findLastMatch(window, /[.!?](\s|$)/g);
    // Reject sentence breaks in the first half — splitting "Yes." off the
    // front of a long line would emit a useless one-word IRC message.
    if (cut === -1 || cut < window.length / 2) {
      // Sentence break too early — use last space within the window.
      cut = window.lastIndexOf(' ');
    }
    if (cut <= 0) {
      // No usable break — hard-cut at the byte boundary, preserving code points.
      const { head, tail } = sliceByBytes(remaining, maxByteLen);
      out.push(head.trimEnd());
      remaining = tail.trimStart();
      continue;
    }
    const chunk = remaining.substring(0, cut);
    // Even at a found break, the chunk could exceed the byte cap when
    // multibyte chars sit between the break and the line start. Re-cap by
    // bytes in that case rather than emitting an over-budget line.
    if (utf8ByteLen(chunk) > maxByteLen) {
      const { head, tail } = sliceByBytes(remaining, maxByteLen);
      out.push(head.trimEnd());
      remaining = tail.trimStart();
      continue;
    }
    out.push(chunk.trimEnd());
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
    // Zero-width-match guard — without this advance, a regex that matched the
    // empty string at position N would loop forever at the same index.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return idx;
}

/**
 * Convert raw LLM output into an array of IRC-safe lines.
 *
 * @param text           — raw LLM response
 * @param maxLines       — maximum number of PRIVMSG lines to emit
 * @param maxLineLength  — max UTF-8 bytes per line. The IRC server hard-limits
 *   PRIVMSG lines to 512 bytes total (including `:nick!user@host PRIVMSG #ch :`
 *   prefix); 440 leaves a comfortable safety margin. Measuring in bytes rather
 *   than JS code units matters for emoji and CJK content, where one visible
 *   character is 3–4 UTF-8 bytes.
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
    // Append ellipsis marker to the final kept line. Both length checks are
    // in UTF-8 bytes — same units as `maxLineLength` — so multibyte content
    // doesn't push us past the IRC line limit during the suffix step.
    const last = truncated[truncated.length - 1];
    const suffix = ' …';
    const suffixBytes = utf8ByteLen(suffix);
    if (utf8ByteLen(last) + suffixBytes <= maxLineLength) {
      truncated[truncated.length - 1] = `${last}${suffix}`;
    } else {
      const { head } = sliceByBytes(last, maxLineLength - suffixBytes);
      truncated[truncated.length - 1] = `${head}${suffix}`;
    }
    return truncated;
  }

  return lines;
}
