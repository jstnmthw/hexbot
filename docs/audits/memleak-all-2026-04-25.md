# Memory Leak Audit: hexbot (full sweep)

**Date:** 2026-04-25
**Scope:** Every `.ts` file in `src/` (99 files) and `plugins/` (73 files, excluding `node_modules` and `tsup.config.ts`).
**Estimated risk:** **Medium** — driven by one CRITICAL that is a Node ESM-loader inherent limitation, plus a handful of WARNINGs around plugin reload, IRC reconnect, and per-user state lingering.

## Summary

The codebase is unusually well-defended for a long-running IRC bot. The plugin loader, dispatcher, plugin-api-factory triad shows clear evidence of prior leak audits (W-DCC1..4, W-CL1..2, W-PS1..3, W-BO1..2 all visibly fixed). Most modules either keep state in SQLite (no in-memory growth), enforce hard caps + LRU eviction, or expose explicit teardown contracts that are correctly called.

The single CRITICAL is structural: Node's ESM loader has no API to evict `import()` registry entries, so cache-busted plugin reloads accumulate one full module graph per `.reload`. This affects every long-running bot that reloads plugins; mitigation is operational (gate cache-bust on file mtime) plus reload counters.

Beyond that, the WARNINGs are mostly latent (one future PR away from a real leak) or slow-burn (per-user state that lingers minutes-to-hours instead of being pruned on QUIT). After hours of typical operation: clean. After weeks of operator `.reload` cycling: real leak via the CRITICAL. After months on a high-churn IRC network: per-user state in `ai-chat`/`seen` will fill caps but cap-evict cleanly.

**Findings:** 1 critical, 16 warning, ~40 info (most info-level items are leak-free patterns called out as templates worth preserving — listed in the "Leak-free patterns" section).

## Cross-cutting verification

The chanmod scan flagged 5 missing `api.off*` registrations contingent on whether the loader reaps them. **Verified resolved**:

- `plugin-loader.ts:513-530` (`cleanupPluginResources`) drains five per-plugin listener Maps tracked by `plugin-api-factory.ts:701+` (`onModesReady`, `onPermissionsChanged`, `onUserIdentified`, `onUserDeidentified`, `onBotIdentified`).
- `plugin-loader.ts:529-530` calls both `channelSettings.unregister(pluginName)` and `channelSettings.offChange(pluginName)` on every unload.

So the chanmod WARNING is downgraded to INFO; the contingent risk is closed.

---

## Findings

### CRITICAL

#### [x] Cache-busted plugin imports accumulate forever in the ESM module registry — **RESOLVED**

- **File:** `src/plugin-loader.ts:721-729` (deleted)
- **Resolution:** Deleted at the source rather than mitigated. The `live-config-updates` refactor (2026-04-25) removed `.reload`, `importWithCacheBust`, the `importedOnce` Set, and the `plugin:reloaded` / `plugin:reload_failed` events outright. `load()` now uses a plain `await import(pathToFileURL(absPath).href)` — Node's ESM loader caches by URL with no query string, so a second `load()` of the same plugin path resolves to the same cached module (which is exactly what an unload→re-enable cycle wants).
- **Why this is the right fix:** Node's ESM loader has no module-graph eviction API, so any cache-busted re-import is unrecoverable. Mitigations (mtime gate, `importedOnce` prune, reload counter) reduce the rate of leak but never close it. Removing the leak vector is the only correct answer; the operator paths it served are picked up by `.set core plugins.<id>.enabled true/false` (lifecycle) and `.restart` (clean process restart for code edits).
- **Receipt:** `tests/plugin-loader.test.ts` `unloadAll` describe block; `tsc --noEmit` shows zero unresolved references to `importWithCacheBust` / `importedOnce` / `reload` / `plugin:reloaded` / `plugin:reload_failed`.

---

### WARNING — plugin loader / dispatcher / event bus

#### [x] `BotEventBus.setMaxListeners(50)` masks accumulation across reloads — **RESOLVED**

