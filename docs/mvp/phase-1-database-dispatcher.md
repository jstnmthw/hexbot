# Plan: Phase 1 — Database + Dispatcher

## Summary

Build the two foundational modules that everything else depends on: the SQLite database wrapper and the Eggdrop-style event dispatcher. These are fully testable in isolation — no IRC connection needed. This phase ends with a solid test suite proving both modules work correctly.

## Dependencies

- [x] Phase 0 complete (project scaffolding, pnpm install works)

---

## Phase 1A: Database module

**Goal:** A working namespaced key-value store backed by SQLite.

- [ ] Create `src/database.ts` implementing the `Database` class:
  - `async open()` — opens SQLite, creates `kv` and `mod_log` tables if not exist, enables WAL mode
  - `get(namespace, key)` — returns value string or null
  - `set(namespace, key, value)` — upsert, auto-JSON-stringify non-strings
  - `del(namespace, key)` — delete a key
  - `list(namespace, prefix?)` — list keys in a namespace, optionally filtered by prefix
  - `close()` — close the database connection
  - **Security:** All queries MUST use parameterized statements (prepared statements with `?` placeholders). Never concatenate user input into SQL. Namespace isolation must be enforced in the class — callers cannot access a namespace they didn't request.
- [ ] Table schemas:

```sql
CREATE TABLE IF NOT EXISTS kv (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT,
  updated   INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS mod_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER DEFAULT (unixepoch()),
  action    TEXT NOT NULL,
  channel   TEXT,
  target    TEXT,
  by        TEXT,
  reason    TEXT
);
```

- `logModAction(action, channel, target, by, reason?)` — insert into mod_log
- `getModLog(filter?)` — query mod_log with optional channel/action/target filters
- [ ] Create `tests/database.test.ts`:
  - Test open/close lifecycle
  - Test set and get (string values)
  - Test set and get (JSON objects auto-stringified)
  - Test get returns null for missing keys
  - Test del removes a key
  - Test list returns all keys in namespace
  - Test list with prefix filter
  - Test namespace isolation (plugin A can't see plugin B's keys)
  - Test overwrite (set same key twice, get returns latest)
  - Use a temp file or `:memory:` for test database
- [ ] **Verify:** `pnpm vitest run tests/database.test.ts` — all tests pass

## Phase 1B: Event dispatcher

**Goal:** The Eggdrop-style bind/unbind system with full bind type support, wildcard matching, flag checking (stubbed), and stackable vs non-stackable behavior.

- [ ] Create `src/utils/wildcard.ts`:
  - Export `wildcardMatch(pattern, text, caseInsensitive?)` — `*` and `?` wildcard matcher
  - Pure function, no state — shared by dispatcher and permissions
- [ ] Create `tests/utils/wildcard.test.ts`:
  - Test exact match
  - Test `*` matches any string
  - Test `?` matches single character
  - Test `*word*` pattern
  - Test case-insensitive mode
  - Test empty pattern / empty text edge cases
- [ ] Create `src/dispatcher.ts` implementing the `EventDispatcher` class:
  - `bind(type, flags, mask, handler, pluginId)` — register a handler
  - `unbind(type, mask, handler)` — remove a specific handler
  - `unbindAll(pluginId)` — remove all handlers for a plugin
  - `async dispatch(type, ctx)` — dispatch an event to matching handlers
  - `listBinds(filter?)` — list registered binds, optionally filtered by type or plugin
  - Internal: `_matchesMask(type, mask, ctx)` — uses `wildcardMatch()` from utils
  - Internal: `_checkFlags(requiredFlags, ctx)` — flag checking (accept a permissions object in constructor, but work without one — return true if no permissions system)
  - **Security:** Flag checking MUST happen before the handler is called, never after. Handler errors MUST be caught in try/catch so one bad handler cannot crash the dispatch loop or prevent other handlers from firing. See `docs/SECURITY.md` sections 3 and 4.
  - Stackable types: `pubm`, `msgm`, `join`, `part`, `kick`, `nick`, `mode`, `raw`, `time`, `notice`
  - Non-stackable types: `pub`, `msg` (overwrite previous bind on same mask)
  - Timer (`time`) binds: set up `setInterval`, clean up on unbind/unbindAll
  - Hit counter: each bind entry tracks how many times it's been triggered
- [ ] Create `tests/core/dispatcher.test.ts`:
  - Test bind and dispatch for `pub` type (exact command match)
  - Test bind and dispatch for `pubm` type (wildcard match)
  - Test `msg` and `msgm` types
  - Test `join` type with `*` mask and specific channel mask
  - Test non-stackable: binding same mask twice overwrites
  - Test stackable: binding same mask twice calls both handlers
  - Test `unbind` removes the correct handler
  - Test `unbindAll` removes only the specified plugin's binds
  - Test `_checkFlags` returns true when no permissions system (flags = `-`)
  - Test handler errors are caught and don't crash dispatch
  - Test `listBinds` returns correct entries with hit counts
  - Test `time` binds fire on interval (use short interval + setTimeout to verify)
  - Test `time` binds are cleaned up on unbindAll
  - Test case-insensitive matching for pub/msg commands
  - Test dispatch returns without error when no binds exist for a type
- [ ] **Verify:** `pnpm vitest run tests/core/dispatcher.test.ts` — all tests pass

## Phase 1C: Integration check

- [ ] Run full test suite: `pnpm test` — all tests from 1A and 1B pass together
- [ ] Verify no circular dependencies between database.ts and dispatcher.ts (they should be independent)

---

## Verification

**This phase is complete when:**

1. `pnpm vitest run tests/database.test.ts` — all pass
2. `pnpm vitest run tests/core/dispatcher.test.ts` — all pass
3. `pnpm test` — all tests pass (database + dispatcher combined)
4. Both modules export clean ESM interfaces
5. No lint errors or unhandled promise rejections in tests

## Next phase

Phase 2: Permissions + Command Handler
