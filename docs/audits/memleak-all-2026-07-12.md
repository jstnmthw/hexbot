# Memory Leak Audit: all

**Date:** 2026-07-12
**Scope:** `all` — every `.ts` file under `src/` and `plugins/` (186 files, ~54,000 lines), audited in 26 module groups
**Estimated risk:** High — driven entirely by M-01 (pre-auth remote OOM on the botlink listen port). Drops to Medium if the listen port is loopback/tunnel-only _and_ all leaves are trusted; note the module's own comments treat a compromised leaf as in-model.

## Summary

HexBot's lifecycle discipline is unusually strong for a codebase this size: `cleanupPluginResources()` reaps dispatcher binds, event-bus listeners, help/settings registrations, and per-plugin registries on every unload; the IRC bridge, DCC manager, and botlink bookkeeping all have verified symmetric teardown; and 78 deliberately bounded or cleanup-correct patterns were catalogued during the scan. **No leak was found that grows per-message under normal traffic.** The risk concentrates in two places: (1) the **botlink socket seam**, where Node-internal buffers — readline line accumulation inbound (M-01), socket write buffering outbound (M-02/M-03) — bypass every application-level cap the module carefully enforces; the inbound case is a remotely triggerable OOM reachable _before authentication_ on the hub listen port. (2) **Slow identity/tracking maps** (`networkAccounts`, ai-chat `userBuckets`/`trackedChannels`, chanmod timer sets) that prune on some departure paths but not all, growing over weeks-to-months with nick/channel churn.

Absent a hostile or degraded botlink peer, the bot would likely run for **months** before WARNING-class growth becomes noticeable. A hostile peer that can reach the botlink port can OOM it in **minutes** (M-01); a stalled-but-alive peer can grow the hub heap for the **entire connection lifetime** (M-02 + M-03).

**Findings:** 1 critical, 9 warning, 23 info

_(35 raw findings from 26 scanners + 2 critic follow-ups; every finding was adversarially verified by an independent 3-lens panel — cleanup-hunter, lifecycle-analyst, runtime-tracer — with a single-skeptic fast path for scanner-rated INFO. All 35 survived verification; 2 duplicate pairs were merged and 4 severities adjusted per verifier consensus, yielding 33.)_

## Method & coverage

- 92 agents total: 26 module-group scanners (every file read in full), 61 verification passes, 1 completeness critic, 2 targeted follow-up scans, plus follow-up verification.
- The critic confirmed coverage is exact: every `.ts` under `src/` and `plugins/` appears in exactly one scan group; `scripts/`, `tests/`, `dist/`, and build configs never run inside the long-lived bot process.
- Cross-module lifecycle verdicts from the critic: plugin reload is clean end-to-end (`src/plugin-loader.ts:670-790`); IRC reconnect reuses a single client with idempotent `connect()` and self-healing `attach()`; DCC teardown is exemplary; botlink _bookkeeping_ is clean — but both directions of **socket buffer accumulation** in the hub↔leaf seam were invisible to a per-file split and surfaced only in the follow-up sweep (M-01, M-02).
- Structural lesson for future audits: Node-internal buffering (readline line buffers, socket write buffers) only manifests at the seam between socket owner and protocol wrapper — a seam-focused pass should complement any per-file scan.

## Findings

### [CRITICAL] M-01 · Inbound frame-size caps bypassable: node:readline buffers a newline-free stream unboundedly before 'line' ever fires

**File:** `src/core/botlink/protocol.ts:264`

**Category:** node-level

**Growth rate:** wire-speed byte accumulation per socket while the peer withholds LF — ~125 MB per pre-auth socket at 100 Mbps in the 10s handshake window (x3 pending sockets per IP), ~1.1 GB (100 Mbps) to ~11 GB (1 Gbps) per authenticated leaf in the ~90s heartbeat window

**Found by:** sweep scanner

**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). lifecycle-analyst suggested WARNING because growth is attacker-driven rather than organic; kept CRITICAL — the pre-auth path needs no credentials and an OOM kill takes down the whole bot.

**Description:** CONFIRMED (focused follow-up). MAX_PRE_HANDSHAKE_FRAME_SIZE (4 KB) and MAX_FRAME_SIZE (64 KB) are enforced only inside rl.on('line') (protocol.ts:267-295), which fires only after a newline arrives. node:readline (created at line 264 with crlfDelay: Infinity) accumulates all bytes of an incomplete line in its internal buffer with no limit, and grep confirms no 'data'-level listener exists anywhere in src/core/botlink/ — the only socket-input listener is rl.on('line'). A peer that streams bytes without ever sending \n therefore grows process memory at wire speed while both caps sit unreachable. Exposure windows: (1) PRE-AUTH on the hub — any host that can reach the listen port gets max_pending_handshakes ?? 3 admitted sockets per IP (auth.ts:340, via auth.admit at hub.ts:480, up to MAX_PENDING_IPS=4096 IPs) x handshake_timeout_ms ?? 10_000 (hub.ts:531) x line rate, re-openable continuously after each timeout reclaim; this completely defeats the 4 KB pre-handshake cap whose stated purpose is limiting unauthenticated resource burn. (2) POST-AUTH on the hub — a compromised/buggy leaf streams newline-free bytes; lastMessageAt only advances on complete frames (hub.ts:780), so teardown waits for the heartbeat timeout, link_timeout_ms ?? 90_000 (hub.ts:155) plus up to one 30s tick. The attacker cannot extend past that (completing the giant line to refresh lastMessageAt would trip the 64 KB check), but multi-GB accumulation inside ~90-120s is enough to OOM a small host before reclamation. (3) MIRROR IMAGE on the leaf — leaf.ts wraps its socket in the same BotLinkProtocol (leaf.ts:355) with a 15s handshake timer (leaf.ts:361-362) and the same 30s/90s heartbeat defaults (leaf.ts:109-110), so a hostile or compromised hub can do the identical thing to every leaf. Memory is reclaimed only when the timeout path destroys the socket — within the window growth is uncapped. Contrast: the DCC module already solves exactly this with dataGuard (src/core/dcc/index.ts:541-560), which counts bytes between LFs on 'data' and destroys the socket at 4 KiB.

**Evidence:**

```ts
this.rl = createReadline({ input: socket, crlfDelay: Infinity });
...
rl.on('line', (line: string) => {
  ...
  if (this.preHandshake && lineBytes > MAX_PRE_HANDSHAKE_FRAME_SIZE) { ... }
  ...
  if (lineBytes > MAX_FRAME_SIZE) {
    this.logger?.error('Frame exceeds 64KB limit, dropping connection');
```

**Impact:** Remotely triggered RSS spike to OOM: pre-auth by anyone who can reach the hub port (mitigated only by the bind-to-loopback/tunnel deployment guidance), post-auth by a compromised leaf — a threat the module's own comments treat as in-model — and symmetrically against every leaf by a hostile hub. An OOM kill takes down the whole bot (weeks of uptime, all channels, all sessions). Both existing frame-size defenses are dead code against this input shape.

**Remediation:** Add a byte-counting 'data' guard mirroring DCC's dataGuard (dcc/index.ts:541-560), installed in the BotLinkProtocol constructor so hub and leaf both inherit it: track bytes since the last 0x0a, reset on LF, and close()/destroy the socket when the running count exceeds MAX_PRE_HANDSHAKE_FRAME_SIZE while this.preHandshake (else MAX_FRAME_SIZE). Store the listener in a named field and socket.off() it in close()/the 'close' handler, matching DCC's clearAllTimers() hygiene.

### [WARNING] M-02 · protocol.send() discards socket.write() backpressure — unbounded outbound buffer growth for slow botlink consumers

**File:** `src/core/botlink/protocol.ts:400` <br>
**Category:** stream-leak <br>
**Growth rate:** every outbound frame destined to a slow/stalled peer is retained in that socket's Node write buffer: one RELAY_OUTPUT frame per mirrored console line (up to 64 KB each, 30/s per source leaf), every hub broadcast (BSAY fan-out, PARTY_CHAT, permission-mutation SETFLAGS/ADDUSER/DELUSER, BOTJOIN/BOTPART), full CHAN + ADDUSER + CHAN_BAN_SYNC snapshots re-broadcast on each new-leaf bootstrap, plus one PING per 30 s — indefinitely, with no cap <br>
**Found by:** sweep scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). Found twice independently (botlink-leaf scan + critic follow-up); 6/6 verifier lenses across both reports upheld the leak. All three lenses on this report suggested WARNING (requires a stalled-but-alive peer) — downgraded from the scanner's CRITICAL. <br>
**Merged:** The botlink-leaf scanner independently reported the same root cause ("BotLinkProtocol.send() ignores socket.write() backpressure", WARNING, 3/3 upheld) — merged here as a single finding. See M-03 for the heartbeat gap that makes the growth window unbounded, and M-20 for the dead containment contract in hub.broadcast. <br>
**Description:** CONFIRMED (focused follow-up). BotLinkProtocol.send() (protocol.ts:382-402) calls this.socket.write(json + '\r\n') at line 400, discards the returned backpressure boolean, and returns true unconditionally — false is only returned for closed/destroyed sockets or frames over 64 KB. Grep confirms this is the ONLY socket write in src/core/botlink/ and that no 'drain' listener, socket.writableLength check, bufferSize inspection, or highWaterMark configuration exists anywhere in the module (all 'drain' hits are the unrelated PendingRequestMap.drain). When a peer consumes more slowly than the hub produces (stalled remote process, closed TCP receive window, asymmetrically degraded VPN/tunnel path), the kernel send buffer fills and every subsequent write is buffered in Node userland (socket.writableLength) on the hub heap forever. The inbound direction was explicitly hardened against slow consumers (MAX_PENDING_FRAMES = 1000, protocol.ts:213) but there is no outbound counterpart. The same BotLinkProtocol is used by leaf.ts, so a leaf pointed at a stuck hub leaks identically — single root cause, reported once here. Chattiest producers feeding the stuck buffer: RELAY_OUTPUT console mirroring (relay-handler.ts:133 emits one frame per output line of a relayed session), bootstrap syncs (relay-orchestrator.ts:156-160 ships ChannelStateSyncer.buildSyncFrames — one CHAN frame per channel with the full user list — plus one ADDUSER per user and one CHAN_BAN_SYNC per shared channel through the same protocol.send), and hub.broadcast fan-out to all leaves including the stuck one (BSAY via hub-bsay-router.ts:70, general leaf-frame fan-out via hub-frame-dispatch.ts:251, permission events via hub.ts:287/292/303). <br>
**Evidence:**

```ts
this.socket.write(json + '\r\n');
return true;
```

**Impact:** Hub process RSS grows by roughly the full botnet traffic volume destined to the stuck peer for as long as the connection lives — days to weeks of uptime ends in OOM kill of the whole bot. The bytes sit inside the stream's internal buffered list, so heap snapshots of application collections (leaves Map, routes, pendingCmds) look clean, making the leak hard to diagnose in production. A single degraded peer link silently degrades the entire hub. <br>
**Remediation:** Make send() honest: `return this.socket.write(json + '\r\n');` so callers see backpressure. Additionally enforce a ceiling — check `this.socket.writableLength` in send() (or expose it for the heartbeat, see the heartbeat finding) and when it exceeds a bound (1-4 MB) either destroy the connection (preferred: a peer that far behind has diverged anyway and will resync on reconnect) or shed droppable frame classes (RELAY_OUTPUT, PARTY_CHAT, BSAY) while the buffer is nonempty. Update hub.broadcast's docstring in the same change (see the hub.ts finding).

### [WARNING] M-03 · Heartbeat timeout considers only inbound frame age — stuck-writer peers are never disconnected, making the write-buffer leak unbounded

