// Transforms LLM text into IRC-safe, properly-split messages.
// Strips markdown, normalizes whitespace, splits at sentence/word boundaries,
// truncates to a maximum number of lines, and neutralizes ChanServ fantasy
// command prefixes (see docs/audits/ai-chat-llm-injection-2026-04-05.md).

/**
 * Characters that, when they appear at position 0 of a channel PRIVMSG, can be
 * parsed by IRC services (ChanServ fantasy commands) and executed against the
 * bot's ACL. An LLM that is prompt-injected to emit `.deop admin` or similar
 * would otherwise have ChanServ act on the bot's behalf.
 *
 * The set covers the prefixes used by Atheme (`.`, `!`), Anope BotServ (`!`),
 * and slash-style fantasy on some networks (`/`). Prepending a single leading
 * space breaks the parser (services check byte 0) without changing visible
 * content in any IRC client we target.
 */
const FANTASY_PREFIXES = /^[.!/]/;

/** Prepend a space if a line starts with a character that services parse as a command prefix. */
export function neutralizeFantasyPrefix(line: string): string {
  return FANTASY_PREFIXES.test(line) ? ` ${line}` : line;
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
    // soft hyphen, word joiner, etc. These are invisible but can hide a trailing
    // fantasy-command prefix (e.g. `\u200b.deop admin`) from the position-0 check
    // in neutralizeFantasyPrefix(). Stripping them makes the first VISIBLE
    // character also the first byte inspected.
    .replace(/\p{Cf}/gu, '');
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
export function formatResponse(text: string, maxLines: number, maxLineLength: number): string[] {
  if (!text) return [];

  const cleaned = stripMarkdown(stripProtocolUnsafe(text));

  // Split at original newlines, clean each line, drop empties.
  const rawLines = cleaned.split('\n');
  const lines: string[] = [];

  for (const raw of rawLines) {
    const line = collapseWhitespace(raw);
    if (!line) continue;
    for (const chunk of splitLongLine(line, maxLineLength)) {
      if (chunk) lines.push(neutralizeFantasyPrefix(chunk));
    }
  }

  if (lines.length === 0) return [];

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
