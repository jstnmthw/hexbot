// HexBot — Shared help renderer (Services / ChanServ-style)
//
// One renderer module for both transports — the IRC `!help` plugin and
// the core `.help` built-in (REPL / DCC / IRC dot-commands). Inputs are
// the unified {@link HelpRegistry} corpus; outputs are arrays of
// already-formatted lines that each transport sends through its own
// channel (NOTICE / PRIVMSG / ctx.reply).
//
// Display model (mirrors network services like ChanServ/NickServ):
//   - The bare index opens with a wrapped intro paragraph, then lists the
//     available *topics* only — uppercased, with a short description
//     aligned beside each. Individual commands never appear here.
//   - A topic view (`help irc`) lists that topic's commands with aligned
//     descriptions and points at `help <topic> <command>` for detail.
//   - Per-command detail opens with a `Syntax:` line, then the description,
//     any `detail[]` lines, then a `Requires:` line.
//   - Settings scopes are a sub-tree: the index points at `.help set`; a
//     scope view folds keys by dotted prefix; a group view expands one
//     prefix; a leaf key resolves to the normal command-detail path.
//
// Layered responsibilities:
//   - {@link filterByPermission}     — strip entries the caller may not see
//   - {@link lookup}                 — dispatch a query to one of the result
//                                     kinds (command / category / scope /
//                                     denied / none)
//   - {@link renderIndex}            — bare-index render, scopes folded to a
//                                     single pointer line
//   - {@link renderCommand}          — single-entry `Syntax:` detail
//   - {@link renderCategory}         — non-scope category view
//   - {@link renderScope}            — settings-scope view (folded or expanded)
import type { HandlerContext, HelpEntry, HelpRegistryView } from '../types';

/**
 * Permissions surface needed by the renderer. Pass `null` to skip flag
 * gating entirely — used by the REPL transport, which is already trust-
 * boundary protected (only the operator can read `bot.json`).
 */
