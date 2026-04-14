# Quality Report — hexbot

_Scanned: 93 files across `src/` (62) and `plugins/` (31), totalling ~16,445 lines._
_Date: 2026-04-14_

## Summary

Overall the codebase is readable and the module boundaries generally match `DESIGN.md`. The biggest systemic issue is **a handful of genuine god files** (`dcc.ts` at 1526 lines, `botlink-hub.ts` at 876, `connection-lifecycle.ts` at 554, `rss/index.ts` and `flood/index.ts` at 516 each) that have each grown to cover 3–5 unrelated concerns. The second-largest pattern is **low-grade duplication in the command and backend layers** (argument parsing boilerplate across `core/commands/*`, ChanServ notice parsing between Atheme/Anope, per-backend capability checks). Neither blocks shipping. Worth noting: the utility layer (`src/utils/*`) and the smaller plugins (`seen`, `greeter`, `8ball`, `help`, `topic`) are tight, well-scoped, and worth emulating.

Phases below are ordered by refactoring value. Every actionable finding is a `- [ ]` so downstream skills (`/refactor`, `/build`) can tick them off.

---

## High Priority

Issues where a refactor would most improve readability or reduce risk.

### Phase H1 — God file splits

- [x] **`src/core/dcc.ts` (1526 lines) — split into a `src/core/dcc/` module directory.** The file currently mixes auth state machine, relay mode, console UI/banner rendering, session I/O routing, and TCP server management in two large classes. Proposed split (consumer-facing `DCCManager`/`DCCSession` imports unchanged via re-export):
  - `dcc/dcc-auth.ts` — `DCCAuthTracker` + auth policy (currently lines 376–463)
  - `dcc/dcc-session.ts` — `DCCSession` class, slimmed; `onLine()` dispatcher (803–874) becomes a table-driven router
  - `dcc/dcc-session-ui.ts` — extract `showBanner()` and its ordinal/format helpers (322–692) into a `BannerRenderer`
  - `dcc/dcc-manager.ts` — `DCCManager`, with `rejectIfInvalid()` guard checks (1285–1363) centralised into a single enum-based result
  - `dcc/dcc-protocol.ts` — `ipToDecimal`, `parseDccChatPayload`, `isPassiveDcc` (250–299)
  - `dcc/dcc-types.ts` — the scattered interfaces (44–210)
  - **Risk:** Medium. Behaviour-preserving but touches the session lifecycle.

- [x] **`src/core/botlink-hub.ts` (876 lines) — extract three modules.** The hub currently owns connection lifecycle, frame dispatch, relay state, party line, and protection requests. Split into:
  - `botlink-connection-manager.ts` — `LeafConnection`, `listen()`, `handleConnection()`, `handleHello()`, heartbeat (lines 34–44, 102–679, 833–827)
  - `botlink-frame-dispatcher.ts` — `onSteadyState()` and all frame handlers (685–788) + `cleanupLeafState()` (791–812)
  - `botlink-relay-manager.ts` — `activeRelays`/`protectRequests` Maps and routing (56–59, 364–441)
  - `botlink-hub.ts` retains the public API (`send`, `broadcast`, `getLeaves`) and delegates. Target: ~300 lines.
  - **Risk:** Medium. Behaviour-preserving, but requires disciplined dependency direction.

- [x] **`src/core/connection-lifecycle.ts` (554 lines) — extract close-reason classifier.** Lines 380–399 hold three pattern matrices (`FATAL_PATTERNS`, `RATE_LIMITED_PATTERNS`, `TRANSIENT_LABEL_PATTERNS`) and the classification entry point. This logic is the most valuable piece in the file and deserves its own `close-reason-classifier.ts` (50–60 lines, pure functions, trivially unit-testable). Similarly, lift TLS cipher logging and join-error routing into small helpers so `registerConnectionEvents()` reads as a dispatch table.
  - **Risk:** Low.

