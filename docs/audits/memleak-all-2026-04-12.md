# Memory Leak Audit: Full Codebase

**Date:** 2026-04-12
**Scope:** All `.ts` files in `src/` and `plugins/` (56 source files, 31 plugin files)
**Estimated risk:** Medium — based on worst findings
**Status:** All 26 findings fixed (2026-04-12). See CHANGELOG.md `[Unreleased]`.

## Summary

The hexbot codebase is well-designed for memory safety in a long-running process. The core infrastructure uses tracked-listener patterns with proper `detach()` cleanup, the dispatcher cleans up timer binds, and the plugin loader's unload path is thorough. The primary leak vectors were **unbounded Maps that never prune stale keys** (especially `SlidingWindowCounter` used in 5+ locations) and **incomplete cleanup in teardown/close paths** for the BotLink hub, memo system, and DCC sessions.

All findings have been remediated. Key changes: `SlidingWindowCounter.sweep()` with periodic invocation, partial-init safety in the plugin loader, tracked listeners in connection lifecycle and BotLink hub, TTL sweeps for BotLink routing maps, and channel/account cleanup in ChannelState.

**Findings:** 2 critical, 14 warning, 10 info — all fixed

---

## Findings

### [CRITICAL] chanmod plugin leaks resources on partial init failure

**File:** `plugins/chanmod/index.ts:24`
**Category:** reload residue
**Growth rate:** per failed init attempt

The `teardowns` array collects cleanup functions as `init()` progresses. If `init()` throws partway through, some teardown functions have been pushed but the plugin is never registered as loaded. The loader calls `unbindAll` but does not invoke the partial `teardowns` array. This leaks the ProtectionChain, ChanServ notice handlers, and any timer state created before the failure point.

```typescript
let teardowns: Array<() => void> = [];
```

**Impact:** Each failed init leaks all resources registered before the error. Repeated load failures accumulate leaked ProtectionChain instances, IRC listeners, and timers.

**Remediation:** Wrap `init()` so that on exception, the partially-built teardowns array is drained before re-throwing. Or have the plugin loader capture and invoke teardown on failed init.

---

### [CRITICAL] MemoManager.detach() missing dispatcher/command cleanup

**File:** `src/core/memo.ts:130-147`
**Category:** reload residue
**Growth rate:** per attach/detach cycle

`attach()` registers binds on the dispatcher and a command on the command handler. `detach()` only clears the pending request timer and cooldown map — it does NOT unbind dispatcher binds or unregister the `memo` command. If the memo system is detached and reattached, old binds and command registrations persist alongside new ones, causing duplicate handler execution.

```typescript
detach(): void {
    if (this.pendingRequest) {
        clearTimeout(this.pendingRequest.timer);
        this.pendingRequest = null;
    }
    this.deliveryCooldown.clear();
    // Missing: this.dispatcher.unbindAll(OWNER_ID)
    // Missing: this.commandHandler.unregisterCommand('memo')
}
```

**Impact:** Each attach/detach cycle adds 2 dispatcher binds and 1 command handler registration that are never removed. Memos are delivered multiple times per cycle.

**Remediation:** Add `this.dispatcher.unbindAll(OWNER_ID)` and command handler cleanup to `detach()`.

---

### [WARNING] SlidingWindowCounter never evicts stale keys

**File:** `src/utils/sliding-window.ts:6-17`
**Category:** unbounded collection
**Growth rate:** one entry per unique key that ever triggers a rate check

The `windows` Map prunes timestamps within each key on every `check()` call, but never removes a key once all its timestamps have expired. Every unique key (typically `nick!user@host`) persists as a dead empty-array entry forever. This class is used in at least 5 locations: `dispatcher.ts` (pubFlood, msgFlood), `irc-bridge.ts` (ctcpRateLimiter), and `plugins/flood/index.ts` (4 trackers).

```typescript
private windows = new Map<string, number[]>();
check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const timestamps = (this.windows.get(key) ?? []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return timestamps.length > limit;
}
```

**Impact:** On a busy network with 1000+ unique users/day, accumulates ~64-128 bytes per stale key. Reaches O(MB) over months across all SlidingWindowCounter instances.

