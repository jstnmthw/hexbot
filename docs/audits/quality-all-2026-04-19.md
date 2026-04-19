# Quality Report — hexbot

_Scanned: ~140 source files across `src/`, `plugins/`, `tests/` (excluding `node_modules/`)_
_Date: 2026-04-19_

## Summary

The codebase is architecturally sound and disciplined — **teardown hygiene is strong across plugins, utility code is almost uniformly pure and focused, and audit-logging conventions are applied consistently in every mutating command**. The main systemic issue is **size accumulation in a handful of long-lived modules**: `dcc/index.ts` (1654), `plugins/ai-chat/index.ts` (1667), `bot.ts` (1262), `types.ts` (948), `database.ts` (859), `botlink/hub.ts` (821). These are not architectural faults — they are the natural drift of modules that absorb responsibility over time. The highest leverage is (a) splitting the two 1600+-line god files, (b) fixing two specific plugin→core API boundary violations, and (c) consolidating duplicated patterns (DCC session teardown, botlink heartbeat, chanmod backend scaffolding, test helpers).

## High Priority

Issues where refactoring would most improve readability or reduce risk. Each `- [ ]` item is a distinct actionable refactor.

- [x] **`src/core/dcc/index.ts` — 1654-line god file, 13 distinct responsibilities across 2 classes**
  - **Problem:** `DCCSession` (lines 312–916) owns password/active state machine, relay mode FSM, idle/prompt timers, readline lifecycle, log filtering, and command routing. `DCCManager` (lines 941–1654) owns CTCP handling, a 5-step guard chain, TCP server lifecycle, session storage, auth sweep, event-bus subscriptions, IRC mirroring, and party-line broadcast.
  - **Evidence:** `dcc/index.ts:1355–1461` (guard chain `rejectIfInvalid` + 5 `check*` methods), `dcc/index.ts:1250–1268` (IRC mirrors), `dcc/index.ts:1562–1624` (`openSession()` 63-line mix), `dcc/index.ts:1030/1332/1437/1455/1640/1643` (session-key casemapping repeated 6×).
  - **Suggested split:** Extract `dcc/protocol-acceptance.ts` (CTCP + guard chain + server allocation), `dcc/irc-mirror.ts` (notice/privmsg fanout + NickServ filter), `dcc/session-store.ts` (session map + casemapping helpers), leave `dcc/manager.ts` focused on auth + event wiring.
  - **Risk:** Medium — many call sites; requires careful test coverage around the guard chain.

- [x] **`plugins/ai-chat/index.ts` — 1667-line plugin god file, 13 distinct responsibilities**
  - **Problem:** Config parsing, provider factory, privilege gates, rate-limit notifications, character selection, init/teardown, two bind handlers (pubm/pub), pipeline orchestration, session pipeline, subcommand dispatch, and iteration-stats formatting all in one file. `handleSubcommand()` is a **225-line `switch`** (lines 1416–1639); `runPipeline()` is ~160 lines (1124–1284); `pubm` handler is 60+ lines (947–1073).
  - **Evidence:** `plugins/ai-chat/index.ts:112–330` (config parsing), `434–551` (privilege gates), `947–1073` (pubm), `1124–1284` (runPipeline), `1416–1639` (subcommand switch).
  - **Suggested split:** Extract `plugins/ai-chat/config.ts`, `plugins/ai-chat/permission-gates.ts`, `plugins/ai-chat/handlers/pubm.ts`, `plugins/ai-chat/handlers/subcommand.ts` (or a handler-map), `plugins/ai-chat/pipeline.ts`.
  - **Risk:** Low — teardown is already centralized and subsystems are modular; extraction is mostly moving functions.

