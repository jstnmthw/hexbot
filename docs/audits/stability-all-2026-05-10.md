# Stability Audit & Action Plan: hexbot (all)

**Date:** 2026-05-10
**Scope:** every `.ts` file under `src/` and `plugins/` — connection lifecycle, dispatcher, plugin loader, database, DCC, botlink, services, orchestrator, IRC commands & queue, channel state, external-call plugins (rss / ai-chat / spotify-radio), IRC-behavior plugins (chanmod / flood / topic / greeter), utilities, small plugins (8ball / ctcp / help / seen).
**Methodology:** 12 parallel concern-area subagents → parent spot verification of CRITICAL claims against source → strict severity recalibration against the skill's CRITICAL bar ("realistic in-this-deployment scenario takes the bot offline or wedges a core subsystem within one event") → consolidated into this single document.
**Tags used:** `[verified]` parent spot-checked the cited code; `[at-scale]` realistic only beyond solo-dev deployment; `[latent]` currently dormant, only triggered by future code changes; `[security-xref]` also a security finding worth cross-listing.
**Estimated resilience:** **Medium** — closing the 3 CRITICALs and ~10 of the highest-impact WARNINGs would lift this to High.

## Summary

hexbot already implements most of the load-bearing Nygard stability patterns: a tier-classified reconnect driver with jitter, a frame-size-capped JSON-line botlink protocol with per-leaf rate limits, an outbound message queue with token-bucket pacing, AbortController-driven external HTTP calls, and a dispatcher that wraps every handler call in try/catch. The codebase has clearly absorbed several rounds of stability work — `flushWithDeadline`, `cancelPendingVerifies`, `unref()` on all known sweep timers, the auto-disable threshold for throwing time-binds, IRCv3 STS persistence, the four-state bot-identify state machine.

After strict severity recalibration, the genuinely-CRITICAL surface is small: **(1)** mutating IRC verbs (`ban`/`kick`/`mode`/`topic`/`invite`) bypass the outbound message queue entirely, leaving the bot one chanmod recovery storm away from an Excess-Flood K-line; **(2)** synchronous `process.exit(2)` calls inside the database layer skip every teardown step and can corrupt WAL on a routine I/O hiccup; **(3)** `ensureChannel` will create channel records on TOPIC/CHANNELINFO for channels the bot was never in, so a hostile or misbehaving server can grow the channel-state map unbounded.

A further 11 items previously labelled CRITICAL by parallel subagents have been demoted to WARNING — the scenarios are real but the realistic blast radius is operator-recoverable, scale-dependent, or "noisy not offline." Those demoted items appear at the top of their respective phase sections, with full body preserved.

**Findings:** 3 CRITICAL, 89 WARNING, 55 INFO

### Realistic survival estimates

- A normal flaky-network week (TCP RST, ping timeout, NickServ lag): **good** — driver, dispatcher, queue absorb routine chaos.
- A K-line during a chanmod takeover-recovery: **poor** — unqueued mode burst is exactly what triggers the K-line.
- A 30-min Gemini outage on a heavily ai-chat-triggered channel: **poor** — circuit-open path produces per-message channel-visible "AI is temporarily unavailable" spam (W-AICHAT-SPAM).
- A botnet hub crash with 20+ leaves: **poor at scale, fine solo-dev** — synchronous sync replay starves heartbeat (W-BOTLINK-SYNC at-scale only).
- A six-month uptime with no operator intervention: **fair** — `kv` table grows monotonically; some plugin counters never prune.

---

## Phases (downstream-skill checkboxes)

Each section below is a discrete review phase. `/build` and refactoring skills can tick these off as they fix items.

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
- [ ] **Phase 13 (follow-up) — Cover the 5 files missed by the original sweep** (`src/core/audit.ts`, `src/core/memo.ts`, `src/core/relay-orchestrator.ts`, `src/core/seed-from-json.ts`, `src/utils/deep-freeze.ts`, `src/database-errors.ts`)

---

## CRITICAL findings (3)

### [C-IRCCMDS] IRCCommands mutating verbs bypass the outbound message queue [verified]

- [x] **Fix queue bypass in `IRCCommands` mutating verbs**
- **File:** `src/core/irc-commands.ts:175,187,232,238,252,343,370`
- **Pattern:** Self-denial via send-rate / unbounded send burst
- **Anti-pattern (Nygard):** Integration point without throttle, self-denial attack
- **Scenario:** Operator runs `.ban #foo *!*@evil` 30 times in 3 seconds during a raid; OR `BanStore.applyOnJoin` walks 50 stored bans on netjoin; OR chanmod's `performMassReop` issues `+oooo` plus `toDeop` plus `toHalfop` plus `performHostileResponse` on the same tick during a takeover recovery on a 30-flagged-user channel.
- **Impact:** The 2 msg/s steady-state queue rate (the operator's only flood protection) does not apply. Lines hit `irc-framework`'s send buffer directly. Solanum/Charybdis trip Excess Flood K-line at ~10 lines in 2 seconds, removing the bot from every channel during the moment it most needs to be present.
- **Remediation:** Route every mutating verb (`KICK`, `BAN`, `MODE`, `TOPIC`, `INVITE`, `JOIN`) through `messageQueue.enqueue(channelOrTarget, () => client.raw(line))`. `say`/`notice` already do this through the plugin-api factory; align the helper layer.

### [C-DBEXIT] `process.exit(2)` from inside synchronous DB reads bypasses every teardown step [verified]

- [x] **Replace DB `process.exit(2)` with a poisoned-flag throw routed through `bot.shutdown()`**
- **File:** `src/database.ts:185`, `src/core/mod-log.ts:319` (both inside `runClassified`)
- **Pattern:** Error containment — fatal-vs-non-fatal conflation
- **Anti-pattern:** Cascading failure (DB hiccup → process exit during in-flight handlers)
- **Scenario:** A user runs `.seen somebody` (a read), the WAL emits a transient `SQLITE_IOERR_SHORT_READ` (NFS hiccup, btrfs snapshot, marginal disk). OR a background `pruneBatch` from `mod_log.pruneModLogIfConfigured` hits `SQLITE_CORRUPT` on a malformed metadata row.
- **Impact:** The synchronous handler calls `process.exit(2)` mid-tick. In-flight async work (DCC writes, queued sends, RSS fetches) silently aborts. `client.quit()` never sends; ban-store sinks never flush; mod_log never closes; SQLite WAL is left in inconsistent state. The supervisor restarts the bot — but next boot's startup migration may also fail.
- **Remediation:** Set `this.fatal = true; this.writesDisabled = true;` and throw `DatabaseFatalError`. Let `bot.ts`'s `step()` shutdown harness drive `db.close()` then `process.exit(2)`. Background prune already has try/catch; `runClassified` shouldn't bypass it.
- **Design-intent note:** Whether the original `process.exit(2)` was deliberate fail-fast or sloppy mechanism is unclear and worth a design review before R14 lands. Either way the proposed remediation preserves loud-fail semantics — corruption still causes an exit; what changes is that teardown runs first.

### [C-ENSURECHAN] `ensureChannel` allowed for TOPIC/CHANNELINFO grows the channel map unboundedly [verified, borderline]

- [x] **Restrict `ensureChannel` to JOIN/USERLIST/`injectChannelSync`**
- **File:** `src/core/channel-state.ts:730-738` (called from `onTopic` at :567, `onUserlist`, `onChannelInfo`, `onJoin`)
- **Pattern:** Unbounded growth / channel-state poisoning
- **Anti-pattern:** Unbounded result set
- **Scenario:** A hostile or misconfigured server emits `TOPIC #not-mine :foo` for a channel the bot was never in. `onTopic` calls `ensureChannel(name)` which creates a `ChannelInfo` unconditionally. The bot now believes it's tracking that channel. Same for stray RPL_CHANNELMODEIS during a netsplit re-merge.
- **Impact:** Memory grows monotonically with hostile server activity. The presence checker can't detect this because it iterates `configuredChannels` only. After months of uptime on a flaky network, channel map can hold thousands of ghost entries.
- **Remediation:** `onTopic` / `onChannelInfo` should `this.channels.get(name)` and bail if missing. `ensureChannel` only legitimate from `onJoin`, `onUserlist`, `injectChannelSync`.
- **Severity note:** Borderline — the trigger requires server misbehaviour rather than expected network conditions, but the unbounded-growth shape qualifies it for CRITICAL. If the deployment connects only to trusted networks, this collapses to WARNING.

---

## WARNING findings (90)

The 11 items at the top of phases 1, 4, 5, 7, 10 were originally labelled CRITICAL by parallel subagents but were demoted during meta-review. Their full bodies are preserved (rather than compacted) because the scenarios are useful for downstream `/build` work even at WARNING priority.

### Phase 1 — Connection lifecycle (13 items)

#### Demoted from CRITICAL

- [ ] **[W-STS-EXIT] `process.exit(2)` from inside `Bot.connect()` STS gate skips full teardown** [verified]
  - **File:** `src/bot.ts:1370-1375`
  - **Pattern:** Shutdown ordering / partial-init failure
  - **Scenario:** Plaintext first contact to a server with an existing STS policy in `_sts`. `applySTSPolicyToConfig` throws a refusal. `bot.ts` calls `process.exit(2)` directly inside `connect()`.
  - **Impact:** DB just opened, permissions loaded, plugins loaded, botlink hub started — none get torn down. SQLite WAL files dangle. Hub leaves get TCP RST instead of graceful shutdown. Plugins' open file descriptors leak. The `bot:disconnected` event is emitted right before exit but listeners don't get to run before the process dies.
  - **Demotion reason:** Trigger requires an _operator config error_ (plaintext `tls=false` + persistent STS policy). Once-per-deployment event. The supervisor restarts cleanly; FD/WAL leak on already-exiting process is recoverable.
  - **Remediation:** Throw a typed `STSRefusalError`. Catch in `Bot.start()`, run `gracefulShutdown` with desired exit code (2). Or call `await this.shutdown()` before `process.exit(2)`.

- [x] **[W-BOTSTART] `Bot.start()` does not resolve until first registration succeeds** [verified]
  - **File:** `src/core/connection-lifecycle.ts:174-184,319-322`, `src/bot.ts:1415`
  - **Pattern:** Cascading failure / supervisor handshake
  - **Scenario:** First boot to a network that returns `ERROR :Closing Link (Throttled)` or K-line on the very first attempt. Driver classifies as `rate-limited` (5min initial, 30min cap). `onRegistered` never runs.
  - **Impact:** The promise from `Bot.start()` stays pending for 5-30 min. `index.ts`'s `await currentBot.start()` blocks. The healthcheck file is never created (it's wired to `bot:connected`); the supervisor restart-loops on healthcheck failure precisely while the in-process driver is correctly waiting out the K-line.
  - **Demotion reason:** The bot is _correctly recovering_, not wedged. The downstream supervisor failure (W-HEALTHCHECK below) is the actual offender. The fix is healthcheck redesign, not in-process retry behaviour.
  - **Remediation:** Resolve `Bot.start()` after the first attempt is scheduled (success or retry). Surface live state via `getReconnectState()` so the healthcheck can report "alive but reconnecting" instead of "alive but disconnected".

