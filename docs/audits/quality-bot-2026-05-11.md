# Quality Report — hexbot `src/bot.ts`

_Scanned: 1 file (2042 lines) — `src/bot.ts`_
_Date: 2026-05-11_

## Summary

`bot.ts` is documented as a "thin orchestrator that wires modules together," but at 2042 lines it has accreted three large secondary concerns directly into the `Bot` class: a 250-line core-settings schema (`registerCoreSettings`), a 90-line per-key change dispatcher (`applyCoreSettingChange`), and a 180-line `connect()` that inlines the entire lifecycle callback graph. The constructor and `start()` are already well-split into named phases — that pattern just needs to be carried into the next layer. The good news is most extractions are mechanical and low-risk; nothing in this file is structurally tangled, it's just oversized.

## High Priority

Issues where refactoring would most improve readability or reduce risk.

### `src/bot.ts:402-655` — `registerCoreSettings` is 250 lines of declarative data on the orchestrator

- [x] **Problem:** The setting-definition list (~30 entries, lines 404-648) is essentially a schema table embedded inside an orchestrator class. Reading `Bot` from top to bottom forces a 250-line scroll past data that has nothing to do with wiring. The only logic interleaved is one `onReload` closure on `irc.nick` (lines 553-557) which calls `this.client.changeNick`.
- **Evidence:** Lines 402-648 are a single array literal with uniform shape; line 652-654 attaches `onChange`. Only the `irc.nick` entry needs a closure over `this`.
- **Suggested split:** Move the definition list to `src/core/core-settings-defs.ts` as a pure data export (or a `buildCoreSettingDefs(bot)` factory that injects only the one `irc.nick` reload closure). `Bot.registerCoreSettings()` shrinks to ~10 lines: import defs, register, attach the central onChange.
- **Risk:** Low. Defs are inert data; the `irc.nick` closure is the only `this`-dependent entry.

---

### `src/bot.ts:662-755` — `applyCoreSettingChange` is a 94-line per-key switch with repeated coercion boilerplate

- [x] **Problem:** Every case does the same two-step shape: type-guard the value, then push it into either `this.config.X.Y` or a subsystem method. The switch reaches into eight subsystems (logger, db, messageQueue, dispatcher, memo, services config, dcc config, plugin loader). Adding a new core setting today requires touching three places: the def list (line 404), the switch (line 663), and reading the config in the subsystem.
- **Evidence:** Lines 663-754. Repeated patterns: `if (typeof value === 'string') this.X.setY(...)`, `if (typeof value === 'number') this.config.X.Y = value`. The two "fan-out" cases (queue.rate/burst lines 673-679; flood.\* lines 680-696) duplicate the registry lookup pattern.
- **Suggested split:** Make each setting def carry its own typed `onChange(bot, value)` (already half-done — `onReload` exists). Then `applyCoreSettingChange` becomes a one-line lookup against a `Map<string, Handler>`. The "fan-out" cases can be a single shared handler keyed by prefix (`queue.*`, `flood.*`). Combined with the previous finding, this collapses two large blocks into one well-factored module.
- **Risk:** Medium. Behavior change is mechanical but the test surface is wide — every core setting needs to round-trip through `.set` after the refactor.

---

### `src/bot.ts:1608-1789` — `connect()` is 182 lines mixing STS, driver construction, lifecycle wiring, and 7 inline callbacks

- [x] **Problem:** `connect()` does seven things: apply STS policy, tear down any prior driver/lifecycle (idempotency guard), build client options, construct the reconnect driver, register the lifecycle handle with ~7 inline callback closures, fire the synchronous `client.connect()` with its own try/catch, and resolve the promise. The single largest cost is the lifecycle config object literal (lines 1678-1764, 87 lines), where each callback contains real business logic — casemapping fan-out, capability fan-out, reconnect state cleanup, and an inline STS-directive handler that mutates `this.config` and clears the message queue.
- **Evidence:** Lines 1608-1789. `applyCasemapping` (1689-1697) fans the casemapping into six subsystems. `applyServerCapabilities` (1699-1708) into four. `onReconnecting` (1709-1724) reaches into three subsystems with multi-line "why we drop X" comments inline. `onSTSDirective` (1725-1755) duplicates STS-policy responsibility that already lives partly in `applySTSPolicyToConfig`.
- **Suggested split:** Extract three private methods on `Bot`:
  - `buildLifecycleHandlers(): RegisterConnectionEventsArgs` — owns all the callbacks.
  - `applyCasemapping(cm: Casemapping): void` — already centralized but currently lives only as a closure.
  - `handleSTSDirective(directive, currentTls): void` — folds the inline closure into a sibling of `applySTSPolicyToConfig`.

  `connect()` then becomes ~30 lines: STS, idempotency tear-down, build options, build handlers, install, fire `client.connect()`.

- **Risk:** Medium. The flow is intricate (resolve-immediately + lifecycle promise + synchronous-throw catch) but the extracted methods are behavior-preserving renames of existing closures.

---

### `src/bot.ts:1142-1190` + `283-285` + `234-285` — three unrelated micro-subsystems live as private fields/methods on `Bot`