- [x] **`plugins/rss/index.ts` (516 lines) — split into `FeedFetcher` + `FeedFormatter` + `FeedStore`.** Current file mixes fetching (195–222), HTML sanitization + formatting (240–258), runtime persistence (307–331), deduplication (160–177), and admin commands (374–516). Extract the first three into plugin-local helpers; keep command handlers in `index.ts`.
  - **Risk:** Low.

- [x] **`plugins/flood/index.ts` (516 lines) — extract `DetectionEngine`, `RateLimitTracker`, `EnforcementExecutor`.** Detection wiring (331–406), enforcement (293–325), lockdown (156–238), offence tracking (269–287), and state sweep (412–433) are currently intertwined through module-level mutable state — nothing is testable in isolation. Extracting even two of these (detection vs enforcement) would unlock unit tests.
  - **Risk:** Medium.

### Phase H2 — API-boundary and leak fixes

- [x] **`plugins/flood/index.ts:13` — drop direct import from `../../src/utils/sliding-window`.** Plugins must go through the scoped `api` object (`DESIGN.md`). Either wrap `SlidingWindowCounter` behind `api.createRateLimiter()` or inline a minimal counter inside the plugin.
  - **Risk:** Low.

- [x] **`plugins/chanmod/bans.ts:29` / `plugins/chanmod/index.ts:243–246` — register `state.startupTimer` with teardown.** Current teardown doesn't clear the startup timer; a reload while pending leaves a stale callback that fires into the new plugin instance.
  - **Risk:** Low, high payoff for reload-stability.

- [x] **`src/core/dcc.ts` — consolidate session timer teardown.** `DCCSession` has three distinct timer paths (idle 876–889, prompt 760–768, relay) cleared from multiple places; `onClose()` (970–971) only clears one. Collapse all timer state into a single `clearAllTimers()` called from `close()`, and consider `AbortController` for socket-lifetime-bound timers. Also audit `DCCManager.attach()` (1094–1123) so listener + `logSink` registrations are paired 1:1 with `detach()` in a `finally`.
  - **Risk:** Medium. Touches shutdown ordering.

- [x] **`plugins/topic/index.ts:13,195` — prune `previewCooldown` Map.** Unbounded map keyed by nick; add the inline sweep pattern from `plugins/help/index.ts:105–109` (sweep entries older than `PREVIEW_COOLDOWN_MS` when `size > 1000`).
  - **Risk:** Trivial.

### Phase H3 — Cross-cutting duplication

- [x] **Centralise permission-flag checks in `src/core/permissions.ts`.** `memo.ts` lines 212 and 331 call `record.global.includes('n') || record.global.includes('m')` directly, bypassing the owner-implies-master precedence in `userHasFlags()` (406–434). Export a public `hasMinFlag(record, flag, channel?)` (or `hasOwnerOrMaster(record)`) and route all external callers through it. Also export the `VALID_FLAGS` / `OWNER_FLAG` / `MASTER_FLAG` constants so duplicated literal `'n'`/`'m'` strings can be replaced.
  - **Risk:** Low.

- [x] **Extract a generic `PendingRequestMap<T>` for botlink.** `botlink-hub.ts` (56–64) and `botlink-leaf.ts` (44–46) both maintain parallel Maps for `pendingCmds` / `pendingWhom` / `pendingProtect`, each re-implementing send/resolve/cancel/timeout around a `ref`-keyed table. The hub-side and leaf-side implementations of `executeCmdFrame()` in `botlink-protocol.ts` (236–284) are also duplicated via separate call sites (hub:254, leaf:428).
  - **Risk:** Low. Mechanical extraction, saves ~60 lines.

- [x] **Consolidate ChanServ notice parsing.** `plugins/chanmod/chanserv-notice-atheme.ts` (91 lines) and `-anope.ts` (194 lines) share structure: regex match → consume probe → call backend → `syncAccessToSettings`. Define a per-backend `{ name, patterns: [{regex, handler}], probe }` descriptor and let `chanserv-notice.ts` (66–83) dispatch in a single loop. Target: ~280 LOC → ~120.
  - **Risk:** Low. Routing is already abstracted.

