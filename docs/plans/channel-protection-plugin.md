# Plan: Channel Protection Plugin

## Summary

A channel protection plugin (`chanop`) that consolidates all channel operator functionality into one plugin. It replaces the existing `auto-op` plugin and adds manual moderation commands: `!op`, `!deop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`. It also adds mode enforcement — if a user who should have ops/voice gets deopped/devoiced, the bot immediately re-applies their mode. Auto-op/voice and mode enforcement are independently toggleable via config.

## Feasibility

- **Alignment**: Fully aligned with DESIGN.md. Phase 2 explicitly calls for channel protection plugins. The plugin API already exposes `op`, `deop`, `voice`, `devoice`, `kick`, `ban`. The auto-op plugin's logic is straightforward to absorb.
- **Dependencies**: All required core modules are built and working:
  - `PluginAPI.op/deop/voice/devoice/kick/ban` — available via `IRCCommands`
  - `Permissions.checkFlags` / `findByHostmask` — flag lookup for auto-op and mode enforcement
  - `ChannelState.getUserHostmask` — needed for `!ban` nick → ban mask resolution
  - `api.bind('mode', ...)` — needed for mode enforcement (react to deop/devoice events)
  - `api.bind('join', ...)` — needed for auto-op on join (migrated from auto-op plugin)
- **Blockers**: None. All infrastructure exists. The `auto-op` plugin and its tests will be removed.
- **Complexity estimate**: M (day) — mode commands are straightforward, but mode enforcement adds event handling complexity
- **Risk areas**:
  - **Mode enforcement loops**: If two bots both enforce modes, they could fight. The bot must detect that a mode change came from itself and skip re-enforcement. Also must not re-enforce if the bot itself was the one who deopped (via `!deop`).
  - **Ban mask generation**: If the target isn't in the channel or channel-state doesn't have their hostmask yet, need graceful fallback.
  - **Bot must have +o** in the channel for any of these to work.
  - **NickServ race on join**: Auto-op inherits the existing ACC verification logic from auto-op.

## Dependencies

- [x] `src/core/irc-commands.ts` — op/deop/voice/devoice/kick/ban wrappers
- [x] `src/core/permissions.ts` — flag checking, hostmask lookup
- [x] `src/core/channel-state.ts` — user hostmask lookup, mode tracking
- [x] `src/plugin-loader.ts` — scoped API with all needed methods
- [x] `src/types.ts` — PluginAPI, HandlerContext interfaces
- [x] `plugins/auto-op/` — existing plugin to absorb and then delete

## Phases

### Phase 1: Plugin scaffold, auto-op migration, and basic mode commands

**Goal:** `chanop` plugin replaces `auto-op` with auto-op/voice on join + `!op`, `!deop`, `!voice`, `!devoice` commands.

- [ ] Create `plugins/chanop/index.ts` with plugin exports (`name`, `version`, `description`, `init`, `teardown`)
- [ ] Create `plugins/chanop/config.json` with defaults (see Config section below)
- [ ] Migrate auto-op join handler from `plugins/auto-op/index.ts`:
  - Bind `join` event with `-` flags (anyone can trigger join)
  - Look up joining user's hostmask in permissions
  - Check if their flags match `op_flags` or `voice_flags` config arrays
  - Optionally verify via NickServ ACC (same logic as current auto-op)
  - Apply +o or +v as appropriate
  - Gate behind `auto_op` config toggle — skip if disabled
- [ ] Bind `!op [nick]` as `pub` type with `+o` flag — ops the target nick (or the caller if no arg)
- [ ] Bind `!deop [nick]` as `pub` type with `+o` flag — deops the target nick (or the caller if no arg)
- [ ] Bind `!voice [nick]` as `pub` type with `+o` flag — voices the target nick (or the caller if no arg)
- [ ] Bind `!devoice [nick]` as `pub` type with `+o` flag — devoices the target nick (or the caller if no arg)
- [ ] Validate: target nick cannot contain `\r`, `\n`, or spaces; reject if invalid
- [ ] Prevent targeting the bot itself for deop (warn the user)
- [ ] **Verification:** Load plugin via mock-bot, simulate join → confirm auto-op works. Simulate `!op` from user with +o flag → confirm mode sent. Confirm denied for user without flag.

