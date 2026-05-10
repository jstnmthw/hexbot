# Stability Audit: hexbot (all)

**Date:** 2026-05-10
**Scope:** every `.ts` file under `src/` and `plugins/` — connection lifecycle, dispatcher, plugin loader, database, DCC, botlink, services, orchestrator, IRC commands & queue, channel state, external-call plugins (rss / ai-chat / spotify-radio), IRC-behavior plugins (chanmod / flood / topic / greeter), utilities, small plugins (8ball / ctcp / help / seen).
**Reviewers:** 12 parallel concern-area subagents, plus spot verification by parent.
**Estimated resilience:** **Medium**

## Summary

hexbot already implements most of the load-bearing Nygard stability patterns: a tier-classified reconnect driver with jitter, a frame-size-capped JSON-line botlink protocol with per-leaf rate limits, an outbound message queue with token-bucket pacing, AbortController-driven external HTTP calls, and a dispatcher that wraps every handler call in try/catch. The codebase has clearly absorbed several rounds of stability work — `flushWithDeadline`, `cancelPendingVerifies`, `unref()` on all known sweep timers, the auto-disable threshold for throwing time-binds, the IRCv3 STS persistence, the four-state bot-identify state machine.

The biggest residual fragilities are: **(1)** mutating IRC verbs (`ban`/`kick`/`mode`/`topic`/`invite`) bypass the message queue entirely and are paced only by `irc-framework`'s send buffer, leaving the bot one chanmod recovery storm away from an Excess-Flood K-line; **(2)** synchronous `process.exit(2)` calls inside the database layer's `runClassified` and inside `Bot.connect()`'s STS gate skip every teardown step and can corrupt WAL; **(3)** the botlink hub serializes large initial syncs in a single tight loop that can starve heartbeat and cascade reconnects across the fleet; **(4)** `ensureChannel` will create channel records on TOPIC/MODE for channels the bot was never in, so a hostile or misbehaving server can grow the channel-state map unbounded; **(5)** several reconcile paths (lockdown lift, post-RECOVER cleanup, deop-cycle) leave server-visible state that can't be recovered without operator action when the bot disconnects mid-flight.

Realistic survival estimates:

- A normal flaky-network week (TCP RST, ping timeout, NickServ lag): **good** — the driver, dispatcher, and queue absorb routine chaos.
- A K-line during a chanmod takeover-recovery: **poor** — the unqueued mode burst is exactly what triggers the K-line in the first place.
- A 30-minute Gemini outage on a heavily ai-chat-triggered channel: **poor** — the circuit-breaker open path fires "AI is temporarily unavailable" per direct-address message.
- A botnet hub crash with 20+ leaves: **poor** — synchronous sync replay starves heartbeat; reconvergence on the 60s rate-limited cap defeats jitter.
- A six-month uptime with no operator intervention: **fair** — `kv` table grows monotonically (no global retention); some plugin counters (`rejoin_attempts:*`, greeter `joinRates`) never prune; mod_log has retention but other namespaces don't.

**Findings:** 14 CRITICAL, 73 WARNING, 47 INFO

---

## Phases (downstream-skill checkboxes)

Each section below is a discrete review phase that produced findings. `/build` and refactoring skills can tick these off as they fix items.

- [ ] **Phase 1 — Connection lifecycle & reconnect** (`connection-lifecycle.ts`, `reconnect-driver.ts`, `close-reason-classifier.ts`, `sts.ts`, `irc-bridge.ts`)
- [ ] **Phase 2 — Dispatcher & plugin loader** (`dispatcher.ts`, `plugin-loader.ts`, `plugin-api-factory.ts`, `flood-limiter.ts`)
- [ ] **Phase 3 — Database layer** (`database.ts`, `database-errors.ts`, `mod-log.ts`, `ban-store.ts`, `admin-list-store.ts`, `settings-registry.ts`, `channel-settings.ts`)
- [ ] **Phase 4 — DCC subsystem** (`src/core/dcc/*`)
- [ ] **Phase 5 — Botlink subsystem** (`src/core/botlink/*`)
- [ ] **Phase 6 — Services & identity** (`services.ts`, `services-parser.ts`, `password.ts`, `permissions.ts`, `owner-bootstrap.ts`, `hostmask-matcher.ts`)
- [ ] **Phase 7 — Orchestrator & process handlers** (`bot.ts`, `index.ts`, `bootstrap.ts`, `process-handlers.ts`)
- [ ] **Phase 8 — IRC commands & message queue** (`irc-commands.ts`, `message-queue.ts`, `command-handler.ts`, `repl.ts`, `audit.ts`, `commands/*`)
- [ ] **Phase 9 — Channel state & ISUPPORT** (`channel-state.ts`, `isupport.ts`, `channel-presence-checker.ts`, `hostmask-matcher.ts`, `irc-event-helpers.ts`)
- [ ] **Phase 10 — External-call plugins** (`plugins/rss`, `plugins/ai-chat`, `plugins/spotify-radio`)
- [ ] **Phase 11 — IRC-behavior plugins** (`plugins/chanmod`, `plugins/flood`, `plugins/topic`, `plugins/greeter`)
- [ ] **Phase 12 — Utilities & small plugins** (`src/utils/*`, `event-bus.ts`, `logger.ts`, `plugins/{8ball,ctcp,help,seen}`)

---

## CRITICAL findings

### [CRITICAL] IRCCommands mutating verbs bypass the outbound message queue

