# Stability Audit: hexbot (full codebase)

**Date:** 2026-04-14
**Scope:** all — `src/**/*.ts` and `plugins/**/*.ts` (~19k LoC across 10 sections)
**Framework:** Michael Nygard _Release It!_ stability patterns
**Estimated resilience:** **Medium**

## Summary

hexbot has solid _foundations_: the reconnect driver with tier-based backoff and jitter, dispatcher-level handler error catches, listener-group cleanup, STS enforcement, ban-store migration transactions, and IRC control-character sanitization are all correct and well thought out. The 2026-04-13 zombie-bot hardening left a clean reconnect loop and good operator visibility via `.status`.

The remaining stability gaps cluster into four themes. (1) **Database error handling** is missing at the synchronous `better-sqlite3` boundary — a locked WAL, full disk, or corrupt row crashes whatever handler happened to touch it, and `permissions.saveToDb()` rewrites the entire `_permissions` namespace on every user mutation. (2) **Plugin event-bus boundaries** (`onModesReady`, `onPermissionsChanged`) don't wrap callbacks in try/catch the way the dispatcher does, so a throw in one plugin's listener aborts the emit for all siblings. (3) **Integration-point timeouts are asymmetric** — the hub enforces handshake deadlines but the leaf does not; the DCC prompt phase has a timeout but scrypt can race socket close; NickServ ACC verification has no upper bound. (4) **Steady-state growth** in several long-lived maps (flood rate-limit buckets never pruned, DCC console-flag store, seen records, relay-pending maps, auth-tracker ban escalation) means a bot that's been up 90 days does not look like a bot that's been up 90 seconds.

Realistic survival estimates:

- **Clean TCP hiccup / ping timeout:** survives indefinitely. Reconnect driver handles it.
- **Netsplit heal with massjoin:** survives; greeter will spam but not K-line.
- **NickServ lagged to 30s:** degrades — the dispatcher serializes privileged commands behind verification and can queue many pending promises.
- **DB locked by concurrent reader:** first affected write throws and crashes the handler; rest of bot keeps running but subsequent writes to the same namespace cascade.
- **Plugin `init()` throws halfway:** loader runs teardown, but the silent catch around teardown can orphan listeners if teardown also throws.
- **Hub restart with 10+ leaves:** thundering herd — leaves reconnect at exact intervals with no jitter, potentially auth-banning themselves.
- **RSS feed returns 500 for 24h:** retries forever with no circuit breaker or backoff; log spam only.
- **Bot up 90 days with active flood plugin:** rate-limit buckets for every user who ever triggered the checker accumulate indefinitely.

**Findings:** 18 critical, 28 warning, 14 info (across 10 sections; duplicates merged).

---

## Findings

### [CRITICAL] Database operations lack error handling for LOCKED / FULL / corrupt conditions

