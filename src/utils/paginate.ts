// HexBot — Multi-line reply pagination helper
//
// Several read-only operator commands (`.modlog`, `.bans`, `.users`,
// `.binds`) used to reply with an unbounded `lines.join('\n')`. Three
// problems:
//
//   1. The outbound message queue's per-target depth cap (50 by default)
//      silently truncates anything past it.
//   2. A botlink-relayed dot-command return path drops trailing lines
//      with no operator-visible signal.
//   3. The terminal / IRC client gets a wall of text the operator has to
//      scroll through.
//
// The fix: cap the visible lines at `DEFAULT_PAGE_SIZE`, append a
// "page N of M" footer when there's more, and let operators advance via
// `--page <N>`. Callers thread the user's `--page` flag through this
// helper; the rest of the command logic stays the same.
//
// Page numbering is 1-based for operator ergonomics (`.modlog --page 1`
// reads as "first page" rather than "page zero").

/** Default visible lines per page. Tuned to fit a typical 80x25 terminal
 * with header lines and operator's own prompt without scroll. */
export const DEFAULT_PAGE_SIZE = 20;

export interface PaginatedReply {
  /** The lines for this page (already capped at the page size). */
  lines: string[];
  /** 1-based page number that was rendered. */
  page: number;
  /** Total number of pages. */
  totalPages: number;
  /** Total number of items across all pages. */
  totalItems: number;
  /** Footer line summarising the page state. Empty when there's only one page. */
  footer: string;
}

/**
 * Slice `items` to the requested 1-based `page`. Out-of-range pages
 * clamp to the nearest valid page rather than returning empty — a typo
 * (`--page 99`) gets the last page instead of a confusingly empty
 * reply.
 */
export function paginate(
  items: string[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): PaginatedReply {
  const totalItems = items.length;
  if (totalItems === 0) {
    return { lines: [], page: 1, totalPages: 1, totalItems: 0, footer: '' };
  }
  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const requested = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const clamped = Math.min(requested, totalPages);
  const start = (clamped - 1) * size;
  const lines = items.slice(start, start + size);
  const footer =
    totalPages > 1
      ? `... page ${clamped}/${totalPages}, ${totalItems} total — use --page <N> to navigate.`
      : '';
  return { lines, page: clamped, totalPages, totalItems, footer };
}

/**
 * Parse `--page N` (or `--page=N`) from a free-form args string. Returns
 * `{ page, rest }` where `rest` is the args with the flag stripped so the
 * caller can continue parsing its own arguments.
 *
 * Accepts only positive integers; an unparseable value is treated as
 * "no flag" so the command's existing argument shape isn't broken by an
 * accidental `--page foo`.
 */
export function parsePageFlag(args: string): { page: number; rest: string } {
  const re = /(?:^|\s)--page(?:=|\s+)(\d+)\b/;
  const match = args.match(re);
  if (!match) return { page: 1, rest: args };
  const n = parseInt(match[1], 10);
  const page = Number.isFinite(n) && n > 0 ? n : 1;
  const rest = (args.slice(0, match.index) + args.slice(match.index! + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { page, rest };
}
