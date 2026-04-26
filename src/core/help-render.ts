// HexBot — Shared help renderer
//
// One renderer module for both transports — the IRC `!help` plugin and
// the core `.help` built-in (REPL / DCC / IRC dot-commands). Inputs are
// the unified {@link HelpRegistry} corpus; outputs are arrays of
// already-formatted lines that each transport sends through its own
// channel (NOTICE / PRIVMSG / ctx.reply).
//
// Layered responsibilities:
//   - {@link filterByPermission}     — strip entries the caller may not see
//   - {@link lookup}                 — dispatch a query to one of the four
//                                     result kinds (command / category /
//                                     scope / none)
//   - {@link renderIndex}            — bare-index render with set:* scope
//                                     folding
//   - {@link renderCommand}          — single-entry detail
//   - {@link renderCategory}         — non-scope category view
//   - {@link renderScope}            — settings-scope verbose listing
import type { HandlerContext, HelpEntry, HelpRegistryView } from '../types';

/**
 * Permissions surface needed by the renderer. Pass `null` to skip flag
 * gating entirely — used by the REPL transport, which is already trust-
 * boundary protected (only the operator can read `bot.json`).
 */
export interface RenderPermissions {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/** Bold the trigger (first word) of a usage string, leaving args unbolded. */
export function boldTrigger(usage: string): string {
  const spaceIdx = usage.indexOf(' ');
  if (spaceIdx === -1) return `\x02${usage}\x02`;
  return `\x02${usage.slice(0, spaceIdx)}\x02${usage.slice(spaceIdx)}`;
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
    }
  | { kind: 'denied'; query: string }
  | { kind: 'none'; query: string };

/**
 * Resolve a help query through the unified corpus. Resolution priority:
 *
 *   1. Exact command match (works through `helpRegistry.get` which
 *      strips `!` / `.` and lowercases). For multi-word queries like
 *      `set core logging.level`, the full query is the command name.
 *   2. Scope header detection — when the matched entry is a synthetic
 *      `.set <scope>` header, the lookup pivots to a scope view so
 *      `!help set chanmod` lists the scope's keys instead of dumping
 *      the bare command line.
 *   3. Category match — falls through when no command matched and the
 *      query case-folds to a category label.
 *   4. None.
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
): LookupResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'none', query };

  // Priority 1: command match
  const entry = registry.get(trimmed);
  if (entry) {
    const cat = entry.category ?? entry.pluginId ?? '';
    // Scope header → pivot to scope view so the listing of keys lands
    // instead of a one-line command-detail render.
    if (cat.startsWith('set:')) {
      const scope = cat.slice(4);
      if (isScopeHeaderEntry(entry, scope)) {
        const scopeEntries = filterByPermission(
          registry.getAll().filter((e) => (e.category ?? e.pluginId ?? '') === cat),
          ctx,
          perms,
        );
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

  // Priority 2: category match (permission-filtered)
  const visible = filterByPermission(registry.getAll(), ctx, perms);
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

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Options driving the bare-index render. */
export interface RenderIndexOptions {
  /** True for the compact one-line-per-category view; false for verbose. */
  compact: boolean;
  /** Header line shown above the index. */
  header: string;
  /** Footer line shown after the verbose listing. Ignored in compact mode. */
  footer: string;
  /** Command prefix used in the intro hint and key-stripping (`!` / `.`). */
  prefix: string;
}

/**
 * Render the bare `!help` / `.help` index — a permission-filtered overview
 * of every available command. `set:*` categories collapse onto a single
 * scope-summary line each so the index doesn't get swamped by 200 setting
 * keys. Returns the empty `["No commands available."]` line when nothing
 * is visible to the caller.
 */
export function renderIndex(entries: HelpEntry[], opts: RenderIndexOptions): string[] {
  if (entries.length === 0) {
    return ['No commands available.'];
  }

  const groups = new Map<string, HelpEntry[]>();
  const settingsScopes = new Map<string, { header: HelpEntry | null; keyCount: number }>();

  for (const entry of entries) {
    const cat = entry.category ?? entry.pluginId ?? '';
    if (cat.startsWith('set:')) {
      const scope = cat.slice(4);
      const slot = settingsScopes.get(scope) ?? { header: null, keyCount: 0 };
      if (isScopeHeaderEntry(entry, scope)) {
        slot.header = entry;
      } else {
        slot.keyCount += 1;
      }
      settingsScopes.set(scope, slot);
      continue;
    }
    const list = groups.get(cat) ?? [];
    list.push(entry);
    groups.set(cat, list);
  }

  const lines: string[] = [];
  if (opts.compact) {
    lines.push(
      `\x02${opts.header}\x02 — ${opts.prefix}help <category> or ${opts.prefix}help <command>`,
    );
    for (const [category, group] of groups) {
      const commands = group.map((e) => stripCommandPrefix(e.command, opts.prefix)).join('  ');
      lines.push(`  \x02${category}\x02: ${commands}`);
    }
    lines.push(...renderSettingsScopeIndex(settingsScopes));
  } else {
    lines.push(`\x02${opts.header}\x02`);
    for (const [category, group] of groups) {
      lines.push(`\x02[${category}]\x02`);
      for (const entry of group) {
        lines.push(`  ${boldTrigger(entry.usage)} — ${entry.description}`);
      }
    }
    lines.push(...renderSettingsScopeIndex(settingsScopes));
    if (opts.footer) lines.push(opts.footer);
  }
  return lines;
}

/**
 * Render the per-command detail view. Mirrors `!help <command>` and
 * `.help <command>` — bold trigger, em-dash, description, optional
 * `| Requires: <flags>` suffix, plus any per-line `detail[]`.
 */
export function renderCommand(entry: HelpEntry): string[] {
  const lines: string[] = [];
  const flagsSuffix = entry.flags === '-' ? '' : ` | Requires: ${entry.flags}`;
  lines.push(`${boldTrigger(entry.usage)} — ${entry.description}${flagsSuffix}`);
  if (entry.detail) {
    for (const line of entry.detail) {
      lines.push(`  ${line}`);
    }
  }
  return lines;
}

/**
 * Render a non-scope category view — the `[category]` header followed by
 * one bold-trigger line per command. Used for plugin-defined categories
 * like `[moderation]`, `[fun]`, `[info]`.
 */
export function renderCategory(category: string, entries: HelpEntry[]): string[] {
  const lines: string[] = [`\x02[${category}]\x02`];
  for (const entry of entries) {
    lines.push(`  ${boldTrigger(entry.usage)} — ${entry.description}`);
  }
  return lines;
}

/**
 * Render the verbose settings-scope view — `!help set chanmod` style.
 * Lists every key under the scope with its description, prefixed by the
 * scope name and key count, with a tail hint pointing at the per-key
 * detail path.
 */
export function renderScope(
  scope: string,
  header: HelpEntry | null,
  entries: HelpEntry[],
  prefix: string,
): string[] {
  const keys = entries.filter((e) => !isScopeHeaderEntry(e, scope));
  const lines: string[] = [];
  const titleSuffix = header?.description ? ` — ${header.description}` : '';
  lines.push(`\x02${scope}\x02 settings (${keys.length})${titleSuffix}`);
  for (const e of keys) {
    const keyName = extractKeyName(e.command, scope);
    lines.push(`  \x02${keyName}\x02 — ${e.description}`);
  }
  if (keys.length > 0) {
    lines.push(`Type ${prefix}help set ${scope} <key> for detail.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Drop a single leading `prefix` character from `command` so the compact
 * index renders bare command names (`8ball  seen` rather than
 * `!8ball  !seen`). Multi-word commands keep the rest intact.
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

/**
 * Render the folded `[settings]` pseudo-category — one line per scope
 * with summary and key count. Empty array when no scopes are present so
 * the caller can `lines.push(...renderSettingsScopeIndex(scopes))`
 * unconditionally.
 */
function renderSettingsScopeIndex(
  scopes: Map<string, { header: HelpEntry | null; keyCount: number }>,
): string[] {
  if (scopes.size === 0) return [];
  const lines: string[] = ['\x02[settings]\x02'];
  for (const [scope, info] of scopes) {
    const summary = info.header?.description ?? '';
    const count = info.keyCount;
    const countLabel = count === 1 ? '1 key' : `${count} keys`;
    const tail = summary ? ` — ${summary}` : '';
    lines.push(`  \x02${scope}\x02 (${countLabel})${tail}`);
  }
  return lines;
}