### Phase 2: Mode enforcement

**Goal:** When a user who should have ops/voice is deopped/devoiced by someone else, the bot re-applies their mode immediately.

- [ ] Bind `mode` event with `-` flags to watch for `-o` and `-v` changes
- [ ] When a `-o` or `-v` is detected on a user:
  1. Skip if `enforce_modes` config is `false`
  2. Skip if the mode change came from the bot itself (prevent loops)
  3. Look up the affected user's hostmask from channel-state
  4. Check their permission flags against `op_flags` / `voice_flags`
  5. If they should have the mode, re-apply it with a brief delay (avoid rapid mode flapping)
- [ ] Track which mode changes the bot initiated (via `!deop`/`!devoice` commands) so those are NOT re-enforced — only external deops trigger re-enforcement
- [ ] Gate behind `enforce_modes` config toggle — disabled by default
- [ ] **Verification:** Load plugin with enforcement enabled. Simulate a mode `-o` on a user with +o flags → confirm bot re-ops them. Simulate `!deop nick` → confirm bot does NOT re-op (intentional deop). Simulate mode change from the bot's own nick → confirm no loop.

### Phase 3: Kick and ban commands

**Goal:** `!kick`, `!ban`, `!unban`, `!kickban` working with permission checks.

- [ ] Bind `!kick <nick> [reason]` as `pub` type with `+o` flag
  - Parse args: first word is nick, rest is reason (default: `default_kick_reason` from config)
  - Validate nick argument exists (reply with usage if missing)
  - Prevent kicking the bot itself
- [ ] Bind `!ban <nick|mask>` as `pub` type with `+o` flag
  - If argument contains `!` or `@`, treat as explicit ban mask (sanitize first)
  - If plain nick, look up via `api.getUserHostmask(channel, nick)` → generate `*!*@host` mask
  - If hostmask lookup fails, reply with error suggesting explicit mask
- [ ] Bind `!unban <mask>` as `pub` type with `+o` flag — removes a ban
- [ ] Bind `!kickban <nick> [reason]` as `pub` type with `+o` flag — bans then kicks in one step
- [ ] **Verification:** Simulate `!kick BadUser spamming` → confirm KICK sent. Simulate `!ban nick` with known hostmask → confirm +b with `*!*@host`. Test `!kickban`. Test unknown nick error.

### Phase 4: Remove auto-op plugin

**Goal:** Clean removal of the old plugin with no leftover references.

- [ ] Delete `plugins/auto-op/` directory (index.ts, config.json)
- [ ] Delete `tests/plugins/auto-op.test.ts`
- [ ] Update `config/plugins.example.json`: remove `auto-op` entry, add `chanop` entry
- [ ] **Verification:** `pnpm test` passes with no auto-op references. Grep codebase for `auto-op` to confirm clean removal.

### Phase 5: Tests

**Goal:** Full test coverage for the chanop plugin.

**Auto-op tests (migrated + expanded):**
- [ ] Test: user with +o flag joins → auto-opped
- [ ] Test: user with +v flag joins → auto-voiced
- [ ] Test: user with +n flag joins → auto-opped (owner implies op)
- [ ] Test: unknown user joins → nothing happens
- [ ] Test: user with flags for different channel → nothing happens
- [ ] Test: auto_op disabled in config → no auto-op on join
- [ ] Test: bot itself joins → not self-opped

**Mode enforcement tests:**
- [ ] Test: user with +o flags gets deopped externally → bot re-ops them
- [ ] Test: user with +v flags gets devoiced externally → bot re-voices them
- [ ] Test: user deopped via `!deop` command → bot does NOT re-op (intentional)
- [ ] Test: mode change from bot itself → no re-enforcement (loop prevention)
- [ ] Test: enforce_modes disabled in config → no re-enforcement
- [ ] Test: user without flags gets deopped → nothing happens

