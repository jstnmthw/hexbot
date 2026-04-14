// HexBot — `.modlog` pager and `.audit-tail` REPL stream
//
// DCC- and REPL-only audit query surface. Refused on IRC channels to keep
// audit data out of public scrollback and to avoid flood-kicks from the
// page-size echo.
//
// Permission model note: `chpass`, `modlog`, and `flags` deliberately do
// their permission checks inline instead of relying on bind-flag gating.
// The policy for each is transport- or argument-sensitive (e.g. `chpass`
// self-rotation is allowed for any caller; `modlog` source filtering is
// owner-only) and doesn't fit the coarse `flags: '+X'` gate. Do not
// "simplify" these back to bind flags without re-reading DESIGN.md §12.
//
// State model:
//   • Each session carries one `PagerState` keyed by `dcc:<handle>` or
//     `'repl'`. The state holds the current filter, cursor, and the total
//     count snapshotted on first query so pagination labels stay stable
//     even if new rows land mid-browse.
//   • Idle pagers expire after `IDLE_TIMEOUT_MS`; pruning happens lazily
//     on every command invocation so no background timer is needed.
//   • Cursor is `(beforeId)` — pages walk strictly forward through the
//     descending `id` order, so deep pagination stays O(log n) on the
//     `mod_log_ts` index instead of O(offset).
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase, ModLogEntry, ModLogFilter, ModLogSource } from '../../database';
import type { BotEventBus } from '../../event-bus';
import { stripFormatting } from '../../utils/strip-formatting';
import { MASTER_FLAG, OWNER_FLAG, type Permissions } from '../permissions';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 10;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const VALID_SOURCES: ReadonlySet<string> = new Set<ModLogSource>([
  'repl',
  'irc',
  'dcc',
  'botlink',
  'plugin',
  'config',
  'system',
]);

// ---------------------------------------------------------------------------
// Pager state
// ---------------------------------------------------------------------------

/**
 * A single session's view into the mod log. `filter` is frozen at query
 * time so subcommands like `.modlog next` stay scoped to the original
 * query. `pageStart`/`pageEnd` are 1-indexed for footer rendering;
 * `lastIdSeen` is the cursor used to fetch the next page.
 */
interface PagerState {
  filter: ModLogFilter;
  /** Page rows currently displayed (newest-first). Empty when nothing matched. */
  rows: ModLogEntry[];
  /** Total row count snapshotted when the query was first executed. */
  totalAtFirstQuery: number;
  /** 1-indexed start of the current page. */
  pageStart: number;
  /** 1-indexed end of the current page (== rows.length when full). */
  pageEnd: number;
  /** History of (firstId, lastId) tuples for previous pages — enables `prev`. */
  pageStack: Array<{ firstId: number; lastId: number }>;
  /** Wall-clock ms of the last command on this pager — used for idle expiry. */
  lastUsed: number;
}

const pagers = new Map<string, PagerState>();

/**
 * Tail listeners keyed by session. Module-scoped (not hidden inside
 * `registerModLogCommands`) so {@link clearAuditTailForSession} and
 * {@link shutdownModLogCommands} can find them from teardown paths.
 * Holds a closure over `ctx.reply` per entry, so any shutdown path
 * that skips cleanup leaks the REPL/DCC session context. See audit
 * findings W-CMD1 and W-CMD2 (2026-04-14).
 */
interface TailEntry {
  listener: (entry: ModLogEntry) => void;
  eventBus: BotEventBus;
}
const tailListeners = new Map<string, TailEntry>();

function sessionKey(ctx: CommandContext): string {
  if (ctx.source === 'dcc' && ctx.dccSession) return `dcc:${ctx.dccSession.handle}`;
  if (ctx.source === 'repl') return 'repl';
  // Botlink-relayed callers carry the originating handle in `ctx.nick`
  // so each remote operator gets their own pager.
  return `${ctx.source}:${ctx.nick}`;
}

