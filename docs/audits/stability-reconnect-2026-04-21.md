# Stability Audit: Reconnect / Identify / ChanServ Race

**Date:** 2026-04-21
**Scope:** `src/core/services.ts`, `src/core/connection-lifecycle.ts`, `src/bot.ts`,
`plugins/chanmod/index.ts`, `plugins/chanmod/auto-op.ts`, `plugins/chanmod/anope-backend.ts`,
`plugins/chanmod/chanserv-notice.ts` — analysed against `tmp/connect-log-bug.txt` (real incident)
**Estimated resilience:** Low for channel-protection continuity after a dirty reconnect

---

## Summary

On 2026-04-20 23:43–23:51 UTC, an IRC network outage caused all three bots (HEX, BlueAngel,
neo) to disconnect simultaneously. Both HEX and BlueAngel went through 9–10 failed reconnect
cycles before the server stabilised. When they finally reconnected, **SASL authentication
silently failed on the successful connection** — proven by NickServ sending "This nickname is
registered and protected" to HEX at 23:53:05, a message the server sends only to unidentified
clients. Because `services.identify()` is a no-op when `sasl: true`, there is no fallback
IDENTIFY path. With HEX unidentified, the chanmod Anope probe that fires immediately on
channel join couldn't get a ChanServ response (ChanServ ignores queries from unidentified
accounts on Rizon). Both probes timed out in 8 s, leaving `chanserv_access = 'none'` for
the entire session. HEX had no ops and could not auto-voice or auto-op any users. This state
persisted undetected until the next manual restart — **over 12 hours later**.

The bot would survive a clean reconnect (SASL intact) indefinitely, but a dirty reconnect
after a prolonged network outage exposes a chain of fragilities that together produce a
**total loss of channel protection** with no automatic recovery and no operator-visible alert.

**Findings:** 4 critical, 4 warning, 2 info

---

## Incident Timeline (from `connect-log-bug.txt`)

| Time (UTC)        | Event                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 23:43:47          | BlueAngel disconnected ("connection closed")                                                                                  |
| 23:44:25          | HEX disconnected ("connection closed")                                                                                        |
| 23:44:25–23:51:14 | HEX: 9 failed reconnect attempts; SASL authenticates (`account-notify: * identified as HEX`) but server closes link each time |
| 23:51:25          | **HEX reconnects successfully** — no `account-notify` logged, HEX is NOT identified                                           |
| 23:51:27          | chanmod starts Anope ACCESS LIST + INFO probe for #hexbot                                                                     |
| 23:51:35          | **Both probes time out** — `access remains 'none'`                                                                            |
| 23:53:03          | neo, dark, d3m0n join #hexbot — HEX cannot voice or op anyone                                                                 |
| 23:53:05–06       | NickServ sends "This nickname is registered and protected" to HEX (confirms HEX unidentified)                                 |
| 23:53:08          | NickServ STATUS verification for dark times out — +o not applied                                                              |
| 00:49:05          | Same failure repeats — HEX still unidentified, still can't mode anyone                                                        |
| ~11:00+           | Session ends (restart or manual intervention)                                                                                 |

---

## Findings

### [CRITICAL] C-1: SASL failure on reconnect has no recovery path

**File:** `src/core/services.ts:148-156`
**Pattern:** self-healing (missing), graceful degradation (missing)
**Anti-pattern:** Integration point without error detection; cascading failure
**Scenario:** After 9 failed SASL exchanges (TCP connect → SASL auth → server closes link), the
10th successful TCP connection fails SASL silently. The server sends the SASL exchange but the
authentication result is never confirmed before `registered` fires — or the SASL exchange is
skipped entirely on the server side due to rate limiting.

**Description:** When SASL is configured, `services.identify()` returns immediately:

```typescript
// src/core/services.ts:148-156
identify(): void {
  if (this.servicesConfig.sasl) return; // SASL handles auth
  if (this.servicesConfig.type === 'none') return;
  if (!this.servicesConfig.password) return;
  …
}
```