- [x] **Problem:** `Bot` carries three small subsystems inline that have nothing to do with orchestration:
  1. **KV daily prune + monthly VACUUM** (lines 1142-1190, plus the `KV_RETENTION_DAYS` static table). 50 lines of timer logic on the orchestrator.
  2. **Audit fallback ring buffer** (fields 283-285, methods 216-240). Bounded queue with FIFO eviction — a textbook tiny class.
  3. **Secret-file permission checks** (top-level functions 78-124). Already module-scoped but tied to `loadConfig` and only used there.
- **Evidence:** Each of these is independently testable, has zero shared state with the rest of `Bot`, and clutters the class with unrelated reading.
- **Suggested split:**
  - `src/core/kv-maintenance.ts` — `scheduleKvMaintenance(db, logger)`, returns `{ stop(): void }`. `Bot` holds the handle, calls `stop()` in shutdown.
  - `src/core/audit-fallback.ts` — `class AuditFallbackBuffer { push, snapshot, stats }`. `Bot` holds an instance, exposes the two getters as thin pass-throughs.
  - `src/config/file-permissions.ts` — `enforceSecretFilePermissions`, `checkDotenvPermissions`. `loadConfig` imports both.
- **Risk:** Low for all three. Pure mechanical moves with no behavior change.

---

### `src/bot.ts:1471-1602` — `shutdown()` is 132 lines of step orchestration with an inline `step()` helper

- [x] **Problem:** Twelve teardown steps in `shutdown()` (plus the `pluginLoader.unloadAll` await that uses its own try/catch instead of the helper) live in one method. The `step()` helper itself (1480-1486) is good and worth keeping, but the steps would read better as a declarative list paired with the helper.
- **Evidence:** Lines 1480-1601. Each step is small; the value is in the ordering and the helper. Line 1527-1531 hand-rolls a try/catch that the `step()` helper could absorb if it accepted async functions.
- **Suggested split:** Either (a) keep in-place but accept `() => void | Promise<void>` in `step()` and remove the hand-rolled try/catch, or (b) extract a `buildShutdownSteps(bot): Array<[name, fn]>` table and have `shutdown()` iterate it. (a) is the smaller, safer change.
- **Risk:** Low. Ordering matters, but the existing comments make it explicit.

---

## Medium Priority

Worth doing, not urgent.

### `src/bot.ts:1890-1960` + `1991-2002` + `2009-2021` — config-file I/O lives on `Bot`

- [x] **Problem:** `loadConfig`, `readBotJsonAsRecord`, and `readPluginsJsonAsRecord` are all file-read + parse + (sometimes) resolve-secrets routines that don't depend on any `Bot` state besides `_botConfigPath` and the logger. Putting them on the class makes the class larger and discourages unit-testing them in isolation.
- **Evidence:** `loadConfig` (70 lines) only uses `bootstrap`, the path, and `console.error`. The two `readXAsRecord` helpers each open a file, parse JSON, return a record.
- **Suggested split:** Move to `src/config/loader.ts` as pure functions taking explicit deps. `Bot.loadConfig` becomes a 5-line call site; `readBotJsonAsRecord` / `readPluginsJsonAsRecord` become free functions passed by reference to `registerSettingsCommands`.
- **Risk:** Low.

---

### `src/bot.ts:794-898` — `createServices` is 105 lines that hand-construct 16 subsystems

- [x] **Problem:** Already isolated into a helper (good), but its 16-field return struct is then re-copied field-by-field in the constructor (lines 327-343). Each new subsystem added requires editing both the struct shape and the constructor. The closure-over-`this`-not-yet-set issue is real, but the struct round-trip is a workaround for the `readonly` constraint that costs ~20 lines.
- **Evidence:** Lines 327-343 (16 field re-assignments), 794-898 (struct construction).
- **Suggested split:** Either (a) drop `readonly` on the fields that are set in `createServices` and assign directly inside the helper (less safe for callers; the contract becomes "set during construction"), or (b) keep as-is and accept the duplication — the explicitness is reasonable. The class doc comment on `createServices` (lines 786-793) acknowledges the trade-off. Leaving this as a low-priority observation rather than a strong recommendation.
- **Risk:** Low. Either option is mechanical.

---

### `src/bot.ts:139-145` — `STSRefusalError` belongs in `core/sts.ts`

- [x] **Problem:** A small typed error class lives at the top of `bot.ts` solely so `Bot.connect()` can throw it. STS lives in `src/core/sts.ts`.
- **Evidence:** Lines 139-145.
- **Suggested split:** Move to `src/core/sts.ts`, re-export from `bot.ts` only if `index.ts` needs it visible (it does, for the `instanceof` check at the entry point).
- **Risk:** Low. Move + re-export.

---

### `src/bot.ts:1011-1125` — `start()` does 13 distinct things in one method

