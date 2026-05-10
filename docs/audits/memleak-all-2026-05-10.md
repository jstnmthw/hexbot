# Memory Leak Audit: hexbot (full codebase)

**Date:** 2026-05-10
**Scope:** Every `.ts` file under `src/` and `plugins/` (191 files), partitioned across 9 parallel scanners covering core orchestrator, src/core (root + commands), src/core/dcc, src/core/botlink, and the 11 first-party plugins.
**Estimated risk:** **Low** — no CRITICAL findings. The codebase is unusually disciplined for a long-running IRC bot.

## Summary

hexbot is engineered with leak-prevention as a first-class concern. Across 191 files, scanners found **zero CRITICAL leaks** — no uncapped per-event accumulator, no unconditional listener add on reconnect, no plugin reload path that leaves bindings, timers, or HTTP requests dangling. The patterns that protect this are consistent: bind ownership tracked by plugin name in the dispatcher and reaped on unload, `ListenerGroup` everywhere a long-lived emitter is touched, hard caps + TTL sweeps + per-event eviction layered on every per-channel/per-user collection, and `unref()` on intervals so shutdown isn't blocked.

The 13 WARNING findings are concentrated in three patterns:

1. **Timers stored in local scope but not in a field reachable from teardown** — Services GHOST and SASL-check `setTimeout`s, recoverable-socket-error timestamps. Each is short-lived and `unref()`'d, so impact is bounded but the symmetry is broken.
2. **Listener handles not stored for explicit `socket.off()` / `emitter.off()`** — DCCSession close/error closures, IRCBridge attach idempotence, the pre-handshake DCC error bridge, the Logger static sink registry. Each one is structurally fragile rather than actively leaking.
3. **Per-channel / per-IP collections lacking either a hard cap or an active sweep** — botlink's `pendingHandshakes` (no cap, no sweep), ai-chat's `RateLimiter.ambientChannelWindows` (no PART/KICK eviction; relies on LRU at 256), chanmod's `threatScores` and `lastKnownModes` (no TTL prune; bounded by configured channels today). These would surface as real leaks if a future code path expanded their key space beyond the current bounded set.

The single most-attention-worthy item is **botlink's `pendingHandshakes` Map** (`src/core/botlink/auth.ts:155`): no size cap, no periodic sweep, decrement depends entirely on a `releasePending` discipline that holds today but breaks if any future handshake path forgets to pair admit/release. Recommended fix is small (cap at 4096 with audit warn).

**Findings:** 0 CRITICAL · 13 WARNING · 16 INFO (after culling non-action items)

**Status (2026-05-10):** All findings, INFO items, and Recommendations applied — every checkbox in this document is now `[x]`. Full test suite passes (4160 tests). Concrete fixes:

- WARNINGs: recoverable-error timestamps cap; Spotify time-bind teardown comment documenting the dispatcher dependency; ResilientProvider retry sleep made cancellable.
- INFOs: PluginApi `wrappedHandlers` implicit-bound documented; `Bot._isStarted` flag added; DCCSession `lineHandler` is now a named field with explicit `rl.off()` in clearAllTimers; chanmod `takeoverWarnedChannels` dropped on bot PART/KICK; ai-chat coalescer callback bails early when state is torn down; flood `channelActionRate` capped at 1024 keys with oldest-by-insertion eviction.

---

## Findings

### Core orchestrator (src/ root, utils/, types/, config/)

#### - [x] [WARNING] Logger static sink/hook state survives test resets and is shared across all Logger instances