- [ ] **Fix queue bypass in `IRCCommands` mutating verbs**
- **File:** `src/core/irc-commands.ts:175,187,232,238,252,343,370`
- **Pattern:** Self-denial via send-rate / unbounded send burst
- **Anti-pattern (Nygard):** Integration point without throttle, self-denial attack
- **Scenario:** Operator runs `.ban #foo *!*@evil` 30 times in 3 seconds during a raid; OR `BanStore.applyOnJoin` walks 50 stored bans on netjoin; OR chanmod's `performMassReop` issues `+oooo` plus `toDeop` plus `toHalfop` plus `performHostileResponse` on the same tick during a takeover recovery on a 30-flagged-user channel.
- **Impact:** The 2 msg/s steady-state queue rate (the operator's only flood protection) does not apply. Lines hit `irc-framework`'s send buffer directly. Solanum/Charybdis trip Excess Flood K-line at ~10 lines in 2 seconds, removing the bot from every channel during the moment it most needs to be present.
- **Remediation:** Route every mutating verb (`KICK`, `BAN`, `MODE`, `TOPIC`, `INVITE`, `JOIN`) through `messageQueue.enqueue(channelOrTarget, () => client.raw(line))`. `say`/`notice` already do this through the plugin-api factory; align the helper layer.

### [CRITICAL] `process.exit(2)` from inside synchronous DB reads bypasses every teardown step

- [ ] **Replace DB `process.exit(2)` with a poisoned-flag throw routed through `bot.shutdown()`**
- **File:** `src/database.ts:185`, `src/core/mod-log.ts:319` (both inside `runClassified`)
- **Pattern:** Error containment — fatal-vs-non-fatal conflation
- **Anti-pattern:** Cascading failure (DB hiccup → process exit during in-flight handlers)
- **Scenario:** A user runs `.seen somebody` (a read), the WAL emits a transient `SQLITE_IOERR_SHORT_READ` (NFS hiccup, btrfs snapshot, marginal disk). OR a background `pruneBatch` from `mod_log.pruneModLogIfConfigured` (line 657 region) hits `SQLITE_CORRUPT` on a malformed metadata row.
- **Impact:** The synchronous handler calls `process.exit(2)` mid-tick. In-flight async work (DCC writes, queued sends, RSS fetches in flight) silently aborts. `client.quit()` never sends; ban-store sinks never flush; mod_log never closes; SQLite WAL is left in inconsistent state. The supervisor restarts the bot — but next boot's startup migration may also fail, depending on what state the WAL was in.
- **Remediation:** Set `this.fatal = true; this.writesDisabled = true;` and throw `DatabaseFatalError`. Let `bot.ts`'s `step()` shutdown harness drive `db.close()` then `process.exit(2)`. Background prune already has try/catch; `runClassified` shouldn't bypass it.

### [CRITICAL] `process.exit(2)` from inside `Bot.connect()` STS gate skips full teardown

- [ ] **Route STS-refusal exit through `gracefulShutdown` so DB / plugins / hub / DCC tear down**
- **File:** `src/bot.ts:1370-1375`
- **Pattern:** Shutdown ordering / partial-init failure
- **Scenario:** Plaintext first contact to a server with an existing STS policy in `_sts`. `applySTSPolicyToConfig` throws a refusal. `bot.ts` calls `process.exit(2)` directly inside `connect()`.
- **Impact:** DB just opened (line 909), permissions loaded, plugins loaded, botlink hub started — none get torn down. SQLite WAL files dangle. Hub leaves get TCP RST instead of graceful shutdown. Plugins' open file descriptors leak. The `bot:disconnected` event is emitted right before exit but listeners don't get to run before the process dies.
- **Remediation:** Throw a typed `STSRefusalError`. Catch in `Bot.start()`, run `gracefulShutdown` with desired exit code (2). Or call `await this.shutdown()` before `process.exit(2)`.

### [CRITICAL] Re-entrant SIGTERM stacks two `shutdownWithTimeout` invocations

- [ ] **Add re-entrancy guard in `gracefulShutdown` (signal index.ts handler)**
- **File:** `src/index.ts:141-146,160-165`
- **Pattern:** Reentrant signals / shutdown ordering
- **Scenario:** systemd `TimeoutStopSec` fires SIGTERM, then a second SIGTERM 5 seconds later (operator double Ctrl-C, supervisor escalation). Both invocations call `gracefulShutdown` → `runBotShutdown` → `bot.shutdown()`.
- **Impact:** `Bot.shutdown()` self-guards via `_isShuttingDown`, so the inner work is idempotent — but `shutdownWithTimeout`'s outer 10s timer is started twice, and both invocations race `process.exit(0)`. The second invocation sees the inner shutdown return instantly (already running), then races `process.exit` against the first invocation's still-in-progress `step()` chain. A subsystem teardown can run partially, then exit yanks the process before `db.close()` completes.
- **Remediation:** Top-of-handler `if (signalHandled) return; signalHandled = true;`. Same for SIGINT.

### [CRITICAL] `unhandledRejection` → `fatalExit` chain re-rejects when `bot.shutdown()` throws

- [ ] **Wrap `shutdown()` in `shutdownWithTimeout` so inner throws don't escape**
- **File:** `src/index.ts:152-158`, `src/process-handlers.ts:35-51`
- **Pattern:** Detached promise / shutdown ordering
- **Scenario:** A plugin's `unhandledRejection` triggers `fatalExit`. `runBotShutdown().finally(() => process.exit(1))`. If `bot.shutdown()` throws (e.g. `pluginLoader.unloadAll()` rejection escaped its existing try/catch at bot.ts:1297-1301), `shutdownWithTimeout`'s `Promise.race` rejects, becoming a _new_ `unhandledRejection`. `fatalInProgress` short-circuits the second listener; `process.exit(1)` from `.finally` runs anyway — but operators see two stack traces in the journal and the original error is buried.
- **Impact:** Diagnosis confusion at 3am during incident response. The exit happens but the wrong error is the most prominent in the log.
- **Remediation:** Inner try/catch in `shutdownWithTimeout`: convert reject to resolve; log the inner failure on a dedicated channel.

### [CRITICAL] Botlink hub sync-frame flood blocks event loop and cascades reconnects

- [ ] **Chunk botlink sync via `setImmediate`/`drain` between batches**
- **File:** `src/core/botlink/hub.ts:680-691`, `src/core/botlink/relay-orchestrator.ts:157-163`
- **Pattern:** Synchronous fanout / blocked event loop / cascading failure
- **Anti-pattern:** Self-denial, dogpile/thundering herd
- **Scenario:** A botnet hub with 10k permission rows and 200 channels accepts a leaf reconnect. `acceptHandshake` calls `onSyncRequest` synchronously; the orchestrator runs three `for` loops issuing `protocol.send(f)` per row. ~10k+ `JSON.stringify` + `socket.write` + `sanitizeFrame` calls in one tick, blocking the event loop for hundreds of ms.
- **Impact:** Heartbeat ticks queue but don't fire. Other leaves' inactivity timer (`linkTimeoutMs`, default 90s) is fine for one freeze, but if the hub crashes hard and 20+ leaves reconnect simultaneously, each handshake triggers a 10k-frame sync, leaves time out mid-sync, reconnect, more sync work. Self-amplifying.
- **Remediation:** Stream sync via `setImmediate`/`queueMicrotask` between batches of ~50 frames. Or have leaf request sync after WELCOME so heartbeats can interleave. Honor socket `'drain'`.

### [CRITICAL] Botlink sync ignores `socket.write` backpressure → silent state divergence

- [ ] **Track botlink sync send-buffer; pause/resume on `'drain'`**
- **File:** `src/core/botlink/hub.ts:682,691`
- **Pattern:** Silent failure / state divergence
- **Scenario:** During the 10k-frame sync, the leaf's TCP receive buffer fills; `socket.write` returns false and bytes accumulate in the kernel's send buffer. The hub keeps calling `protocol.send(f)` regardless of the return value, then sends `SYNC_END` while late frames are still in flight (or dropped on the floor if the connection is closed).
- **Impact:** Silent permission divergence between hub and leaf. The leaf considers itself fully synced; the hub considers it fully synced. Until the next eventBus-driven mutation happens to fix the missing entries (which it might never, for `+m`/`+n` flag adds that occurred during the gap).
- **Remediation:** Check `socket.bufferedAmount`; pause and resume on `'drain'`. Add a `SYNC_DIGEST` (count + hash) the leaf can check.

### [CRITICAL] DCC port-pool double-release race after `connection`+`error` on the same listener

- [ ] **Fold pending-DCC `connection` and `error` paths into one cleanup call**
- **File:** `src/core/dcc/index.ts:1703-1724`
- **Pattern:** Resource exhaustion / port-pool corruption
- **Scenario:** A peer accepts a DCC offer (`server.once('connection')` fires → `clearTimeout(pending.timer)`, `pending.delete(port)`, `portAllocator.release(port)`). Microseconds later the same `server` emits `'error'` (late EADDRINUSE-style fault while finishing accept on Linux). Persistent error handler runs, calls `portAllocator.release(port)` _a second time_. Meanwhile a parallel offer to a different nick has marked the same port number used. The duplicate release silently frees a port owned by a different in-flight offer.
- **Impact:** EADDRINUSE on legitimate offers; listeners leaked at the OS level; pending-port pool gradually corrupted.
- **Remediation:** Track an owner-token alongside `markUsed`, or fold both paths through `cleanupPending(port)` that's a no-op if `this.pending` no longer holds that port. Detach `'error'` after `connection` fires.

### [CRITICAL] `ensureChannel` allowed for TOPIC/MODE/CHANNELINFO grows the channel map unboundedly

- [ ] **Restrict `ensureChannel` to JOIN/USERLIST/`injectChannelSync`**
- **File:** `src/core/channel-state.ts:730-738` (called from `onTopic`, `onUserlist`, `onChannelInfo`, `onJoin`)
- **Pattern:** Unbounded growth / channel-state poisoning
- **Scenario:** A hostile or misconfigured server emits `TOPIC #not-mine :foo` for a channel the bot was never in. `onTopic` calls `ensureChannel(name)` which creates a `ChannelInfo` unconditionally. The bot now believes it's tracking that channel. Same for stray MODE numerics during a netsplit re-merge.
- **Impact:** Memory grows monotonically with hostile server activity. The presence checker can't detect this because it iterates `configuredChannels` only. After months of uptime on a flaky network, channel map can hold thousands of ghost entries.
- **Remediation:** `onTopic` / `onChannelInfo` should `this.channels.get(name)` and bail if missing. `ensureChannel` only legitimate from `onJoin`, `onUserlist`, `injectChannelSync`.

### [CRITICAL] `ai-chat` circuit-open spams "AI is temporarily unavailable" during real outages

- [ ] **Map circuit-open errors to silent-with-op-notice path (parity with rate_limit)**
- **File:** `plugins/ai-chat/pipeline.ts:325-337`, `plugins/ai-chat/providers/resilient.ts:162`
- **Pattern:** Cache for graceful degradation / user-visible blast radius
- **Scenario:** Gemini returns 503 for 5 minutes. Resilient breaker opens after 5 failures. Subsequent `respond()` throws `'Circuit breaker open'` of kind `'other'`. Pipeline drops to else-branch and `ctx.reply('AI is temporarily unavailable.')` fires on user-addressed messages.
- **Impact:** Across many channels and triggered users, this is per-message channel-visible feedback every triggered turn for the duration of the outage. The rate-limit path correctly stays silent + once-per-cooldown op-notice; the circuit-open path doesn't.
- **Remediation:** Surface `'circuit_open'` as a distinct kind on `AIProviderError`; route through the same silent path as `rate_limit`.

### [CRITICAL] `Bot.start()` does not resolve until first registration succeeds — rate-limited tier holds it 5–30 min

- [ ] **Resolve `Bot.start()` after first scheduled retry; surface state via `getReconnectState()`**
- **File:** `src/core/connection-lifecycle.ts:174-184,319-322`, `src/bot.ts:1415`
- **Pattern:** Cascading failure / supervisor handshake
- **Scenario:** First boot to a network that returns `ERROR :Closing Link (Throttled)` or K-line on the very first attempt. Driver classifies as `rate-limited` (5min initial, 30min cap). `onRegistered` never runs.
- **Impact:** The promise from `Bot.start()` stays pending. `index.ts`'s `await currentBot.start()` blocks. The healthcheck file is never created (it's wired to `bot:connected`); the supervisor restart-loops on healthcheck failure precisely while the in-process driver is correctly waiting out the K-line. Net effect: no time to drain the rate-limit; the bot never connects until an operator intervenes.
- **Remediation:** Resolve `Bot.start()` after the first attempt is scheduled (success or retry). Surface live state via `getReconnectState()` so the healthcheck can report "alive but reconnecting" instead of "alive but disconnected".

