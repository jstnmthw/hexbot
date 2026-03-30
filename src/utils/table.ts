// HexBot — Table formatting utility
// Aligns columns dynamically based on content width.

export interface TableOptions {
  /** Leading whitespace before each row (default: "  ") */
  indent?: string;
  /** Gap between columns (default: "  ") */
  gap?: string;
}

/**
 * Format rows into aligned columns.
 *
 * Each inner array is one row of cells. Column widths are calculated from the
 * widest value in each column, so alignment adapts to the data.
 *
 * The **last column** is never padded — it flows naturally to the end of the line.
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

  // Calculate max width for each column (except the last — it isn't padded)
  const widths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < colCount - 1; i++) {
      const cell = row[i] ?? '';
      if (cell.length > widths[i]) widths[i] = cell.length;
    }
  }

  const lines: string[] = [];
  for (const row of rows) {
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