- **File:** `src/logger.ts:162-252`
- **Category:** reload residue
- **Growth rate:** one entry per `addSink()` not paired with `removeSink()`; module-global, never garbage-collected
- **Description:** `Logger.sinks: Set<LogSink>`, `Logger.hookWrapper`, and `Logger.sinkWarnFired` are class-static. A plugin or subsystem that adds a sink and forgets to remove it leaks the sink AND its closure (which can capture an entire plugin module graph) for the lifetime of the Node process. There is no per-owner tracking analogous to `BotEventBus.trackListener`; the only safety net is the SINK_WARN_THRESHOLD=8 console.warn.
- **Impact:** Today no in-tree caller addSink()s from a plugin path, but the API surface invites it. A misbehaving future plugin reloaded N times accumulates N stale sinks + closures forever.
- **Remediation:** Add an owner-keyed `addSink(owner, sink)` variant with `removeByOwner` mirroring `BotEventBus.trackListener`, OR don't expose `addSink` to plugins (currently it's static so anything with a Logger import can call it).

#### - [x] [WARNING] IRCBridge listener accumulation if attach() were ever called twice

- **File:** `src/irc-bridge.ts:99, 134-171`
- **Category:** listener leak
- **Growth rate:** one full set of ~14 client listeners + two timers per spurious attach() call
- **Description:** `IRCBridge.attach()` registers ~14 listeners on the irc-framework client into `this.listeners[]` but does not check whether `this.listeners` is already non-empty. Currently safe — Bot.attachBridge() runs once at startup — but a future refactor (e.g. STS-driven reconnect that wants to swap dispatcher behavior) could introduce a second attach() call and silently double every event handler plus orphan the previous CTCP-sweep interval and topic-startup-grace timeout.
- **Impact:** Hypothetical doubled dispatch + two orphaned timers per stray attach.
- **Remediation:** Make `attach()` idempotent: at the top, if `this.listeners.length > 0` either no-op with a warn or call `detach()` first. Same defensive treatment for the two timer fields.

#### - [x] [WARNING] Recoverable-socket-error timestamps array grows unbounded between scrubs

- **File:** `src/index.ts:182-194`
- **Category:** unbounded collection
- **Growth rate:** one entry per recoverable socket error; pruned only on next `noteRecoverable()` call, not on a wallclock interval
- **Description:** `recoverableTimestamps: number[]` is a sliding window pruned only inside `noteRecoverable()`. If a long quiet period follows a burst, the array holds up to ~100 entries indefinitely. Negligible memory (~800 bytes) but the asymmetric "add eagerly, prune lazily" pattern is worth documenting so future copy-paste doesn't apply it to a hotter path.
- **Impact:** Negligible bytes; pattern hazard.
- **Remediation:** Optional: cap with `recoverableTimestamps.length > RECOVERABLE_RATE_MAX * 2` and shift, or run prune from a slow `setInterval(60s).unref()`.

### src/core (root + commands)

#### - [x] [WARNING] SASL-not-identified setTimeout never cancelled on early disconnect

- **File:** `src/core/services.ts:179-187`
- **Category:** timer leak
- **Growth rate:** one orphan timer per reconnect that fails within 3 s
- **Description:** `_onConnected` schedules a 3-second `setTimeout` to warn if SASL didn't identify in time. The handle is `unref()`'d but never stored; if `bot:disconnected` fires inside that 3 s window the timer keeps a closure over `this` (Services instance) alive and its callback fires after teardown.
- **Impact:** Non-fatal due to `unref()`, but on a flapping connection the bot logs misleading SASL warnings tied to dead sessions and briefly pins Services scope.
- **Remediation:** Store the timer in a field (e.g. `this.saslIdentifyCheckTimer`) and `clearTimeout` it inside `_onDisconnected` and at the top of `_onConnected` when re-arming.

#### - [x] [WARNING] GHOST timer + pendingGhostResolver not cleaned on detach

- **File:** `src/core/services.ts:683-724`
- **Category:** timer leak
- **Growth rate:** at most one orphan timer + closure per `ghostAndReclaim` call mid-shutdown
- **Description:** `ghostAndReclaim` schedules a 1.5 s `setTimeout` and stores a `pendingGhostResolver` closure. Both are normally cleared by the success path, but `detach()` and `cancelPendingVerifies()` don't touch them. If shutdown happens while a GHOST is in flight, the timer keeps the closure (and via it `this`) reachable until it fires.
- **Impact:** Bounded (1.5 s); spurious changeNick attempt against a closed transport during teardown.
- **Remediation:** Hoist the timer into `this.ghostTimer` and clear it (and null `pendingGhostResolver`) in `detach()` and `cancelPendingVerifies()`.