**File:** `src/core/botlink/heartbeat.ts:73` <br>
**Category:** stream-leak <br>
**Growth rate:** N/A — amplifier: extends the protocol.ts write-buffer growth window from ~90 s (link_timeout_ms) to the entire multi-week connection lifetime <br>
**Found by:** sweep scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** CONFIRMED (focused follow-up interaction). Heartbeat.tick() decides liveness solely from `Date.now() - this.opts.getLastMessageAt() > this.opts.timeoutMs`. The hub wires getLastMessageAt to `() => conn.lastMessageAt` (hub.ts:851), which is updated only in onSteadyState (hub.ts:780) — i.e. only by INBOUND frames. Outbound deliverability is never consulted: sendPing's result is ignored (hub passes `(seq) => conn.protocol.send({ type: 'PING', seq })`, and send() always returns true per the protocol.ts finding), and nothing inspects the socket's writableLength. Consequence: a leaf that reads at a trickle (bulk CHAN/RELAY_OUTPUT frames queue behind the closed TCP window) but whose own outbound path works — it runs the same Heartbeat class and keeps sending its own PINGs/PONGs/frames upstream — refreshes conn.lastMessageAt forever. The hub's 90 s link timeout never fires, so the per-socket outbound buffer from the protocol.ts finding grows for the full connection lifetime. Only a fully-hung peer (no inbound at all) is caught within ~90 s, which bounds that case to ~90 s of traffic. <br>
**Evidence:**

```ts
if (Date.now() - this.opts.getLastMessageAt() > this.opts.timeoutMs) {
```

**Impact:** The one mechanism designed to evict unhealthy peers cannot see the unhealthy-writer case, so there is no bound and no recovery path for the CRITICAL write-buffer leak: no disconnect, no resync, no operator signal until the OOM. <br>
**Remediation:** Extend HeartbeatOptions with an optional outbound-health probe, e.g. `getWriteBufferBytes?: () => number` and `maxWriteBufferBytes?: number`; in tick(), treat `getWriteBufferBytes() > maxWriteBufferBytes` exactly like the inactivity timeout (stop, then onTimeout). Hub wires it to the connection's socket.writableLength (expose a getter on BotLinkProtocol). Alternatively perform the writableLength ceiling check in the hub's onTick callback, which already runs per tick.

### [WARNING] M-04 · Virtual relay sessions on leaf bots survive hub-link drops — designed orphan-cleanup never matches

**File:** `src/core/botlink/relay-handler.ts:130` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one orphaned entry per inbound relay handle active at the moment a leaf's hub link drops; accumulates across reconnect cycles (capped at 64 per origin bot and bounded by registered permission handles) <br>
**Found by:** botlink-hub scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** handleRelayFrame creates a virtual session per RELAY_REQUEST via sessions.set(handle, {fromBot, sendOutput}) and removes it on RELAY_END or deleted-user RELAY_INPUT. Orphan cleanup on link loss is delegated to the owning orchestrator (src/core/relay-orchestrator.ts), whose 'botlink:disconnected' handler deletes sessions where session.fromBot === botname. That works on the hub role (hub.onLeafDisconnected emits the real leaf botname), but on the LEAF role the event is emitted as eventBus.emit('botlink:disconnected', 'hub', reason) — the literal string 'hub' — while session.fromBot holds the origin bot's real name (the hub stamps frame.fromBot = <sending leaf botname> in BotLinkHub.onSteadyState before forwarding). Unless the hub's configured botname is literally 'hub', the prune matches nothing, and BotLinkLeaf auto-reconnects with backoff, so the stale entries persist across link cycles. Release afterwards is only incidental: (a) the relay service mirror pushes a line through the stale sendOutput, the hub's router no longer knows the relay and echoes RELAY_END, which deletes the entry — requires a private NOTICE/PRIVMSG to arrive at the leaf; (b) a new RELAY_REQUEST for the same handle replaces the entry; (c) RELAY_INPUT for a since-deleted handle. None is guaranteed on a quiet bot. <br>
**Evidence:**

```ts
sessions.set(handle, {
  fromBot,
  sendOutput: (line: string) => {
    deps.sender.sendTo(fromBot, { type: 'RELAY_OUTPUT', handle, line });
  },
});
```

**Impact:** Bounded but unpruned growth of the orchestrator's virtualSessions map on leaf bots (worst case: one entry per registered handle, 64 per origin bot). Each stale entry pins its sendOutput closure, and attachRelayServiceMirror keeps forwarding every private NOTICE/PRIVMSG into dead sessions, emitting RELAY_OUTPUT frames onto the fresh link for relays that no longer exist — wasted frames and potential ghost output routed to a re-established relay for the same handle. Also defeats hasRelayConsole(), which suppresses direct memo delivery while a 'relay' is believed active. <br>
**Remediation:** Root-cause fix belongs in relay-orchestrator.ts: on the leaf role, clear ALL virtual sessions when the (single) hub link drops — e.g. have onDisconnectedCleanup wipe the map when this bot is a leaf, or emit the disconnect event with a sentinel the cleanup treats as 'all origins unreachable'. Alternatively, extend relay-handler.ts with an explicit clearSessionsFromBot/clearAll helper the orchestrator calls on link-down, so the release path lives next to the acquire path.

### [WARNING] M-05 · networkAccounts retains entries for nicks whose departure the bot can never observe

**File:** `src/core/channel-state.ts:288` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one retained entry per unique identified nick that PMs/NOTICEs the bot (or is NickServ-verified) without sharing a channel; cleared only on reconnect <br>
**Found by:** state-tracking scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** The network-wide account map is only pruned on observed departure: onPart deletes a nick when it is no longer in any tracked channel, and onQuit deletes unconditionally. But setAccountForNick() inserts unconditionally, and it is fed from paths that fire for users who share NO channel with the bot: the IRCv3 account-tag on inbound PRIVMSG and NOTICE (irc-bridge.ts checkAccount at lines 237/300/433 calls channelState.setAccountForNick for private messages too), and NickServ ACC/STATUS verification results (services.ts:788 resolveVerification). For such a nick the bot will never see a PART or QUIT (IRC only delivers those for common-channel users), so the entry survives until clearNetworkAccounts() runs on reconnect. On a stable connection with uptime measured in weeks/months, every unique identified stranger who messages the bot — or a single registered account cycling nicks and PMing once per nick — adds a permanent Map entry. There is no TTL, no size cap, and no presence-based sweep (contrast FloodLimiter's MAX_WARNED_KEYS and SlidingWindowCounter's MAX_KEYS). <br>
**Evidence:**

```ts
setAccountForNick(nick: string, account: string | null): void {
    const lower = this.lowerNick(nick);
    const previous = this.networkAccounts.get(lower);
    if (previous === account) return;
    this.networkAccounts.set(lower, account);
```

**Impact:** Slow unbounded heap growth between reconnects (Map entries of nick/account strings — roughly tens of MB per month under deliberate nick-rotation abuse, low single-digit MB under normal PM traffic on a large network), plus an ever-growing stale identity cache feeding the dispatcher's verification fast-path. <br>
**Remediation:** Either gate insertion on channel presence (skip the .set when the nick is in no tracked channel, if the PM fast-path value is deemed dispensable), or bound the map: add a size cap plus a periodic sweep that deletes entries whose nick is not present in any tracked channel — the FloodLimiter maybeSweep()/MAX_WARNED_KEYS pattern in src/core/flood-limiter.ts is the in-repo template.

### [WARNING] M-06 · onKick and bot self-departure never prune networkAccounts, unlike onPart

**File:** `src/core/channel-state.ts:398` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one retained entry per identified user kicked from their last shared channel, plus one per identified member of any channel the bot parts or is kicked from <br>
**Found by:** state-tracking scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** onPart contains a 'still present in any tracked channel, else delete from networkAccounts' prune (lines 369-381). onKick has no equivalent: it deletes the kicked user from the channel's users Map and emits channel:userLeft, but leaves the nick's networkAccounts entry in place. If the kicked user shared no other channel with the bot, no future PART/QUIT is observable, so the entry persists until reconnect. The same gap applies to bot self-departure: when the bot PARTs or is KICKed, `this.channels.delete(lower)` (lines 361 and 410) drops the whole ChannelInfo, but the networkAccounts entries of every member of that channel are never swept — for members sharing no other channel, those entries are orphaned. KICKs are routine in moderated channels, so this accrues steadily on long uptimes. <br>
**Evidence:**

```ts
private onKick(event: Record<string, unknown>): void {
    const kicked = String(event.kicked ?? '');
    const channel = String(event.channel ?? '');
    const lower = this.lowerChannel(channel);

    const ch = this.channels.get(lower);
    if (ch) {
      ch.users.delete(this.lowerNick(kicked));
    }

    // Bot was kicked — remove the entire channel entry
    if (this.botNick && this.lowerNick(kicked) === this.lowerNick(this.botNick)) {
      this.channels.delete(lower);
    }

    this.eventBus.emit('channel:userLeft', channel, kicked);
  }
```

**Impact:** Steady accumulation of orphaned account-cache entries between reconnects (bounded only by unique identified nicks ever kicked or left behind in departed channels); also prolongs the lifetime of stale identity data the dispatcher fast-path consults. <br>
**Remediation:** Extract onPart's 'if no longer present in any tracked channel, delete from networkAccounts' block into a private helper (e.g. pruneAccountIfGone(nickLower)) and call it from onKick for the kicked nick; on the bot self-PART/KICK branch, snapshot the departing channel's user keys before channels.delete() and run the same prune for each.

### [WARNING] M-07 · DCC session map entries orphaned when server casemapping changes between insert and delete

**File:** `src/core/dcc/session-store.ts:54` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one orphaned session entry per DCC session that closes after an IRC reconnect changed the server-advertised CASEMAPPING, when the session nick contains a fold-sensitive character ([ ] \ ~) <br>
**Found by:** dcc scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** DCCSessionStore keys the live-session map by ircLower(nick, this.casemapping), where `casemapping` is mutable state updated via setCasemapping(). Keys are re-derived at every call, not stored. A session is inserted at auth success (index.ts:1270 `this.sessionStore.set(session.nick, session)`) using the casemapping in effect at that moment. Bot.applyCasemappingToBot (src/bot.ts:1320-1327) re-propagates CASEMAPPING to the DCC store on every 'registered' event (src/core/connection-lifecycle.ts:290), and DCC sessions deliberately survive IRC reconnects (the `[disconnected]` notice at index.ts:889-893 exists for exactly that). If a reconnect lands on a server advertising a different casemapping (rfc1459 vs ascii folds `[ ] \ ~` differently; rfc1459 vs strict-rfc1459 differs on `~`), the later teardown path DCCSession.teardownSession → manager.removeSession(nick) → store.delete(nick) re-folds the nick with the NEW casemapping, computes a different key, and the delete silently misses. The closed session entry stays in the map for the life of the process. The stale-eviction path in checkNotAlreadyConnected (index.ts:1729) cannot self-heal it either, because its lookup also uses the new folding. Only closeForHandle() (which deletes by iterated key, session-store.ts:119-122) or detach()/closeAll() ever release it. <br>
**Evidence:**

```ts
sessionKey(nick: string): string {
    return ircLower(nick, this.casemapping);
  }
  ...
  set(nick: string, session: DCCSessionEntry): void {
    this.sessions.set(this.sessionKey(nick), session);
  }
  ...
  delete(nick: string): boolean {
    return this.sessions.delete(this.sessionKey(nick));
  }
```

**Impact:** Each orphan retains the full closed DCCSession graph (destroyed Socket, UserRecord, console-flag Set, manager backref) until process exit. Worse than the memory: checkSessionLimit counts sessionStore.size, so each orphan permanently consumes one of the max_sessions slots (default 5) — repeated occurrences lock operators out of DCC entirely until restart. Orphans are also iterated by fanoutLogToSessions on every log record and appear as ghost users in .who/getSessionList and the banner's 'others here' line. <br>
**Remediation:** Delete by the exact stored key instead of re-folding at delete time: capture the inserted key on the entry (or return it from set() and stash it on the session), and have removeSession/teardownSession use that stored key. Alternatively, re-key the entire map inside setCasemapping(), or make delete() fall back to an identity scan over entries() (the pattern closeForHandle already uses) when the folded-key lookup misses.

