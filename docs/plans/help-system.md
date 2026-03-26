# Plan: IRC Help System (`!help`)

## Summary

Add a ChanServ-style `!help` command that sends users a permission-filtered list of
available bot commands via NOTICE. Plugins register their commands with a new
`HelpRegistry` core service via `api.registerHelp(entries)`. The registry is
automatically cleared on plugin unload, so the list is always current. A standalone
`help` plugin handles the `!help` IRC trigger.

## Feasibility

- **Alignment**: Fits the DESIGN.md architecture cleanly — new core service wired through
  `PluginLoaderDeps`, new `api.*` methods on `PluginAPI`, new standalone plugin. No design
  changes required.
- **Dependencies**: All required core modules exist (`permissions`, `plugin-loader`,
  `PluginAPI`).
- **Blockers**: None.
- **Complexity**: S — straightforward plumbing; the heaviest work is adding help entries to
  each existing plugin.
- **Risk areas**:
  - Hot-reload must clear and re-register help entries atomically — `unload()` clears,
    `init()` re-registers on next load. This is already the pattern for binds.
  - Permission filtering must use live flag lookups (at query time, not registration time)
    so per-channel flags are respected.
  - NOTICE flood: `!help` (no args) can send 10+ lines. The help plugin must route all
    replies through the message queue via `api.notice()`. An optional per-user cooldown
    should be configurable.

## Dependencies

- [x] `PluginAPI` + plugin loader + permissions system (all exist)
- [x] Multi-file plugin support in loader (done — chanmod v2)

## Phases

### Phase 1: `HelpEntry` type + `HelpRegistry` core module

**Goal:** Define the data shape and the registry that stores it.

- [x] Add `HelpEntry` interface to `src/types.ts`:
  ```typescript
  export interface HelpEntry {
    command: string; // trigger including "!", e.g. "!op"
    flags: string; // required flags, same format as bind (e.g. "o", "n|m", "-")
    usage: string; // concise usage line, e.g. "!op [nick]"
    description: string; // one-line description
    detail?: string[]; // extra lines shown only in !help <command>
    category?: string; // grouping label, defaults to pluginId
  }
  ```
- [x] Create `src/core/help-registry.ts` with a `HelpRegistry` class:
  - `register(pluginId: string, entries: HelpEntry[]): void` — stores entries keyed by
    pluginId; overwrites any prior registration for that plugin
  - `unregister(pluginId: string): void` — removes all entries for that plugin
  - `getAll(): HelpEntry[]` — returns all entries across all plugins
  - `get(command: string): HelpEntry | undefined` — case-insensitive lookup by command
    name (strips leading `!` for comparison)
- [x] Verification: unit test in `tests/core/help-registry.test.ts` covering register,
      unregister, getAll, and get (with and without leading `!`)

### Phase 2: Wire `HelpRegistry` into `PluginAPI`

**Goal:** Plugins can call `api.registerHelp()` and `api.getHelpEntries()` in `init()`.

- [x] Add to `PluginAPI` interface in `src/types.ts`:
  ```typescript
  registerHelp(entries: HelpEntry[]): void;
  getHelpEntries(): HelpEntry[];
  ```
- [x] Add `helpRegistry?: HelpRegistry` to `PluginLoaderDeps` interface in
      `src/plugin-loader.ts`
- [x] Implement in `createPluginApi()` inside `src/plugin-loader.ts`:
  ```typescript
  registerHelp(entries: HelpEntry[]): void {
    helpRegistry?.register(pluginId, entries);
  },
  getHelpEntries(): HelpEntry[] {
    return helpRegistry?.getAll() ?? [];
  },
  ```
- [x] In `PluginLoader.unload()`, call `this.helpRegistry?.unregister(pluginName)` after
      teardown and before removing from `this.loaded` (same place as `unbindAll`)
- [x] Instantiate `HelpRegistry` in `Bot` constructor (`src/bot.ts`) and pass it in
      `PluginLoaderDeps`