**Command tests:**
- [ ] Test: `!op nick` from user with +o flag → mode +o sent
- [ ] Test: `!op` with no args → ops the caller
- [ ] Test: `!op nick` from user without +o flag → no mode sent (dispatcher blocks)
- [ ] Test: `!deop nick` → mode -o sent
- [ ] Test: `!voice nick` / `!devoice nick` → correct modes
- [ ] Test: `!kick nick reason` → KICK sent with reason
- [ ] Test: `!kick` with no args → usage reply
- [ ] Test: `!ban nick` with known hostmask → +b `*!*@host` sent
- [ ] Test: `!ban nick` with unknown hostmask → error reply
- [ ] Test: `!ban *!*@bad.host` with explicit mask → +b with that mask
- [ ] Test: `!unban mask` → -b sent
- [ ] Test: `!kickban nick reason` → ban then kick
- [ ] Test: cannot kick/deop the bot itself
- [ ] Test: newline injection in nick argument is rejected

## Config changes

Plugin's own `plugins/chanop/config.json`:

```json
{
  "auto_op": true,
  "enforce_modes": false,
  "op_flags": ["n", "m", "o"],
  "voice_flags": ["v"],
  "verify_timeout_ms": 5000,
  "notify_on_fail": false,
  "default_kick_reason": "Requested",
  "default_ban_reason": "Banned",
  "enforce_delay_ms": 500
}
```

| Field | Type | Description |
|-------|------|-------------|
| `auto_op` | boolean | Auto-op/voice users on join based on their flags |
| `enforce_modes` | boolean | Re-apply ops/voice when a flagged user is deopped/devoiced externally |
| `op_flags` | string[] | Permission flags that qualify for auto-op |
| `voice_flags` | string[] | Permission flags that qualify for auto-voice |
| `verify_timeout_ms` | number | NickServ ACC verification timeout (ms) |
| `notify_on_fail` | boolean | Notice the user if NickServ verification fails |
| `default_kick_reason` | string | Default reason for `!kick` when none provided |
| `default_ban_reason` | string | Default reason for `!ban` when none provided |
| `enforce_delay_ms` | number | Delay before re-enforcing a mode (avoids rapid flapping) |

New entry in `config/plugins.example.json` (replaces `auto-op`):

```json
{
  "chanop": {
    "enabled": true,
    "channels": ["#mychannel"]
  }
}
```

## Database changes

None. Ban/kick actions are logged through the existing `mod_log` table via `IRCCommands`. Timed bans (auto-expire) are deferred to a later iteration.

## Test plan

All tests use the `createMockBot` helper and follow the pattern established by `auto-op.test.ts`:

1. Create mock bot, load the chanop plugin
2. Add test users to permissions with appropriate flags
3. Simulate IRC events (join, mode, privmsg) via `bot.client.simulateEvent()`
4. Assert on `bot.client.messages` for expected mode/kick/raw output
5. Assert that unauthorized users get no action

Key areas to cover:
- Auto-op on join (migrated from auto-op tests)
- Mode enforcement (re-op/re-voice on external deop/devoice)
- Loop prevention (bot doesn't re-enforce its own intentional deops)
- Permission enforcement for each command
- Input validation (missing args, newline injection)
- Ban mask generation from nick → hostmask lookup
- Self-protection (can't kick/deop the bot)
- Config toggles (auto_op and enforce_modes can be independently disabled)

## Decisions (resolved)

1. **Plugin name**: `chanop` — avoids confusion with network ChanServ services
2. **Flag levels**: All commands (including ban/unban) require `+o` — matches how real IRC channels work
3. **Ban mask style**: `*!*@host` only — simple, covers 90% of cases. More styles can be added later.
4. **Self-targeting**: `!op` with no args ops the caller — convenient Eggdrop-style behavior
5. **Auto-op migration**: `auto-op` plugin is fully absorbed into `chanop` and deleted
6. **Mode enforcement**: Re-applies modes when flagged users are deopped/devoiced externally; tracks intentional deops to avoid re-enforcing `!deop` commands; gated behind `enforce_modes` config (default: off)