If SASL fails silently (no `account-notify`, no error logged), the bot has no fallback.
`identifyWithServices()` in `connection-lifecycle.ts` calls this function and returns — the
bot proceeds to join channels without any identity. There is no code anywhere that detects
the absence of an `account-notify` event or that listens for the NickServ "please identify"
prompt as a signal to fall back to password IDENTIFY.

**Evidence from log:**

```
23:51:25 INF [connection] Connected to irc.rizon.net:6697 as HEX
# ← no account-notify line follows (compare: 16:49:49 had one immediately)
…
23:53:05 DBG [services] NickServ notice: This nickname is registered and protected. If it is your
23:53:06 DBG [services] NickServ notice did not match ACC or STATUS pattern: …
```

NickServ's "please identify" prompt is received, logged as a parse miss, and **discarded**.

**Impact:** Bot operates without NickServ identity for the entire session. ChanServ ignores
all commands. Channel protection is completely offline.

**Remediation:**

1. In `services.ts`, detect the NickServ "please identify" notice as an actionable event:

```typescript
// In onNotice(), after ACC/STATUS parse attempts:
const pleaseIdentify = /(?:This nickname is registered|nickname.*registered.*protected)/i.test(
  message,
);
if (pleaseIdentify && this.servicesConfig.sasl && this.servicesConfig.password) {
  this.logger?.warn('NickServ prompt received — SASL may have failed; falling back to IDENTIFY');
  const target = this.getNickServTarget();
  this.client.say(target, `IDENTIFY ${this.servicesConfig.password}`);
  this.eventBus.emit('bot:sasl-identify-fallback');
}
```

2. After falling back, emit `bot:sasl-identify-fallback` so chanmod can schedule a
   re-probe (see C-3).

3. As belt-and-braces: in `connection-lifecycle.ts`, set a `accountNotifyReceived` flag
   when the `account-notify` event fires for the bot's own nick, and warn (+ trigger fallback)
   if `registered` fires without that flag being set within 5 s.

---

### [CRITICAL] C-2: ChanServ probe fires before identity is confirmed; no retry on identify

**File:** `plugins/chanmod/auto-op.ts:178-198`, `plugins/chanmod/anope-backend.ts:179-183`
**Pattern:** connection resilience (missing re-auth sync), self-healing (missing re-probe)
**Anti-pattern:** Cascading failure — SASL miss → probe miss → permanent no-access
**Scenario:** Bot reconnects, joins channel immediately, chanmod fires ACCESS LIST + INFO —
but if SASL has not yet confirmed identity (or has failed), ChanServ ignores the queries.

**Description:** On bot join, `auto-op.ts` calls `chain.verifyAccess(channel)` which calls
`AnopeBackend.verifyAccess()` → `sendChanServ("ACCESS #hexbot LIST")` +
`sendChanServ("INFO #hexbot")`. There is no gate that checks whether the bot is identified
before probing. On non-SASL networks, `identifyWithServices()` fires immediately before the
JOIN but NickServ may not have confirmed the IDENTIFY yet (IRC commands are in-flight).

Once both probes time out (`PROBE_TIMEOUT_MS = 10_000`, chanserv-notice.ts:43), the backend
is left at `access = 'none'`. **There is no re-probe trigger anywhere in the codebase.** The
only path back to having ChanServ access is a plugin reload or process restart.

**Evidence:**

```
23:51:27 INF [plugin:chanmod] Anope: verifying access for #hexbot via ACCESS LIST + INFO probes
23:51:35 DBG [plugin:chanmod] ChanServ access probe for #hexbot timed out — no services response (access remains 'none')
23:51:35 DBG [plugin:chanmod] ChanServ access probe for #hexbot timed out — no services response (access remains 'none')
# 12+ hours later: access is still 'none', no retry attempted
```

**Impact:** Permanent loss of chanmod ChanServ access for the session. Auto-op, auto-voice,
takeover recovery, and AKICK all degrade silently.

**Remediation:**

1. Emit a `bot:identified` event from the SASL success path (when `account-notify` fires for
   the bot's own nick) and from the `identify()` success path (after IDENTIFY is sent, with a
   delay to allow NickServ to process it). Wire chanmod to re-probe on this event:

```typescript
// in chanmod init or auto-op setup:
api.eventBus.on('bot:identified', () => {
  for (const ch of api.botConfig.irc.channels) {
    if (chain.getAccess(ch) === 'none') {
      api.log(`Re-probing ChanServ for ${ch} after identify`);
      chain.verifyAccess(ch);
    }
  }
});
```

2. Alternatively, add a periodic re-probe (every 5 min) that fires only when access is
   `'none'` and the bot is in the channel — this self-heals even without the event.

3. In the probe trigger path (`auto-op.ts`), check whether `api.services.isIdentified()`
   (a new method) before probing, and if not, defer the probe to a `bot:identified` listener.

---

### [CRITICAL] C-3: NickServ STATUS verification fails when bot itself is unidentified — noise poisons the pending verify queue

**File:** `src/core/services.ts:317-388`
**Pattern:** error containment, observability
**Anti-pattern:** Chain reaction — unidentified bot → NickServ "please identify" notice
floods services.ts → STATUS response for dark is drowned out or never sent
**Scenario:** chanmod calls `services.verifyUser('dark')` to gate +o. HEX is unidentified.
NickServ sends "please identify" notices to HEX (not to dark's STATUS query). These notices
arrive on the same `notice` event stream, are parsed as if they might be ACC/STATUS
responses, fail to match, and the pending verify times out.

**Description:** `onNotice()` is called for every NickServ notice. When `pending.size > 0`,
it logs each parse miss:

```typescript
// services.ts:384-388
if (this.pending.size > 0) {
  this.logger?.debug(`NickServ notice did not match ACC or STATUS pattern: ${message}`);
}
```

The "please identify" notices are not in response to a `STATUS dark` query — they are
NickServ prompting HEX to identify. But because the bot sent `STATUS dark` to NickServ and
then NickServ replied with multi-line "please identify" noise (instead of / before the STATUS
response), the 5-second pending timer expires before the real STATUS response (if any) arrives.

In addition, on Rizon/Anope, sending `STATUS dark` while the requester (HEX) is unidentified
may cause NickServ to silently ignore the STATUS query, meaning the response never arrives.

**Evidence:**

```
23:53:03 INF [plugin:chanmod] Verifying dark via NickServ before applying +o in #hexbot
23:53:05 DBG [services] NickServ notice: This nickname is registered and protected. If it is your
23:53:06 DBG [services] NickServ notice did not match ACC or STATUS pattern: …
23:53:08 WRN [services] Verification timeout for dark
23:53:08 INF [plugin:chanmod] Verification failed for dark in #hexbot — not applying +o
```

**Impact:** Any privileged user who joins after a dirty reconnect fails NickServ verification
and receives no auto-op/auto-voice, even if they are genuinely identified. This is fail-closed
(correct from a security POV) but produces false negatives for legitimate users.

**Remediation:**

1. Track whether the bot's own identify has completed in `Services`. When `verifyUser()` is
   called and the bot is known-unidentified, fail fast with a structured reason rather than
   issuing a STATUS query that will silently fail:

```typescript
async verifyUser(nick: string, timeoutMs = 5000): Promise<VerifyResult> {
  if (!this._botIsIdentified) {
    this.logger?.warn(`Skipping NickServ verify for ${nick} — bot is not identified`);
    return { verified: false, account: null };
  }
  …
}
```

2. Expose `getBotIdentifiedState(): 'identified' | 'unidentified' | 'unknown'` so `.status`
   can surface it.

3. Once the SASL fallback (C-1 fix) successfully identifies, call
   `services.markBotIdentified()` so subsequent verify calls are unblocked.

---

### [CRITICAL] C-4: No alt-nick / GHOST sequence — nick squat during outage causes silent failure

**File:** `src/bot.ts:895-910` (`buildClientOptions`)
**Pattern:** connection resilience (missing nick recovery)
**Anti-pattern:** Integration point without error path
**Scenario:** During the 7-minute outage (23:44–23:51), HEX's nick was available on the server
after the ghost timed out. If another IRC client had grabbed it first, HEX would have connected
as `HEX_` or `HEX1` (IRC server nick collision behavior). The bot logs "Connected as HEX" but
is now operating under the wrong nick — every NickServ, ChanServ, and hostmask lookup is broken.

**Description:** `buildClientOptions()` always passes the primary nick with no `alt_nick`:

```typescript
// bot.ts:872-882
const options: Record<string, unknown> = {
  …
  nick: cfg.nick,
  // ← no alt_nick, no GHOST sequence
};
```

irc-framework handles nick collisions by appending `_` — the bot doesn't know this happened.
`channelState.setBotNick(this.config.irc.nick)` is called with the configured nick, not the
actual registered nick, so `isBotNick()` checks are stale. Commands routed to the bot's nick
stop working.

**Impact:** After a nick collision, the bot silently operates under a wrong nick for the entire
session. NickServ cannot identify it (GHOST not sent), ChanServ ignores it, and chanmod has no
ops. Appears identical in logs to the SASL failure scenario (C-1) making root cause diagnosis
harder.

**Remediation:**

1. Add `alt_nick` to `BotConfig.irc` and propagate to `buildClientOptions()`.

2. After `registered`, check if the connected nick matches the configured nick:

```typescript
// in onRegistered (connection-lifecycle.ts):
const connectedNick = String(client.user?.nick ?? cfg.nick);
if (connectedNick.toLowerCase() !== cfg.nick.toLowerCase()) {
  logger.warn(`Registered as ${connectedNick} (expected ${cfg.nick}) — attempting GHOST`);
  eventBus.emit('bot:nick-collision', connectedNick);
  // services.ghostAndReclaim(cfg.nick, cfg.password) — if configured
}
```

3. Implement a `ghostAndReclaim()` in `Services` that sends `GHOST <nick> <password>` then
   `NICK <nick>` after a brief delay (NickServ processes GHOST asynchronously).

4. Update `channelState.setBotNick()` and `bridge.setBotNick()` when the nick changes back
   so `isBotNick()` stays accurate.

---

### [WARNING] W-1: identify/chanmod probe race on non-SASL networks

**File:** `src/core/connection-lifecycle.ts:239-247`
**Pattern:** connection resilience
**Scenario:** On a network using plain NickServ IDENTIFY (not SASL), the bot sends IDENTIFY
then immediately JOINs. chanmod's probe fires on bot join. If NickServ processes IDENTIFY
slowly (services lag, busy network), ChanServ may not yet see the bot as identified when the
probe arrives.

**Description:**

```typescript
// connection-lifecycle.ts:239-247
deps.identifyWithServices?.(); // fire-and-forget: no await, no confirmation
joinConfiguredChannels(deps); // JOIN fires immediately after
```

There is no delay between IDENTIFY and JOIN. The two IRC messages are queued back-to-back with
no synchronization. In practice this works on most networks (NickServ is fast), but under
services load or after a reconnect where NickServ is catching up, the probe races the IDENTIFY.

**Impact:** ChanServ probe may time out despite IDENTIFY eventually succeeding. Identical
outcome to C-1/C-2 but without the SASL failure involved.

**Remediation:** Listen for NickServ's "You are now identified" (or equivalent per-network)
notice and emit `bot:identified`. Only then trigger `verifyAccess()`. As an interim fix,
add a configurable `identify_delay_ms` (default 500ms) before join — crude but effective for
most networks.

---

### [WARNING] W-2: No bot identify-state observability in `.status`

**File:** `src/core/commands/irc-commands-admin.ts` (`.status` command)
**Pattern:** observability
**Scenario:** Operator checks `.status` during a degraded session to understand why chanmod
isn't working. Gets no indication that the bot is not identified.

**Description:** The stability metrics surfaced by `.status` include `servicesTimeoutCount`,
`pendingVerifyCount`, etc. (wired in `bot.ts:450-457`). None of them expose whether the bot
itself is identified with NickServ, what the current chanmod access level is per channel, or
whether the last ChanServ probe succeeded.

**Impact:** Operator flying blind during an incident. The 12-hour undetected degradation in
this incident was partly caused by no alert and no observable signal from `.status`.

**Remediation:**

1. Add `botIdentified: boolean` to `StabilityMetrics` (populated from a flag in `Services`).
2. Add `chanservAccess: Record<string, string>` to chanmod's per-channel state and expose it
   via a `.chanmod status` or `.status` extension.
3. Emit a log-level `ERR` (not `DBG`) when a ChanServ probe times out — currently all probe
   timeouts log at `DBG`, making them invisible in production-level filtering.

---

### [WARNING] W-3: NickServ verify timeout too short for services-degraded reconnect

**File:** `src/core/services.ts:174` (default `timeoutMs = 5000`)
**Pattern:** timeout, graceful degradation
**Scenario:** Immediately after a reconnect where all bots and users flood back simultaneously,
NickServ is under heavy load. `verifyUser('dark')` is called, sends `STATUS dark`, and waits
5 s. NickServ is queueing hundreds of IDENTIFY/STATUS requests from reconnecting clients and
takes >5 s to respond.

**Description:** The 5 s default is appropriate for steady-state operation but too short for
the post-reconnect rush window. The bot should apply a longer timeout during the reconnect
grace period (the first ~30 s after `bot:connected`).

**Impact:** False negative verifications for legitimate users in the reconnect window. Users
who should receive auto-op/voice don't get it and have to rejoin.

**Remediation:** Add a `reconnectGraceTimeoutMs` option (e.g. 15 s) used instead of the
default for the first N seconds after `bot:connected`. `Services` can track a
`reconnectedAt` timestamp and return the longer timeout when within the grace window.

---

### [WARNING] W-4: chanserv probe state not cleared on re-probe; stale deferred no-access may block re-entry

**File:** `plugins/chanmod/chanserv-notice.ts:81-88` (`deferredAnopeNoAccess`)
**Pattern:** self-healing, steady state
**Scenario:** A re-probe (once implemented per C-2 fix) is fired while
`deferredAnopeNoAccess` still has an entry from the timed-out probe. The new ACCESS LIST
response arrives and is processed, but the deferred flush from the old probe may later
overwrite the new result with `access = 'none'`.

**Description:** `deferredAnopeNoAccess` stores a snapshot of the chanset value at defer
time and flushes if the snapshot still matches (guards against operator override). But after
a re-probe, the INFO probe from the _new_ round may fire and write the correct founder result,
only to be clobbered when the _old_ defer flush runs (if `commitDeferredNoAccess` fires late
via the timer).

**Impact:** After a re-probe, channel access may revert to 'none' seconds later via a stale
deferred flush, making the re-probe appear to have succeeded and then immediately failed.

**Remediation:** Clear `deferredAnopeNoAccess` (and cancel relevant `probeTimers`) before
starting a new probe for the same channel. Add a `clearProbeState(channel)` helper to
`chanserv-notice.ts`.

---

### [INFO] I-1: `account-notify: * identified as HEX` during failed reconnects may mask SASL state on successful connect

**File:** `src/core/channel-state.ts` (account-notify handler)
**Pattern:** observability
**Scenario:** During 9 failed connections, each SASL exchange succeeds (proves SASL is
configured and the credential is correct) but the connection drops. On the 10th connection,
SASL may fail silently. The presence of 9 successful SASL logs could mislead an operator
into thinking SASL was working.

**Description:** The `*` nick in `account-notify: * identified as HEX` is the pre-registration
placeholder — this means SASL succeeded at the capability layer but the server then closed
the link before the IRC registration (`001 WELCOME`) was complete. The 10th connection
(successful at TCP level) produced no `account-notify` at all, which is the anomaly.

**Remediation:** Log a `WARN` if `registered` fires without a prior `account-notify` for the
bot's own nick on SASL-configured networks. This gives the first visible signal of a SASL
miss within seconds of reconnect, long before chanmod probe timeouts surface the problem.

---

### [INFO] I-2: No ChanServ access probe on plugin reload

**File:** `plugins/chanmod/index.ts:32-256`
**Pattern:** self-healing
**Scenario:** Operator reloads chanmod (`.reload chanmod`) after a dirty reconnect to
restore protection. `init()` is called fresh, but `chain.verifyAccess(channel)` is only
triggered from the bot-join handler (`auto-op.ts:178-198`) — the bot is already in the
channel, so no join event fires.

**Description:** On reload, chanmod re-seeds backend access from `chanserv_access` channel
settings (lines 207-215 of `index.ts`) but only if `chanserv_access` was explicitly configured.
If access was auto-detected at the previous startup and the setting shows `'none'`
(the default), re-probing never fires.

**Impact:** Operator reload doesn't restore protection unless they also set
`.chanset #hexbot chanserv_access founder` manually.

**Remediation:** On `init()`, after backend access is seeded, always call
`chain.verifyAccess(channel)` for each configured channel where the bot is currently present —
same logic as the bot-join handler, gated on `api.isInChannel(channel)`.

---

## Stable patterns found

- Reconnect backoff and jitter (`src/core/reconnect-driver.ts`) worked correctly: 9 attempts
  over ~7 min with exponential backoff to 31 s cap + jitter. No thundering herd.
- Channel state clear on reconnect (`channelState.clearNetworkAccounts()`,
  `clearAllChannels()`) works correctly — no stale account entries leaked across sessions.
- `services.cancelPendingVerifies('disconnected')` fires correctly on disconnect, preventing
  misleading audit rows.
- `pendingCapRejectionCount` and `servicesTimeoutCount` metrics are well-placed for future
  dashboards.
- `probeState.trustedServicesSource` TOFU pin for ChanServ is correctly reset between
  sessions (plugin teardown clears it).
- The shutdown guard (`_isShuttingDown`) prevents double-teardown races.
- BlueAngel's 00:33 quick reconnect recovered correctly (clean SASL, quick reconnect) —
  confirming the architecture works for the common case.

---

## Recommendations

### Quick wins (< 30 min each)

- [x] **Log `WARN` when `registered` fires without bot `account-notify` on a SASL network** — instant
      visibility into SASL failure; no architectural change needed (I-1 fix, ~10 lines)
- [x] **Promote ChanServ probe timeouts from `DBG` to `WRN`** — they're currently invisible at
      production log levels; operators would have seen the failure within 10 seconds of reconnect
      (W-2 partial, 1 line change in chanserv-notice.ts)
- [x] **Add `botIdentified` boolean to `.status` output** — flag in `Services`, surfaced via
      `getStabilityMetrics()` in `bot.ts` (W-2, ~15 lines)

### Medium effort (code changes, < 2 h each)

- [x] **Detect NickServ "please identify" prompt and trigger password IDENTIFY fallback** — handle
      in `services.ts onNotice()`, emit `bot:sasl-identify-fallback`; wire `connection-lifecycle`
      to call `services.identify()` unconditionally after `registered` when `sasl: true` AND
      `password` is set, then let SASL de-dupe if it already worked (C-1 fix)
- [x] **Re-probe ChanServ on `bot:identified` event** — chanmod subscribes to the new event and
      calls `chain.verifyAccess()` for channels where access is `'none'`; clear `deferredAnopeNoAccess`
      for those channels first (C-2 + W-4 fix)
- [x] **Increase verify timeout during reconnect grace window** — `Services` tracks
      `reconnectedAt`; verifyUser uses 15 s within 30 s of reconnect (W-3 fix)
- [x] **Call `chain.verifyAccess()` on chanmod reload for channels already joined** — gate on
      `api.isInChannel(channel)` in `init()` (I-2 fix)

### Architectural (design input needed)

- [x] **Alt-nick + GHOST sequence** — Add `alt_nick` and `ghost_on_recover` to `BotConfig.irc`;
      implement `services.ghostAndReclaim()`; update `channelState.setBotNick()` and
      `bridge.setBotNick()` dynamically on nick changes after GHOST succeeds (C-4 fix)
- [x] **Formal bot-identify state machine** — `Services` tracks
      `identified | unidentified | pending | unknown`; gates `verifyUser()` on bot being identified;
      emits `bot:identified` / `bot:deidentified` as first-class events that chanmod, DCC, and
      other consumers can subscribe to; wired to both SASL account-notify and password IDENTIFY
      ack paths (C-1 + C-2 + C-3 combined fix)
- [x] **IDENTIFY-before-JOIN gate (configurable)** — Add `identify_before_join: true` config
      that delays JOINs until `bot:identified` event fires (with a max timeout to avoid hanging
      forever); eliminates the IDENTIFY/probe race on non-SASL networks (W-1 fix)