- [x] **File:** `src/database.ts:254, 262, 268, 282, 334, 386` — unguarded `.run()` / `.get()` / `.all()` calls.
- **Pattern:** Graceful degradation / Error containment at integration point
- **Anti-pattern:** Integration point without error classification
- **Scenario:** A concurrent reader holds WAL locks, or the disk fills, or a row gets corrupted. The prepared-statement call throws synchronously and propagates up through whichever dispatcher handler happened to touch it.
- **Evidence:** Neither `db.pragma('busy_timeout = ...')` nor try/catch around the statement calls.
- **Impact:** Stop-the-world for the handler that tripped it. Commands return 500s mid-session; in the worst case (write path during connect), startup crashes before DCC is attached.
- **Remediation:** Add `db.pragma('busy_timeout = 5000')` (SQLite's internal retry handles most short contention). Wrap prepared-statement calls at the `Database` boundary and classify errors: `SQLITE_BUSY/LOCKED` after the 5s timeout → **degrade**: the failing handler replies "database busy, try again" and the rest of the bot keeps serving (audit writes spill to a fallback log sink); `SQLITE_FULL` → log CRITICAL, surface via `.status`, disable writes but keep read-only commands alive; `SQLITE_IOERR`/`SQLITE_CORRUPT` → log CRITICAL and fatal-exit (code 2) so the supervisor restarts. **Do not treat transient lock contention as fatal** — under burst load, degradation beats connection flap.

### [CRITICAL] `permissions.saveToDb()` rewrites the entire namespace on every user mutation

- [x] **File:** `src/core/permissions.ts:480-492`
- **Pattern:** Unbounded writes in hot path
- **Anti-pattern:** Full-table rewrite without atomicity
- **Scenario:** On a botlink hub with 10k users, every `addHostmask` / `setGlobalFlags` / `SETFLAGS` relay deletes and rewrites 10k rows. A SQLITE_BUSY on the second row leaves the DB half-cleaned with no rollback.
- **Evidence:** `saveToDb()` calls `db.list(DB_NAMESPACE)`, loops `db.del()`, then loops `db.set()`. No transaction wrapper.
- **Impact:** Massive write amplification; permission data corruption risk on interrupted writes.
- **Remediation:** Switch to per-record upsert (`INSERT ... ON CONFLICT DO UPDATE`). If full rewrite is kept, wrap in a single transaction.

### [CRITICAL] Plugin event-bus callbacks (`onModesReady`, `onPermissionsChanged`) have no error boundary

- [x] **File:** `src/plugin-api-factory.ts:521-534`
- **Pattern:** Error containment at plugin boundary / Bulkheading
- **Anti-pattern:** Cascading failure through EventEmitter
- **Scenario:** Plugin A's `onModesReady` callback throws. Node's EventEmitter propagates the error to the `emit()` call in `channel-state.ts:561`, aborting the remaining listeners on that event. Plugin B, C, D never see the mode-ready notification.
- **Evidence:** `wrappedListener` just calls `callback(channel)` with no try/catch, unlike `dispatcher.ts:334-341` which does wrap handler calls.
- **Impact:** One misbehaving plugin silently starves every other subscriber; mode-dependent plugin commands fail randomly.
- **Remediation:** Wrap `wrappedListener` body in try/catch with `logger.error`, mirroring the dispatcher pattern.

### [CRITICAL] Silent catch orphans listeners during plugin init-failure recovery

- [x] **File:** `src/plugin-loader.ts:338-343`
- **Pattern:** Silent catch / Error containment
- **Anti-pattern:** Silent failure in recovery path
- **Scenario:** Plugin `init()` registers 5 event listeners then throws. Loader calls `teardown()` to undo. `teardown()` also throws (e.g., DB query in teardown hit the same error). The `catch {}` swallows it; the 5 listeners remain.
- **Evidence:**
  ```ts
  try {
    mod.teardown();
  } catch {
    /* swallow teardown errors */
  }
  ```
- **Impact:** Orphaned listeners accumulate across reloads. Each reload with a failing init doubles the ghost listener count.
- **Remediation:** Log the teardown error at `warn` level with plugin name.

### [CRITICAL] Botlink broadcast fanout ignores per-leaf write failures

- [x] **File:** `src/core/botlink/hub.ts:128-134`
- **Pattern:** Cascading failure / Error containment
- **Anti-pattern:** Fanout without per-recipient error handling
- **Scenario:** Hub broadcasts `ADDUSER`, `SETFLAGS`, or `BOTJOIN` to 10 leaves. Leaf #3's TCP buffer is full; `leaf.protocol.send()` returns false. The loop continues but there's no retry or fallback. Leaves #4–10 still receive the frame, but Leaf #3's permission state diverges silently.
- **Evidence:** `broadcast()` iterates and calls `send()` with no return-value check.
- **Impact:** Silent permission drift across the botnet; relayed commands denied on the diverged leaf.
- **Remediation:** Check `send()` return value, retry on next heartbeat, and emit an observability event for failed fanout.

### [CRITICAL] Chanmod auto-op join handler has no try/catch around async `grantMode()`

- [x] **File:** `plugins/chanmod/auto-op.ts:172, 238`
- **Pattern:** Error containment at plugin boundary
- **Anti-pattern:** Unhandled promise rejection on the hot join path
- **Scenario:** NickServ is lagged. `api.services.verifyUser(nick)` rejects with a timeout. The async handler's rejection escapes into the dispatcher, which catches it (defense in depth) but the auto-op for this join is lost. In the pathological case (NickServ hung), every join during the outage loses its auto-op.
- **Evidence:** `await grantMode(...)` at line 238 has no surrounding try/catch.
- **Impact:** Silent loss of channel security during services outages.
- **Remediation:** Wrap `await grantMode` in try/catch; log and continue.

### [CRITICAL] Mode-enforce recovery cycle lock has a deadlock window

- [x] **File:** `plugins/chanmod/mode-enforce-recovery.ts:64-91`
- **Pattern:** Self-healing / State machine correctness
- **Anti-pattern:** Lock held too long
- **Scenario:** Bot is deopped. Cycle lock acquired, part scheduled for `cycle_delay_ms` (5s). A second deop arrives within the 5s window; outer handler sees lock held, exits without cycling. If the inner part-callback somehow fails to unlock, bot stays deopped forever.
- **Remediation:** Unlock immediately after scheduling the part, not after the nested rejoin callback. Or use a monotonic sequence counter.

### [CRITICAL] `pendingGetKey` map in Anope backend leaks callback closures

- [x] **File:** `plugins/chanmod/anope-backend.ts:176-195`
- **Pattern:** Steady state / Unbounded map
- **Anti-pattern:** Pending-request map without guaranteed cleanup
- **Scenario:** 100+ channels trigger `bad_channel_key` simultaneously on a ChanServ outage. Each registers a pending callback; the 10s timeout should clean up, but closures capture heavy `api`/`probeState`/`channel` objects and hold them until GC.
- **Impact:** Memory pressure on a flaky services outage.
- **Remediation:** Add a hard cap on `pendingGetKey` size; reject new requests at cap. Mirror `pendingAthemeProbes` TTL sweep pattern.

### [CRITICAL] Flood plugin sliding-window buckets never prune empty-but-present keys

- [x] **File:** `plugins/flood/sliding-window.ts:20-27`
- **Pattern:** Steady state / Unbounded growth
- **Anti-pattern:** Per-identity bucket with no TTL
- **Scenario:** Every user who ever triggers the flood checker gets a key. When their flood burst ages out, the timestamp array empties but the _key_ remains in the map. Over 90 days of user churn, the map grows to however many unique hostmasks have ever said anything in monitored channels.
- **Evidence:** `sweep()` only deletes keys where the window is _completely_ outside; empty-array keys are kept.
- **Impact:** Steady linear memory leak proportional to unique-hostmasks-ever-seen.
- **Remediation:** `sweep()` should also delete keys where `timestamps.length === 0`.

### [CRITICAL] RSS time-bind timer can overlap with itself

- [x] **File:** `plugins/rss/index.ts:83-98`
- **Pattern:** Timer discipline / Overlapping invocations
- **Anti-pattern:** Concurrent polls of same feed
- **Scenario:** A poll takes >60s because a feed is slow. The next 60s tick fires; now two async loops walk `activeFeeds` concurrently, racing on `setLastPoll` and potentially double-announcing items or writing stale cache.
- **Impact:** Duplicate announcements; cache inconsistency; polling stuck in overlap state.
- **Remediation:** Track "poll in progress" per feed; skip tick if a previous invocation is still running. Use `Promise.allSettled` with bounded concurrency.

### [CRITICAL] RSS has no circuit breaker for chronically failing feeds

- [x] **File:** `plugins/rss/index.ts:83-98`
- **Pattern:** Graceful degradation
- **Anti-pattern:** Retry without backoff, no circuit breaker
- **Scenario:** A feed's DNS is permanently broken, or the server returns 500 for a week. Every 60s the plugin retries, logs an error, retries. Logs flood; CPU wasted.
- **Remediation:** Track consecutive-failure count per feed. After N failures, exponentially back off the next attempt (doubling). Emit an operator notification when a feed crosses the threshold.

### [CRITICAL] DCC broadcast/announce doesn't guard per-session write errors

- [x] **File:** `src/core/dcc/index.ts:1119, 1127`
- **Pattern:** Error containment / Bulkheading
- **Scenario:** One DCC session's socket is half-open. `session.writeLine()` throws during `broadcast()`; the unhandled exception halts the loop, silencing party-line chat to all sessions after the broken one.
- **Remediation:** Wrap per-session writes in try/catch inside the broadcast loop; mark the failing session stale and close it.

### [CRITICAL] DCC auth-tracker `banCount` never decrements on success

- [x] **File:** `src/core/dcc/auth-tracker.ts:91-95` (also observed identically in `src/core/botlink/auth.ts:295`)
- **Pattern:** Steady state / Permanent escalation
- **Anti-pattern:** Backoff amplification without reset
- **Scenario:** Legitimate user fails scrypt once on a typo, succeeds on retry. `failures` resets but `banCount` stays at 1. Next typo escalates to 2x the base backoff. Over months of occasional typos, real users get locked out with escalating durations.
- **Impact:** Legitimate operators slowly locked out; hostile IPs behind shared NAT get permanently blocked.
- **Remediation:** Either reset `banCount` on `recordSuccess()`, or decay it over time (halve every hour since last failure). Cap `banCount` at ~8.

### [CRITICAL] Botlink leaf has no handshake timeout

- [x] **File:** `src/core/botlink/leaf.ts:263-296`
- **Pattern:** Integration point timeout
- **Anti-pattern:** Asymmetric timeout (hub has 10s, leaf has none)
- **Scenario:** Leaf connects, sends HELLO, hub crashes before sending WELCOME. Leaf waits forever — no heartbeat started yet, no `onClose` unless the kernel eventually notices the half-open socket.
- **Remediation:** Arm a 15s deadline after sending HELLO; on timeout, close the socket and schedule reconnect.

### [CRITICAL] Botlink leaf reconnect has no jitter — thundering herd on hub restart

- [x] **File:** `src/core/botlink/leaf.ts:376-387`
- **Pattern:** Retry discipline / Thundering herd
- **Anti-pattern:** Exponential backoff without jitter
- **Scenario:** Hub crashes. 20 leaves all disconnect within 1s and schedule reconnect for exactly `+5s`. Hub recovers; all 20 hit it simultaneously. `max_pending_handshakes` saturates; IPs get auth-banned by the hub's own defense.
- **Remediation:** `delay = base * (0.5 + 0.5 * Math.random())`.

### [CRITICAL] Botlink pending-command map has no cap

- [x] **File:** `src/core/botlink/pending.ts:22-29`
- **Pattern:** Steady state / Unbounded map
- **Scenario:** Under sustained command-relay load while the hub is laggy, the pending map accumulates entries faster than timeouts reclaim them (the event loop can be backed up).
- **Remediation:** Enforce `CMD_TIMEOUT_MS` bounds validation; add a `MAX_PENDING` cap; reject new relays when at cap.

### [CRITICAL] Seen plugin grows unbounded per channel

- [x] **File:** `plugins/seen/index.ts:49-61, 132-153`
- **Pattern:** Steady state
- **Scenario:** Every pubm writes a record. An active channel with 500 users over 90 days accumulates ~36k+ rows. `cleanupStale()` is a full-scan and only removes rows past `max_age_days`. After a year of growth, cleanup scan time blocks the event loop.
- **Remediation:** **Replace-in-place** — key the record by nick (or lowered-nick) and overwrite on every pubm. Total row count is bounded by unique nicks ever seen, not message count. `.seen <nick>` already only needs the most recent entry, so no functionality is lost. The hourly `cleanupStale` still prunes records for nicks that haven't been seen in `max_age_days` but now runs over a much smaller table.

### [CRITICAL] Handler calls to NickServ `verifyUser()` have no timeout

- [x] **File:** `src/dispatcher.ts:326` → `src/core/services.ts:120`
- **Pattern:** Integration point timeout
- **Anti-pattern:** Unbounded `await` on an external actor
- **Scenario:** Bot requires `require_acc_for: ["+o"]`. NickServ is frozen. Every privileged command awaits verification; pending promises pile up; re-triggering the same command re-creates the pending entry and replaces the AbortController instead of sharing it.
- **Evidence:** `services.ts:120-136` cancels the previous pending verification when a duplicate arrives, restarting the timer.
- **Impact:** Duplicate verifications for the same nick; event loop pressure; permission checks return failures even when NickServ eventually responds on the old path.
- **Remediation:** Deduplicate by returning the existing in-flight promise for the same nick. Cap concurrent pending verifications. **On timeout, fail closed:** deny the privileged command, reply with a clear "services unavailable, try again" notice, and increment a `.status`-visible `services_timeout_count` counter. Do not fall back to cached verification — the existing `require_acc_for` gate exists precisely to prevent impersonation during services flakes.

---

### [WARNING] Plugin teardown failure leaves partial-unload state marked but uncleaned

- [x] **File:** `src/plugin-loader.ts:395-407`
- **Pattern:** Partial init safety
- **Scenario:** `teardown()` throws halfway. `teardownFailed=true` is set but the loader continues the cleanup pipeline — the plugin is removed from `this.loaded` regardless. On reload, ghost state from the previous instance persists.
- **Remediation:** If `teardownFailed`, halt unload and require operator intervention (or at minimum, do not proceed to remove the plugin from the map).

### [WARNING] `reload()` isn't atomic: if `load()` fails after `unload()`, old plugin is lost

- [x] **File:** `src/plugin-loader.ts:445-461`
- **Pattern:** Reload under error
- **Remediation:** **Fail loud.** Do not attempt to restore the old instance — if the new code is broken, resurrecting the old one masks the breakage and the operator ends up running stale code without realizing it. Instead: when `load()` fails after `unload()` has already run, leave the plugin in the unloaded state, log a prominent error with the plugin name and error message, reply `reload failed: <error>; plugin is now unloaded — fix the code and run .load <plugin>` to the invoking session, and emit `plugin:reload_failed` on the event bus so the event is visible in `.status` / audit. Operator intervention is required, which is the correct signal for a broken plugin.

### [WARNING] Message queue dropped (not flushed) on disconnect

- [x] **File:** `src/core/connection-lifecycle.ts:230` → `messageQueue.clear()`
- **Pattern:** Graceful degradation
- **Scenario:** Netsplit drops the socket mid-burst. Queued kick/mode commands are silently discarded; bot reconnects but the operator's intent is lost. Mode enforcement divergence results.
- **Remediation:** Attempt `flush()` before `clear()` with a short deadline; drop only what can't be delivered before timeout.

### [WARNING] Channel state cleared before NAMES re-populates on reconnect

- [x] **File:** `src/core/channel-state.ts:199-223`
- **Pattern:** State resync window
- **Scenario:** `clearAllChannels()` fires on reconnect. Before NAMES repopulates, PRIVMSGs can arrive; permission checks referencing channel user state silently fail.
- **Remediation:** Buffer or reject dispatch until NAMES/ACCOUNT replay completes.

### [WARNING] Flood counters not cleared on reconnect

- [x] **File:** `src/dispatcher.ts:113-117`
- **Pattern:** Steady state / State resync
- **Scenario:** Old session's user gets flagged. Bot reconnects; first message from that user is instantly rate-limited from stale counters.
- **Remediation:** Wire `bot:disconnected` to `SlidingWindowCounter.clear()` for pub/msg flood counters.

### [WARNING] Registration timeout `client.quit()` may not trigger close on a dead socket

- [x] **File:** `src/core/connection-lifecycle.ts:160-166`
- **Scenario:** TCP connected, no IRC greeting. `client.quit()` queues a QUIT on a half-open socket; `close` event doesn't fire; reconnect driver doesn't notice; process hangs for the kernel's TCP timeout (~2.5 min).
- **Remediation:** After `quit()`, set a 5s deadline that explicitly destroys the socket if `close` hasn't fired.

### [WARNING] Infinite JOIN retries on banned/invite-only channels

- [x] **File:** `src/core/connection-lifecycle.ts:437-451`
- **Pattern:** Self-denial
- **Scenario:** Bot gets K-lined from a channel. Presence-check interval keeps retrying JOIN every 30s forever; server rate-limits the JOINs; collateral K-line risk.
- **Remediation:** Parse 471/473/474/475/477 and stop retrying permanent-failure reasons.

### [WARNING] STS failure throws synchronously from `connect()` path

- [x] **File:** `src/bot.ts:832`
- **Scenario:** STS policy exists but is unsatisfiable. `connect()` throws; the bot exits code 1 rather than code 2. Supervisor treats it as a transient crash and restart-loops forever.
- **Remediation:** Emit a `fatal`-tier close reason so the reconnect driver exits 2.

### [WARNING] Metadata JSON.parse in `getModLog` / ban-store migration / admin-list-store is unguarded

- [x] **Files:** `src/database.ts:393`, `src/core/ban-store.ts:130`, `src/utils/admin-list-store.ts:52`
- **Scenario:** A single corrupted row (interrupted write, manual edit, bad botlink relay) poisons every `.modlog` query, every `.bans` listing, or every startup migration.
- **Remediation:** Wrap each parse in try/catch; skip bad rows with a warning log and continue.

### [WARNING] `ListenerGroup.removeAll()` exits on first `off()` throw

- [x] **File:** `src/utils/listener-group.ts:38-47`
- **Scenario:** One listener's removal throws; remaining listeners stay attached and fire on the next event, racing with new listeners from the reconnected session.
- **Remediation:** Wrap each `removeListener` / `off` in try/catch; always complete the loop.

### [WARNING] `plugin-loader` listener-cleanup loops have the same fail-stop issue

- [x] **File:** `src/plugin-loader.ts:421-425, 429-435`
- **Remediation:** Same — per-entry try/catch with error log.

### [WARNING] DCC socket write during `close()` races against concurrent destroy

- [x] **File:** `src/core/dcc/index.ts:815-817`
- **Scenario:** `close()` checks `!socket.destroyed`, then writes, then destroys. A concurrent `close` event between the check and the write can make the write throw.
- **Remediation:** Wrap the farewell write in try/catch; destroy regardless.

### [WARNING] DCC pending server leaks on listen `error`

- [x] **File:** `src/core/dcc/index.ts:1360-1364`
- **Scenario:** `server.on('error')` releases port and pending map entry but does _not_ call `server.close()`. The server object — and its FD — leak.
- **Remediation:** Add `server.close()` in the error branch.

### [WARNING] DCC console-flag store never cleaned up

- [x] **File:** `src/core/dcc/index.ts:528-530`
- **Pattern:** Steady state
- **Scenario:** Every handle that ever connects accumulates a kv row for console-flag state. No TTL, no pruning on `user:removed`.
- **Remediation:** Delete the kv row on `user:removed`; consider a max-age sweep.

### [WARNING] DCC max-sessions check runs _before_ duplicate-eviction

- [x] **File:** `src/core/dcc/index.ts:1242-1246`
- **Scenario:** User has two zombie sessions. Tries a third with `max_sessions=2`. Limit check rejects before eviction would have freed a slot.
- **Remediation:** Swap order — `checkNotAlreadyConnected()` first, then `checkSessionLimit()`.

### [WARNING] Scrypt password verification blocks the event loop

- [x] **Files:** `src/core/dcc/index.ts:758`, `src/core/password.ts`
- **Scenario:** Under a burst of DCC auth attempts, each ~100ms scrypt blocks all other IRC processing for that window.
- **Remediation:** Confirm `verifyPassword()` uses `crypto.scrypt` (async callback), not `scryptSync`. If not, move to a worker thread.

### [WARNING] Hub `releasePending` called before `acceptHandshake` rejects

- [x] **File:** `src/core/botlink/hub.ts:514-521`
- **Scenario:** `finish('ok')` releases the pending slot counter _before_ `acceptHandshake` runs. If accept rejects synchronously and `onClose` fires synchronously, the same IP can immediately open a second slot before the first rejection propagates. `max_pending_handshakes` is bypassable.
- **Remediation:** Move `releasePending` after `acceptHandshake` completes.

### [WARNING] Hub `onSyncRequest` callback can throw mid-sync, leaving leaf stuck

- [x] **File:** `src/core/botlink/hub.ts:601-607`
- **Scenario:** `SYNC_START` sent; `onSyncRequest` throws (permissions undefined, etc.); `SYNC_END` never sent. Leaf waits forever in sync phase while hub has moved to steady state — asymmetric state.
- **Remediation:** Wrap the callback invocation in try/catch; always send `SYNC_END` (even with an `ERROR` frame).

### [WARNING] Botlink leaf silently stops on ERROR frame during handshake without onDisconnected

- [x] **File:** `src/core/botlink/leaf.ts:288-295`
- **Scenario:** Hub rejects with `AUTH_FAILED`; leaf closes socket and returns without calling `onDisconnected`. Any bot code relying on disconnect notifications (watchdog, DCC sync tracker) is stale.
- **Remediation:** Always call `onDisconnected` before returning.

### [WARNING] RSS parser instance is shared across polls with stale timeout config

- [x] **File:** `plugins/rss/index.ts:62`
- **Remediation:** Pass timeout as a parameter into each fetch, not a parser-level field.

### [WARNING] RSS `dns.lookup` has no explicit timeout

- [x] **File:** `plugins/rss/url-validator.ts:103`
- **Scenario:** Slow resolver hangs `!rss add` indefinitely.
- **Remediation:** `Promise.race` with a 5s timeout.

### [WARNING] Flood `teardown()` doesn't lift scheduled bans

- [x] **File:** `plugins/flood/index.ts:289-293`
- **Scenario:** Reload cancels ban-lift timers; the bans become permanent until the 60s sweep picks them up on next load.
- **Remediation:** Call `enforcement.liftExpiredBans()` in teardown.

### [WARNING] Flood enforcement actions fire-and-forget without per-channel queue

- [x] **File:** `plugins/flood/enforcement-executor.ts:71`
- **Pattern:** Self-denial
- **Scenario:** A flood burst dispatches 100+ mode/kick actions in ~1s; IRC server rate-limits and K-lines the bot.
- **Remediation:** Bounded per-channel action queue; respect `messageQueue` drain semantics.

### [WARNING] Chanmod `probeState.probeTimers` uses array-splice during callback iteration

- [x] **File:** `plugins/chanmod/chanserv-notice.ts:152-153`
- **Scenario:** Concurrent timer-fires splice a shared array, index-shifting clobbers other removals. Timers leak.
- **Remediation:** Use a `Set<Timer>` instead; `delete(timer)`.

### [WARNING] Takeover-detect ring buffer capped at 200 hard-coded

- [x] **File:** `plugins/chanmod/takeover-detect.ts:107-109`
- **Scenario:** Sustained attack of 200+ unauthorized ops in the window truncates early events; attack history incomplete for forensics.
- **Remediation:** Make the cap a chanset; default higher (1000).

### [WARNING] Modlog pager state never cleared on DCC disconnect

- [x] **File:** `src/core/commands/modlog-commands.ts:73` (pagers map)
- **Scenario:** Handle disconnects mid-pager; state lingers indefinitely until the same handle reconnects.
- **Remediation:** Wire DCC-session-end to `clearPagerForSession`.

### [WARNING] `countModLog()` re-runs on every page-nav verb

- [x] **File:** `src/core/commands/modlog-commands.ts:322`
- **Scenario:** On a 10M-row `mod_log`, every `.modlog next/prev` does a `SELECT COUNT(*)` with the filter. Response time grows linearly.
- **Remediation:** Cache count in pager state; refresh only on `.modlog top`.

### [WARNING] Mod-log retention prune runs synchronously at `open()`

- [x] **File:** `src/database.ts:572-580`
- **Scenario:** Operator sets retention from infinite to 30 days after 2 years of logs. Startup blocks for minutes on a single massive DELETE holding the write lock.
- **Remediation:** Background task doing `DELETE ... LIMIT 10000` incrementally.

---

### [INFO] Timer-bind error handlers log but never auto-disable failing handlers

- [x] **File:** `src/dispatcher.ts:269-275` — timer keeps firing forever; log spam is the only signal.
- **Remediation:** Counter + threshold; auto-unbind after N consecutive failures.

### [INFO] Config JSON parse is unguarded at `index.ts:78`

- [x] **File:** `src/index.ts:78` — malformed `package.json` kills startup without a clear message.

### [INFO] REPL readline promise chain uses `.finally()` without `.catch()`

- [x] **File:** `src/repl.ts:85-88` — silent hang if `handleLine` rejects outside its own try.

### [INFO] Plugin temp-file cleanup uses silent catches

- [x] **File:** `src/plugin-loader.ts:176-182, 602-607` — orphaned `.reload-*.ts` files accumulate on reload failures.

### [INFO] RSS response body buffers up to 5MiB × concurrent feeds

- [x] **File:** `plugins/rss/feed-fetcher.ts:209-214` — peak heap on slow feeds is `maxBytes × concurrency`.

### [INFO] RSS per-feed announcement drip creates cross-feed backpressure

- [x] **File:** `plugins/rss/feed-formatter.ts:63` — 500ms-per-item forces 50 feeds × 5 items = 125s wall time for `!rss check all`.

### [INFO] CTCP plugin response flood is contained at the bridge, not the plugin

- [x] **File:** `src/irc-bridge.ts:468-469` — correct design; documentable in CTCP README.

### [INFO] Greeter has no massjoin debounce

- [x] **File:** `plugins/greeter/index.ts:102-134` — netsplit heal with 50 rejoins spams 50 notices.
- **Remediation:** Track per-channel join rate; suppress greetings during burst.

### [INFO] Help cooldown map uses size-triggered sweep (not time-triggered)

- [x] **File:** `plugins/help/index.ts:118-130` — benign but grows up to 1000 before first sweep.

### [INFO] Fanout (e.g. hub rate-limit drop) inconsistently reports failure

- [x] **File:** `src/core/botlink/hub.ts:639-653` — CMD rate-limit sends ERROR, PARTY_CHAT silently drops.

### [INFO] Relay stale-route sweep only fires on heartbeat tick

- [x] **File:** `src/core/botlink/hub.ts:764` — 0-30s cleanup latency; collision window on rapid reconnect.

### [INFO] Verify-flags silently defaults unknown flags to level 0

- [x] **File:** `src/utils/verify-flags.ts:22, 28` — operator typo in `require_acc_for` silently disables the verification gate.
- **Remediation:** Validate `require_acc_for` at config load; warn on unknown flags.

### [INFO] Wildcard matcher is `O(pattern * text)` — grief-prone but not ReDoS

- [x] **File:** `src/utils/wildcard.ts:59-103` — document bound; warn operators about excessive-`*` masks.

### [INFO] Unknown botlink frame types logged individually

- [x] **File:** `src/core/botlink/protocol.ts:196-199` — log spam under misbehaving leaf; no metric.

---

## Stable patterns found

These are the patterns the remediations should match.

- **Reconnect driver tier classification** (`src/core/reconnect-driver.ts`, `connection-lifecycle.ts`): transient/rate-limited/fatal with jitter and monotonic state, fatal exits code 2 for supervisor escalation. Exemplary.
- **Dispatcher handler error isolation** (`src/dispatcher.ts:334-341`): every handler invocation wrapped in try/catch; one bad handler does not break siblings. This is the pattern to replicate in `plugin-api-factory.ts` for event-bus listeners.
- **ListenerGroup idiom** (`src/utils/listener-group.ts`): correctly used by `connection-lifecycle`, `services`, `channel-state` to avoid listener leaks across reconnect.
- **`unref()` on long-lived timers**: message-queue drain, botlink auth sweep, DCC auth sweep — correctly marked so they don't keep the process alive.
- **Transactional schema migration** (`src/database.ts:515-537`): mod_log migration in a single transaction rolls back cleanly on interruption.
- **Sanitization at every raw-IRC seam** (`src/utils/sanitize.ts` + 40+ call sites): idempotent, correct, strips `\r\n\0`.
- **STS pre-connect enforcement** (`src/bot.ts` + `src/core/sts.ts`): reads policy from DB and refuses insecure downgrade.
- **Botlink handshake "finish closure"** (`src/core/botlink/hub.ts:486-492`): single-source-of-truth for handshake cleanup across timeout/protocol-error/close. Template for other async state machines.
- **Dispatcher `.catch()` on every bridge `dispatch()` call** (`src/irc-bridge.ts`): double-defense against promise rejection escaping the dispatcher.
- **Chanmod `CycleState` centralization** (`plugins/chanmod/state.ts:97-142`): all timers in one `Set`, `clearAll()` drains them on teardown. Template for other plugins.
- **Chanmod `markIntentional()` / `wasIntentional()`** (`plugins/chanmod/helpers.ts`): prevents the bot from fighting its own mode changes.
- **RSS wall-clock timeout + AbortController** (`plugins/rss/feed-fetcher.ts:156-160`): correct defense against slow-drip DoS.
- **RSS socket pinning against DNS rebinding** (`plugins/rss/feed-fetcher.ts:146-149`): re-validates the IP after DNS, then connects by IP.
- **RSS DOCTYPE rejection before parsing**: defends against billion-laughs / XXE.
- **Flood / dispatcher sliding-window `MAX_KEYS` cap** (`src/utils/sliding-window.ts:11`): bounds memory deliberately even under key-rotation attack (though flood plugin's local copy needs the same fix — see critical finding).
- **DCC `clearAllTimers()` single choke-point** (`src/core/dcc/index.ts:793-804`): called from every close path, idempotent.
- **Process-level handlers** (`src/index.ts:182-192`): `uncaughtException` and `unhandledRejection` fatal-exit with log.

---

## Recommendations

### Quick wins (< 5 min each)

- [x] `src/database.ts` — add `db.pragma('busy_timeout = 5000')` in `open()`. (Lets SQLite handle short contention before our code sees an error.)
- [x] `src/plugin-api-factory.ts:521-534` — wrap `wrappedListener` bodies in try/catch + logger.error.
- [x] `src/plugin-loader.ts:338-343` — log teardown errors during init-failure recovery (remove silent catch).
- [x] `src/database.ts:393` — try/catch around metadata `JSON.parse`.
- [x] `src/core/ban-store.ts:130` — try/catch around migration `JSON.parse`.
- [x] `src/utils/admin-list-store.ts:52` — catch-and-skip during `list()` deserialization.
- [x] `src/utils/listener-group.ts:38-47` — per-entry try/catch in `removeAll()`.
- [x] `src/plugin-loader.ts:421-435` — same fix in plugin-loader listener cleanup loops.
- [x] `src/core/botlink/leaf.ts:376-387` — add jitter: `delay * (0.5 + 0.5 * Math.random())`.
- [x] `src/core/botlink/leaf.ts:288-295` — call `onDisconnected` before returning on handshake ERROR.
- [x] `src/core/dcc/index.ts:1242-1246` — swap session-limit and duplicate-check order.
- [x] `src/core/dcc/index.ts:815-817` — try/catch around farewell write in `close()`.
- [x] `src/core/dcc/index.ts:1360-1364` — add `server.close()` in server error branch.
- [x] `plugins/flood/sliding-window.ts:20-27` — prune keys with empty timestamp arrays in `sweep()`.
- [x] `plugins/flood/index.ts:289-293` — call `liftExpiredBans()` in teardown.
- [x] `plugins/chanmod/auto-op.ts:238` — wrap `await grantMode` in try/catch.
- [x] `plugins/chanmod/chanserv-notice.ts:152-153` — switch `probeTimers` from array to `Set`.
- [x] `src/dispatcher.ts:113-117` — clear flood counters on `bot:disconnected`.
- [x] `src/utils/verify-flags.ts:22,28` — warn on unknown flags at config load.
- [x] `src/bot.ts:832` — emit fatal-tier close reason instead of synchronous throw.

### Medium effort (refactoring needed)

- [x] `src/core/permissions.ts:480-492` — replace full-namespace rewrite with per-record upsert inside a transaction.
- [x] `src/database.ts` — classify `SqliteError` codes and wrap critical statements. Policy: BUSY/LOCKED after the pragma-level 5s timeout → degrade (fail the command, reply "database busy", keep bot alive, spill audit writes to fallback log sink); FULL → CRITICAL log, disable writes via an in-memory flag, keep read-only handlers working, surface in `.status`; IOERR/CORRUPT → fatal exit code 2. Never treat transient lock contention as fatal.
- [x] `src/core/services.ts:120` — dedupe in-flight `verifyUser` by nick; add concurrency cap.
- [x] `src/dispatcher.ts:326` — add timeout wrapper on verification (5s default) and on command handler awaits. On verification timeout, **fail closed**: deny the privileged command with a "services unavailable" reply and increment `services_timeout_count` in `.status`. No cached fallback — the gate exists to prevent impersonation during services flakes.
- [x] `src/core/connection-lifecycle.ts:230` — implement `flush()`-with-deadline before `clear()` on disconnect.
- [x] `src/core/connection-lifecycle.ts:437-451` — parse numerics 471-477 and classify permanent vs transient; skip permanent.
- [x] `src/core/connection-lifecycle.ts:160-166` — 5s socket-destroy deadline after `client.quit()` on registration timeout.
- [x] `src/core/channel-state.ts:199-223` — coordinate with dispatcher: defer dispatch to a rejoined channel until NAMES completes.
- [x] `src/plugin-loader.ts:445-461` — fail-loud reload: on `load()` failure after `unload()` ran, leave the plugin unloaded, emit `plugin:reload_failed`, log a prominent error, and reply "reload failed; plugin is now unloaded — fix the code and run `.load`". Do not silently resurrect the old instance.
- [x] `src/plugin-loader.ts:395-407` — treat `teardownFailed` as fatal for unload.
- [x] `src/core/dcc/auth-tracker.ts` (+ `src/core/botlink/auth.ts`) — reset or decay `banCount` on success.
- [x] `src/core/dcc/index.ts:528-530` — clean up console-flag store on `user:removed`.
- [x] `src/core/dcc/index.ts:1119,1127` — guard per-session writes in broadcast/announce.
- [x] `src/core/botlink/pending.ts:22-29` — `MAX_PENDING` cap + bounds check.
- [x] `src/core/botlink/leaf.ts:263-296` — handshake deadline after HELLO.
- [x] `src/core/botlink/hub.ts:128-134` — per-leaf write-result check and retry on heartbeat.
- [x] `src/core/botlink/hub.ts:601-607` — try/catch around `onSyncRequest`; always send `SYNC_END`.
- [x] `src/core/botlink/hub.ts:514-521` — move `releasePending` after `acceptHandshake`.
- [x] `plugins/rss/index.ts:83-98` — add in-flight lock per feed; skip overlapping ticks.
- [x] `plugins/rss/index.ts` — circuit breaker per feed (failure count + backoff).
- [x] `plugins/rss/url-validator.ts:103` — `Promise.race` DNS lookup with 5s deadline.
- [x] `plugins/chanmod/mode-enforce-recovery.ts:64-91` — unlock immediately after scheduling part, not after rejoin.
- [x] `plugins/chanmod/anope-backend.ts:176-195` — cap `pendingGetKey`; sweep TTL.
- [x] `plugins/flood/enforcement-executor.ts:71` — bounded per-channel action queue.
- [x] `plugins/seen/index.ts` — replace per-event append with per-user replace-in-place keyed by lowered nick. Bounds total rows by unique nicks, not message count; `.seen <nick>` behavior is unchanged.
- [x] `src/core/commands/modlog-commands.ts:73, 322` — cache `countModLog` in pager state; wire DCC disconnect to clear pager state.

### Architectural (design changes)

- [x] `src/database.ts:572-580` — incremental background pruning for `mod_log` retention; do not block `open()`.
- [x] `src/core/services.ts` — separate NickServ-verification promise queue from the dispatch path; timeout, circuit-break, fall back to "unverified" rather than hanging commands.
- [x] `src/core/dcc/index.ts:758` / `src/core/password.ts` — verify scrypt is the async variant; if not, wrap in a worker.
- [x] Document the global plugin-API contract: event-bus listeners **must not throw** (and the API layer now enforces it with wrappers). _The wrappers landed in `plugin-api-factory.ts` — `safeInvoke` around every `onModesReady`/`onPermissionsChanged` listener catches and logs throws with the offending plugin name. Plugin API contract docs deferred to a separate doc-only PR._
- [x] Document and add a metric for: timer bind error rate, reconnect count, handler error count, leaf sync-retry count, RSS feed circuit-break state. These show up in `.status` and tell an operator whether the bot is degraded without waiting for a user report. _Partial — `.status` now reports `services-timeouts`, `pending-verifies`, `verify-cap-rejected`, `plugins`, and `failed-plugins` via the new `getStabilityMetrics()` hook in `irc-commands-admin.ts`. Timer/handler/RSS-break counters are tracked internally (dispatcher auto-disables failing timers, RSS backs off chronic failures, pending-request maps expose `droppedCount`); wiring them into `.status` is a small follow-up._
- [x] Add a `--strict-plugins` boot flag or a loud startup banner listing failed plugins — currently a broken plugin silently degrades the bot. _Startup banner chosen: `Bot.start()` now logs a prominent `===== STARTUP BANNER: N plugin(s) FAILED to load =====` line when any plugin fails during `loadAll()`, and `failedPluginNames` lands in `.status` so operators notice degraded state immediately. The `--strict-plugins` hard-fail variant is left for a separate PR if operators ask for it._
- [ ] Add a periodic state-reconciliation loop: "am I still opped in every channel I'm supposed to be opped in; is every configured feed actively polling; is NickServ responsive." Publish to `.status`. _Deferred — this is multi-hour architectural work touching chanmod, rss, services, and `.status`. Pieces of it exist today (presence check in connection-lifecycle; RSS circuit breaker self-monitors; services timeout counter in `.status`), so the failure modes are individually observable. A unified reconciliation loop is a good follow-up PR._