---

## Medium Priority

Worth doing, not urgent.

### Phase M1 — Orchestration / mixed concerns

- [ ] **`src/bot.ts:75–256,258–500` — phase the constructor + `start()`.** The `Bot` class wires ~15 subsystems in one constructor and a 200+ line `start()`. Extract `createServices()`, `attachBridge()`, `registerCoreCommands()`, `startBotLink()` so each phase is readable and testable independently.
  - **Risk:** Medium.

- [ ] **`src/irc-bridge.ts:210–300` — extract `parseCommand()` / `buildContext()` / `checkAccount()` helpers.** `onPrivmsg`, `onAction`, `onJoin` each repeat the same sanitize → command extract → context build → account check → flood check → dispatch sequence. A shared `dispatchMessage()` would eliminate the duplication and make the dispatch intent explicit.
  - **Risk:** Low.

- [ ] **`src/command-handler.ts:130–202` — extract `checkCommandPermissions()`.** Permission, transport (`ctx.source !== 'repl'`), and pre-execute-hook logic are interleaved in `execute()`. Split into a dedicated permission gate + a dispatch core.
  - **Risk:** Low.

- [ ] **`src/core/channel-state.ts:379–445` — split `onMode()` into `processUserPrefixMode()` + `processChannelMode()`.** 66-line function with four-level nesting; the two mode classes share nesting structure but diverge in logic.
  - **Risk:** None. Pure extraction.

- [ ] **`src/core/permissions.ts:285–301` — extract `matchesAccountPattern()` / `matchesHostmaskPattern()`.** The `$a:account` branch's silent `continue` at line 289 is easy to miss in the current mixed loop.
  - **Risk:** None.

- [ ] **`src/core/irc-commands.ts:234–283` — collapse `mode()` double-walk into a single pass.** Current code counts params, then allocates, then batches — same prefix lookups done twice. Build `{mode, param}` array in one pass.
  - **Risk:** Low.

- [ ] **`src/core/dcc.ts:734–801` — replace relay boolean flags with an explicit state enum.** Three booleans (`_relayCallback`, `_relayConfirmed`, `_relayTimer`) encode a state machine; invalid combinations are reachable (callback null while timer still running, 760–768).
  - **Risk:** Low.

- [ ] **`src/core/dcc.ts:322–692` — extract `BannerRenderer`.** The `showBanner()` body contains its own ordinal/pluralisation logic (`Intl.PluralRules` at 621–629), stat layout, mIRC colour coding, and uptime formatting. Move into its own file so banner tweaks don't require reading `DCCSession`.
  - **Risk:** Low.

### Phase M2 — Plugin state and command boilerplate

- [ ] **`plugins/chanmod/state.ts` — partition `SharedState` by owner.** Nine modules currently read and mutate the same state record; no single file is "in charge" of any sub-field. As a first step, move `cycleTimers` behind a small `CycleState` API (`schedule(ms, fn)`, `clearAll()`) so the teardown story is centralised. `intentionalModeChanges`, `enforcementCooldown`, `threatScores`, `lastKnownModes` can follow the same pattern.
  - **Risk:** Medium.

- [ ] **`plugins/chanmod/mode-enforce.ts:147–216` — document the handler contract.** The orchestrator runs 7 sub-handlers in a fixed order; each returns `boolean` where `true` means "halt subsequent handlers". This is implicit. Add a `ModeHandler` interface and a doc comment listing the order (`reapply → remove-unauth → key → limit → self-deop → opped → bitch → bot-banned → enforcebans → user`). Collect the shared guards (`isNodesynch`, `canEnforce`) into a `ModeContext` object passed to each handler (reduces current 9-parameter signatures in `handleBotSelfDeop`).
  - **Risk:** Low.

