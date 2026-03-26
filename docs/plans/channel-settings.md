# Plan: Per-Channel Settings System (`ChannelSettings`)

## Summary

Add a framework-level per-channel settings system modeled directly on Eggdrop's `chanset`/`setudef`
mechanism. Plugins declare typed setting definitions (flags, strings, integers) in `init()`. Bot
operators set them at runtime via `.chanset #chan [+/-]key [value]`. Plugins read them at handler
time with `api.channelSettings.get(channel, key)`.

This eliminates the pattern of each plugin inventing its own per-channel storage commands and
conventions. A single `.chaninfo #chan` command gives operators a unified view of every per-channel
setting across all loaded plugins — exactly as Eggdrop's `.chaninfo` works.

**The distinction from `api.config`:**

- `api.config` — static operator config loaded from files at startup; same value for all channels
- `api.channelSettings` — runtime operator config set via IRC; different per channel; persists in DB

Both coexist. Config files remain the right place for global defaults, rate limits, and anything
that needs a restart. Channel settings are for anything an operator should be able to toggle
per-channel without touching a file.

## Feasibility

- **Alignment**: `HelpRegistry` is the direct analogue — same pattern of register/unregister in
  `PluginLoader`, same injection through `PluginLoaderDeps`, same `api.*` surface.
- **Blockers**: The `topic` bind type does not exist yet. It is required for topic protection (Phase
  4b) and is added in Phase 0 as foundation work.
- **Complexity**: M — the core module and wiring are straightforward; plugin migrations are
  mechanical but thorough.
- **Risk areas**:
  - **Key collisions**: two plugins registering the same key name. Log and skip the duplicate at
    registration time rather than throwing, to prevent one bad plugin from crashing another.
  - **Default precedence**: plugins pass `api.config.x ?? hardcoded` as the `default` when
    registering. The `channelSettings` value then layers on top. Plugin authors must set defaults
    from `api.config` at registration time — no magic fallback in the framework.
  - **Values outlive defs**: `unregister()` removes defs but never deletes stored DB values.
    Operator data must survive plugin reloads and unloads.
  - **IRC input sanitization**: `.chanset` string values must be stripped of `\r`/`\n` before
    storage (existing security rule — use `sanitize()` from `src/utils/sanitize.ts`).
  - **topic event echo**: some IRCd servers send TOPIC for all channels on connect. Topic
    protection handlers must ignore this startup burst (same startup-grace pattern as
    chanmod mode enforcement).

## Dependencies

- [x] `HelpRegistry` pattern (Phase 1 reference implementation)
- [x] `BotDatabase` KV store (reused with `chanset` namespace)
- [x] `sanitize()` utility for IRC input (already exists)
- [ ] `topic` BindType (Phase 0)

---

## Phases

### Phase 0: New bind types

**Goal:** Add `topic` and `quit` to the dispatcher so plugins can react to these IRC events. Both
are deferred Eggdrop staples that have been blocked by missing irc-bridge support.

#### `topic` bind type

- [ ] Add `'topic'` to `BindType` in `src/types.ts` (stackable)

- [ ] In `src/irc-bridge.ts`, listen for irc-framework `topic` event and dispatch:

  ```typescript
  // ctx fields dispatched:
  // nick      — nick that changed the topic (empty string for server-set topics)
  // ident     — ident (empty string for server-set)
  // hostname  — hostname (empty string for server-set)
  // channel   — channel name
  // text      — new topic text (empty string = topic cleared)
  // command   — 'topic'
  // args      — ''
  ```

  Do not dispatch if `channel` is absent or invalid. Sanitize `text` with `sanitize()`.

- [ ] Do NOT dispatch topic events received during the initial channel join burst (within
      `STARTUP_GRACE_MS = 5000` after `bot:connected`). Use a module-level boolean gate in
      `IRCBridge.attach()` cleared by a `setTimeout`, identical to the approach used elsewhere.

#### `quit` bind type

- [ ] Add `'quit'` to `BindType` in `src/types.ts` (stackable)

- [ ] In `src/irc-bridge.ts`, listen for irc-framework `quit` event and dispatch:

  ```typescript
  // nick      — nick that quit
  // ident     — ident
  // hostname  — hostname
  // channel   — null (not channel-scoped)
  // text      — quit message
  // command   — 'quit'
  // args      — ''
  ```

  Do not dispatch the bot's own quit event.