**Remediation:** Add a `sweep()` method that removes keys with no timestamps within the window. Call it periodically (e.g., every 5-10 minutes via a timer), or have `check()` delete keys when the filtered array is empty before the push.

---

### [WARNING] Dispatcher floodWarned Set never pruned

**File:** `src/dispatcher.ts:117`
**Category:** unbounded collection
**Growth rate:** one entry per unique hostmask that triggers flood protection

The `floodWarned` Set entries are only deleted when the same key passes a subsequent non-flood check. If a user floods once and leaves, their key persists forever.

```typescript
private floodWarned = new Set<string>();
```

**Impact:** Grows with unique flood-triggering hostmasks. Low memory per entry but unbounded.

**Remediation:** Sweep alongside the SlidingWindowCounter fix — remove entries whose corresponding rate-limit key has expired.

---

### [WARNING] ChannelState.channels never pruned on bot PART/KICK

**File:** `src/core/channel-state.ts:55`
**Category:** unbounded collection
**Growth rate:** one entry per channel the bot has ever joined

The `channels` Map grows via `ensureChannel()` on JOIN, userlist, topic, and channel-info events, but entries are never removed when the bot PARTs or is KICKed. Each entry contains a nested `users` Map.

```typescript
private channels: Map<string, ChannelInfo> = new Map();
```

**Impact:** If the bot is repeatedly invited to and joins many channels, this accumulates stale ChannelInfo entries with user data. Proportional to distinct channels ever joined.

**Remediation:** When `onPart`/`onKick` fires and the leaving nick matches the bot's own nick, delete the channel from `this.channels`.

---

### [WARNING] BotLink hub eventBus listeners not removed on close

**File:** `src/core/botlink-hub.ts:174-191`
**Category:** listener leak
**Growth rate:** 5 listeners per hub instantiation

`setCommandRelay()` registers 5 anonymous listeners on the eventBus (`user:added`, `user:removed`, `user:flagsChanged`, `user:hostmaskAdded`, `user:hostmaskRemoved`) but never stores references and never removes them. The hub's `close()` method has no eventBus cleanup.

```typescript
eventBus.on('user:added', broadcastUserSync);
eventBus.on('user:removed', (handle) => { ... });
eventBus.on('user:flagsChanged', (handle, globalFlags, channelFlags) => { ... });
eventBus.on('user:hostmaskAdded', broadcastUserSync);
eventBus.on('user:hostmaskRemoved', broadcastUserSync);
```

**Impact:** If the hub is recreated (tests, future restart flow), listeners accumulate. The closures capture `permissions` and the hub instance, preventing GC.

**Remediation:** Store listener references in the class. Add cleanup to `close()` that calls `eventBus.off()` for each.

---

### [WARNING] BotLink hub close() doesn't clear auxiliary maps

**File:** `src/core/botlink-hub.ts:452-465`
**Category:** unbounded collection
**Growth rate:** one-time retention at shutdown

`close()` clears `this.leaves` but does NOT clear `remotePartyUsers`, `activeRelays`, `protectRequests`, `cmdRoutes`, or `pendingCmds`. These keep entries alive if the hub object remains referenced. `pendingCmds` entries hold unresolved Promise callbacks.

**Impact:** Prevents GC of hub state after close. One-time retention, not accumulative.

**Remediation:** Add `.clear()` calls for all five maps in `close()`. Resolve pending promises with errors before clearing.

---

### [WARNING] BotLink hub protectRequests/cmdRoutes have no TTL

**File:** `src/core/botlink-hub.ts:56-62`
**Category:** unbounded collection
**Growth rate:** per unanswered PROTECT request or CMD relay

If a leaf sends a PROTECT request and no leaf ever responds, or a CMD is routed to a leaf that crashes, these map entries persist forever. No TTL or sweep exists.

```typescript
private protectRequests: Map<string, string> = new Map();
private cmdRoutes: Map<string, string> = new Map();
```

**Impact:** Under normal operation this is rare, but a misbehaving leaf causes indefinite accumulation.

**Remediation:** Add TTL-based sweep (store insertion timestamp, sweep every 60s, expire after 30s). Similar to how `pendingCmds` has a 10s timeout.