- [x] Verification: load a test plugin that calls `api.registerHelp([...])`, assert entries
      appear in `helpRegistry.getAll()`; reload the plugin, assert entries are refreshed; unload,
      assert they are gone

### Phase 3: `help` plugin

**Goal:** `!help` and `!help <command>` work in channels and PMs.

- [x] Create `plugins/help/index.ts`:
  - Export `name = 'help'`, `version`, `description`
  - In `init(api)`:
    - Bind `!help` on `pub` (flags `'-'`) — channel command
    - Bind `!help` on `msg` (flags `'-'`) — PM command
    - Both share one handler function
  - Handler logic:
    1. Read `reply_type` from config; define a `send(ctx, text)` helper that routes to the
       right IRC call:
       - `"notice"` → `api.notice(ctx.nick, text)` (private notice, default)
       - `"privmsg"` → `api.say(ctx.nick, text)` (private message)
       - `"channel_notice"` → `api.notice(ctx.channel ?? ctx.nick, text)` (NOTICE to
         channel if invoked there, else falls back to private notice)
         All three always target the **nick** for `!help <command>` (detail view) —
         `"channel_notice"` is only used for the **list view** when a channel is available.
    2. Parse `ctx.args.trim()` — if non-empty, treat as `<command>` for detailed help
    3. **Detail view** (`!help <command>`):
       - Strip leading `!` from arg; call `api.getHelpEntries()` then find match
       - `send(ctx, ...)` each line: usage, flags, description, any `detail` lines
       - If not found: `send(ctx, "No help available for !<command>")`
       - No permission filtering — show what's required even if user lacks flags (ChanServ
         behaviour)
    4. **List view** (`!help` no args):
       - Get all entries; filter to those where `flags === '-'` or
         `api.permissions.checkFlags(entry.flags, ctx)` is true
       - Group by `category` (fall back to pluginId if omitted)
       - `send(ctx, ...)` each line: header, grouped commands, footer
       - Enforce per-user cooldown (default 30 s) to prevent queue flooding
  - Teardown: clear cooldown map
- [x] Create `plugins/help/config.json`:
  ```json
  {
    "cooldown_ms": 30000,
    "reply_type": "notice",
    "header": "*** Help ***",
    "footer": "*** End of Help ***"
  }
  ```
  Valid `reply_type` values:
  - `"notice"` — private NOTICE to requesting nick (default, ChanServ-style)
  - `"privmsg"` — private PRIVMSG to requesting nick
  - `"channel_notice"` — NOTICE to the channel for list view (appears as `-Bot- [#ch] ...`);
    falls back to private notice if invoked via PM
- [x] Verification: load the help plugin in tests, call the handler, assert reply lines
      sent to the correct nick (not the channel) with correct content; verify permission
      filtering omits commands the mock user cannot run; test both `reply_type` values

### Phase 4: Add help entries to existing plugins

**Goal:** All user-facing `!commands` appear in `!help`.

Each plugin calls `api.registerHelp([...])` near the top of `init()`. Categories should be
human-readable strings (e.g. `"moderation"`, `"info"`).

- [x] `plugins/chanmod/commands.ts` — register:

  | command     | flags | usage                         | description                              |
  | ----------- | ----- | ----------------------------- | ---------------------------------------- |
  | `!op`       | `o`   | `!op [nick]`                  | Op a nick (or yourself if omitted)       |
  | `!deop`     | `o`   | `!deop [nick]`                | Deop a nick (or yourself if omitted)     |
  | `!halfop`   | `o`   | `!halfop [nick]`              | Halfop a nick (or yourself if omitted)   |
  | `!dehalfop` | `o`   | `!dehalfop [nick]`            | Dehalfop a nick (or yourself if omitted) |
  | `!voice`    | `o`   | `!voice [nick]`               | Voice a nick (or yourself if omitted)    |
  | `!devoice`  | `o`   | `!devoice [nick]`             | Devoice a nick (or yourself if omitted)  |
  | `!kick`     | `o`   | `!kick <nick> [reason]`       | Kick a nick with an optional reason      |
  | `!ban`      | `o`   | `!ban <nick\|mask> [minutes]` | Ban a nick or mask; optionally timed     |
  | `!unban`    | `o`   | `!unban <nick\|mask>`         | Remove a ban by nick or mask             |
  | `!kickban`  | `o`   | `!kickban <nick> [reason]`    | Ban and kick in one step                 |
  | `!bans`     | `o`   | `!bans [channel]`             | List tracked bans and expiry times       |

  Category: `"moderation"`

