# Plan: Help-system overhaul (one corpus, two transports)

## Summary

HexBot has two parallel help systems today (core `.help` over the
command map; plugin `!help` over `HelpRegistry`) plus the start of a
third (`.helpset` for settings). They don't share data, don't share
filtering, and each covers a different slice of what an operator might
want to discover. This plan unifies them on `HelpRegistry` as the
**single corpus**, auto-feeds three sources into it (core commands,
plugin `!`-commands, settings — across all three scopes), and renders
with two thin transports (REPL/DCC/dot-IRC `.help` and IRC plugin
`!help`) over a shared renderer module. `.helpset` goes away — the
canonical surface becomes `.help set <scope> [<key>]`. The work ships
in four mergeable phases that each leave the tree green.

The triggering observation was operator-facing: `.help set ai-chat`
errors with "Unknown command", and `.help set` only shows the one-line
`.set` command summary — even though every registered setting carries a
`description`, `type`, `default`, `reloadClass`, and `allowedValues`
already. The minimum cosmetic fix (route `.help set <scope>` into the
existing settings renderer) papers over the deeper problem; the right
work is to merge the three would-be systems into one.

## Background & current shape

### System 1 — Core `.help` (`src/command-handler.ts`)

- Lives on `CommandHandler` as a built-in (registered in the
  constructor, line 110).
- Iterates `this.commands` (the map populated by every
  `registerCommand` call across `src/core/commands/*.ts`).
- Renders one line per command, grouped by `category`, no `detail[]`,
  no per-entry permission filter (relies on the command itself to deny
  on execute via `checkCommandPermissions`, line 208).
- Reachable from REPL, DCC console, and IRC dot-commands.
- **Sees:** every dot-command (`.set`, `.binds`, `.users`, `.op`,
  `.helpset`, etc.).
- **Does not see:** any `!`-command registered by a plugin (`!greet`,
  `!rss`, `!ai`, `!seen`, `!8ball`).

### System 2 — Plugin `!help` (`plugins/help/index.ts` + `src/core/help-registry.ts`)

- Lives in the `help` plugin.
- Iterates `HelpRegistry.getAll()`, which plugins push to via
  `api.registerHelp(entries)` (plugin-api-factory.ts:1086).
- Per-entry metadata: `command`, `flags`, `usage`, `description`,
  `detail[]`, `category`, `pluginId`.
- Permission-filtered (`!help` filters by flags via
  `permissions.checkFlags`); compact-or-verbose index controlled by
  `compact_index`; supports `!help <command>` and `!help <category>`
  lookup (plugins/help/index.ts:150-163).
- Reachable from IRC channels and PMs.
- **Sees:** every `!`-command a plugin registered.
- **Does not see:** any core dot-command, any setting key.

### System 3 (incipient) — `.helpset`

- Added with the live-config landing (881e8b5). One shape only:
  `.helpset <scope> <key>` returns a detail line + type/default/
  reload/allowed (settings-commands.ts:337-378).
- Bare `.helpset` errors with the usage string — no listing of scopes
  or keys.
- Renders settings metadata that already exists on every `register()`
  call (`description`, `type`, `default`, `reloadClass`,
  `allowedValues`, `owner`).
- **Sees:** settings.
- **Does not see:** anything else.

### What this costs operators

- An IRC user typing `!help` doesn't discover `.set`, `.binds`,
  `.users`, `.op`, or any other dot-command — even though they may
  legitimately have `n` and could run them.
- A REPL operator typing `.help` doesn't discover `!greet` or `!rss`
  even though plugins are loaded and the entries exist.
- Neither path discovers settings. `.help set ai-chat` errors;
  `!help set` only finds the `.set` command line; `.helpset` only
  works if the operator already knows it exists, the scope, and the
  key they want.
- `description` strings live on three different registers (command
  options, `HelpEntry` records, `SettingEntry` defs). They drift
  whenever one moves and the others don't.

## Feasibility

- **Alignment.** The destination shape mirrors ChanServ / NickServ
  exactly — `HELP` (categorized command list), `HELP SET` (menu of
  options per scope), `HELP SET TOPICLOCK` (per-key detail). About 75%
  of that shape exists today; the missing piece is the middle rung,
  exactly the `category: 'set:<scope>'` slot this plan fills. No
  DESIGN.md changes required.