- [ ] Verification (`tests/irc-bridge.test.ts`):
  - TOPIC event with user prefix → dispatched with correct nick/channel/text
  - TOPIC event with server prefix (no `!`) → dispatched with empty nick/ident/hostname
  - TOPIC event during startup grace → not dispatched
  - TOPIC event after grace expires → dispatched
  - QUIT event → dispatched with correct fields
  - Bot's own QUIT → not dispatched

---

### Phase 1: `ChannelSettings` core module

**Goal:** A DB-backed registry of typed per-channel settings. Plugins register definitions; the
framework stores and retrieves values. Defs live in memory; values live in SQLite.

- [ ] Add types to `src/types.ts`:

  ```typescript
  export type ChannelSettingType = 'flag' | 'string' | 'int';

  export type ChannelSettingValue = boolean | string | number;

  /** A typed per-channel setting definition registered by a plugin. */
  export interface ChannelSettingDef {
    key: string; // globally unique key, e.g. 'bitch', 'greet_msg'
    type: ChannelSettingType;
    default: ChannelSettingValue;
    description: string; // shown in .chaninfo output
  }

  /** ChannelSettingDef with its owning plugin attached (internal + PluginAPI). */
  export interface ChannelSettingEntry extends ChannelSettingDef {
    pluginId: string;
  }
  ```

- [ ] Create `src/core/channel-settings.ts`:

  ```typescript
  export class ChannelSettings {
    private defs: Map<string, ChannelSettingEntry> = new Map();

    constructor(private readonly db: BotDatabase) {}

    register(pluginId: string, defs: ChannelSettingDef[]): void;
    // For each def:
    //   If key is already registered by a DIFFERENT pluginId: log a warning and skip.
    //   If key is registered by the SAME pluginId (reload): replace silently.
    // Store each accepted def tagged with pluginId.

    unregister(pluginId: string): void;
    // Remove all defs owned by pluginId.
    // Do NOT touch stored DB values — operator data must survive plugin unloads.

    get(channel: string, key: string): ChannelSettingValue;
    // Read stored value from DB (namespace 'chanset', key '${channel}:${key}').
    // Coerce to the def's type: flag → boolean, int → parseInt, string → raw.
    // Return def.default if no stored value exists.
    // Return '' if def is unknown (graceful degradation — plugin may be unloaded).

    set(channel: string, key: string, value: ChannelSettingValue): void;
    // Validate the key is registered (warn and no-op if not).
    // Store String(value) in DB under namespace 'chanset', key '${channel}:${key}'.

    unset(channel: string, key: string): void;
    // Delete stored value from DB. Next get() returns def.default.

    isSet(channel: string, key: string): boolean;
    // Returns true if a stored value exists (i.e. operator has explicitly set it).

    getDef(key: string): ChannelSettingEntry | undefined;

    getAllDefs(): ChannelSettingEntry[];
    // All registered defs across all plugins, in registration order.

    getChannelSnapshot(channel: string): Array<{
      entry: ChannelSettingEntry;
      value: ChannelSettingValue;
      isDefault: boolean;
    }>;
    // Returns all registered defs with their current values for the given channel.
    // isDefault = true when no stored value exists.
  }
  ```

- [ ] Verification (`tests/core/channel-settings.test.ts`):
  - `register` + `getDef`: def retrievable by key; `pluginId` is set
  - `get` with no stored value: returns `def.default`
  - `set` + `get`: stored value returned; coerced to correct type
    - `flag` stored as `"true"` / `"false"` → coerced to `boolean`
    - `int` stored as `"42"` → coerced to `42`
    - `string` stored as `"hello"` → returned as `"hello"`
  - `unset`: subsequent `get` returns `def.default`; `isSet` returns `false`
  - `isSet`: `false` before set, `true` after, `false` after unset
  - `unregister`: def removed from `getAllDefs()`; stored value still in DB (verify by
    re-registering and calling `get`)
  - Key collision: second plugin's def with same key is skipped; original def unchanged
  - Same-plugin re-register: replaces def without error
  - `getChannelSnapshot`: lists all defs with correct values and `isDefault` flags

---

### Phase 2: Wire `ChannelSettings` into `PluginAPI`

**Goal:** Plugins can call `api.channelSettings.register()`, `.get()`, and `.set()` in `init()`.