- [ ] **`plugins/chanmod/commands.ts` (414 lines) — extract ban commands.** Factory pattern already isolates the mode-command handlers (159–234); split `handleBan` / `handleUnban` / `handleKickban` / `handleBans` (265–398) out to a new `chanmod/ban-commands.ts`. Commands file shrinks to ~180 lines.
  - **Risk:** Low.

- [ ] **Core command-handler duplication — extract small helpers.** Several patterns repeat across `src/core/commands/*`:
  - `getAuditSource(ctx)` — `ctx.source === 'repl' ? 'REPL' : ctx.nick` appears in `permission-commands.ts:23,46,97`, `channel-commands.ts`, `plugin-commands.ts`, `password-commands.ts`.
  - `parseBanArgs(args)` / `validateChannel(arg)` — ban-commands `ban`/`unban`/`stick`/`unstick` and irc-commands-admin `join`/`part`/`invite` duplicate `args.trim().split(/\s+/)` → check `'#'` prefix → extract mask/channel.
  - `replyFailure(name, error)` — `plugin-commands.ts:61,91,123` all do `tryAudit(...)` + templated `ctx.reply(...)` on load/unload/reload failure.
  - **Risk:** Low.

- [ ] **`src/core/commands/irc-commands-admin.ts:248–282` — merge `formatUptime` and `formatUptimeColored`.** 12 of 15 lines are copies. Collapse to one function with an optional `colorize: boolean`, or extract the colour-wrap as a decorator.
  - **Risk:** Low.

- [ ] **`plugins/flood/index.ts:334,352,372,394` — move `isPrivileged()` check before `isFloodTriggered()`.** Exempt users still populate the counter today, which is wasted work and delays lockdown decisions for real offenders.
  - **Risk:** Low.

- [ ] **`plugins/rss/index.ts:445–448` — tighten `handleAdd` seed-failure reporting.** A failed initial poll is logged as `'ok'` with an "added but initial fetch failed" message; operators miss real problems. Return a result type from `pollFeed` or wrap the seed in try/catch before calling `saveRuntimeFeed`.
  - **Risk:** Low.

### Phase M3 — Minor subsystem cleanups

- [ ] **`src/dispatcher.ts:163–204` — extract `_maybeSweep()` in `floodCheck`.** Lazy sweep mid-flood-check is correct but surprising; named helper clarifies intent.
  - **Risk:** None.

- [ ] **`src/config.ts:254–310` — accept a `Logger` in `resolveSecrets()`.** `_env` warnings currently go to raw stdout and are lost in production log pipelines.
  - **Risk:** None.

- [ ] **`src/plugin-api-factory.ts:139–194` — revisit the `channelScope` `WeakMap` wrapper.** Only activates when a plugin defines `channelScope`; a simple `{handler, wrapped}` pair list would be easier to reason about and imposes the same cost.
  - **Risk:** Low.

- [ ] **`src/core/services.ts:115–150` — use `AbortController` for pending verify timers.** Manual `clearTimeout` across a map is error-prone; `abort()` on an old signal is the cleaner cancellation idiom.
  - **Risk:** Low.

- [ ] **`src/core/message-queue.ts:209–248` — rethink round-robin cursor.** Current code clamps `rrIndex` defensively in both `popNext()` and `removeTarget()`; tracking the current target _string_ instead of an index into `targetOrder[]` removes the clamping entirely. Add tests first — round-robin invariants are subtle.
  - **Risk:** Medium.

- [ ] **`src/core/botlink-hub.ts:418–424` — rename `sendOrDeliver(botname, frame, isHub?)` → `sendToBot()` and inline the self-dispatch at the call sites.** The current method silently redirects to `onLeafFrame` when `botname === config.botname`; the intent is clearer when routing lives at the call site.
  - **Risk:** Trivial.