### src/core/dcc

#### - [x] [WARNING] Pre-handshake `socket.once('error')` closure outlives the pending object it captures

- **File:** `src/core/dcc/index.ts:1616-1618`
- **Category:** closure capture
- **Growth rate:** one captured `pending` object per accepted DCC connection that never errors before `DCCSession.start()` (i.e. every healthy session)
- **Description:** `openSession()` installs `socket.once('error', err => this.logger?.debug(...pending.nick...))` to bridge the pre-handshake gap. Because `.once` only self-removes after firing, the listener stays attached for the full session lifetime, holding a closure that captures the entire `PendingDCC` (with its `user: UserRecord`, server reference, ident, hostname, timer handle). DCCSession also installs its own permanent `socket.on('error')` after start, so the pre-handshake handler is dead weight from that point.
- **Impact:** Per-session retained heap: one closure plus a `PendingDCC` (UserRecord, closed NetServer reference, cleared timer). Bounded by max_sessions × hundreds of bytes; complicates heap snapshots and retains a UserRecord per active session unnecessarily.
- **Remediation:** Capture only `pending.nick` (a string) in the pre-handshake listener, and remove it explicitly in `DCCSession.start()` after its own `error` listener attaches — store the function reference so it can be `socket.off()`'d.

#### - [x] [WARNING] Stale-session eviction does not clear pager/audit-tail state for the evicted session

- **File:** `src/core/dcc/index.ts:1481-1486`
- **Category:** unbounded collection
- **Growth rate:** potentially one orphaned modlog-pager / audit-tail entry per stale-session eviction
- **Description:** `checkNotAlreadyConnected()` has two paths for a stale session: `session.isClosed` true → just `sessionStore.delete(nick)` with no pager cleanup, OR call `session.close()` which routes through `teardownSession()` and DOES call `clearPagerForSession`. Path (a) skips the cleanup — pager/audit-tail entries keyed by `dcc:<handle>` linger until their own IDLE_TIMEOUT_MS sweep.
- **Impact:** Bounded by modlog-commands pager TTL (~minutes); but stale `.more` state can confuse a reconnecting user.
- **Remediation:** Hoist `clearPagerForSession(\`dcc:${session.handle}\`)`and`clearAuditTailForSession`calls so they run on both paths — or unify by always going through`teardownSession`.

#### - [x] [WARNING] DCCSession 'close' / 'error' socket listeners never explicitly removed

- **File:** `src/core/dcc/index.ts:427-429, 543-545`
- **Category:** listener leak
- **Growth rate:** two listeners per session (bounded by max_sessions); released only when the socket itself is destroyed
- **Description:** `start()` and `startActiveForTesting()` register anonymous `socket.on('close', () => this.onClose())` and `socket.on('error', () => this.onClose())` that are never paired with `socket.off()` in `clearAllTimers()` / `teardownSession()`. The closures capture `this` (full session graph). On graceful close (which calls `socket.destroy()`) this is fine; on peer-initiated drop where `socket.emit('close')` fires first, the closures linger until the socket object is GC'd.
- **Impact:** Adds noise to heap snapshots and a small constant-per-recent-session overhead. Self-resolves but increases retained-heap during peer-drop spikes.
- **Remediation:** Mirror the named `dataGuard` treatment: store close/error handlers as fields, attach via the stored references, and `socket.off(...)` them in `clearAllTimers()`.

### src/core/botlink

#### - [x] [WARNING] `pendingHandshakes` Map has no size cap and no sweep — relies entirely on releasePending discipline