- [ ] Add `PluginChannelSettings` interface to `src/types.ts`:

  ```typescript
  /** Per-channel settings API provided to plugins. */
  export interface PluginChannelSettings {
    /** Declare per-channel setting definitions for this plugin. Call once in init(). */
    register(defs: ChannelSettingDef[]): void;
    /** Read a per-channel setting. Returns def.default if not set by an operator. */
    get(channel: string, key: string): ChannelSettingValue;
    /** Write a per-channel setting (for plugin-managed settings, e.g. topic text). */
    set(channel: string, key: string, value: ChannelSettingValue): void;
    /** True if an operator has explicitly set this value (not relying on default). */
    isSet(channel: string, key: string): boolean;
  }
  ```

- [ ] Add to `PluginAPI` in `src/types.ts`:

  ```typescript
  // Per-channel settings
  channelSettings: PluginChannelSettings;
  ```

- [ ] Add `channelSettings?: ChannelSettings | null` to `PluginLoaderDeps` in
      `src/plugin-loader.ts`

- [ ] Implement in `createPluginApi()` inside `src/plugin-loader.ts`:

  ```typescript
  channelSettings: Object.freeze({
    register(defs: ChannelSettingDef[]): void {
      channelSettings?.register(pluginId, defs);
    },
    get(channel: string, key: string): ChannelSettingValue {
      return channelSettings?.get(channel, key) ?? '';
    },
    set(channel: string, key: string, value: ChannelSettingValue): void {
      channelSettings?.set(channel, key, value);
    },
    isSet(channel: string, key: string): boolean {
      return channelSettings?.isSet(channel, key) ?? false;
    },
  }),
  ```

- [ ] In `PluginLoader.unload()`, call `this.channelSettings?.unregister(pluginName)` alongside
      `this.helpRegistry?.unregister(pluginName)`

- [ ] In `src/bot.ts`:
  - Import `ChannelSettings` from `./core/channel-settings`
  - Add `readonly channelSettings: ChannelSettings` field
  - Instantiate `this.channelSettings = new ChannelSettings(this.db)` before `PluginLoader`
  - Pass `channelSettings: this.channelSettings` to `PluginLoader` deps

- [ ] Verification:
  - Load a test plugin that calls `api.channelSettings.register([...])` and
    `api.channelSettings.set('#test', 'key', 'value')` → verify via `channelSettings.get()`
  - Reload plugin → def re-registered; stored value intact
  - Unload plugin → def removed; stored value still in DB

---

### Phase 3: `.chanset` and `.chaninfo` core commands

**Goal:** Operators can configure per-channel settings at runtime via the bot command interface.

- [ ] Create `src/core/commands/channel-commands.ts`:

  ```typescript
  export function registerChannelCommands(
    handler: CommandHandler,
    channelSettings: ChannelSettings,
  ): void;
  ```

  #### `.chanset #chan [+/-]key [value]`

  Flags: `+o` required.

  Argument parsing (everything after `.chanset`):

  | Input             | Action                                                           |
  | ----------------- | ---------------------------------------------------------------- |
  | `#chan +key`      | Set flag `key` to `true`                                         |
  | `#chan -key`      | Unset `key` (revert to default); for flags, also sets to `false` |
  | `#chan key value` | Set string or int `key` to `value` (everything after key)        |
  | `#chan key`       | Show current value of `key` for that channel                     |
  | `#chan` only      | Usage error                                                      |

  Error cases:
  - Channel arg missing or doesn't start with `#`/`&` → "Usage: .chanset #chan [+/-]key [value]"
  - Key unknown (no def registered) → "Unknown setting: `key` — is the plugin loaded?"
  - Type mismatch (e.g. `+key` on a `string` def) → "Use `.chanset #chan key value` for string
    settings"
  - Value provided for a flag def → "Use `.chanset #chan +key` or `.chanset #chan -key` for flags"
  - Sanitize string values with `sanitize()` before storage

  #### `.chaninfo #chan`

  Flags: `+o` required.

  Output: one line per registered def, grouped by plugin:

  ```
  Channel settings for #hexbot (3 set, 2 default):
    [chanmod]   bitch          flag   OFF        Deop users without op flag
    [chanmod]   enforce_modes  flag   ON  *      Re-apply channel modes if removed
    [chanmod]   channel_modes  str    "+nt" *    Mode string to enforce
    [greeter]   greet_msg      str    (default)  Per-channel join greeting
    [topic]     protect_topic  flag   OFF        Restore topic if changed by non-op
    [topic]     topic_text     str    (not set)  Enforced topic text
  ```

  `*` marks values that differ from the def's default. `(not set)` for empty strings when no
  value has been stored. If `#chan` has no settings stored at all, say so explicitly.