- [ ] **`src/core/botlink-hub.ts:534–596` — flatten the handshake callback chain.** Extract `performHandshake(protocol, frame, ip)` or a small state object so timer cleanup and auth release don't fragment across three closures.
  - **Risk:** Medium.

- [ ] **`src/core/botlink-hub.ts:378–412` — unify relay-not-found behaviour.** Line 384–390 sends `RELAY_END` on missing target; 396/402/408 silently drop. Pick one strategy and apply consistently.
  - **Risk:** Medium.

- [ ] **`src/core/botlink-protocol.ts:113–135,236–284` — move `RateCounter` and `executeCmdFrame()` out of the "protocol" file.** `RateCounter` is a hub concern; `executeCmdFrame` is command-execution glue used by hub and leaf. Both pollute what should be a framing-only module.
  - **Risk:** Low.

- [ ] **Create `src/core/botlink-types.ts`.** Move `LinkPermissions`, `CommandRelay`, `LinkFrame`, `PartyLineUser` out of `botlink-protocol.ts` (currently 92–104). Importing types from a file called "protocol" is misleading.
  - **Risk:** Trivial.

---

## Low Priority / Cosmetic

- [ ] `src/core/permissions.ts:18,30` — export `VALID_FLAGS`, `OWNER_FLAG`, `MASTER_FLAG` so callers stop hardcoding `'n'`/`'m'`.
- [ ] `src/core/audit.ts:36–51` — add a JSDoc example showing `auditActor(ctx)` usage so command authors discover it.
- [ ] `src/core/dcc.ts:471,530–531,1039` — compute `rateLimitKey` once in the `DCCSession` constructor and reuse.
- [ ] `src/core/dcc.ts:912` — `verifyPassword()` should return `{ok:true}|{ok:false,reason}` so "bad password" and "scrypt error" can be distinguished for logging (safe to still reject both).
- [ ] `src/core/dcc.ts:415–438` — add a comment on `DCCAuthTracker` sliding-window reset semantics; current logic is correct but subtle.
- [ ] `src/core/dcc-console-commands.ts:112–148` — extract a helper shared between `mutateOwnFlags` and `mutateOtherHandleFlags` for the repeated `parseCanonicalFlags` / `formatFlags` calls.
- [ ] `src/core/botlink-leaf.ts:37,371,460` — rename `lastMessageAt` → `lastHeartbeatAt`; current name overpromises.
- [ ] `src/core/botlink-auth.ts:232–233` — the `TODO (security audit WARNING): switch to crypto.timingSafeEqual` comment should be a tracked issue, not an in-source TODO.
- [ ] Magic numbers scattered in botlink — `botlink-auth.ts:330` (`ESCALATED_STALE_MS`), `botlink-hub.ts:654–656,860–862` (rate counters, TTLs). Move to config or a constants file when next touched.
- [ ] Frame-type string literals across `botlink-*.ts` — define a `FrameType` const-map to catch typos in comparisons at compile time.
- [ ] `src/command-handler.ts:187–190` — relay pre-hook wiring could move to a pre-hook handler so core execute() focuses on business logic.
- [ ] `src/core/database.ts:249–313` — extract `validateModActionOptions()` to shorten `logModAction`.
- [ ] `src/core/modlog-commands.ts:485–529` — `runNext`/`runPrev`/`runTop`/`runEnd` each repeat "fetch pager → update rows/pageStart/pageEnd/lastUsed → render"; minor `updatePagerState()` helper would dedupe.
- [ ] `plugins/rss/index.ts:374–403,486–495` — `parseAddArgs()` helper for add/check command argument parsing.
- [ ] `plugins/rss/index.ts:260` — inline trivial `delay()` wrapper or document why it's a named function.
- [ ] `plugins/help/index.ts:74–76,113–116` — extract `filterByPermission(entries, ctx)` helper.
- [ ] `plugins/greeter/index.ts:94,127,150,167` — extract `greetKey(handle)` so the `greet:` prefix isn't repeated in four places.
- [ ] `plugins/chanmod/mode-enforce-recovery.ts:34–44` — 9-parameter handler signatures resolve naturally if M2's `ModeContext` extraction happens.