- [x] **Problem:** `start()` is already broken into named helpers for the heavy lifts (`attachBridge`, `attachDcc`, `attachMemo`, `startBotLink`, `registerPostLinkCommands`, `registerCoreCommands`), but the inline body still does: idempotency check, banner, db.open, audit-fallback wire, permissions load, seed-from-json, log-level reapply, owner ensure, weak-hostmask audit, plaintext warning, plugin load + failure tracking, uptime-anchor listener, schedule KV maintenance, connect. The sequence is correct but reads as a long checklist.
- **Evidence:** Lines 1011-1125.
- **Suggested split:** Extract a `bootSubsystems()` (db.open through `warnServicesPlaintextRisks`) and `bootPlugins()` (the loader call + failure handling + uptime anchor). `start()` reads top-to-bottom as: idempotency → banner → bootSubsystems → registerCoreCommands → attach\* → startBotLink → registerPostLinkCommands → wireMemoDccNotify → bootPlugins → scheduleKvMaintenance → connect.
- **Risk:** Low.

---

## Low Priority / Cosmetic

Small wins, address opportunistically.

- [x] `src/bot.ts:283-285` — `AUDIT_FALLBACK_CAPACITY = 256` lives as a static on `Bot` but is only referenced inside `pushAuditFallback`. Moves with the audit-fallback extraction above.
- [x] `src/bot.ts:374-383` — `_fatalShutdownScheduled` field is declared mid-class (line 374) between `pushAuditFallback` and `scheduleFatalShutdown`. Group it with the other lifecycle guard fields (`_isShuttingDown`, `_isStarted`) near the top of the class for consistency.
- [x] `src/bot.ts:986-1006` — the `getServerSupports` closure in `createPluginLoader` builds a known-key dictionary inline. Extract `KNOWN_ISUPPORT_KEYS` as a module constant and turn the loop into a one-liner — also makes the list discoverable by `grep`.
- [x] `src/bot.ts:1242-1320` — `registerCoreCommands` is fine as-is, but the inline `botInfo` object passed to `registerIRCAdminCommands` (lines 1259-1283) has eight closures over `this`. Lifting to a `buildBotInfo(): BotInfo` helper would keep `registerCoreCommands` skim-readable.
- [x] `src/bot.ts:243-255` — three small getters (`dccManager`, `botLinkHub`, `botLinkLeaf`) sit between the audit-fallback methods and `startTime`. Group all getters together.
- [x] `src/bot.ts:1832-1851` — the `options` literal in `buildClientOptions` mixes config-derived values and hard-coded constants (`auto_reconnect: false`, `version: null`, `enable_chghost: true`). A small `BASE_CLIENT_OPTIONS` constant would surface "these are intentional irc-framework overrides" at file scope.

---

## Patterns to address across the codebase

These are systemic to `bot.ts` but the fixes are coordinated, not file-by-file.

- [x] **Settings-def + change-handler co-location.** The split between `registerCoreSettings` (the def list) and `applyCoreSettingChange` (the switch) means a reader has to cross-reference two huge blocks 200 lines apart to understand a single setting. A single record-per-key shape (`{ def, onChange? }`) would collapse them into one definition that lives next to its handler. This same pattern likely shows up in plugin settings registries; worth aligning.
- [x] **Inline subsystem-fan-out closures.** `applyCasemapping`, `applyServerCapabilities`, and the various `onReconnecting`/`onSTSDirective` callbacks in `connect()` each fan a single notification across 3-6 subsystems. The bot is the natural hub for this, but lifting each fan-out into its own named method (`applyCasemapping`, `applyCapabilities`, `onBeforeReconnect`, `applySTSDirective`) makes the connect-time wiring readable and unit-testable.
- [x] **"Long-lived subsystem with timers" inline on the class.** KV maintenance is the obvious case, but the same shape will recur (e.g., a future `pendingVerifySweeper`). Establish a small convention — every such subsystem is a class with `start()`/`stop()`, the bot holds the handle, shutdown calls `stop()` via the existing `step()` helper.

---

## What looks good

Be specific. These patterns are working — don't change them in the refactor.

- **Constructor phase split** (lines 327-366). `createServices` / `wireDispatcher` / `createPluginLoader` is exactly the right shape. The pattern just needs to be carried into `start()` and `connect()`.
- **Attach-phase helpers** (lines 1322-1468). `attachBridge`, `attachDcc`, `attachMemo`, `startBotLink`, `registerPostLinkCommands`, `wireMemoDccNotify` are each small, focused, and well-named. This is the model the rest of the file should match.
- **`step()` helper in `shutdown()`** (lines 1480-1486). Tiny pattern, high payoff — every step independently fails and logs. Worth extending to async.
- **Comment discipline.** The "why" comments throughout (STS-refusal rationale at 130-138, audit-fallback at 274-282, the auto_reconnect=false incident reference at 1840-1843, the 32-bit timer overflow note at 1137-1140) are exactly the kind of load-bearing context that survives a refactor. Don't drop them when moving code.
- **`trackListener('bot', ...)` discipline.** Every closure that captures `this` is registered under the `bot` owner so `removeByOwner('bot')` in shutdown sweeps it. Consistent and easy to audit — keep enforcing this.
- **Idempotency guards.** `_isStarted`, `_isShuttingDown`, `_fatalShutdownScheduled`, and the defensive prior-driver tear-down at the top of `connect()` (lines 1635-1643) all show the file has been hardened against re-entry. Preserve these through any extraction.