export interface RenderPermissions {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/** Column gap (spaces) between the name column and the description column. */
const COLUMN_GAP = 2;

/** Left indent for aligned list rows — four spaces, per services convention. */
const ROW_INDENT = '    ';

/** Wrap width for prose lines (intro paragraph, descriptions, footers). */
const WRAP_WIDTH = 60;

/** Total line budget for an aligned row before its description wraps. */
const ROW_WIDTH = 72;

/** Soft wrap width used when packing the folded settings-group grid. */
const GRID_WIDTH = 72;

/**
 * Short blurbs for the core command topics shown beside each uppercased
 * label in the bare index. Topics with no entry here (plugin-defined
 * categories like `fun`) fall back to a comma-joined list of their
 * command names — still tells the reader what lives inside without core
 * having to know plugin vocabulary.
 */
const TOPIC_DESCRIPTIONS: Record<string, string> = {
  general: 'Basic bot commands',
  permissions: 'Bot user accounts and access flags',
  dispatcher: 'Inspect the event dispatcher binds',
  irc: 'Channel presence and messaging',
  plugins: 'Load, unload, and reload plugins',
  settings: 'Live configuration and channel settings',
  audit: 'Moderation audit log',
  dcc: 'DCC console sessions',
  memo: 'MemoServ proxy',
  botlink: 'Botnet links and remote bots',
  moderation: 'Channel bans and enforcement',
};

/**
 * Greedy word-wrap `text` to `width` columns. Words longer than `width`
 * land on their own line unbroken — hostmasks and setting keys are more
 * useful intact than split mid-token. Returns `[]` for empty/blank input.
 */
export function wrapText(text: string, width: number): string[] {
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

/**
 * Filter `entries` down to those the caller may see. Unflagged entries
 * (`'-'`) pass through unconditionally; flagged entries hit `perms`.
 * `null` perms returns the input unchanged (REPL trusted-console path).
 */
export function filterByPermission(
  entries: HelpEntry[],
  ctx: HandlerContext,
  perms: RenderPermissions | null,
): HelpEntry[] {
  if (!perms) return entries;
  return entries.filter((e) => e.flags === '-' || perms.checkFlags(e.flags, ctx));
}

/**
 * True for the synthetic scope-header entry registered by `SettingsRegistry`
 * — the trigger is the bare scope command (`.set core`, `.set chanmod`)
 * with no trailing key. Used to peel headers out of the per-scope key
 * listing in the bare index and the scope view.
 */
export function isScopeHeaderEntry(entry: HelpEntry, scope: string): boolean {
  const segments = entry.command.trim().split(/\s+/);
  return segments.length === 2 && segments[1] === scope;
}

// ---------------------------------------------------------------------------
// Lookup dispatch
// ---------------------------------------------------------------------------

/**
 * Outcome of a `!help <query>` / `.help <query>` lookup. Transports map
 * each kind to the right renderer call.
 */
export type LookupResult =
  | { kind: 'command'; entry: HelpEntry }
  | { kind: 'category'; category: string; entries: HelpEntry[] }
  | {
      kind: 'scope';
      scope: string;
      header: HelpEntry | null;
      entries: HelpEntry[];
      /** Dotted-prefix group to expand (`.help set core logging`); folded view when absent. */
      group?: string;
    }
  | { kind: 'denied'; query: string }
  | { kind: 'none'; query: string };

/**
 * Resolve a help query through the unified corpus. Resolution priority:
 *
 *   1. Exact command match — biased toward the active prefix. Bare
 *      queries try `${prefix}${query}` first so `.help ban` from REPL
 *      resolves to `.ban` (admin) rather than `!ban` (channel-op), and
 *      `!help ban` from a channel resolves to `!ban` rather than
 *      `.ban`. Cross-prefix queries (`.help !ban`) reject — only the
 *      active prefix's surface is visible.
 *   2. Scope header detection — when the matched entry is a synthetic
 *      `.set <scope>` header, the lookup pivots to a folded scope view so
 *      `.help set chanmod` lists the scope's keys instead of dumping the
 *      bare command line.
 *   3. Settings group expansion — `.help set core logging` pivots to a
 *      scope view filtered to the `logging.*` keys when no exact command
 *      matched but the third token names a dotted-prefix group.
 *   4. Topic drill-down — `.help irc say` resolves the trailing tokens as
 *      a command and matches when that command lives under the leading
 *      topic. The ChanServ `HELP SET EMAIL` shape.
 *   5. Category match — falls through when no command matched and the
 *      query case-folds to a category label. Filtered by prefix so
 *      `.help moderation` shows `.ban`/`.unban`/`.bans` and
 *      `!help moderation` shows `!ban`/`!op`/`!kick`/etc.
 *   6. None.
 *
 * Permission gating: matched commands the caller cannot see resolve to
 * `denied` (renderer turns this into the same `No help for "<query>"`
 * line the not-found path uses, so privileged commands don't leak by
 * shape difference); category and scope views filter their entries
 * through {@link filterByPermission}, returning `none` if nothing
 * survives.
 */
export function lookup(
  registry: HelpRegistryView,
  query: string,
  ctx: HandlerContext,
  perms: RenderPermissions | null,
  prefix: string,
): LookupResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'none', query };

  // Priority 1: command match — biased toward the active prefix.
  // Bare queries try the prefix-qualified form first; explicit-prefix
  // queries resolve directly. Wrong-prefix entries are rejected so
  // cross-surface lookups don't leak.
  const queryHasPrefix = trimmed.startsWith('!') || trimmed.startsWith('.');
  let entry: HelpEntry | undefined;
  if (queryHasPrefix) {
    entry = registry.get(trimmed);
  } else {
    entry = registry.get(`${prefix}${trimmed}`) ?? registry.get(trimmed);
  }
  if (entry && !commandMatchesPrefix(entry.command, prefix)) {
    entry = undefined;
  }
  if (entry) {
    const cat = entry.category ?? entry.pluginId ?? '';
    // Scope header → pivot to the folded scope view so the listing of
    // keys lands instead of a one-line command-detail render.
    if (cat.startsWith('set:')) {
      const scope = cat.slice(4);
      if (isScopeHeaderEntry(entry, scope)) {
        const scopeEntries = collectScopeEntries(registry, scope, prefix, ctx, perms);
        if (scopeEntries.length > 0) {
          return { kind: 'scope', scope, header: entry, entries: scopeEntries };
        }
      }
    }
    // Permission gate
    if (entry.flags === '-' || !perms || perms.checkFlags(entry.flags, ctx)) {
      return { kind: 'command', entry };
    }
    return { kind: 'denied', query };
  }

  // Priority 3: settings group expansion — `set <scope> <group>` where
  // `<group>.*` names live keys but `<scope> <group>` is not itself a key.
  const groupResult = resolveSettingsGroup(registry, trimmed, prefix, ctx, perms);
  if (groupResult) return groupResult;