- [ ] Register in `Bot.start()` alongside other core commands:

  ```typescript
  registerChannelCommands(this.commandHandler, this.channelSettings);
  ```

- [ ] Verification (`tests/core/channel-commands.test.ts`):
  - `.chanset #chan +protect_topic` → `channelSettings.get('#chan', 'protect_topic')` === `true`
  - `.chanset #chan -protect_topic` → `isSet` returns `false`
  - `.chanset #chan greet_msg Hello {nick}!` → stored; retrieved correctly
  - `.chanset #chan greet_msg` (no value) → replies with current value
  - `.chanset #chan unknown_key` → "Unknown setting" reply
  - `.chanset #chan` (no key) → usage error
  - `.chanset #chan +greet_msg` (wrong type for string) → type error reply
  - `.chaninfo #chan` → lists all defs grouped by plugin with `*` markers
  - Permission: caller without `+o` → rejected

---

### Phase 4: Migrate existing plugins

**Goal:** Plugins adopt `api.channelSettings` for settings that vary by channel.

**Default precedence pattern** used in every migration:

```typescript
// At registration time in init(), set default from api.config so the global
// config still works as the baseline:
api.channelSettings.register([
  { key: 'some_flag', type: 'flag', default: api.config.some_flag as boolean ?? false, ... },
]);

// At handler time, read per-channel value (returns default if operator hasn't set it):
const enabled = api.channelSettings.get(ctx.channel, 'some_flag') as boolean;
```

Operators who set nothing in `.chanset` get the `api.config` value as before. Per-channel
overrides layer on top transparently.

#### 4a: `greeter`

Settings to register:

| key         | type     | default                                                   | description                                                      |
| ----------- | -------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `greet_msg` | `string` | `api.config.message \|\| 'Welcome to {channel}, {nick}!'` | Per-channel join greeting (`{channel}` and `{nick}` substituted) |

- [ ] Register in `init()` before binds
- [ ] In join handler, read in this precedence order:
  1. User's custom greet (from `api.db.get(\`greet:${handle}\`)`) — unchanged
  2. Channel's `greet_msg` setting (`api.channelSettings.get(channel, 'greet_msg')`)
  3. Fallback is the def's default, which already reflects `api.config.message`
- [ ] Remove the standalone `const message = api.config.message` local variable —
      the `channelSettings` default covers it
- [ ] Update greeter README: add `greet_msg` channel setting to the config table and note
      that `.chanset #chan greet_msg <text>` sets a channel-specific greeting
- [ ] Verification:
  - No setting stored → global `api.config.message` is used
  - `greet_msg` set on `#foo` → used for joins in `#foo` only
  - User custom greet still overrides channel setting

#### 4b: `topic` plugin

Settings to register:

| key             | type     | default | description                                                      |
| --------------- | -------- | ------- | ---------------------------------------------------------------- |
| `protect_topic` | `flag`   | `false` | Restore topic if changed by a user without `+o` flag             |
| `topic_text`    | `string` | `''`    | The enforced topic text (set automatically on authorized change) |

- [ ] Register in `init()`

- [ ] Add `!settopic <text>` command (flags `o`):
  - Writes `topic_text` via `api.channelSettings.set(channel, 'topic_text', text)`
  - Calls `api.topic(channel, text)` to apply immediately
  - Usage: `!settopic Welcome to #hexbot — development chat`
  - Register help entry: `{ command: '!settopic', flags: 'o', usage: '!settopic <text>',
description: 'Set and lock the channel topic', category: 'topic' }`