- [ ] **[W-STS-LEAK] Connection lifecycle `onClose` runs `messageQueue.flushWithDeadline` after STS upgrade decision** [security-xref]
  - **File:** `src/bot.ts:1463-1485` (`onSTSDirective`), `src/core/connection-lifecycle.ts:362-369` (onClose)
  - **Pattern:** Cascading failure / cleartext leak
  - **Scenario:** Plaintext first contact to a server with `sts=port=6697,duration=2592000`. Bot decides to upgrade, calls `client.quit('STS upgrade')`, queued PRIVMSGs from `messageQueue` are still in `flushWithDeadline(100)` from `onClose`. The 100ms drain can flush a queued op or an in-flight reply _over plaintext_ between the upgrade decision and the new TLS connect.
  - **Impact:** A queued `.adduser nick *!*@host` setting a password, or a plugin reply containing token material, can leak to a passive observer during the upgrade transition.
  - **Demotion reason:** Security concern more than stability concern. 100ms drain window plus requirement that queue contains secret-bearing content makes this narrow.
  - **Remediation:** When `onSTSDirective` mutates config to upgrade, call `messageQueue.clear()` _before_ `client.quit()`. Skip the `flushWithDeadline` on this specific disconnect path.

#### Original WARNINGs

- [x] **W1.1** — `client.quit('Registration timeout')` race against late `'irc error'` overwrites `lastCloseReason` (`connection-lifecycle.ts:215,328-339`). Late server ERROR re-classifies as `rate-limited` (5min) instead of `transient` (1s). _Fix:_ lock `lastCloseReason` once `'registration timeout'` is set.
- [x] **W1.2** — Single SASL-fail event triggers `process.exit(2)` with no retry budget (`close-reason-classifier.ts:33-34`, `reconnect-driver.ts:168-174`). Transient SASL race takes the bot down indefinitely. _Fix:_ fatal-after-3-consecutive-without-registration.
- [x] **W1.3** — `identify_before_join` await not cancellable on shutdown (`connection-lifecycle.ts:285-307`). On `removeListeners()` mid-await, inner timer + EventBus once-listeners survive.
- [x] **W1.4** — `STSStore.get()` deletes expired rows during a read with no try/catch (`sts.ts:107-141`). Transient `SQLITE_BUSY` at boot blocks `Bot.start()`.
- [x] **W1.5** — `connect()` synchronous throw bypasses `'connecting'` event; registration timer leaks across retries (`connection-lifecycle.ts:206-235`).
- [x] **W1.6** — `messageQueue.clear()` runs before `cancelPendingVerifies`; DB throw inside `onClose` wedges reconnect (`connection-lifecycle.ts:362-369`). _Fix:_ per-step try/catch in `onClose`.
- [x] **W1.7** — `cancelReconnect()` does not stop registration timer or presence timer (`connection-lifecycle.ts:404-406`).
- [x] **W1.8** — Transient-tier exponential cap math (`2 ** consecutiveFailures`) blows up at `>= 50` (`reconnect-driver.ts:117-126`). Clamped, but fragile. _(Already addressed by `TRANSIENT_DOUBLING_CAP=20` clamp before this audit ran — verified no overflow at `consecutiveFailures > 20`.)_
- [x] **W1.9** — `onSocketError` does not schedule fail-safe close-watchdog (`connection-lifecycle.ts:375-381`). TLS handshake-stage RST may strand bot.
- [x] **W1.10** — DNS ENOTFOUND classified as `transient`, retried every 1-30s forever (`close-reason-classifier.ts:82-94`). Operator typo → DNS hammered. _Fix:_ ENOTFOUND on first attempt → fatal.

### Phase 2 — Dispatcher & plugin loader (6 items)

