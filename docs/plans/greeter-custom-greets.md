# Plan: User Custom Greets for Greeter Plugin

## Summary

Extend the greeter plugin so registered users can set a personal greeting that fires
when they join a channel. A `min_flag` config controls the minimum privilege level
required to set or change a greeting (e.g. `"v"` = voice or higher, `"o"` = op or higher).
When a user who has a custom greet set joins a channel, their custom message is used
instead of the default template. Greets are stored in the plugin's namespaced KV store
keyed by the user's bot handle.

## Feasibility

- **Alignment**: Fits cleanly within the plugin architecture. Uses existing bind system,
  KV store, and `PluginPermissions` API — no core changes needed.
- **Dependencies**: Greeter plugin (exists), permissions module (exists), KV store (exists).
- **Blockers**: None.
- **Complexity**: S (a few hours).
- **Risk areas**:
  - Message injection: custom greet strings must have `\r` and `\n` stripped before use.
  - Flag "at least X" semantics: `userHasFlag` does simple string inclusion, so having
    `o` does NOT automatically satisfy a `+v` check. A custom `meetsMinFlag` helper is
    needed to implement "at least this level" hierarchy.
  - Hostmask lookup at join time adds a tiny DB read per join — negligible at IRC scale.

## Dependencies

- [x] Greeter plugin (`plugins/greeter/index.ts`)
- [x] `api.permissions.findByHostmask()` available in `PluginAPI`
- [x] `api.db` (namespaced KV store) available in `PluginAPI`
- [x] `VALID_FLAGS = 'nmov'` ordering in `src/core/permissions.ts`

## Phases

### Phase 1: Config schema update

**Goal:** Add `allow_custom` and `min_flag` fields to the plugin config.

- [ ] Update `plugins/greeter/config.json` to add `allow_custom: true` and `min_flag: "v"`.
- [ ] In `plugins/greeter/index.ts`, read these two config fields with sensible defaults
      (`allow_custom` defaults to `false` to keep existing behaviour unchanged; `min_flag`
      defaults to `"v"`).
- [ ] Verification: plugin still loads and default greeting still fires with no config
      changes.

### Phase 2: Flag hierarchy helper

**Goal:** Implement a utility that checks "at least X level" given the `n > m > o > v`
ordering defined by `VALID_FLAGS`.

The existing `userHasFlag` (in core) only checks string inclusion. Having flag `o` does
NOT automatically satisfy a `+v` check. We need a helper that treats the ordering
hierarchically: if the required minimum is `v` (lowest), then having `o`, `m`, or `n`
also satisfies it.

- [ ] Add a private `meetsMinFlag(userRecord: UserRecord, minFlag: string, channel: string | null): boolean`
      function inside `plugins/greeter/index.ts`.
  - Map each flag in VALID_FLAGS ordering `nmov` to a numeric level: `n=0, m=1, o=2, v=3`.
  - A user "meets" the minimum if they have any flag whose level ≤ the minFlag's level
    (lower index = higher privilege).
  - Check both global flags and channel-specific flags from the user record.
  - Owner (`n`) always passes any check.
- [ ] Verification: unit test the helper directly (see Test Plan).

### Phase 3: Commands — `!setgreet` and `!delgreet`

**Goal:** Let users set and remove their custom greeting via a single `!greet` command
with subcommands.

- [ ] Add a single `pub` bind for `!greet` with flags `-` (fire for everyone; auth is
      checked manually inside the handler so the bot can give a useful denial message).
      Dispatch on `ctx.args` trimmed:
  - **`!greet` (no args)**: look up the caller's user record; if found and a KV greet
    exists, reply privately with it; otherwise reply privately: "No custom greet set."
  - **`!greet set <message>`**: subcommand is `set`, remainder is the message.
    - If `allow_custom` is `false`, reply privately: "Custom greets are disabled."
    - Look up the user's record via `api.permissions.findByHostmask(nick!ident@host)`.
    - If no record found, reply privately: "You must be a registered user to set a greet."
    - If record found but `meetsMinFlag` returns false, reply privately:
      "You need at least `+<min_flag>` to set a custom greet."
    - Otherwise: validate message (strip `\r\n`, enforce max length of 200 chars), store
      in KV as key `greet:{handle}`, reply privately: "Custom greet set."
  - **`!greet del`**: same auth checks (registered + meetsMinFlag); delete KV key
    `greet:{handle}`, reply privately: "Custom greet removed."
  - **Unknown subcommand**: reply privately: "Usage: !greet | !greet set <message> | !greet del"
- [ ] Verification: load plugin in a test and fire pub dispatch events for `!greet`,
      `!greet set`, and `!greet del`; confirm KV reads/writes and reply calls.

### Phase 4: Join handler — custom greet lookup

**Goal:** When a user with a saved custom greet joins, use it instead of the default.