---

## Patterns to address across the codebase

- [ ] **Casemapping threading noise.** `ircLower(name, this.casemapping)` is called 29+ times across `channel-state.ts`, `permissions.ts`, `memo.ts`, etc. Add a private `lowerNick()` / `lowerChannel()` convenience on each class so the dominant pattern becomes `lowerNick(nick)`. One-liner wrappers, large readability win. **Risk:** Trivial.

- [ ] **Event listener attach/detach boilerplate.** `channel-state.ts`, `services.ts`, `connection-lifecycle.ts` all store listeners in an array and attach/detach via a helper. A small `ListenerGroup` utility (or mixin) would remove this duplication and make the leak-safe pattern the default. **Risk:** Low.

- [ ] **`ModActor` threading is verbose.** Audit logging needs `actor: ModActor | undefined` threaded through `IRCCommands` methods. `src/core/audit.ts` has helpers (`auditActor`, `auditOptions`) but they're rarely used. Either enforce them in the core command template or document the usage in `CLAUDE.md`. **Risk:** None (convention change).

- [ ] **Command-handler boilerplate cluster.** The shared patterns flagged in Phase M2 (`getAuditSource`, `parseBanArgs`, `validateChannel`, `replyFailure`, uptime formatters) all point to a missing `src/utils/command-helpers.ts` (or extensions to `parse-args.ts`). Worth bundling into a single change so every command file benefits at once. **Risk:** Low.

- [ ] **Permission checks inline in command handlers (intentional exception).** `chpass`, `modlog`, `flags` do custom permission logic rather than rely on bind flags. This is intentional per design (nuanced policies); flag for the `modlog-commands.ts` comment that documents the exception so future code reviews don't churn on it. **Risk:** None (documentation).

---

## What looks good

Several files and subsystems are clean and worth emulating — **do not refactor these just because they're nearby**:

- **`src/utils/wildcard.ts`** — single responsibility, clearly documents the case-mapping invariant, reused correctly by dispatcher and permissions.
- **`src/utils/split-message.ts`** — UTF-8 byte-aware splitting with grapheme iteration; subtle but well-commented.
- **`src/utils/admin-list-store.ts`** — generic CRUD wrapper with clean DI, no duplication.
- **`src/utils/parse-args.ts`** — good foundation for command parsing; `splitN()` correctly preserves control characters for validators.
- **`src/core/modlog-commands.ts`** — excellent patterns: isolated `PagerState` interface (49–63), extracted `checkModlogPermission()` (234–259), `ColumnSpec` rendering abstraction (280–294), small focused subcommands (~30 lines each).
- **`src/event-bus.ts`** — minimal, well-typed typed-EventEmitter wrapper; the override boilerplate is load-bearing for type safety and should stay.
- **`src/types.ts`** — the `BindContextFor<T>` conditional type (215–249) is the right pattern for a discriminated union; don't "simplify" it.
- **`src/logger.ts`** — structured sink abstraction is correct; only the deprecated `setOutputHook` path should eventually go.
- **`src/index.ts`** — clean CLI bootstrap and signal handling.
- **`plugins/seen`, `plugins/8ball`, `plugins/greeter`, `plugins/help`** — tight, focused plugin implementations that are good models for new plugin authors.
- **`plugins/chanmod/mode-enforce-*` cluster** — the file split is principled (channel vs user vs recovery); the cluster needs documentation of the handler contract, not re-organisation.
- **`plugins/chanmod/protection-backend.ts`** — the `ProtectionBackend` interface itself is solid and cleanly abstracts Atheme/Anope differences. Duplication lives in the concrete backends, not the interface.
