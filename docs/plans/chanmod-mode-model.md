# Plan: Eggdrop-Style Additive/Subtractive Mode Enforcement

## Summary

Refactor chanmod's `channel_modes` setting from an "exact match" model to Eggdrop's additive/subtractive model. Currently `channel_modes: "nt"` means "the channel should have EXACTLY these modes — anything else is unauthorized and removed." The new model: `channel_modes: "+nt-s"` means "ensure +n and +t are set, ensure -s is removed, leave everything else alone."

This eliminates the bot fighting server-set modes, ChanServ MLOCK, and network-specific modes it doesn't understand (e.g., `+z` on Rizon/UnrealIRCd).

Additionally: add `CHANMODES` ISUPPORT awareness so the bot knows which modes exist on the network, and replace hardcoded `PARAM_MODES` with a dynamic set derived from the server's CHANMODES token.

**Supersedes:** Parts of `enforce-param-modes.md` (Phase 2e's unauthorized mode removal logic will use the new additive/subtractive model instead of the "remove everything not in set" approach).

## Feasibility

- **Alignment:** Fully aligned with DESIGN.md. Follows Eggdrop's proven 30-year model.
- **Dependencies:** None — all required infrastructure exists.
- **Blockers:** None.
- **Complexity:** M (a day) — mostly mechanical updates to parsing and enforcement logic, plus tests.
- **Risk areas:**
  - Behavioral change: operators relying on the exact-match model will find modes they previously auto-removed are now left alone. This is intentional but needs clear migration docs.
  - Backward compatibility: old-format strings (`"nt"`) must still work, treated as `"+nt"`.
  - Dynamic `PARAM_MODES` depends on `getServerSupports()` being populated. Safe because enforcement only runs after connection + ISUPPORT, but fallback to `['k', 'l']` is needed.

## Dependencies

- [x] `plugins/chanmod/mode-enforce.ts` — mode enforcement (exists)
- [x] `plugins/chanmod/helpers.ts` — mode parsing utilities (exists)
- [x] `src/bot.ts` — ISUPPORT plumbing (exists)
- [x] `src/core/channel-state.ts` — channel mode tracking (exists, includes `ch.modes`)
- [x] Channel settings infrastructure — `.chanset` (exists)

## Phases

### Phase 1: New `parseChannelModes()` function

**Goal:** A parser that understands `"+nt-s"` syntax and returns structured add/remove sets.

**File:** `plugins/chanmod/helpers.ts`

- [ ] Add `ParsedChannelModes` interface:
  ```ts
  export interface ParsedChannelModes {
    add: Set<string>; // modes to ensure are set
    remove: Set<string>; // modes to ensure are unset
  }
  ```
- [ ] Implement `parseChannelModes(modeStr: string, paramModes?: Set<string>): ParsedChannelModes`:
  - Walk the string character by character, tracking current direction (`+` or `-`)
  - Characters after `+` go into `add`, characters after `-` go into `remove`
  - **Backward compatibility:** if the string contains no `+` or `-` at all (e.g., `"nt"`), treat every character as additive (`+nt`). No warning emitted — silent compat.
  - Strip param modes (from `paramModes` arg, defaulting to `PARAM_MODES`) from both sets with a warning (use `channel_key`/`channel_limit` instead)
  - A mode cannot be in both `add` and `remove` — last occurrence wins (e.g., `"+n-n"` → `remove: {n}`)
  - Empty string → both sets empty
- [ ] Update existing `parseModesSet()` to delegate: `return parseChannelModes(modeStr, paramModes).add`
- [ ] Verify: unit tests for all parsing cases (see Phase 6)

### Phase 2: Add `CHANMODES` to ISUPPORT + dynamic param modes

**Goal:** The bot knows which modes exist on the network, and parameter modes are derived from ISUPPORT rather than hardcoded.

**Files:** `src/bot.ts`, `plugins/chanmod/helpers.ts`

- [ ] Add `'CHANMODES'` to the `known` array in `src/bot.ts:174`. No other changes needed — existing `getServerSupports()` mechanism handles it.
- [ ] Add `getParamModes(api: PluginAPI): Set<string>` to `plugins/chanmod/helpers.ts`:
  ```ts
  export function getParamModes(api: PluginAPI): Set<string> {
    const chanmodes = api.getServerSupports()['CHANMODES'];
    if (!chanmodes) return PARAM_MODES; // fallback to hardcoded ['k', 'l']
    const [listModes, alwaysParam, paramOnSet] = chanmodes.split(',');
    const set = new Set<string>();
    for (const c of listModes ?? '') set.add(c); // Category A: list modes
    for (const c of alwaysParam ?? '') set.add(c); // Category B: always-param
    for (const c of paramOnSet ?? '') set.add(c); // Category C: param on set
    return set;
  }
  ```
- [ ] Keep `PARAM_MODES` constant as fallback, but all runtime call sites should prefer `getParamModes(api)` when `api` is available
- [ ] Verify: `api.getServerSupports()['CHANMODES']` returns expected value after connection

### Phase 3: Update `syncChannelModes()`

**Goal:** The proactive sync (runs on join and `.chanset` changes) uses additive/subtractive logic.

**File:** `plugins/chanmod/mode-enforce.ts`, function `syncChannelModes()` (lines 49-122)

- [ ] Replace `parseModesSet(channelModes)` at line 66 with `parseChannelModes(channelModes, getParamModes(api))`
- [ ] **Add missing modes** (lines 73-79): Change `desiredModes` → `parsed.add`. Gate behind `enforceModes` (both sides now require enforcement to be on). Filter modes in `add` that are not in `currentModes`, build `+` string.
- [ ] **Remove modes** (lines 82-92): Replace entirely. Still gated behind `enforceModes`. Instead of removing every mode not in the desired set, only remove modes explicitly in `parsed.remove` that ARE present on the channel:

  ```ts
  // Old (exact-match model):
  // const unauthorized = [...currentModes].filter(m => !desiredModes.has(m) && !PARAM_MODES.has(m));

  // New (additive/subtractive model):
  if (enforceModes && parsed.remove.size > 0 && currentModes) {
    const toRemove = [...currentModes].filter((m) => parsed.remove.has(m) && !paramModes.has(m));
    if (toRemove.length > 0) {
      const modeString = '-' + toRemove.join('');
      api.mode(channel, modeString);
      api.log(`Enforcing ${modeString} on ${channel}`);
    }
  }
  ```

- [ ] **Fix log messages:** Change past tense "Removed" to present tense "Enforcing" or "Removing":
  - Line 90: `Removed unauthorized modes` → `Enforcing ${modeString} on ${channel}`
  - Line 105: `Removed unauthorized channel key` → `Removing unauthorized channel key on ${channel}`
  - Line 118: `Removed unauthorized channel limit` → `Removing unauthorized channel limit on ${channel}`
- [ ] Verify: bot joins channel with `+ntsz`, config is `"+nt-s"` → bot removes `-s`, leaves `+z` alone

### Phase 4: Update reactive mode handler

**Goal:** Real-time mode change reactions use additive/subtractive logic.

**File:** `plugins/chanmod/mode-enforce.ts`, the handler bound in `setupModeEnforce()` (lines ~142-414)

- [ ] Replace `parseModesSet(channelModes)` with `parseChannelModes(channelModes, getParamModes(api))`
- [ ] **Re-apply removed modes** (lines ~159-168): When someone removes a mode (e.g., `-t`), check if `modeChar` is in `parsed.add` AND `enforceModes` is on. If yes, re-apply `+modeChar`. Uses `parsed.add` instead of the flat set.
- [ ] **React to added modes** (lines ~170-189): When someone adds a mode (e.g., `+s`), check if `modeChar` is in `parsed.remove`. If yes, re-apply `-modeChar`. If `modeChar` is not in `add` AND not in `remove` (unmentioned), do **nothing**. This replaces the aggressive "not in desired set = unauthorized" logic.
  ```ts
  // Old: if (!enforceChannelModeSet.has(modeChar) && !PARAM_MODES.has(modeChar)) → remove
  // New: if (parsed.remove.has(modeChar)) → remove; else → ignore
  ```
- [ ] Verify: user sets `+i` on channel with config `"+nt-s"` → bot ignores it (not in remove set). User sets `+s` → bot removes it.

### Phase 5: Update setting descriptions and config

**Goal:** Help text reflects the new format.

**File:** `plugins/chanmod/index.ts`

- [ ] Update `channel_modes` description (line ~40) from:
      `'Mode string to enforce when enforce_modes is on (e.g. "imnpst")'`
      to:
      `'Mode string to enforce (e.g. "+nt-s"); modes not mentioned are left alone. Legacy format "nt" treated as "+nt".'`
- [ ] No changes to `config.json` (default is `""` which is valid in both models)

### Phase 6: Tests

**Goal:** Full coverage of the new parsing and enforcement behavior.

**File:** `tests/plugins/chanmod.test.ts` and `plugins/chanmod/helpers.ts` tests

#### 6a: `parseChannelModes()` unit tests

- [ ] New describe block in helpers test (or chanmod test):
  - `"+nt-s"` → `add: {n, t}, remove: {s}`
  - `"nt"` (legacy) → `add: {n, t}, remove: {}` (backward compat)
  - `"+nt"` → `add: {n, t}, remove: {}`
  - `"-si"` → `add: {}, remove: {s, i}`
  - `"+nt-si+m"` → `add: {n, t, m}, remove: {s, i}`
  - `"+n-n"` (conflict) → last wins: `add: {}, remove: {n}`
  - `""` (empty) → both sets empty
  - `"+ntk"` (param mode) → stripped from add with warning, `add: {n, t}`
  - `"-kl"` (param modes in remove) → stripped

#### 6b: Sync behavior tests

- [ ] Channel has `+ntsz`, config `"+nt-s"` → bot sends `-s`, does NOT send `-z`
- [ ] Channel has `+nts`, config `"+nt-s"` → bot sends `-s`
- [ ] Channel has `+nt`, config `"+nt-s"` → bot sends nothing (no modes to add or remove)
- [ ] Channel has `+n`, config `"+nt-s"` → bot sends `+t` (missing add mode)
- [ ] Channel has `+nts`, config `"+nt"` (no remove set) → bot sends nothing (s is not in remove set, left alone)
- [ ] Legacy format: channel has `+nts`, config `"nt"` → bot sends nothing (legacy = additive only, no removals)

#### 6c: Reactive handler tests

- [ ] User sets `+s` with config `"+nt-s"` → bot removes `-s`
- [ ] User sets `+i` with config `"+nt-s"` → bot does nothing (i not mentioned)
- [ ] User removes `-t` with config `"+nt-s"` → bot re-applies `+t`
- [ ] User removes `-s` with config `"+nt-s"` → bot does nothing (s is in remove set, removal is desired)
- [ ] User removes `-i` with config `"+nt-s"` → bot does nothing (i not mentioned)

#### 6d: Update existing tests

- [ ] Find and update tests that rely on the old "exact match" removal behavior. Key test: "removes unauthorized simple modes on join" (~line 3847) — this expects modes not in the set to be removed. Update it to use `"+nt-si"` format to get equivalent behavior.
- [ ] Verify all existing passing tests still pass or are updated

#### 6e: Dynamic `PARAM_MODES` tests

- [ ] When `CHANMODES` ISUPPORT is `"beI,k,l,imnpst"` → param modes include `b,e,I,k,l`
- [ ] When `CHANMODES` is unavailable → fallback to `['k', 'l']`

### Phase 7: Documentation

**Goal:** Operators know what changed and how to migrate.

- [ ] Update `plugins/chanmod/README.md`:
  - Change `channel_modes` examples from `"imnpst"` to `"+nt-s"` format
  - Add "Migration from legacy format" section explaining:
    - Old format `"nt"` is auto-detected and treated as `"+nt"` (additive only)
    - To also remove specific modes, use `"+nt-s"` format
    - Operators who relied on exact-match removal need to explicitly list modes to remove
- [ ] Add `CHANGELOG.md` entry under `[Unreleased]`:
  - `channel_modes` now uses Eggdrop-style `"+nt-s"` format; unmentioned modes are left alone
  - Old format auto-detected for backward compatibility (additive only, no removals)
  - `CHANMODES` ISUPPORT token now exposed via `getServerSupports()`
  - Parameter modes dynamically determined from CHANMODES (hardcoded fallback retained)

## Config changes

No new config fields. Existing `channel_modes` accepts the new format. Old format remains valid.

Example:

```
.chanset #hexbot channel_modes +nt-s
.chanset #hexbot enforce_modes on
```

## Database changes

None. The `channel_modes` value stored in the per-channel settings DB is a string — the new format is just a different string shape. Existing values (e.g., `"nt"`) are handled by backward-compatible parsing.

## Test plan

See Phase 6 above. Summary of key scenarios:

| #   | Scenario                   | Config                     | Channel state      | Expected                                                  |
| --- | -------------------------- | -------------------------- | ------------------ | --------------------------------------------------------- |
| 1   | Sync: remove explicit      | `"+nt-s"`                  | `+ntsz`            | `-s` sent, `z` untouched                                  |
| 2   | Sync: add missing          | `"+nt-s"`                  | `+ns`              | `+t` sent                                                 |
| 3   | Sync: nothing to do        | `"+nt-s"`                  | `+nt`              | no MODE sent                                              |
| 4   | Sync: legacy format        | `"nt"`                     | `+nts`             | `+nt` enforced if missing, `s` left alone (additive only) |
| 5   | Reactive: unauthorized add | `"+nt-s"`                  | user sets `+s`     | `-s` sent                                                 |
| 6   | Reactive: unmentioned add  | `"+nt-s"`                  | user sets `+i`     | ignored                                                   |
| 7   | Reactive: protected remove | `"+nt-s"`                  | user removes `-t`  | `+t` re-applied                                           |
| 8   | Reactive: desired remove   | `"+nt-s"`                  | user removes `-s`  | ignored (removal desired)                                 |
| 9   | Param modes: dynamic       | CHANMODES=`beI,k,l,imnpst` | `"+ntk"` in config | `k` stripped, warning                                     |
| 10  | Param modes: fallback      | no ISUPPORT                | `"+ntk"` in config | `k` stripped via hardcoded set                            |

## Design decisions

1. **`enforce_modes: false` gates BOTH sides.** When enforcement is off, neither `+` additions nor `-` removals run. Matches Eggdrop where `enforcemode` must be set for any mode enforcement to happen. Operators opt into all enforcement with one toggle.

2. **No deprecation warning for old-format strings.** Old format `"nt"` silently works as `"+nt"`. Operators discover the new format from docs.