- [ ] In the existing `join` bind handler in `plugins/greeter/index.ts`, after the bot-nick
      skip check:
  1. Build full hostmask: `` `${ctx.nick}!${ctx.ident}@${ctx.hostname}` ``
  2. Look up user record via `api.permissions.findByHostmask(hostmask)`.
  3. If found, check KV for key `greet:{record.handle}`.
  4. If a custom greet exists: use it (applying `{channel}` / `{nick}` substitutions and
     `stripFormatting` on nick) instead of the default message.
  5. If no custom greet or no user record: fall back to the existing default message.
- [ ] Verification: dispatch a join event for a user who has a KV greet set; confirm the
      custom message fires. Dispatch a join for a user without one; confirm default fires.

### Phase 5: Plugin restructure (if needed)

**Goal:** Keep the file readable as it grows from ~35 to ~130 lines.

- [ ] If the file exceeds ~100 lines, split into helper functions within the same file
      (no separate modules needed at this scale): `setupCommands(api, cfg)` and
      `setupJoinHandler(api, cfg)`, each returning a teardown function.
- [ ] Update `teardown()` to call sub-teardowns.
- [ ] Verification: existing tests still pass; plugin hot-reloads cleanly.

### Phase 6: Tests and README

**Goal:** Full test coverage and updated documentation.

- [ ] Add test cases to `tests/plugins/greeter.test.ts` (see Test Plan below).
- [ ] Update `plugins/greeter/README.md` with the new commands and config fields.
- [ ] Verification: `pnpm test` passes with no regressions.

## Config changes

`plugins/greeter/config.json` (defaults):

```json
{
  "message": "Welcome to {channel}, {nick}!",
  "allow_custom": false,
  "min_flag": "v"
}
```

`plugins.json` example override to enable with op-only restriction:

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "message": "Welcome to {channel}, {nick}!",
      "allow_custom": true,
      "min_flag": "o"
    }
  }
}
```

**`min_flag` values** (uses `nmov` hierarchy, lower index = higher privilege):

| Value | Meaning                   |
| ----- | ------------------------- |
| `"n"` | Owner only                |
| `"m"` | Master or higher          |
| `"o"` | Op or higher              |
| `"v"` | Voice or higher (default) |

> Note: there is no halfop flag in the bot's permission system (`VALID_FLAGS = 'nmov'`).
> "Above halfop" maps to `"o"` (op or higher) in this system.

## Database changes

No new tables. Uses the greeter plugin's existing namespaced KV store.

New keys in the `greeter` namespace:

| Key              | Value                 | Notes                               |
| ---------------- | --------------------- | ----------------------------------- |
| `greet:{handle}` | Custom message string | e.g. `greet:jake` → `"Back again!"` |

Custom greet strings support the same `{channel}` and `{nick}` substitutions as the
default message template.

## Test plan

Add to `tests/plugins/greeter.test.ts`:

- **`meetsMinFlag` helper** (test the exported or locally imported helper directly):
  - User with flag `o` meets `"o"`, `"v"` but not `"m"`, `"n"`.
  - User with flag `n` (owner) meets every level.
  - User with no relevant flags meets nothing.
  - Channel-specific flag `o` satisfies `"v"` minimum when checked against that channel.

- **`!greet set <message>`**:
  - User with `v` flag sets greet → KV key `greet:{handle}` is written.
  - User below `min_flag` threshold is denied (reply check).
  - `allow_custom: false` → denied for everyone.
  - Message with embedded `\r\n` is stripped before storage.
  - Message over 200 chars is rejected.

- **`!greet del`**:
  - Existing greet is removed.
  - No-op when no greet is set (graceful).

- **`!greet` (no args)**:
  - Returns the stored message when one exists.
  - Returns "No custom greet set" when none exists.

- **`!greet <unknown>`**:
  - Returns usage hint.

- **Join handler — custom greet**:
  - User with KV greet triggers custom message on join.
  - `{channel}` and `{nick}` substitutions apply to custom greet.
  - User without KV greet falls back to default template.
  - Unregistered user (no permission record) gets default template (no crash).

- **Regression**: all four existing tests still pass unchanged.

## Open questions

1. **Global vs per-channel greets**: This plan implements a single global greet per user
   (same message in all channels). Should greets be per-channel (key = `greet:{channel}:{handle}`)?
   Per-channel adds complexity (need a `.setgreet #chan message` syntax) but is more
   flexible. Defaulting to global for now; per-channel can be a follow-up.

2. **Custom greet in addition to default, or instead?**: This plan replaces the default
   greeting when a custom one exists. Should both fire (default first, then custom)?
   Or should the custom greet be the only one? Current plan: custom replaces default.

3. **Op override — set greets for others?**: Should ops/masters be able to run
   `!setgreet <handle> <message>` to manage another user's greet? Not included in this
   plan; easy to add as a follow-up.