### [CRITICAL] Healthcheck reports unhealthy during legitimate rate-limited reconnect → restart loop

- [ ] **Anchor healthcheck to process+driver liveness, not active IRC connection**
- **File:** `src/index.ts:113-116`
- **Pattern:** Cold-start invariants / supervisor signal handshake
- **Scenario:** Bot is connected, gets K-lined, enters the rate-limited tier (300s initial, doubling to 1800s cap). `stopHeartbeat` runs on `bot:disconnected`, removing `/tmp/.hexbot-healthy`. Any healthcheck cadence shorter than the reconnect delay reports unhealthy → supervisor restarts the bot mid-backoff → fresh attempt → instant K-line → loop.
- **Impact:** Restart loop competes with K-line auto-expiry; the operator's careful 30-min backoff is defeated by 1-min healthcheck interval.
- **Remediation:** Heartbeat should report "alive" if the process is up and the reconnect driver is in a known state (`reconnecting`, `degraded`, or `connected`). Only `stopped` or unresponsive process should trigger restart.

### [CRITICAL] STS policy revocation (`duration=0`) is blocked over plaintext

- [ ] **Allow `duration=0` STS revoke from any session**
- **File:** `src/core/connection-lifecycle.ts:457-513` (~501), `src/core/sts.ts:68-91,149-154`
- **Pattern:** STS persistence / one-way pinning
- **Scenario:** A network needs to retire its STS policy (e.g. discontinuing TLS-only enforcement). They issue `sts=duration=0` over plaintext. The lifecycle ingestion path's "plaintext + duration-only" guard refuses.
- **Impact:** Operators relying on the network's STS revocation cannot revoke from plaintext. The only recovery is a manual DB edit. STS is currently one-way: settable, not revocable.
- **Remediation:** Allow `duration=0` through to `STSStore.put` regardless of plaintext. The `del` path is safe — it doesn't mutate anything attacker-controlled (the attacker could just refuse to advertise).

### [CRITICAL] Connection lifecycle `onClose` runs `messageQueue.flushWithDeadline` after STS upgrade decision