- [x] `plugins/8ball/index.ts` — register `!8ball <question>`, flags `-`, category `"fun"`
- [x] `plugins/seen/index.ts` — register `!seen <nick>`, flags `-`, category `"info"`
- [x] `plugins/topic/index.ts` — register:
  - `!topic <theme> <text>` / `!topic preview [text]` / `!topics`, flags `-`, category `"topic"`
- [x] `plugins/greeter/index.ts` — register `!greet [set|show|delete] ...`, flags `-`,
      category `"general"` (if `allow_custom` is enabled; register unconditionally and let
      permission filtering handle it at query time)
- [x] Verification: load all plugins in integration test, call `api.getHelpEntries()`,
      assert expected commands are present

## Config changes

New `plugins/help/config.json` defaults (no changes to `bot.json` or `plugins.json` schema):

```json
{
  "cooldown_ms": 30000,
  "reply_type": "notice",
  "header": "*** Help ***",
  "footer": "*** End of Help ***"
}
```

- `reply_type` options:
  - `"notice"` — private NOTICE to requesting nick (default)
  - `"privmsg"` — private PRIVMSG to requesting nick
  - `"channel_notice"` — NOTICE sent to the channel for the list view, so it appears as
    `-Bot- [#channel] Available commands: ...`; detail view (`!help <cmd>`) always goes
    privately to the nick; falls back to private notice when invoked via PM
- Unknown commands get an explicit reply: `No help available for !<command>`.

Enable in `config/plugins.json`:

```json
{
  "help": {
    "enabled": true
  }
}
```

Pre-listed as enabled in `config/plugins.example.json`.

## Database changes

None.

## Test plan

- `tests/core/help-registry.test.ts`
  - register entries for two plugins; getAll returns both
  - get() finds by exact command and by command without `!`
  - unregister() removes only the target plugin's entries
  - re-register() (same pluginId) replaces prior entries, not duplicates

- `tests/plugins/help.test.ts`
  - `!help` with no args sends reply to the requesting nick, not the channel (both when
    called from a channel and from a PM)
  - `reply_type: "notice"` → NOTICE to nick
  - `reply_type: "privmsg"` → PRIVMSG to nick
  - `reply_type: "channel_notice"` → list view sends NOTICE to channel; detail view still
    sends NOTICE to nick; PM invocation falls back to private notice
  - Permission filtering: user with no flags sees only `flags: '-'` entries
  - User with `+o` sees `flags: 'o'` entries as well
  - `!help op` returns detail for `!op`; `!help !op` also works (strips leading `!`)
  - `!help unknowncmd` returns explicit "No help available for !unknowncmd" reply
  - Cooldown: second call within `cooldown_ms` is silently dropped (no second reply)

- Update `tests/plugins/chanmod.test.ts`, `seen.test.ts`, `8ball.test.ts`, `topic.test.ts`
  - Assert `api.getHelpEntries()` includes the expected commands after init

## Decisions

| Question        | Decision                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Reply type      | Configurable: `"notice"` (default) \| `"privmsg"` \| `"channel_notice"`                        |
| Reply target    | List view: to nick (notice/privmsg) or to channel (channel_notice); detail view always to nick |
| Unknown command | Explicit reply: `No help available for !<command>`                                             |
| Category naming | Plugins supply their own string; defaults to pluginId if omitted                               |
| Auto-enable     | Pre-listed as enabled in `plugins.example.json`                                                |