- **Dependencies.** All wiring already exists: `HelpRegistry` is
  threaded through `Bot → PluginLoader → plugin-api-factory`
  (bot.ts:728, plugin-loader.ts:203, plugin-api-factory.ts:326).
  `CommandHandler` is the only major surface that does NOT yet
  receive it (constructor at command-handler.ts:103); Phase 1 adds
  that. `SettingsRegistry` already exposes the metadata Phase 2
  needs (`getAllDefs`, `getDef`); only one new optional constructor
  field (`scopeSummary`) needs adding.
- **Blockers.** None. Pure refactor + extension on existing audited
  code. No new npm packages, no IRC protocol changes, no DB schema
  migrations.
- **Complexity estimate.** **M** (one focused day per phase, four
  phases — half a week if executed sequentially). Each phase is
  shippable independently and leaves user-visible improvement.
- **Risk areas.**
  - **Volume management.** `chanmod` alone has ~46 settings. `flood`,
    `greeter`, `help`, `rss`, `ai-chat` add more. Naively dumping
    them into the index would swamp it. Mitigation already designed
    in: `compact_index` already groups by category; the top-level
    `!help` index gets one line per category (`set:core`,
    `set:chanmod`, …), not 200 lines per setting. Deep dive only
    happens when an operator drills in.
  - **Cross-plugin command collisions.** Today's `HelpRegistry`
    silently shadows on collision (`get()` returns whichever bucket
    iterates first; `getAll()` returns duplicates). Phase 1 adds
    explicit collision detection + a boot-time warning + a fallback
    namespaced-command keep so the second-registered entry is
    discoverable under `<pluginId>:<command>` rather than lost.
  - **Settings entry permissions.** Auto-derived setting entries
    inherit `flags: 'n'` from the underlying `.set` command. `!help`'s
    existing flag filter (`filterByPermission`, plugins/help/index.ts:22)
    hides them from unprivileged users automatically — but operators
    used to seeing settings via `.helpset` (which is `flags: '-'`,
    line 340) will see settings disappear from the unprivileged
    `!help` view. Acceptable — settings _should_ be operator-only —
    but the migration message in Phase 4 should call this out.
  - **Sub-help dispatch ambiguity.** `.help set chanmod auto_op` has
    to resolve in two stages: try as a longer command name first,
    then fall through to category-prefix lookup (`set:chanmod` +
    `auto_op` as a key within that category). The same priority
    `plugins/help/index.ts` already uses for `!help <command>` vs
    `!help <category>`; we extend it one level deeper.
  - **`.help` permission gating regression.** Today `.help` shows
    all commands with no flag filter — REPL is trusted, IRC dot-
    commands rely on the command's own deny-on-execute. After Phase 3,
    `.help` runs the same `filterByPermission` logic as `!help`. For
    REPL this is moot (REPL bypasses flag checks per
    command-handler.ts:223). For DCC/IRC dot-commands, unprivileged
    users will stop seeing `.set`, `.kick`, etc. in the index — which
    is the _correct_ behavior (it stops leaking the surface area) but
    is a behavior change worth flagging in the Phase 3 commit
    message.
  - **`.helpset` removal blast radius.** Two known consumers:
    `src/core/commands/settings-commands.ts:337` (the registration
    itself) and any audit / docs string referencing the command name.
    No plugin or external integration depends on it (introduced
    881e8b5; never publicly documented as a stable API).

## Dependencies

- [x] `src/core/help-registry.ts` — existing primitive, needs collision detection
- [x] `src/command-handler.ts` — existing built-in `.help` to retire in Phase 3
- [x] `src/core/settings-registry.ts` — `getAllDefs` / `getDef` already exposed
- [x] `src/core/commands/settings-commands.ts` — `.helpset` to remove in Phase 4
- [x] `plugins/help/index.ts` — renderer to extract in Phase 3
- [x] `src/plugin-api-factory.ts:1086` — `registerHelp` already wired
- [x] `src/plugin-loader.ts:602` — `unregister(pluginName)` already drops both `!`-entries and (after Phase 2) settings-derived entries via the same pluginId bucket
- [x] `src/bot.ts:728` — `HelpRegistry` constructed and threaded via `services.helpRegistry`
- [ ] New: `src/core/help-render.ts` — extracted shared renderer (Phase 3)
- [ ] New: `scopeSummary` field on `SettingsRegistryOptions` (Phase 2)

## Design