  // Priority 4: `<topic> <command>` drill-down.
  const drillResult = resolveTopicCommand(registry, trimmed, prefix, ctx, perms);
  if (drillResult) return drillResult;

  // Priority 5: category match (prefix-filtered, then permission-filtered).
  const visible = filterByPermission(
    registry.getAll().filter((e) => commandMatchesPrefix(e.command, prefix)),
    ctx,
    perms,
  );
  const categoryEntries = visible.filter(
    (e) => (e.category ?? e.pluginId ?? '').toLowerCase() === trimmed.toLowerCase(),
  );
  if (categoryEntries.length > 0) {
    const actualCategory = categoryEntries[0].category ?? categoryEntries[0].pluginId ?? '';
    if (actualCategory.startsWith('set:')) {
      const scope = actualCategory.slice(4);
      const header = categoryEntries.find((e) => isScopeHeaderEntry(e, scope)) ?? null;
      return { kind: 'scope', scope, header, entries: categoryEntries };
    }
    return { kind: 'category', category: actualCategory, entries: categoryEntries };
  }

  return { kind: 'none', query };
}

/**
 * Gather the permission-filtered entries belonging to `set:<scope>` under
 * the active prefix. Shared by the scope-header pivot and group expansion.
 */
function collectScopeEntries(
  registry: HelpRegistryView,
  scope: string,
  prefix: string,
  ctx: HandlerContext,
  perms: RenderPermissions | null,
): HelpEntry[] {
  return filterByPermission(
    registry
      .getAll()
      .filter(
        (e) =>
          (e.category ?? e.pluginId ?? '') === `set:${scope}` &&
          commandMatchesPrefix(e.command, prefix),
      ),
    ctx,
    perms,
  );
}

/**
 * Resolve `set <scope> <group>` to a scope view expanded to the group's
 * keys. Returns null when the query isn't a settings-group shape, the
 * scope is unknown/empty under this prefix, or `<group>` matches no
 * dotted-prefix keys. `<scope> <group>` that is itself a full key never
 * reaches here — Priority 1 resolves it as a leaf command first.
 */
function resolveSettingsGroup(
  registry: HelpRegistryView,
  trimmed: string,
  prefix: string,
  ctx: HandlerContext,
  perms: RenderPermissions | null,
): LookupResult | null {
  const tokens = trimmed.replace(/^[!.]/, '').split(/\s+/);
  if (tokens.length < 3 || tokens[0].toLowerCase() !== 'set') return null;
  const scope = tokens[1];
  const group = tokens.slice(2).join(' ');
  const scopeEntries = collectScopeEntries(registry, scope, prefix, ctx, perms);
  if (scopeEntries.length === 0) return null;
  const hasGroupKeys = scopeEntries.some((e) => {
    if (isScopeHeaderEntry(e, scope)) return false;
    const keyName = extractKeyName(e.command, scope);
    return keyName === group || keyName.startsWith(`${group}.`);
  });
  if (!hasGroupKeys) return null;
  const header = scopeEntries.find((e) => isScopeHeaderEntry(e, scope)) ?? null;
  return { kind: 'scope', scope, header, entries: scopeEntries, group };
}

/**
 * Resolve `<topic> <command>` to that command's detail — the ChanServ
 * `HELP SET EMAIL` drill-down shape (`.help irc say`, `!help fun 8ball`).
 * The trailing tokens resolve through the same prefix-biased command
 * lookup as a bare query, but the match only counts when the entry
 * actually lives under the named topic — `.help irc flags` must not
 * silently alias into PERMISSIONS. Flagged-out matches resolve to
 * `denied` so privileged commands don't leak by shape difference.
 * Returns null (fall through) when the query isn't this shape.
 */
function resolveTopicCommand(
  registry: HelpRegistryView,
  trimmed: string,
  prefix: string,
  ctx: HandlerContext,
  perms: RenderPermissions | null,
): LookupResult | null {
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;
  const topic = tokens[0].toLowerCase();
  const rest = tokens.slice(1).join(' ');
  const restHasPrefix = rest.startsWith('!') || rest.startsWith('.');
  const entry = restHasPrefix
    ? registry.get(rest)
    : (registry.get(`${prefix}${rest}`) ?? registry.get(rest));
  if (!entry || !commandMatchesPrefix(entry.command, prefix)) return null;
  if ((entry.category ?? entry.pluginId ?? '').toLowerCase() !== topic) return null;
  if (entry.flags === '-' || !perms || perms.checkFlags(entry.flags, ctx)) {
    return { kind: 'command', entry };
  }
  return { kind: 'denied', query: trimmed };
}