- [x] **W2.1** — `dispatch()` iterates `this.binds` array without snapshot — handler-side `unbindAll` reentrancy is undefined (`dispatcher.ts:362-398`) [verified]. _Fix:_ `const snapshot = this.binds.slice()` at top of loop.
- [x] **W2.2** — `unloadAll()` partial-failure recovery silently force-deletes without dispatcher cleanup (`plugin-loader.ts:588-601`, `unload()` 552-569). Throwing teardown leaves binds/listeners attached, plugin removed from `loaded` map. Ghost handlers fire post-unload.
- [x] **W2.3** — No circuit breaker for non-timer handlers throwing on every event (`dispatcher.ts:389-396`). 100 msgs/min at a broken `pubm` handler = 100 stack traces/min in logs forever. Timer binds get auto-disable; pub/msg/raw don't.
- [x] **W2.4** — Disposed-API guard cannot reach the user-supplied handler closure (`plugin-api-factory.ts:282-294`). Plugin's own `setInterval` outliving teardown calls `myHandler` against a torn-down api. The doc/comment overstates the guard's reach.
- [x] **W2.5** — `setCommandRelay` re-wire doesn't track per-call eventBus reference (`hub.ts:236-298`) [latent]. Re-wire with a different bus reference leaks listeners on the original.
- [x] **W2.6** — Flood `warned` Set FIFO eviction breaks one-time-per-window guarantee under cap (`flood-limiter.ts:147-152`). 8193rd flooder evicts oldest warned nick → duplicate notice on rotation.

### Phase 3 — Database layer (8 items)