- [x] **`src/bot.ts` — 1262-line orchestrator mixes BotLink relay, DCC wiring, STS, connection lifecycle, and service setup**
  - **Problem:** `Bot` class absorbs responsibilities that belong in dedicated modules. Inline `startBotLink()` (539–626, 103 lines) interleaves hub/leaf setup with listener registration and frame relay. Relay virtual sessions + `PARTY_CHAT` frame dispatch (1100–1215) are bot-link concerns, not core orchestration.
  - **Evidence:** `src/bot.ts:100–106` (9 `_foo: Foo | null` fields with ad-hoc lifecycle), `539–626` (botlink startup), `1100–1215` (relay frame handler), `804–811` (null-reset-during-reconnect guards).
  - **Suggested split:** Extract `src/core/relay-orchestrator.ts` owning `startBotLink`, party-line wiring, relay session state, and frame dispatch. Introduce a `SubsystemRegistry` for the optional subsystem pointers with a single `teardown()`.
  - **Risk:** Medium — relay is self-contained but the reconnect path reassigns fields; needs careful callback handle wiring.

- [x] **`src/core/botlink/hub.ts` — 821-line god file; `onSteadyState()` is a 98-line frame dispatch table**
  - **Problem:** Connection lifecycle + handshake + auth gating + frame dispatch + rate limiting + relay routing + BSAY + heartbeat + pending-request management all in one class. Adding a new frame type forces edits in a 50-line switch deep inside `onSteadyState` (677–774).
  - **Evidence:** `botlink/hub.ts:677–774` (onSteadyState with 3 inline rate checks + switch), `268–307` (handleCmdRelay), `339–359` (handleBsay), `506–562` (beginHandshake), `800–820` (startHeartbeat).
  - **Suggested split:** `botlink/hub-frame-dispatch.ts` (FrameHandler interface + registry), `botlink/hub-cmd-relay.ts`, `botlink/hub-bsay-router.ts`. Keep `hub.ts` focused on connection/handshake/auth-gate.
  - **Risk:** Medium — frame dispatch is on the hot path; tests must cover every frame type through the new registry.

- [x] **`src/types.ts` — 948-line dumping ground mixes dispatch, config, plugin API, and IRC protocol shapes**
  - **Problem:** 30+ plugin-wrapper interfaces, every `HandlerContext` variant, `BotConfig` + nested schemas, user records, and IRC protocol types share one file. Cannot describe its responsibility in a single sentence.
  - **Evidence:** `src/types.ts:15–256` (bind + context types), `272–485` (plugin API shapes), `542–566` (DB/user records), `573–857` (config schemas), `929–948` (re-exports).
  - **Suggested split:** `src/types/dispatch.ts` (bind + contexts), `src/types/config.ts`, `src/types/plugin-api.ts`. Keep `src/types.ts` as a façade re-exporting all three.
  - **Risk:** Low — purely organizational, but touches ~40 import statements across the repo.

- [x] **Plugin→core API boundary violation: `plugins/chanmod/mode-enforce.ts:36` imports `wildcardMatch` from `src/utils/`**
  - **Problem:** Runtime import of a utility function from `../../src/utils/wildcard` breaks the plugin encapsulation contract in CLAUDE.md and DESIGN.md. Only types should cross that boundary.
  - **Evidence:** `plugins/chanmod/mode-enforce.ts:36`, used at `:125` and `:152`.
  - **Suggested fix:** Expose `wildcardMatch` via the `api` object (add `api.util.matchWildcard(pattern, value)`), or vendor the ~20 LOC implementation into `plugins/chanmod/helpers.ts`.
  - **Risk:** Low — one file, trivial signature.

- [x] **Plugin→core API boundary violation: `plugins/flood/rate-limit-tracker.ts:11` imports `SlidingWindowCounter` runtime class from `src/utils/`**
  - **Problem:** Same contract violation as above, but imports a stateful class rather than a pure function.
  - **Evidence:** `plugins/flood/rate-limit-tracker.ts:11`.
  - **Suggested fix:** Expose the counter via `api` (preferred — other plugins will want it), or vendor it into the flood plugin.
  - **Risk:** Low.