/**
 * True when the entry's command trigger uses the active prefix. Isolates
 * `.help` (REPL/admin dot-command) and `!help` (channel bang-command)
 * corpora — each transport surfaces only its own commands. Multi-word
 * commands like `.set core logging.level` still test the leading
 * character so the whole settings tree stays bound to `.`.
 */
function commandMatchesPrefix(command: string, prefix: string): boolean {
  return command.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Options driving the bare-index render. */
export interface RenderIndexOptions {
  /** True for the terse packed-names view; false for the full aligned view. */
  compact: boolean;
  /** Header line shown above the index. */
  header: string;
  /** Footer line shown after the full listing. Ignored in compact mode. */
  footer: string;
  /** Command prefix used in the intro hint and name-stripping (`!` / `.`). */
  prefix: string;
}

/**
 * Render the bare `!help` / `.help` index. The full (verbose) view is the
 * ChanServ base-help shape: the `header` paragraph wrapped to prose width,
 * then one aligned row per *topic* — uppercased label plus a short
 * description. Individual commands live one level down in the topic view.
 * The compact view keeps the terse one-line-per-category packing. `set:*`
 * categories collapse to a single `Configuration:` pointer line so the
 * index isn't swamped by hundreds of setting keys. Returns the empty
 * `["No commands available."]` line when nothing is visible to the caller.
 */
export function renderIndex(entries: HelpEntry[], opts: RenderIndexOptions): string[] {
  if (entries.length === 0) {
    return ['No commands available.'];
  }

  const groups = new Map<string, HelpEntry[]>();
  const scopeNames: string[] = [];
  const seenScopes = new Set<string>();

  for (const entry of entries) {
    const cat = entry.category ?? entry.pluginId ?? '';
    if (cat.startsWith('set:')) {
      const scope = cat.slice(4);
      if (!seenScopes.has(scope)) {
        seenScopes.add(scope);
        scopeNames.push(scope);
      }
      continue;
    }
    const list = groups.get(cat) ?? [];
    list.push(entry);
    groups.set(cat, list);
  }

  const lines: string[] = [];
  if (opts.compact) {
    lines.push(`${opts.header} — ${opts.prefix}help <category> or ${opts.prefix}help <command>`);
    for (const [category, group] of groups) {
      const names = group.map((e) => stripCommandPrefix(e.command, opts.prefix)).join(' ');
      lines.push(` ${sectionLabel(category)}  ${names}`);
    }
    if (scopeNames.length > 0) {
      // `CONFIG`, not `SETTINGS` — the `settings` command category already
      // owns a `SETTINGS` section; this line points at the `set:*` scope tree.
      lines.push(` CONFIG  ${scopeNames.join(' ')} — ${opts.prefix}help set <scope>`);
    }
    return lines;
  }

  // Full view: wrapped intro paragraph, then the topics as one contiguous
  // aligned block — no per-command rows at this level.
  if (opts.header) {
    lines.push(...wrapText(opts.header, WRAP_WIDTH));
    lines.push(' ');
  }
  if (groups.size > 0) {
    const labelWidth = Math.max(...[...groups.keys()].map((c) => sectionLabel(c).length));
    for (const [category, group] of groups) {
      lines.push(
        ...alignedRow(
          sectionLabel(category),
          topicDescription(category, group, opts.prefix),
          labelWidth,
        ),
      );
    }
  }
  if (scopeNames.length > 0) {
    lines.push(' ');
    lines.push(
      ...wrapText(
        `Configuration: ${scopeNames.join(' ')} — ${opts.prefix}help set <scope>`,
        WRAP_WIDTH,
      ),
    );
  }
  if (opts.footer) {
    lines.push(' ');
    lines.push(opts.footer);
  }
  return lines;
}

/**
 * Render the per-command detail view — the ChanServ `Syntax:` shape.
 * `Syntax:` line, the wrapped description, any per-line `detail[]`, then
 * a `Requires:` line for flagged commands.
 */
export function renderCommand(entry: HelpEntry): string[] {
  const lines: string[] = [
    `Syntax: ${entry.usage}`,
    ' ',
    ...wrapText(entry.description, WRAP_WIDTH),
  ];
  if (entry.detail) {
    for (const line of entry.detail) {
      lines.push(`  ${line}`);
    }
  }
  if (entry.flags !== '-') {
    lines.push(`Requires: ${entry.flags}`);
  }
  return lines;
}

/**
 * Render a non-scope topic view — the ChanServ `HELP SET` shape. An
 * uppercased label (with the topic blurb when one exists), a blank line,
 * one aligned `name  description` row per command, then a wrapped hint
 * pointing at the `help <topic> <command>` drill-down.
 */
export function renderCategory(category: string, entries: HelpEntry[], prefix: string): string[] {
  const nameWidth = maxNameWidth(entries, prefix);
  const label = sectionLabel(category);
  const blurb = TOPIC_DESCRIPTIONS[category.toLowerCase()];
  const lines: string[] = [blurb ? `${label} — ${blurb}` : label, ' '];
  for (const entry of entries) {
    lines.push(
      ...alignedRow(stripCommandPrefix(entry.command, prefix), entry.description, nameWidth),
    );
  }
  lines.push(' ');
  lines.push(
    ...wrapText(
      `Type ${prefix}help ${category.toLowerCase()} <command> for more information on a particular command.`,
      WRAP_WIDTH,
    ),
  );
  return lines;
}

/**
 * Render the settings-scope view — `!help set chanmod` style. Two shapes:
 *
 *   - Folded (no `group`): keys grouped by dotted prefix (`logging.*`,
 *     `queue.*`) shown as a packed count grid, with any non-dotted keys
 *     listed directly. Tail points at expanding a group.
 *   - Expanded (`group` set): the keys under `<group>.*` listed in full,
 *     aligned name + description. Tail points at per-key detail.
 */
export function renderScope(
  scope: string,
  header: HelpEntry | null,
  entries: HelpEntry[],
  prefix: string,
  group?: string,
): string[] {
  const keys = entries.filter((e) => !isScopeHeaderEntry(e, scope));

  if (group !== undefined) {
    const groupKeys = keys.filter((e) => {
      const name = extractKeyName(e.command, scope);
      return name === group || name.startsWith(`${group}.`);
    });
    const width = maxKeyWidth(groupKeys, scope);
    const lines: string[] = [`${scope} / ${group} — ${countLabel(groupKeys.length)}`, ' '];
    for (const e of groupKeys) {
      lines.push(...alignedRow(extractKeyName(e.command, scope), e.description, width));
    }
    if (groupKeys.length > 0) {
      lines.push(`Type ${prefix}help set ${scope} <key> for one key's detail.`);
    }
    return lines;
  }

  const titleSuffix = header?.description ? ` — ${header.description}` : '';
  const lines: string[] = [`${scope} settings — ${countLabel(keys.length)}${titleSuffix}`];

  const { grouped, flat } = foldKeysByPrefix(keys, scope);
  if (grouped.size > 0) {
    lines.push(' ');
    lines.push(...renderGroupGrid(grouped));
  }
  if (flat.length > 0) {
    lines.push(' ');
    const width = maxKeyWidth(flat, scope);
    for (const e of flat) {
      lines.push(...alignedRow(extractKeyName(e.command, scope), e.description, width));
    }
  }
  if (keys.length > 0) {
    lines.push(
      grouped.size > 0
        ? `Type ${prefix}help set ${scope} <group> to expand, or <key> for detail.`
        : `Type ${prefix}help set ${scope} <key> for detail.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Uppercase a category label for the ChanServ-style section header. */
function sectionLabel(category: string): string {
  return category.toUpperCase();
}

/** `1 key` / `N keys` — singular-aware count label for scope titles. */
function countLabel(count: number): string {
  return count === 1 ? '1 key' : `${count} keys`;
}

/**
 * One aligned table row: four-space indent, `name` padded to `width`, a
 * `COLUMN_GAP` gutter, then `description`. Descriptions that would push
 * the line past {@link ROW_WIDTH} wrap onto continuation lines indented
 * to the description column — the ChanServ ENTRYMSG shape. The help
 * output carries no IRC formatting; rows read as a plain scan list.
 */
function alignedRow(name: string, description: string, width: number): string[] {
  const pad = ' '.repeat(Math.max(1, width - name.length + COLUMN_GAP));
  const descColumn = ROW_INDENT.length + width + COLUMN_GAP;
  const wrapped = wrapText(description, Math.max(24, ROW_WIDTH - descColumn));
  if (wrapped.length === 0) return [`${ROW_INDENT}${name}`];
  const [first, ...rest] = wrapped;
  const contIndent = ' '.repeat(descColumn);
  return [`${ROW_INDENT}${name}${pad}${first}`, ...rest.map((line) => `${contIndent}${line}`)];
}

/**
 * Description shown beside a topic label in the bare index — the curated
 * core blurb when one exists, else the topic's command names joined into
 * a scan list (plugin-defined topics document themselves this way).
 */
function topicDescription(category: string, group: HelpEntry[], prefix: string): string {
  return (
    TOPIC_DESCRIPTIONS[category.toLowerCase()] ??
    group.map((e) => stripCommandPrefix(e.command, prefix)).join(', ')
  );
}

/** Widest prefix-stripped command name across `entries` (0 when empty). */
function maxNameWidth(entries: HelpEntry[], prefix: string): number {
  let max = 0;
  for (const e of entries) {
    const len = stripCommandPrefix(e.command, prefix).length;
    if (len > max) max = len;
  }
  return max;
}

/** Widest extracted key name across scope `entries` (0 when empty). */
function maxKeyWidth(entries: HelpEntry[], scope: string): number {
  let max = 0;
  for (const e of entries) {
    const len = extractKeyName(e.command, scope).length;
    if (len > max) max = len;
  }
  return max;
}

/**
 * Partition scope key entries into dotted-prefix groups and non-dotted
 * "flat" keys. `logging.level` / `logging.file` fold under `logging`;
 * `enabled` stays flat and is listed directly. Insertion order is
 * preserved so the grid and flat list follow registration order.
 */
function foldKeysByPrefix(
  keys: HelpEntry[],
  scope: string,
): { grouped: Map<string, HelpEntry[]>; flat: HelpEntry[] } {
  const grouped = new Map<string, HelpEntry[]>();
  const flat: HelpEntry[] = [];
  for (const e of keys) {
    const name = extractKeyName(e.command, scope);
    const dot = name.indexOf('.');
    // dot === 0 is a leading-dot / misfiled entry with no real prefix —
    // keep it flat so its full name survives rather than folding under "".
    if (dot <= 0) {
      flat.push(e);
      continue;
    }
    const p = name.slice(0, dot);
    const list = grouped.get(p) ?? [];
    list.push(e);
    grouped.set(p, list);
  }
  return { grouped, flat };
}

/**
 * Render the folded group grid — `<prefix>.* <count>` cells packed several
 * per line within {@link GRID_WIDTH}. Cells share a fixed width so counts
 * line up across rows.
 */
function renderGroupGrid(grouped: Map<string, HelpEntry[]>): string[] {
  const entries = [...grouped.entries()];
  const labelWidth = Math.max(...entries.map(([g]) => `${g}.*`.length));
  const countWidth = Math.max(...entries.map(([, ks]) => String(ks.length).length));
  const cells = entries.map(
    ([g, ks]) => `${`${g}.*`.padEnd(labelWidth)} ${String(ks.length).padStart(countWidth)}`,
  );
  const cellWidth = labelWidth + 1 + countWidth;
  const gap = 4;
  const cols = Math.max(1, Math.floor((GRID_WIDTH + gap) / (cellWidth + gap)));
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(`${ROW_INDENT}${cells.slice(i, i + cols).join(' '.repeat(gap))}`);
  }
  return rows;
}

/**
 * Drop a single leading `prefix` character (or the whole multi-char
 * prefix) from `command` so index rows render bare command names
 * (`8ball` rather than `!8ball`). Multi-word commands keep the rest intact.
 */
function stripCommandPrefix(command: string, prefix: string): string {
  if (prefix.length === 1 && command.startsWith(prefix)) {
    return command.slice(1);
  }
  if (command.startsWith(prefix)) {
    return command.slice(prefix.length);
  }
  return command;
}

/**
 * Extract the key name from a settings command (`.set chanmod auto_op` →
 * `auto_op`). Falls back to the full command tail when the shape doesn't
 * match — a defensive default since the renderer is consumed by both
 * core code (where shapes are guaranteed) and operator-facing transports
 * (where format drift would still need a sensible render).
 */
function extractKeyName(command: string, scope: string): string {
  const segments = command.trim().split(/\s+/);
  // Expect: [prefix-set, scope, ...key-segments]. We strip the first two.
  if (segments.length < 3) return command;
  if (segments[1] !== scope) return command;
  return segments.slice(2).join(' ');
}