function pruneIdle(now = Date.now()): void {
  for (const [key, state] of pagers) {
    if (now - state.lastUsed > IDLE_TIMEOUT_MS) {
      pagers.delete(key);
    }
  }
}

/** Clear a session's pager — exposed so DCC/REPL tear-down can drop the entry eagerly. */
export function clearPagerForSession(key: string): void {
  pagers.delete(key);
}

/** Clear a session's audit-tail subscription — exposed so DCC/REPL tear-down can unsubscribe eagerly. */
export function clearAuditTailForSession(key: string): void {
  const entry = tailListeners.get(key);
  if (entry) {
    entry.eventBus.off('audit:log', entry.listener);
    tailListeners.delete(key);
  }
}

/**
 * Teardown-time cleanup — drop every pager and every audit-tail
 * subscription. Called from `Bot.shutdown()` so a bot restart doesn't
 * leak the closures held by tailListeners or the page rows held by
 * pagers.
 */
export function shutdownModLogCommands(): void {
  pagers.clear();
  for (const entry of tailListeners.values()) {
    entry.eventBus.off('audit:log', entry.listener);
  }
  tailListeners.clear();
}

/** Test-only: drop every pager. */
export function _resetPagersForTest(): void {
  pagers.clear();
}

// ---------------------------------------------------------------------------
// Filter grammar
// ---------------------------------------------------------------------------

const FILTER_FIELDS = new Set([
  'action',
  'target',
  'channel',
  'by',
  'source',
  'plugin',
  'outcome',
  'since',
  'grep',
]);

const VALID_OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure']);

interface ParsedFilter {
  filter: ModLogFilter;
  error: string | null;
}

/**
 * Parse a token stream like `action kick channel #foo since 1h grep oops`
 * into a {@link ModLogFilter}. Tokens are paired (`field` + value) so
 * order is irrelevant; `grep` consumes the rest of the line so the value
 * may contain spaces. Unknown fields produce a short error rather than
 * silently dropping to "no filter".
 */
export function parseModlogFilter(args: string): ParsedFilter {
  const filter: ModLogFilter = {};
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const field = tokens[i].toLowerCase();
    if (!FILTER_FIELDS.has(field)) {
      return { filter, error: `unknown filter "${field}" — try: ${[...FILTER_FIELDS].join(', ')}` };
    }
    if (field === 'grep') {
      // grep consumes the rest of the line so substrings can contain spaces
      const rest = tokens.slice(i + 1).join(' ');
      if (!rest) return { filter, error: 'grep needs a value' };
      filter.grep = rest;
      break;
    }
    const value = tokens[i + 1];
    if (!value) return { filter, error: `${field} needs a value` };
    switch (field) {
      case 'action':
        filter.action = value;
        break;
      case 'target':
        filter.target = value;
        break;
      case 'channel':
        filter.channel = value.toLowerCase();
        break;
      case 'by':
        filter.by = value;
        break;
      case 'source':
        if (!VALID_SOURCES.has(value)) {
          return {
            filter,
            error: `invalid source "${value}" — one of: ${[...VALID_SOURCES].join('|')}`,
          };
        }
        filter.source = value;
        break;
      case 'plugin':
        filter.plugin = value;
        break;
      case 'outcome':
        if (!VALID_OUTCOMES.has(value)) {
          return { filter, error: `invalid outcome "${value}" — one of: success|failure` };
        }
        filter.outcome = value;
        break;
      case 'since': {
        const seconds = parseDurationSeconds(value);
        if (seconds === null) {
          return { filter, error: `invalid duration "${value}" — examples: 30m, 2h, 7d` };
        }
        filter.sinceTimestamp = Math.floor(Date.now() / 1000) - seconds;
        break;
      }
    }
    i += 2;
  }
  return { filter, error: null };
}

/** Parse `30m` / `2h` / `7d` into seconds. Returns null on bad input. */
export function parseDurationSeconds(input: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
  }
  /* v8 ignore next -- unreachable: regex class restricts unit to s/m/h/d */
  return null;
}

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

