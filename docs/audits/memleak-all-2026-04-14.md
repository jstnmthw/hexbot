# Memory Leak Audit: whole codebase

**Date:** 2026-04-14
**Scope:** every `.ts` file under `src/` and `plugins/` (77 source files, 12 parallel scan agents)
**Estimated risk:** **Medium-High** — three CRITICAL findings in `plugins/flood/` and `plugins/chanmod/index.ts` that can be exploited under botnet-scale attack or by a future refactor; the rest of the codebase is notably disciplined, with exemplary teardown patterns in botlink, DCC, and the connection lifecycle.

## Summary

Hexbot is, overall, a well-hardened long-running IRC bot. The core modules (`ListenerGroup`, `PendingRequestMap`, `RateCounter`, `SlidingWindowCounter` in `src/utils/`, the dispatcher's timer bookkeeping, and the connection lifecycle) are all leak-safe by construction, and the bot architecture deliberately registers listeners **once at startup** rather than per reconnect — sidestepping the single most common IRC-bot leak class by construction.

The worst findings are in the **flood plugin**: `plugins/flood/sliding-window.ts` (a separate, newer implementation from the leak-safe `src/utils/sliding-window.ts`) has no max-entry cap, and `handleMsgFlood` keys rate limits by nick rather than hostmask — so a botnet nick-rotation attack can balloon the tracker linearly with attack traffic between 60-second sweeps. Under a modest 10k-bot flood the plugin can plausibly allocate tens of thousands of `Array<number>` entries before the next sweep runs. A long-running bot with an unmaintained chanmod reload also risks closure-chain retention of per-channel state via an Atheme `onRecoverCallback` that is never nulled on teardown.

On the positive side: no leaks were found in plugin-loader, dispatcher, irc-bridge, channel-state, ban-store, database, message-queue, reconnect-driver, services (with one polish item), connection-lifecycle (with one polish item), or in any `utils/` module. Every `setInterval` in the codebase has a captured handle and a cleanup path. No `setMaxListeners(0)` anywhere (verified ripgrep).

**Findings: 3 critical, 34 warning, 26 info** (plus ~40 leak-free patterns confirmed). BotLink INFO-5 (`relay-handler.ts sessions` leaf-disconnect cleanup) was verified and dismissed — the cleanup hook is present in `bot.ts:570-581`.

**Open design questions resolved 2026-04-14** (see remediation notes on C1 and W-PS1 below):

- **C1** — delete `plugins/flood/sliding-window.ts`, reuse `src/utils/sliding-window.ts` as the single source of truth for the primitive.
- **W-PS1** — null plugin API methods after `teardown()` so a retained `api` closure cannot fan out to core state.

**Projected time-to-problem under normal traffic:** weeks to months. **Under a sustained botnet attack:** minutes to hours for the flood plugin's SlidingWindowCounter to grow past practical memory.

---

## Scan phases (all complete)

- [x] Plugin system (loader, api-factory, dispatcher)
- [x] Bot orchestration (bot, irc-bridge, event-bus, command-handler, index, logger, process-handlers, repl, config)
- [x] Core state modules (channel-state, channel-settings, ban-store, permissions, database, help-registry, isupport, memo, sts, owner-bootstrap, audit)
- [x] Connection lifecycle (reconnect-driver, connection-lifecycle, services, close-reason-classifier, message-queue, password)
- [x] BotLink subsystem (15 files under `src/core/botlink/`)
- [x] DCC subsystem (5 files under `src/core/dcc/`)
- [x] Core command handlers (11 files under `src/core/commands/`)
- [x] Utils modules (14 files under `src/utils/`)
- [x] Chanmod plugin (24 files)
- [x] Flood plugin (5 files)
- [x] RSS plugin (5 files)
- [x] Small plugins (8ball, greeter, help, seen, topic, ctcp)

---

## CRITICAL findings

### [CRITICAL] C1 — `plugins/flood/sliding-window.ts` has no max-entry cap (botnet amplifier)

- [x] **File:** `plugins/flood/sliding-window.ts:5-14` — **Fixed 2026-04-14:** deleted `plugins/flood/sliding-window.ts`; `rate-limit-tracker.ts` now imports from `../../src/utils/sliding-window`.
- **Category:** unbounded collection
- **Growth rate:** one entry per unique `nick@channel` / `join:<hostmask>` / `part:<hostmask>` / `nick:<hostmask>` per sliding window — permanent until the periodic 60s sweep runs
- **Description:** This is a _separate_ SlidingWindowCounter implementation from the leak-safe one in `src/utils/sliding-window.ts` (which caps at 8192 keys and has an emergency inline sweep). The flood plugin's copy has a plain `Map<string, number[]>` with no size cap and no emergency sweep — it relies entirely on the 60s `time` bind in `plugins/flood/index.ts:277` to prune.
- **Evidence:**
  ```ts
  private windows = new Map<string, number[]>();
  check(key: string, windowMs: number, limit: number): boolean {
    ...
    timestamps.push(now);
    this.windows.set(key, timestamps);
  ```
- **Impact:** Under a 10k-bot join flood in a 60-second window the counter allocates 10k `join:*` entries plus 10k `part:*` entries plus up to 10k `nick:*` entries — 30k `Array<number>` allocations minimum, held for up to 60s. Because the `ident` field is user-controlled, a spoof-ident attacker can multiply entries beyond the real host count. Sustained multi-minute attacks accumulate beyond the sweep cadence and a pathological attack can OOM the process.
- **Remediation (decided 2026-04-14):** **Delete `plugins/flood/sliding-window.ts` and have `rate-limit-tracker.ts` import `SlidingWindowCounter` from `src/utils/sliding-window.ts`.** The utils version already has `MAX_KEYS = 8192` + emergency inline sweep + FIFO eviction and is the project's canonical primitive. Single source of truth prevents future divergence. Verify the utils version's API matches the flood plugin's call sites (`check(key, windowMs, limit)`, `sweep(windowMs)`, `reset()`) before deleting.

### [CRITICAL] C2 — `plugins/flood/index.ts` keys message-flood tracking by nick, allowing rotation amplification

- [x] **File:** `plugins/flood/index.ts:127` — **Fixed 2026-04-14:** `handleMsgFlood` now keys by `msg:<hostmask>@<channel>`; `EnforcementExecutor.offenceTracker` has a 2000-entry insertion-order LRU cap.
- **Category:** unbounded collection (amplification of C1)
- **Growth rate:** one offence entry per `nick@channel` per nick change, retained for `offenceWindowMs` (5 min default)
- **Description:** The join, part, and nick-change handlers already key by hostmask (leak-safe), but `handleMsgFlood` still keys by `${api.ircLower(ctx.nick)}@${api.ircLower(channel)}`. An attacker rotating nicks across 10k bots mints 10k fresh offence-tracker entries without ever touching the previous keys, all of which live in `EnforcementExecutor.offenceTracker` for the full 5-minute window. Combined with C1, this is the attack multiplier.
- **Evidence:**
  ```ts
  const key = `${api.ircLower(ctx.nick)}@${api.ircLower(channel)}`;
  if (!rateLimits.check('msg', key)) return;
  const action = enforcement.recordOffence(key);
  ```
- **Impact:** `EnforcementExecutor.offenceTracker` at `plugins/flood/enforcement-executor.ts:28` is also an uncapped `Map`. A minute of nick-rotation flooding can populate it to the same cardinality as C1 and keep those entries alive for 5× longer.
- **Remediation:** Rekey `handleMsgFlood` to use hostmask (same pattern as the join/part/nick handlers). Also add a hard cap on `EnforcementExecutor.offenceTracker` (e.g. 2000 entries, LRU eviction when exceeded).

### [CRITICAL] C3 — Chanmod `onRecoverCallback` never nulled on teardown (Atheme backend)

- [x] **File:** `plugins/chanmod/index.ts:66-68` + `plugins/chanmod/atheme-backend.ts:120` — **Fixed 2026-04-14:** Atheme branch now pushes a teardown nulling `backend.onRecoverCallback`; `clearSharedState(state)` helper added to `state.ts` and registered as the last teardown.
- **Category:** reload residue / closure capture
- **Growth rate:** one orphaned closure per chanmod reload when `chanserv_services_type === 'atheme'`
- **Description:** The plugin sets `backend.onRecoverCallback = (channel) => state.pendingRecoverCleanup.set(...)` at init, but `teardown()` never nulls this reference. Today this is benign because nothing retains the backend instance outside `init()`'s lexical scope — the closure graph becomes GC-eligible when the plugin module is unloaded. **But** it is fragile: a single future refactor that keeps the backend alive (e.g., a `chain.getBackends()` accessor for diagnostics) converts this into a permanent retention of the old `state` object (six `Map`s/`Set`s of per-channel history) across every reload.
- **Evidence:**
  ```ts
  backend.onRecoverCallback = (channel: string) => {
    state.pendingRecoverCleanup.set(api.ircLower(channel), Date.now() + PENDING_STATE_TTL_MS);
  };
  ```
- **Impact:** Today: none (GC-eligible). After a refactor that retains backend references: one full `ChanmodState` object retained per reload, containing `pendingRecoverCleanup`, `lastKnownModes`, `unbanRequested`, `splitOpsSnapshot`, `threatScores`, `takeoverWarnedChannels`, and `knownGoodTopics` — potentially thousands of entries each on a populated deployment.
- **Remediation:** (1) add `teardowns.push(() => { backend.onRecoverCallback = undefined; });` in the Atheme branch of `init()`; (2) add a single `teardowns.push(() => clearSharedState(state))` helper that nulls every `Map`/`Set` on `state` — belt-and-braces so no lingering closure can pin the whole per-channel history graph.

---

## WARNING findings (grouped by subsystem)

### Plugin system (`src/plugin-loader.ts`, `src/plugin-api-factory.ts`, `src/dispatcher.ts`)

- [x] **W-PS1 — ESM module cache retention.** **Fixed 2026-04-14** (`createPluginApi` returns `{ api, dispose }`; `wrapApiMethods` guards every top-level and sub-API method against a `disposed` cell; `plugin-loader.unload()` calls `dispose()` after teardown). `plugin-loader.ts:568-610` uses a `.reload-<ts>-*.ts` trick to bypass Node's ESM cache, but Node has no "drop module" API, so every reload leaves the prior module graph resident. Any plugin with module-level mutable state (`const state = new Map()` at file top) is a permanent retention leak on reload. This is the single architectural hazard that amplifies every other plugin-side finding. **Fix (decided 2026-04-14):** **Null plugin API methods post-teardown.** After `teardown()` completes in `plugin-loader.unload()`, iterate the frozen `api` object and replace each method with a no-op (or wrap each method in a thin `disposed`-flag check). This turns every plugin teardown bug from a permanent retention leak into a bounded one — even if a plugin's old closure still holds `api`, the closure can no longer fan out to the dispatcher, database, bot config, or IRC client. Since `Object.freeze(api)` currently blocks reassignment, the implementation will need each API method to be a thin indirection that checks a `disposed` flag set on teardown.
- [x] **W-PS2 — `onModesReady` / `onPermissionsChanged` have no plugin-facing removal API.** **Fixed 2026-04-14** (`offModesReady`/`offPermissionsChanged` added to PluginAPI; per-callback→wrapper maps in the channel-state factory). `plugin-api-factory.ts:519-542` lets plugins subscribe but offers no `offModesReady` / `offPermissionsChanged` — a plugin that subscribes from a per-message handler leaks linearly with IRC traffic. Also, the per-plugin listener maps are hand-rolled instead of using `ListenerGroup` (the shared primitive). **Fix:** expose `offModesReady`/`offPermissionsChanged`, migrate bookkeeping to `ListenerGroup`.
- [x] **W-PS3 — Partial-init cleanup drift.** **Fixed 2026-04-14** (shared `cleanupPluginResources(pluginName, disposeApi)` helper used by both `load()` init-catch and `unload()`). `plugin-loader.ts:336-368` (init-catch) and `:388-443` (unload) are two hand-copied cleanup recipes. They agree today but there is no shared helper; any future subsystem added to one and forgotten in the other leaks on failed-init. **Fix:** factor a single private `cleanupPluginResources(pluginName)` helper.

### Bot orchestration (`src/bot.ts`, `src/event-bus.ts`)

- [x] **W-BO1 — `BotEventBus` has no listener cap or per-owner registry.** **Fixed 2026-04-14** (`trackListener(owner, event, fn)` + `removeByOwner(owner)` on BotEventBus; called from plugin-loader cleanup). `event-bus.ts:59-85` extends `EventEmitter` without a cap or accounting. Plugins subscribe via `plugin-api-factory.ts:524-537` and the only defense against reload residue is the plugin's own teardown discipline. **Fix:** add `trackListener(owner, event, fn)` / `removeByOwner(owner)` to `BotEventBus`, call `removeByOwner(pluginId)` from `PluginLoader.unload()`.
- [x] **W-BO2 — `bot.ts:shutdown()` ordering is fragile.** **Fixed 2026-04-14** (each teardown step wrapped in `step()` helper with per-step try/catch and logged error). `bot.ts:618-679` runs teardown steps sequentially without per-step try/catch. If any upstream subsystem's `close()` / `detach()` throws, every downstream step is skipped — `memo.detach()`, `bridge.detach()`, `messageQueue.stop()`, and `db.close()` are all conditionally reachable. **Fix:** wrap each subsystem teardown in its own try/catch, or collect cleanup closures into an array and loop swallowing errors per-step.

### Core state (`src/core/memo.ts`)

- [x] **W-CS1 — `memo.ts` `deliveryCooldown` Map not pruned on `user:removed`.** **Fixed 2026-04-14** (memo `attach()` subscribes to `user:removed`, `detach()` unsubscribes). `memo.ts:102,347-351` — bounded by the admin set in practice (so not a runtime leak), but it is the only map in the core state audit that doesn't have a cleanup path tied to user lifecycle events. **Fix:** subscribe to `eventBus.on('user:removed', handle => this.deliveryCooldown.delete(handle.toLowerCase()))` in `attach()`.

### Connection lifecycle (`src/core/connection-lifecycle.ts`, `src/core/services.ts`)

- [x] **W-CL1 — `presenceTimer` not cleared in `onClose`.** **Fixed 2026-04-14.** `connection-lifecycle.ts:192-193` — the interval keeps running during long rate-limited backoffs (up to 30 min per attempt), logging "Not in configured channel X" for every configured channel every `channel_rejoin_interval_ms`. Noisy, not leaky. **Fix:** clear `presenceTimer` in `onClose` alongside `registrationTimer`.
- [x] **W-CL2 — Pending NickServ verifies not cancelled on disconnect.** **Fixed 2026-04-14** (`services.cancelPendingVerifies('disconnected')` called from `onReconnecting`). `services.ts:88-97` + `connection-lifecycle.ts:225-231` — if the connection drops mid-verification, the pending Promise ages out to a misleading `nickserv-verify-timeout` audit row instead of failing fast with "disconnected." **Fix:** add `services.cancelPendingVerifies('disconnected')` and call it from `onClose` before `messageQueue.clear()`.

### DCC subsystem (`src/core/dcc/index.ts`, `auth-tracker.ts`)

- [x] **W-DCC1 — Anonymous `socket.on('data')` line-length guard never removed on close.** **Fixed 2026-04-14** (`dataGuard` stored as class field, detached in `clearAllTimers`). `dcc/index.ts:411-423` (`attachLineLengthGuard`) installs a closure that captures the entire session instance and is only GC'd when the socket is destroyed. **Fix:** store the handler as a named method reference and `socket.off('data', this.dataGuard)` in `clearAllTimers()`.
- [x] **W-DCC2 — Two `on('error')` listeners coexist per session.** **Fixed 2026-04-14** (`openSession` pre-start error handler changed to `.once`). `dcc/index.ts:1390-1392` + `:384/487` — `openSession` attaches an error listener to cover the pre-`start()` window but never removes it once `start()` runs. Both listeners live for the session lifetime. **Fix:** make the `openSession` listener a `once()`, or explicitly `off()` it before calling `session.start()`.
- [x] **W-DCC3 — `attach()` is not idempotent.** **Fixed 2026-04-14** (`attached` flag; `attach()` short-circuits and warns on double-invoke; `detach()` clears the flag). `dcc/index.ts:971-974` — calling `attach()` twice without an intervening `detach()` unconditionally overwrites `ircListeners`, `eventBusListeners`, and `authSweepTimer` without clearing the prior registrations. **Fix:** guard `attach()` with an "already attached" check or call `detach()` internally before re-attaching.
- [x] **W-DCC4 — `DCCAuthTracker` has no hard size cap.** **Fixed 2026-04-14** (`maxEntries=10_000` with oldest-`firstFailure` eviction). `auth-tracker.ts:23,99-112` — the 5-minute sweep is time-based only; any entry whose `bannedUntil` was within the last 24h stays. A brute-force attacker cycling identities can grow the map arbitrarily. **Fix:** add `maxEntries` (~10k) with oldest-`firstFailure` eviction.
- [x] **W-DCC5 — Prompt-phase idle timer not `.unref()`'d.** **Fixed 2026-04-14.** `dcc/index.ts:721-726` — `resetIdle`/`resetPromptIdle` setTimeouts block graceful SIGTERM exit until they fire. Compare to `dcc/index.ts:608` which correctly uses `timer.unref?.()`. **Fix:** call `.unref?.()` on idle timers.

### Core command handlers (`src/core/commands/modlog-commands.ts`)

- [x] **W-CMD1 — `.audit-tail` EventBus listener not cleaned up at REPL shutdown.** **Fixed 2026-04-14** (`tailListeners` module-scoped; `clearAuditTailForSession` + `shutdownModLogCommands` wired into DCC close and Bot.shutdown). `modlog-commands.ts:413,449-457` — the listener holds a closure over `ctx.reply` and has no removal path from process shutdown. **Fix:** expose a `unregisterAuditTail()` hook called from REPL teardown; key `tailListeners` by session ID instead of the literal string `'repl'`.
- [x] **W-CMD2 — `clearPagerForSession` exported but never called.** **Fixed 2026-04-14** (called from `DCCSession.close`/`onClose` and `Bot.shutdown` via `shutdownModLogCommands`). `modlog-commands.ts:73,91-94` — the function exists with a comment "exposed so DCC/REPL tear-down can drop the entry eagerly" but no caller invokes it. Pager state holds up to a full page of `ModLogEntry` objects for 30 minutes past session close. **Fix:** wire it into DCC session close and REPL teardown.

### BotLink subsystem (`src/core/botlink/leaf.ts`)

- [x] **W-BL1 — Heartbeat-timeout branch doesn't call `stopHeartbeat()` inline.** **Fixed 2026-04-14** (`stopHeartbeat()` called inline before `protocol?.close()`). `botlink/leaf.ts:393-403` — the timeout branch calls `this.protocol?.close()` and relies on the resulting `socket.on('close')` → `onClose` path to drain the heartbeat interval. The hub's analogous path at `hub.ts:751` does the right thing (inline `clearInterval`). Race window: a concurrent destroyed-socket condition can suppress the `onClose` callback, leaving the interval running. **Fix:** call `this.stopHeartbeat()` inline before `this.protocol?.close()`.

### RSS plugin (`plugins/rss/index.ts`, `feed-fetcher.ts`, `feed-formatter.ts`)

- [x] **W-RSS1 — `teardown()` doesn't null `parser` or abort in-flight fetches.** **Fixed 2026-04-14** (module-level `AbortController`; `teardown()` aborts before clearing state). `plugins/rss/index.ts:57-58,145-147` — the module-level `parser: Parser` binding stays resident and any in-flight `pollFeed` continues to run against the torn-down plugin's `api` reference until the 30s wall-clock timer fires. **Fix:** introduce a module-level `AbortController`, abort it in `teardown()`, thread the signal through to the fetcher.
- [x] **W-RSS2 — In-flight HTTP request not abortable externally.** **Fixed 2026-04-14** (`FetchFeedOpts.signal` threads through `doRequest`, composed with internal wall-clock abort). `plugins/rss/feed-fetcher.ts:156-160` — the internal `AbortController` is wall-clock-timer-only with no external signal hookup. **Fix:** accept an external `AbortSignal` on `FetchFeedOpts` and compose with `AbortSignal.any([external, internal])`.
- [x] **W-RSS3 — Announce drip-feed `setTimeout` survives teardown.** **Fixed 2026-04-14** (drip-feed sleep is now interruptible via `signal`). `plugins/rss/feed-formatter.ts:56-64` — the `await new Promise(resolve => setTimeout(resolve, 500))` loop between announced items has no abort check. Up to 5 items × 500ms = 2.5s of residue per reload. **Fix:** short-circuit the announce loop on an abort signal, or track the drip-feed `setTimeout` handles in a module-scope Set and `clearTimeout` them all in `teardown()`.

### Chanmod plugin (`plugins/chanmod/`)

- [x] **W-CM1 — `setupStickyBans` is registered outside the `teardowns[]` array.** **Fixed 2026-04-14.** `plugins/chanmod/index.ts:235` — every other `setup*` call returns a teardown closure; this one is a bare call. The inconsistency is a pattern footgun for future edits. **Fix:** convert to `teardowns.push(setupStickyBans(api, state));`.
- [x] **W-CM2 — `markIntentional` spike on wildcard bans.** **Fixed 2026-04-14** (`markIntentional` runs inline prune past `INTENTIONAL_INLINE_SWEEP_AT=10_000`). `plugins/chanmod/mode-enforce.ts:143-159` — `handleEnforceBans` iterates every channel member and calls `markIntentional` before kicking. A wildcard ban `*!*@*` marks every user at once; a 500-user channel under repeated wildcard-ban attacks can populate `state.intentionalModeChanges` with thousands of 5s-TTL entries between 60s prune ticks. **Fix:** add a size guard in `markIntentional` that triggers inline pruning past ~10k entries.
- [x] **W-CM3 — `probeTimers` O(n²) splice pattern.** **Fixed 2026-04-14** (`probeTimers` is now `Set<Timeout>` in both chanserv-notice and anope-backend). `plugins/chanmod/chanserv-notice.ts:144-156` (and `anope-backend.ts:186-194`) — uses `indexOf` + `splice` inside the timer callback for an O(n)-per-fire removal. 50 concurrent probes give O(n²) total work. Not a memory leak, but a scaling hazard. **Fix:** use `Set<Timeout>` for `probeTimers` — O(1) delete.
- [x] **W-CM4 — `recoveryState` Map not cleared when the bot `.part`s a channel.** **Fixed 2026-04-14** (`dropRecovery` helper + bot-part/kick binds in join-recovery). `plugins/chanmod/join-recovery.ts:61,133-139` — the map only self-clears after a successful join + 5 min of sustained presence. If the bot is manually `.part`ed after a failed-join record exists, the entry persists for the plugin lifetime. **Fix:** bind the bot's own `part`/`kick` and `recoveryState.delete(api.ircLower(ctx.channel))` on matching events.

### Flood plugin (additional warnings beyond C1/C2)

- [x] **W-FL1 — `RateLimitTracker.sweep()` doesn't tolerate window shrinks.** **Fixed 2026-04-14** (flood init now warns and clamps invalid `*_window_secs`). `plugins/flood/rate-limit-tracker.ts:39-44` + `sliding-window.ts:20-27` — a misconfigured `windowMs === 0` turns sweep into a no-op. **Fix:** assert `windowMs > 0` at config load; use `max(window, 60s)` in sweep.
- [x] **W-FL2 — `LockdownController.activeLocks` timer not dropped on bot part/kick.** **Fixed 2026-04-14** (`dropChannel` method + bot-part/kick binds in flood index). `plugins/flood/lockdown.ts:107-111` — if the bot is kicked mid-lockdown, the timer still fires a `mode -R` on a channel the bot isn't in, and the entry lingers in `activeLocks` until the timer fires. **Fix:** bind `part`/`kick` for the bot's own nick and drop the lockdown record.
- [x] **W-FL3 — `LockdownController.flooders` grows unbounded during an active lockdown.** **Fixed 2026-04-14** (`record()` early-returns when the channel is already locked). `plugins/flood/lockdown.ts:75-82` — `sweep()` deliberately skips channels that are currently locked down, so a long lockdown under continued probing grows the flooders set to botnet-size. **Fix:** cap the per-channel `Set<string>` at ~500, or stop recording entirely while `activeLocks` holds the channel.
- [x] **W-FL4 — `EnforcementExecutor.offenceTracker` has no size cap.** **Fixed 2026-04-14** (covered by C2's `MAX_OFFENCE_ENTRIES=2000` insertion-order LRU). `plugins/flood/enforcement-executor.ts:28,56-66` — addressed partially by C2, but worth calling out separately: the tracker needs an LRU cap independent of C2's rekey.
- [x] **W-FL5 — Module-scope `logFloodError` closure captures mutable `api` binding.** **Fixed 2026-04-14** (`logFloodError` now a local closure capturing `capturedApi`; `EnforcementExecutor.inFlight` Set + `drainPending()` awaited in async teardown). `plugins/flood/index.ts:55-59,66-68` — pending async enforcement promises started under the _old_ module will still resolve against the _old_ `api` reference after a reload. **Fix:** drop the module-scope closure and use a constructor-captured version; track in-flight actions in a `Set<Promise>` and `Promise.all`-drain on teardown.
- [x] **W-FL6 — `liftExpiredBans()` silently skips when bot has no ops.** **Fixed 2026-04-14** (24h grace-window past expiry drops the record with a warn log). `plugins/flood/enforcement-executor.ts:78-102` — expired ban records sit in SQLite forever if the bot permanently loses ops, and the `api.db.list('ban:')` scan cost grows O(n). **Fix:** delete expired records past a 24h grace period regardless of ops state, with a warning log.

### Small plugins

- [x] **W-SP1 — `ctcp` plugin has no `teardown()` export.** **Fixed 2026-04-14.** `plugins/ctcp/index.ts` — even a no-op export makes intent explicit and survives pattern-lint checks. **Fix:** add `export function teardown(): void {}`.
- [x] **W-SP2 — `topic` plugin uses module-level `let previewCooldown: Map`.** **Fixed 2026-04-14** (`previewCooldown` moved inside `init()` as a `const`). `plugins/topic/index.ts` — reassigns on `teardown()` but the module-level pattern is fragile under ESM reload retention (W-PS1). **Fix:** move `previewCooldown` inside `init()` as a `const` captured by its bind closure; reduce `teardown()` to a no-op.
- [x] **W-SP3 — `help` plugin uses module-level `cooldowns` Map.** **Fixed 2026-04-14** (`cooldowns` moved inside `init()` as a `const`). `plugins/help/index.ts` — same pattern as W-SP2. Functionally correct but inconsistent with `seen`/`greeter`, which keep all state in the DB. **Fix:** move `cooldowns` inside `init()`, captured by the handler closure.

---

## INFO findings (short-form)

- [x] Plugin API captures full `deps` bag via closures (`plugin-api-factory.ts:110-256`); benign today, but coupled with W-PS1 is the "loaded gun" if teardown misses anything — consider nulling plugin API methods after unload. **Addressed by W-PS1 (2026-04-14)** — post-teardown every method is a no-op, so the retained `deps` closures can no longer fan out.
- [x] `ListenerGroup` silently no-ops if target exposes neither `removeListener` nor `off` — interface-contract edge case; add a runtime assertion. **Fixed 2026-04-15** (constructor throws on targets exposing neither alias).
- [x] `closeSessionsForHandle` uses plain JS `toLowerCase()` instead of `ircLower` — consistency note, not a leak. **Fixed 2026-04-15** (`src/core/dcc/index.ts:1657`).
- [x] BotLink leaf reconnect `socket.once('connect', ...) / once('error', ...)` with symmetric `removeListener` is correct but subtle — add a comment. **Fixed 2026-04-15** — comment added at the attach site.
- [x] ~~BotLink `relay-handler.ts` `sessions` map has no TTL sweep and no leaf-disconnect hook~~ **— verified 2026-04-14: `bot.ts:570-581` wires `_onBotlinkDisconnectedCleanup` on `eventBus.on('botlink:disconnected', ...)` which iterates `_relayVirtualSessions` and deletes every entry whose `fromBot` matches the disconnecting leaf. The cleanup hook is present; this is not a finding.**
- [x] `pending-verify` timer fires `nickserv-verify-timeout` audit rows after disconnect (addressed by W-CL2). **Addressed by W-CL2 (2026-04-14).**
- [x] RSS `url-validator.ts` `dns.lookup` has no explicit timeout — inherits OS resolver timing (up to 90s per fetch with redirects). **Already fixed** by the 2026-04-14 stability audit — `url-validator.ts:108-117` races `dns.lookup` against a 5s deadline.
- [x] Chanmod `probedChannels` Set not cleared on `.part` (bounded by unique channel set). **Already fixed** by W-CM4 — `join-recovery.ts:147-159` `dropRecovery` clears it on bot part/kick.

- [x] BotLink `sharing.ts` `MaskList` has no per-channel cap; bounded in practice by IRC-server ban-list limits, but a compromised peer can inject high-cardinality masks via `syncBans` / `syncExempts`. **Fixed 2026-04-15** — `MAX_MASKS_PER_CHANNEL = 256` cap in `sharing.ts`; `add()` drops and `sync()` truncates with warn log.
- [x] BotLink `remotePartyUsers` has 7-day TTL but no hard cap — a malicious leaf can grow it to `MAX_PENDING_ROUTES`-equivalent between sweeps. **Fixed 2026-04-15** — `MAX_REMOTE_PARTY_USERS = 512` cap in `relay-router.ts`; `trackPartyJoin` drops new joins past the cap with warn log.
- [x] `rss:seen:` KV set has only time-based eviction; a high-volume feed can accumulate 30k+ rows per feed between daily cleanups, and `api.db.list('rss:seen:')` briefly holds them all in memory. **Fixed 2026-04-15** — `MAX_SEEN_PER_FEED = 1000` per-feed LRU cap trimmed inline by `markSeen` in `feed-store.ts`.
- [x] Chanmod `takeoverWarnedChannels` bounded by session channel count; `resetThreat()` exists but is never called from any handler. **Fixed 2026-04-15** — `resetThreat()` deleted as dead code (only tests referenced it); `takeoverWarnedChannels` is self-bounded by channel count and needs no further action.

### Dropped items (not leaks / not applicable / stale)

Removed 2026-04-15 after re-triage — each was either explicitly benign in the finding text, already fixed by a warning-tier item, or stale:

- `EventDispatcher.destroy()` — not a leak, author's own note.
- `plugin-loader.ts` `importedOnce` — bounded; rename is cosmetic only.
- `command-handler.ts` `unregisterByOwner` — plugins don't expose `registerCommand` through the plugin API, so there's no reload path to leak.
- `repl.ts` Bot reference — explicitly benign (lifetimes match).
- `index.ts` `recoverableTimestamps` — bounded at 100.
- `database.ts` prepared-statement cache — bounded by WHERE permutations.
- DCC listener count vs default-10 cap — not a leak; silencing would only hide a warning.
- DCC `attach()` `authSweepTimer` re-assignment — covered by W-DCC3's `attached` idempotency flag.
- BotLink `cmdRefCounter` — overflow in ~3 million years.
- BotLink hub handshake `finish('ok')` — "correctly wired" per audit text.
- `BotLinkProtocol` `off()` on `rl.on('line')` / `socket.on('close')` — safe; cleanup via socket destroy is a documented Node contract.
- RSS `doRequest` DOCTYPE chunks array — Promise settlement GCs it; no measurable window.
- Chanmod `threatScores` — ring-buffered at 200, bounded by channel count.

## Open questions

All resolved 2026-04-15 — see the INFO entries above for outcomes.

---

## Leak-free patterns worth preserving

A clean pattern is as valuable as a finding — future refactors should copy these rather than invent.

### Primitives (`src/utils/`)

- [x] **`ListenerGroup`** (`src/utils/listener-group.ts:33-47`) — same-reference invariant between `on()` and `removeAll()`, reusable after clear, handles both `removeListener` and `off` aliases. This is the canonical leak-safe pattern for the whole codebase.
- [x] **`SlidingWindowCounter`** (`src/utils/sliding-window.ts:26-40`) — `MAX_KEYS = 8192` hard cap with emergency inline sweep + FIFO fallback. Cannot be DoSed. (**Note:** `plugins/flood/sliding-window.ts` is a _different_ file and does not share this protection — see C1.)

### Core subsystems

- [x] **`EventDispatcher.unbindAll(pluginId)`** (`src/dispatcher.ts:294-304`) — walks all binds, clears timers via `clearTimer()`, rebuilds the array with matches removed. Fully correct plugin-scoped unbind.
- [x] **Dispatcher timer cleanup** (`src/dispatcher.ts:474-480`) — every `setInterval` handle stored in `this.timers: Map<BindEntry, Timer>`, every removal path routes through `clearTimer()`.
- [x] **`ChannelState` PART/QUIT/KICK hygiene** (`src/core/channel-state.ts:152,279,291,326,340,369`) — every `set` has at least one paired cleanup; cross-channel `stillPresent` scan before evicting `networkAccounts` on PART; `ListenerGroup` used consistently.
- [x] **`BanStore.liftExpiredBans()`** (`src/core/ban-store.ts:18,92-117`) — 24h grace window handles "bot lost ops" without accumulation.
- [x] **Database prepared-statement discipline** (`src/database.ts:217-233`) — 6 hot-path statements prepared once, `close()` nulls `this.db` explicitly.
- [x] **`ReconnectDriver` timer lifecycle** (`src/core/reconnect-driver.ts:108-115,145-159,163`) — single `retryTimer` handle, every entry path calls `clearRetryTimer()` first.
- [x] **Listener registration is one-shot per session, not per reconnect** (`src/core/connection-lifecycle.ts:146-150,245-249,258-259`) — `ListenerGroup`-wrapped listeners installed once in `registerConnectionEvents()`, drained once on shutdown. Explicit response to the 2026-04-13 incident documented in the file header.
- [x] **`Services.verifyUser` AbortController pattern** (`src/core/services.ts:88-174`) — one `abort()` idiom handles timeout, re-issue, resolve, and detach. Gold standard.
- [x] **`MessageQueue` 500-depth cap + per-disconnect clear** (`src/core/message-queue.ts:67,137-142,156-167`) — bounded queue, drops newest on overflow, fully reset on every disconnect.

### Botlink subsystem

- [x] **`PendingRequestMap`** (`src/core/botlink/pending.ts`) — every `create()` installs a setTimeout that clears itself and deletes the map entry; `drain()` iterates all entries. Used by 4 distinct pending maps and drained in every disconnect path.
- [x] **`RateCounter`** (`src/core/botlink/rate-counter.ts`) — single `number[]` per counter, self-prunes on every `check()`. No per-peer Map.
- [x] **`BotLinkAuthManager`** (`src/core/botlink/auth.ts`) — true-LRU `authTracker` with `MAX_AUTH_TRACKERS = 10_000` cap, `manualCidrBans` cap at 500, `pendingHandshakes` decremented via `releasePending()` on every teardown path, sweep timer `.unref()`'d.
- [x] **`BotLinkRelayRouter`** (`src/core/botlink/relay-router.ts`) — `MAX_PENDING_ROUTES = 4096` + 30s TTL sweep for `cmdRoutes`/`protectRequests`, `cleanupLeafState()` walks all four maps on peer disconnect.
- [x] **`BotLinkHub` per-leaf cleanup** (`src/core/botlink/hub.ts:357,727,747`) — every leaf-disconnect path clears ping timer, deletes from leaves map, sweeps router state, broadcasts `BOTPART`.

### DCC subsystem

- [x] **`DCCSession.clearAllTimers()`** (`src/core/dcc/index.ts:793-804`) — single choke point that both `close()` and `onClose()` route through.
- [x] **`DCCManager.detach()`** (`src/core/dcc/index.ts:1035-1073`) — orderly teardown of auth sweep, log sink, binds, listeners, sessions, pending servers, ports.
- [x] **`pending` server cleanup** (`src/core/dcc/index.ts:1336-1366`) — three-exit coverage (`once('connection')`, `setTimeout`, `server.on('error')`) all clear the timer, release the port, delete the pending entry.

### Chanmod plugin

- [x] **`CycleState`** (`plugins/chanmod/state.ts:97-143`) — centralises every part/rejoin/defer timer; `schedule` self-removes from the set on fire; `clearAll` iterates and clears every tracked timer plus locks.
- [x] **`teardowns[]` reset discipline** (`plugins/chanmod/index.ts:24-29`) — reset to `[]` at init and at end of teardown, even if teardown threw. Correct defensive pattern.

### RSS plugin

- [x] **Uses `api.bind('time', '-', '60', ...)` instead of `setInterval`.** Dispatcher-owned timers mean plugin reload can't leak zombie intervals. Correct pattern for plugins that need periodic work.
- [x] **Dedup state lives in SQLite KV, not in-process.** No `Map<feedId, Set<hash>>` to grow across reloads.

### Small plugins

- [x] **`seen` plugin** writes directly to DB with no in-memory mirror — reload-safe by design.
- [x] **`greeter` plugin** is stateless — registers bind, processes each join, no accumulating state.

---

## Recommendations (prioritized)

### Quick wins (< 5 min each)

- [x] **W-SP1** — add `export function teardown(): void {}` to `plugins/ctcp/index.ts`. **Fixed 2026-04-14.**
- [x] **W-DCC5** — add `.unref?.()` calls after the `setTimeout`s in `resetIdle` / `resetPromptIdle` in `dcc/index.ts`. **Fixed 2026-04-14.**
- [x] **W-CL1** — clear `presenceTimer` in `onClose` alongside `registrationTimer` in `connection-lifecycle.ts`. **Fixed 2026-04-14.**
- [x] **W-CM1** — `setupStickyBans` now returns a no-op teardown and is pushed to `teardowns[]`. **Fixed 2026-04-14.**
- [x] **C3** — covered in the C3 section above. **Fixed 2026-04-14.**
- [x] **W-FL1** — flood config load warns and clamps non-positive `*_window_secs` to documented defaults. **Fixed 2026-04-14.**

### Medium effort (targeted refactoring)

- [x] **C1** — **Done 2026-04-14** (deleted `plugins/flood/sliding-window.ts`; imports from `src/utils/sliding-window`).
- [x] **C2** — **Done 2026-04-14** (hostmask rekey + `MAX_OFFENCE_ENTRIES=2000` LRU).
- [x] **W-DCC1 + W-DCC2 + W-DCC3** — **Done 2026-04-14** (named `dataGuard` + `clearAllTimers` detach; `once('error')` pre-start; `attached` idempotency flag).
- [x] **W-DCC4** — **Done 2026-04-14** (`maxEntries=10_000` oldest-`firstFailure` eviction).
- [x] **W-RSS1 + W-RSS2 + W-RSS3** — **Done 2026-04-14** (module-level `AbortController` threaded through fetcher + drip-fed announce loop).
- [x] **W-CMD1 + W-CMD2** — **Done 2026-04-14** (`clearPagerForSession`/`clearAuditTailForSession` wired into DCC close; `shutdownModLogCommands()` wired into bot shutdown).
- [x] **W-CL2** — **Done 2026-04-14** (`services.cancelPendingVerifies('disconnected')` called from `onReconnecting`).
- [x] **W-CM2** — **Done 2026-04-14** (inline prune past `INTENTIONAL_INLINE_SWEEP_AT=10_000`).
- [x] **W-CM3** — **Done 2026-04-14** (`probeTimers` → `Set<Timeout>`).
- [x] **W-CM4** — **Done 2026-04-14** (`dropRecovery` helper + bot-part/kick binds).
- [x] **W-FL2 + W-FL3 + W-FL4** — **Done 2026-04-14** (`dropChannel`, early-return on active lock, covered by C2's LRU).
- [x] **W-FL6** — **Done 2026-04-14** (24h grace-window deletion).
- [x] **W-CS1** — **Done 2026-04-14** (`memo.attach()` subscribes to `user:removed`).
- [x] **W-BL1** — **Done 2026-04-14** (`stopHeartbeat()` inline before `protocol?.close()`).
- [x] **W-BO2** — **Done 2026-04-14** (`step()` helper wraps each shutdown substep in try/catch).

### Architectural (design changes needed)

- [x] **W-PS1** — **Done 2026-04-14.** `createPluginApi` returns `{ api, dispose }`; `wrapApiMethods` guards every top-level method and the `SUB_API_KEYS` namespaces against a `disposedCell` checked on every call; `plugin-loader.unload()` and the load init-catch call `dispose()` via `cleanupPluginResources`.
- [x] **W-BO1** — **Done 2026-04-14.** `BotEventBus.trackListener(owner, event, fn)` + `removeByOwner(owner)`; called from `cleanupPluginResources`.
- [x] **W-PS2** — **Done 2026-04-14.** `offModesReady`/`offPermissionsChanged` added to PluginAPI; per-callback→wrapper maps in `createPluginChannelStateApi` back them.
- [x] **W-PS3** — **Done 2026-04-14.** Single `cleanupPluginResources(pluginName, disposeApi)` private method; both `load()` init-catch and `unload()` call it.
- [x] **W-FL5** — **Done 2026-04-14.** `logFloodError` is now a constructor-captured closure; `EnforcementExecutor.inFlight: Set<Promise>` is awaited via `drainPending()` in the plugin's async `teardown()`.

---

## Observations on code hygiene

- **Zero `setMaxListeners(0)`** in the codebase (verified). Nothing is masking a real leak behind a suppressed warning.
- **Every `setInterval`** in the codebase has a captured handle and an explicit `clearInterval` path — no unbounded intervals.
- **Listener registration is intentionally one-shot**, not per-reconnect. The `reconnect-driver.ts:10-15` comment documents this as a deliberate response to irc-framework's broken built-in reconnect — do not regress.
- **The DCC and BotLink subsystems are the best-engineered parts of the codebase** for leak safety. The patterns (`clearAllTimers`, `PendingRequestMap`, `cleanupLeafState`, `RateCounter`, the abort-controller pattern in `services.ts`) are worth copying to other subsystems.
- **The flood plugin is the worst-engineered** in this dimension — it diverges from the `src/utils/sliding-window.ts` primitive, uses nick-keyed tracking where hostmask is required, and lacks any hard cap. Under a real attack it is the first place the bot will OOM.
- **Chanmod's `teardown()` coverage is broad and explicit**, but the one gap (`onRecoverCallback`) is the kind of subtle closure-capture that only matters after a future refactor. The recommended `clearSharedState(state)` helper is belt-and-braces but worth adding.
