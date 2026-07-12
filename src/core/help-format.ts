// HexBot — Help formatting service (shared layout conventions)
//
// Single home for the visual conventions every help surface follows.
// Both transports — the core `.help` built-in (REPL / DCC / IRC
// dot-commands) and the IRC `!help` plugin — render through the view
// builders in `help-render`, and those builders compose every page from
// the primitives here. A styling change (wrap width, indent, label
// casing, row alignment, block separation) lands here once and every
// help view picks it up.
//
// Page anatomy (mirrors network services like ChanServ/NickServ):
//
//   TITLE — short blurb                      titleLine()
//
//       NAME      description                alignedRows()
//       LONGNAME  description that wraps
//                 onto the aligned column
//
//   Wrapped footer hint pointing at the      prose()
//   next drill-down level.
//
// Blocks are separated by single `' '` lines (a literal space, not an
// empty string, so IRC clients don't drop the separator) — helpPage()
// inserts them between non-empty blocks.

/** Column gap (spaces) between the name column and the description column. */
export const COLUMN_GAP = 2;

/** Left indent for aligned list rows — four spaces, per services convention. */
export const ROW_INDENT = '    ';

/** Wrap width for prose lines (intro paragraphs, titles, footer hints). */
export const WRAP_WIDTH = 60;

/** Total line budget for an aligned row before its description wraps. */
export const ROW_WIDTH = 72;

/** Block separator — a space so IRC clients render the blank line. */
const BLANK = ' ';

/**
 * Greedy word-wrap `text` to `width` columns. Words longer than `width`
 * land on their own line unbroken — hostmasks and setting keys are more
 * useful intact than split mid-token. Returns `[]` for empty/blank input.
 */
export function wrapText(text: string, width = WRAP_WIDTH): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Uppercase a topic / section name into a services-style label. */
export function sectionLabel(name: string): string {
  return name.toUpperCase();
}

/**
 * Page title — `LABEL — blurb` with the label uppercased, wrapped to
 * prose width. Omitting `blurb` yields the bare label.
 */
export function titleLine(label: string, blurb?: string): string[] {
  return wrapText(blurb ? `${sectionLabel(label)} — ${blurb}` : sectionLabel(label));
}

/** Wrapped prose block — intro paragraphs, pointer lines, footer hints. */
export function prose(text: string): string[] {
  return wrapText(text);
}

/**
 * Aligned name/description table. Names share one column sized to the
 * widest entry; descriptions that would push a line past
 * {@link ROW_WIDTH} wrap onto continuation lines indented to the
 * description column — the ChanServ ENTRYMSG shape. Rows carry no IRC
 * formatting; they read as a plain scan list.
 */
export function alignedRows(
  rows: ReadonlyArray<readonly [name: string, description: string]>,
): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([name]) => name.length));
  const descColumn = ROW_INDENT.length + width + COLUMN_GAP;
  const contIndent = ' '.repeat(descColumn);
  const lines: string[] = [];
  for (const [name, description] of rows) {
    const wrapped = wrapText(description, Math.max(24, ROW_WIDTH - descColumn));
    if (wrapped.length === 0) {
      lines.push(`${ROW_INDENT}${name}`);
      continue;
    }
    const pad = ' '.repeat(Math.max(1, width - name.length + COLUMN_GAP));
    const [first, ...rest] = wrapped;
    lines.push(`${ROW_INDENT}${name}${pad}${first}`, ...rest.map((line) => `${contIndent}${line}`));
  }
  return lines;
}

/**
 * Assemble page blocks with single blank separators. Empty blocks are
 * dropped, so callers pass conditional sections unguarded and never
 * leak a dangling separator.
 */
export function helpPage(...blocks: string[][]): string[] {
  const present = blocks.filter((block) => block.length > 0);
  const lines: string[] = [];
  for (const [i, block] of present.entries()) {
    if (i > 0) lines.push(BLANK);
    lines.push(...block);
  }
  return lines;
}