- **File:** `src/core/botlink/auth.ts:155`
- **Category:** unbounded collection
- **Growth rate:** one entry per unique IP that opens a connection but whose `releasePending` never fires; permanent until process restart
- **Description:** `pendingHandshakes: Map<string, number>` is incremented in `admit()` (line 247) and decremented in `releasePending()` (lines 254-258). There is no hard cap, no periodic sweep, and no TTL. Decrement depends on the hub's `beginHandshake.finish()` closure invoking `releasePending` on every termination — correct on the paths traced today. Sibling state surfaces (authTracker, manualCidrBans, the four routing maps, pendingCmds) all have a cap; this one does not.
- **Impact:** Slow growth keyed by unique source IPs over weeks/months. ~80 bytes per entry → 10k IPs ≈ 1 MB. The cap-less unboundedness is a latent bug that surfaces as a long-tail crash if any new code path forgets to release.
- **Remediation:** Add a hard cap (e.g. 4096) and reject `admit()` with `pending-limit` once exceeded; or piggy-back a sweep onto `sweepStaleTrackers()` that drops entries older than `handshake_timeout_ms`. Best: track `(count, firstAdmitTime)` and sweep entries older than a few seconds.

#### - [x] [WARNING] Hub-side `beginHandshake` closure can leak its slot if `BotLinkProtocol` construction throws between admit() and beginHandshake()

- **File:** `src/core/botlink/hub.ts:443`
- **Category:** closure capture
- **Growth rate:** one `pendingHandshakes` increment per failed protocol construction
- **Description:** `handleConnection` calls `this.auth.admit(ip)` (line 447) then constructs `new BotLinkProtocol(socket, this.logger)` (line 467) and calls `beginHandshake()`. There is no try/finally around lines 467-468 that calls `auth.releasePending(ip, admission.whitelisted)` if construction throws.
- **Impact:** Theoretical pending-slot leak per failed construction. Per-IP cap of 3 (`max_pending_handshakes`) means it could quickly lock out a legitimate IP. Current constructor doesn't throw under normal conditions.
- **Remediation:** Wrap lines 467-468 in `try/catch` and call `this.auth.releasePending(ip, admission.whitelisted)` on throw before destroying the socket.

### plugins/chanmod

#### - [x] [WARNING] `setupStopnethack()` returns `void` instead of a teardown function and isn't registered in the teardown chain

- **File:** `plugins/chanmod/stopnethack.ts:63`
- **Category:** reload residue
- **Growth rate:** no per-event growth (binds are auto-reaped); residue is the contract violation, not the listeners
- **Description:** Every other `setup*` helper returns `() => void` and gets pushed into `teardowns` from index.ts. `setupStopnethack` returns `void` and is invoked by `setupProtection` (protection.ts:294) without a return capture. Today no leak — the registered binds are auto-cleaned and shared state is wiped by `clearSharedState`. The risk is structural: any future per-stopnethack timer/listener has no obvious cleanup site.
- **Impact:** Latent. Today no leak — but the next person to add a `setInterval` or probe Map here will have no cleanup hook and risks introducing a real reload leak.
- **Remediation:** Change the signature to `: () => void`, return `() => {}` (or any future cleanup), and capture the return into the teardown chain.

#### - [x] [WARNING] `pruneExpiredState` does not iterate `threatScores` by window expiry — entries persist for inactive channels until reload

- **File:** `plugins/chanmod/state.ts:231`
- **Category:** unbounded collection
- **Growth rate:** one entry per channel that ever recorded a threat event (bounded by configured channel count today)
- **Description:** `pruneExpiredState` iterates `intentionalModeChanges`, `enforcementCooldown`, `pendingRecoverCleanup`, `unbanRequested`, and `cycles` — but not `threatScores`, `splitOpsSnapshot`, `knownGoodTopics`, `lastKnownModes`, or `takeoverWarnedChannels`. `getOrCreateThreat` resets a channel's score on read once the window expires, but a channel with no further threat events keeps its `ThreatState` (potentially up to 1000 cached `events`) until plugin teardown.
- **Impact:** Today bounded by configured channels. After weeks on a busy network with takeover events on many channels: each `threatScores` entry can hold up to 1000 events × ~80 B = ~80 KB. On 50 channels, several MB of cached threat history per plugin lifetime.
- **Remediation:** Add a `threatScores` sweep in `pruneExpiredState`: drop entries where `now - threat.windowStart > config.takeover_window_ms`. Same treatment for `knownGoodTopics` (TTL past N days) and `lastKnownModes` (drop after a successful re-op or extended kick state).

