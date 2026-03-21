# Plan: Phase 2 — Permissions + Command Handler

## Summary
Build the Eggdrop-style permissions system (hostmask-based identity, n/m/o/v flags with per-channel overrides) and the shared command handler that will serve both the REPL and IRC admin commands. Still no IRC connection — fully testable with unit tests.

## Dependencies
- [x] Phase 0 complete (scaffolding)
- [x] Phase 1 complete (database + dispatcher, tests passing)

---

## Phase 2A: Permissions core module

**Goal:** Users identified by hostmask, flags checked per-channel, persisted to database.

- [x] Create `src/core/permissions.ts` implementing the `Permissions` class:
  - Constructor takes a `Database` instance (or null for testing without persistence)
  - `addUser(handle, hostmask, globalFlags)` — add a user record
  - `removeUser(handle)` — remove a user
  - `addHostmask(handle, hostmask)` — add additional hostmask to existing user
  - `removeHostmask(handle, hostmask)` — remove a hostmask
  - `setGlobalFlags(handle, flags)` — set global flags (e.g., `'nmov'`)
  - `setChannelFlags(handle, channel, flags)` — set per-channel flags
  - `checkFlags(nick, channel, requiredFlags)` — check if nick has required flags
    - `-` = always true
    - `+n` = needs owner
    - `+o` = needs op
    - `+n|+m` = needs owner OR master
    - Owner (`n`) implies all other flags
    - Check global flags first, then channel-specific
  - `findByHostmask(fullHostmask)` — match `nick!ident@host` against stored patterns
  - `findByNick(nick)` — convenience lookup (matches nick portion of stored hostmasks)
  - `getUser(handle)` — return full user record
  - `listUsers()` — return all user records
  - `loadFromDb()` — load all users from database into memory cache
  - `saveToDb()` — persist current state to database
  - Internal: `_hostmaskMatch(pattern, hostmask)` — uses `wildcardMatch()` from `src/utils/wildcard.ts`
  - **Security:** See `docs/SECURITY.md` section 3. Key rules:
    - Warn (log `[security]`) when adding a `nick!*@*` hostmask for users with `+o` or higher flags
    - `findByHostmask` must not short-circuit on first partial match — verify the full `nick!ident@host` pattern
    - Owner flag (`n`) implying all flags is intentional but means `n` accounts are high-value targets
    - Log all permission changes (adduser, deluser, flag changes) with the source (REPL or IRC nick)
- [x] User record shape:
```typescript
{
  handle: 'admin',
  hostmasks: ['*!myident@my.host.com'],
  global: 'nmov',
  channels: { '#main': 'o', '#games': 'v' }
}
```
- [x] Use database namespace `_permissions` for persistence
- [x] Create `tests/core/permissions.test.ts`:
  - Test addUser and getUser
  - Test removeUser
  - Test addHostmask / removeHostmask
  - Test checkFlags with `-` (always passes)
  - Test checkFlags with `+o` (passes for user with `o` flag)
  - Test checkFlags with `+n` owner flag implies all others
  - Test checkFlags with `+n|+m` OR logic
  - Test checkFlags with per-channel flags (user has `o` in #main but not #games)
  - Test checkFlags falls back to global when no channel-specific flags
  - Test findByHostmask with exact match
  - Test findByHostmask with wildcard patterns (`*!*@host`, `*!ident@*`)
  - Test findByHostmask returns null for non-matching hostmask
  - Test database persistence: save, create new instance, load, verify data survives
  - Test listUsers returns all users
- [x] **Verify:** `pnpm vitest run tests/core/permissions.test.ts` — all pass

## Phase 2B: Command handler

**Goal:** A shared command parser/router that takes a command string and dispatches to registered handlers. Transport-agnostic — doesn't care whether input came from REPL, IRC, or a future socket.

- [x] Create `src/command-handler.ts` implementing the `CommandHandler` class:
  - Constructor takes no module references — it's a pure router
  - `async execute(commandString, context)` — parse and execute a command
    - `context` includes `{ source: 'repl'|'irc', nick, channel, reply(msg) }`
  - `registerCommand(name, options, handler)` — register a command
    - `options`: `{ flags, description, usage, category }`
  - `getCommands()` — list all registered commands
  - `getHelp(commandName?)` — return help text for one or all commands
  - Built-in commands (only `.help` — the handler's own concern):
    - `.help [command]` — list commands or show help for one
  - Command prefix: `.` (dot) — consistent with Eggdrop
  - Unknown command returns a helpful error message
  - Empty input is handled gracefully (no-op)

- [x] Create `src/core/commands/` directory for command groups that each module registers:
  - `src/core/commands/permission-commands.ts` — registers `.adduser`, `.deluser`, `.flags`, `.users`
    - Export `registerPermissionCommands(handler, permissions)` function
    - Takes a `CommandHandler` and `Permissions` instance
  - `src/core/commands/dispatcher-commands.ts` — registers `.binds`
    - Export `registerDispatcherCommands(handler, dispatcher)` function

  **Later phases will add more command groups:**
  - Phase 3: `src/core/commands/irc-commands-admin.ts` — `.say`, `.join`, `.part`, `.status`
  - Phase 4: `src/core/commands/plugin-commands.ts` — `.plugins`, `.load`, `.unload`, `.reload`

  Each command group is a small, focused module that only depends on the handler and the module it wraps. No god-constructor needed.

- [x] Create `tests/command-handler.test.ts`:
  - Test `.help` returns list of commands
  - Test `.help <command>` returns help for that command
  - Test registerCommand works correctly
  - Test unknown command returns helpful error
  - Test empty input is handled gracefully
  - Test command parsing with quoted arguments (if needed)
- [x] Create `tests/core/commands/permission-commands.test.ts`:
  - Test `.adduser admin *!test@host nmov` creates user via permissions
  - Test `.flags admin` shows current flags
  - Test `.flags admin +o #channel` sets channel flags
  - Test `.users` lists users
  - Test `.deluser admin` removes user
- [x] Create `tests/core/commands/dispatcher-commands.test.ts`:
  - Test `.binds` returns bind list from dispatcher
- [x] **Verify:** all command tests pass

## Phase 2C: Wire permissions into dispatcher

- [x] Update dispatcher to accept a `Permissions` instance in constructor
- [x] Update `_checkFlags` to use `permissions.checkFlags()` when available
- [x] Add integration test: bind a command with `+o` flag, dispatch with a user who has `o` → handler fires
- [x] Add integration test: bind with `+o`, dispatch with a user who has no flags → handler does not fire
- [x] **Verify:** all existing dispatcher tests still pass, new integration tests pass

## Phase 2D: Full test suite

- [x] Run `pnpm test` — all tests from Phase 1 + Phase 2 pass together
- [x] Verify no regressions in database or dispatcher tests

---

## Verification

**This phase is complete when:**
1. `pnpm vitest run tests/core/permissions.test.ts` — all pass
2. `pnpm vitest run tests/command-handler.test.ts` — all pass
3. `pnpm vitest run tests/core/commands/permission-commands.test.ts` — all pass
4. Dispatcher + permissions integration tests pass
5. `pnpm test` — entire test suite passes (Phase 1 + Phase 2)
6. Permissions correctly persists to and loads from the database
7. Permission commands can add users, set flags, and list users using real (not mocked) permissions and dispatcher instances

## Next phase
Phase 3: Bot Core + IRC Connection
