# Memory Leak Audit: full codebase

**Date:** 2026-04-19
**Scope:** Every `.ts` file under `src/` and `plugins/` (excluding `node_modules`, `dist`, test fixtures).
**Estimated risk:** **Medium** — two CRITICAL findings, both with bounded blast radius; a large number of WARNING-level items that are mostly defensive or operator-driven slow leaks.

## Summary

hexbot's leak hygiene is better than typical long-running Node code — the plugin loader's teardown contract, the `ListenerGroup` pattern, and bounded-collection conventions (`SlidingWindowCounter`, `LRUMap`, explicit TTL sweeps) are applied consistently. The audit found **2 CRITICAL**, **33 WARNING**, and **many INFO** items across 11 concern areas.

The two CRITICAL items are both realistic-but-bounded:

1. **ESM module cache growth on every plugin reload** (`plugin-loader.ts`). Each `.reload` adds a fresh `?t=<timestamp>` URL to Node's internal loader map, which never evicts. After hundreds of reloads the old module graphs (code, constants, closures) are retained for the life of the process. At hexbot's deployment pattern (operator-driven reloads, not automation) this is bounded-per-operator-action, not per-message — so it's tolerable but should be surfaced to operators.
2. **ai-chat provider calls not aborted on teardown** (`plugins/ai-chat/index.ts:1040`). A reload during an in-flight Ollama/Gemini request orphans a 60-second TCP fetch, its AbortController, and the entire prompt/context closure. Bounded by reload frequency × concurrent requests; worst case during rapid dev-reload loops.

A typical production bot running 24/7 without frequent reloads would likely survive months without hitting either CRITICAL. Operator-driven or debug-loop workflows are the failure mode.

**Findings:** 2 CRITICAL, 33 WARNING, ~35 INFO (clean patterns + minor observations)

## Phase checklist

- [x] Hot-reload machinery (plugin-loader, dispatcher, event-bus, plugin-api-factory)
- [x] Core connection layer (bot, irc-bridge, reconnect-driver, connection-lifecycle, process-handlers, command-handler, repl)
- [x] Core state tracking (channel-state, channel-settings, ban-store, admin-list-store, memo, mod-log, services, permissions, database)
- [x] Botlink subsystem (23 files)
- [x] DCC subsystem (8 files + dcc-console-commands)
- [x] Core commands and utils (34 files)
- [x] ai-chat plugin (20 files)
- [x] chanmod plugin (22 files)
- [x] rss plugin (7 files)
- [x] flood plugin (4 files)
- [x] Small plugins (seen, 8ball, greeter, help, topic, ctcp)

---

## Findings

### [CRITICAL] ESM module cache grows unboundedly on every reload

- [ ] **File:** `src/plugin-loader.ts:698-706` (`importWithCacheBust`)
- **Category:** reload-residue
- **Growth rate:** +1 distinct module instance per `.reload <plugin>`, retained for process lifetime
- **Description:** `importWithCacheBust` appends `?t=<timestamp>` to force Node's ESM loader to fetch a fresh copy on reload. Node keys its internal module map by the full URL; each distinct timestamp creates a distinct key that is never evicted.
- **Evidence:**
  ```ts
  const fileUrl = pathToFileURL(absPath).href + `?t=${ts}`;
  return (await import(fileUrl)) as Record<string, unknown>;
  ```
- **Impact:** Each reload retains the old module's top-level code, string constants, and transitive dependency closures. 500 reloads of ai-chat over a month = 500 copies of its module graph alive. No public Node API to evict ESM loader entries.
- **Remediation:** (a) Document as a known bounded-per-operator-action cost; (b) track reload count per plugin and surface in `.plugins`; (c) consider emitting a warning when a plugin has been reloaded >N times in one process; (d) true fix would be a Worker-per-plugin architecture — out of scope.

### [CRITICAL] ai-chat provider in-flight requests not cancelled on teardown

- [x] **File:** `plugins/ai-chat/index.ts:1040-1066` (`teardown()`)
- **Category:** stream-leak + reload-residue
- **Growth rate:** One orphaned TCP fetch + timer + captured prompt closure per reload while a provider call is in flight
- **Description:** `teardown()` sets `provider = null` but does not abort or await outstanding `provider.complete()` calls. Ollama's `fetchJson` holds an AbortController with a 60s timeout; Gemini's `withTimeout` holds a 30s timer. Reload leaves those running against the old captured refs; when they resolve they touch torn-down `tokenTracker`/`rateLimiter`/`semaphore` instances.
- **Remediation:** Add a plugin-level AbortController and call `provider.abort?.()` in teardown; make teardown async-aware so the loader can await drain up to a ceiling.