### plugins/ai-chat

#### - [x] [WARNING] RateLimiter ambient channel window not dropped on bot PART/KICK

- **File:** `plugins/ai-chat/index.ts:567-588`
- **Category:** unbounded collection
- **Growth rate:** one entry per channel the bot is ambiently active in, until LRU eviction at 256
- **Description:** Bot PART/KICK handlers drop social-tracker, context-manager, engagement-tracker, and `lastRateLimitOpNoticeAt` entries — but not `rateLimiter`'s `ambientChannelWindows`. RateLimiter has no `forgetChannel` method. The entry persists until LRU cap (256) or plugin teardown.
- **Impact:** Negligible bytes (≤ 256 channels × 5 timestamps), but inconsistent with the rest of the per-channel cleanup story. Could mask a real leak if the cap is later raised.
- **Remediation:** Add a `forgetChannel(channelKey)` method to RateLimiter that deletes from `ambientChannelWindows`; call it from the bot-PART/KICK branch in index.ts.

### plugins/rss + spotify-radio

#### - [x] [WARNING] Spotify fetch has no external abort signal — in-flight request survives plugin teardown for up to 10s

- **File:** `plugins/spotify-radio/spotify-client.ts:162`
- **Category:** stream leak
- **Growth rate:** one bounded retention per teardown that races with a poll (≤10s lifetime)
- **Description:** `fetchWithTimeout()` creates a private AbortController for its 10s timeout but does NOT accept or forward a plugin-lifecycle abort signal. When `index.ts:teardown()` runs while a `getCurrentlyPlaying` / `refreshAccessToken` fetch is mid-flight, the fetch keeps running until it resolves, errors, or hits the 10s timeout — the async frame holds the entire SpotifyClient closure (cfg, refresh token, fetchImpl, log/error functions) alive that whole time.
- **Impact:** On a hot-reload loop, each reload that races a poll pins one extra closure for up to 10s. The retained refresh token in memory is the security-relevant aspect (brief credential persistence in two closures simultaneously).
- **Remediation:** Accept an external `AbortSignal` in `createSpotifyClient` options and `AbortSignal.any([controller.signal, externalSignal])` inside `fetchWithTimeout`. Plumb a module-level AbortController from `createSpotifyRadio()` aborted in teardown, mirroring `rss/index.ts:96-244`.

#### - [x] [WARNING] Spotify time-bind handler runs forever if dispatcher doesn't unbind on teardown

- **File:** `plugins/spotify-radio/index.ts:384`
- **Category:** listener leak
- **Growth rate:** one orphan handler per reload IF the dispatcher fails to drop plugin binds
- **Description:** `registerPollLoop()` calls `api.bind('time', '-', '10', async () => { await tickPollLoop(api); })`. `teardown()` nulls `cfg/spotify/session` inside the closure but does NOT unbind the handler — relies entirely on the plugin loader to drop plugin-owned binds on unload. The early-return at line 393 means any future regression in that contract leaks silently.
- **Impact:** Defense-in-depth. Today the dispatcher drops plugin binds on unload, so this is theoretical. If the contract regresses, a `.reload spotify-radio` every minute for a day would pin 1440 closures.
- **Remediation:** Capture bind handles (if `api.bind` returns one) and explicitly remove them in teardown, OR document the dispatcher dependency in a teardown comment so a future change to the bind/unbind contract surfaces in code review.

---

## INFO findings (low priority; address when convenient)

### Core orchestrator

