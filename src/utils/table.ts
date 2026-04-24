// HexBot — Table formatting utility
// Aligns columns dynamically based on content width.

export interface TableOptions {
  /** Leading whitespace before each row (default: "  ") */
  indent?: string;
  /** Gap between columns (default: "  ") */
  gap?: string;
}

/**
 * Strip ASCII control bytes from a cell before measuring / emitting. Cells
 * feeding `formatTable` come from user input on various code paths (handles,
 * hostmasks, plugin names); a stray `\x03` in one cell would bleed IRC colour
 * codes into adjacent cells on the REPL and recompute column widths with
 * zero-width characters that pad visually wrong.
 */
function stripControlBytes(cell: string): string {
  // eslint-disable-next-line no-control-regex
  return cell.replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Format rows into aligned columns.
 *
 * Each inner array is one row of cells. Column widths are calculated from the
 * widest value in each column, so alignment adapts to the data.
 *
 * The **last column** is never padded — it flows naturally to the end of the line.
 *
 * Control bytes (`\x00-\x1f\x7f`) are stripped from every cell before
 * measurement and emission. Callers that rely on ANSI colour must apply
 * colour *after* formatting, not inside the cells.
 *
 * @returns One string per row, joined with `\n`.
 */
export function formatTable(rows: string[][], opts?: TableOptions): string {
  if (rows.length === 0) return '';

  const indent = opts?.indent ?? '  ';
  const gap = opts?.gap ?? '  ';

  // Determine the number of columns from the widest row
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount === 0) return '';

  const sanitized: string[][] = rows.map((row) => row.map((cell) => stripControlBytes(cell ?? '')));

  // Calculate max width for each column (except the last — it isn't padded)
  const widths: number[] = new Array(colCount).fill(0);
  for (const row of sanitized) {
    for (let i = 0; i < colCount - 1; i++) {
      const cell = row[i] ?? '';
      if (cell.length > widths[i]) widths[i] = cell.length;
    }
  }

  const lines: string[] = [];
  for (const row of sanitized) {
    const parts: string[] = [];
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? '';
      // Pad all columns except the last
      parts.push(i < colCount - 1 ? cell.padEnd(widths[i]) : cell);
    }
    lines.push(indent + parts.join(gap));
  }

  return lines.join('\n');
}