### One corpus

`HelpRegistry` already carries every per-entry field we need
(`flags`, `category`, `detail[]`, `pluginId`). Two additions:

1. **Collision detection.** When a new entry's normalized command
   matches an entry in a different bucket, emit a logger warning at
   registration time and keep the new entry under a namespaced key
   (`<pluginId>:<command>`) so it's still discoverable instead of
   silently lost.
2. **Sub-help dispatch.** When `.help <cmd> <arg>` matches no
   command directly, try `<cmd> <arg>` as a category prefix or a
   longer command name. Settings live under `set:<scope>` categories,
   so `.help set chanmod` returns the menu of keys; `.help set
chanmod auto_op` returns the per-key detail. Same lookup pattern
   `!help <category>` already uses, walked one level deeper.

### Three feeds

**Core commands.** `CommandHandler.registerCommand` mirrors into
`HelpRegistry` under a reserved `pluginId: 'core'`:

```ts
this.helpRegistry?.register('core', [
  {
    command: `${this.prefix}${name}`,
    flags: options.flags,
    usage: options.usage,
    description: options.description,
    category: options.category,
  },
]);
```

The `.help` built-in registered in `CommandHandler`'s constructor
gets the same treatment so `core:help` shows up in the index.

**Plugin `!`-commands.** Already register via `api.registerHelp` —
no change. Phase 2 piggy-backs on the same pluginId bucket for
settings entries derived from each plugin's `SettingsRegistry`.

**Settings (core, plugin, channel — all three scopes).** Every
`SettingsRegistry.register(defs)` call additionally pushes derived
help entries into `HelpRegistry`:

```ts
this.helpRegistry?.register(
  this.owner,
  defs.map((def) => ({
    command: `${prefix}set ${this.scopeLabel} ${def.key}`,
    flags: 'n',
    usage: `${prefix}set ${this.scopeLabel} ${def.key} <${def.type}>`,
    description: def.description,
    detail: [
      `Type: ${def.type}  Default: ${formatDefault(def)}  Reload: ${def.reloadClass}`,
      ...(def.allowedValues?.length ? [`Allowed: ${def.allowedValues.join(', ')}`] : []),
    ],
    category: `set:${this.scopeLabel}`,
  })),
);
```

Channel-scope keys land under one shared `set:channel` category — the
schema is per-registry, not per-instance, so listing it once per
channel would just repeat.

### Two transports

Both `.help` (in `command-handler.ts`) and `!help` (in
`plugins/help/index.ts`) become thin renderers over the same
`HelpRegistry`. The renderer logic — category grouping, compact vs.
verbose, permission filtering, command vs. category lookup — already
lives in `plugins/help/index.ts`; Phase 3 extracts it to
`src/core/help-render.ts` and has both transports call it.

The transport difference reduces to:

- **`.help`** (REPL / DCC / IRC dot-commands): trusted local console
  in REPL, flag-checked elsewhere; reply via `ctx.reply`.
- **`!help`** (IRC `!`-commands): always flag-checked; reply via
  `notice`/`privmsg` per the plugin's existing `reply_type` setting.

Same content, same gating, same renderer. The two `.` and `!`
prefixes survive only because operator muscle memory exists for
both — the underlying system is one.

### Locked design decisions

Confirmed during planning multi-choice — these are the rendering
defaults the implementation ships with. **Do not relitigate without
explicit user input.**

#### `.help set <scope>` — verbose by default

One line per key with description, ChanServ-style. Operators who
type `.help set chanmod` are in "tell me everything about this scope"
mode and want descriptions inline; the dense `.info`-style flag grid
is the wrong shape there.

```
.help set chanmod
chanmod settings (46):
  auto_op (flag)              — Auto-op flagged users on join
  op_flags (string)           — Comma-separated flags eligible for auto-op
  enforce_modes (flag)        — Re-apply channel mode string when removed
  enforce_channel_modes (str) — Mode string to enforce
  ...
Type .help set chanmod <key> for detail.
```

Defer a `--compact` flag until someone asks for it. The `.info
<scope>` view already covers the dense-grid use case.

#### Channel-scope settings — single `set:channel` category

All channels share the same registered key schema (the def lives on
the registry, the value lives on the channel). The help corpus
should reflect schema, not instances. One `set:channel` category
listing the schema once; the value-side `.info <#chan>` /
`.chaninfo` surface continues to operate per-channel.