---

### [WARNING] Hot-reload / plugin API

- [ ] **W-1.** `plugin-api-factory.ts:178-252` — `wrappedHandlers` array in scoped plugin api has no dedup; repeated `bind()` of the same `(handler, type, mask)` creates dead entries that `unbind()` can't find.
- [x] **W-2.** `dispatcher.ts:250-259` — `unbind()` uses case-sensitive mask comparison, but `bind()` uses `caseCompare(...)`. Case-varied unbinds silently no-op, leaving bind + timer resident until process exit.
- [ ] **W-3.** `dispatcher.ts:221-246` — Timer closures capture `entry` and `handler`; if `unbindAll` fires while a timer callback is mid-flight, the returned promise pins the old plugin closure. Add a `disposed` flag checked on each timer fire.
- [ ] **W-4.** `dispatcher.ts:221-245` — Plugin `setInterval` timers are not `.unref()`'d, so outstanding plugin timers block graceful shutdown.
- [x] **W-5.** `event-bus.ts` — `BotEventBus extends EventEmitter` with no `setMaxListeners()` call. With 4+ plugins subscribing to `user:added`/`user:flagsChanged`/`user:hostmaskAdded`, Node's default 10-listener cap triggers misleading warnings. Set to 50 explicitly (not Infinity).
- [ ] **W-6.** `plugin-api-factory.ts:819-821` — `channelSettings.onChange` plugin callbacks rely on `offChange(pluginId)` to drain ALL callbacks for that plugin; verify the method is per-plugin not per-callback, add test.
- [ ] **W-7.** `plugin-api-factory.ts:337-339` — `wrapApiMethods` guards only one sub-API level deep. If any future sub-API adds nested objects, their methods escape the dispose guard.
- [ ] **W-8.** `plugin-loader.ts:154, 699-702` — `importedOnce` Set never shrinks, even when a plugin is deleted from disk. Bounded by on-disk plugin count; informational.

### [WARNING] Core connection layer

- [ ] **W-9.** `src/index.ts:153-211` — Four module-level `process.on()` handlers (`SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection`) have no symmetric removal. Acceptable for a single-entry-point process; fragile if the module is ever re-imported (test harness).
- [ ] **W-10.** `src/core/connection-lifecycle.ts:196-217` — Inner `setTimeout(..., SOCKET_DESTROY_GRACE_MS).unref()` for forced socket destroy is not tracked by `ListenerGroup`; can't be cancelled during shutdown. `.unref()` mitigates but closure still captures `client` + `logger`.
- [x] **W-11.** `src/bot.ts:665` — `await new Promise<void>((r) => setTimeout(r, 500))` in shutdown is not tracked; a second `shutdown()` call stacks another 500ms wait. Add an `isShuttingDown` guard.
- [ ] **W-12.** `src/bot.ts:585-592` (`wireMemoDccNotify`) — Monkey-patches `DCCManager.onPartyJoin` by chaining `prev ← new` without an unwind. Called once today; a second call stacks wrappers unboundedly.
- [x] **W-13.** `src/irc-bridge.ts:93` (`ctcpRateLimiter`) — `SlidingWindowCounter` caps at 8192 keys but has no scheduled sweep on the bridge instance; under CTCP flood from unique hostmasks the map reaches cap before emergency sweep fires. Add `setInterval(sweep, WINDOW_MS)` tracked for detach.
- [x] **W-14.** `src/bot.ts:523-525` — Anonymous `eventBus.on('user:removed', ...)` listener has no captured reference; can't be removed. Also **redundant** with `DCCManager`'s own `user:removed` handler (`src/core/dcc/index.ts:1185-1198`), which does properly track and remove. Recommendation: delete the `bot.ts` listener entirely.
- [ ] **W-15.** `src/bot.ts:311-313` — `eventBus.on('bot:disconnected', ...)` anonymous arrow in `Bot` constructor; same class as W-14. Bounded by single-Bot-per-process.
- [ ] **W-16.** Nowhere in core does a `setMaxListeners()` call exist — this is the **right** outcome, called out to warn against future masking fixes.

### [WARNING] Core state tracking