- **File:** `src/event-bus.ts:117-126`
- **Category:** listener leak (defense-in-depth)
- **Growth rate:** masked — would otherwise warn at 10
- **Description:** Cap raised from 10 to 50 with the comment "four-plus plugins routinely subscribe". Legitimate at steady state, but a per-reload listener leak (the kind W-PS2 was created to address) wouldn't warn until the **51st** stale listener accumulates. With 5 plugins × 5 reloads × 1 leaked listener each you reach 25 — invisible. ai-chat alone subscribes to `user:identified`/`user:deidentified`/`channel:modesReady` and can hit 50 within a single dev session of repeated `.reload`s if any wiring is wrong.
- **Remediation:** Lower to 20; treat any warning as a real bug. Or instrument the bus to log per-event counts at thresholds (10/20/30) so operators see the trend before the cap fires.

#### [x] Bare `eventBus.on()` calls bypass `removeByOwner` safety net — **RESOLVED**

- **Files:** `src/bot.ts:387, 573`, `src/index.ts:112-113`
- **Category:** listener leak (latent)
- **Growth rate:** zero today; one listener per re-invocation of any of these sites if they ever move to a re-runnable path
- **Description:** `wireDispatcher()` registers `bot:disconnected` directly; `attachBridge()` registers `bot:nick-collision`; `index.ts` registers `bot:connected`/`bot:disconnected` for heartbeat. Each fires once per process today (constructor-installed), so no live leak — but there is no symmetric `off()` and the closures capture `this` (entire `Bot` instance for the bot.ts ones).
- **Remediation:** Migrate all bare `.on()` calls on the event bus to `trackListener('bot', ...)`; then `bot.shutdown()` can call `eventBus.removeByOwner('bot')` as a uniform safety net.

#### [x] Plugin-api-factory listener tracking maps populated _after_ `eventBus.on()` — **RESOLVED**