```
.help set channel
  greet_msg (string)        — Per-channel join greeting
  flood_lock_mode (string)  — Channel mode to set on flood lockdown
  ...
Set per-channel via .set <#channel> <key> <value>.
```

#### `.help set` (no scope) — scope names + summary + key count

```
.help set
  core    (43 keys) — Bot-wide singletons (irc, services, queue, ...)
  chanmod (46 keys) — Channel mode enforcement, takeover protection
  flood   (16 keys) — Flood detection and channel lockdown
  rss     (6 keys)  — RSS/Atom feed announcer tunables
  channel (5 keys)  — Per-channel overrides (use .help set channel)
  ...
Type .help set <scope> to list keys, .help set <scope> <key> for detail.
```

Requires each `SettingsRegistry` to carry a one-line scope summary.
Plugin scopes auto-populate from the plugin module's exported
`description`; `core` and `channel` get short hardcoded strings at
their construction sites in `bot.ts`.

### Collision policy

First-come-first-served + warn. The newcomer keeps an entry under a
namespaced command name so it's still discoverable; developers see
the warning at boot, rename, ship a fix.

```ts
register(pluginId: string, entries: HelpEntry[]): void {
  let bucket = this.entries.get(pluginId) ?? new Map();
  this.entries.set(pluginId, bucket);
  for (const entry of entries) {
    const key = normalizeCommand(entry.command);
    const owner = this.findExistingOwner(key, pluginId);
    if (owner) {
      this.logger?.warn(
        `[help-registry] "${entry.command}" already owned by "${owner}"; ` +
        `"${pluginId}" entry kept under namespaced command ` +
        `"${pluginId}:${entry.command}"`,
      );
      const namespaced = `${pluginId}:${entry.command}`;
      bucket.set(`${pluginId}:${key}`, {
        ...entry, pluginId, command: namespaced,
      });
      continue;
    }
    bucket.set(key, { ...entry, pluginId });
  }
}
```

### ChanServ alignment

Mapping HexBot today against ChanServ's three help layers:

| ChanServ                          | HexBot today                          | HexBot after this plan                           |
| --------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `HELP` (categorized command list) | `.help` (already categorized)         | unchanged + permission-filtered + sees `!`-cmds  |
| `HELP SET` (menu of options)      | `.help set` → one line, no menu       | `.help set` → list scopes, summary per scope     |
| `HELP SET TOPICLOCK` (detail)     | `.helpset chanmod auto_op` (works)    | `.help set chanmod auto_op` (same, via one verb) |
| `INFO #channel` (current state)   | `.info chanmod` (works, shows values) | unchanged — describes state, complements help    |