- [ ] **Clear queue (don't flush) on STS-upgrade close path**
- **File:** `src/bot.ts:1463-1485` (`onSTSDirective`), `src/core/connection-lifecycle.ts:362-369` (onClose)
- **Pattern:** Cascading failure / cleartext leak
- **Scenario:** Plaintext first contact to a server with `sts=port=6697,duration=2592000`. Bot decides to upgrade, calls `client.quit('STS upgrade')`, queued PRIVMSGs from `messageQueue` are still in `flushWithDeadline(100)` from `onClose`. The 100ms drain can flush a queued op or an in-flight reply _over plaintext_ between the upgrade decision and the new TLS connect.
- **Impact:** A queued `.adduser nick *!*@host` setting a password, or a plugin reply containing token material, can leak to a passive observer during the upgrade transition.
- **Remediation:** When `onSTSDirective` mutates config to upgrade, call `messageQueue.clear()` _before_ `client.quit()`. Skip the `flushWithDeadline` on this specific disconnect path.

---

## WARNING findings

### Phase 1 — Connection lifecycle

- [ ] **W1.1 — `client.quit('Registration timeout')` race against late `'irc error'` overwrites `lastCloseReason`** (`connection-lifecycle.ts:215,328-339`). Late server ERROR re-classifies as `rate-limited` (5min) instead of `transient` (1s). _Remediation:_ lock `lastCloseReason` once `'registration timeout'` is set.
- [ ] **W1.2 — Single SASL-fail event triggers `process.exit(2)` with no retry budget** (`close-reason-classifier.ts:33-34`, `reconnect-driver.ts:168-174`). A transient SASL race (services restart mid-auth) can take the bot down indefinitely. _Remediation:_ fatal-after-3-consecutive-without-registration-between, not single-shot.
- [ ] **W1.3 — `identify_before_join` await not cancellable on shutdown** (`connection-lifecycle.ts:285-307`). On `removeListeners()` mid-await, the inner timer + EventBus once-listeners survive; `joinConfiguredChannels` runs against a torn-down client.
- [ ] **W1.4 — `STSStore.get()` deletes expired rows during a read with no try/catch** (`sts.ts:107-141`). Transient `SQLITE_BUSY` at boot blocks `Bot.start()`.
- [ ] **W1.5 — `connect()` synchronous throw bypasses `'connecting'` event; registration timer leaks across retries** (`connection-lifecycle.ts:206-235`). Stale destroy fires against a new connection.
- [ ] **W1.6 — `messageQueue.clear()` runs before `cancelPendingVerifies`; DB throw inside `onClose` wedges reconnect** (`connection-lifecycle.ts:362-369`). Single-point catastrophic: no reconnect ever scheduled. _Remediation:_ per-step try/catch in `onClose`.
- [ ] **W1.7 — `cancelReconnect()` does not stop registration timer or presence timer** (`connection-lifecycle.ts:404-406`). Partial shutdown leaks timers.
- [ ] **W1.8 — Transient-tier exponential cap math (`2 ** consecutiveFailures`) blows up at `>= 50`** (`reconnect-driver.ts:117-126`). Clamped by `Math.min`, but the calculation is fragile.
- [ ] **W1.9 — `onSocketError` does not schedule fail-safe close-watchdog** (`connection-lifecycle.ts:375-381`). TLS handshake-stage RST may strand bot with no scheduled retry.
- [ ] **W1.10 — DNS ENOTFOUND classified as `transient`, retried every 1-30s forever** (`close-reason-classifier.ts:82-94`). Operator typo in `irc.host` → DNS hammered. _Remediation:_ ENOTFOUND on first attempt → fatal; after a successful registration → rate-limited.

### Phase 2 — Dispatcher & plugin loader

- [ ] **W2.1 — `dispatch()` iterates `this.binds` array without snapshot — handler-side `unbindAll` reentrancy is undefined** (`dispatcher.ts:362-398`). Mid-dispatch `.disable` self-unbind causes index skip; with `await` between handlers, reassignment of `this.binds` opens microtask race. _Remediation:_ `const snapshot = this.binds.slice()` at top of loop.
- [ ] **W2.2 — `unloadAll()` partial-failure recovery silently force-deletes without dispatcher cleanup** (`plugin-loader.ts:588-601`, `unload()` 552-569). Throwing teardown leaves binds/listeners attached, plugin removed from `loaded` map. Ghost handlers fire post-unload.
- [ ] **W2.3 — No circuit breaker for non-timer handlers throwing on every event** (`dispatcher.ts:389-396`). 100 msgs/min at a broken `pubm` handler = 100 stack traces/min in logs forever. Timer binds get auto-disable; pub/msg/raw don't.
- [ ] **W2.4 — Disposed-API guard cannot reach the user-supplied handler closure** (`plugin-api-factory.ts:282-294`). Plugin's own `setInterval` outliving teardown calls `myHandler` against a torn-down api. The doc/comment overstates the guard's reach.
- [ ] **W2.5 — `setCommandRelay` re-wire doesn't track per-call eventBus reference** (`hub.ts:236-298`). Re-wire with a different bus reference leaks listeners on the original. (Currently latent; orchestrator passes the same bus.)
- [ ] **W2.6 — Flood `warned` Set FIFO eviction breaks one-time-per-window guarantee under cap** (`flood-limiter.ts:147-152`). 8193rd flooder evicts oldest warned nick → duplicate notice on rotation.

### Phase 3 — Database layer

- [ ] **W3.1 — `getAllBans()` and `liftExpiredBans()` are unbounded scans of monotonically growing namespace** (`ban-store.ts:109-110,144`). After a year of anti-flood activity, `_bans` holds 50k-500k records. Sweep is O(n) per timer tick. _Remediation:_ min-heap on `(expires, key)` updated in `storeBan`/`removeBan`.
- [ ] **W3.2 — `setAuditFallback` sink is wired in type signature but never connected by the bot** (`database.ts:139`, `mod-log.ts:272`). Disk-full writes drop silently with no fallback. Either delete the dead code or wire a default ring-buffer sink in `bot.ts`.
- [ ] **W3.3 — Schema migration runs unconditionally inside constructor without batching** (`mod-log.ts:255,558-581`). 2M-row mod*log migration holds write lock and blocks bot for tens of seconds. \_Remediation:* batched copy via `setImmediate` like the prune already does.
- [ ] **W3.4 — `permissions.listUsers()` walks whole namespace; botlink replace path also linear** (`permissions.ts:538,572`). 10k users * JSON.parse per call. No pagination. *Remediation:\* `db.list(ns, prefix, { limit })` and stream.
- [ ] **W3.5 — `transaction()` does not short-circuit when `writesDisabled`** (`database.ts:197`). Setup work runs uselessly; partial transaction visible in WAL.
- [ ] **W3.6 — `kv` table has no retention or pruning** (`database.ts:243-251`). `seen`, `ai-chat`, `social-tracker`, `feed-store`, `ban:`, `tokens:` all grow forever. Multi-year uptime accumulates stale state. _Remediation:_ per-namespace retention hook + periodic VACUUM.
- [ ] **W3.7 — `parseMetadataSafe` returns `null` on read but `audit:log` already emitted parsed metadata** (`mod-log.ts:58-72,439,470`). Asymmetric state for botlink relay observers.
- [ ] **W3.8 — `ban-store.ts:202-210` empty-arg catch silently drops parse errors during legacy migration**. Silent data loss; no audit row.

### Phase 4 — DCC subsystem

- [ ] **W4.1 — `pendingSessions` leak if `DCCSession.start()` throws before `attachLifecycleHandlers`** (`dcc/index.ts:1817-1818,435-462`). Pre-start `'error'` handler is removed before lifecycle handlers attach; an `'error'` event in that microtask gap can crash. Even if caught, session sits in `pendingSessions` forever.
- [ ] **W4.2 — Lockout/no-password `socket.write` not wrapped in try/catch** (`dcc/index.ts:1766-1768,1785-1788`). Late RST emits `'error'` after pre-handshake handler is removed → unhandled error.
- [ ] **W4.3 — `mod_log` writes during DCC auth-failure storm are synchronous** (`dcc/index.ts:1198-1209,1248-1278`). Brute-force attacker triggers O(maxFailures) inserts per identity per window; multiple identities cycling through `maxEntries=10000` saturates main loop. _Remediation:_ batch `auth-fail` rows under lockout window.
- [ ] **W4.4 — DCC sessions survive IRC reconnect; can issue commands while IRC is down** (`bot.ts:1283-1287`, `dcc/index.ts:1367-1399`). User runs `.say #foo` during reconnect; bot queues for minutes; on reconnect, stale ops issued. _Remediation:_ surface connection state to DCC prompt.

### Phase 5 — Botlink subsystem

- [ ] **W5.1 — `RateCounter.check()` is O(n) per call** (`botlink/rate-counter.ts:19-25`). `filter` reallocates on every check; under recovery storms compounds with sync-frame flood.
- [ ] **W5.2 — `BotLinkLeaf.connect()` race: socket dangles if `disconnect()` arrives mid-DNS** (`botlink/leaf.ts:120-145`). `onConnect` runs `initProtocol` despite `disconnecting === true`. _Remediation:_ `if (this.disconnecting) { socket.destroy(); return; }`.
- [ ] **W5.3 — `disconnect()` zeros `linkKey`; subsequent `connect()` (vs `reconnect()`) silently fails** (`botlink/leaf.ts:286-288,304`). Future orchestrator integrations that "stop then start" loop forever.
- [ ] **W5.4 — Pre-handshake socket has no per-frame size cap; attacker can drive `JSON.parse` + `sanitizeFrame` on 64KB junk for 10s** (`hub.ts:443-482`, `protocol.ts:213`). Sustained-load CPU consumption per attacker connection. _Remediation:_ cap pre-handshake frame to 4KB.
- [ ] **W5.5 — `frameDispatchContext()` rebuilt per frame** (`hub.ts:715-739,750`). 300 frames/s = 300 closures/s; major-GC pressure. _Remediation:_ build once at `setCommandRelay`/`acceptHandshake`.
- [ ] **W5.6 — `BotLinkProtocol`'s `'line'` listener has no max-queue check** (`protocol.ts:216-252`). `onFrame` is fire-and-forget; slow consumer + fast peer queues lines in readline buffer.
- [ ] **W5.7 — Sync replay relies on idempotent upsert but does not detect frame loss** (`hub.ts:680-691`). Combined with W5 backpressure issue above; flag together.
- [ ] **W5.8 — Reconnect storm against per-IP `max_pending_handshakes=3` self-DoSes NAT'd fleets** (`auth.ts:326`, `leaf.ts:519-542`). All leaves through one WireGuard exit IP queue 3-at-a-time.

### Phase 6 — Services & identity

- [ ] **W6.1 — `verifyUser` ACC→STATUS retry doesn't reset 5s timeout** (`services.ts:610-632`). Misconfigured `services.type` causes false-positive `nickserv-verify-timeout` rows where the diagnostic should be "backend mismatch retried".
- [ ] **W6.2 — `pendingGhostResolver` not cleared if GHOST notice arrives after 1.5s timer** (`services.ts:579-584,773-790`). Generation race on rapid second reclaim resolves new attempt early using stale ack.

### Phase 7 — Orchestrator & process

- [ ] **W7.1 — `process.on` handlers attached after `main()` is invoked — order-fragile** (`index.ts:160-225,235`). Future refactor adding `await` at module top-level opens window where early throw bypasses handlers.
- [ ] **W7.2 — Bootstrap throw exits via `process.exit(1)` before logger exists; stderr line lacks systemd priority** (`bot.ts:222-227,1607-1664`). `journalctl -p err` filters miss bootstrap failures.
- [ ] **W7.3 — No supervisor ready-signal (no `sd_notify`)** (`index.ts:106-122`). systemd `Type=notify` cannot be used; "started" reported on fork return, not on connect.
- [ ] **W7.4 — `.restart` command `process.exit(0)` after `bot.shutdown()` — no `stopHeartbeat()`** (`bot.ts:1082-1085`). Healthcheck file may not be removed on restart.
- [ ] **W7.5 — No `process.on('warning')` or `'beforeExit'` handlers** (`index.ts`). MaxListeners-exceeded warnings during plugin reload accumulate silently.
- [ ] **W7.6 — Plugin-load failure logged loud but does not change exit posture** (`bot.ts:971-976`). No way to opt into "fail-fast on any plugin error" for CI/staging.

### Phase 8 — IRC commands & queue

- [ ] **W8.1 — `messageQueue.flush()` on shutdown drains synchronously without deadline** (`message-queue.ts:168-173`, `bot.ts:1322`). 200 queued lines hit kernel TCP buffer in microseconds → server K-lines on burst right before QUIT → restart connects into K-line.
- [ ] **W8.2 — `client.quit()` after `flush()` may not sequence QUIT after the burst** (`bot.ts:1322-1334`). 500ms `setTimeout` is not a drain; burst can reorder past QUIT.
- [ ] **W8.3 — REPL `process.exit(0)` from `rl.on('close')` skips Promise.catch** (`repl.ts:115-119`). `bot.shutdown()` rejection becomes unhandled; bot zombies.
- [ ] **W8.4 — REPL has no `process.stdin.on('error')` handler** (`repl.ts:51-122`). EPIPE on stdout (parent dies, `tee` closes early) crashes the bot.
- [ ] **W8.5 — `.modlog`, `.bans`, `.users`, `.binds` reply with unbounded `lines.join('\n')`** (`ban-commands.ts:84-101`, `modlog-commands.ts:730-734`, `permission-commands.ts:228-241`, `dispatcher-commands.ts:60-77`). Botlink-relayed dot-commands re-emit lines via origin `ctx.reply`; 200 lines @ 2/s = 100s drain → hits per-target queue cap (50) → silent truncation.
- [ ] **W8.6 — `runEnd` (`.modlog end`) walks full result set with O(N/PAGE_SIZE) synchronous queries** (`modlog-commands.ts:663-684`). 1M-row mod_log → 100k SQLite queries blocks event loop. PING TIMEOUT.
- [ ] **W8.7 — `messageQueue.setRate(0, ...)` silently coerces 0 to default 2** (`message-queue.ts:229-239`, `bot.ts:570-572`). Operator can't disable queue; misconfiguration silent.
- [ ] **W8.8 — `IRCCommands.mode()` parse-failure throws to caller; ban-commands runs synchronously without try/catch** (`irc-commands.ts:98-108,301-306,358-364`, `ban-commands.ts:154`). Unhandled throw on hot path can take down dispatcher.
- [ ] **W8.9 — `.bot <self> .<cmd>` recursion is not limited** (`botlink-commands.ts:581-583`). Self-targeted relay of `.bot myself .bot myself ...` is unbounded recursion. _Remediation:_ add `bot` to `BOT_RELAY_FORBIDDEN_COMMANDS`.
- [ ] **W8.10 — `.audit-tail` listener leaks closure over stale REPL ctx if shutdown order goes wrong** (`modlog-commands.ts:548-557`, `repl.ts:147`). Latent because there's only one REPL per process.

### Phase 9 — Channel state & ISUPPORT

- [ ] **W9.1 — RPL_CHANNELMODEIS (324) parses `+l` param without finite/positive guard** (`channel-state.ts:577,591`). Server with non-numeric param sets `ch.limit = NaN`, poisoning every comparison forever. _Remediation:_ reuse `parseInt + Number.isFinite` guard from `processChannelMode`.
- [ ] **W9.2 — Mode-array entries with missing `+`/`-` direction silently treated as remove** (`channel-state.ts:411,576-602`). Server emitting `'o'` (no prefix) un-tracks `+t`. _Remediation:_ skip-with-warn for malformed direction.
- [ ] **W9.3 — Reconnect mid-353: race window where `clearAllChannels` runs but late lines re-create empty records** (`channel-state.ts:280-308,498-533`). Half-stitched ghost channels until next NAMES burst.
- [ ] **W9.4 — NICK collision overwrites without warning** (`channel-state.ts:377-406`). Netsplit merge: existing `Bob` overwritten by `Alice`-renamed-to-Bob; account/away vanish. Security-relevant under `$a:` matching.
- [ ] **W9.5 — Per-PART O(channels) iteration to determine residual presence** (`channel-state.ts:310-345`). Netsplit recovery: 5000 PARTs × 100 channels = 500k iterations. _Remediation:_ reverse `nick → Set<channel>` index.
- [ ] **W9.6 — Drift detection runs only against `configuredChannels`** (`channel-presence-checker.ts:80-119`). Run-time `.join #help` is invisible; netsplit losing the bot from `#help` is never reconciled. _Remediation:_ secondary pass over `getAllChannels()`.
- [ ] **W9.7 — TARGMAX parser silently coerces malformed pairs** (`isupport.ts:170-186`). `TARGMAX=PRIVMSG:` (empty) → `Infinity`; `:0` rejected silently. _Remediation:_ warn-and-default to 1.

### Phase 10 — External-call plugins (RSS / ai-chat / spotify-radio)

- [ ] **W10.1 — RSS permanent error treated as transient on add path** (`plugins/rss/commands.ts:284-313`). Persists feeds even on 404 seed; 5 doomed polls before circuit opens. _Remediation:_ refuse persist on permanent 4xx seed failure.
- [ ] **W10.2 — RSS `!rss check` (manual all-feeds) bypasses circuit breaker** (`plugins/rss/commands.ts:382-395`). DNS outage → 10 sequential failures → 50s blocking + 10 channel notices.
- [ ] **W10.3 — ai-chat `inflightControllers.clear()` after abort doesn't await fetch unwind; stale completion can release semaphore on new instance** (`providers/ollama.ts:266-271`, `providers/gemini.ts:144-149`). Per-init epoch token would gate this.
- [ ] **W10.4 — spotify-radio `!radio on` does not verify token via `getCurrentlyPlaying()` before announcing** (`plugins/spotify-radio/index.ts:269-325`). Asymmetric "Radio is on" / 50s later "Too many errors. Radio off." channel announce.
- [ ] **W10.5 — RSS per-feed staggering: feeds tick on same 60s boundary; concurrent feeds chunk-flood at minute boundary** (`plugins/rss/feed-formatter.ts:109`). Multiple feeds × 5 items each × 500ms drip can trip flood guard. _Remediation:_ jitter first poll within interval.

### Phase 11 — IRC-behavior plugins (chanmod / flood / topic / greeter)

- [ ] **W11.1 — `rejoin_attempts:<chan>` KV records never deleted** (`plugins/chanmod/protection.ts:128,154`). KV bloat across reboots; piggyback periodic prune.
- [ ] **W11.2 — Cycle-on-deop wedge on services-free networks** (`plugins/chanmod/mode-enforce-recovery.ts:87-98`). PART succeeds, JOIN blocked by mode set during 2s window, no recourse → bot AWOL until reload.
- [ ] **W11.3 — Stale `pendingRecoverCleanup` / `unbanRequested` fires `-im` on rejoin** (`mode-enforce-recovery.ts:131-134`, `protection.ts:111-113`). After PART, fast re-join can apply `-im` to wrong-state channel.
- [ ] **W11.4 — `splitActive` / `splitExpiry` not pruned by 60s time bind** (`plugins/chanmod/stopnethack.ts:99-106`). Misleading state until next mode event.
- [ ] **W11.5 — Mass re-op `+oooooooo...` not capped per recovery cycle** (`mode-enforce-recovery.ts:225-241`). 30-flagged-user channel: 6-7 MODE lines + deop/halfop/voice + hostile response in one tick → flood K-line during recovery.
- [ ] **W11.6 — Lockdown timer fires `-${mode}` after bot disconnect; if reconnect not complete, mode stranded on server forever** (`plugins/flood/lockdown.ts:154-156,168-183`). Documented in code; flagging because audit asked. _Remediation:_ persist active locks in `api.db`; re-attempt on rejoin.
- [ ] **W11.7 — `joinRates` / lockdown counters survive bot ops loss mid-window** (`plugins/flood/lockdown.ts:48-58`). Flooders set populated even when bot has no ops; semantic stale data.
- [ ] **W11.8 — `enforcement-executor inFlight` Set has detached promise race against teardown** (`plugins/flood/enforcement-executor.ts:276-281`). Brittle; add `disposed` flag at top of teardown.
- [ ] **W11.9 — Greeter `joinRates` per-channel map never pruned for departed channels** (`plugins/greeter/index.ts:145,184`). Slow leak in kilobytes/year; mirror chanmod's bot-PART/KICK pattern.

### Phase 12 — Utilities & small plugins

- [ ] **W12.1 — `eventBus.on(...)` direct (vs `trackListener`) bypasses ownership tracking** (`event-bus.ts:201-208`). Easy mistake; leaked listener never seen by `removeByOwner`.
- [ ] **W12.2 — `help.cooldown_ms` snapshot at init time; live-config inconsistent with header/footer** (`plugins/help/index.ts:82-87`). Operator runs `.set help cooldown_ms 0` and is surprised it requires reload. Documented in code; flag for UX.
- [ ] **W12.3 — `plugins/ctcp/index.ts` `CTCP PING` echoes `ctx.text` verbatim with no length cap** (`plugins/ctcp/index.ts:35-37`). Attacker sends 1KB payload → outbound NOTICE truncated mid-codepoint by server.
- [ ] **W12.4 — SOCKS5 connect timeout not configured end-to-end** (`src/utils/socks.ts`). Black-holed proxy → half-open connect indefinitely. _Remediation:_ expose `connect_timeout_ms`; verify irc-framework respects it.

---

## INFO findings (defense-in-depth, low priority)

### Phase 1

- [ ] **I1.1** STS clock-skew vulnerability — system clock backward jump can resurrect expired policy briefly (`sts.ts`).
- [ ] **I1.2** `parseSTSDirective` silently drops unknown keys — debug-log for forward compat (`sts.ts`).
- [ ] **I1.3** `cancelPendingVerifies` lacks audit `actor` — disconnect-driven audit row has no `by` field.
- [ ] **I1.4** `permanentFailureChannels` cleared on registration but no explicit assertion — add test.

### Phase 2

- [ ] **I2.1** Compile claim of duplicate `inferredName` from agent was **false** — verified single declaration at `plugin-loader.ts:374`. **Real `tsc` errors exist** in `plugin-api-factory.ts:233` (readonly drift), `tests/core/commands/ban-commands.test.ts:210`, `tests/core/permissions.test.ts:878`, `tests/helpers/mock-plugin-api.ts:83`, `tests/plugin-api-dispose.test.ts:14`, `tests/plugins/audit-coverage.test.ts:49`, `tests/plugins/chanmod-bans.test.ts:64` — all `readonly`/`Readonly<>` mismatches and stale test mocks missing `version`/`botVersion` fields. Build is broken at HEAD.

### Phase 3

- [ ] **I3.1** No write-permission check on `data/` dir at startup — operator-friendly early failure missing.
- [ ] **I3.2** `ensureOpen()` returns handle but most callers ignore — consistency.
- [ ] **I3.3** No covering `(target, channel)` index on mod_log — only relevant at million-row scale.
- [ ] **I3.4** `transaction()` has no nesting protection — runtime guard would friendlier.

### Phase 4

- [ ] **I4.1** Auth tracker O(n) eviction at maxEntries=10000 — ~100µs at cap, fine.
- [ ] **I4.2** `RangePortAllocator.allocate()` is O(range) — trivial at typical 100-port range.
- [ ] **I4.3** `setKeepAlive(true, 60_000)` set even on rate-limit-locked branch — wasted syscall.

### Phase 5

- [ ] **I5.1** `cmdRefCounter` never resets per connection — practical non-issue (`Number.MAX_SAFE_INTEGER` ≈ 285 years at 1k cmds/s).
- [ ] **I5.2** `MAX_REMOTE_PARTY_USERS=512`, `PARTY_TTL=7d` — sweep is heartbeat-driven; if all leaves disconnect, no sweeps run.
- [ ] **I5.3** `HUB_ONLY_FRAMES` enforced at fanout, not at receive — leaves can transmit `ADDUSER` and the hub silently drops.
- [ ] **I5.4** `BotLinkAuthManager.dispose()` only called from `close()` — hub crash mid-listen leaks 5-min sweep timer (unref'd).

### Phase 6

- [ ] **I6.1** Verification cap (128 MAX_PENDING_VERIFIES) lacks priority — owner's command can be denied during a spam wave.
- [ ] **I6.2** `_botIdentifyState='unidentified'` is sticky until next disconnect — momentary glitch locks bot for whole session.
- [ ] **I6.3** `verifyUser` returns `verified:false` on `'unidentified'` with no operator-visible feedback — silent dispatch denial.
- [ ] **I6.4** `permissions.findByHostmask` is O(users × hostmasks_per_user) per privileged event — botnet-scale only.
- [ ] **I6.5** `accountLookup` not wrapped in try/catch in `checkFlags` — misbehaving lookup throws into dispatch.
- [ ] **I6.6** Owner bootstrap is idempotent — verified, no fix needed; small forensic gap on re-seed.
- [ ] **I6.7** scrypt is async (libuv pool) — DCC pre-handshake gate sits ahead of it; flooding-model well-mitigated.
- [ ] **I6.8** Hostmask wildcard matcher is bounded (512 / 4096) — verified clean.
- [ ] **I6.9** Service parser regexes are anchored — verified clean.

### Phase 7

- [ ] **I7.1** `recoverableTimestamps` array module-level — survives re-`main()`, only a concern if main is ever wrapped.
- [ ] **I7.2** `printBanner` writes color codes to non-TTY — cosmetic in `journalctl`.
- [ ] **I7.3** `gracefulShutdown` writes "shutting down" before any teardown step — fine.

### Phase 8

- [ ] **I8.1** `MessageQueue.setRate()` doesn't restart timer — drain pace stays at old cadence after `.set core queue.rate`.
- [ ] **I8.2** `popNext` re-resolves cursor via `indexOf` — O(n) at hot path with many targets.
- [ ] **I8.3** `.repl-command` audit row stores trimmed line up to 256 chars — `.chpass --self <pw>` may persist literally.
- [ ] **I8.4** `flushWithDeadline` swallows per-message exceptions silently — add warn log.
- [ ] **I8.5** Per-target queue cap of 50 hardcoded — surface as `core.queue.per_target_depth`.

### Phase 9

- [ ] **I9.1** Wildcard pattern matcher is bounded — verified.
- [ ] **I9.2** `parseUserlistModes` empty-modes fallback is safe — verified.
- [ ] **I9.3** `clearAllChannels` correctly called from `onReconnecting` — verified.
- [ ] **I9.4** `presence-check` interval is `unref()`'d — verified.
- [ ] **I9.5** `extractAccountTag` handles `null`/`'*'`/empty correctly — verified.

### Phase 10

- [ ] **I10.1** RSS coalescer uses fixed 500ms inter-line drip; not config-aware.
- [ ] **I10.2** RSS `setLastPoll` not advanced on thrown-then-caught fetch — relies on circuit breaker for retry gating.
- [ ] **I10.3** ai-chat coalescer relies on entry-tracked timer cleanup; new code adding a `setTimeout` outside `pending` can leak.
- [ ] **I10.4** ai-chat `lastRateLimitOpNoticeAt` Map bounded by `joinedChannels` — implicit, document.
- [ ] **I10.5** ai-chat token-budget JSON corrupt-row reads as zero-spent — under-counts budget.
- [ ] **I10.6** spotify-radio rate-limit state survives session reconstruction — verified clean.

### Phase 11

- [ ] **I11.1** `assessThreat()` calls `Date.now()` twice per event — trivial.
- [ ] **I11.2** `chanserv-notice.ts:165-171` — `commitDeferredNoAccess` properly nulled on teardown — verified.
- [ ] **I11.3** `recentTerminal` keyed by nick (offence tracker keys by hostmask) — nick rotation defeats it.
- [ ] **I11.4** topic-restore reentrancy guard correct — verified.

### Phase 12

- [ ] **I12.1** `wildcard.ts` per-character `result += ch` — modern V8 handles via cons-strings; optional perf.
- [ ] **I12.2** `sliding-window.ts` `Array.filter` allocation per call — in-place compaction would reduce GC.
- [ ] **I12.3** `sliding-window.ts` FIFO eviction comment doesn't explain Map insertion-order assumption.
- [ ] **I12.4** `duration.ts` `\d+` unbounded but `Math.min` clamps — bound regex to `\d{1,15}`.
- [ ] **I12.5** Per-sender CTCP throttle relies entirely on outbound queue — inbound CPU is unconditional.
- [ ] **I12.6** `seen` plugin hourly sweep does two table scans — combine into one pass.

---

## Stable patterns found (templates for fixes)

These are well-implemented and worth keeping as references when fixing other paths:

- **Tier-classified close reasons with explicit labels** (`close-reason-classifier.ts`) — pure function, table-driven, fully testable. Template for any future "classify external error → policy" need.
- **`auto_reconnect: false` + driver ownership** (`reconnect-driver.ts`, `bot.ts:1553`) — clean separation; the driver is unit-testable without an IRC mock. Replicate for NickServ verify retry.
- **`ListenerGroup` for IRC client listeners** (`irc-bridge.ts:181`, `connection-lifecycle.ts:191`) — every listener registered through one helper, removed in one call. **Should be the only public path** in `event-bus.ts` too.
- **STS first-contact defense with `tls_verify=false`** (`connection-lifecycle.ts:482-489`) — refuses to pin policy from an unauthenticated TLS session.
- **Plaintext-with-existing-policy short-circuit** (`connection-lifecycle.ts:469-474`) — exemplary belt-and-braces guard.
- **Idempotency guard in `IRCBridge.attach()`** (`irc-bridge.ts:142-147`) — detects programming errors rather than silently leaking listeners.
- **Bridge `.catch()` on every dispatch call** (dispatcher invocation in irc-bridge) — handler rejection never escapes to irc-framework.
- **Timer auto-disable + minimum 10s floor** (`dispatcher.ts:237-243,247-266`) — every throwing time-bind eventually trips off.
- **Per-plugin bind hard cap with refusal** (`dispatcher.ts:197-209`) — bulkhead against runaway plugin.
- **`verifyUser()` AbortController pattern** (`services.ts:351-419`) — timeout, abort, dedup, hard cap, audit on cap breach. Single resolution path; promise can never reject.
- **`PendingRequestMap` cap + drain** (`botlink/pending.ts:63-122`) — bounded entries, cap-hit log cadence, shutdown drain so awaiters don't hang.
- **Heartbeat `tick()` stops itself before `onTimeout`** (`botlink/heartbeat.ts:72-83`) — double-fire structurally impossible.
- **Reconnect jitter** (`botlink/leaf.ts:519-527`) — 0.5–1.0× full jitter against exponential delay; thundering-herd mitigated.
- **Frame parse safety** (`botlink/protocol.ts:216-252`) — per-line size cap, unknown-type drop, recursion-capped sanitizeFrame.
- **`PermissionSyncer.applyFrame` + `injectChannelSync` are upsert-by-key** — replays do not duplicate.
- **`clearAllTimers()` choke-point in DCC** (`dcc/index.ts:950-987`) — every named listener removed by reference; heap snapshots stay clean.
- **DCC `isStale` zombie eviction** (`dcc/index.ts:550-552,1606-1621`) — handles both `closed` and `socket.destroyed` before session-limit check.
- **DCC TOCTOU between password capture and verify** (`handlePasswordLine` 891-908) — live-hash refetch + `pendingSessions` sweep on `user:passwordChanged` closes rotation race.
- **DCC per-session error boundary in `broadcast`/`announce`** (`dcc/index.ts:1448-1483`) — one stale write doesn't silence the party line.
- **DCC `MAX_LINE_BYTES` data guard** (`dcc/index.ts:470-531`) — closes "stream gigabytes without LF" pre-readline wedge.
- **DCC auth tracker `maxEntries=10000`** (`auth-tracker.ts:87-96`) — bounded under brute force, oldest-first eviction.
- **`step()` helper for shutdown** (`bot.ts:1248-1254`) — per-step try/catch; one failed step can't block subsequent.
- **`shutdownWithTimeout` with `timer.unref()`** (`process-handlers.ts:35-51`).
- **Recoverable-socket-error rate limiter** (`index.ts:184-201`) — sliding window + bounded array.
- **Reconnect driver cancellation runs first in shutdown** (`bot.ts:1258-1263`) — prevents stray timer reopening socket mid-shutdown.
- **All RSS / ai-chat / spotify-radio external fetches** wrap an `AbortController` + timeout, registered for teardown abort.
- **ai-chat resilient breaker excludes deterministic `safety` and `auth` errors** (`providers/resilient.ts:31-177`) — closes the deterministic-DoS where a crafted prompt would open the circuit on every channel.
- **`MAX_AMBIENT_CHANNELS=256` LRU cap** (`ai-chat/rate-limiter.ts:72-73,187-218`) — bounded with bot-leave forget cleanup.
- **Spotify `parseRetryAfter` clamps to `[1, 300]`** — hostile/malformed header can't pin the bot for hours.
- **Spotify `handlePollError` distinguishes auth/rate-limit/network with kill switch at 5 consecutive errors**.
- **Channel-state `attach()` uses `ListenerGroup`; `detach()` calls `removeAll()`** — no raw `client.on(...)`.
- **Wildcard matcher is hand-rolled DP, not regex** — no catastrophic backtracking; capped at 512/4096.
- **`flood-limiter` warned-set FIFO at 8192-cap** — bounded under attack.
- **Help plugin `cooldowns` Map scoped inside `init()`, keyed on `ident@host`, capped via `COOLDOWN_MAP_SWEEP_THRESHOLD=1000`, time-bind sweep backstop**.
- **`seen` plugin `MAX_TEXT_LENGTH=200` and `enforceEntryCap=10000`** — hourly sweep + size cap.
- **`Logger.SINK_WARN_THRESHOLD=8` and `removeByOwner` drain both maps** — clean sink leak detection.
- **Owner bootstrap idempotent: `getUser()` and `getPasswordHash() !== null` short-circuit re-seed**.
- **`api.ctcpResponse` flows through `sanitize()` and `messageQueue`** — outbound CTCP rate-limited.

---

## Recommendations

### Quick wins (< 1 hour each)

- [ ] **R1** — Add `signalHandled` guard to `gracefulShutdown` (W7-class, prevents SIGTERM stacking; CRITICAL #4).
- [ ] **R2** — Allow `duration=0` STS revoke from plaintext (CRITICAL #13; one-line config gate).
- [ ] **R3** — Add `bot` to `BOT_RELAY_FORBIDDEN_COMMANDS` (W8.9; one-line constant).
- [ ] **R4** — Snapshot `this.binds.slice()` at top of `dispatch()` loop (W2.1).
- [ ] **R5** — Wrap each step of `onClose` in its own try/catch (W1.6).
- [ ] **R6** — Reset 5s timeout on ACC→STATUS retry (W6.1).
- [ ] **R7** — Bound regex in `duration.ts` to `\d{1,15}` (I12.4).
- [ ] **R8** — Wrap `accountLookup` invocation in try/catch (I6.5).
- [ ] **R9** — Replace agent-2's false CRITICAL claim with the **actual** `tsc` errors (I2.1) — fix readonly drift in `plugin-api-factory.ts:233` and update test mocks adding `version`/`botVersion`.
- [ ] **R10** — Pattern-match DNS errors in `close-reason-classifier.ts` to fatal-on-first-attempt (W1.10).
- [ ] **R11** — Add length cap in CTCP PING reply (W12.3).
- [ ] **R12** — Disable healthcheck removal during reconnecting state — anchor to driver liveness (CRITICAL #11).

### Medium effort (refactoring)

- [ ] **R13** — Route every mutating `IRCCommands` verb through `messageQueue` (CRITICAL #1) — needs touching all `client.raw` sites + tests for ordering.
- [ ] **R14** — Replace DB `process.exit(2)` with `DatabaseFatalError` flow (CRITICAL #2 + #3) — needs `bot.shutdown()` integration.
- [ ] **R15** — Chunk botlink sync via `setImmediate`/`drain` (CRITICAL #6) — small loop refactor with backpressure handling.
- [ ] **R16** — Track botlink sync send-buffer for backpressure (CRITICAL #7) — needs `socket.bufferedAmount` plus optional `SYNC_DIGEST` for divergence detection.
- [ ] **R17** — Restrict `ensureChannel` to JOIN/USERLIST/inject (CRITICAL #8) — small refactor at every call site.
- [ ] **R18** — Bot.start resolution after first attempt scheduled (CRITICAL #10) — needs healthcheck redesign (R12 paired).
- [ ] **R19** — DCC `pendingSessions` add-after-start ordering + re-attach fallback `'error'` listener (W4.1).
- [ ] **R20** — DCC port-pool owner-token (CRITICAL #9).
- [ ] **R21** — `kv` table per-namespace retention hook + periodic VACUUM (W3.6).
- [ ] **R22** — Batch mod_log migration via `setImmediate` (W3.3).
- [ ] **R23** — Persist flood lockdown active-locks in `api.db`; re-attempt `-mode` on rejoin (W11.6).
- [ ] **R24** — Cap chanmod mass re-op per recovery cycle, mirroring `HOSTILE_BATCH_SIZE` (W11.5).
- [ ] **R25** — Pagination + caps on `.modlog`, `.bans`, `.users`, `.binds` reply lines (W8.5, W8.6).
- [ ] **R26** — REPL `process.stdin/stdout` error handling + `Promise.catch` on shutdown (W8.3, W8.4).
- [ ] **R27** — ai-chat surface `'circuit_open'` error kind and route to silent path (CRITICAL #9 [variant]).
- [ ] **R28** — Heartbeat-by-driver-state instead of by-IRC-connect (CRITICAL #11 + W7.4).
- [ ] **R29** — Bound RSS retry / circuit on manual `!rss check` (W10.2).
- [ ] **R30** — Spotify token verify before "Radio is on" announce (W10.4).
- [ ] **R31** — Greeter `joinRates` per-channel prune on bot PART/KICK (W11.9), mirroring chanmod.
- [ ] **R32** — chanmod cycle-on-deop fallback ladder (W11.2).

### Architectural (design changes — flag for discussion)

- [ ] **R33** — Reconcile loop for "intent vs reality": periodic check that bot is op'd in channels where config says it should be; mode `+t` enforced where chanset says so; lockdown not stranded. Currently fragmentary across plugins.
- [ ] **R34** — Single-source-of-truth for queue config — `messageQueue.setRate` should restart timer to honor config changes live.
- [ ] **R35** — Pluggable namespace retention: per-plugin TTL for `kv` rows; long-uptime invariant.
- [ ] **R36** — `eventBus.on()` deprecation — make `trackListener(owner, ...)` the only public surface to prevent ownership-bypass.
- [ ] **R37** — `sd_notify` integration for `Type=notify` units; READY=1 on connected, STOPPING=1 on shutdown, optional WATCHDOG=1.
- [ ] **R38** — Botlink reconnect-storm protection: per-IP whitelist exempts WireGuard exit; document NAT topology requirement.
- [ ] **R39** — Plugin handler circuit breaker for non-timer binds — `consecutiveFailures` counter with trip-state and `.binds` visibility (W2.3).
- [ ] **R40** — `findByHostmask` per-dispatch memo cache — only matters at >1k user scale (I6.4).
- [ ] **R41** — Operator-facing notice when verify denies a privileged command for `'unidentified'` (I6.3).

---

## Top three to fix first

1. **CRITICAL #1 — IRCCommands queue bypass.** Highest realistic blast radius (K-line during chanmod recovery storm = the bot disappears from every channel during a raid). Mechanically simple: thread mutating verbs through `messageQueue.enqueue`.
2. **CRITICAL #2 + #3 — DB and STS `process.exit(2)` bypass shutdown.** Minor refactor to throw and let the existing `step()` harness drive graceful exit. Closes a class of WAL-corruption / leak hazards.
3. **CRITICAL #6 — Botlink sync flood blocks event loop.** Fleet-wide reconvergence depends on this — a single hub crash should not cascade through 20 leaves. Chunk via `setImmediate`/`drain`; honor backpressure.