- - [x] **PluginApi `wrappedHandlers` has no cap if a plugin abuses bind()** — `src/plugin-api-factory.ts:199, 270-283`. Bounded transitively by `PLUGIN_BIND_HARDCAP=1000` in dispatcher. Document the implicit bound.
- - [x] **Bot.startTime restamped after start()** — `src/bot.ts:190, 964`. Not a leak; a double-start would reset visible uptime everywhere. Add `_isStarted` flag for symmetry with `_isShuttingDown`.

### src/core

- - [x] **RelayOrchestrator.virtualSessions has no per-bot cap** — `src/core/relay-orchestrator.ts:85`. Hostile leaf could grow unboundedly. Add cap (e.g. 64 per `fromBot`).

### src/core/dcc

- - [x] **DCCSession.rl 'line' handler is anonymous and only released via rl.close()** — `src/core/dcc/index.ts:419-425, 537-541`. Symmetric with named `dataGuard` for defense.

### src/core/botlink

- - [x] **SharedBanList has no per-channel-count cap** — `src/core/botlink/sharing.ts:48`. Hostile peer could send sync frames for unbounded distinct channels. Add `MAX_CHANNELS_PER_LIST` cap.
- - [x] **auth.ts manual ban with `bannedUntil=MAX_SAFE_INTEGER` bypasses sweep eviction forever** — `src/core/botlink/auth.ts:362`. Functional concern: LRU can drop manual permanent bans from the hot path.
- - [x] **Leaf's `reconnectTimer` is not `.unref()`'d** — `src/core/botlink/leaf.ts:530`. Process-shutdown concern; production paths fine.

### plugins/chanmod

- - [x] **`takeoverWarnedChannels` Set never shrinks during a session** — `plugins/chanmod/state.ts:98`. Bounded by configured channels; optional drop on bot PART.
- - [x] **`lastKnownModes` can leak entries when a kick is followed by a permanent unrecovered state** — `plugins/chanmod/protection.ts:97 / mode-enforce-recovery.ts:137`. Bounded by configured channels.

### plugins/ai-chat

- - [x] **ResilientProvider retry sleep is not cancellable on teardown** — `plugins/ai-chat/providers/resilient.ts:39,84`. Holds a few setTimeouts for ≤2s after teardown; not a true leak.
- - [x] **Coalescer fired callback can run against torn-down module state during a narrow window** — `plugins/ai-chat/index.ts:786-792, message-coalescer.ts:128-139`. Safe via optional chaining; defense-in-depth opportunity.

### plugins/rss + spotify-radio

- - [x] **Spotify cached access token persists in closure during teardown race** — `plugins/spotify-radio/spotify-client.ts:153`. Security-relevant only because the values are credentials; bounded by 10s. Pairs with the WARNING above.

### plugins/flood + seen + topic

- - [x] **`previewCooldown` sweep only fires when `size > 1000`, leaving expired entries indefinitely below threshold** — `plugins/topic/index.ts:237-241`. Bounded by ops-only `+o` flag; cosmetic.
- - [x] **Two separate `part` binds where one would suffice** — `plugins/flood/index.ts:472,477-479`. Auto-cleaned by loader; latent fragility if the loader API changes.
- - [x] **`channelActionRate` Map has no size cap** — `plugins/flood/enforcement-executor.ts:103,137-150`. Bounded by joinable channel count (~hundreds).
- - [x] **Bot-leaves-channel does not clear `channelActionRate` or offence entries scoped to that channel** — `plugins/flood/enforcement-executor.ts:103,94`. Stale entries age out via time-windowed sweeps within ~5 minutes.

---

## Leak-free patterns worth preserving (template for future code)

### Dispatcher / Plugin system