`.info` stays as the current-state surface (ChanServ's `INFO`); help
becomes the description surface (ChanServ's `HELP`). Complementary,
not redundant.

## Phases

### Phase 1: Collision detection + core auto-feed

**Goal:** `!help` gains every dot-command. `.help` is unchanged on
the surface but its registrations now mirror into `HelpRegistry`.
Cross-plugin command collisions stop being silent.

- [x] Extend `HelpRegistry.register` (`src/core/help-registry.ts`) with cross-bucket collision detection per the snippet above; accept an optional `logger?: LoggerLike` constructor arg
- [x] Add `findExistingOwner(key, ownPluginId)` private helper that walks all buckets except the caller's
- [x] Add `normalizeCommand` to also strip leading `.` so dot-commands case-fold correctly
- [x] Update `HelpRegistry.get()` to also check namespaced keys (`<pluginId>:<command>`) so the loser of a collision is still resolvable
- [x] Update `Bot` (`src/bot.ts:728`) to construct `HelpRegistry` with the bot logger
- [x] Add an optional `helpRegistry?: HelpRegistry | null` constructor parameter to `CommandHandler` (`src/command-handler.ts:103`)
- [x] Mirror every `registerCommand` call into `helpRegistry.register('core', [...])`, including the built-in `.help` registered in the constructor
- [x] Wire `CommandHandler` instantiation in `Bot` to pass the shared `HelpRegistry`
- [x] Update tests: `tests/core/help-registry.test.ts` for collision warning + namespaced fallback; `tests/command-handler.test.ts` for the auto-feed
- [x] **Verify:** `pnpm test` green (3987/3987); manual smoke deferred to operator

### Phase 2: Settings auto-derive

**Goal:** Every `SettingsRegistry.register()` call also pushes
derived help entries. `!help set <scope>` and
`!help set <scope> <key>` both work. `.helpset` continues to work
unchanged (Phase 4 retires it).

- [x] Add `scopeSummary?: string` to `SettingsRegistryOptions` (`src/core/settings-registry.ts:128-141`)
- [x] Add `helpRegistry?: HelpRegistry | null` to `SettingsRegistryOptions`
- [x] Add `scopeLabel: string` to `SettingsRegistryOptions` so the registry knows what to render in `command`/`category` strings (`'core'`, `'channel'`, or the plugin id)
- [x] In `SettingsRegistry.register()`, after the def is stored, push a derived `HelpEntry` per def into `helpRegistry` under the def's `owner` bucket — settings registered by `chanmod` go into the `chanmod` bucket so `unregister(pluginId)` on plugin unload drops them naturally
- [x] Implement `formatDefault(def)` helper inside `settings-registry.ts` (boolean → ON/OFF; string with empty → `(empty)`; int → `String(n)`)
- [x] Wire `Bot` (`src/bot.ts`) to pass `helpRegistry` + `scopeLabel: 'core'` + a hardcoded scope summary string when constructing the core `SettingsRegistry`
- [x] Wire `Bot` (or wherever `ChannelSettings` is constructed) to pass `helpRegistry` + `scopeLabel: 'channel'` + a hardcoded scope summary string
- [x] Wire `PluginLoader` (`src/plugin-loader.ts:740-800` mergeConfig / plugin-settings creation) to pass `helpRegistry` + `scopeLabel: pluginId` + `scopeSummary: module.description` when constructing each per-plugin `SettingsRegistry`
- [x] Update `plugins/help/index.ts` so the bare `!help` index includes a special pseudo-category render for `set:*` categories that shows each scope's summary + key count (the "no scope" view from the locked design decisions)
- [x] Update tests: `tests/core/settings-registry.test.ts` adds an assertion that `helpRegistry.getAll()` contains a `set:<label>` entry per registered def; settings-scope index tests in `tests/plugins/help.test.ts` cover the bare-index folded render (integration smoke deferred — assertions in unit + plugin tests cover the same surface)
- [x] **Verify:** `pnpm test` green (3997/3997); manual smoke deferred to operator

### Phase 3: Extract renderer

**Goal:** One renderer module powers both `.help` and `!help`.
`.help set <scope> <key>` works for the first time. The duplicated
formatting logic disappears.

- [x] Create `src/core/help-render.ts` exporting:
  - `renderIndex(entries, opts: { compact, header, footer, prefix })` — the bare-index path (used by `.help` with no args and `!help` with no args)
  - `renderCommand(entry, opts: { prefix })` — the `<command>` lookup path (boldTrigger + flags suffix + detail lines)
  - `renderCategory(category, entries, opts: { prefix })` — the `<category>` lookup path
  - `lookup(registry, query, ctx, perms)` — the dispatch logic (try as command, try as category, try as `<command> <arg>` sub-help, return null if no match)
  - `filterByPermission(entries, ctx, perms)` — extracted from `plugins/help/index.ts:22`
- [x] Move `boldTrigger` from `plugins/help/index.ts` into `help-render.ts`
- [x] Have `plugins/help/index.ts` import every renderer from `help-render.ts`, deleting the in-plugin copies; the plugin's `handler` shrinks to: cooldown gate → `lookup()` → render → `send()`
- [x] Have `CommandHandler.handleHelp` (`src/command-handler.ts:321`) replace its built-in `getHelp` body with the same `lookup()` → render path, gated through `filterByPermission` (REPL bypasses by passing `null` perms; legacy `getHelp` retained as a fallback for the no-registry test path)
- [x] Implement sub-help dispatch in `lookup`: when `<arg1> <arg2>` is the query and `<arg1>` matches no command but `set:<arg2>` matches a category, fall through to category render with the rest as a key filter (handled implicitly via `helpRegistry.get(query)` resolving to the synthetic `.set <scope> <key>` entry registered by `SettingsRegistry` in Phase 2)
- [x] Delete the now-unused `getHelp(commandName?)` method on `CommandHandler` if no other consumer remains — kept as a fallback path for the no-registry test fixture; existing tests rely on it
- [x] Update `plugins/help/index.ts` cooldown / settings registration unchanged
- [x] Update tests: `tests/core/help-render.test.ts` covers formatting + lookup + filterByPermission; `tests/plugins/help.test.ts` keeps cooldown + transport-level behaviour; `tests/command-handler.test.ts` adds cases for `.help <plugin-cmd>`, `.help set <scope>`, `.help set <scope> <key>`
- [x] **Verify:** `pnpm test` green (4028/4028); manual smoke deferred to operator. **Behavior change for commit message:** unprivileged DCC/IRC dot-command users no longer see operator-only commands in the `.help` index now that `filterByPermission` runs on the dot-command path too.

### Phase 4: Delete `.helpset`

**Goal:** One verb left for help. `.help set <scope> [<key>]` is the
canonical path.

- [x] Remove the `helpset` registration from `src/core/commands/settings-commands.ts:337-378`
- [x] Search the tree for any remaining `.helpset` strings (CONFIG.md, GETTING_STARTED.md, settings-render.ts JSDoc, settings-commands.ts module header) and update them to `.help set`
- [x] Search for `helpset` in committed log strings, snapshot tests, and rendered docs (only intentional references remain: settings-commands.ts module header documenting the removal, and the regression test confirming `.helpset` returns Unknown command)
- [x] Remove or update `tests/core/commands/settings-commands.test.ts` cases that exercised `.helpset` (replaced with a regression test asserting `.helpset` now returns `Unknown command`)
- [x] Update CHANGELOG / release notes if the project tracks them, noting the unification + the `.helpset` → `.help set` migration (no CHANGELOG file in tree — release notes captured in commit message)
- [x] **Verify:** `pnpm test` green (4028/4028); `tsc --noEmit` clean; `.helpset core foo` in REPL returns `Unknown command: .helpset` exactly as any other unknown command does (covered by the new regression test); `.help set core foo` returns the per-key detail line (covered by Phase 3 command-handler tests)

## Config changes

None. The settings registered by `plugins/help/index.ts` (`cooldown_ms`,
`reply_type`, `compact_index`, `header`, `footer`) all keep their
current shape.

The `compact_index` flag's behavior implicitly changes: it now also
governs whether `set:*` categories are dumped in full or one-lined.
Default stays `true`, so existing operators see the compact form.

## Database changes

None.

## Test plan

- **`tests/core/help-registry.test.ts`** — Phase 1: collision warning
  fires when the same command name is registered by two plugins; the
  loser is keyed under `<pluginId>:<command>` and resolvable by
  `get()`; `getAll()` returns both entries.
- **`tests/command-handler.test.ts`** — Phase 1: every
  `registerCommand` mirrors into `HelpRegistry` under `'core'`. Phase
  3: `.help <plugin-cmd>`, `.help set <scope>`, `.help set <scope>
<key>` all return the expected render.
- **`tests/core/settings-registry.test.ts`** — Phase 2: registering a
  def pushes a `HelpEntry` into the supplied `helpRegistry` under
  `category: 'set:<scopeLabel>'`; `unregister(owner)` on the registry
  _does not_ drop help entries (those are dropped by
  `helpRegistry.unregister(pluginId)` on plugin unload, which already
  happens at `plugin-loader.ts:602`).
- **`tests/core/help-render.test.ts`** — Phase 3: `renderIndex` /
  `renderCommand` / `renderCategory` / `lookup` formatting; sub-help
  dispatch (`.help set chanmod auto_op` resolves to the per-key
  entry); permission filtering hides `n`-flagged entries from `-`-
  flag callers.
- **`tests/integration/help-corpus.test.ts`** — Phase 2 + 3 end-to-
  end: boot a minimal bot with one fake plugin that registers a
  `!`-command and a setting; assert that `!help`, `.help`, `!help
set`, `.help set`, `!help set <plugin>`, `.help set <plugin>` all
  produce the expected merged output.

## Open questions

None remaining — three multi-choice answers locked during planning
(see "Locked design decisions" above):

1. `.help set <scope>` renders verbose-by-default (one line per key
   with description).
2. Channel-scope keys land under a single `set:channel` category.
3. Bare `.help set` shows scope names + summary + key count.

If implementation surfaces a new ambiguity (likely candidate: how to
render `.help set <scope> <key>` for a `string` setting whose value
contains newlines), defer to existing `.helpset` rendering until an
explicit decision is requested.
