// HexBot — Shared help view builders (Services / ChanServ-style)
//
// One view module for both transports — the IRC `!help` plugin and
// the core `.help` built-in (REPL / DCC / IRC dot-commands). Inputs are
// the unified {@link HelpRegistry} corpus; outputs are arrays of
// already-formatted lines that each transport sends through its own
// channel (NOTICE / PRIVMSG / ctx.reply). All layout conventions (wrap
// widths, indents, label casing, row alignment, block separation) live
// in `help-format` — every view here composes those primitives, so the
// whole help system reads as one page style.
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
//     scope view lists dotted-prefix topics in the base-index shape, with
//     flat and single-member keys folded under a synthetic OTHER topic; a
//     topic view expands one prefix (or OTHER); a leaf key resolves to
//     the normal command-detail path.
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
//   - {@link renderNotFound}         — uniform not-found / denied reply
//   - {@link indexIntro}             — standard bare-index intro paragraph
import type { HandlerContext, HelpEntry, HelpRegistryView } from '../types';
import { ROW_INDENT, alignedRows, helpPage, prose, sectionLabel, titleLine } from './help-format';

/**
 * Permissions surface needed by the renderer. Pass `null` to skip flag
 * gating entirely — used by the REPL transport, which is already trust-
 * boundary protected (only the operator can read `bot.json`).
 */
export interface RenderPermissions {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/**
 * Label of the synthetic scope topic collecting flat keys and
 * single-member dotted prefixes — one row instead of a topic per stray
 * key. Matched case-insensitively on expansion (`.help set core other`).
 */
const OTHER_TOPIC = 'other';

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
 * reaches here — Priority 1 resolves it as a leaf command first. The
 * synthetic OTHER topic resolves when the scope has bucketed keys and no
 * real `other`-prefixed keys shadow it.
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
  const keys = scopeEntries.filter((e) => !isScopeHeaderEntry(e, scope));
  const hasGroupKeys = keys.some((e) => {
    const keyName = extractKeyName(e.command, scope);
    return keyName === group || keyName.startsWith(`${group}.`);
  });
  if (!hasGroupKeys) {
    const isOtherTopic =
      group.toLowerCase() === OTHER_TOPIC && foldKeysByPrefix(keys, scope).other.length > 0;
    if (!isOtherTopic) return null;
  }
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

/**
 * Standard bare-index intro paragraph — the ChanServ-style opener both
 * transports share. {@link renderIndex} falls back to this when the
 * caller passes an empty header, so the wording lives here once rather
 * than drifting between the core `.help` built-in and the `!help`
 * plugin's operator-configurable header.
 */
export function indexIntro(prefix: string): string {
  return (
    'HexBot allows you to manage and control various aspects of ' +
    'the bot and its channels. Available command topics are ' +
    `listed below; to use a command, type ${prefix}command. For more ` +
    `information on a specific topic, type ${prefix}help topic; for a ` +
    `specific command, type ${prefix}help topic command.`
  );
}

/**
 * Uniform not-found reply. Also used for permission-denied lookups so
 * privileged commands don't leak by shape difference — both transports
 * must send exactly this line for both cases.
 */
export function renderNotFound(query: string, prefix: string): string {
  return `No help for "${query}" — type ${prefix}help for a list of commands`;
}

/** Options driving the bare-index render. */
export interface RenderIndexOptions {
  /** True for the terse packed-names view; false for the full aligned view. */
  compact: boolean;
  /**
   * Header shown above the index — the intro paragraph in the full view,
   * the lead of the one-line banner in compact mode. Empty falls back to
   * {@link indexIntro} (full) or a short product banner (compact).
   */
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