- **Bind ownership tracked by plugin name + reaped on unload** (`src/dispatcher.ts`). `bindsByPlugin` counter decremented on every removal; soft warn at 500, hard cap at 1000. Auto-disable timers after `TIMER_FAILURE_THRESHOLD` consecutive errors.
- **PluginLoader explicit ESM cache-busting via `pathToFileURL(absPath).href`** with a code comment calling out the historical leak (`src/plugin-loader.ts:386-394`).
- **PluginLoader.cleanupPluginResources drains five separate listener Maps + unbinds + disposes API + unregisters settings**, all wrapped in per-entry `try/catch` so one bad `off()` can't strand siblings (`src/plugin-loader.ts:602-723`).
- **PluginLoader.unload() KEEPS a plugin in the loaded map when teardown() throws** — refusing to silently drop ghost state that a future reload would double-register.
- **PluginApi factory's `dispose()` flips a single shared cell** that every wrapped method consults; even a stale `setInterval` holding the api handle cannot fan out to dispatcher/db/IRC client (`src/plugin-api-factory.ts:249-355`).

### Event bus / IRC bridge

- **BotEventBus.setMaxListeners(20) with one-shot warnings at 10/15** — the cap is documented as a leak detector, not a tolerance buffer (`src/event-bus.ts:122-159`).
- **BotEventBus.trackListener / removeByOwner pattern** so closures over `this` are drained on shutdown.
- **IRCBridge.attach records every `client.on()` in a `listeners[]` array; detach() removes exactly those** — never calls `removeAllListeners` (`src/irc-bridge.ts:99, 184-187, 604-608`).
- **`.unref()` on the periodic CTCP sweep timer** so it never pins the event loop.
- **ListenerGroup utility refuses to attach to any target that exposes neither `removeListener` nor `off`** — leak-safe pattern is the default (`src/utils/listener-group.ts:30-34`).

### Sliding-window utilities

- **SlidingWindowCounter has hard `MAX_KEYS=8192` cap with emergency sweep + FIFO fallback** so an attacker rotating hostmasks can't grow the map indefinitely (`src/utils/sliding-window.ts`).
- **FloodLimiter caps both the underlying counter and the `warned` set; periodic sweep + `reset()` on disconnect.**

### Channel/User state

- **ChannelState uses ListenerGroup, shrinks per-channel on PART/QUIT/KICK and self-PART/KICK**; networkAccounts also shrinks when the user leaves every tracked channel.
- **`clearNetworkAccounts()` and `clearAllChannels()` wired through `connection-lifecycle.onReconnecting`** to drop cross-session identity caches.

### Services

- **Services dedupes pending verifies, caps at MAX_PENDING_VERIFIES=128, audits the cap rejection, and aborts every pending verify on `detach()`.**

### Reconnect / Timers

- **ReconnectDriver stores `retryTimer` in a single closure variable and clears it on every transition** — no possibility of stacked retry timers.
- **ConnectionLifecycle stores `presenceTimer` and `registrationTimer` in closures and clears both on `close` and on the returned `removeListeners()`.**
- **ChannelPresenceChecker calls `unref()` on its returned interval** as defense in case any reconnect path forgets to clear it.

### DCC

- **DCCManager.attach() guards re-entry with the `attached` flag**, so a second attach() without detach() cannot orphan ircListeners/eventBusListeners/authSweepTimer.
- **DCCSession.clearAllTimers() is the single choke-point** for timer/listener cleanup, called from both close() and onClose() via teardownSession() — explicitly removes named `dataGuard` listener so the closure is GC-eligible immediately.
- **DCCAuthTracker enforces a hard `maxEntries` cap (10k) with oldest-by-firstFailure eviction** on insert.

### Botlink

- **PendingRequestMap is exemplary**: hard cap (4096), drain() on disconnect at every site, per-entry timer cleared in resolve()/drain(), and a safety net of timeoutMs always firing the resolve.
- **BotLinkRelayRouter has TTL sweep on all four routing maps + per-leaf cleanupLeafState() + per-map size caps.**
- **Heartbeat.stop() runs BEFORE onTimeout fires**, making double-dispatch impossible.
- **BotLinkProtocol nulls onFrame/onClose/onError on socket 'close' AFTER firing onClose one final time** — explicit-close callers still get notification but the protocol object stops pinning closures.