- [ ] Bind `'topic'` event using the new bind type (Phase 0):

  ```typescript
  api.bind('topic', '-', '*', (ctx) => {
    if (!ctx.channel) return;
    if (!api.channelSettings.get(ctx.channel, 'protect_topic')) return;

    const enforced = api.channelSettings.get(ctx.channel, 'topic_text') as string;
    if (!enforced) return; // no authoritative topic set yet

    const isAuthorized = api.permissions.checkFlags('o', ctx);
    if (isAuthorized) {
      // Authorized change — update the stored topic
      api.channelSettings.set(ctx.channel, 'topic_text', ctx.text);
    } else {
      // Restore the enforced topic
      api.topic(ctx.channel, enforced);
    }
  });
  ```

- [ ] Update topic README and help entries

- [ ] Verification:
  - `protect_topic = false`: topic changes pass through; `topic_text` not updated
  - `protect_topic = true`, `topic_text = 'Foo'`: non-op changes topic → bot restores `'Foo'`
  - `protect_topic = true`: op changes topic → `topic_text` updated to new value; not reverted
  - `!settopic Foo` → stores `'Foo'` and applies it; subsequent non-op change → reverted to `'Foo'`
  - Startup grace: topic events received within `STARTUP_GRACE_MS` do not trigger restore

#### 4c: `chanmod`

Settings to register — these are the config keys that logically vary per channel. Global defaults
continue to work via `api.config` passed as `default` at registration time.

| key             | type     | default                                   | description                                                |
| --------------- | -------- | ----------------------------------------- | ---------------------------------------------------------- |
| `bitch`         | `flag`   | `config.bitch \|\| false`                 | Deop any user who receives +o without the required op flag |
| `enforce_modes` | `flag`   | `config.enforce_modes \|\| false`         | Re-apply channel mode string if removed                    |
| `channel_modes` | `string` | `config.enforce_channel_modes \|\| '+nt'` | Mode string to enforce when `enforce_modes` is on          |
| `auto_op`       | `flag`   | `config.auto_op \|\| true`                | Auto-op flagged users on join                              |
| `protect_ops`   | `flag`   | `config.punish_deop \|\| false`           | Punish users who deop a flagged op                         |
| `enforcebans`   | `flag`   | `config.enforcebans \|\| false`           | Kick users who match a new ban mask                        |

Registration belongs in `index.ts` (before `setupAutoOp`, `setupModeEnforce`, etc.) because
`api` is passed down — `setupCommands` and other modules receive `api` and can read channel
settings directly.

- [ ] Register settings in `index.ts` `init()`
- [ ] Update `mode-enforce.ts`:
  - Replace `config.bitch` reads with `api.channelSettings.get(ctx.channel, 'bitch')`
  - Replace `config.enforce_modes` with `api.channelSettings.get(ctx.channel, 'enforce_modes')`
  - Replace `config.enforce_channel_modes` with `api.channelSettings.get(ctx.channel, 'channel_modes')`
  - Replace `config.punish_deop` with `api.channelSettings.get(ctx.channel, 'protect_ops')`
  - Replace `config.enforcebans` with `api.channelSettings.get(ctx.channel, 'enforcebans')`
- [ ] Update `auto-op.ts`: replace `config.auto_op` with
      `api.channelSettings.get(ctx.channel, 'auto_op')`
- [ ] `config.json` keeps all these keys as global defaults (no removal) — passing them as
      `default` in the registration call is sufficient

- [ ] Verification:
  - All existing chanmod tests pass unchanged (global config still drives behavior)
  - New: channel A has `bitch = true`, channel B has `bitch = false` → deopping behavior
    differs per channel
  - New: `enforce_modes` on in channel A but off in channel B → mode re-enforcement only in A

---

## Architecture

```
Operator (DCC/REPL)
       |
       | .chanset #hexbot +bitch
       | .chaninfo #hexbot
       v
CommandHandler
       |
       v
channel-commands.ts
       |
       | channelSettings.set('#hexbot', 'bitch', true)
       | channelSettings.getChannelSnapshot('#hexbot')
       v
ChannelSettings              ← src/core/channel-settings.ts
  defs: Map<key, entry>  ←─── api.channelSettings.register(defs)   (plugin init)
  db: BotDatabase
       |
       | get/set with namespace='chanset', key='#hexbot:bitch'
       v
BotDatabase (kv table)

Plugin handler:
  api.channelSettings.get(ctx.channel, 'bitch')  →  ChannelSettings.get()
```

---

## Eggdrop comparison