- **File:** `src/plugin-api-factory.ts:701-722` (and four parallel on*/off* pairs)
- **Category:** listener leak (latent)
- **Growth rate:** one orphaned wrapper per failed `eventBus.on` call (rare but not zero)
- **Description:** Each `onModesReady` / `onPermissionsChanged` / `onUserIdentified` / `onUserDeidentified` / `onBotIdentified` runs `eventBus.on(...)` _before_ tracking-map writes. If `eventBus.on` ever throws (theoretical today since `EventEmitter.on` doesn't, but a future override could), the listener is on the bus but not in the tracking maps — `cleanupPluginResources` can't find it on unload, leaks for bus lifetime.
- **Remediation:** Reorder so tracking-map writes happen first; or wrap the three statements in a try/`eventBus.off` rollback.

#### [x] No `pluginLoader.unloadAll()` on bot shutdown — **RESOLVED**

- **Resolution:** Added `PluginLoader.unloadAll()` and called from `Bot.shutdown()` between `relay-orchestrator.stop` and `memo.detach`. Every loaded plugin's `teardown()` runs on process exit; per-plugin throws are logged and the loop continues so one bad teardown can't strand siblings.

#### [x] `EventDispatcher.binds[]` has no per-plugin cap (bind-storm risk) — **RESOLVED**

- **File:** `src/dispatcher.ts:259-268`
- **Category:** unbounded collection (defense-in-depth)
- **Description:** A buggy plugin that calls `api.bind()` in a handler loop pushes into `binds[]` indefinitely until unload. At 10k entries every dispatch becomes O(10k) wildcard-match work. Throughput collapses before OOM.
- **Remediation:** Soft cap (e.g. 1000 binds/plugin) with warning at 500 and refusal at 1000. The non-stackable filter for `pub`/`msg` already catches the common case; this catches the genuinely misbehaving.

#### [x] `PluginLoader.importedOnce` Set never pruned on unload — **RESOLVED (deleted)**

- **Resolution:** The `importedOnce` Set was deleted alongside `importWithCacheBust` and `reload()` in the live-config refactor. Plain `import()` now resolves to the cached module on every `load()` of the same path — no per-load tracking needed, no leak vector remaining.

#### [x] Auto-disabled timer binds become zombie entries in `dispatcher.binds[]` — **RESOLVED**

- **File:** `src/dispatcher.ts:215`
- **Category:** unbounded collection (small)
- **Description:** Auto-disable path calls `clearTimer(entry)` (clears interval + timer-Map entry) but does not splice from `this.binds`. The bind shows up in `.binds` listings forever in a "zombie" state with `consecutiveFailures` saturated. Real concern is operator confusion more than memory.
- **Remediation:** Splice from `this.binds` on auto-disable, or set `disabled: true` and have `listBinds()` filter/label.

---

### WARNING — IRC connection / services

#### [x] `bot:nick-collision` eventBus listener registered without paired `off()` — **RESOLVED**

- **File:** `src/bot.ts:573`
- **Category:** listener leak (latent)
- **Description:** `attachBridge()` registers an inline arrow on `bot:nick-collision` and never removes it. Today `attachBridge()` runs once at construction, so no live leak. Closure captures `this`, `channelState`, `bridge`, `config`, `services`. No symmetric `off` in `Bot.stop()` — a future refactor that re-attaches the bridge silently leaks.
- **Remediation:** Hoist to a named field (matching the `_onConnected`/`_onDisconnected` pattern in `services.ts:149-151`); add `eventBus.off('bot:nick-collision', this._onNickCollision)` to `Bot.stop()`.

#### [x] `pendingGhostResolver` overwritten without clearing prior pending resolver — **RESOLVED**

- **File:** `src/core/services.ts:670-693`
- **Category:** closure capture / correctness bug
- **Description:** `ghostAndReclaim()` overwrites `this.pendingGhostResolver` on each call. If invoked twice within 1.5s (flapping nick-collision events on a fragile link), the old `setTimeout` is still scheduled. When it fires, `finish()` sets `this.pendingGhostResolver = null`, _clobbering the new race's resolver_ — second `ghostAndReclaim()` waits the full 1.5s instead of unblocking on ack. Memory impact small (one orphaned timer + closure per overlap); cross-resolver clobbering is a correctness bug.
- **Remediation:** At top of `ghostAndReclaim`, if `this.pendingGhostResolver` is non-null, call it (or store a separate `pendingGhostTimer` and clear it) before installing the new one.

---

### WARNING — networked subsystems

#### [x] `BotLinkRelayRouter.activeRelays` Map has no hard cap — **RESOLVED**

- **File:** `src/core/botlink/relay-router.ts:87, 126, 250`
- **Category:** unbounded collection
- **Growth rate:** one entry per RELAY_REQUEST that passes the `hasRemoteSession` gate; up to ~3,600/hr before the 1-hour TTL sweep
- **Description:** Sibling routing maps `cmdRoutes` and `protectRequests` enforce `MAX_PENDING_ROUTES = 4096`; `remotePartyUsers` enforces `MAX_REMOTE_PARTY_USERS = 512`. `activeRelays` only relies on the 1-hour `RELAY_TTL` sweep, which is itself heartbeat-driven and stops if all leaves disconnect.
- **Remediation:** Add cap check in both `registerHubRelay` and the RELAY_REQUEST branch. Suggest `MAX_ACTIVE_RELAYS = 256`.

#### [x] DCC `mirrorTimestamps` rate-limit array is module-level state — **RESOLVED**

- **File:** `src/core/dcc/irc-mirror.ts:22`
- **Category:** reload residue
- **Description:** Module-level `mirrorTimestamps: number[]` is shared globally across all DCCManager instances. Bounded at `MIRROR_RATE_LIMIT=60` so not a heap leak, but two DCCManager instances in the same process (test fixtures) share one rate-limit window, and a future hot-reload of `irc-mirror.ts` orphans the array's old captures.
- **Remediation:** Lift into `createMirrorRateLimiter()` factory returning `{ allow }`; instantiate per-manager. Pass to `mirrorNotice` / `mirrorPrivmsg` instead of implicit module global.

---

### WARNING — REPL / logger

#### [x] `Logger.sinks` Set is module-static, never pruned across plugin reloads — **RESOLVED**

- **File:** `src/logger.ts:162`
- **Category:** reload residue
- **Description:** Class-level `static sinks: Set<LogSink>` shared across the process. Plugins that register sinks in `init()` and forget `removeSink()` in `teardown()` leak a closure over the old module scope on every reload — not just the function but every variable it captures. Each subsequent log line iterates the entire set, multiplying per-log CPU by leak count.
- **Remediation:** Add `Logger.sinkCount()` metric and a runtime warning when `sinks.size > 8`. Consider a named-sink registry (`addSink(name, sink)`) so the plugin loader can audit and force-remove on reload.

#### [x] REPL `Logger.setOutputHook` not cleared if shutdown throws before `stop()` — **RESOLVED**

- **File:** `src/repl.ts:86`
- **Category:** closure capture
- **Description:** `Logger.setOutputHook((line) => this.print(line))` captures the BotREPL `this`. Matching `setOutputHook(null)` only runs in `stop()`. If `process.exit()` fires from the close handler without `stop()` (uncaught exception during `bot.shutdown()`), the hook stays — entire BotREPL graph alive. Production: minor (process exit clears). Tests with multiple BotREPL instances: each leaks one BotREPL graph.
- **Remediation:** Wrap `stop()` in `try/finally` from the close handler. Or `process.once('exit', () => Logger.setOutputHook(null))` in `start()` defensively.

---

### WARNING — command + audit infrastructure

#### [x] `.audit-tail` listener captures full `ctx` for the REPL session lifetime — **RESOLVED**

- **File:** `src/core/commands/modlog-commands.ts:529-534`
- **Category:** closure capture
- **Description:** `.audit-tail` registration creates `listener = (entry) => { if (matcher(entry)) ctx.reply(renderRow(entry)); }` and stores it in module-scope `tailListeners`. Closure captures `ctx` and `ctx.reply`. No automatic eviction on REPL detach — only `.audit-tail off` or `shutdownModLogCommands()` at process exit.
- **Remediation:** Wire a `repl:detached` event from REPL teardown that calls `clearAuditTailForSession('repl')`. Optional: auto-`off` after N hours of no command activity.

#### [x] `.modlog` `pagers` Map accumulates `botlink:<nick>` entries between sweeps — **RESOLVED**

- **File:** `src/core/commands/modlog-commands.ts:78, 95-101, 103-109`
- **Category:** unbounded collection (slow)
- **Description:** Module-scope `pagers` Map keyed by session. DCC and REPL keys are eagerly cleared via `clearPagerForSession`. Botlink-relayed callers get a `botlink:<nick>` key with no equivalent teardown hook — `pruneIdle` only runs on the next `.modlog` invocation. A quiet hub where operators run `.modlog` once and disconnect leaves entries until the next `.modlog` from anyone.
- **Remediation:** Either (a) `setInterval(pruneIdle, IDLE_TIMEOUT_MS / 2).unref()` registered + cleared in shutdown, or (b) hook `botlink:leaf-disconnect`/`botlink:relay-end` events to `clearPagerForSession(\`botlink:${handle}\`)` for symmetric cleanup with DCC.

---

### WARNING — plugins

#### [x] ai-chat: no `quit` bind; per-user state lingers after user leaves — **RESOLVED**

- **File:** `plugins/ai-chat/index.ts:551-564`
- **Category:** unbounded collection (slow)
- **Description:** Plugin only registers `part`/`kick` binds gated on `api.isBotNick(ctx.nick)` — they fire only when the BOT leaves. No `quit` bind. When an individual user QUITs/PARTs, none of `EngagementTracker.engaged[nick]`, `RateLimiter.userBuckets[nick]`, `SocialTracker.activeUsers[nick]`, or `SessionManager.sessions[nick|ch]` is proactively cleaned. Each has its own bounded eviction (5 min activity window, hard caps + LRU, idle-bucket eviction, soft/hard timeouts) so this is bounded — but per-user residue lingers minutes-to-hours, eating cap headroom.
- **Remediation:** Add a `quit` bind that calls `engagementTracker?.endEngagement(channel, ctx.nick)` and `sessionManager?.endSession(ctx.nick, channel)` for every channel the bot shares with the quitting user. Add a non-bot `part`/`kick` branch for per-channel cleanup.

#### [x] ai-chat: `lastRateLimitOpNoticeAt` not cleared on bot leaves channel — **RESOLVED**

- **File:** `plugins/ai-chat/index.ts:124, 551-564`
- **Category:** unbounded collection
- **Description:** Module-scope `Map<channel, number>` for per-channel op-notice debounce. Bot's own `part`/`kick` binds clear `socialTracker`, `contextManager`, `engagementTracker` — but not `lastRateLimitOpNoticeAt`. Only `teardown()` clears it. No hard cap, no idle eviction. On invite-spam-prone networks, grows by one entry per channel × every rate-limit incident, only reclaimed on plugin teardown.
- **Remediation:** Add `lastRateLimitOpNoticeAt.delete(ctx.channel)` to both bot-leave branches alongside the existing `dropChannel` calls.

#### [x] ai-chat: per-channel collection caps not coordinated across trackers — **RESOLVED**

- **Files:** `plugins/ai-chat/engagement-tracker.ts:18`, `plugins/ai-chat/social-tracker.ts:64`, `plugins/ai-chat/context-manager.ts`, `plugins/ai-chat/rate-limiter.ts`
- **Category:** unbounded collection (slow)
- **Description:** Each per-channel collection caps independently: `EngagementTracker.MAX_CHANNELS=256`, `SocialTracker.MAX_CHANNELS=256`, `ContextManager.channels` (no documented cap, only TTL-based pruning that deletes empty buffers), `RateLimiter.ambientChannelWindows` (no cap, per-access pruning leaves Map keys). Combined footprint scales with the union of channels each tracker has seen, not a single global set.
- **Remediation:** Add `MAX_CHANNELS` cap with LRU eviction to `ContextManager.channels` and `RateLimiter.ambientChannelWindows`, OR wire `ContextManager.pruneAll()` to the existing 60s sweep that runs `expireInactive()`.

#### [x] seen plugin: per-nick (not per-channel) tracking with 10k cap — **PARTIALLY RESOLVED** (redundant query-path sweep dropped; per-channel scoping deferred)

- **File:** `plugins/seen/index.ts:75-102`
- **Category:** unbounded collection (capped, but coarse)
- **Description:** `pubm` writes a KV row keyed only by `seen:<nick>`. No per-channel scoping — a nick that spoke once in any channel sits in the table for 90 days. Hourly sweep enforces 10k cap, but on a busy network that fills in days; thereafter active users get pushed out by transient ones via TTL+cap interaction. Inline `cleanupStale` runs on every `!seen` query (O(n) DB scan + JSON.parse per entry).
- **Remediation:** (a) Drop the inline `cleanupStale` from the `!seen` query path — the hourly sweep + per-record age check on read make it redundant. (b) Optional: prune on QUIT/PART, or move to LRU eviction so cap pressure doesn't churn long-lived entries.

---

## Leak-free patterns worth highlighting

These should be preserved when refactoring and used as templates for new code.

### Defense-in-depth templates

- [ ] **`disposeApi` + `wrapApiMethods`** (`plugin-api-factory.ts:128-378`) — neutralize-don't-just-detach. Walks every top-level method and listed sub-API namespace; post-dispose every guarded method short-circuits to `undefined`. Template for any "handle must outlive subsystem" defense.
- [ ] **`ListenerGroup`** (`utils/listener-group.ts`) — record-on-attach, per-entry try/catch on detach, constructor refusal of unsupportable targets. Right template for any per-emitter listener set.
- [ ] **`BotEventBus.trackListener` / `removeByOwner`** (`event-bus.ts:161-190`) — owner-keyed listener registry. Right template whenever an EventEmitter outlives its subscriber.
- [ ] **`EventDispatcher.unbindAll` rebuild-not-splice** (`dispatcher.ts:271-281`) — reentrancy-safe collection cleanup.
- [ ] **`Bot.shutdown` step-wrapper** (`bot.ts:707-713`) — per-step try/catch so one teardown failure can't strand the rest.

### Connection layer

- [ ] **`IRCBridge.detach()`** removes all `client.on()` via `listenIrc()`/`this.listeners`, clears `topicStartupGraceTimer` and `ctcpSweepTimer`, resets listener array. Reference implementation.
- [ ] **`ChannelState` PART/QUIT/KICK/NICK pruning** (`channel-state.ts:310-406`) — textbook user/channel pruning including `networkAccounts.delete` and bot-self-kick channel removal.
- [ ] **`Services` pending-verify map** (`services.ts:64, 218-228, 238-245, 314-348`) — `MAX_PENDING_VERIFIES=128` cap; concurrent callers share one promise; `detach()` aborts every controller; `cancelPendingVerifies()` separate disconnect-path cleanup.
- [ ] **`ReconnectDriver`** (`reconnect-driver.ts:108-199`) — single `retryTimer` field; `clearRetryTimer()` called at top of every reschedule path.
- [ ] **`MessageQueue`** (`message-queue.ts:72-74, 144-162, 218-222, 305-312`) — global + per-target depth caps; `removeTarget()` evicts both `subQueues` and `targetOrder` when sub-queue empties.
- [ ] **`FloodLimiter`** (`flood-limiter.ts:57, 115-119, 146-153`) — `MAX_WARNED_KEYS=8192` with insertion-order eviction; `reset()` on `bot:disconnected`.

### Botlink

- [ ] **`pending.ts`** — hard cap 4096 with cap-hit logging, per-entry `setTimeout` with `clearTimeout` on resolve, `drain(fallback)` for shutdown.
- [ ] **`lru-map.ts`** — cap enforced inside `set()`, evict-oldest via `keys().next().value`; promote-on-re-set uses `delete`+`set` so iteration order matches LRU.
- [ ] **`heartbeat.ts`** — `start()`/`stop()` idempotent; cleared on every disconnect path.
- [ ] **`leaf.ts` `connect()`** — explicit removal of twin `once` listeners inside each handler with comment explaining why `once` alone is insufficient.

### DCC

- [ ] **`DCCSession.clearAllTimers`** (`dcc/index.ts:869-887`) — single chokepoint for timer + listener cleanup, called from `close()` and `onClose()`. Includes explicit `socket.off('data', this.dataGuard)`.
- [ ] **`DCCManager.detach`** (`dcc/index.ts:1232-1264`) — model teardown: every resource created in `attach()` is undone here.
- [ ] **`DCCAuthTracker`** (`dcc/auth-tracker.ts:89-98, 170-187`) — `maxEntries` cap with oldest-first eviction; STALE_MS-aware sweep preserves 24h ban-escalation state.
- [ ] **`socket.setKeepAlive(true, 60_000)`** — kernel-level dead-peer detection so half-open sockets surface as `error`/`close` events.

### Stores / persistence

- [ ] **DB-backed stores with no in-memory cache** (`AdminListStore`, `BanStore`, `STSStore`) — re-query SQLite on each call. Trades tiny CPU for zero leak surface.
- [ ] **`MemoManager.detach()`** — `dispatcher.unbindAll(OWNER_ID)` is the canonical idiom for module reload safety.
- [ ] **`pruneOldModLogRows`** — first batch sync, subsequent batches via `setImmediate.unref()`. Prevents both startup blocking and event-loop pinning.

### Utils

- [ ] **`SlidingWindowCounter`** — filters timestamps in-place on every access, emergency sweep + FIFO fallback at `MAX_KEYS=8192` cap.
- [ ] **`wildcard.ts`** — `MAX_PATTERN_LEN=512` and `MAX_TEXT_LEN=4096` make the DP scan immune to plugin-supplied DoS inputs.

### chanmod (especially well-engineered)

- [ ] **`state.cycles`** (`chanmod/state.ts:104-150`) — every `setTimeout` goes through this registry; `clearAll()` cancels everything pending on teardown. Track for cancel-by-reference, schedule for fire-and-forget.
- [ ] **`pruneExpiredState` 60s tick** (`chanmod/state.ts:231-246`) — dual-tier (opportunistic inline sweep at 10K + periodic prune) on `intentionalModeChanges`, `enforcementCooldown`, `pendingRecoverCleanup`, `unbanRequested`, `cycles` locks.
- [ ] **`pendingGetKey` cap** (`chanmod/anope-backend.ts:130-159`) — `MAX_PENDING_GETKEY=64` hard cap with rejection + 10s self-removing timeout.

### ai-chat (the teardown story)

- [ ] **Provider abort plumbed end-to-end** (`ai-chat/index.ts:1097-1102`, `providers/{ollama,gemini,resilient}.ts`) — `inflightControllers: Set<AbortController>` populated per call, `delete()`-d in `finally`; `teardown()` aborts BEFORE nulling refs so a 60s Ollama call doesn't resolve against torn-down `tokenTracker`.
- [ ] **`sendLines` honors AbortSignal** (`ai-chat/assistant.ts:382-421`) — drip-fed sends cancel cleanly; `teardownController` plumbed through `pipeline`. Without this, a reload during a 5-line × 500ms response holds `ctx.reply`/`api.say` closures alive for up to 2s after unload.
- [ ] **`MessageCoalescer.teardown`** (`ai-chat/message-coalescer.ts:111-117`) — iterates pending bursts, clears each timer, then clears the Map.
- [ ] **`SessionManager` triple-bound** — per-session turn cap (40), total session cap (500) with LRU, inactivity expiry on 60s tick. Plus identity gating so nick-takeover can't inherit a session.

### Smaller plugins

- [ ] **Closure-scoped state in `init()`** (`greeter`, `help`, `topic`) — explicitly comments why scoping inside `init()` lets GC reclaim previous module's state on reload. Right pattern.
- [ ] **`enforcement.drainPending()`** (`flood/index.ts:399`) — async teardown awaits in-flight enforcement before nulling state.
- [ ] **`circuitBreaker.forget(id)`** (`rss/commands.ts:331`) — semantically distinct from `recordSuccess`; called on `!rss remove` so add/remove churn doesn't leave failure-count entries forever.

---

## Recommendations (prioritized)

### Quick wins (<5 min each)

- [x] Add `lastRateLimitOpNoticeAt.delete(ctx.channel)` to ai-chat bot-leave handlers (`plugins/ai-chat/index.ts:551-564`).
- [x] Drop redundant `cleanupStale(api, maxAgeMs)` call from `plugins/seen/index.ts` `!seen` query path.
- [x] Add `pending.timer.unref?.()` after the `setTimeout` in `src/core/dcc/index.ts:1554-1559` for consistency with surrounding code.
- [x] Use `this.server.once('error', reject)` instead of `.on(...)` at `src/core/botlink/hub.ts:155`.
- [x] Pre-empt any in-flight `pendingGhostResolver` at the top of `Services.ghostAndReclaim()`.
- [x] Add `MAX_ACTIVE_RELAYS = 256` cap to `BotLinkRelayRouter.activeRelays` mirroring sibling caps.

### Medium effort (≤30 min each)

- [x] Hoist `bot:nick-collision` handler in `src/bot.ts:573` to a named field; add `eventBus.off` to `Bot.stop()`.
- [x] Migrate the four bare `eventBus.on()` calls in `bot.ts` and `index.ts` to `trackListener('bot', ...)`.
- [x] Reorder `eventBus.on(...)` after tracking-map writes (or wrap in try/rollback) in `plugin-api-factory.ts:701-722` × 5 sites.
- [x] Add per-user `quit` bind (and non-bot `part`/`kick` branches) to `plugins/ai-chat/index.ts` for engagement / session / social-tracker / rate-limiter cleanup.
- [x] Lift `mirrorTimestamps` into `createMirrorRateLimiter()` factory; instantiate per-DCCManager.
- [x] Wire `repl:detached` event → `clearAuditTailForSession('repl')` in `modlog-commands.ts`.
- [x] Add periodic `pruneIdle` timer (or botlink-leaf-disconnect hook) for `.modlog` pagers in `modlog-commands.ts`.
- [x] ~~Delete from `importedOnce` in `PluginLoader.unload()`; gate cache-bust on file mtime.~~ N/A — `importedOnce` and the cache-busting `.reload` were deleted in the live-config refactor.
- [x] Splice auto-disabled timer binds from `dispatcher.binds[]` (or add `disabled: true` flag with `listBinds` filter).

### Architectural (design changes)

- [x] Add `unloadAll()` to `PluginLoader`; call from `Bot.shutdown()`. (already RESOLVED above)
- [x] Lower `BotEventBus.setMaxListeners` from 50 to 20; instrument per-event counts at thresholds (10/20/30).
- [x] Add `MAX_CHANNELS` cap with LRU eviction to `ai-chat/context-manager.ts` and `ai-chat/rate-limiter.ts:ambientChannelWindows`. Or wire `ContextManager.pruneAll()` to the existing 60s sweep.
- [x] Add `Logger.sinkCount()` metric and a runtime warning at threshold; consider named-sink registry so the plugin loader can audit ownership.
- [x] Add per-plugin bind cap (1000 with warning at 500) to `EventDispatcher`.
- [x] ~~Document `.reload` reload-counter strategy and consider per-plugin Worker threads for plugins that must reload often.~~ N/A — `.reload` was deleted in the live-config refactor.