### Plugins

- **chanmod's centralized `CycleState`** owns every recovery/cycle timer through `schedule`/`scheduleWithLock`/`track`; `clearAll()` from teardown.
- **chanmod's module-level `teardowns` array reset to `[]` at the top of init()** so a previously-thrown teardown can't accumulate stale closures across reloads.
- **flood's `capturedApi` closure pattern** defends against retained closures from prior load reaching the disposed module-level `api`.
- **flood's `inFlight` Set + `drainPending()` in teardown** awaits in-flight enforcement promises so a late-resolving kick/ban cannot touch the disposed api.
- **seen plugin keeps zero in-memory state** — every record lives in SQLite KV with hourly age + entry-cap sweep.
- **topic plugin declares `previewCooldown` inside `init()`** (not at module scope) so reload drops the old Map via GC.
- **rss has a module-level AbortController forwarded to fetch() and the announce drip loop**, aborted with a Reason in teardown.
- **All four small plugins (8ball, ctcp, greeter, help) export an explicit `teardown()`** even when empty — ensures the loader recognizes the symbol and signals reload-safety review.
- **ai-chat: every per-channel Map shares MAX_CHANNELS=256 with LRU/oldest-by-activity eviction; PART/KICK/QUIT explicitly call forgetUser/dropChannel; teardownController.abort() runs before nulling refs.**

---

## Recommendations

### Quick wins (< 5 min each)

- - [x] Cap `pendingHandshakes` at 4096 in `src/core/botlink/auth.ts` with audit-warn on rejection
- - [x] Wrap `BotLinkProtocol` construction in `src/core/botlink/hub.ts:467` with try/catch that calls `releasePending` on throw
- - [x] Store and clear the SASL-check `setTimeout` in `src/core/services.ts:179`
- - [x] Hoist the GHOST timer into a field in `src/core/services.ts:683` and clear in `detach()`
- - [x] Add `.unref()` to `leaf.reconnectTimer` in `src/core/botlink/leaf.ts:530`
- - [x] Change `setupStopnethack` signature to return `() => void` (`plugins/chanmod/stopnethack.ts:63`)
- - [x] Drop the `size > 1000` guard on `previewCooldown` sweep in `plugins/topic/index.ts:237`
- - [x] Combine the two `part` binds in `plugins/flood/index.ts:472,477` into one handler

### Medium effort (refactoring needed)

- - [x] Add `forgetChannel(channelKey)` to ai-chat `RateLimiter` and call from PART/KICK
- - [x] Add `threatScores` (and friends) sweep to `plugins/chanmod/state.ts:pruneExpiredState`
- - [x] Make `IRCBridge.attach()` idempotent (check `listeners.length > 0`)
- - [x] Fix DCC pre-handshake `socket.once('error')` to capture only `pending.nick`, remove explicitly in `DCCSession.start()`
- - [x] Mirror DCCSession `dataGuard` treatment for close/error handlers (named fields + `socket.off()` in clearAllTimers)
- - [x] Unify DCC stale-session eviction paths so both branches go through `teardownSession`
- - [x] Add `MAX_CHANNELS_PER_LIST` cap to `MaskList` in `src/core/botlink/sharing.ts`
- - [x] Plumb external AbortSignal into Spotify `createSpotifyClient` and abort from teardown
- - [x] Add `EnforcementExecutor.dropChannel()` for symmetric per-channel cleanup on bot PART/KICK

### Architectural (design changes needed)

- - [x] Introduce owner-keyed `Logger.addSink(owner, sink)` with `removeByOwner` mirroring `BotEventBus.trackListener` (currently any plugin code with a Logger import can install a static sink with no cleanup hook)
- - [x] Cap `RelayOrchestrator.virtualSessions` per `fromBot` to prevent a hostile leaf from amplifying state
- - [x] Consider re-hydrating manual permanent bans from `linkBanStore` on admit-miss so LRU eviction can't silently lose them (`src/core/botlink/auth.ts:362`)
