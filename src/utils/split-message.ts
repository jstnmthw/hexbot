// HexBot — IRC message splitting utility
// Splits long messages at word boundaries to fit within IRC's ~512 byte limit.

/** Maximum safe message content length (accounting for protocol overhead + bot prefix). */
const MAX_MSG_BYTES = 400;

/** Maximum number of lines to send per reply. */
const MAX_LINES = 4;

/**
 * Split a message into lines that fit within IRC's message length limit.
 * Caps output at MAX_LINES, appending "..." if truncated.
 */
export function splitMessage(
  text: string,
  maxBytes = MAX_MSG_BYTES,
  maxLines = MAX_LINES,
): string[] {
  // Handle newlines in the input first
  const inputLines = text.split('\n');
  const outputLines: string[] = [];

  for (const line of inputLines) {
    if (line.length <= maxBytes) {
      outputLines.push(line);
    } else {
      // Split long line at word boundaries
      let remaining = line;
      while (remaining.length > maxBytes) {
        let splitIdx = remaining.lastIndexOf(' ', maxBytes);
        if (splitIdx <= 0) {
          // No space found — hard split
          splitIdx = maxBytes;
        }
        outputLines.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).trimStart();
      }
      if (remaining) {
        outputLines.push(remaining);
      }
    }

    if (outputLines.length > maxLines) break;
  }

  // Cap at maxLines
  if (outputLines.length > maxLines) {
    const truncated = outputLines.slice(0, maxLines);
    truncated[maxLines - 1] += ' ...';
    return truncated;
  }

  return outputLines;
}