| Eggdrop                     | hexbot equivalent                                       | Notes                                |
| --------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `setudef flag varname`      | `api.channelSettings.register([{ type: 'flag', ... }])` | Plugin declares vars in `init()`     |
| `setudef int varname`       | `{ type: 'int', ... }`                                  |                                      |
| `setudef str varname`       | `{ type: 'string', ... }`                               |                                      |
| `.chanset #chan +flag`      | `.chanset #chan +flag`                                  | Identical syntax                     |
| `.chanset #chan -flag`      | `.chanset #chan -flag`                                  | Unsets / reverts to default          |
| `.chanset #chan var value`  | `.chanset #chan var value`                              | Identical                            |
| `.chanset #chan var`        | `.chanset #chan var`                                    | Shows current value                  |
| `.chaninfo #chan`           | `.chaninfo #chan`                                       | Lists all settings grouped by plugin |
| `channel get #chan var`     | `api.channelSettings.get(channel, key)`                 | Read in handler                      |
| `channel set #chan var val` | `api.channelSettings.set(channel, key, val)`            | Write in handler                     |
| `channel islinked #chan`    | —                                                       | Out of scope                         |

---

## Database changes

No new tables. Extended `kv` table:

| namespace | key format           | example value              | set by                                 |
| --------- | -------------------- | -------------------------- | -------------------------------------- |
| `chanset` | `#chan:key`          | `"true"`                   | `.chanset` or plugin                   |
| `chanset` | `#hexbot:bitch`      | `"true"`                   | `.chanset #hexbot +bitch`              |
| `chanset` | `#hexbot:greet_msg`  | `"Welcome, {nick}!"`       | `.chanset #hexbot greet_msg ...`       |
| `chanset` | `#hexbot:topic_text` | `"Dev chat — no flooding"` | `!settopic` or authorized topic change |

Values persist across plugin reloads and bot restarts. `unregister()` never deletes values.

---

## Config changes

`plugins.json` and `bot.json` schemas are unchanged.

`api.config` continues to work as global defaults. No existing config keys are removed — plugin
registration uses them as `default` values, so operators who have not run `.chanset` get identical
behavior to before.

---

## Test plan

- `tests/irc-bridge.test.ts` — `topic` and `quit` dispatch (Phase 0)
- `tests/core/channel-settings.test.ts` — full unit coverage of `ChannelSettings` class (Phase 1)
- `tests/core/channel-commands.test.ts` — `.chanset` and `.chaninfo` command tests (Phase 3)
- `tests/plugins/greeter.test.ts` — per-channel greet precedence: user > channel > global (Phase 4a)
- `tests/plugins/topic.test.ts` — `protect_topic` + `topic_text` + `'topic'` bind type (Phase 4b)
- `tests/plugins/chanmod.test.ts` — per-channel `bitch`/`enforce_modes`/`auto_op` (Phase 4c)

---

## Open questions

1. **Key collision policy**: log + skip vs. throw. Suggested: log a warning and skip the
   duplicate at `register()` time. Throwing would prevent a plugin from loading if another
   plugin with a conflicting key is already loaded — bad DX. Log is sufficient.

2. **`!settopic` vs. `.chanset` only**: should `topic_text` be settable only via `.chanset`
   (consistent admin interface) or also via an in-channel `!settopic` command? Both can coexist:
   `!settopic` is the ergonomic in-channel op command; `.chanset` is the admin override. Both
   write the same `topic_text` key.

3. **`enforce_modes` migration path**: `chanmod` currently reads `enforce_modes` from
   `api.config` as a simple boolean. After migration, the channel setting overrides it. Operators
   with `enforce_modes: true` in their `config.json` will see no change (default = config value).
   Confirmed acceptable?

4. **Startup grace window for topic**: should the `STARTUP_GRACE_MS` constant be shared with
   chanmod's mode-enforcement grace period, or each plugin manages its own? Suggestion: each plugin
   uses its own guard — they may have different timing needs and should not share state.

5. **`.chanset` from REPL**: the REPL command context has `source: 'repl'` and no IRC nick.
   The command handler already dispatches REPL commands; `.chanset` takes the channel as an
   explicit argument, so it works transparently from the REPL. Confirm no special handling needed.

6. **`quit` bind in `seen` plugin**: now that `quit` events are dispatched, `seen` should record
   quit events as last-seen. This is a small improvement that can be done in Phase 4 or as a
   follow-up.