- [ ] **W-17.** `src/core/services.ts:360-382` — NickServ "unknown command" retry path iterates `this.pending`; if services send a stray reply while no entry is pending, the orphan-retry branch fires an outbound STATUS/ACC with no waiter. Bounded by malformed replies; not a map-growth leak, but a silent outbound message leak.
- [ ] **W-18.** `src/core/channel-presence-checker.ts:88` — `permanentFailureChannels` is only pruned when the bot successfully rejoins the same channel. Channels removed from the configured list mid-session leak until disconnect (which does clear). Sweep based on current config set each tick.
- [x] **W-19.** `src/core/channel-settings.ts:147-158` — `onChange(pluginId, cb)` appends without dedup. A plugin's `init()` called N times during a reload retry loop accumulates N copies of the same callback. Add identity dedup.
- [ ] **W-20.** `src/core/memo.ts:116` — `deliveryCooldown.delete` via `user:removed` only wires if `eventBus` is provided. Make `eventBus` required or log a warning at `attach()` when null.
- [x] **W-21.** `src/core/channel-presence-checker.ts:120` — Returned `setInterval` handle is not `.unref()`'d. If any reconnect path ever forgets to `clearInterval`, the captured graph (`configuredChannels`, `retrySchedule`, etc.) pins indefinitely. Defensive fix: call `.unref()` before returning.
- [ ] **W-22.** `src/core/permissions.ts:353-370` — `findByHostmask`/`checkFlags` has no cache. O(users × patterns) per inbound message. Not a leak; called out because the audit asked about caches — there are none, by design.

### [WARNING] Botlink subsystem

- [ ] **W-23.** `src/core/botlink/protocol.ts:211-220` — Socket `'close'`/`'error'` listeners are never removed; rely on socket GC. Pair with their sibling `socket.off` calls for symmetry.
- [x] **W-24.** `src/core/botlink/protocol.ts:246-251` — `BotLinkProtocol.close()` doesn't null `onFrame`/`onClose`/`onError`, leaving captured hub/leaf state pinned until the protocol object is GC'd. Add `this.onFrame = null; this.onClose = null; this.onError = null;` after destroy.
- [ ] **W-25.** `src/core/botlink/auth.ts:120` — `pendingHandshakes` Map caps the counter value per IP but not the number of IP keys. `releasePending()` currently drains every exit path, but a distributed scanner can briefly fill the map. Add periodic sweep for orphaned entries.

### [WARNING] DCC subsystem

- [x] **W-26.** `src/bot.ts:523-525` (dup of W-14) — Anonymous listener **and** redundant with DCCManager's own handler. Deleting the bot.ts listener is the cleanest fix.

### [WARNING] Core commands and utils

- [x] **W-27.** `src/core/commands/modlog-commands.ts:78, 92` — Module-level `pagers` and `tailListeners` Maps. `pagers` has a 30-min idle sweep; `tailListeners` has **no idle sweep**. A REPL `.audit-tail on` that exits without `.audit-tail off` leaks the listener + captured `CommandContext` until process exit. **Resolution:** no code change needed. `.audit-tail` is REPL-only and enforced at the source-check (`if (ctx.source !== 'repl')`), and the REPL is a single process-scoped session bound to `process.stdin` — there is no per-session disconnect path to hook, and `tailListeners` is bounded to one entry (`'repl'`). `shutdownModLogCommands()` drains the listener on `Bot.shutdown`. Adding an idle-timeout sweep would break the operator UX (walk away for 30 min, come back to silently-stopped tail). Documented as bounded-by-design rather than a growth leak.
- [x] **W-28.** `src/core/flood-limiter.ts:79, 137-138` — `warned` Set has no hard cap; only cleared by the 5-minute sweep, which only fires on the hot path after `SWEEP_INTERVAL_MS` has elapsed. Idle bot → set persists at peak until next flood event. Cap at 8192 (same as underlying counter) or clear alongside counter sweep.

### [WARNING] ai-chat plugin

- [x] **W-29.** `plugins/ai-chat/assistant.ts:378-401` (`sendLines`) — Recursive `setTimeout` chain for multi-line output is not tracked; can't be cleared on teardown. Old `ctx.reply` captures survive reload. Track timers in a Set, clear in teardown.
- [x] **W-30.** `plugins/ai-chat/ambient.ts:86-118, 126-197` — `ambientEngine.stop()` clears the interval but doesn't cancel in-flight sender callbacks. Registered senders capture `provider`, `rateLimiter`, etc. from init time. Add a "still running" flag checked at await boundaries.
- [ ] **W-31.** `plugins/ai-chat/index.ts:400-483` (sender closure) — The ambient sender captures module-level refs; on reload, pending invocations run against the old instances. Partially mitigated by nulling module vars in teardown; doesn't fully prevent orphan work.