---

### [WARNING] BotLink leaf pending maps not flushed on disconnect

**File:** `src/core/botlink-leaf.ts:44-46, 249-262`
**Category:** unbounded collection
**Growth rate:** up to N pending entries per disconnect (bounded by 10s timeout)

`pendingCmds`, `pendingWhom`, and `pendingProtect` are NOT cleared on disconnect. Entries eventually self-clean via their individual timeouts (5-10s), but during that window the `resolve` callbacks hold stale references to DCC sessions or IRC response paths.

**Impact:** Stale closures held for up to 10 seconds after disconnect. Minor GC delay.

**Remediation:** On disconnect, iterate all three maps, resolve with error/empty result, clear the maps.

---

### [WARNING] Relay virtual sessions have no orphan cleanup

**File:** `src/core/botlink-relay-handler.ts:61-89`
**Category:** unbounded collection
**Growth rate:** per orphaned relay session

`_relayVirtualSessions` entries are added on RELAY_REQUEST and removed on RELAY_END. If RELAY_END never arrives (hub crash, network partition), the entry persists forever with its closure references.

**Impact:** Infrequent under normal operation but possible during network instability.

**Remediation:** Clear virtual sessions when a `botlink:disconnected` event fires for the originating bot. Or add a session TTL/heartbeat.

---

### [WARNING] Connection lifecycle startup retry timer not cancellable

**File:** `src/core/connection-lifecycle.ts:232`
**Category:** timer leak
**Growth rate:** one uncancellable timer per startup retry

`setTimeout(() => deps.reconnect!(), delay)` — the timer ID is never stored. If the bot shuts down during the retry window, the callback fires after cleanup.

```typescript
setTimeout(() => deps.reconnect!(), delay);
```

**Impact:** Potential post-shutdown reconnect attempt. At most one outstanding timer.

**Remediation:** Store the timer ID and clear it in the returned handle or during shutdown.

---

### [WARNING] DCC readline interface not explicitly closed

**File:** `src/core/dcc.ts:302`
**Category:** stream leak
**Growth rate:** per DCC session

`DCCSession.start()` creates a readline interface wrapping the socket but never stores it or calls `rl.close()`. Relies on implicit cleanup when the socket is destroyed.

```typescript
const rl = createReadline({ input: this.socket, crlfDelay: Infinity });
```

**Impact:** One leaked readline reference per DCC session until GC collects the destroyed socket.

**Remediation:** Store `rl` as a class member and call `rl.close()` in `close()` and `onClose()`.

---

### [WARNING] DCC server error handler missing clearTimeout

**File:** `src/core/dcc.ts:856-861`
**Category:** timer leak
**Growth rate:** per DCC server error

The server `'error'` handler releases the port and removes the pending entry but does not clear the pending timeout timer. The timer fires 30s later holding closure references to the server and nick.

**Impact:** Timer holds references for up to 30s after error. Harmless callback on already-cleaned state.

**Remediation:** Add `clearTimeout(pending.timer)` at the start of the `'error'` handler.

---

### [WARNING] Flood plugin offenceTracker never pruned

**File:** `plugins/flood/index.ts:67`
**Category:** unbounded collection
**Growth rate:** per unique nick triggering flood detection

The `offenceTracker` Map grows per unique `nick@channel` key with `lastSeen` timestamps. Expired entries are never pruned — they persist until plugin teardown/reload.

```typescript
let offenceTracker: Map<string, OffenceEntry>;
```

**Impact:** Hundreds of entries per day on a busy network. Small objects, but unbounded.

**Remediation:** Add periodic cleanup on the existing `time` bind to remove entries where `Date.now() - lastSeen > offenceWindowMs`.

---

### [WARNING] Chanmod state maps never pruned during runtime

**File:** `plugins/chanmod/state.ts:63-64`
**Category:** unbounded collection
**Growth rate:** per mode change event per channel

`intentionalModeChanges` entries persist if the corresponding mode event never arrives (e.g., target user parted). `enforcementCooldown` entries have `expiresAt` but are never proactively pruned.

```typescript
intentionalModeChanges: new Map(),
enforcementCooldown: new Map(),
```