/**
 * Decide whether the caller can run `.modlog` and, if so, scope the filter.
 *
 * - Global `n` flag: unrestricted.
 * - Global `m` flag: restricted to channels where the user has per-channel
 *   `o`, plus rows where `target = user.handle`. Achieved by setting
 *   `channelsIn` and `target` on the filter — when both are set the OR
 *   isn't expressible through SQL AND, so the helper returns either form
 *   and the caller invokes `.modlog` twice and merges. To keep the model
 *   simple, we adopt **channel scope only**: an `m` user sees rows from
 *   channels they op, full stop. Self-target audit can be queried with
 *   `target <handle>` explicitly.
 * - Below `m`: rejected.
 */
export interface ModlogPermissionResult {
  allowed: boolean;
  reason?: string;
  /** Set when caller is restricted to a specific channel set. */
  channelScope?: string[];
}

export function checkModlogPermission(
  permissions: Permissions,
  ctx: CommandContext,
): ModlogPermissionResult {
  // REPL caller is implicitly the owner — no permission check needed,
  // matches how every other REPL-gated command treats the attached console.
  if (ctx.source === 'repl') return { allowed: true };

  const fullHostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
  const user = permissions.findByHostmask(fullHostmask);
  if (!user) return { allowed: false, reason: 'permission denied' };

  if (user.global.includes(OWNER_FLAG)) return { allowed: true };
  if (!user.global.includes(MASTER_FLAG)) {
    return { allowed: false, reason: 'requires +m or higher' };
  }

  // Master flag: collect every channel where this user has per-channel `o`.
  // Channel keys are stored case-folded by Permissions.setChannelFlags so we
  // pass them through as-is.
  const opChannels: string[] = [];
  for (const [channel, flags] of Object.entries(user.channels)) {
    if (flags.includes('o') || flags.includes('n')) opChannels.push(channel);
  }
  return { allowed: true, channelScope: opChannels };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Format an absolute unix-seconds timestamp as a relative "Xm ago". */
export function relativeTime(ts: number, now = Math.floor(Date.now() / 1000)): string {
  const delta = Math.max(0, now - ts);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function truncate(s: string | null | undefined, width: number): string {
  const v = s ?? '—';
  if (v.length <= width) return v;
  return v.slice(0, width - 1) + '…';
}

interface ColumnSpec {
  header: string;
  width: number;
  get: (row: ModLogEntry) => string;
}

const COLUMNS: ColumnSpec[] = [
  { header: 'ID', width: 6, get: (r) => String(r.id) },
  { header: 'WHEN', width: 8, get: (r) => relativeTime(r.timestamp) },
  { header: 'ACTION', width: 14, get: (r) => r.action },
  { header: 'WHO', width: 14, get: (r) => r.by ?? '—' },
  { header: 'TARGET', width: 18, get: (r) => r.target ?? '—' },
  { header: 'CHAN', width: 12, get: (r) => r.channel ?? '—' },
  { header: 'OUTCOME', width: 8, get: (r) => r.outcome },
];

function renderHeader(): string {
  return COLUMNS.map((c) => c.header.padEnd(c.width)).join(' ');
}

function renderRow(row: ModLogEntry): string {
  return COLUMNS.map((c) => truncate(c.get(row), c.width).padEnd(c.width)).join(' ');
}

function renderPage(state: PagerState, _db: BotDatabase): string[] {
  const lines: string[] = [];
  if (state.rows.length === 0) {
    lines.push('(no matching rows)');
    return lines;
  }
  lines.push(renderHeader());
  for (const row of state.rows) lines.push(renderRow(row));

  // Use the snapshot total captured by `beginQuery` — do NOT re-run
  // countModLog on every page nav. On a 10M-row mod_log, each
  // SELECT COUNT(*) with the current filter grows linearly with
  // page count and makes deep pagination painful. The snapshot is
  // refreshed only when the user runs `.modlog top`, which starts
  // a fresh query. See stability audit 2026-04-14.
  lines.push(
    `-- ${state.pageStart}-${state.pageEnd} of ${state.totalAtFirstQuery} — .modlog next | prev | top | show <id> --`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Pager subcommands
// ---------------------------------------------------------------------------

interface RegisterDeps {
  handler: CommandHandler;
  db: BotDatabase | null;
  permissions: Permissions;
  eventBus: BotEventBus;
}

export function registerModlogCommands(deps: RegisterDeps): void {
  const { handler, db, permissions, eventBus } = deps;
  if (!db) return;

  handler.registerCommand(
    'modlog',
    {
      // Permission is enforced inside the handler (`checkModlogPermission`)
      // because the policy is more nuanced than the dispatcher's flag gate:
      // master users get a channel-scoped view rather than a flat refusal,
      // and the rejection messages differ by reason (transport, flag, scope).
      flags: '-',
      description: 'Query the moderation audit log (DCC/REPL only)',
      usage: '.modlog [filter...] | next | prev | top | end | show <id> | clear',
      category: 'audit',
    },
    (args, ctx) => {
      if (ctx.source === 'irc') {
        ctx.reply('audit queries are DCC-only — /dcc chat me');
        return;
      }
      const perm = checkModlogPermission(permissions, ctx);
      if (!perm.allowed) {
        ctx.reply(`.modlog: ${perm.reason}`);
        return;
      }

      pruneIdle();
      const key = sessionKey(ctx);
      const trimmed = args.trim();

      // Subcommand routing — single-word verbs without an `=` separator
      // dispatch to navigation; everything else is treated as a fresh
      // filter expression (or empty for the default query).
      const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
      switch (firstWord) {
        case 'next':
        case 'n':
          return runNext(ctx, key, db);
        case 'prev':
        case 'p':
          return runPrev(ctx, key, db);
        case 'top':
          return runTop(ctx, key, db);
        case 'end':
          return runEnd(ctx, key, db);
        case 'show':
          return runShow(ctx, trimmed.slice(firstWord.length).trim(), db, perm);
        case 'clear':
          pagers.delete(key);
          ctx.reply('.modlog: pager state cleared');
          return;
      }

      // Fresh query — parse, attach permission scope, store, render.
      const parsed = parseModlogFilter(trimmed);
      if (parsed.error) {
        ctx.reply(`.modlog: ${parsed.error}`);
        return;
      }
      const filter = applyPermissionScope(parsed.filter, perm);
      const state = beginQuery(filter, db);
      pagers.set(key, state);
      reply(ctx, renderPage(state, db));
    },
  );

  // -------------------------------------------------------------------------
  // .audit-tail — live stream of audit:log events (REPL only)
  // -------------------------------------------------------------------------

  handler.registerCommand(
    'audit-tail',
    {
      // REPL-only, enforced inside the handler. Dispatcher flags are not
      // a substitute — the source check has to come first so a non-REPL
      // owner gets the "REPL-only" message rather than a flag rejection.
      flags: '-',
      description: 'Stream audit:log events to the attached REPL',
      usage: '.audit-tail [filter...] | off',
      category: 'audit',
    },
    (args, ctx) => {
      if (ctx.source !== 'repl') {
        ctx.reply('.audit-tail is REPL-only');
        return;
      }
      const trimmed = args.trim();
      if (trimmed === 'off') {
        const existing = tailListeners.get('repl');
        if (existing) {
          eventBus.off('audit:log', existing.listener);
          tailListeners.delete('repl');
          ctx.reply('.audit-tail off');
        } else {
          ctx.reply('.audit-tail: not currently tailing');
        }
        return;
      }
      const parsed = parseModlogFilter(trimmed);
      if (parsed.error) {
        ctx.reply(`.audit-tail: ${parsed.error}`);
        return;
      }
      // Replace any existing listener — only one tail per REPL.
      const old = tailListeners.get('repl');
      if (old) eventBus.off('audit:log', old.listener);

      const matcher = makeMatcher(parsed.filter);
      const listener = (entry: ModLogEntry): void => {
        if (matcher(entry)) ctx.reply(renderRow(entry));
      };
      eventBus.on('audit:log', listener);
      tailListeners.set('repl', { listener, eventBus });
      ctx.reply('.audit-tail on (use `.audit-tail off` to stop)');
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyPermissionScope(filter: ModLogFilter, perm: ModlogPermissionResult): ModLogFilter {
  if (!perm.channelScope) return filter;
  // Master users are restricted to their op'd channels. If the caller also
  // supplied an explicit `channel` filter, keep it only when it's inside
  // the allowed set — otherwise force-clamp to the channel scope.
  const scope = new Set(perm.channelScope.map((c) => c.toLowerCase()));
  if (filter.channel && !scope.has(filter.channel.toLowerCase())) {
    return { ...filter, channelsIn: [] }; // empty → no rows
  }
  return { ...filter, channelsIn: perm.channelScope };
}

function beginQuery(filter: ModLogFilter, db: BotDatabase): PagerState {
  const total = db.countModLog(filter);
  const rows = db.getModLog({ ...filter, limit: PAGE_SIZE });
  return {
    filter,
    rows,
    totalAtFirstQuery: total,
    pageStart: rows.length === 0 ? 0 : 1,
    pageEnd: rows.length,
    pageStack: [],
    lastUsed: Date.now(),
  };
}

/**
 * Swap `state.rows` in-place, recompute the 1-based `pageStart`/`pageEnd`
 * bounds from `nextStart`, and refresh `lastUsed`. Centralises the
 * "update rows + bounds + lastUsed" trio that every pager verb needs.
 */
function updatePagerState(state: PagerState, rows: ModLogEntry[], nextStart: number): void {
  state.rows = rows;
  state.pageStart = rows.length === 0 ? 0 : nextStart;
  state.pageEnd = rows.length === 0 ? 0 : nextStart + rows.length - 1;
  state.lastUsed = Date.now();
}

function runNext(ctx: CommandContext, key: string, db: BotDatabase): void {
  const state = pagers.get(key);
  if (!state) {
    ctx.reply('.modlog: no active query — run `.modlog [filter...]` first');
    return;
  }
  if (state.rows.length === 0) {
    ctx.reply('.modlog: no more rows');
    return;
  }
  const lastId = state.rows[state.rows.length - 1].id;
  const next = db.getModLog({ ...state.filter, beforeId: lastId, limit: PAGE_SIZE });
  if (next.length === 0) {
    ctx.reply('.modlog: end of results');
    return;
  }
  state.pageStack.push({ firstId: state.rows[0].id, lastId });
  updatePagerState(state, next, state.pageEnd + 1);
  reply(ctx, renderPage(state, db));
}

function runPrev(ctx: CommandContext, key: string, db: BotDatabase): void {
  const state = pagers.get(key);
  if (!state) {
    ctx.reply('.modlog: no active query — run `.modlog [filter...]` first');
    return;
  }
  const prev = state.pageStack.pop();
  if (!prev) {
    ctx.reply('.modlog: already at the first page');
    return;
  }
  // Walk back to the page whose first row was `prev.firstId`. The cursor
  // for that page is `prev.firstId + 1` (use beforeId one greater so the
  // first row reappears).
  const rows = db.getModLog({ ...state.filter, beforeId: prev.firstId + 1, limit: PAGE_SIZE });
  updatePagerState(state, rows, Math.max(1, state.pageStart - PAGE_SIZE));
  reply(ctx, renderPage(state, db));
}

function runTop(ctx: CommandContext, key: string, db: BotDatabase): void {
  const state = pagers.get(key);
  if (!state) {
    ctx.reply('.modlog: no active query — run `.modlog [filter...]` first');
    return;
  }
  // Re-snapshot the total so `.modlog top` is the canonical "refresh" verb.
  const fresh = beginQuery(state.filter, db);
  pagers.set(key, fresh);
  reply(ctx, renderPage(fresh, db));
}

function runEnd(ctx: CommandContext, key: string, db: BotDatabase): void {
  const state = pagers.get(key);
  if (!state) {
    ctx.reply('.modlog: no active query — run `.modlog [filter...]` first');
    return;
  }
  // Walk forward in PAGE_SIZE steps until exhausted. Bounded by the snapshot
  // total so a runaway filter can't loop indefinitely.
  const maxIterations = Math.ceil(state.totalAtFirstQuery / PAGE_SIZE) + 2;
  let safety = 0;
  while (safety++ < maxIterations) {
    if (state.rows.length === 0) break;
    const lastId = state.rows[state.rows.length - 1].id;
    const next = db.getModLog({ ...state.filter, beforeId: lastId, limit: PAGE_SIZE });
    if (next.length === 0) break;
    state.pageStack.push({ firstId: state.rows[0].id, lastId });
    updatePagerState(state, next, state.pageEnd + 1);
  }
  reply(ctx, renderPage(state, db));
}

function runShow(
  ctx: CommandContext,
  arg: string,
  db: BotDatabase,
  perm: ModlogPermissionResult,
): void {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) {
    ctx.reply('.modlog show: usage `.modlog show <id>`');
    return;
  }
  const row = db.getModLogById(id);
  if (!row) {
    ctx.reply(`.modlog show: no row with id ${id}`);
    return;
  }
  // Reapply the permission scope so a master can't fetch arbitrary IDs
  // outside the channels they op.
  if (perm.channelScope) {
    const allowed = new Set(perm.channelScope.map((c) => c.toLowerCase()));
    if (!row.channel || !allowed.has(row.channel.toLowerCase())) {
      ctx.reply('.modlog show: permission denied for that row');
      return;
    }
  }
  const ts = new Date(row.timestamp * 1000).toISOString();
  const lines: string[] = [
    `Row #${row.id}`,
    `  when:    ${ts} (${relativeTime(row.timestamp)})`,
    `  action:  ${row.action}`,
    `  source:  ${row.source}${row.plugin ? ` (plugin=${row.plugin})` : ''}`,
    `  by:      ${row.by ?? '—'}`,
    `  channel: ${row.channel ?? '—'}`,
    `  target:  ${row.target ?? '—'}`,
    `  outcome: ${row.outcome}`,
    `  reason:  ${row.reason ?? '—'}`,
  ];
  if (row.metadata) {
    // Strip formatting on the JSON dump — metadata values can contain
    // arbitrary nick / message content that an attacker may have seeded
    // with mIRC color codes hoping to spoof an operator console line.
    lines.push(`  metadata: ${stripFormatting(JSON.stringify(row.metadata))}`);
  }
  reply(ctx, lines);
}

function reply(ctx: CommandContext, lines: string[]): void {
  for (const line of lines) ctx.reply(line);
}

/** Compile an in-memory matcher from a parsed filter — used by `.audit-tail`. */
function makeMatcher(filter: ModLogFilter): (entry: ModLogEntry) => boolean {
  return (e) => {
    if (filter.action && e.action !== filter.action) return false;
    if (filter.target && e.target !== filter.target) return false;
    if (filter.channel && (e.channel ?? '').toLowerCase() !== filter.channel.toLowerCase()) {
      return false;
    }
    if (filter.source && e.source !== filter.source) return false;
    if (filter.plugin && e.plugin !== filter.plugin) return false;
    if (filter.by && e.by !== filter.by) return false;
    if (filter.outcome && e.outcome !== filter.outcome) return false;
    if (filter.sinceTimestamp != null && e.timestamp < filter.sinceTimestamp) return false;
    if (filter.grep) {
      const blob = `${e.reason ?? ''} ${e.metadata ? JSON.stringify(e.metadata) : ''}`;
      if (!blob.toLowerCase().includes(filter.grep.toLowerCase())) return false;
    }
    return true;
  };
}
