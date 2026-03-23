# Plan: CASEMAPPING ISUPPORT Support

## Summary

IRC servers advertise their nick/channel comparison rules via the `CASEMAPPING` ISUPPORT token (005). Hexbot currently hardcodes RFC 1459 semantics everywhere: the existing `ircLower()` in `src/utils/wildcard.ts` applies the `[]{}\|~^` folding table, but all `.toLowerCase()` calls scattered through the codebase apply only ASCII rules. This creates a correctness gap on EFNet/Undernet/IRCNet (rfc1459), strict-rfc1459 networks, and Libera/OFTC (ascii). The fix has three layers:

1. Read `CASEMAPPING` from `client.network.supports('CASEMAPPING')` after connect and store the active mapping in a shared location.
2. Refactor `ircLower()` to accept an explicit `Casemapping` parameter and dispatch to the correct table. Provide a zero-argument form that defaults to `'rfc1459'` for backward compatibility.
3. Replace every nick/channel `.toLowerCase()` call throughout the codebase with `ircLower(text, casemapping)` using the network-provided value.

## Casemapping semantics reference

| CASEMAPPING token | Rules                                                  |
| ----------------- | ------------------------------------------------------ |
| `rfc1459`         | a-z = A-Z, `[` = `{`, `]` = `}`, `\` = `\|`, `~` = `^` |
| `strict-rfc1459`  | Same as rfc1459 but `~` ≠ `^`                          |
| `ascii`           | Only a-z = A-Z (standard JS `.toLowerCase()`)          |

## Key decisions

### Where to store the active casemapping

Store it on `Bot` as a plain `string` property (`activeCasemapping: string`) initialised to `'rfc1459'` (safe default). Expose a getter so it can be read without touching the `IrcClient` directly. Pass it into every module that needs it via a `setCasemapping()` method called from `bot.ts` after the `registered` event fires (when ISUPPORT is guaranteed to be available).

Rationale: a module-level singleton would cause test isolation failures. A property on `Bot` kept in sync via the `registered` event is the pattern already used for `botNick` in `IRCBridge`, and it gives clean dependency injection.

### When CASEMAPPING is available

`irc-framework` parses 005 ISUPPORT before emitting the `registered` event. Therefore `client.network.supports('CASEMAPPING')` returns the correct string inside the `registered` handler. Reading it there is safe.

### Backward compatibility for the wildcard matcher

`wildcardMatch` calls `ircLower()` when `caseInsensitive = true`. Hostmask patterns (e.g. `*!*@host.com`) contain no characters affected by the rfc1459 vs ascii distinction (only `[]{}\|~^` differ). Passing `'rfc1459'` as the default is safe and keeps existing tests green.

For nick/channel key matching inside `ChannelState` and `Permissions`, the active network casemapping should be used. These modules receive a `casemapping` dependency via `setCasemapping()`.

### Plugin API exposure

Add `ircLower(text: string): string` to `PluginAPI`. The implementation in `plugin-loader.ts` closes over the bot's `getCasemapping()` function, so it always returns the currently-active mapping.

## Feasibility

- **Alignment**: Fits the existing architecture — `Bot` already passes helpers through to `PluginLoader`. The only structural change is adding `casemapping` to a handful of constructor/setter signatures.
- **Complexity**: M (one day)
- **Risk areas**:
  - Existing DB keys in `seen` and `chanmod` are stored with `.toLowerCase()`. If the network casemapping differs from ascii and a nick contains `[]{}\|~^`, old records won't be found by the new lookup. These age out naturally — no migration needed.
  - `ChannelState` users map keys change format for nicks with special chars. Since channel state is ephemeral (populated fresh on connect), this is handled transparently by reconnect.
  - `command-handler.ts` `.toLowerCase()` calls normalise bot-internal ASCII command names (`.help`, `.flags`) — not IRC nicks/channels. These must **not** be changed.

## Dependencies

All modules are already built. This is a pure refactor with no new dependencies.

## Phases

### Phase 1: Core utility — refactor `ircLower()` and add `caseCompare()`

**Goal:** Make `src/utils/wildcard.ts` the single source of truth for all three casemapping tables. No callers change in this phase.

**File: `src/utils/wildcard.ts`**

- [x] Add `Casemapping` type: `export type Casemapping = 'rfc1459' | 'strict-rfc1459' | 'ascii'`
- [x] Change `ircLower(text: string)` signature to `ircLower(text: string, casemapping: Casemapping = 'rfc1459'): string`
  - `'ascii'`: return `text.toLowerCase()` (no special folding)
  - `'strict-rfc1459'`: same switch/case as current body but omit the `'~' → '^'` case
  - `'rfc1459'` (default): current body unchanged
- [x] Add `export function caseCompare(a: string, b: string, casemapping: Casemapping = 'rfc1459'): boolean { return ircLower(a, casemapping) === ircLower(b, casemapping); }`
- [x] Add fourth optional `casemapping: Casemapping = 'rfc1459'` parameter to `wildcardMatch()` and thread it through to the two `ircLower()` calls inside the function body
- [x] Verify: `pnpm test tests/utils/wildcard.test.ts` — all existing tests pass

### Phase 2: Add `Casemapping` type and `ircLower` to shared types

**Goal:** Make `Casemapping` importable from `src/types.ts` and add `ircLower` to `PluginAPI`.

**File: `src/types.ts`**

- [x] Add `export type Casemapping = 'rfc1459' | 'strict-rfc1459' | 'ascii'`
- [x] Add `ircLower(text: string): string` to the `PluginAPI` interface
- [x] Verify: `pnpm typecheck` passes

### Phase 3: Read CASEMAPPING in `bot.ts` and propagate to modules

**Goal:** Capture the network's CASEMAPPING after connect and push it to all dependent modules.

**File: `src/bot.ts`**

- [x] Add `private _casemapping: Casemapping = 'rfc1459'` and `getCasemapping(): Casemapping { return this._casemapping; }`
- [x] In the `registered` event handler, after the channel join loop, read and validate:
  ```ts
  const cm = this.client.network.supports('CASEMAPPING');
  if (cm === 'ascii' || cm === 'strict-rfc1459' || cm === 'rfc1459') {
    this._casemapping = cm;
  } else {
    this._casemapping = 'rfc1459'; // safe fallback
  }
  this.botLogger.info(`CASEMAPPING: ${this._casemapping}`);
  ```
- [x] After setting `_casemapping`, call `setCasemapping()` on: `channelState`, `permissions`, `dispatcher`, `services`, and `dccManager` (if present)
- [x] Verify: dev mode connect shows `[bot] CASEMAPPING: <value>` in logs

### Phase 4: Update `ChannelState`

**Goal:** All nick and channel map keys are normalised with the active casemapping.

**File: `src/core/channel-state.ts`**

- [x] Import `Casemapping` and `ircLower` from `../utils/wildcard.js`
- [x] Add `private casemapping: Casemapping = 'rfc1459'` and `setCasemapping(cm: Casemapping): void { this.casemapping = cm; }`
- [x] Replace every bare `ircLower(x)` call with `ircLower(x, this.casemapping)`:
  - `getChannel(name)`, `getUser(channel, nick)`, `onJoin`, `onPart`, `onQuit`, `onKick`, `onNick`, `onMode`, `onUserlist`, `onWholist`, `ensureChannel`
- [x] Verify: `pnpm test tests/core/channel-state.test.ts`

### Phase 5: Update `Permissions`

**Goal:** Channel flag lookups use the correct casemapping for channel name keys.

**File: `src/core/permissions.ts`**

- [x] Import `Casemapping` from `../utils/wildcard.js`
- [x] Add `private casemapping: Casemapping = 'rfc1459'` and `setCasemapping(cm: Casemapping): void { this.casemapping = cm; }`
- [x] Replace `ircLower(channel)` in `setChannelFlags()` and `userHasFlag()` with `ircLower(channel, this.casemapping)`
- [x] Leave `handle.toLowerCase()` calls intact — these are bot-internal identifiers, not IRC nicks/channels
- [x] Verify: `pnpm test tests/core/permissions.test.ts`

### Phase 6: Update `EventDispatcher`

**Goal:** Mask/command comparisons in the dispatcher use the network casemapping.

**File: `src/dispatcher.ts`**

- [x] Import `Casemapping` and `caseCompare` from `./utils/wildcard.js`
- [x] Add `private casemapping: Casemapping = 'rfc1459'` and `setCasemapping(cm: Casemapping): void { this.casemapping = cm; }`
- [x] In `bind()` deduplication check: replace `ircLower(b.mask) === ircLower(mask)` with `caseCompare(b.mask, mask, this.casemapping)`
- [x] In `matchesMask()`: replace exact command comparisons with `caseCompare(x, y, this.casemapping)`; pass `this.casemapping` as the fourth arg to all `wildcardMatch(..., true)` calls
- [x] Verify: `pnpm test tests/core/dispatcher.test.ts tests/core/dispatcher-permissions.test.ts`

### Phase 7: Update `Services` and `DCCManager`

**Goal:** Pending verification map and DCC session map use the network casemapping.

**File: `src/core/services.ts`**

- [x] Import `Casemapping` and `ircLower`; add `private casemapping: Casemapping = 'rfc1459'` and `setCasemapping()`
- [x] Replace `nick.toLowerCase()` in `verifyUser()` and `resolveVerification()` with `ircLower(nick, this.casemapping)`
- [x] Leave NickServ source comparisons as-is (service name, not user nick)
- [x] Verify: `pnpm test tests/core/services.test.ts`

**File: `src/core/dcc.ts`**

- [x] Import `Casemapping` and `ircLower`; add `private casemapping: Casemapping = 'rfc1459'` and `setCasemapping()`
- [x] Replace the three `nick.toLowerCase()` session map key lookups with `ircLower(nick, this.casemapping)`
- [x] Verify: `pnpm test tests/core/dcc.test.ts`

### Phase 8: Wire `getCasemapping` and `ircLower` into the Plugin API

**Goal:** Plugins can call `api.ircLower()` and get the live network casemapping. Fix the `getServerSupports()` stub.

**File: `src/plugin-loader.ts`**

- [x] Add `getCasemapping: () => Casemapping` to `PluginLoaderDeps` (default: `() => 'rfc1459'`)
- [x] In `createPluginApi()`, implement `ircLower(text: string): string { return ircLower(text, this.getCasemapping()); }`
- [x] Add `getServerSupports: () => Record<string, string>` to `PluginLoaderDeps`; replace the existing stub implementation with this dep
- [x] In `bot.ts`, provide both deps when constructing `PluginLoader`:
  - `getCasemapping: () => this.getCasemapping()`
  - `getServerSupports: () => { /* closure over client.network.supports for known ISUPPORT tokens */ }`
- [x] Update the existing `getServerSupports` test that expects `{}` to use a mock dep
- [x] Add test: `api.ircLower('[A]')` returns `'{a}'` with rfc1459 and `'[a]'` with ascii
- [x] Verify: `pnpm test tests/plugin-loader.test.ts`

### Phase 9: Replace `.toLowerCase()` in plugins with `api.ircLower()`

**Goal:** All nick/channel comparisons in plugins use the network casemapping.

**File: `plugins/seen/index.ts`**

- [x] Lines 30, 42, 58: `targetNick.toLowerCase()` / `ctx.nick.toLowerCase()` → `api.ircLower(...)`

**File: `plugins/greeter/index.ts`**

- [x] Line 24: `ctx.nick.toLowerCase() === botNick.toLowerCase()` → `api.ircLower(ctx.nick) === api.ircLower(botNick)`

**File: `plugins/flood/index.ts`**

- [x] `isBotNick()` (line 52): both `.toLowerCase()` → `api.ircLower()`
- [x] `botHasOps()` (line 58): `getBotNick().toLowerCase()` → `api.ircLower(getBotNick())`
- [x] `banDbKey()` (line 108), `storeFloodBan()` (line 114): `channel.toLowerCase()` → `api.ircLower(channel)`
- [x] Message tracker key (line 220): both nick and channel `.toLowerCase()` → `api.ircLower()`
- [x] Join/nick tracker keys (lines 243, 249, 268, 281): `hostmask.toLowerCase()` → `api.ircLower(hostmask)`

**File: `plugins/chanmod/index.ts`**

- [x] `isBotNick()` (line 48), `botHasOps()` (line 55), `botCanHalfop()` (line 64): replace both sides of nick comparisons
- [x] `markIntentional()` / `wasIntentional()` (lines 77, 83): both nick and channel
- [x] `banDbKey()` (line 151), `storeBan()` (line 157), `getChannelBanRecords()` (line 171): channel key
- [x] Nodesynch nicks check (line 372): both sides
- [x] `cycleScheduled` set (lines 385, 396, 401) and cooldown keys (lines 386, 432): channel/target

- [x] Verify: `pnpm test tests/plugins/`

### Phase 10: New unit tests

**Goal:** Cover the new `ircLower` variants and key integration paths.

**File: `tests/utils/wildcard.test.ts`** (extend existing)

- [x] `ircLower('~ABC', 'rfc1459') === '^abc'`
- [x] `ircLower('~ABC', 'strict-rfc1459') === '~abc'`
- [x] `ircLower('~ABC', 'ascii') === '~abc'`
- [x] `ircLower('[hello]', 'rfc1459') === '{hello}'`
- [x] `ircLower('[hello]', 'ascii') === '[hello]'`
- [x] `caseCompare('~nick', '^nick', 'rfc1459') === true`
- [x] `caseCompare('~nick', '^nick', 'strict-rfc1459') === false`
- [x] `caseCompare('~nick', '^nick', 'ascii') === false`
- [x] `wildcardMatch('[foo]', '{foo}', true, 'rfc1459') === true`
- [x] `wildcardMatch('[foo]', '{foo}', true, 'ascii') === false`

**File: `tests/core/channel-state.test.ts`** (extend existing)

- [x] After `setCasemapping('ascii')`, a join with nick `[Brace]` is stored/retrieved as `[brace]` (no bracket folding)
- [x] After `setCasemapping('rfc1459')`, the same nick is stored as `{brace}`

**File: `tests/core/permissions.test.ts`** (extend existing)

- [x] `setChannelFlags` with channel `#[test]`: stored as `#{test}` under rfc1459, `#[test]` under ascii