**Impact:** Slow leak proportional to distinct channel:nick pairs triggering enforcement. Hundreds per day, never cleaned until reload.

**Remediation:** Add periodic pruning on the existing `time` bind (60s interval) to remove expired entries.

---

### [WARNING] Chanmod timer arrays grow monotonically

**File:** `plugins/chanmod/state.ts:65-66, 82-88`
**Category:** unbounded collection
**Growth rate:** per scheduled enforcement/cycle timer

Timer IDs are pushed into `enforcementTimers` and `cycleTimers` arrays but never removed after the timer fires. Arrays only shrink on teardown.

```typescript
scheduleEnforcement(delayMs: number, fn: () => void): void {
    const timer = setTimeout(fn, delayMs);
    state.enforcementTimers.push(timer);
},
```

**Impact:** ~100 stale timer IDs per day. Negligible memory per entry but unbounded.

**Remediation:** Use a Set and have the timer callback remove its own ID upon firing.

---

### [INFO] ESM module cache residue on plugin reload

**File:** `src/plugin-loader.ts:483-484`
**Category:** reload residue
**Growth rate:** one stale module per plugin reload

Cache-busting via `?t=<timestamp>` creates a new module URL on each reload. Node's ESM cache retains the old module entry. Each ghost module retains its exports.

**Impact:** With 20 plugins reloaded 10 times = ~200 stale entries, a few MB. Negligible in production (rare reloads).

**Remediation:** Known Node.js ESM limitation. Document as expected. Consider a restart recommendation after N reloads.

---

### [INFO] Connection lifecycle listeners use anonymous closures

**File:** `src/core/connection-lifecycle.ts:135-259`
**Category:** listener leak
**Growth rate:** 7 listeners, registered once per bot lifetime

Seven listeners are registered on the IRC client via anonymous closures with no removal path. Currently called exactly once, so no accumulation. Design concern for testability.

**Remediation:** Store listener references and return a `detach()` method on the handle for defense-in-depth.

---

### [INFO] ChannelState networkAccounts grows between reconnects

**File:** `src/core/channel-state.ts:57`
**Category:** unbounded collection
**Growth rate:** per unique nick via extended-join/account-notify

Entries are removed on QUIT and cleared on reconnect, but nicks that PART all shared channels without QUITting persist until reconnect. Bounded by network user count.

**Remediation:** On PART, check if the parting nick remains in any tracked channel; if not, evict from networkAccounts.

---

### [INFO] BotLink protocol readline not explicitly closed

**File:** `src/core/botlink-protocol.ts:155-179`
**Category:** stream leak
**Growth rate:** N/A — cleaned up when socket is destroyed

The readline interface is created but never explicitly closed. In practice, `socket.destroy()` triggers readline teardown. Not a real leak.

**Remediation:** Store `rl` and call `rl.close()` in `BotLinkProtocol.close()` for explicit lifecycle.

---

### [INFO] BotLink MaskList never prunes empty channels

**File:** `src/core/botlink-sharing.ts:26-56`
**Category:** unbounded collection
**Growth rate:** per distinct channel with ban/exempt history

Channel keys remain with empty arrays when all entries are removed. Bounded by total distinct channels.

**Remediation:** Delete the channel key in `remove()` when the list becomes empty.

---

### [INFO] BotLink auth tracker only sweeps on admit()

**File:** `src/core/botlink-auth.ts:127, 274-297`
**Category:** unbounded collection
**Growth rate:** per unique attacking IP within sweep window

Well-designed TTL sweep, but only runs when a new connection arrives. Under distributed attack, map grows between admit() calls.

**Remediation:** Add a periodic sweep timer (e.g., every 5 minutes) independent of incoming connections.

---

### [INFO] Flood plugin module-level state pattern

**File:** `plugins/flood/index.ts:20-76`
**Category:** reload residue
**Growth rate:** per reload (if ESM cache-bust fails)

Module-level `let` variables hold state including a reference to `api`. Relies on ESM cache-busting in the plugin loader. Currently works correctly but fragile pattern.

**Remediation:** Consider class-based or parameter-passing patterns to avoid module-level references.

---

### [INFO] MessageQueue constructor auto-starts timer

