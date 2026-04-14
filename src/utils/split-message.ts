// HexBot — IRC message splitting utility
//
// IRC imposes a 512-byte ceiling on the full protocol line (RFC 1459 §2.3),
// counting *bytes*, not JavaScript UTF-16 code units. A channel using
// emoji/Cyrillic/Japanese will blow past the limit if we naively slice on
// `.length`, and mid-codepoint slicing produces mojibake on the wire.
//
// This module splits at grapheme-unsafe boundaries — still word-preferred,
// but measured in UTF-8 bytes and iterated by code point so surrogate pairs
// stay intact. Callers that know their outbound prefix size (nick!user@host
// + verb + target + CRLF) can pass `reservedBytes` to shrink the budget to
// the true server-facing room; the default budget is a conservative 400.

/** Maximum safe message content length (accounting for protocol overhead + bot prefix). */
const MAX_MSG_BYTES = 400;

/** Maximum number of lines to send per reply. */
const MAX_LINES = 4;

/** ASCII `" ..."` — 4 bytes, appended to the last line on truncation. */
const ELLIPSIS = ' ...';
const ELLIPSIS_BYTES = ELLIPSIS.length;

/**
 * Split a message into lines that fit within IRC's message length limit.
 * Caps output at `maxLines`, appending `" ..."` if truncated. Counts bytes
 * (not UTF-16 code units) and never splits a surrogate pair.
 *
 * @param text - The message text. `\n` is treated as a hard line break.
 * @param maxBytes - Per-line byte ceiling before subtracting reservedBytes.
 * @param maxLines - Cap on the number of lines returned.
 * @param reservedBytes - Bytes to reserve for out-of-band framing
 *   (`:nick!user@host PRIVMSG #chan :` + CRLF, or CTCP `\x01...\x01` wrappers).
 *   Subtracted from `maxBytes` to yield the effective content budget.
 */
export function splitMessage(
  text: string,
  maxBytes = MAX_MSG_BYTES,
  maxLines = MAX_LINES,
  reservedBytes = 0,
): string[] {
  const budget = Math.max(1, maxBytes - reservedBytes);
  const inputLines = text.split('\n');
  const outputLines: string[] = [];

  for (const line of inputLines) {
    splitLineInto(line, budget, outputLines);
    if (outputLines.length > maxLines) break;
  }

  if (outputLines.length > maxLines) {
    const truncated = outputLines.slice(0, maxLines);
    truncated[maxLines - 1] = appendEllipsis(truncated[maxLines - 1], budget);
    return truncated;
  }

  return outputLines;
}

/**
 * Split one `\n`-free input line into one or more chunks that fit `budget`
 * bytes, preferring word boundaries. Pushes chunks directly into `out`.
 */
function splitLineInto(line: string, budget: number, out: string[]): void {
  if (byteLength(line) <= budget) {
    out.push(line);
    return;
  }

  // Early truncation — `Array.from(line)` allocates a Unicode code point
  // array proportional to `line.length`. A plugin forwarding a multi-MB
  // string would allocate a giant intermediate array even though only
  // `MAX_LINES * maxBytes * 2` code units can possibly survive after
  // splitting. Cut the input down before we iterate. The bound is
  // deliberately loose (2x) so we don't chop mid-word when the budget
  // splits exactly on a character boundary.
  const maxCodeUnits = MAX_LINES * budget * 2;
  const truncatedLine = line.length > maxCodeUnits ? line.slice(0, maxCodeUnits) : line;

  // Iterate by Unicode code point so we never split a surrogate pair.
  const cps = Array.from(truncatedLine);
  let start = 0;

  while (start < cps.length) {
    let bytes = 0;
    let end = start;
    let lastSpace = -1;

    // Longest prefix of cps[start..) that fits in the byte budget.
    while (end < cps.length) {
      const cpBytes = byteLength(cps[end]);
      if (bytes + cpBytes > budget) break;
      bytes += cpBytes;
      if (cps[end] === ' ') lastSpace = end;
      end++;
    }

    if (end >= cps.length) {
      const rest = cps.slice(start).join('');
      if (rest.length > 0) out.push(rest);
      return;
    }

    // We must split before cps[end]. Prefer a word boundary:
    // A) the character at `end` itself is a space → split there and drop it;
    // B) an earlier space within [start, end) → split there and drop it;
    // C) no space available → hard split at `end` (single long word).
    let splitAt: number;
    let dropSplitChar: boolean;
    if (cps[end] === ' ') {
      splitAt = end;
      dropSplitChar = true;
    } else if (lastSpace > start) {
      splitAt = lastSpace;
      dropSplitChar = true;
    } else {
      splitAt = end;
      dropSplitChar = false;
    }

    out.push(cps.slice(start, splitAt).join(''));
    start = splitAt + (dropSplitChar ? 1 : 0);
    while (start < cps.length && cps[start] === ' ') start++;
  }
}

/**
 * Append `" ..."` to `line`, trimming the tail first if needed so the result
 * still fits `budget` bytes. Trimming iterates by code point to stay safe.
 */
function appendEllipsis(line: string, budget: number): string {
  if (byteLength(line) + ELLIPSIS_BYTES <= budget) {
    return line + ELLIPSIS;
  }
  const cps = Array.from(line);
  let bytes = byteLength(line);
  while (cps.length > 0 && bytes + ELLIPSIS_BYTES > budget) {
    const last = cps.pop()!;
    bytes -= byteLength(last);
  }
  return cps.join('') + ELLIPSIS;
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