  if (opts.compact) {
    const lines: string[] = [];
    const banner = opts.header || 'HexBot Commands';
    lines.push(`${banner} — ${opts.prefix}help <category> or ${opts.prefix}help <command>`);
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
  const topics: Array<[string, string]> = [...groups.entries()].map(([category, group]) => [
    sectionLabel(category),
    topicDescription(category, group, opts.prefix),
  ]);
  return helpPage(
    prose(opts.header || indexIntro(opts.prefix)),
    alignedRows(topics),
    scopeNames.length > 0
      ? prose(`Configuration: ${scopeNames.join(' ')} — ${opts.prefix}help set <scope>`)
      : [],
    opts.footer ? [opts.footer] : [],
  );
}

/**
 * Render the per-command detail view — the ChanServ `Syntax:` shape.
 * `Syntax:` line, the wrapped description with any `detail[]` lines
 * indented beneath it, then a `Requires:` block for flagged commands.
 */
export function renderCommand(entry: HelpEntry): string[] {
  const body = prose(entry.description);
  for (const line of entry.detail ?? []) {
    body.push(`${ROW_INDENT}${line}`);
  }
  return helpPage(
    [`Syntax: ${entry.usage}`],
    body,
    entry.flags !== '-' ? [`Requires: ${entry.flags}`] : [],
  );
}

/**
 * Render a non-scope topic view — the ChanServ `HELP SET` shape. An
 * uppercased label (with the topic blurb when one exists), a blank line,
 * one aligned `name  description` row per command, then a wrapped hint
 * pointing at the `help <topic> <command>` drill-down.
 */
export function renderCategory(category: string, entries: HelpEntry[], prefix: string): string[] {
  return helpPage(
    titleLine(category, TOPIC_DESCRIPTIONS[category.toLowerCase()]),
    alignedRows(
      entries.map((entry) => [stripCommandPrefix(entry.command, prefix), entry.description]),
    ),
    prose(
      `Type ${prefix}help ${category.toLowerCase()} <command> for more information on a particular command.`,
    ),
  );
}

/**
 * Render the settings-scope view — `!help set core` style. Two shapes:
 *
 *   - Folded (no `group`): the base-index shape — one aligned row per
 *     multi-member dotted prefix (uppercased topic label, member key
 *     names as the description), with flat keys and single-member
 *     prefixes folded under a synthetic OTHER topic. A scope with no
 *     multi-member prefixes lists its keys directly instead of showing
 *     an OTHER-only table.
 *   - Expanded (`group` set): the keys under `<group>.*` listed in full,
 *     aligned name + description; `other` expands the OTHER bucket.
 *     Tail points at per-key detail.
 */
export function renderScope(
  scope: string,
  header: HelpEntry | null,
  entries: HelpEntry[],
  prefix: string,
  group?: string,
): string[] {
  const keys = entries.filter((e) => !isScopeHeaderEntry(e, scope));
  const keyRows = (list: HelpEntry[]): Array<[string, string]> =>
    list.map((e) => [extractKeyName(e.command, scope), e.description]);
  const keyHint = `Type ${prefix}help set ${scope} <key> for more information on a particular key.`;

  if (group !== undefined) {
    let groupKeys = keys.filter((e) => {
      const name = extractKeyName(e.command, scope);
      return name === group || name.startsWith(`${group}.`);
    });
    // Real `other.*` keys shadow the synthetic topic — the bucket only
    // answers when the literal match came up empty.
    if (groupKeys.length === 0 && group.toLowerCase() === OTHER_TOPIC) {
      groupKeys = foldKeysByPrefix(keys, scope).other;
    }
    return helpPage(
      titleLine(`${scope} settings / ${group}`, countLabel(groupKeys.length)),
      alignedRows(keyRows(groupKeys)),
      groupKeys.length > 0 ? prose(keyHint) : [],
    );
  }

  const blurb = header?.description
    ? `${header.description} (${countLabel(keys.length)})`
    : countLabel(keys.length);
  const title = titleLine(`${scope} settings`, blurb);

  const { grouped, other } = foldKeysByPrefix(keys, scope);
  if (grouped.size === 0) {
    // No multi-member prefixes — every key is a "single", so an
    // OTHER-only table would just add a hop. List them directly.
    return helpPage(title, alignedRows(keyRows(other)), other.length > 0 ? prose(keyHint) : []);
  }

  const topics: Array<[string, string]> = [...grouped.entries()].map(([g, ks]) => [
    sectionLabel(g),
    ks.map((e) => extractKeyName(e.command, scope).slice(g.length + 1)).join(', '),
  ]);
  if (other.length > 0) {
    topics.push([
      sectionLabel(OTHER_TOPIC),
      other.map((e) => extractKeyName(e.command, scope)).join(', '),
    ]);
  }
  return helpPage(
    title,
    alignedRows(topics),
    prose(
      `Type ${prefix}help set ${scope} <topic> for the keys in a topic, or ${prefix}help set ${scope} <key> for more information on a particular key.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** `1 key` / `N keys` — singular-aware count label for scope titles. */
function countLabel(count: number): string {
  return count === 1 ? '1 key' : `${count} keys`;
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

/**
 * Partition scope key entries into multi-member dotted-prefix topics and
 * the `other` bucket. `logging.level` / `logging.file` fold under
 * `logging`; non-dotted keys (`enabled`) and prefixes with a single
 * member land in `other` — the folded view groups those under one OTHER
 * row rather than spending a topic on a lone key. Two passes so both
 * partitions preserve registration order.
 */
function foldKeysByPrefix(
  keys: HelpEntry[],
  scope: string,
): { grouped: Map<string, HelpEntry[]>; other: HelpEntry[] } {
  const memberCounts = new Map<string, number>();
  for (const e of keys) {
    const p = dottedPrefix(extractKeyName(e.command, scope));
    if (p !== null) memberCounts.set(p, (memberCounts.get(p) ?? 0) + 1);
  }
  const grouped = new Map<string, HelpEntry[]>();
  const other: HelpEntry[] = [];
  for (const e of keys) {
    const p = dottedPrefix(extractKeyName(e.command, scope));
    if (p === null || (memberCounts.get(p) ?? 0) < 2) {
      other.push(e);
      continue;
    }
    const list = grouped.get(p) ?? [];
    list.push(e);
    grouped.set(p, list);
  }
  return { grouped, other };
}

/**
 * First dotted segment of a key name (`logging.level` → `logging`), or
 * null when there is no real prefix — no dot, or a leading-dot misfiled
 * entry whose full name should survive rather than folding under "".
 */
function dottedPrefix(name: string): string | null {
  const dot = name.indexOf('.');
  return dot <= 0 ? null : name.slice(0, dot);
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