### [WARNING] rss plugin

- [x] **W-32.** `plugins/rss/circuit-breaker.ts:22-24` + `plugins/rss/commands.ts:287-289` — `CircuitBreaker` state (`failureCount`, `backoffUntil`, `brokenNotified`) is NOT cleared when a feed is removed via `!rss remove`. State accumulates per `!rss add`/`!rss remove` cycle with unique ids. Add `circuitBreaker.recordSuccess(id)` (or dedicated `forget(id)`) to `handleRemove`.
- [ ] **W-33.** `plugins/rss/index.ts:178-202` — `RssCommandsDeps` snapshots `parser` and `cfg` at `init()`. Today the whole deps object dies when the bind is dropped on reload, but a future refactor that reuses the handler outside the bind lifecycle would leak. Use getters or rebuild deps per-handler.

---

## INFO findings (selected)

Not broken out in detail — see the per-area agent outputs in conversation context. Highlights:

- [ ] **I-1.** `src/utils/sliding-window.ts:11, 39-54` — `SlidingWindowCounter` has `MAX_KEYS=8192` with emergency sweep + FIFO eviction. Reference implementation for bounded per-key state.
- [ ] **I-2.** `src/core/message-queue.ts` — `MAX_DEPTH=500` enforced on enqueue; drain timer `.unref()`'d; `start()` calls `stop()` first so double-start doesn't leak. Exemplary.
- [ ] **I-3.** `src/utils/listener-group.ts:23-67` — Constructor validates target has `removeListener`/`off`; per-entry try/catch in `removeAll()`. This is the pattern used by `channel-state`, `services`, `connection-lifecycle`. Getting it right matters — and it's right.
- [ ] **I-4.** `src/core/botlink/pending.ts` — `PendingRequestMap` cap (4096) + `setTimeout` deterministic drain + `drain()` on every teardown path. No stuck entries possible.
- [ ] **I-5.** `src/core/botlink/lru-map.ts:41-50` — Correct insertion-order FIFO eviction on `set`. Note: `get()` does NOT promote — document this contract.
- [ ] **I-6.** `src/core/dcc/index.ts:868-886` — `DCCSession.clearAllTimers` explicitly `socket.off('data', this.dataGuard)` to release closure capture. Pattern worth copying.
- [ ] **I-7.** `src/core/channel-state.ts:323-334` — `networkAccounts` entry deleted when a user leaves every tracked channel. Per-JOIN safety verified.
- [ ] **I-8.** All `plugins/chanmod/*.ts` — Every `setTimeout` is tracked in a cleanup Set; `clearSharedState()` runs last as belt-and-braces. Unusually hardened.
- [ ] **I-9.** `plugins/ai-chat/*` — Every in-memory collection has a hard cap, TTL sweep, and `clear()` in teardown (`SessionManager`, `ContextManager`, `SocialTracker`, `EngagementTracker`, `RateLimiter`). Well-engineered except for provider abort (CRITICAL).
- [ ] **I-10.** `plugins/rss/*` — `abortController` lifecycle, `interruptibleSleep` listener cleanup, and `MAX_SEEN_PER_FEED` cap all correct.
- [ ] **I-11.** `plugins/seen/index.ts` — Dual sweeps: age (90 days) and size (10,000 entries). DB-backed; no in-memory state.
- [ ] **I-12.** `src/core/commands/modlog-commands.ts` — Pager has idle sweep; export `shutdownModLogCommands()` drains on bot shutdown.
- [ ] **I-13.** `plugins/flood/enforcement-executor.ts:39, 187-195` — `offenceTracker` capped at 2000 with FIFO eviction + 60s sweep.

## Leak-free patterns worth preserving

The following are **not findings** — they are the reason the audit turned up so few critical items. Preserve these conventions:

- **Everything goes through `api.bind()`**, and the plugin loader's `dispatcher.unbindAll(pluginName)` auto-removes binds on unload. No plugin uses raw `client.on()`/`setInterval` directly.
- **`ListenerGroup`** is used for every place where core code attaches listeners to long-lived emitters. Its constructor refuses targets that don't expose `off`/`removeListener` — a crucial defensive invariant.
- **`SlidingWindowCounter` + `LRUMap`** for every bounded-collection-with-TTL need. Instances capped at 8192 and 10000 respectively.
- **Init-scoped, not module-scoped**, for plugin state Maps (`cooldowns` in help, `previewCooldown` in topic, `joinRates` in greeter). Reload drops the old Map automatically.
- **Explicit `dispose` contract** in `plugin-api-factory.ts:300-306` (`wrapApiMethods`) — stale closures holding the api after unload short-circuit to `undefined`. Single most important memory-safety mechanism in the codebase.
- **`clearSharedState(state)` last in chanmod teardown** as belt-and-braces against earlier teardown steps throwing.
- **`DCCSession.teardownSession`** as single choke-point converging every close path; guarantees socket destroy + store removal + timer clear + party-part emit.
- **`Bot.connect()` idempotency guard** at `src/bot.ts:709-717` — tears down prior `reconnectDriver` and `lifecycleHandle` before creating new ones, preventing stacking on repeated `connect()` calls.

## Recommendations

### Quick wins (< 5 min each)

- [x] Delete `src/bot.ts:523-525` (W-14/W-26) — the anonymous `user:removed` listener is redundant with DCCManager's.
- [x] Add `caseCompare(b.mask, mask, this.casemapping)` to `dispatcher.unbind()` (W-2).
- [x] Set `this.setMaxListeners(50)` in `BotEventBus` constructor with a comment (W-5).
- [x] Null `onFrame`/`onClose`/`onError` in `BotLinkProtocol.close()` (W-24).
- [x] `.unref()` the `channel-presence-checker` setInterval return value (W-21).
- [x] Add `isShuttingDown` guard to `Bot.shutdown()` and remove the untracked 500ms wait (W-11).
- [x] Add identity dedup to `ChannelSettings.onChange` (W-19).
- [x] In rss `handleRemove`, call `circuitBreaker.recordSuccess(id)` (W-32).

### Medium effort (refactoring needed)

- [x] Track ai-chat `sendLines` setTimeouts in a Set; clear in teardown (W-29). (Implemented via an AbortSignal parameter on `sendLines`/`sendLinesGated` and a plugin-level `teardownController`.)
- [x] Add a cancellation flag to ai-chat ambient sender; check at await boundaries (W-30). (Same `teardownController` — ambient sender checks `signal.aborted` before init work and after each `await`.)
- [x] Cap ai-chat provider calls with an AbortController; abort in teardown; make teardown async-aware (**CRITICAL #2**). (`abort()` added to `AIProvider`; Ollama tracks inflight controllers, Gemini rejects outer withTimeout; plugin teardown calls `provider.abort?.()` before nulling state refs. Async-aware teardown not included — bounded-blast-radius by abort alone.)
- [ ] Replace `bot.ts` `wireMemoDccNotify` monkey-patch with an explicit subscribe API on `DCCManager` (W-12).
- [x] Add periodic sweep to `modlog-commands` `tailListeners` OR wire disconnect-driven cleanup (W-27). (No code change — `.audit-tail` is REPL-only and REPL is process-scoped; Map bounded to 1 entry, drained at shutdown. Documented as bounded-by-design.)
- [x] Cap `FloodLimiter.warned` Set at 8192 (match counter) or clear alongside counter sweep (W-28).
- [x] Add periodic sweep to `irc-bridge.ctcpRateLimiter` (W-13).

### Architectural (design changes needed)

- [ ] Track per-plugin reload count and surface in `.plugins` output; warn operators when a plugin has been reloaded N+ times (mitigates **CRITICAL #1**).
- [ ] Long-term: investigate Worker-per-plugin to actually evict old module graphs from the ESM loader cache (**CRITICAL #1** true fix).
- [ ] Make plugin `teardown()` able to return a Promise so the loader awaits provider drain + in-flight cleanup.
- [ ] Add a lint or test invariant: every sub-API that takes `pluginId` must have a corresponding cleanup call in `plugin-loader.cleanupPluginResources` (W-6).

## Files and lines by area

| Area                    | Critical | Warning | Info    |
| ----------------------- | -------- | ------- | ------- |
| Hot-reload machinery    | 1        | 8       | 5       |
| Core connection layer   | 0        | 8       | 13      |
| Core state tracking     | 0        | 6       | 11      |
| Botlink subsystem       | 0        | 3       | 12      |
| DCC subsystem           | 0        | 1       | 3       |
| Core commands and utils | 0        | 2       | 5       |
| ai-chat plugin          | 1        | 3       | 10      |
| chanmod plugin          | 0        | 0       | 21      |
| rss plugin              | 0        | 2       | 6       |
| flood plugin            | 0        | 0       | 3       |
| Small plugins           | 0        | 0       | 7       |
| **Total**               | **2**    | **33**  | **~96** |