**File:** `src/core/message-queue.ts:92-103`
**Category:** timer leak
**Growth rate:** per unconstructed/unstopped queue

Constructor calls `this.start()` unconditionally. If `stop()` is never called, the interval persists. Mitigated by `.unref()`.

**Remediation:** Ensure `stop()` is called in all shutdown paths (currently it is).

---

### [INFO] Help/Topic plugin cooldown maps grow during runtime

**Files:** `plugins/help/index.ts:12`, `plugins/topic/index.ts:13`
**Category:** unbounded collection
**Growth rate:** per unique nick using the command

Cooldown Maps grow per unique nick but are properly cleared on teardown. Bounded by distinct nicks.

**Remediation:** None needed — growth is negligible and cleanup is correct.

---

## Leak-free patterns found

### Tracked-listener pattern (IRCBridge, ChannelState, Services, DCC)

The gold standard cleanup pattern used throughout the codebase:

```typescript
private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
// In setup:
this.client.on(event, fn);
this.listeners.push({ event, fn });
// In detach():
for (const { event, fn } of this.listeners) {
    this.client.removeListener(event, fn);
}
this.listeners = [];
```

### Dispatcher timer cleanup

Timer binds tracked in `Map<BindEntry, Timer>`, properly cleared in `unbind()` and `unbindAll()`.

### Plugin loader unload path

Thorough: calls teardown(), unbinds all dispatcher binds, unregisters help entries, unregisters channel settings + change listeners, removes modesReady eventBus listeners.

### Plugin API frozen objects

`Object.freeze()` on the plugin API and sub-objects prevents plugins from attaching arbitrary state.

### Bot.shutdown() orchestration

Comprehensive and ordered shutdown: stops presence check, closes botlink, detaches all modules, flushes message queue, sends QUIT, closes database.

### Services pending verification cleanup

Three-way cleanup (success, timeout, detach) with duplicate-request cancellation. Exemplary.

### Seen plugin — database-backed state

Uses SQLite for all persistence with hourly cleanup of stale entries. No in-memory accumulation.

### Chanmod submodules — pure function pattern

Most chanmod submodules (sticky, helpers, mode-enforce-\*, topic-recovery, etc.) are pure functions that take state/api as parameters. No module-level mutable state. Ideal for hot-reload safety.

---

## Recommendations

### Quick wins (< 5 min each)

1. **Add `sweep()` to SlidingWindowCounter** — iterate the map, delete keys with no timestamps in the window. Call on a 5-minute timer from the dispatcher. Fixes findings in dispatcher, irc-bridge, and flood plugin simultaneously.
2. **Add `clearTimeout(pending.timer)` to DCC server error handler** — one line fix.
3. **Add `.clear()` calls to BotLink hub `close()`** — clear all 5 auxiliary maps.
4. **Flush BotLink leaf pending maps on disconnect** — iterate and resolve, then clear.
5. **Store DCC readline as class member** — call `rl.close()` in session cleanup.

### Medium effort (refactoring needed)

6. **Add MemoManager dispatcher/command cleanup to `detach()`** — add `unbindAll(OWNER_ID)` and `unregisterCommand('memo')`. Requires verifying the owner ID convention.
7. **Prune ChannelState.channels on bot PART/KICK** — need to inject or detect the bot's own nick to distinguish self-PART from other-PART.
8. **Add TTL sweep to BotLink hub protectRequests/cmdRoutes** — store timestamps, sweep every 60s.
9. **Add periodic pruning to chanmod enforcementCooldown/intentionalModeChanges** — hook into existing `time` bind.
10. **Add periodic pruning to flood offenceTracker** — hook into existing `time` bind.
11. **Store connection-lifecycle listener refs** — return a proper detach handle.

### Architectural (design changes needed)

12. **Handle partial chanmod init failure** — wrap `init()` to drain the teardowns array on exception, or have the plugin loader invoke partial teardown on failed init.
13. **Add orphan detection to relay virtual sessions** — listen for `botlink:disconnected` and clean up sessions from the disconnected bot.
14. **Store BotLink hub eventBus listener refs** — requires refactoring `setCommandRelay()` to track listeners and clean them in `close()`.