- [x] Verify: `pnpm test` — full suite passes

## Config changes

None. `CASEMAPPING` is read from the server, not from `bot.json`.

## Database changes

None to the schema. Key format for nick/channel-keyed plugin entries may subtly change if the network uses `ascii` and nicks contain `[]{}\|~^`. Old entries written with rfc1459 folding will not be found by ascii-folded lookups in that narrow case. Entries age out naturally — no migration required.

## Test plan

| Test                                   | File                               | What it verifies                         |
| -------------------------------------- | ---------------------------------- | ---------------------------------------- |
| `ircLower` rfc1459 table               | `tests/utils/wildcard.test.ts`     | `~→^`, `[→{`, `]→}`, `\→\|`              |
| `ircLower` strict-rfc1459 table        | same                               | `~` does not fold to `^`                 |
| `ircLower` ascii table                 | same                               | brackets do not fold                     |
| `caseCompare` all three tables         | same                               | equality semantics                       |
| `wildcardMatch` with casemapping param | same                               | mask matching respects casemapping       |
| `ChannelState` ascii mode nick key     | `tests/core/channel-state.test.ts` | nick with `[` stored/retrieved correctly |
| `Permissions` ascii channel flags      | `tests/core/permissions.test.ts`   | channel key not folded in ascii          |
| `api.ircLower` uses live casemapping   | `tests/plugin-loader.test.ts`      | plugin API delegates to current mapping  |
| `getServerSupports` live (not stub)    | `tests/plugin-loader.test.ts`      | returns real ISUPPORT values             |

## Decisions

1. **`wildcardMatch` for hostmask patterns in `Permissions.findByHostmask()`**: Keep rfc1459 as a hardcoded default. Hostmask patterns (`*!*@host.com`) rarely contain `[]{}\|~^`, so no practical difference exists between casemappings here. No need to thread the active casemapping into `findByHostmask()`.

2. **`topic` plugin `.toLowerCase()` calls**: Leave as-is. These normalise bot-internal subcommand strings and cooldown keys — not IRC nicks/channels. IRC casemapping rules do not apply.

3. **`command-handler.ts` `.toLowerCase()` calls**: Leave as-is. These normalise bot-defined ASCII command names (`.help`, `.flags`). Not IRC nicks/channels, no correctness benefit to changing them.