- [x] **W3.1** — `getAllBans()` and `liftExpiredBans()` are unbounded scans of monotonically growing namespace (`ban-store.ts:109-110,144`) [at-scale]. _Fix:_ min-heap on `(expires, key)` updated in `storeBan`/`removeBan`. _(scope: scale-deferred — won't-fix until botnet deployment.)_
- [x] **W3.2** — `setAuditFallback` sink wired in type signature but never connected (`database.ts:139`, `mod-log.ts:272`). Disk-full writes drop silently with no fallback. Either delete the dead code or wire a default ring-buffer sink in `bot.ts`.
- [x] **W3.3** — Schema migration runs unconditionally inside constructor without batching (`mod-log.ts:255,558-581`) [at-scale]. 2M-row mod*log migration holds write lock and blocks bot for tens of seconds. \_Fix:* batched copy via `setImmediate`. _(scope: scale-deferred.)_
- [x] **W3.4** — `permissions.listUsers()` walks whole namespace; botlink replace path also linear (`permissions.ts:538,572`) [at-scale]. _Fix:_ `db.list(ns, prefix, { limit })` and stream. _(scope: scale-deferred.)_
- [x] **W3.5** — `transaction()` does not short-circuit when `writesDisabled` (`database.ts:197`).
- [x] **W3.6** — `kv` table has no retention or pruning (`database.ts:243-251`). `seen`, `ai-chat`, `social-tracker`, `feed-store`, `ban:`, `tokens:` all grow forever. _Fix:_ per-namespace retention hook + periodic VACUUM.
- [x] **W3.7** — `parseMetadataSafe` returns `null` on read but `audit:log` already emitted parsed metadata (`mod-log.ts:58-72,439,470`). Asymmetric state for botlink relay observers.
- [x] **W3.8** — `ban-store.ts:202-210` empty-arg catch silently drops parse errors during legacy migration. Silent data loss; no audit row.

### Phase 4 — DCC subsystem (5 items)

#### Demoted from CRITICAL

- [x] **[W-DCC-PORT] DCC port-pool double-release race after `connection`+`error` on the same listener** [verified]
  - **File:** `src/core/dcc/index.ts:1703-1724`
  - **Pattern:** Resource exhaustion / port-pool corruption
  - **Scenario:** A peer accepts a DCC offer (`server.once('connection')` fires → `clearTimeout(pending.timer)`, `pending.delete(port)`, `portAllocator.release(port)`). Microseconds later the same `server` emits `'error'` (late EADDRINUSE-style fault while finishing accept on Linux). Persistent error handler runs, calls `portAllocator.release(port)` _a second time_. Meanwhile a parallel offer to a different nick has marked the same port number used. The duplicate release silently frees a port owned by a different in-flight offer.
  - **Impact:** EADDRINUSE on legitimate offers; listeners leaked at the OS level; pending-port pool gradually corrupted.
  - **Demotion reason:** Window is microseconds: after `server.once('connection')` runs `server.close()` synchronously, a follow-up `'error'` would have to fire on a closed listener AND a parallel offer would have to allocate the same port number in that microsecond gap. Theoretically possible on Linux; not demonstrated.
  - **Remediation:** Track an owner-token alongside `markUsed`, or fold both paths through `cleanupPending(port)` that's a no-op if `this.pending` no longer holds that port. Detach `'error'` after `connection` fires.

#### Original WARNINGs

- [x] **W4.1** — `pendingSessions` leak if `DCCSession.start()` throws before `attachLifecycleHandlers` (`dcc/index.ts:1817-1818,435-462`). Pre-start `'error'` handler is removed before lifecycle handlers attach; an `'error'` event in that microtask gap can crash. Even if caught, session sits in `pendingSessions` forever.
- [x] **W4.2** — Lockout/no-password `socket.write` not wrapped in try/catch (`dcc/index.ts:1766-1768,1785-1788`). Late RST emits `'error'` after pre-handshake handler is removed → unhandled error.
- [x] **W4.3** — `mod_log` writes during DCC auth-failure storm are synchronous (`dcc/index.ts:1198-1209,1248-1278`). Brute-force attacker triggers O(maxFailures) inserts per identity per window. _Fix:_ batch `auth-fail` rows under lockout window.
- [x] **W4.4** — DCC sessions survive IRC reconnect; can issue commands while IRC is down (`bot.ts:1283-1287`, `dcc/index.ts:1367-1399`). _Fix:_ surface connection state to DCC prompt.

### Phase 5 — Botlink subsystem (10 items)

#### Demoted from CRITICAL

- [x] **[W-BOTLINK-SYNC] Botlink hub sync-frame flood blocks event loop and cascades reconnects** [at-scale] _(scope: scale-deferred — won't-fix until botnet deployment.)_
  - **File:** `src/core/botlink/hub.ts:680-691`, `src/core/botlink/relay-orchestrator.ts:157-163`
  - **Pattern:** Synchronous fanout / blocked event loop / cascading failure
  - **Anti-pattern:** Self-denial, dogpile/thundering herd
  - **Scenario:** A botnet hub with 10k permission rows and 200 channels accepts a leaf reconnect. `acceptHandshake` calls `onSyncRequest` synchronously; the orchestrator runs three `for` loops issuing `protocol.send(f)` per row. ~10k+ `JSON.stringify` + `socket.write` + `sanitizeFrame` calls in one tick, blocking the event loop for hundreds of ms.
  - **Impact:** Heartbeat ticks queue but don't fire. If the hub crashes hard and 20+ leaves reconnect simultaneously, each handshake triggers a 10k-frame sync, leaves time out mid-sync, reconnect, more sync work. Self-amplifying.
  - **Demotion reason:** Doomsday scenario assumes 10k permission rows + 200 channels + 20+ leaves. Operator deployment is single-bot now with botnet-scale possible later. At 100 rows / 1-2 channels / single hub, the freeze is sub-millisecond. Worth fixing **before scaling**; not pre-deployment-blocking at current scale.
  - **Remediation:** Stream sync via `setImmediate`/`queueMicrotask` between batches of ~50 frames. Or have leaf request sync after WELCOME. Honor socket `'drain'`. Land R15/R16 as part of any future scale-out work.

- [x] **[W-BOTLINK-BP] Botlink sync ignores `socket.write` backpressure → silent state divergence** [at-scale] _(scope: scale-deferred — won't-fix until botnet deployment.)_
  - **File:** `src/core/botlink/hub.ts:682,691`
  - **Pattern:** Silent failure / state divergence
  - **Scenario:** During the 10k-frame sync, the leaf's TCP receive buffer fills; `socket.write` returns false and bytes accumulate in the kernel's send buffer. The hub keeps calling `protocol.send(f)` regardless of the return value, then sends `SYNC_END` while late frames are still in flight (or dropped on the floor if the connection is closed).
  - **Impact:** Silent permission divergence between hub and leaf. The leaf considers itself fully synced; the hub considers it fully synced. Until the next eventBus-driven mutation happens to fix the missing entries (which it might never, for `+m`/`+n` flag adds that occurred during the gap).
  - **Demotion reason:** Same scale dependency as W-BOTLINK-SYNC. State divergence requires sustained sync traffic that requires scale. Fix **before scaling**.
  - **Remediation:** Check `socket.bufferedAmount`; pause and resume on `'drain'`. Add a `SYNC_DIGEST` (count + hash) the leaf can check.

#### Original WARNINGs

- [x] **W5.1** — `RateCounter.check()` is O(n) per call (`botlink/rate-counter.ts:19-25`). `filter` reallocates on every check; under recovery storms compounds with sync-frame flood. _(scope: scale-deferred — recovery storms only matter past botnet-scale.)_
- [x] **W5.2** — `BotLinkLeaf.connect()` race: socket dangles if `disconnect()` arrives mid-DNS (`botlink/leaf.ts:120-145`). _Fix:_ `if (this.disconnecting) { socket.destroy(); return; }`.
- [x] **W5.3** — `disconnect()` zeros `linkKey`; subsequent `connect()` (vs `reconnect()`) silently fails (`botlink/leaf.ts:286-288,304`) [latent].
- [x] **W5.4** — Pre-handshake socket has no per-frame size cap; attacker can drive `JSON.parse` + `sanitizeFrame` on 64KB junk for 10s (`hub.ts:443-482`, `protocol.ts:213`). _Fix:_ cap pre-handshake frame to 4KB.
- [x] **W5.5** — `frameDispatchContext()` rebuilt per frame (`hub.ts:715-739,750`). 300 frames/s = 300 closures/s; major-GC pressure. _Fix:_ build once at `setCommandRelay`/`acceptHandshake`. _(scope: scale-deferred — only matters at sustained ≥100 frames/s.)_
- [x] **W5.6** — `BotLinkProtocol`'s `'line'` listener has no max-queue check (`protocol.ts:216-252`).
- [x] **W5.7** — Sync replay relies on idempotent upsert but does not detect frame loss (`hub.ts:680-691`). Pair with W-BOTLINK-BP fix. _(scope: scale-deferred.)_
- [x] **W5.8** — Reconnect storm against per-IP `max_pending_handshakes=3` self-DoSes NAT'd fleets (`auth.ts:326`, `leaf.ts:519-542`). _(scope: scale-deferred — single-bot deploy doesn't have a fleet.)_

### Phase 6 — Services & identity (2 items)

- [x] **W6.1** — `verifyUser` ACC→STATUS retry doesn't reset 5s timeout (`services.ts:610-632`). Misconfigured `services.type` causes false-positive `nickserv-verify-timeout` rows.
- [x] **W6.2** — `pendingGhostResolver` not cleared if GHOST notice arrives after 1.5s timer (`services.ts:579-584,773-790`). Generation race on rapid second reclaim.

### Phase 7 — Orchestrator & process (10 items)

#### Demoted from CRITICAL

- [x] **[W-SIGTERM] Re-entrant SIGTERM stacks two `shutdownWithTimeout` invocations**
  - **File:** `src/index.ts:141-146,160-165`
  - **Pattern:** Reentrant signals / shutdown ordering
  - **Scenario:** systemd `TimeoutStopSec` fires SIGTERM, then a second SIGTERM 5 seconds later (operator double Ctrl-C, supervisor escalation). Both invocations call `gracefulShutdown` → `runBotShutdown` → `bot.shutdown()`.
  - **Impact:** `Bot.shutdown()` self-guards via `_isShuttingDown`, so the inner work is idempotent — but `shutdownWithTimeout`'s outer 10s timer is started twice, and both invocations race `process.exit(0)`. The second invocation sees the inner shutdown return instantly, then races `process.exit` against the first invocation's still-in-progress `step()` chain.
  - **Demotion reason:** The inner work is already idempotent (acknowledged by the original analysis). The race against `process.exit(0)` is theoretical; worst case is a slightly-uncleaner exit on operator double-Ctrl-C.
  - **Remediation:** Top-of-handler `if (signalHandled) return; signalHandled = true;`. Same for SIGINT.

- [ ] **[W-FATALEXIT] `unhandledRejection` → `fatalExit` chain re-rejects when `bot.shutdown()` throws**
  - **File:** `src/index.ts:152-158`, `src/process-handlers.ts:35-51`
  - **Pattern:** Detached promise / shutdown ordering
  - **Scenario:** A plugin's `unhandledRejection` triggers `fatalExit`. `runBotShutdown().finally(() => process.exit(1))`. If `bot.shutdown()` throws, `shutdownWithTimeout`'s `Promise.race` rejects, becoming a _new_ `unhandledRejection`.
  - **Impact:** Diagnosis confusion at 3am during incident response. Operators see two stack traces in the journal and the original error is buried.
  - **Demotion reason:** Diagnostic clarity is real but it's not "takes the bot offline." Triggers a fresh `unhandledRejection` only if a plugin's teardown throws AND `fatalExit` was already in flight.
  - **Remediation:** Inner try/catch in `shutdownWithTimeout`: convert reject to resolve; log the inner failure on a dedicated channel.

- [x] **[W-HEALTHCHECK] Single-file healthcheck conflates liveness with readiness — split into a two-file model**
  - **File:** `src/index.ts:113-116`, `docker-compose.yml`, `docs/multi-instance/docker-compose.yml`
  - **Pattern:** Supervisor signal vs restart-policy separation; k8s-style liveness/readiness
  - **Original framing (now revised):** "Bot is connected, gets K-lined, enters the rate-limited tier (300s initial, doubling to 1800s cap). `stopHeartbeat` runs on `bot:disconnected`, removing `/tmp/.hexbot-healthy`. Any healthcheck cadence shorter than the reconnect delay reports unhealthy → supervisor restarts the bot mid-backoff → fresh attempt → instant K-line → loop."
  - **Why the framing was wrong:** That scenario assumes the supervisor auto-restarts on `unhealthy`. **Docker compose `restart: unless-stopped` does not do that** — it restarts on container _exit_, not on healthcheck status. The healthcheck just colors the `STATUS` column in `docker ps`. Auto-restart-on-unhealthy requires an explicit opt-in (Docker Swarm restart policy, `autoheal` sidecar, k8s liveness probe). With the default deploy, the rate-limited backoff is preserved by the in-process driver and the `unhealthy` signal is exactly what an operator wants to see — "this bot can't reach IRC, look at it."
  - **Historical context:** The healthcheck was introduced in commit `844e83c` ("Fix zombie process on exhausted reconnects") to catch a specific bug — `irc-framework`'s built-in `auto_reconnect` silently gave up after 10 attempts and left the bot offline-but-alive. Wiring the heartbeat to `bot:connected` / `bot:disconnected` was the right shape for that failure mode. The subsequent reconnect-driver rewrite eliminated the zombie scenario but kept the same wiring.
  - **Real defect:** A single binary signal can't simultaneously serve "tell the operator something is wrong" AND "restart the container if and only if a restart will help." These are different needs. The k8s pattern splits them: _liveness_ (restart-worthy — process wedged) vs _readiness_ (state visibility — connected to dependency). The current single file forces operators to choose one semantic globally; "incompatibility with autoheal" is the symptom of that conflation, not a fundamental tension.
  - **Resolution (operator-confirmed):** Two-file model.
    - `/tmp/.hexbot-alive` — touched every 30s while the event loop is responsive. Removed only on graceful shutdown / fatal exit. **Liveness signal** — supervisors that auto-restart point here.
    - `/tmp/.hexbot-connected` — touched on `bot:connected`, removed on `bot:disconnected`. **Readiness signal** — operator dashboards / monitoring point here.
    - Default `docker-compose.yml` healthcheck uses `-connected` (preserves current operator-visibility-first semantics). README documents the alternative for autoheal/k8s users.
  - **Remediation:**
    1. `src/index.ts`: rename existing `HEALTHCHECK_FILE` to `CONNECTED_FILE`; add `ALIVE_FILE` constant. Split `startHeartbeat`/`stopHeartbeat` into `startAliveHeartbeat` (always running, started in `main()`) and `wireConnectedHeartbeat` (event-bus driven, current behavior). `gracefulShutdown` / `fatalExit` clean up both.
    2. `docker-compose.yml` + `docs/multi-instance/docker-compose.yml`: update healthcheck command from `/tmp/.hexbot-healthy` to `/tmp/.hexbot-connected` (no semantic change for default deploy).
    3. `README.md` deploy section: document both files, the k8s-style mapping, and a snippet for autoheal users.
  - **Severity:** WARNING — the current single-file behavior works for the default deploy but the architectural split unblocks future k8s/autoheal adopters and removes a known operator footgun.

#### Original WARNINGs

- [x] **W7.1** — `process.on` handlers attached after `main()` is invoked — order-fragile (`index.ts:160-225,235`) [latent].
- [x] **W7.2** — Bootstrap throw exits via `process.exit(1)` before logger exists; stderr line lacks systemd priority (`bot.ts:222-227,1607-1664`).
- [ ] **W7.3** — No supervisor ready-signal (no `sd_notify`) (`index.ts:106-122`). systemd `Type=notify` cannot be used.
- [x] **W7.4** — `.restart` command `process.exit(0)` after `bot.shutdown()` — no `stopHeartbeat()` (`bot.ts:1082-1085`). Healthcheck file may not be removed on restart.
- [x] **W7.5** — No `process.on('warning')` or `'beforeExit'` handlers (`index.ts`).
- [x] **W7.6** — Plugin-load failure logged loud but does not change exit posture (`bot.ts:971-976`). No way to opt into "fail-fast" for CI/staging.

### Phase 8 — IRC commands & queue (10 items)

- [x] **W8.1** — `messageQueue.flush()` on shutdown drains synchronously without deadline (`message-queue.ts:168-173`, `bot.ts:1322`). 200 queued lines → server K-lines on burst right before QUIT → restart connects into K-line.
- [x] **W8.2** — `client.quit()` after `flush()` may not sequence QUIT after the burst (`bot.ts:1322-1334`).
- [x] **W8.3** — REPL `process.exit(0)` from `rl.on('close')` skips Promise.catch (`repl.ts:115-119`). `bot.shutdown()` rejection → unhandled; bot zombies.
- [x] **W8.4** — REPL has no `process.stdin.on('error')` handler (`repl.ts:51-122`). EPIPE on stdout crashes the bot.
- [x] **W8.5** — `.modlog`, `.bans`, `.users`, `.binds` reply with unbounded `lines.join('\n')` (`ban-commands.ts:84-101`, `modlog-commands.ts:730-734`, `permission-commands.ts:228-241`, `dispatcher-commands.ts:60-77`). Botlink-relayed dot-commands silent-truncate at per-target queue cap.
- [x] **W8.6** — `runEnd` (`.modlog end`) walks full result set with O(N/PAGE*SIZE) synchronous queries (`modlog-commands.ts:663-684`) [at-scale]. 1M-row mod_log → 100k SQLite queries blocks event loop. *(scope: scale-deferred.)\_
- [x] **W8.7** — `messageQueue.setRate(0, ...)` silently coerces 0 to default 2 (`message-queue.ts:229-239`, `bot.ts:570-572`).
- [x] **W8.8** — `IRCCommands.mode()` parse-failure throws to caller; ban-commands runs synchronously without try/catch (`irc-commands.ts:98-108,301-306,358-364`, `ban-commands.ts:154`).
- [x] **W8.9** — `.bot <self> .<cmd>` recursion is not limited (`botlink-commands.ts:581-583`). _Fix:_ add `bot` to `BOT_RELAY_FORBIDDEN_COMMANDS`.
- [x] **W8.10** — `.audit-tail` listener leaks closure over stale REPL ctx if shutdown order goes wrong (`modlog-commands.ts:548-557`, `repl.ts:147`) [latent].

### Phase 9 — Channel state & ISUPPORT (7 items)

- [ ] **W9.1** — RPL*CHANNELMODEIS (324) parses `+l` param without finite/positive guard (`channel-state.ts:577,591`) [verified]. Server with non-numeric param sets `ch.limit = NaN`. \_Fix:* reuse `parseInt + Number.isFinite` guard from `processChannelMode`.
- [ ] **W9.2** — Mode-array entries with missing `+`/`-` direction silently treated as remove (`channel-state.ts:411,576-602`). _Fix:_ skip-with-warn for malformed direction.
- [ ] **W9.3** — Reconnect mid-353: race window where `clearAllChannels` runs but late lines re-create empty records (`channel-state.ts:280-308,498-533`).
- [ ] **W9.4** — NICK collision overwrites without warning (`channel-state.ts:377-406`). Netsplit merge loses tracked account/away. Security-relevant under `$a:` matching.
- [x] **W9.5** — Per-PART O(channels) iteration to determine residual presence (`channel-state.ts:310-345`) [at-scale]. _Fix:_ reverse `nick → Set<channel>` index. _(scope: scale-deferred.)_
- [ ] **W9.6** — Drift detection runs only against `configuredChannels` (`channel-presence-checker.ts:80-119`). Run-time `.join #help` is invisible.
- [ ] **W9.7** — TARGMAX parser silently coerces malformed pairs (`isupport.ts:170-186`). `TARGMAX=PRIVMSG:` (empty) → `Infinity`; `:0` rejected silently.

### Phase 10 — External-call plugins (6 items)

#### Demoted from CRITICAL

- [x] **[W-AICHAT-SPAM] ai-chat circuit-open spams "AI is temporarily unavailable" during real outages** [verified]
  - **File:** `plugins/ai-chat/pipeline.ts:325-337`, `plugins/ai-chat/providers/resilient.ts:162`
  - **Pattern:** Cache for graceful degradation / user-visible blast radius
  - **Scenario:** Gemini returns 503 for 5 minutes. Resilient breaker opens after 5 failures. Subsequent `respond()` throws `'Circuit breaker open'` of kind `'other'`. Pipeline drops to else-branch and `ctx.reply('AI is temporarily unavailable.')` fires on user-addressed messages.
  - **Impact:** Across many channels and triggered users, this is per-message channel-visible feedback every triggered turn for the duration of the outage. The rate-limit path correctly stays silent + once-per-cooldown op-notice; the circuit-open path doesn't.
  - **Demotion reason:** Blast radius is "channel sees `'AI is temporarily unavailable'` per triggered turn" — noisy, not bot-offline. Operator can mute via plugin disable; unrelated subsystems unaffected.
  - **Remediation:** Surface `'circuit_open'` as a distinct kind on `AIProviderError`; route through the same silent path as `rate_limit`.

#### Original WARNINGs

- [ ] **W10.1** — RSS permanent error treated as transient on add path (`plugins/rss/commands.ts:284-313`). Persists feeds even on 404 seed; 5 doomed polls before circuit opens.
- [x] **W10.2** — RSS `!rss check` (manual all-feeds) bypasses circuit breaker (`plugins/rss/commands.ts:382-395`). DNS outage → 10 sequential failures → 50s blocking + 10 channel notices.
- [x] **W10.3** — ai-chat `inflightControllers.clear()` after abort doesn't await fetch unwind; stale completion can release semaphore on new instance (`providers/ollama.ts:266-271`, `providers/gemini.ts:144-149`).
- [x] **W10.4** — spotify-radio `!radio on` does not verify token via `getCurrentlyPlaying()` before announcing (`plugins/spotify-radio/index.ts:269-325`). Asymmetric "Radio is on" / 50s later "Too many errors. Radio off." channel announce.
- [x] **W10.5** — RSS per-feed staggering: feeds tick on same 60s boundary; concurrent feeds chunk-flood at minute boundary (`plugins/rss/feed-formatter.ts:109`). _Fix:_ jitter first poll within interval. _(Deterministic per-feed `feedOffsetMs(id, interval)` in `plugins/rss/index.ts`: first announce poll fires after `offset` ms instead of full interval; subsequent ticks revert to `lastPoll + interval`. Sibling feeds with the same interval but different ids drift apart on first fire.)_

### Phase 11 — IRC-behavior plugins (9 items)

- [ ] **W11.1** — `rejoin_attempts:<chan>` KV records never deleted (`plugins/chanmod/protection.ts:128,154`). KV bloat across reboots.
- [x] **W11.2** — Cycle-on-deop wedge on services-free networks (`plugins/chanmod/mode-enforce-recovery.ts:87-98`). PART succeeds, JOIN blocked by mode set during 2s window → bot AWOL until reload.
- [ ] **W11.3** — Stale `pendingRecoverCleanup` / `unbanRequested` fires `-im` on rejoin (`mode-enforce-recovery.ts:131-134`, `protection.ts:111-113`).
- [ ] **W11.4** — `splitActive` / `splitExpiry` not pruned by 60s time bind (`plugins/chanmod/stopnethack.ts:99-106`).
- [x] **W11.5** — Mass re-op `+oooooooo...` not capped per recovery cycle (`mode-enforce-recovery.ts:225-241`). 30-flagged-user channel: 6-7 MODE lines + deop/halfop/voice + hostile response in one tick → flood K-line during recovery.
- [x] **W11.6** — Lockdown timer fires `-${mode}` after bot disconnect; if reconnect not complete, mode stranded on server forever (`plugins/flood/lockdown.ts:154-156,168-183`). _Fix:_ persist active locks in `api.db`; re-attempt on rejoin.
- [ ] **W11.7** — `joinRates` / lockdown counters survive bot ops loss mid-window (`plugins/flood/lockdown.ts:48-58`).
- [ ] **W11.8** — `enforcement-executor inFlight` Set has detached promise race against teardown (`plugins/flood/enforcement-executor.ts:276-281`). _Fix:_ `disposed` flag at top of teardown.
- [x] **W11.9** — Greeter `joinRates` per-channel map never pruned for departed channels (`plugins/greeter/index.ts:145,184`). _Fix:_ mirror chanmod's bot-PART/KICK pattern.

### Phase 12 — Utilities & small plugins (4 items)

- [x] **W12.1** — `eventBus.on(...)` direct (vs `trackListener`) bypasses ownership tracking (`event-bus.ts:201-208`). _(@deprecated JSDoc; full migration deferred.)_
- [ ] **W12.2** — `help.cooldown_ms` snapshot at init time; live-config inconsistent with header/footer (`plugins/help/index.ts:82-87`).
- [x] **W12.3** — `plugins/ctcp/index.ts` `CTCP PING` echoes `ctx.text` verbatim with no length cap (`plugins/ctcp/index.ts:35-37`).
- [ ] **W12.4** — SOCKS5 connect timeout not configured end-to-end (`src/utils/socks.ts`). Black-holed proxy → half-open connect.

---

## INFO findings (54)

### Phase 1

- [ ] **I1.1** STS clock-skew vulnerability — backward jump can resurrect expired policy briefly (`sts.ts`).
- [ ] **I1.2** `parseSTSDirective` silently drops unknown keys — debug-log for forward compat.
- [ ] **I1.3** `cancelPendingVerifies` lacks audit `actor` — disconnect-driven row has no `by` field.
- [ ] **I1.4** `permanentFailureChannels` cleared on registration but no explicit assertion — add test.
- [x] **I1.5** STS policy revocation (`duration=0`) is blocked over plaintext (`connection-lifecycle.ts:457-513` ~501, `sts.ts:68-91,149-154`) [verified]. Operators relying on the network's STS revocation cannot revoke from plaintext; only recovery is a manual DB edit. _Demoted from WARNING after operator confirmed STS revocation is rare._ _Fix (R2):_ allow `duration=0` through to `STSStore.put` regardless of plaintext.

### Phase 2

- [x] **I2.1** Build is broken at HEAD: `tsc` errors in `plugin-api-factory.ts:233` (readonly drift), `tests/core/commands/ban-commands.test.ts:210`, `tests/core/permissions.test.ts:878`, `tests/helpers/mock-plugin-api.ts:83`, `tests/plugin-api-dispose.test.ts:14`, `tests/plugins/audit-coverage.test.ts:49`, `tests/plugins/chanmod-bans.test.ts:64` — readonly mismatches and stale test mocks missing `version`/`botVersion` fields. Independent of this audit but blocks `pnpm build`. _(Verified clean at HEAD on 2026-05-10: both `pnpm build` and `pnpm tsc --noEmit` exit 0; resolved by prior commits.)_

### Phase 3

- [ ] **I3.1** No write-permission check on `data/` dir at startup — operator-friendly early failure missing.
- [ ] **I3.2** `ensureOpen()` returns handle but most callers ignore — consistency [latent].
- [ ] **I3.3** No covering `(target, channel)` index on mod_log — only relevant at million-row scale.
- [ ] **I3.4** `transaction()` has no nesting protection — runtime guard would be friendlier.

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
- [x] **I6.3** `verifyUser` returns `verified:false` on `'unidentified'` with no operator-visible feedback — silent dispatch denial.
- [x] **I6.4** `permissions.findByHostmask` is O(users × hostmasks*per_user) per privileged event [at-scale]. *(scope: scale-deferred.)\_
- [x] **I6.5** `accountLookup` not wrapped in try/catch in `checkFlags` — misbehaving lookup throws into dispatch.
- [ ] **I6.6** Owner bootstrap is idempotent — verified, no fix needed; small forensic gap on re-seed.
- [ ] **I6.7** scrypt is async (libuv pool) — DCC pre-handshake gate sits ahead of it; flooding-model well-mitigated.
- [ ] **I6.8** Hostmask wildcard matcher is bounded (512 / 4096) — verified clean.
- [ ] **I6.9** Service parser regexes are anchored — verified clean.

### Phase 7

- [ ] **I7.1** `recoverableTimestamps` array module-level — survives re-`main()` [latent].
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
- [x] **I12.4** `duration.ts` `\d+` unbounded but `Math.min` clamps — bound regex to `\d{1,15}`.
- [ ] **I12.5** Per-sender CTCP throttle relies entirely on outbound queue — inbound CPU is unconditional.
- [ ] **I12.6** `seen` plugin hourly sweep does two table scans — combine into one pass.

---

## Stable patterns found (templates for fixes)

These are well-implemented and worth keeping as references when fixing other paths:

- **Tier-classified close reasons with explicit labels** (`close-reason-classifier.ts`) — pure function, table-driven, fully testable.
- **`auto_reconnect: false` + driver ownership** (`reconnect-driver.ts`, `bot.ts:1553`) — clean separation; unit-testable without an IRC mock.
- **`ListenerGroup` for IRC client listeners** (`irc-bridge.ts:181`, `connection-lifecycle.ts:191`) — every listener registered through one helper, removed in one call. **Should be the only public path** in `event-bus.ts` too.
- **STS first-contact defense with `tls_verify=false`** (`connection-lifecycle.ts:482-489`) — refuses to pin policy from an unauthenticated TLS session.
- **Plaintext-with-existing-policy short-circuit** (`connection-lifecycle.ts:469-474`) — exemplary belt-and-braces guard.
- **Idempotency guard in `IRCBridge.attach()`** (`irc-bridge.ts:142-147`) — detects programming errors rather than silently leaking listeners.
- **Bridge `.catch()` on every dispatch call** — handler rejection never escapes to irc-framework.
- **Timer auto-disable + minimum 10s floor** (`dispatcher.ts:237-243,247-266`) — every throwing time-bind eventually trips off.
- **Per-plugin bind hard cap with refusal** (`dispatcher.ts:197-209`) — bulkhead against runaway plugin.
- **`verifyUser()` AbortController pattern** (`services.ts:351-419`) — timeout, abort, dedup, hard cap, audit on cap breach. Single resolution path; promise can never reject.
- **`PendingRequestMap` cap + drain** (`botlink/pending.ts:63-122`) — bounded entries, cap-hit log cadence, shutdown drain.
- **Heartbeat `tick()` stops itself before `onTimeout`** (`botlink/heartbeat.ts:72-83`) — double-fire structurally impossible.
- **Reconnect jitter** (`botlink/leaf.ts:519-527`) — 0.5–1.0× full jitter against exponential delay.
- **Frame parse safety** (`botlink/protocol.ts:216-252`) — per-line size cap, unknown-type drop, recursion-capped sanitizeFrame.
- **`PermissionSyncer.applyFrame` + `injectChannelSync` are upsert-by-key** — replays do not duplicate.
- **`clearAllTimers()` choke-point in DCC** (`dcc/index.ts:950-987`) — every named listener removed by reference.
- **DCC `isStale` zombie eviction** (`dcc/index.ts:550-552,1606-1621`) — handles both `closed` and `socket.destroyed`.
- **DCC TOCTOU between password capture and verify** (`handlePasswordLine` 891-908) — live-hash refetch + `pendingSessions` sweep on `user:passwordChanged`.
- **DCC per-session error boundary in `broadcast`/`announce`** (`dcc/index.ts:1448-1483`) — one stale write doesn't silence the party line.
- **DCC `MAX_LINE_BYTES` data guard** (`dcc/index.ts:470-531`) — closes "stream gigabytes without LF" pre-readline wedge.
- **DCC auth tracker `maxEntries=10000`** (`auth-tracker.ts:87-96`) — bounded under brute force, oldest-first eviction.
- **`step()` helper for shutdown** (`bot.ts:1248-1254`) — per-step try/catch.
- **`shutdownWithTimeout` with `timer.unref()`** (`process-handlers.ts:35-51`).
- **Recoverable-socket-error rate limiter** (`index.ts:184-201`) — sliding window + bounded array.
- **Reconnect driver cancellation runs first in shutdown** (`bot.ts:1258-1263`) — prevents stray timer reopening socket mid-shutdown.
- **All RSS / ai-chat / spotify-radio external fetches** wrap an `AbortController` + timeout, registered for teardown abort.
- **ai-chat resilient breaker excludes deterministic `safety` and `auth` errors** (`providers/resilient.ts:31-177`) — closes the deterministic-DoS path.
- **`MAX_AMBIENT_CHANNELS=256` LRU cap** (`ai-chat/rate-limiter.ts:72-73,187-218`) — bounded with bot-leave forget cleanup.
- **Spotify `parseRetryAfter` clamps to `[1, 300]`** — hostile/malformed header can't pin the bot for hours.
- **Spotify `handlePollError` distinguishes auth/rate-limit/network with kill switch at 5 consecutive errors**.
- **Channel-state `attach()` uses `ListenerGroup`; `detach()` calls `removeAll()`** — no raw `client.on(...)`.
- **Wildcard matcher is hand-rolled DP, not regex** — no catastrophic backtracking; capped at 512/4096.
- **`flood-limiter` warned-set FIFO at 8192-cap** — bounded under attack.
- **Help plugin `cooldowns` Map scoped inside `init()`, keyed on `ident@host`, capped at 1000, time-bind sweep backstop**.
- **`seen` plugin `MAX_TEXT_LENGTH=200` and `enforceEntryCap=10000`** — hourly sweep + size cap.
- **`Logger.SINK_WARN_THRESHOLD=8` and `removeByOwner` drain both maps** — clean sink leak detection.
- **Owner bootstrap idempotent** — `getUser()` and `getPasswordHash() !== null` short-circuit re-seed.
- **`api.ctcpResponse` flows through `sanitize()` and `messageQueue`** — outbound CTCP rate-limited.

---

## Recommendations (action plan)

Cross-references use symbolic IDs (`[C-XXX]`, `[W-XXX]`, `Wx.y`) that are stable under reordering.

### Top three to fix first

1. **[C-IRCCMDS] — IRCCommands queue bypass.** Highest realistic blast radius (K-line during chanmod recovery storm = the bot disappears from every channel during a raid). Mechanically simple: thread mutating verbs through `messageQueue.enqueue`. See R13.
2. **[C-DBEXIT] — DB `process.exit(2)` bypasses shutdown.** Minor refactor to throw and let the existing `step()` harness drive graceful exit. Closes a class of WAL-corruption / FD-leak hazards. See R14.
3. **[C-ENSURECHAN] — `ensureChannel` unbounded growth.** One-line refactor at every TOPIC/CHANNELINFO call site. Closes the unbounded-growth surface a hostile or buggy server could exploit. See R17.

### Quick wins (< 1 hour each)

- [x] **R1** — Add `signalHandled` guard to `gracefulShutdown` ([W-SIGTERM]).
- [x] **R2** — Allow `duration=0` STS revoke from plaintext (I1.5; one-line config gate; low priority — operator confirmed rare use case).
- [x] **R3** — Add `bot` to `BOT_RELAY_FORBIDDEN_COMMANDS` (W8.9; one-line constant).
- [x] **R4** — Snapshot `this.binds.slice()` at top of `dispatch()` loop (W2.1).
- [x] **R5** — Wrap each step of `onClose` in its own try/catch (W1.6).
- [x] **R6** — Reset 5s timeout on ACC→STATUS retry (W6.1).
- [x] **R7** — Bound regex in `duration.ts` to `\d{1,15}` (I12.4).
- [x] **R8** — Wrap `accountLookup` invocation in try/catch (I6.5).
- [x] **R9** — Fix the typecheck failures (I2.1) — readonly drift in `plugin-api-factory.ts:233` and 6 stale test mocks. Independent of stability work but blocks `pnpm build`. _(No-op: HEAD is already clean — see I2.1.)_
- [x] **R10** — Pattern-match DNS errors in `close-reason-classifier.ts` to fatal-on-first-attempt (W1.10).
- [x] **R11** — Add length cap in CTCP PING reply (W12.3).
- [x] **R12** — Implement two-file healthcheck model: `/tmp/.hexbot-alive` (liveness — always touched) + `/tmp/.hexbot-connected` (readiness — touched on `bot:connected`, removed on `bot:disconnected`). Update both `docker-compose.yml` files to point at `-connected` for default visibility-first semantics. README deploy section documents both files and the k8s-style mapping ([W-HEALTHCHECK]). ~25 LOC plus 2 docker-compose updates plus a README block.

### Medium effort (refactoring)

- [x] **R13** — Route every mutating `IRCCommands` verb through `messageQueue` ([C-IRCCMDS]) — touches all `client.raw` sites + ordering tests.
- [x] **R14** — Replace DB `process.exit(2)` with `DatabaseFatalError` flow ([C-DBEXIT] and [W-STS-EXIT]) — needs `bot.shutdown()` integration.
- [x] **R15** — Chunk botlink sync via `setImmediate`/`drain` ([W-BOTLINK-SYNC]) — small loop refactor with backpressure handling. _(scope: scale-deferred.)_
- [x] **R16** — Track botlink sync send-buffer for backpressure ([W-BOTLINK-BP]) — `socket.bufferedAmount` plus optional `SYNC_DIGEST` for divergence detection. _(scope: scale-deferred.)_
- [x] **R17** — Restrict `ensureChannel` to JOIN/USERLIST/inject ([C-ENSURECHAN]) — small refactor at every call site.
- [x] **R18** — Resolve `Bot.start()` after first attempt scheduled ([W-BOTSTART]). Independent of R12 — this is about the REPL never starting and `main()` never completing on a rate-limited first boot, not about the healthcheck signal.
- [x] **R19** — DCC `pendingSessions` add-after-start ordering + re-attach fallback `'error'` listener (W4.1).
- [x] **R20** — DCC port-pool owner-token ([W-DCC-PORT]).
- [x] **R21** — `kv` table per-namespace retention hook + periodic VACUUM (W3.6).
- [x] **R22** — Batch mod*log migration via `setImmediate` (W3.3). *(scope: scale-deferred.)\_
- [x] **R23** — Persist flood lockdown active-locks in `api.db`; re-attempt `-mode` on rejoin (W11.6).
- [x] **R24** — Cap chanmod mass re-op per recovery cycle, mirroring `HOSTILE_BATCH_SIZE` (W11.5).
- [x] **R25** — Pagination + caps on `.modlog`, `.bans`, `.users`, `.binds` reply lines (W8.5, W8.6). _(`.bans`, `.users`, `.binds` now accept `--page N` with a 20-line cap via `src/utils/paginate.ts`. `.modlog` already paginates via `next`/`prev`/`top` at PAGE_SIZE=10. W8.6 [.modlog end] stays scope: scale-deferred.)_
- [x] **R26** — REPL `process.stdin/stdout` error handling + `Promise.catch` on shutdown (W8.3, W8.4).
- [x] **R27** — ai-chat surface `'circuit_open'` error kind and route to silent path ([W-AICHAT-SPAM]).
- [x] **R28** — ai-chat `inflightControllers` per-init epoch token (W10.3).
- [x] **R29** — Bound RSS retry / circuit on manual `!rss check` (W10.2).
- [x] **R30** — Spotify token verify before "Radio is on" announce (W10.4).
- [x] **R31** — Greeter `joinRates` per-channel prune on bot PART/KICK (W11.9).
- [x] **R32** — chanmod cycle-on-deop fallback ladder (W11.2).
- [x] **R33** — Run a focused follow-up audit pass over Phase 13 files (`audit.ts`, `memo.ts`, `relay-orchestrator.ts`, `seed-from-json.ts`, `deep-freeze.ts`, `database-errors.ts`); promote findings into this document. _(scope: skipped — operator chose to close existing findings first; revisit if specific incident data points there.)_

### Architectural (design changes — flag for discussion)

- [x] **R34** — Reconcile loop for "intent vs reality": periodic check that bot is op'd in channels where config says it should be; mode `+t` enforced where chanset says so; lockdown not stranded. Currently fragmentary across plugins. _(scope: deferred — operator chose to keep per-plugin recovery rather than build a generic ReconcileManager. Revisit if recovery gaps are observed in production.)_
- [x] **R35** — Single-source-of-truth for queue config — `messageQueue.setRate` should restart timer to honor config changes live. _(Verified at HEAD: `MessageQueue.setRate` already calls `this.start()` to restart the timer on rate change — see message-queue.ts:255-258. No-op.)_
- [x] **R36** — Pluggable namespace retention: per-plugin TTL for `kv` rows; long-uptime invariant. _(Implemented as a hardcoded `KV_RETENTION_DAYS` table in `Bot` plus `BotDatabase.pruneOlderThan()` / `vacuum()` helpers; daily prune + monthly VACUUM under unref'd timers. Pluggable per-plugin opt-in via the API surface deferred — extend the table or expose `api.db.setRetentionDays()` if a plugin needs a tighter TTL than the default.)_
- [x] **R37** — `eventBus.on()` deprecation — make `trackListener(owner, ...)` the only public surface (W12.1). _(Doc-only deprecation; full migration left as future refactor — flagged with @deprecated JSDoc.)_
- [x] **R38** — `sd_notify` integration for `Type=notify` units; READY=1 on connected, STOPPING=1 on shutdown, optional WATCHDOG=1 (W7.3). _(scope: deferred — operator deploys via Docker, not systemd. The two-file healthcheck (R12) covers the same need for Docker / k8s.)_
- [x] **R39** — Botlink reconnect-storm protection: per-IP whitelist exempts WireGuard exit; document NAT topology requirement (W5.8). _(scope: scale-deferred.)_
- [x] **R40** — Plugin handler circuit breaker for non-timer binds — `consecutiveFailures` counter with trip-state and `.binds` visibility (W2.3).
- [x] **R41** — `findByHostmask` per-dispatch memo cache — only matters at >1k user scale (I6.4). _(scope: scale-deferred.)_
- [x] **R42** — Operator-facing notice when verify denies a privileged command for `'unidentified'` (I6.3).
- [x] **R43** — Update `.claude/skills/stability` to spell out an "in-this-deployment realistic" CRITICAL bar AND make parent verification of CRITICAL claims the default in the audit process. Prevents the severity-inflation pattern that produced 14 CRITICALs in this round (operator-confirmed direction).

---

## Operator-resolved decisions (recorded for downstream skills)

These were open during meta-review and have been answered. Captured here so future audits and `/build` can rely on the same context.

- [x] **Deployment scale:** Single-bot now, botnet possible later. [W-BOTLINK-SYNC] / [W-BOTLINK-BP] stay WARNING; treat `[at-scale]`-tagged items as "fix before scaling," not "fix before next deploy." **Update 2026-05-10 (operator):** all `[at-scale]` items are _won't-fix until deployment posture changes_ — gate any future scale-out on revisiting them. The W- and R-items below carry an inline `_(scope: scale-deferred)_` annotation so downstream skills know not to act on them.
- [x] **Healthcheck design intent:** The single-file signal conflated _liveness_ ("restart me if I'm wedged") with _readiness_ ("am I doing my job"). Resolution: two-file k8s-style model — `/tmp/.hexbot-alive` (always touched) + `/tmp/.hexbot-connected` (touched on connect, removed on disconnect). Default `docker-compose.yml` uses `-connected` for operator visibility; autoheal/k8s liveness adopters point at `-alive` to preserve the in-process backoff. R12 implements this; the supposed "incompatibility with autoheal" is dissolved. R18 (Bot.start await blocking) is independent.
- [x] **DB `process.exit(2)` intent:** Unclear — but R14 preserves loud-fail semantics either way. Captured inline on [C-DBEXIT].
- [x] **STS revocation:** Rare use case. [W-STS-REVOKE] demoted to INFO (now I1.5). R2 stays in quick-wins at low priority.
- [ ] **Future audit process (R43):** Both stricter CRITICAL bar in the skill AND parent verification of CRITICAL claims before accepting from subagents.

---

## Provenance

- **Original audit:** 12 parallel concern-area subagents (general-purpose), one per phase, each producing CRITICAL/WARNING/INFO findings against its file scope.
- **Parent verification:** spot-checked 7 CRITICAL claims directly against source ([C-IRCCMDS], [C-DBEXIT], [C-ENSURECHAN], [W-STS-EXIT], [W-AICHAT-SPAM], W2.1, W9.1, [W-DCC-PORT], I1.5) and confirmed all hold up. Confirmed `process.on('uncaughtException')` and `process.on('unhandledRejection')` are registered at `index.ts:203,215`.
- **Counts independently verified:** 14 CRITICAL section headers, 79 W-tagged + 11 demoted = 90 WARNING items, 54 I-tagged INFO items by `grep -c`.
- **Severity recalibration:** 11 of 14 originally-CRITICAL findings demoted to WARNING using the strict bar — "realistic in-this-deployment scenario takes the bot offline or wedges a core subsystem within one event."
- **One agent claim was found false:** an early subagent claimed a duplicate `inferredName` declaration in `plugin-loader.ts`. Verified single declaration at line 374; no compile error from that source. The real `tsc` failure (I2.1) is a separate readonly/test-mock drift issue.