- [x] **`src/core/botlink/auth.ts` — 538-line file mixes escalation math + pending-handshake storage + CIDR ban mgmt + sweep**
  - **Problem:** `noteFailure()` (272–350) embeds exponential-backoff/decay math inline alongside LRU eviction (286–291, relying on Map insertion order). `sweepStaleTrackers()` (383–411) iterates 4 state types.
  - **Evidence:** `botlink/auth.ts:272–350` (noteFailure), `383–411` (sweep), `286–291` (implicit LRU via Map order).
  - **Suggested split:** `botlink/auth-escalation.ts` (pure math + timer), `botlink/auth-store.ts` (Map storage + DB persistence). Keep `auth.ts` as the admission gate.
  - **Risk:** Low — escalation math is well-contained and easy to unit-test once extracted.

- [x] **`src/database.ts` — 859 lines mix KV store and mod_log concerns**
  - **Problem:** Single class owns KV CRUD, mod_log schema, retention pruning, mod_log writes (with metadata scrubbing), and mod_log reads. `logModAction()` is 95 lines (483–578). Scrubbing logic is duplicated between write and query paths.
  - **Evidence:** `src/database.ts:227–378` (KV), `380–482` (mod_log schema + retention), `483–578` (logModAction), `580–859` (queries).
  - **Suggested split:** Extract `src/core/mod-log.ts` (schema + retention + scrubbing + read/write). Keep `src/database.ts` focused on KV + error classification.
  - **Risk:** Medium — mod_log is on the audit path; extraction must preserve the `db.logModAction` signature plugins depend on.

- [x] **`src/core/channel-state.ts` — dual source-of-truth for network accounts**
  - **Problem:** Maintains both `networkAccounts` map (58) and a per-user `accountName` field (29). Every account-change handler (`onAccount`, `onAway`, `onUserUpdated`) fans out the same "iterate channels, find user by nick-lower, update field" loop. Missing either copy silently loses data.
  - **Evidence:** `src/core/channel-state.ts:58,29,252–263,587–611,619–638,641–654`.
  - **Suggested split:** Treat `networkAccounts` as canonical; compute per-user `accountName` via getter, or remove the map and read from per-channel records. Extract `updateUserAcrossChannels()` helper.
  - **Risk:** Low–Medium — needs careful `account-notify` timing tests.

- [x] **Duplicated heartbeat + frame parsing between `botlink/hub.ts` and `botlink/leaf.ts`**
  - **Problem:** Both files independently implement timer loops, PING/PONG validation, and link-timeout detection.
  - **Evidence:** `botlink/hub.ts:687–707` ≈ `botlink/leaf.ts:365–369`; `botlink/hub.ts:800–820` ≈ `botlink/leaf.ts:439–454`.
  - **Suggested split:** Extract `botlink/heartbeat.ts` exposing a generic driver with `onTimeout` callback. Inject into both hub and leaf.
  - **Risk:** Low — behavior is identical; extraction is mechanical.

- [x] **`plugins/rss/index.ts` — 554-line plugin mixes command handlers, circuit breaker, polling loop, and config parsing**
  - **Problem:** `handleAdd/List/Remove/Check` are 200+ combined lines alongside five maps of circuit-breaker state, the polling bind, and help registration.
  - **Evidence:** `plugins/rss/index.ts:138–554` (commands + circuit breaker + polling).
  - **Suggested split:** `plugins/rss/commands.ts` (handlers), `plugins/rss/circuit-breaker.ts` (failure state + backoff). Keep `index.ts` thin.
  - **Risk:** Low.

---

## Medium Priority

Worth doing, not urgent.

- [x] **`src/core/permissions.ts` — flag logic + hostmask parsing + DB I/O in one 649-line class**
  - **Evidence:** `permissions.ts:366–385` (findByHostmask), `141–176` (addUser mixes validation + DB + event + mod-log), persist-on-every-mutation pattern.
  - **Suggested split:** Extract `HostmaskMatcher` (pattern matching with specificity scoring). Batch persistence via explicit `flush()`.
  - **Risk:** Low–Medium.