### [WARNING] M-08 · Stale user-bucket eviction is unreachable, so userBuckets grows with nick churn

**File:** `plugins/ai-chat/rate-limiter.ts:287` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one ~100-byte UserBucket per abandoned nick (nick change, or a QUIT/PART the bot never witnesses); never reclaimed for process lifetime <br>
**Found by:** ai-chat-providers scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** The map's designed backstop, evictStaleBuckets(), can never run and would not evict the right entries if it did. Defect 1 (unreachable trigger): refillBucket() advances bucket.lastRefill to within refillMs of now (`bucket.lastRefill += earned * refillMs` leaves `now - lastRefill = elapsed % refillMs < refillMs`) BEFORE evaluating `now - bucket.lastRefill > STALE_BUCKET_IDLE_MS` (1h). The condition can only be true when refillMs > 3,600,000ms, i.e. user_refill_seconds > 3600 — the shipped default is 12 (config.ts: `userRefillSeconds: asNum(rl.user_refill_seconds, 12)`). At any sane config the sweep is dead code. Defect 2 (wrong filter): even if invoked, the sweep only deletes buckets with `b.tokens >= this.config.userBurst`, but refill is lazy (only on that user's own next check/record), so a drive-by user who spent a token and vanished has tokens frozen at burst-1 forever and is never evicted. The external cleanup wiring in index.ts (rateLimiter.forgetUser on user PART/KICK and QUIT fan-out) handles clean departures, but the plugin binds only join/part/kick/quit/topic/pubm — there is NO 'nick' bind, so every nick change strands the old nick's bucket, and the eventual QUIT clears only the final nick. This is precisely the case the code's own comment says the eviction exists for: "safe to evict so nick-rotation doesn't grow userBuckets without bound". <br>
**Evidence:**

```ts
this.userBuckets.set(key, bucket); // line 287 — entry creation

// refillBucket(), lines 303-315 — the dead trigger:
bucket.tokens = Math.min(this.config.userBurst, bucket.tokens + earned);
bucket.lastRefill += earned * refillMs;
if (
  bucket.tokens >= this.config.userBurst &&
  now - bucket.lastRefill > STALE_BUCKET_IDLE_MS &&
  this.userBuckets.size > EVICTION_MIN_BUCKETS
) {
  this.evictStaleBuckets(now);
}

// evictStaleBuckets(), lines 320-324 — the filter that skips drained buckets:
for (const [key, b] of this.userBuckets) {
  if (b.lastRefill < cutoff && b.tokens >= this.config.userBurst) {
    this.userBuckets.delete(key);
  }
}
```

**Impact:** Slow, unbounded heap drift over weeks/months of uptime on networks with nick rotation (away-nick cycling, ghost/reconnect suffixes) or users the bot loses sight of after it parts a shared channel. ~100 bytes per stranded nick means degradation not fast OOM, but with the backstop dead the map's only bound is process restart — and rateLimiter.reset() on plugin teardown means a reload masks the growth, making it hard to spot in soak testing. <br>
**Remediation:** Make the sweep reachable and correct: evaluate staleness (or run evictStaleBuckets) on a trigger independent of the just-touched bucket's post-refill state — e.g. every Nth getOrCreateBucket call or whenever userBuckets.size crosses a threshold — and drop the `tokens >= userBurst` filter: for any bucket idle longer than userBurst*refillMs (36s at defaults, vs the 1h cutoff), deletion is semantically identical to lazy refill because getOrCreateBucket recreates at full burst. Optionally also bind 'nick' in index.ts to forgetUser(oldNick).

### [WARNING] M-09 · AmbientEngine.trackedChannels never removes parted/kicked channels and has no size cap

**File:** `plugins/ai-chat/ambient.ts:87` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one Set entry per unique channel that ever has a pubm message; entries persist after bot PART/KICK and are only released at plugin teardown/reload <br>
**Found by:** ai-chat-state scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Merged:** The ai-chat-core scanner independently flagged the same Set via its call site (plugins/ai-chat/index.ts:768, rated INFO, 1/1 upheld) — merged here. <br>
**Description:** The ambient engine tracks channels via `onChannelActivity()`, which is called for every pubm event (plugins/ai-chat/index.ts:768, before even the bot-self check). Entries are added with `.add()` at line 87 and the only removal anywhere is the wholesale `.clear()` inside `stop()` (line 82), which runs solely at plugin teardown. The class exposes no per-channel removal API, and the bot-part/kick cleanup branch in index.ts (lines 575-598) purges SocialTracker (`dropChannel`), ContextManager (`clearContext`), EngagementTracker (`dropChannel`), and RateLimiter (`forgetChannel`) — but has nothing to call on the ambient engine, so channels the bot has left stay tracked forever. All three sibling per-channel structures enforce a MAX_CHANNELS = 256 hard cap explicitly to defend against invite-spam/auto-join exhaustion (context-manager.ts:68, social-tracker.ts:64, engagement-tracker.ts:18); trackedChannels is the one per-channel collection with neither a cap nor pruning. Each stale entry is also iterated by the 30-second tick loop (`tickInner()` line 146) for the remaining plugin lifetime, performing dead lookups against the social tracker (which returns 'dead'/undefined for dropped channels, so no misfires — just wasted work). <br>
**Evidence:**

```ts
onChannelActivity(channel: string): void {
    this.trackedChannels.add(channel.toLowerCase());
  }

// declaration (line 48):
private trackedChannels = new Set<string>();

// only cleanup, inside stop() (line 82):
this.trackedChannels.clear();
```

**Impact:** Slow unreclaimed growth on a bot with churning channel membership (invites, auto-join, temporary channels): each channel string is retained until the plugin reloads, and the 30s ambient tick iterates every stale key for the process lifetime. Memory per entry is small (a lowercased channel-name string plus Set overhead), so this degrades over weeks/months rather than days, but it is the only ai-chat per-channel structure with no eviction path — a deliberate invite-spam flood grows it without bound while every sibling tracker stays capped at 256. <br>
**Remediation:** Add an `AmbientEngine.dropChannel(channel: string)` method (`this.trackedChannels.delete(channel.toLowerCase())`) and call it from the bot-part and bot-kick cleanup branches in index.ts alongside `socialTracker?.dropChannel(ctx.channel)`. Additionally enforce a MAX_CHANNELS = 256 cap in `onChannelActivity()` (evict oldest-inserted via `this.trackedChannels.keys().next().value`, mirroring SocialTracker.maintain) so the set scales with the other per-channel maps.

### [WARNING] M-10 · Tracked sustained-presence reset timers accumulate forever in CycleState timer Set

**File:** `plugins/chanmod/join-recovery.ts:151` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one retained Timeout (plus its captured closure when the timer fires rather than being cleared) per bot JOIN that follows a join-error recovery attempt; zero in healthy channels, up to ~12/hour per channel during a sustained ban-recover cycle at max backoff <br>
**Found by:** chanmod-enforce scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). <br>
**Description:** The bot-join handler creates a 5-minute sustained-presence reset timer and registers it via state.cycles.track(timer). CycleState's track() (plugins/chanmod/state.ts:147-149) only does timers.add(timer) — the backing Set removes entries solely inside schedule()'s self-removing wrapper (state.ts:130 is the only timers.delete site) or wholesale in clearAll() at plugin teardown; cycles.pruneExpired() prunes locks only, never timers. So every timer registered through track() stays in the Set for the remainder of the plugin instance's lifetime, whether it fires (deleting the recoveryState entry) or is cleared by one of the three clearTimeout sites (join-recovery.ts:138, :162, :378). Node nulls _onTimeout only in clearTimeout, not when a timer fires, so fired-and-retained Timeout objects keep their callback closure reachable — pinning rs, the recoveryState Map, chanKey, api, and the captured join ctx. Since a new timer is created and tracked on every bot join while a recoveryState entry exists (repeated ban→recover→rejoin cycles, netsplit rejoin storms with join errors), the Set grows without bound until .reload/.unload. <br>
**Evidence:**

```ts
const timer = setTimeout(() => {
  if (rs.resetTimer !== timer) return;
  recoveryState.delete(chanKey);
  api.debug(`Join recovery backoff reset for ${ctx.channel} (sustained presence)`);
}, SUSTAINED_PRESENCE_MS);
rs.resetTimer = timer;
state.cycles.track(timer);
```

**Impact:** Slow, unbounded heap growth over weeks/months of uptime in any environment with recurring join errors (ban wars, flaky netsplits, services outages): dead Timeout handles plus, for fired timers, their full closure graphs are retained until the next plugin reload. Also corrupts the cycles.size diagnostic (counts thousands of dead timers), obscuring future leak analysis. <br>
**Remediation:** Make tracked timers removable: add an untrack(timer)/cycles remove path — have the timer callback untrack itself on fire, and call untrack at the three clearTimeout sites (or have track() return a dispose handle stored in rs instead of the raw timer). Alternatively route the reset through a schedule()-style self-removing wrapper that returns a cancel function kept in rs.resetTimer.

### [INFO] M-11 · wrappedHandlers tracking array diverges from dispatcher state — entries pushed before bind() and never reconciled on refusal or non-stackable overwrite

**File:** `src/plugin-api-factory.ts:310` <br>
**Category:** unbounded-collection <br>
**Growth rate:** One stale WrappedEntry per re-bind of an already-bound pub/msg mask (dispatcher overwrite semantics), and one per api.bind() call past the 1000-bind hardcap; channel-scoped plugins only; held for the entire plugin lifetime <br>
**Found by:** plugin-system scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). Downgraded WARNING → INFO on 2/3 verifier consensus (growth requires dispatcher-refused or non-stackable overwritten re-binds, rare in practice). <br>
**Description:** For channel-scoped plugins, api.bind() pushes a WrappedEntry into the per-api wrappedHandlers array BEFORE calling dispatcher.bind(). The dispatcher can decline or drop that bind without the factory noticing, in two ways: (1) at PLUGIN_BIND_HARDCAP the dispatcher logs and does a bare `return` — it does not throw (src/dispatcher.ts:213-217) — so every refused bind still leaves a permanent entry in wrappedHandlers, directly contradicting the comment at lines 225-228 ("A plugin that hits the dispatcher cap never makes it into wrappedHandlers either"); (2) for non-stackable types (pub/msg) the dispatcher REMOVES the previously-bound wrapped handler and installs the new one (src/dispatcher.ts:229-241), but the factory keeps the old WrappedEntry — so a plugin that legitimately relies on the documented overwrite semantics (re-bind same mask to replace a handler, e.g. on a settings change) accumulates one stale entry per re-bind with no cap, no warning, and no path below the hardcap that ever trips it. Each stale entry retains two closures (the plugin's original handler plus the scope wrapper) and whatever scope those handlers captured. Side effect: after a same-handler re-bind, api.unbind() finds the STALE entry first, calls dispatcher.unbind() with a wrapper that is no longer registered (silent no-op), splices only the stale entry, and leaves the live dispatcher bind attached — the unbind silently fails and the handler keeps firing. <br>
**Evidence:**

```ts
wrappedHandlers.push({ handler: widenedHandler, type, mask, wrapped });
dispatcher.bind(type, flags, mask, wrapped, pluginId);
```

**Impact:** Unbounded closure retention inside a long-lived plugin's api: the hardcap that exists precisely to contain runaway api.bind() loops bounds the dispatcher at 1000 entries but does not bound this array, so the containment is defeated on the factory side. For well-behaved scoped plugins that use re-bind-to-replace, entries (and their captured handler scopes) accumulate for the weeks/months the plugin stays loaded, released only on unload/disable. The stale-entry-first unbind lookup additionally leaves live binds attached after api.unbind(), keeping handler closures reachable from the dispatcher indefinitely. <br>
**Remediation:** Make dispatcher.bind() report acceptance (return boolean or the created entry) and only push into wrappedHandlers on success; on non-stackable binds, first splice any existing wrappedHandlers entry with the same (type, mask) — mirroring the dispatcher's overwrite — before pushing the new one. Also fix the false bounding comment at lines 225-228.

### [INFO] M-12 · Stale JSDoc claims hot-reload re-imports the plugin module and resets module-level state — false since cache-busting was removed, masking plugin-side reload residue

**File:** `src/plugin-api-factory.ts:150` <br>
**Category:** reload-residue <br>
**Growth rate:** N/A — documentation defect; the plugin-side state it conceals persists and grows across enable/disable cycles instead of resetting <br>
**Found by:** plugin-system scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** The PluginApiHandle JSDoc (the authoritative description of what dispose() does and does not cover) states that module-level state "resets" because "Hot-reload re-imports the module". That was true under the old cache-busted `import('?t=<timestamp>')` path, but plugin-loader.ts:407-415 deliberately removed cache-busting ("a second `load()` of the same plugin path resolves to the same cached module") and the `.load`/`.unload`/`.reload` commands were deleted in lockstep (src/core/commands/plugin-commands.ts:6-8). Today a disable→enable cycle via `.set core plugins.<id>.enabled` re-runs init() against the SAME cached module instance: top-level `let`s, module-level Maps/Sets, and any api/config references stashed at module scope survive unload and are never released by the loader (Node's ESM registry has no eviction API). A plugin author reading this JSDoc will conclude module-level caches are reload-safe when they are the one category of plugin state the loader cannot clean. <br>
**Evidence:**

```ts
 * - Module-level state captured before `init()` returned (top-level
 *   `let`s, imported singletons). Hot-reload re-imports the module so
 *   this state resets, but the running closure of a stale interval is
 *   not affected.
```

**Impact:** Obscures leak analysis for every plugin in the tree: module-level mutable state (the highest-risk reload-residue class in this codebase) is documented as self-resetting, so plugin authors and reviewers will not add explicit clearing in teardown(). A module-level Map keyed by nick/channel keeps its contents across enable/disable cycles; a module-level `api` reference keeps the disposed api object graph (config copies, wrappedHandlers, callback maps, logger) alive for the life of the process. <br>
**Remediation:** Rewrite the bullet to match current loader behavior: unload/enable-disable reuses the cached module instance, module-level state is NOT reset, and plugins must reset module-level mutable state in teardown() (or lazily in init()). Cross-reference the plain-import rationale comment in plugin-loader.ts load().

### [INFO] M-13 · Plugin subscription surfaces (on* family and *.onChange) are uncapped during plugin lifetime — cleanup deferred entirely to unload, no analogue of the bind hardcap

**File:** `src/plugin-api-factory.ts:825` <br>
**Category:** listener-leak <br>
**Growth rate:** One event-bus listener per on*() call with a distinct callback (three listeners per onPermissionsChanged call, fanned across user:added/user:flagsChanged/user:hostmaskAdded), plus one registry callback per channelSettings/coreSettings/settings onChange call; all held until plugin unload <br>
**Found by:** plugin-system scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** The five on* registration methods (onModesReady, onPermissionsChanged, onUserIdentified, onUserDeidentified, onBotIdentified) dedupe only by callback reference identity — a plugin that subscribes with a fresh closure per call (e.g. inside a bind handler or a per-channel loop) accumulates a wrapper in the byCallback map, an entry in the loader's shared per-plugin list, and a live event-bus listener on every call, with no cap and no warning beyond Node's MaxListeners notice (the bus raises it to 20 via setMaxListeners in src/event-bus.ts:131). The channelSettings.onChange / coreSettings.onChange / settings.onChange surfaces are weaker still: each call appends a fresh wrapper to the registry's per-owner listener stack, PluginChannelSettings exposes no offChange at all, and the coreSettings/settings offChange drains the whole owner stack rather than one callback — so a plugin cannot shed individual subscriptions mid-lifetime. All of these ARE fully drained by cleanupPluginResources on unload (verified: plugin-loader.ts:681-790 plus registry offChange(owner) calls), so this is not a standing leak — but the codebase's own threat model treats runaway per-call registration by a plugin as expected misbehavior (the dispatcher enforces PLUGIN_BIND_WARN and a 1000-bind hardcap for exactly this), and these parallel surfaces have no equivalent bound for a bot with weeks-to-months uptime. <br>
**Evidence:**

```ts
const list = modesReadyListeners.get(pluginId) ?? [];
list.push(wrappedListener);
modesReadyListeners.set(pluginId, list);
eventBus.on('channel:modesReady', wrappedListener);
```

**Impact:** A misbehaving or careless plugin (subscribing per event/per message with fresh closures) grows event-bus listener arrays and registry callback stacks without bound for as long as it stays loaded; each wrapper retains the plugin callback's captured scope. Every emit of the affected event also iterates the accumulated listeners, degrading dispatch latency before memory becomes the visible symptom. <br>
**Remediation:** Mirror the dispatcher's containment: track a per-plugin subscription count across the on*/onChange surfaces with a warn threshold and hard cap (refuse + log, matching PLUGIN_BIND_HARDCAP semantics). Optionally expose per-callback offChange on the channelSettings/coreSettings/settings views so plugins can release subscriptions without a full unload.

### [INFO] M-14 · unregisterCommand releases the handler but never the mirrored help entry (and uses a case-mismatched delete key)

**File:** `src/command-handler.ts:162` <br>
**Category:** reload-residue <br>
**Growth rate:** one retained HelpEntry per distinct command name ever unregistered — no accumulation across repeated register/unregister cycles (HelpRegistry upserts by strict key) <br>
**Found by:** dispatch-events scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** registerCommand mirrors every command into the shared HelpRegistry under the reserved 'core' bucket (line 162), but unregisterCommand (lines 166-168) only deletes from this.commands — the mirrored HelpEntry is never removed. HelpRegistry exposes only per-plugin unregister(pluginId) (src/core/help-registry.ts:131), and unregistering 'core' would wipe every core command's help, so there is no way to release a single entry. The one runtime caller today is src/core/memo.ts:206 (memo detach), after which '.memo' stays listed in .help despite the command being gone. A second asymmetry in the same pair: registerCommand stores under name.toLowerCase() (line 154) while unregisterCommand deletes the raw name (line 167) — a mixed-case caller would silently no-op the delete and retain the full CommandEntry, including its handler closure (which typically captures db/permissions/client scope). Latent today since the only caller passes a lowercase name. Both retentions are bounded by the set of distinct command names in source, so this is residue that obscures leak analysis rather than growth under traffic. <br>
**Evidence:**

```ts
registerCommand:
    this.commands.set(name.toLowerCase(), { name, options, handler });
    ...
    this.helpRegistry.register('core', [entry]);
  }

  /** Remove a previously registered command. Returns true if it existed. */
  unregisterCommand(name: string): boolean {
    return this.commands.delete(name);
  }
```

**Impact:** Small and bounded: a few retained strings per distinct unregistered command plus a stale .help listing that advertises a dead command. The latent case-mismatch path would retain a handler closure (and everything it captures) until process exit. Main cost is that the register/unregister pair looks symmetric but is not, which hides residue from future dynamic-command or attach/detach callers. <br>
**Remediation:** Make unregisterCommand fully symmetric with registerCommand: delete this.commands.get/delete with name.toLowerCase(), and remove the mirrored help entry — e.g. add a HelpRegistry.remove(pluginId, command) method (the two-level Map already supports per-key deletion) and call it with `${this.prefix}${name}` from unregisterCommand.

### [INFO] M-15 · Presence-check interval re-armed after lifecycle teardown by the cancelled identify_before_join await

**File:** `src/core/connection-lifecycle.ts:351` <br>
**Category:** timer-leak <br>
**Growth rate:** at most one resurrected setInterval per disconnect/shutdown landing inside the identify_before_join await window (up to 60s after each registration); never accumulates — the single presenceTimer slot is cleared by the next 'registered'/'close', or orphaned exactly once at shutdown <br>
**Found by:** connection scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** The async onRegistered handler awaits a cancellable promise when services.identify_before_join is set (lines 312-341). All three resolution arms — bot:identified, bot:disconnected, and the cancelIdentifyAwait hook invoked by removeListeners() — resolve the same promise, and the continuation after the await unconditionally runs joinConfiguredChannels(deps) and re-arms presenceTimer via startChannelPresenceCheck(). Shutdown variant: Bot.shutdown() runs stopPresenceCheck() + removeListeners(); removeListeners() calls cancelIdentifyAwait(), whose resolve() schedules the continuation as a microtask — which then arms a brand-new interval after the handle has been discarded (bot.ts nulls _lifecycleHandle), so nothing can ever clear it. Disconnect variant: onClose's 'log-and-emit-disconnect' step synchronously fires the bot:disconnected once-arm; after onClose finishes its 'cancel-presence-timer' step, the microtask continuation re-arms the interval, which then ticks every channel_rejoin_interval_ms (30s default) through the entire reconnect backoff window — issuing client.join() calls (dropped by irc-framework's connection.write() when not connected, so no buffer growth) and the 'Not in configured channel' warnings that the onClose comment explicitly says the clear exists to prevent. Mitigations that keep this at INFO: startChannelPresenceCheck unref()s the handle (channel-presence-checker.ts:139), the slot self-heals on the next 'registered'/'close', and src/index.ts exits the process after shutdown. <br>
**Evidence:**

```ts
permanentFailureChannels.clear();
if (presenceTimer !== null) clearInterval(presenceTimer);
presenceTimer = startChannelPresenceCheck(deps, permanentFailureChannels, retrySchedule);
```

**Impact:** In the shutdown variant the orphaned interval closure pins the full connection dependency graph (client, channelState, configuredChannels, messageQueue, dispatcher, eventBus, logger, permanentFailureChannels) until process exit — a real retention in any embedding or test harness that calls shutdown() without exiting. In the disconnect variant it performs spurious work and log noise for the whole backoff window (potentially 30 minutes on the rate-limited tier), violating the teardown contract the code documents; no unbounded memory growth because irc-framework drops writes while disconnected. <br>
**Remediation:** Gate the continuation: have the identify_before_join promise resolve a status ('proceed' | 'aborted' — set by the cancelIdentifyAwait hook and the bot:disconnected arm) and return from onRegistered without calling joinConfiguredChannels or re-arming presenceTimer when aborted. Alternatively set a closure-level tornDown/disconnected flag in removeListeners()/the disconnect arm and check it immediately after the await.

### [INFO] M-16 · Core 'invite' dispatcher bind is not released by the ConnectionLifecycleHandle that registered it

**File:** `src/core/connection-lifecycle.ts:810` <br>
**Category:** reload-residue <br>
**Growth rate:** one stacked dispatcher bind per repeat Bot.connect() invocation — currently zero at runtime (connect() runs exactly once per process, bot.ts:657); latent on the repeat-connect path bot.ts explicitly anticipates ('future STS path, manual .reconnect command') <br>
**Found by:** connection scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** registerConnectionEvents() calls bindCoreInviteHandler(), which registers dispatcher.bind('invite', '-', '*', handler, 'core'), but the returned ConnectionLifecycleHandle (stopPresenceCheck / removeListeners / cancelReconnect) never unbinds it. The bind is only released out-of-band at process shutdown, by IRCBridge.detach() calling dispatcher.unbindAll('core') (irc-bridge.ts:201). Today this is safe because Bot.start() guards _isStarted and calls connect() once, and reconnects go through the driver's client.connect() without re-registering the lifecycle. However, Bot.teardownPriorConnection() (bot.ts:1244-1259) is explicitly written for repeat connect() calls and claims 'so we don't stack listeners' — yet it only tears down the client listeners and timers. Each repeat registerConnectionEvents() would push one more 'invite' bind ('invite' is stackable; dispatcher NON_STACKABLE_TYPES is only {'pub','msg'}), each a fresh closure capturing that call's deps (client, configuredChannels, logger, getCasemapping), none removable until process shutdown. <br>
**Evidence:**

```ts
  dispatcher.bind(
    'invite',
    '-',
    '*',
    (ctx) => {
```

**Impact:** If the anticipated .reconnect command or an STS-driven repeat Bot.connect() lands, binds accumulate one per reconnect cycle: each INVITE then fires N duplicate handler runs (N duplicate JOIN attempts), and every stale closure keeps its captured deps reachable for the life of the process. The lifecycle handle's claimed idempotency is incomplete, which obscures leak analysis for whoever builds that feature. <br>
**Remediation:** Make ConnectionLifecycleHandle symmetric with what registerConnectionEvents registers: keep the invite handler reference and call dispatcher.unbind('invite', '*', handler) inside removeListeners(), or register the bind under a lifecycle-scoped owner (e.g. 'core:connection-lifecycle') and call dispatcher.unbindAll(owner) in the handle teardown.

### [INFO] M-17 · ensureChannel reachable from stray non-self JOIN/NAMES, unlike the guarded TOPIC/324 paths

**File:** `src/core/channel-state.ts:334` <br>
**Category:** unbounded-collection <br>
**Growth rate:** N/A under a well-behaved server; one permanent ChannelInfo per stray non-self JOIN or 353 for an untracked channel (buggy server, netsplit replay) <br>
**Found by:** state-tracking scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** onJoin (line 334) and onUserlist (line 577) allocate channel records via ensureChannel() keyed by the server-supplied channel name, without checking that the JOIN is the bot's own or that the channel is already tracked. The file itself establishes this exact threat model and guards the equivalent paths: onTopic (lines 641-646) and onChannelInfo (lines 660-665) deliberately refuse to allocate, with the comment that a stray numeric 'would otherwise grow `this.channels` unboundedly when a hostile or buggy server emits stray 332/TOPIC numerics'. The disconnecting-window guard covers only the reconnect race, not steady-state strays. Under a correct server JOIN/353 arrive only for channels the bot is in, so this is not a leak in normal operation — but the guard asymmetry means one class of stray server line allocates permanent ChannelInfo records (removable only by self-PART/KICK of that exact channel or reconnect) while another class is defended. <br>
**Evidence:**

```ts
const ch = this.ensureChannel(channel);
const user: UserInfo = {
  nick,
  ident,
  hostname,
  hostmask: `${nick}!${ident}@${hostname}`,
  modes: [],
  joinedAt: new Date(),
  accountName,
};
ch.users.set(this.lowerNick(nick), user);
```

**Impact:** Usage-dependent: with a buggy server, misbehaving bouncer, or netsplit re-merge replaying lines, phantom ChannelInfo/UserInfo graphs accumulate until reconnect; they also enter getAllChannels() and are swept by the presence checker forever. No growth on healthy networks. <br>
**Remediation:** In onJoin, call ensureChannel only when the joining nick is the bot or the channel is already tracked (mirror the onTopic/onChannelInfo containment); in onUserlist, look up with channels.get() and ignore NAMES for untracked channels — a legitimate NAMES always follows the bot's own JOIN, which is the sanctioned allocation site.

### [INFO] M-18 · CIDR ban cap enforced only after DB persistence; uncapped reload lets _linkbans and manualCidrBans grow past MAX_CIDR_BANS

**File:** `src/core/botlink/auth-store.ts:93` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one persisted DB row per unique CIDR ever manually banned (admin-command-driven); permanent bans (bannedUntil=0) are never swept, and each survives into memory on every restart <br>
**Found by:** botlink-leaf scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** addManualBan() writes the ban to the DB-backed linkBanStore BEFORE checking the MAX_CIDR_BANS (500) cap, so a CIDR ban rejected from the hot path is still persisted. loadPersistedBans() then loads every non-expired persisted CIDR ban into manualCidrBans with no cap check at all (line 174). Net effect: the _linkbans KV namespace grows without bound across the process lifetime, and after a restart the in-memory manualCidrBans map can exceed the cap that exists specifically to bound it. The expiry sweep in auth.ts only removes bans with a non-zero bannedUntil, so permanent bans accumulate forever. Growth requires operator .botlink ban commands (verified: only reachable via botlink-commands.ts:247 -> hub.manualBan -> auth.manualBan), not normal traffic, hence INFO rather than WARNING. <br>
**Evidence:**

```ts
addManualBan(ban: LinkBan): boolean {
    this.linkBanStore?.set(ban);

    if (ban.ip.includes('/')) {
      // CIDR range — enforce cap to prevent connection-path DoS
      if (!this.manualCidrBans.has(ban.ip) && this.manualCidrBans.size >= MAX_CIDR_BANS) {
        this.logger?.warn(`CIDR ban limit (${MAX_CIDR_BANS}) reached, rejecting ${ban.ip}`);
        return false;
      }
...and in loadPersistedBans() (line 173-174, no cap):
      if (ban.ip.includes('/')) {
        this.manualCidrBans.set(ban.ip, ban);
```

**Impact:** Unbounded DB growth in the _linkbans namespace (one row per unique CIDR ever banned, permanent rows immortal), and an in-memory manualCidrBans map that silently exceeds its documented 500-entry cap after restart. Every admission check (BotLinkAuthManager.admit) linear-scans manualCidrBans per non-whitelisted connection, so an over-cap map re-opens the connection-path DoS the cap was added to prevent. Per-entry memory is small (~150 B) but the retention is permanent. <br>
**Remediation:** Move this.linkBanStore?.set(ban) to after the CIDR cap check so rejected bans are never persisted, and enforce MAX_CIDR_BANS in loadPersistedBans() (skip + warn once the cap is reached). Optionally add a startup sweep that deletes expired rows from the store.

### [INFO] M-19 · Relayed CMD execution retains ctx/output/closure with no executor-side timeout or outstanding-count cap

**File:** `src/core/botlink/cmd-exec.ts:56` <br>
**Category:** closure-capture <br>
**Growth rate:** one retained {frame, output[], ctx, sendResult closure} set per inbound CMD frame whose command handler never settles; N/A for well-behaved handlers <br>
**Found by:** botlink-leaf scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** executeCmdFrame() chains sendResult onto cmdHandler.execute() with no deadline. The requesting side is fully bounded (PendingRequestMap: 10s timeout, 4096 cap, drained on disconnect), but the executing side keeps the output array, the CommandContext (whose reply closure holds output), and the sendResult closure (which captures the hub/leaf send path) alive until the handler promise settles. A relayToHub-reachable command handler that never settles — e.g. a plugin awaiting an outbound fetch with no AbortController/timeout — accumulates one retained closure set per invocation. The leaf's inbound CMD rate limit (50/s, leaf.ts) caps arrival rate but not the number of outstanding executions, so retention is unbounded over weeks of uptime if any handler can hang. <br>
**Evidence:**

```ts
cmdHandler
  .execute(`.${command} ${args}`.trim(), ctx)
  .then(() => {
    sendResult(ref, output);
  })
  /* v8 ignore start -- .catch only fires if command handler throws */
  .catch((err) => {
    sendResult(ref, [`Error: ${err instanceof Error ? err.message : String(err)}`]);
  });
```

**Impact:** Slow, invisible retention on the executing bot when any relayed command handler hangs: the requester already received its 10s timeout reply, so nothing surfaces operationally while pending promise chains, output buffers, and contexts accumulate on the executor. Asymmetric with the otherwise carefully bounded pending-request design on the requesting side. <br>
**Remediation:** Race cmdHandler.execute() against a deadline matching the requester's ceiling (10s): on timeout, send a 'command timed out' CMD_RESULT once and drop references (guard sendResult so it fires at most once). Alternatively track an outstanding-execution counter with a hard cap that refuses new CMD frames when saturated.

### [INFO] M-20 · broadcast() documents an unreachable 'write buffer full' divergence-detection contract

**File:** `src/core/botlink/hub.ts:207` <br>
**Category:** stream-leak <br>
**Growth rate:** N/A <br>
**Found by:** sweep scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** CONFIRMED (focused follow-up). The broadcast() docstring (hub.ts:205-213) claims 'a send() that returns false (write buffer full, socket half-open) or throws is logged and ... A subsequent bootstrap or heartbeat round-trip will detect the divergence and either resync or disconnect the stuck leaf', and the warn at hub.ts:224-226 repeats 'failed (write buffer full or socket half-open)'. Three parts of that contract do not exist: (1) protocol.send() has no buffer-full return path — it returns false only for closed/destroyed sockets or frames over 64 KB; (2) the heartbeat cannot detect a stuck writer (see heartbeat.ts finding); (3) there is no post-handshake resync mechanism — onSyncRequest fires only inside acceptHandshake (hub.ts:715), never periodically. The 'socket half-open' clause is the only reachable trigger for the warn. This is exactly the kind of comment that obscures leak analysis: it asserts the slow-consumer case is detected and self-healing when it is silently unbounded. <br>
**Evidence:**

```ts
* Per-leaf error containment: a `send()` that returns false (write
   * buffer full, socket half-open) or throws is logged and the
   * remaining leaves still receive the frame. A subsequent bootstrap
   * or heartbeat round-trip will detect the divergence and either
   * resync or disconnect the stuck leaf.
```

**Impact:** Operators and future audits reading broadcast() conclude slow-consumer buffering is already handled and look elsewhere for the memory growth; the warn message would also misattribute a half-open-socket failure to buffer pressure. <br>
**Remediation:** Rewrite the docstring and warn text to state the real false conditions (connection closed/destroyed, frame over 64 KB). Once send() propagates socket.write()'s boolean (per the protocol.ts finding), 'write buffer full' becomes accurate — update the wording as part of that change and describe the actual recovery mechanism chosen (writableLength ceiling disconnect or frame shedding).

### [INFO] M-21 · DCCSession.write() ignores backpressure — an authenticated client that types but never reads pins an ever-growing outbound queue

**File:** `src/core/dcc/index.ts:699` <br>
**Category:** stream-leak <br>
**Growth rate:** log-fanout + party-line + command-reply volume for the session lifetime; unbounded in time while the client sends at least one line per idle window (default 300s) <br>
**Found by:** sweep scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** DCCSession.write() calls this.socket.write(data) without checking the return value or socket.writableLength. The idle timer resets on inbound lines only (onLine -> resetIdle), and TCP keepalive (60s) detects dead peers, not stalled-but-alive readers — so an authenticated client that sends a line every few minutes while never reading keeps the session open indefinitely as receiveLog() fan-out (every matching log record, per console flags), party-line broadcasts, and command replies accumulate in the outbound buffer. DCCManager.broadcast/announce close a session only when writeLine THROWS (lines 1573-1608); a full write buffer does not throw, it just buffers, so that containment never triggers. Bounding factors keep this INFO rather than WARNING: it requires valid credentials plus password auth, max_sessions defaults to 5, and verbose console flags are needed for high volume — but growth is genuinely unreleased for as long as the client maintains the pattern. Contrast with findings in protocol.ts: same root pattern, but the DCC blast radius is authenticated operators only. <br>
**Evidence:**

```ts
private write(data: string): void {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(data);
    }
  }
```

**Impact:** Up to max_sessions (default 5) authenticated clients can each pin an unbounded outbound queue — tens to hundreds of MB over hours with verbose console flags (e.g. debug logging + IRC mirror) — released only when the session actually closes. <br>
**Remediation:** In DCCSession.write(), check this.socket.writableLength against a cap (e.g. 1 MB) and close('write buffer overflow — client not reading') when exceeded, consistent with the manager's existing stale-session close posture; alternatively skip receiveLog delivery while socket.write() has returned false until 'drain'.

### [INFO] M-22 · BotREPL.start() registers process-level listeners that stop() never removes

**File:** `src/repl.ts:135` <br>
**Category:** listener-leak <br>
**Growth rate:** one stdout 'error' + one stdin 'error' + one 'exit' listener per BotREPL.start() call (called once in current wiring; accumulates per cycle if the REPL is ever restarted) <br>
**Found by:** support scanner <br>
**Verification:** 2/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: refuted (high). runtime-tracer refuted on the grounds that BotREPL.start() runs exactly once in current wiring; the two upholding lenses both suggested INFO — downgraded WARNING → INFO. <br>
**Description:** start() attaches three anonymous closures to process-lifetime emitters: process.once('exit', ...) at line 91, process.stdout.on('error', ...) at line 135, and process.stdin.on('error', ...) at line 145. stop() carefully removes the tracked ircListeners from bot.client, clears the Logger output hook, and drops the audit-tail subscription — but these three handlers are not recorded anywhere and are never removed on any teardown path (confirmed: no process.removeListener/removeAllListeners exists in src/). The stdout and stdin 'error' handlers capture `this` (via this.logger, this.rl), so after stop() the torn-down BotREPL instance — and through this.bot a second root to the whole Bot graph — remains permanently reachable from the stdout/stdin listener lists. In today's wiring index.ts:293 starts the REPL exactly once and the only stop() path leads to process.exit(0), so growth is bounded at one cycle; but stop() is a public, documented-idempotent teardown whose contract is broken, and any future REPL cycling (restart-on-detach, DCC console takeover, tests that call start/stop) accumulates one set of listeners per cycle, with the stale stdin 'error' handler still able to fire this.rl?.close() against a defunct instance. <br>
**Evidence:**

```ts
process.once('exit', () => Logger.setOutputHook(null));  // line 91
...
process.stdout.on('error', (err) => {                    // line 135
  const code = (err as NodeJS.ErrnoException).code;
  ...
  this.logger?.error('stdout error:', err);
});
process.stdin.on('error', (err) => {                     // line 145
  this.logger?.warn('stdin error:', err);
  ...
  this.rl?.close();
```

**Impact:** A stopped BotREPL (plus its child loggers and captured closures) can never be garbage-collected; each hypothetical start/stop cycle leaks another listener set on process.stdout/process.stdin, tripping Node's MaxListenersExceededWarning at 11 and leaving stale handlers that act on defunct REPL instances. Also obscures leak analysis of the process-level emitters. <br>
**Remediation:** Track the process-level handlers exactly like ircListeners: store {emitter, event, fn} tuples at registration in start(), and in stop() call process.stdout.removeListener('error', fn), process.stdin.removeListener('error', fn), and process.removeListener('exit', exitFn). Keep the exit hook's behavior by also clearing the output hook directly in stop() (already done at line 179).

### [INFO] M-23 · deliveryCooldown prune uses a different key folding than insert — orphaned entries survive user removal

**File:** `src/core/memo.ts:435` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one orphaned Map entry per removed admin whose handle contains rfc1459-special characters ([ ] \ ~~) <br>
**Found by:** core-misc scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** Entries are inserted into the per-handle cooldown map with a plain JS case fold: line 430 computes `const handleKey = record.handle.toLowerCase();` and line 435 stores it. The pruning path installed in attach() deletes with an IRC-aware fold instead: line 196 runs `this.deliveryCooldown.delete(this.lowerNick(handle));` where lowerNick() is ircLower(handle, casemapping). Under the default 'rfc1459' casemapping (src/utils/wildcard.ts:12-32), ircLower additionally folds '['→'{', ']'→'}', '\\'→'|', '~~'→'^' — String.prototype.toLowerCase() does not. For any admin handle containing those characters (e.g. `Op[1]`: insert key `op[1]`, delete key `op{1}`), the user:removed prune targets a key that was never inserted, so the entry persists until process shutdown (detach() is the only other clear, at bot.ts:1104). For plain alphanumeric handles the two foldings agree and pruning works as documented. The eventBus wiring itself is confirmed live: permissions.ts:312 emits 'user:removed' and bot.ts:494-503 passes eventBus into MemoManager. <br>
**Evidence:**

```ts
src/core/memo.ts:195-198 — `this.onUserRemoved = (handle: string): void => {\n  this.deliveryCooldown.delete(this.lowerNick(handle));\n};\nthis.eventBus.on('user:removed', this.onUserRemoved);`
vs src/core/memo.ts:430 + 435 — `const handleKey = record.handle.toLowerCase();` ... `this.deliveryCooldown.set(handleKey, now);`
```

**Impact:** Tiny in absolute terms (a string key plus a number per affected removed admin), but the prune path silently fails for a subset of handles, so the map is no longer strictly bounded by currently-existing admin handles as the MemoDeps.eventBus doc comment (memo.ts:73-78) promises. Over months of uptime with admin churn this is retained-forever state, and the inconsistent folding obscures leak analysis of the map. <br>
**Remediation:** Use one canonical fold at both sites. Handles are bot-local identities (not IRC nicks), so plain `handle.toLowerCase()` is the right fold: change line 196 to `this.deliveryCooldown.delete(handle.toLowerCase())`. Alternatively fold with `this.lowerNick()` at the insert site (lines 430/435) — either way insert and delete must agree.

### [INFO] M-24 · abort() mid-backoff resumes the retry loop, launching an unabortable post-teardown provider request

**File:** `plugins/ai-chat/providers/resilient.ts:146` <br>
**Category:** reload-residue <br>
**Growth rate:** one full provider round-trip (with retained prompt/message closures) per request sitting in retry-backoff at teardown; self-releases within requestTimeoutMs plus remaining backoffs (~60-130s at Ollama defaults) <br>
**Found by:** ai-chat-providers scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** abort() clears and resolves every pendingSleeps entry, then calls this.inner.abort() (which bumps the inner provider's epoch and aborts its current controllers). But `entry.resolve()` resumes the awaiting complete() loop on a microtask that runs AFTER abort() returns — the loop's next attempt then calls this.inner.complete(), which registers a fresh AbortController under the already-bumped epoch. Nothing ever aborts that fresh request: teardown's single provider?.abort?.() has already run. The in-code comment's claim that "the next iteration either succeeds or throws via the inner provider's own abort path" is incorrect — the inner abort path fired before the retry started. The post-teardown request runs to completion or timeout, keeping the old module graph (system prompt, message history, provider, and the awaiting pipeline closure over tokenTracker/semaphore/rateLimiter) reachable past index.ts teardown(), and it burns provider compute/RPM after the plugin is nominally gone. Retention is transient and bounded (default maxRetries=2 caps it at ~2 extra attempts), so this is residue that delays reclamation across reloads rather than permanent growth. <br>
**Evidence:**

```ts
for (const entry of this.pendingSleeps) {
  clearTimeout(entry.timer);
  entry.resolve();
}
this.pendingSleeps.clear();
this.inner.abort?.();

// complete() retry loop, line 114 — resumes here and re-enters inner.complete():
await this.sleep(Math.floor(backoff * (0.5 + Math.random())));
```

**Impact:** After `.reload ai-chat` with a call mid-backoff, the torn-down module instance stays reachable for up to ~2 further attempts x requestTimeoutMs (60s Ollama default); rapid repeated reloads can stack several such zombies transiently. Also dispatches real LLM work (Ollama generation / Gemini quota) on behalf of a dead plugin instance. <br>
**Remediation:** Have abort() latch an aborted flag (or make sleep() resolve with 'aborted' | 'slept'); in complete(), after the backoff await, throw AIProviderError('aborted', 'network') instead of retrying when the abort fired. Clear the latch per call (capture it before the loop) so post-reload instances are unaffected.

### [INFO] M-25 · CycleState.track() never removes fired/cleared timer handles from its tracking Set

**File:** `plugins/chanmod/state.ts:148` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one dead Timeout handle per bot rejoin during an active join-recovery backoff cycle (join-recovery.ts:151 is the sole caller); entries persist until plugin unload <br>
**Found by:** chanmod-core scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** schedule() wraps its callback so the timer deletes itself from the backing `timers` Set when it fires, but track() adds an externally created timer with no removal path other than clearAll() at teardown. pruneExpired() sweeps only the `locks` Map, never the `timers` Set. The one caller (join-recovery's sustained-presence reset) clearTimeout()s the previous timer on every bot re-join and tracks a fresh replacement — but neither fired nor cleared handles are ever deleted from the Set, so it grows monotonically for the life of a plugin load cycle. Not reachable from normal message traffic; growth requires kick/ban recovery churn. <br>
**Evidence:**

```ts
track(timer: ReturnType<typeof setTimeout>): void {
      timers.add(timer);
    },
```

**Impact:** Slow, unbounded accumulation of dead Timeout objects within one load cycle. clearTimeout() nulls the callback so cleared handles retain only the ~150 B shell; naturally-fired handles may additionally retain their callback closure (api, recovery record, channel string) depending on Node timer internals. A channel under sustained ban->rejoin attack for weeks accumulates thousands of entries. It also inflates the `size` diagnostic ('for tests and diagnostics'), making real timer-leak analysis harder. <br>
**Remediation:** Give tracked timers the same lifecycle as schedule(): expose an untrack(timer) (or have track() return a disposer) and call it from join-recovery's fire path, its clearTimeout replacement path, and dropRecovery; alternatively refactor the sustained-presence timer onto scheduleWithLock so every timer goes through the self-removing wrapper.

### [INFO] M-26 · teardown() runs teardown callbacks without per-entry try/catch — one throw strands the rest and pins the old plugin graph

**File:** `plugins/chanmod/index.ts:349` <br>
**Category:** reload-residue <br>
**Growth rate:** at most one orphaned plugin-instance graph, only when a teardown callback throws; released again at the next init() (does not compound across reloads) <br>
**Found by:** chanmod-core scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** If any registered teardown throws (nine of them come from out-of-module setup* helpers), the `for` loop aborts: later-registered teardowns — potentially the setup* helpers' timer clears and always clearSharedState(), which is registered last — never run, and the `teardowns = []` reset is skipped. Because the loader deliberately reuses the cached ESM module on reload (plain import, no cache-bust — src/plugin-loader.ts:408-415), the module-level `teardowns` array then keeps closures over the disposed api, SharedState (all its Maps/Sets), ProtectionChain, and backends. init()'s own comment ('Reset in case a previous teardown threw') anticipates the throw path but only half-mitigates it: the reset happens on the NEXT load, so after a `.unload chanmod` with a throwing teardown the old graph is pinned indefinitely. <br>
**Evidence:**

```ts
export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
```

**Impact:** Bounded to a single stale generation: the loader still reaps dispatcher binds, event-bus listeners, and settings registries even when teardown() throws (src/plugin-loader.ts cleanupPluginResources runs regardless), and all chanmod timers are one-shot. But skipped timer clears mean pending setTimeout callbacks fire against disposed state after unload, and the retained SharedState/backends survive an unload-without-reload until process restart. <br>
**Remediation:** Wrap each `td()` in try/catch (log and continue) and move `teardowns = []` into a finally — mirroring the per-entry try/catch pattern the loader itself uses in cleanupPluginResources, so one failing cleanup cannot strand the timer clears and clearSharedState() behind it.

### [INFO] M-27 · knownGoodTopics entries survive PART/KICK and are excluded from the prune sweep

**File:** `plugins/chanmod/topic-recovery.ts:31` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one entry (topic string + timestamp) per distinct channel ever joined during the plugin instance's lifetime; entries persist after the bot leaves the channel <br>
**Found by:** chanmod-enforce scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** Every topic change at threat level 0 writes a snapshot into state.knownGoodTopics keyed by ircLower(channel). Entries for the same channel overwrite in place, but nothing ever deletes an entry while the plugin is loaded: pruneExpiredState (plugins/chanmod/state.ts:270-314) TTL-prunes every other SharedState map (intentionalModeChanges, enforcementCooldown, pendingRecoverCleanup, unbanRequested, threatScores, lastKnownModes, splitOpsSnapshot) but omits knownGoodTopics, and index.ts's part/kick dropChannelState handler removes only takeoverWarnedChannels. The sole cleanup is teardown (topic-recovery.ts:40 / clearSharedState). Growth is operator/invite-driven (channels joined) rather than traffic-driven, so this is bounded in a fixed-channel deployment — but with the invite feature enabled, a bot that visits many channels over months retains a stale topic snapshot for every channel it ever passed through. <br>
**Evidence:**

```ts
state.knownGoodTopics.set(api.ircLower(channel), {
  topic: ctx.text,
  setAt: Date.now(),
});
```

**Impact:** Small (topic strings are <=~390 bytes), but stale snapshots for long-departed channels persist for the plugin lifetime, diverging from the prune-everything convention of SharedState; a much-later rejoin during elevated threat could also restore a months-old topic from the stale snapshot. <br>
**Remediation:** Delete the channel's knownGoodTopics entry in the bot part/kick cleanup path (alongside takeoverWarnedChannels), or add knownGoodTopics to pruneExpiredState with a TTL keyed on setAt.

### [INFO] M-28 · untrustedSourcesWarned set is unbounded over attacker-controlled ident@host keys

**File:** `plugins/chanmod/chanserv-notice.ts:210` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one entry per unique ident@host that sends a notice as the ChanServ nick while untrusted (services outage or misconfigured services_host_pattern); zero growth in normal operation <br>
**Found by:** chanmod-services scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** The warn-dedup set `probeState.untrustedSourcesWarned` adds one entry per unique untrusted source (add sites at lines 210 and 225) and is only cleared by plugin teardown (line 252) — no size cap, no TTL, and no pruning by the 60s pruneExpiredState sweep (it lives on ProbeState, not SharedState). The key is `ident@host`, and ident is client-supplied on most IRCds: an attacker who holds the ChanServ nick during an extended services outage can cycle idents across reconnects, adding one ~40-60 byte string per reconnect for the lifetime of the plugin load. Reaching this code requires the sender to match the configured chanserv_nick, so growth is impossible while services are up; this is a usage-dependent hardening gap, not a normal-traffic leak. <br>
**Evidence:**

```ts
if (!probeState.untrustedSourcesWarned.has(sourceKey)) {
            probeState.untrustedSourcesWarned.add(sourceKey);
```

**Impact:** Negligible under normal operation. Under deliberate abuse (impostor holding the ChanServ nick through a long services outage, cycling ident per reconnect) the set grows slowly and is only reclaimed on .reload chanmod or restart; each add also emits one WRN log line, so sustained growth is at least visible to operators. <br>
**Remediation:** Cap the set (e.g. stop adding past 256 entries and fall back to a time-based warn throttle), or key the dedup on a single boolean + timestamp (warn at most once per N minutes regardless of source) instead of tracking every unique source string.

### [INFO] M-29 · setupChanServNotice teardown docstring claims to drop the notice bind but the returned closure does not unbind it

**File:** `plugins/chanmod/chanserv-notice.ts:173` <br>
**Category:** listener-leak <br>
**Growth rate:** none as currently wired (loader auto-reaps binds on unload); one orphaned 'notice' bind capturing backend+probeState+config per call if setupChanServNotice is ever re-run outside the plugin unload path <br>
**Found by:** chanmod-services scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** The JSDoc (line 151) says '@returns teardown that drops the bind, clears every pending probe map...', but the returned closure (lines 243-255) only clears probe state — it never calls api.unbind for the anonymous handler registered at line 173. Today this is safe: init() calls it exactly once per load and plugin-loader's cleanupPluginResources runs dispatcher.unbindAll(pluginName) on every unload, which removes the bind and frees the closure over backend/probeState. But the contract is misleading and obscures leak analysis: a future caller that re-runs setup mid-lifecycle (e.g. reacting to a chanserv_nick or services-type setting change without a full plugin reload) would stack 'notice' handlers, each pinning the previous backend instance, its accessLevels map, and the old ProbeState. The anonymous arrow function also cannot be removed by the caller because no reference to it escapes. <br>
**Evidence:**

```ts
 * @returns teardown that drops the bind, clears every pending probe map,
...
  api.bind('notice', '-', '*', (ctx) => {
...
  return () => {
    probeState.pendingAthemeProbes.clear();
```

**Impact:** No leak in the current wiring. If the setup/teardown pair is ever reused without an intervening plugin unload, each cycle leaks one dispatcher bind entry plus the full captured scope (backend, probe maps, config), and stale handlers would keep processing ChanServ notices against disposed state. <br>
**Remediation:** Name the handler, and have the returned teardown call api.unbind('notice', '*', handler) before clearing probe state — or correct the docstring to state that bind removal is delegated to the loader's unbindAll, matching the accurate comments in commands.ts and sticky.ts.

### [INFO] M-30 · Permanent flood-ban KV rows are never reclaimed and are re-parsed in full every 60s

**File:** `plugins/flood/enforcement-executor.ts:446` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one ban: KV row per tempban enforcement when ban_duration_minutes=0, never deleted; entire namespace materialized and JSON.parsed every 60s sweep <br>
**Found by:** flood scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** storeBan() writes `expires: 0` when the operator sets ban_duration_minutes=0 ('permanent until operator lifts'). liftExpiredBans() gates deletion on `record.expires > 0 && record.expires <= now`, so expires=0 rows are unreachable by every reclamation path, including the 24h no-ops grace branch that exists specifically to stop unbounded ban: growth. Nothing reconciles a manual operator `-b` with the KV row either, so rows for long-lifted bans persist forever. Each 60s sweep calls `this.api.db.list('ban:')`, which materializes the whole namespace into an array and JSON.parses every row — transient allocation and CPU per tick grow monotonically with historical tempban count. Config-dependent (default is 10 minutes, which is fully reclaimed), hence INFO. <br>
**Evidence:**

```ts
const expires = minutes === 0 ? 0 : now + minutes * 60_000;
    const record: BanRecord = { mask, channel: this.api.ircLower(channel), ts: now, expires };
    this.api.db.set(`ban:${this.api.ircLower(channel)}:${mask}`, JSON.stringify(record));
...
      if (record.expires > 0 && record.expires <= now) {
```

**Impact:** Under ban_duration_minutes=0, a flood wave that tempbans hundreds of rotating hostmasks leaves that many rows in SQLite forever; every 60s tick allocates and parses all of them, so sweep cost and per-tick garbage grow without bound over months of uptime. This is the exact hazard the file's own liftExpiredBans doc-comment warns about ('grow the ban: KV space unboundedly and slow every db.list scan'), but the permanent-ban path escapes the defense. <br>
**Remediation:** Give expires=0 rows a reclamation path: on the 60s sweep, delete rows whose mask no longer appears in the channel banlist (or drop rows older than a configurable max age), and/or hook the mode/-b observation to delete the matching `ban:<chan>:<mask>` key when an operator lifts the ban.

### [INFO] M-31 · recentTerminal map has no size cap and its pruning depends entirely on the auto-disableable 60s time bind

**File:** `plugins/flood/enforcement-executor.ts:272` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one entry per distinct (channel, nick) kick/tempban while the sweep bind is tripped (rate-capped at ~10 terminal actions per 5s per channel); zero net growth while the sweep runs <br>
**Found by:** flood scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** apply() inserts into `recentTerminal` on every kick/tempban (`this.recentTerminal.set(targetKey, now)`), and stale entries (2s TTL) are removed only by sweep() on the `api.bind('time','-','60',...)` tick, dropChannel(), or teardown. Unlike its two sibling maps in the same file — offenceTracker (MAX_OFFENCE_ENTRIES=2000, evicts on insert) and channelActionRate (MAX_CHANNEL_RATE_KEYS=1024, evicts on insert) — recentTerminal has no hard cap and no inline pruning, so its boundedness rests solely on the timer bind staying alive. The dispatcher permanently auto-disables a plugin's timer bind after TIMER_FAILURE_THRESHOLD consecutive handler failures (src/dispatcher.ts:270, 'Reload the plugin to reset'), and the shared sweep handler also runs liftExpiredBans() with live db calls that can throw repeatedly if the DB degrades — tripping the bind kills pruning while enforcement (and insertion) continues. LockdownController.flooders shares the same dead-sweep dependency but has inline pruning and ops/active-lock gates mitigating it; recentTerminal is the one collection with no second line of defense. <br>
**Evidence:**

```ts
      this.recentTerminal.set(targetKey, now);
...
  sweep(): void {
    ...
    for (const [key, ts] of this.recentTerminal) {
      if (now - ts > TERMINAL_SUPPRESSION_MS) {
        this.recentTerminal.delete(key);
      }
    }
```

**Impact:** In the failure mode where the 60s sweep bind is auto-tripped during a sustained flood (nick-rotating botnet minting distinct nicks), recentTerminal accumulates up to ~120 small entries per minute per channel indefinitely until plugin reload — the offence and channel-rate maps stay capped in the same scenario, so this map is the only one that can grow without bound. Degradation is slow (string+number entries), but it silently undermines the file's otherwise consistent belt-and-braces posture. <br>
**Remediation:** Mirror the sibling maps' defense: add a MAX_RECENT_TERMINAL cap with oldest-insertion eviction on insert, or prune expired entries inline in apply() (entries have a 2s TTL, so an opportunistic prune when size exceeds a small threshold is cheap).

### [INFO] M-32 · firstPollDone set retains removed-feed ids for the life of the plugin instance

**File:** `plugins/rss/index.ts:208` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one retained feed-id string per removed feed that completed at least one announce poll; never pruned until plugin unload/reload <br>
**Found by:** rss scanner <br>
**Verification:** 3/3 verifier lenses upheld — cleanup-hunter: upheld (high) · lifecycle-analyst: upheld (high) · runtime-tracer: upheld (high). Downgraded WARNING → INFO on 2/3 verifier consensus (bounded by the count of distinct removed feed ids). <br>
**Description:** init() creates `const firstPollDone = new Set<string>()` (line 162), captured by the 60s time-bind closure, and every feed that completes an announce poll is added at line 208. Nothing ever deletes entries: `handleRemove` in plugins/rss/commands.ts (lines 387-389) removes the feed from `activeFeeds`, deletes the KV row, and calls `deps.circuitBreaker.forget(id)` — but `firstPollDone` is not part of `RssCommandsDeps`, so the remove path cannot reach it. The codebase explicitly fixed this exact pattern for the circuit breaker (the `forget()` docstring: "an add/remove churn of unique ids can't leave stale ... entries that accumulate forever"); firstPollDone is the sibling collection that was missed. Over a weeks/months-uptime bot, `!rss add X ... !rss remove X` cycles with unique ids accumulate stale strings until the plugin is reloaded (dispatcher.unbindAll releases the closure then). Bounded concurrently by max_feeds=100, but unbounded across churn of unique ids. <br>
**Evidence:**

```ts
const firstPollDone = new Set<string>();  // line 162
...
firstPollDone.add(feed.id);  // line 208 — no matching .delete() anywhere

// commands.ts handleRemove (387-389) — prunes everything except firstPollDone:
deleteRuntimeFeed(api, id);
activeFeeds.delete(id);
deps.circuitBreaker.forget(id);
```

**Impact:** Slow in-memory growth (short strings, <=32 chars each) proportional to operator add/remove churn; also a correctness wart — a feed removed and re-added under the same id skips its first-poll stagger. Magnitude is small, but it is a definite never-released reference during normal long-uptime operation. <br>
**Remediation:** Expose the set to the command layer the same way the breaker is exposed: add `firstPollDone` (or a `forgetFeed(id)` callback) to `RssCommandsDeps` and call `firstPollDone.delete(id)` in handleRemove next to `deps.circuitBreaker.forget(id)`. Alternatively fold first-poll tracking into the CircuitBreaker-style lifecycle class so `forget()`/`reset()` cover it.

### [INFO] M-33 · rss:last_poll KV rows are orphaned forever when a feed is removed

**File:** `plugins/rss/feed-store.ts:108` <br>
**Category:** unbounded-collection <br>
**Growth rate:** one orphaned KV row (~60 bytes) per unique removed feed id, retained forever <br>
**Found by:** rss scanner <br>
**Verification:** 1/1 skeptic upheld (single-lens fast path for scanner-rated INFO) — cleanup-hunter: upheld (high). <br>
**Description:** setLastPoll writes `rss:last_poll:<feedId>` on every poll (line 108), but no code path ever deletes these rows for a removed feed: `deleteRuntimeFeed` (line 161) deletes only `rss:feed:<id>`, and the daily `cleanupSeen` sweep scans only the `rss:seen:` prefix. By contrast, a removed feed's `rss:seen:<id>:*` dedup entries DO age out via cleanupSeen after dedup_window_days, so last_poll is the only permanently orphaned namespace. This is SQLite/disk residue rather than process-memory growth — nothing loads the last_poll namespace wholesale into memory (getLastPoll reads per-key) — so it is reported at INFO for a memory audit. <br>
**Evidence:**

```ts
export function setLastPoll(api: PluginAPI, feedId: string): void {
  api.db.set(`rss:last_poll:${feedId}`, new Date().toISOString());
}
...
export function deleteRuntimeFeed(api: PluginAPI, id: string): void {
  api.db.del(`rss:feed:${id}`);  // last_poll row for `id` is never deleted
}
```

**Impact:** Unbounded but tiny KV/disk growth across add/remove churn of unique feed ids; no RAM impact. Also leaves stale state: re-adding a feed id later inherits the old lastPoll timestamp, skipping the silent first-run seeding gate in init(). <br>
**Remediation:** Delete the row alongside the feed record: add `api.db.del(`rss:last_poll:${id}`)` to deleteRuntimeFeed (or call it from handleRemove), mirroring how circuitBreaker.forget() drops per-feed state.

## Leak-free patterns found

The scan catalogued 78 correct-cleanup patterns (full list in the workflow transcript). The most instructive — use these as templates when fixing the findings above:

- **`src/core/dcc/index.ts:541-560` — `dataGuard`**: byte-counting `data` listener that destroys the socket when bytes-since-last-LF exceed the cap. _This is the exact template for fixing M-01._
- **`plugins/flood/enforcement-executor.ts` — `offenceTracker`**: rolling-window TTL prune plus hard size cap. _Named by the scanner as the template for M-31._
- **`src/bot.ts` — owner-tagged listener lifecycle**: every long-lived subscription goes through `trackListener('bot', ...)`; `shutdown()` drains them in one `eventBus.removeByOwner('bot')`; `teardownPriorConnection()` cancels prior driver/timers before `connect()` creates new ones.
- **`src/dispatcher.ts` — `unbindAll(pluginId)`**: single teardown sweep clearing timers and per-plugin bookkeeping, invoked automatically by the plugin loader on every unload — `api.bind()` without `api.unbind()` does _not_ leak across reloads.
- **`src/plugin-loader.ts:670-791` — `cleanupPluginResources()`**: one shared teardown recipe for both the init-failure path and `unload()`.
- **`src/irc-bridge.ts` — symmetric `attach()`/`detach()`**: every `client.on()` recorded for removal; idempotency guard prevents doubled listeners; both timers cleared and nulled; sweep interval `unref()`d.
- **`src/core/services.ts` — pending NickServ verifies**: dedupe by shared in-flight promise + hard cap (`MAX_PENDING_VERIFIES = 128`).
- **`src/core/message-queue.ts`**: `start()` calls `stop()` first; queues capped globally (500) and per-target (50) with a disconnect drain.
- **`src/core/botlink/pending.ts` — `PendingRequestMap`**: timeout timers self-delete their entry; `resolve()` clears the timer; capped and drained on close.
- **`src/core/botlink/relay-router.ts`**: every routing map has all three release mechanisms — hard size caps, TTL sweep, and event-driven delete.
- **`plugins/ai-chat/rate-limiter.ts` — `ambientChannelWindows`**: triple-bounded (LRU cap 256, delete+set promotion, coldest-key ejection). _The sibling `userBuckets` (M-08) and `trackedChannels` (M-09) lack exactly this._
- **`plugins/rss/feed-fetcher.ts` — `doRequest()`**: per-request `AbortController` composed with the plugin-lifecycle signal; released on every settle path.
- **`src/index.ts` — `recoverableTimestamps`**: sliding window pruned on every insert _and_ hard-capped, so a burst followed by quiet cannot pin memory.
- **`plugins/chanmod/state.ts:128-140` — `CycleState.schedule()`**: scheduled timers self-delete from the tracking Set on fire. _`track()` (M-25) is the one entry point that skips this._

## Recommendations

Every finding appears exactly once below. Checkboxes are for downstream skills (`/build`, `/refactor`) to tick as fixes land.

### Quick wins (< 5 min each)

- [x] **M-06** `src/core/channel-state.ts:398` — prune `networkAccounts` in `onKick` and bot self-departure, mirroring the existing `onPart` logic
- [x] **M-09** `plugins/ai-chat/ambient.ts:87` — add `AmbientEngine.dropChannel()`, call it from the part/kick eviction branch (`index.ts:575-598`), and add the `MAX_CHANNELS = 256` cap the sibling trackers use
- [x] **M-10** `plugins/chanmod/join-recovery.ts:151` — route sustained-presence timers through the self-deleting `CycleState.schedule()` instead of `track()`
- [x] **M-25** `plugins/chanmod/state.ts:148` — make `track()` wrap callbacks to self-delete from the Set on fire (same fix as M-10, root-cause side)
- [x] **M-14** `src/command-handler.ts:166` — `unregisterCommand`: delete by `name.toLowerCase()` and remove the mirrored help entry (add `HelpRegistry.remove(pluginId, command)`)
- [x] **M-22** `src/repl.ts:135` — store the stdout/stdin/exit listener refs and remove them in `stop()`
- [x] **M-23** `src/core/memo.ts:435` — fold the `deliveryCooldown` prune key the same way as the insert key
- [x] **M-24** `plugins/ai-chat/providers/resilient.ts:146` — re-check the abort flag after each backoff sleep before relaunching the provider request
- [x] **M-12** `src/plugin-api-factory.ts:150` — fix the stale hot-reload JSDoc (module is no longer cache-busted; module-level plugin state persists across enable/disable)
- [x] **M-15** `src/core/connection-lifecycle.ts:351` — re-check the disposed flag after the `identify_before_join` await before re-arming the presence interval
- [x] **M-16** `src/core/connection-lifecycle.ts:810` — track the core `invite` bind on the handle so teardown releases it (latent repeat-connect path)
- [x] **M-17** `src/core/channel-state.ts:334` — guard `ensureChannel` against stray non-self JOIN/353 like the TOPIC/324 paths
- [x] **M-26** `plugins/chanmod/index.ts:349` — wrap each teardown callback in try/catch so one throw cannot strand the rest
- [x] **M-27** `plugins/chanmod/topic-recovery.ts:31` — include `knownGoodTopics` in the prune sweep / part-kick cleanup
- [x] **M-28** `plugins/chanmod/chanserv-notice.ts:210` — cap `untrustedSourcesWarned` (attacker-controlled ident@host keys)
- [x] **M-29** `plugins/chanmod/chanserv-notice.ts:173` — make the returned teardown closure actually drop the notice bind, or fix the docstring
- [x] **M-31** `plugins/flood/enforcement-executor.ts:272` — add a size cap to `recentTerminal` (use the `offenceTracker` pattern in the same file)
- [x] **M-32** `plugins/rss/index.ts:208` — delete from `firstPollDone` when a feed is removed
- [x] **M-33** `plugins/rss/feed-store.ts:108` — delete the `rss:last_poll` KV row when a feed is removed
- [x] **M-20** `src/core/botlink/hub.ts:207` — update `broadcast()`'s docstring when M-02 makes the write-buffer-full return reachable _(M-02 not yet done — docstring/warn text corrected to describe the real send() failure conditions; reword again when M-02 lands)_

### Medium effort (refactoring needed)

- [ ] **M-01** `src/core/botlink/protocol.ts:264` — **CRITICAL**: add a byte-counting `data` guard mirroring DCC `dataGuard` (`dcc/index.ts:541-560`) in the `BotLinkProtocol` constructor so hub and leaf both inherit it; enforce `MAX_PRE_HANDSHAKE_FRAME_SIZE`/`MAX_FRAME_SIZE` on raw bytes, not completed lines
- [ ] **M-02** `src/core/botlink/protocol.ts:400` — return the real `socket.write()` boolean from `send()` and enforce a `writableLength` ceiling (1–4 MB) that closes stuck peers
- [ ] **M-03** `src/core/botlink/heartbeat.ts:73` — have the heartbeat tick also inspect outbound `writableLength` so stuck-writer peers are disconnected on the same cadence as inbound silence (pairs with M-02)
- [ ] **M-04** `src/core/botlink/relay-handler.ts:130` — purge virtual relay sessions when a leaf's hub link drops (the designed orphan-cleanup key never matches)
- [ ] **M-05** `src/core/channel-state.ts:288` — add TTL or cap for `networkAccounts` entries whose departure the bot can never observe (PM/NOTICE-only identified nicks)
- [ ] **M-07** `src/core/dcc/session-store.ts:54` — use casemapping-stable keys (or fold with the insert-time mapping at delete) so sessions survive a CASEMAPPING change across reconnect
- [ ] **M-08** `plugins/ai-chat/rate-limiter.ts:287` — make the existing stale-user-bucket eviction reachable so `userBuckets` stops growing with nick churn
- [ ] **M-11** `src/plugin-api-factory.ts:310` — reconcile `wrappedHandlers` when `bind()` is refused or overwrites a non-stackable mask
- [ ] **M-13** `src/plugin-api-factory.ts:825` — add a cap (or explicit accounting) for the plugin `on*`/`onChange` subscription surfaces, analogous to the bind hardcap
- [ ] **M-18** `src/core/botlink/auth-store.ts:93` — enforce `MAX_CIDR_BANS` before persistence and sweep permanent rows on load
- [ ] **M-19** `src/core/botlink/cmd-exec.ts:56` — add an executor-side timeout / outstanding-count cap for relayed CMD closures
- [ ] **M-21** `src/core/dcc/index.ts:699` — cap per-session outbound `writableLength` for DCC clients that type but never read
- [ ] **M-30** `plugins/flood/enforcement-executor.ts:446` — stop persisting (or periodically sweep) permanent flood-ban KV rows; avoid re-parsing the whole namespace every 60s

### Architectural (design changes needed)

- [ ] **Botlink outbound flow-control policy** (umbrella for M-02/M-03/M-20): decide disconnect-vs-shed semantics for slow peers — disconnect is simpler and safe since peers resync on reconnect; frame-class shedding (RELAY_OUTPUT, PARTY_CHAT, BSAY) preserves the link at the cost of divergence bookkeeping
- [ ] **Seam-focused audit pass** (critic-identified structural gap): per-file scans cannot see Node-internal buffer growth or cross-module closure retention; add a periodic audit that traces retained references across module seams (socket owner ↔ protocol wrapper, loader ↔ api factory ↔ registries)