- [x] **`src/core/services.ts` — `verifyUser()` is 89 lines mixing promise/abort/timeout/cap-enforcement logic**
  - **Evidence:** `services.ts:173–262` (verifyUser), `316–399` (response parsers that don't depend on state).
  - **Suggested split:** Extract `ServicesTimeoutTracker` for timeout/cap state. Move `tryParseAccResponse/tryParseStatusResponse` to a pure `ServicesParser` module.
  - **Risk:** Low.

- [x] **`src/core/connection-lifecycle.ts` — `registerConnectionEvents()` closes over 5+ state variables and 4 event handlers (200+ lines)**
  - **Evidence:** `connection-lifecycle.ts:126–565`, especially `159–194` and the `permanentFailureChannels` set shared between `registerJoinErrorListeners()` (440–489) and `startChannelPresenceCheck()` (534–565).
  - **Suggested split:** `ConnectionFSM` class; separate `ChannelPresenceChecker`.
  - **Risk:** Low.

- [x] **`src/irc-bridge.ts` — 694-line bridge mixes sanitization, account-tag extraction, rate limiting, and every event translation**
  - **Evidence:** `irc-bridge.ts:47–48` (STARTUP_GRACE_MS constant), `87–99` (account-tag extraction), scattered sanitize calls.
  - **Suggested split:** Extract `SanitizeOptions` helper; consider an event-translation table keyed by irc-framework event name.
  - **Risk:** Low.

- [x] **`src/dispatcher.ts` — bind dispatch + flood limiting + verification provider wiring in 520 lines**
  - **Evidence:** `dispatcher.ts:186–235` (flood state + sweep), `136–138` (verification provider).
  - **Suggested split:** Extract `FloodLimiter` class; inject into dispatcher.
  - **Risk:** Medium — flood state is tightly coupled to per-nick tracking.

- [x] **`src/config.ts` — 441 lines interleave Zod schemas, env-secret resolution, and validation**
  - **Evidence:** Schemas (39–80+) interleaved with resolution/validation.
  - **Suggested split:** Move schemas to `src/config/schemas.ts`; keep `config.ts` as loader/resolver.
  - **Risk:** Low.

- [x] **`src/plugin-api-factory.ts` — 787 lines of wrappers around single-implementor APIs**
  - **Evidence:** `plugin-api-factory.ts:407–421` (createPluginPermissionsApi passes through verbatim), `423+` (createPluginServicesApi same), `377+` (createPluginDbApi same).
  - **Suggested split:** Inline trivial passthroughs into main `createPluginApi()`; keep the dispose mechanics (`289–303`) which do real work.
  - **Risk:** Low — reduces file to ~400 lines without behavior change.

- [x] **`src/utils/command-helpers.ts` — not a util (imports `CommandContext`, `tryAudit`, `BotDatabase`)**
  - **Evidence:** `utils/command-helpers.ts:7–9` imports from `../command-handler`, `../core/audit`, `../database`.
  - **Suggested fix:** Move to `src/core/command-helpers.ts`.
  - **Risk:** Low — mechanical move + import updates.

- [x] **`src/utils/admin-list-store.ts` — stateful class wrapping `BotDatabase` with console.warn side effects**
  - **Evidence:** `utils/admin-list-store.ts:17–21,55–68` (mutable state + direct console.warn at 62).
  - **Suggested fix:** Move to `src/core/admin-list-store.ts` (alongside other DB-adjacent code) and inject a logger.
  - **Risk:** Low.

- [x] **DCC session teardown duplication: `close()` and `onClose()` share 90% of cleanup**
  - **Evidence:** `dcc/index.ts:865–897` vs `899–915` — both call `removeSession`, `announce`, `notifyPartyPart`, `clearPagerForSession`, `clearAuditTailForSession`.
  - **Suggested fix:** Extract `private teardownSession()`; both callers delegate to it. `close()` additionally handles graceful socket destruction.
  - **Risk:** Low.

- [x] **DCC IRC mirror extraction duplication: `mirrorNotice` and `mirrorPrivmsg`**
  - **Evidence:** `dcc/index.ts:1250–1268` — both extract `{nick,target,message}`, both filter channels; only output format and NickServ check differ.
  - **Suggested fix:** Extract `private formatEventParts(raw)` returning the shared struct; specialize per mirror.
  - **Risk:** Low.

- [x] **DCC session-key casemapping boilerplate repeated 6×**
  - **Evidence:** `dcc/index.ts:1030,1332,1437,1455,1640,1643` — manual `ircLower(nick, this.casemapping)`.
  - **Suggested fix:** Add private helpers `sessionKey(nick)`, `getSessionByNick(nick)`, `setSession(nick, session)`.
  - **Risk:** Low.

- [x] **chanmod Anope/Atheme backends duplicate ~70% of access-management scaffolding**
  - **Evidence:** `plugins/chanmod/anope-backend.ts:36–48` vs `atheme-backend.ts:22–30` (accessLevels + autoDetectedChannels identical); both implement the same `canOp/canDeop/canUnban/canInvite/canRecover/canClearBans/canRemoveKey/canAkick/requestOp/...` surface.
  - **Suggested split:** Extract `BackendBase` with shared access/capability logic; let each subclass override `requestRecover`, `requestRemoveKey`, `verifyAccess`/`flagsToTier`. Saves ~80 LOC.
  - **Risk:** Low — interface is stable.

- [x] **`plugins/chanmod/chanserv-notice-anope.ts` — 5-state-machine notice handler with deferral race window**
  - **Evidence:** `chanserv-notice-anope.ts:139–189` (stateful INFO parser + `activeInfoChannel`), `174–186` (deferred-flush logic).
  - **Suggested fix:** At minimum, document the race windows. Consider extracting `DeferredFlushManager` if it grows further.
  - **Risk:** Low.

- [x] **`src/core/commands/` — argument parsing boilerplate duplicated ~7 times**
  - **Evidence:** `permission-commands.ts:37–41`, `password-commands.ts:76–78`, `channel-commands.ts:74–80`, `irc-commands-admin.ts:127–137`, `modlog-commands.ts:415` — all `parts = args.split(/\s+/); if (parts.length < N) { ctx.reply('Usage: …'); return; }`.
  - **Suggested fix:** Add `parseCommandArgs(args, minParts, usage, ctx)` to `command-helpers.ts` after it moves to core.
  - **Risk:** Low.

- [x] **`src/core/commands/` — inconsistent dependency injection styles**
  - **Evidence:** `ban-commands.ts` takes `Deps` interface; `password-commands.ts` takes `Deps`; `permission-commands.ts` takes two positional params; `botlink-commands.ts` takes **6** positional params.
  - **Suggested fix:** Standardize on the `Deps` interface pattern already used by ban/password.
  - **Risk:** Low — call-site only.

- [x] **`src/core/commands/` — ad-hoc inline permission validation patterns (no shared helpers)**
  - **Evidence:** `password-commands.ts:70–112` (transport-based checks), `modlog-commands.ts:388–405` (master vs owner nuance), `permission-commands.ts:157–158` (masters can't grant +m). Only `botlink-commands.ts` has extracted `requireEnabled/requireHub/requireLeaf` helpers.
  - **Suggested split:** Create `src/core/commands/permission-helpers.ts` with `requireTransport(ctx, allowed)`, `requireSelfOrOwner(ctx, handle, permissions)`. Promote the botlink pattern.
  - **Risk:** Low.

- [x] **`src/core/botlink/relay-router.ts` — four Map-based routing tables with near-identical sweep logic**
  - **Evidence:** `relay-router.ts:275–289` (sweepStaleRoutes, four loops differing only in TTL constant).
  - **Suggested fix:** Generic `RoutingMap<T>` class with configurable TTL and auto-sweep. Reduces 298 LOC to ~180.
  - **Risk:** Low.

- [x] **Test helper duplication across 14+ plugin test files**
  - **Evidence:** `tests/plugins/chanmod*.test.ts`, `tests/plugins/flood.test.ts`, `tests/plugins/topic.test.ts` all redefine `tick(ms)`, `giveBotOps(bot, channel)`, `addToChannel(...)`, `simulateMode(...)`, `simulatePrivmsg(...)`, `simulateJoin(...)`.
  - **Suggested fix:** Extract to `tests/helpers/plugin-test-helpers.ts`; import in all affected files.
  - **Risk:** Low — test-only change.

- [x] **`plugins/ai-chat/` — `handleSubcommand()` is a 225-line `switch` statement**
  - **Evidence:** `plugins/ai-chat/index.ts:1416–1639` — 12 cases each mixing validation, DB ops, and reply formatting.
  - **Suggested fix:** Handler map keyed by subcommand name (`handlers: Record<string, (args, ctx) => Promise<void>>`); each handler in its own function.
  - **Risk:** Low.

- [x] **`plugins/ai-chat/` — `runPipeline()` mixes provider call, character style, degraded-mode fallback, and IRC send**
  - **Evidence:** `plugins/ai-chat/index.ts:1124–1284` (160 lines), especially `1163` (degraded placeholder) and `1256` (applyCharacterStyle post-format).
  - **Suggested split:** Extract `plugins/ai-chat/sender.ts` (IRC send with drip-feed). Document why character styling runs after formatting (security: avoid re-introducing fantasy prefixes via lowercasing).
  - **Risk:** Low.

- [x] **`plugins/rss/feed-formatter.ts` — `announceItems` mixes formatting, 500ms drip-feed sleep, and API calls**
  - **Evidence:** `feed-formatter.ts:61–97`.
  - **Suggested fix:** Extract a dedicated announce-loop helper that owns the drip-feed + abort signal plumbing; formatter stays pure.
  - **Risk:** Low.

- [x] **`src/core/botlink/pending.ts` — hardcoded `MAX_PENDING = 4096`, no observability when cap is hit**
  - **Evidence:** `botlink/pending.ts:22,46–48`; `relay-router.ts:114–118,134–138` duplicate cap checks.
  - **Suggested fix:** Make cap configurable per instance; emit a warning (or log) when `droppedAtCap` increments.
  - **Risk:** Low.

- [x] **`src/core/botlink/auth.ts` — LRU eviction relies on Map insertion order (`286–291`) with no explicit guard**
  - **Suggested fix:** Extract `LRUMap<K,V>` helper encapsulating the eviction invariant.
  - **Risk:** Low.

- [x] **`plugins/ai-chat/` — session expiry interval doesn't catch exceptions**
  - **Evidence:** `plugins/ai-chat/index.ts:754–758` — if `sessionManager.expireInactive()` throws, the error is swallowed.
  - **Suggested fix:** Wrap in try/catch and log; or audit `expireInactive()` for throw-safety.
  - **Risk:** Low.

---

## Low Priority / Cosmetic

Small wins, address opportunistically.

- [ ] `src/command-handler.ts:193` — `checkCommandPermissions(entry, commandName, args, ctx)` — `commandName`/`args` are redundant (available via `entry`/`ctx`).
- [ ] `src/plugin-api-factory.ts:154,226` — `getCasemapping()` called inside each bind-dispatch closure; add a comment noting CASEMAPPING is assumed stable, or cache it.
- [ ] `src/event-bus.ts:117–137` — type casts for contravariance are verbose; not actionable without an event-bus rewrite.
- [ ] `src/core/dcc/index.ts:932–939` — awkward `as unknown as {...}` cast for `offBusListener`.
- [ ] `src/core/dcc/protocol.ts:11` — `DCC_PROMPT_TIMEOUT_MS` lives in the wire-protocol module but is only used for the UX prompt. Move to a `dcc/constants.ts` alongside `PENDING_TIMEOUT_MS` (922), `MAX_LINE_BYTES` (426), `MAX_BLANK_PROMPTS` (432).
- [ ] `src/core/commands/modlog-commands.ts` — 7 exported helpers (`parseModlogFilter`, `parseDurationSeconds`, `checkModlogPermission`, `relativeTime`) lack JSDoc.
- [ ] `src/utils/verify-flags.ts:18–36` — `validateRequireAccFor()` is a 15-line wrapper around a single config-field check; inline into the config loader.
- [ ] `src/utils/socks.ts:15–22` — `buildSocksOptions()` is a one-liner conditional spread; inline or shorten via `Object.fromEntries`.
- [ ] `src/core/irc-commands.ts:245–302` — `mode()` reimplements param allocation (251–269) already done per-mode at 170–198; extract `ModeBuilder` or document the duplication.
- [ ] `src/core/message-queue.ts:241–283` — `popNext` cursor is a nick name (O(n) `indexOf`); document the trade-off or extract a `RoundRobinCursor`.
- [ ] `src/core/memo.ts:152–159` — `eventBus` subscription for cleanup is optional; make it mandatory, or switch cooldown to `WeakMap<UserHandle, timestamp>`.
- [ ] `src/core/permissions.ts:366–385` vs `src/core/memo.ts:229–248` — both iterate users to find matching records; candidate for a shared `findUsersByPredicate` if a third call-site emerges.
- [ ] `plugins/flood/lockdown.ts:68–79` — `timestamps.shift()` / `flooders.clear()` interaction is non-obvious after prior bug-fix; extract `pruneStaleFlooders()` with named intent.
- [ ] `plugins/rss/feed-fetcher.ts:159–280` — `doRequest()` composes wall-clock timeout + external abort + socket pinning; add a header comment explaining the three-way timeout.
- [ ] `plugins/greeter/index.ts:251`, `plugins/help/index.ts:179`, `plugins/8ball/index.ts:57` — empty `teardown()` with "No cleanup needed" comments; move that explanation to the point where state is scoped inside `init()` (makes the intent visible next to the state declaration).
- [ ] `plugins/ai-chat/index.ts:790–804` — null-then-assign pattern for `provider` is less clear than a ternary: `provider = providerConfig ? await createResilientProvider(…) : null`.
- [ ] `plugins/ai-chat/index.ts:1032–1072` — three-level branching in reply-decision is acceptable but could flatten via an extracted `buildDecisionContext(...)` helper.
- [ ] `plugins/ai-chat/index.ts:1256` — character style applied after formatting is intentional for security; add a one-line comment explaining why order matters.
- [ ] `src/core/commands/dispatcher-commands.ts` — read-only `.binds` command; no audit logging. Not a bug, but a one-line comment explaining the skip would clarify intent.
- [ ] `src/core/commands/botlink-commands.ts:357–441` — `.relay` handler is 84 lines; acceptable but a candidate for a named helper if a second relay-like command appears.

---

## Patterns to address across the codebase

These are systemic — address with a single coordinated change rather than file-by-file.

- [x] **Casemapping is threaded manually through 5+ modules**
  - Permissions, ChannelState, DCCManager, MessageQueue, IRCBridge each store a `casemapping` field and call `ircLower()` at every key lookup. `setCasemapping()` must be invoked on each in the correct order during ISUPPORT parsing. Introduce `src/core/casemapping-manager.ts` owning the single source of truth, with subscribers that rehash their keys on change.
- [x] **`auditActor(ctx)` helper (documented in CLAUDE.md §12) is unused across `src/core/commands/`**
  - All mutating handlers call `tryAudit(db, ctx, ...)` directly instead. Either (a) update CLAUDE.md to clarify `tryAudit` is the command-handler form and `auditActor` is only for `IRCCommands.method(...)` calls, or (b) adopt `auditActor` uniformly.
- [x] **Plugin→core boundary violations**
  - Two runtime imports: `plugins/chanmod/mode-enforce.ts:36` (`wildcardMatch`) and `plugins/flood/rate-limit-tracker.ts:11` (`SlidingWindowCounter`). Add an `api.util` namespace exposing both, rather than one-off exceptions.
- [x] **Reconnect teardown is not orchestrated**
  - `clearNetworkAccounts()`, `clearAllChannels()`, `cancelPendingVerifies()`, relay session resets, and subsystem null-outs are called separately across `bot.ts:804–811` and elsewhere. A single `onReconnecting()` hook that subsystems subscribe to would eliminate the risk of forgetting one.
- [x] **Event-bus emission is scattered; centralize audit paths**
  - Permissions, ChannelState, Services, and Memo all emit independently. `audit.ts` partly centralizes but broader emission patterns (e.g., `user:removed`, `account:changed`) could share a helper.
- [x] **Test helper duplication** — see High/Medium entry; extract `tests/helpers/plugin-test-helpers.ts`.

---

## What looks good

Specific files and patterns worth preserving and emulating — do not "clean these up."

- **Entry point & primitives.** `src/index.ts`, `src/process-handlers.ts`, `src/event-bus.ts` are tight, focused, testable.
- **Audit helpers.** `src/core/audit.ts` provides single call-site mod-log attribution; grep-friendly and consistently used across all mutating command handlers.
- **Ban store.** `src/core/ban-store.ts` has a clean two-pass sweep (104–129) and validation on load.
- **Database error classification.** `src/database.ts:25–67` — distinct `DatabaseBusyError`/`DatabaseFullError`/fatal paths with graceful caller degradation.
- **Channel settings registry.** `src/core/channel-settings.ts` — case-folding on write, legacy fallback on read (83–95), plugin lifecycle hooks.
- **Message queue round-robin.** `src/core/message-queue.ts` — tight invariants, well-tested; subtle but correct.
- **`src/utils/` is almost entirely pure.** `wildcard.ts`, `sanitize.ts`, `sliding-window.ts`, `split-message.ts`, `strip-formatting.ts`, `table.ts`, `duration.ts`, `parse-args.ts`, `irc-event.ts`, `listener-group.ts` — all focused, documented, no hidden state.
- **Botlink module hygiene.** `protocol.ts`, `types.ts`, `frame-types.ts`, `cmd-exec.ts`, `protect.ts`, `relay-handler.ts`, `rate-counter.ts`, `sync.ts`, `sharing.ts` — each has a clear single responsibility; handshake + teardown paths unified.
- **DCC peripheral modules.** `auth-tracker.ts`, `console-flags.ts`, `protocol.ts`, `banner.ts`, `login-summary.ts` — focused, testable. The 1654-line `dcc/index.ts` is the exception, not the rule.
- **chanmod teardown architecture.** `plugins/chanmod/index.ts:30–256` — teardown array pattern; Atheme callback nulling (72–79) to break closure pinning; centralized `state.ts` with `CycleState` TTL pruning. Model for new plugins.
- **ai-chat provider architecture.** `providers/types.ts` (minimal interface), `providers/resilient.ts` (half-open circuit breaker with jittered backoff, 30–139), `output-formatter.ts` (NFKC normalization + combining-mark stripping for fantasy-prefix defense). Do not consolidate Gemini + Ollama — they legitimately speak different APIs.
- **flood enforcement.** `plugins/flood/enforcement-executor.ts` — clean separation of `recordOffence` / `apply` / `drainPending` / `liftExpiredBans`; teardown at `plugins/flood/index.ts:318–336` is exemplary.
- **Command hygiene.** Consistent `tryAudit` usage across mutating handlers; last-owner-protection in `permission-commands.ts:92–101`; DCC-transport rejection in `password-commands.ts:70–74`.
- **Test grouping.** `tests/plugins/chanmod.test.ts` (63 `describe` blocks) and `tests/core/botlink.test.ts` (37 describes) are large but well-sectioned — no structural problem.
