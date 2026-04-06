# Security Audit: Recent Features (~20 commits)

**Date:** 2026-04-06
**Scope:** All code changes from `e045490` (Remove stale implementation plans) through `acca7f5` (ChanServ-assisted join error recovery). Covers:

- Config secrets env var resolution and Zod validation (`src/config.ts`)
- BotLink hub auth brute-force protection (`src/core/botlink-hub.ts`)
- ChanServ-assisted join error recovery (`plugins/chanmod/join-recovery.ts`)
- ChanServ notice parsing: Anope INFO founder detection, bold-wrap fix (`plugins/chanmod/chanserv-notice.ts`)
- Immediate unban on +b matching bot hostmask (`plugins/chanmod/mode-enforce.ts`)
- Join-error dispatching via IRC bridge (`src/irc-bridge.ts`)
- Scoped plugin unbind fix (`src/plugin-loader.ts`)
- Connection lifecycle refactoring (`src/core/connection-lifecycle.ts`)
- Anope GETKEY-based key retrieval (`plugins/chanmod/anope-backend.ts`)
- Config argument parsing (`src/index.ts`)

## Summary

The recent work is security-positive overall: Zod schema validation at config load time, env-var secrets replacing inline JSON, and auth brute-force protection on the BotLink hub are all significant hardening. No critical vulnerabilities found. Two warnings and three informational findings.

**Findings:** 0 critical, 2 warning, 3 info

## Findings

### [WARNING] Join recovery backoff defeated by successful rejoin

**File:** `plugins/chanmod/join-recovery.ts:107-115`
**Category:** DoS / ChanServ abuse amplification

**Description:** The join recovery backoff state resets every time the bot successfully joins a channel:

```typescript
api.bind('join', '-', '*', (ctx: HandlerContext) => {
  if (!isBotNick(api, ctx.nick)) return;
  const chanKey = api.ircLower(ctx.channel!);
  if (recoveryState.has(chanKey)) {
    recoveryState.delete(chanKey);     // ← backoff completely wiped
```

An attacker with channel ops can cycle the bot indefinitely: ban bot -> bot requests ChanServ UNBAN + INVITE -> bot rejoins (backoff resets) -> ban again. Each cycle takes ~3-4 seconds (SERVICES_DELAY_MS + processing) and generates 2-3 ChanServ requests. Over time this could:

1. Saturate the bot's message queue, delaying legitimate messages to other channels.
2. Trigger ChanServ's own rate limiting, preventing the bot from using ChanServ protection elsewhere.
3. Create log noise masking real takeover events.

The `getOrCreateState` function always starts with `lastAttempt: 0`, which unconditionally passes `checkCooldown`, so no backoff ever applies across the ban-rejoin cycle.

**Remediation:** On successful join, reset the `probedChannels` set (so re-probing works) but do NOT delete the `recoveryState` entry. Instead, set `lastAttempt = Date.now()` to keep the backoff active. Reset the backoff only after the bot has been in the channel for a sustained period (e.g., 5 minutes without a kick/ban). Something like:

```typescript
api.bind('join', '-', '*', (ctx: HandlerContext) => {
  if (!isBotNick(api, ctx.nick)) return;
  const chanKey = api.ircLower(ctx.channel!);
  probedChannels.delete(chanKey);
  // Don't delete recoveryState — let the backoff persist.
  // Schedule a delayed reset so sustained presence clears it.
  const rs = recoveryState.get(chanKey);
  if (rs) {
    rs.lastAttempt = Date.now();
    state.scheduleCycle(300_000, () => {
      // 5 min
      recoveryState.delete(chanKey);
    });
  }
});
```

---

### [WARNING] Auth tracker unbounded growth for banned IPs

**File:** `src/core/botlink-hub.ts:677-689`
**Category:** DoS / resource exhaustion

**Description:** The `sweepStaleTrackers()` method only removes entries where `banCount === 0`:

```typescript
if (tracker.bannedUntil < now && tracker.banCount === 0 && now - tracker.firstFailure > windowMs) {
  this.authTracker.delete(ip);
}
```

Once an IP has been banned even once (`banCount >= 1`), its tracker entry persists for the lifetime of the process. A distributed scanner probing from many source IPs (botnets, cloud instances) will create an ever-growing map. At ~100 bytes per entry, 1M unique IPs ≈ 100MB.

The doubling escalation (`banCount` driving the ban duration) is the reason entries are kept — but entries that haven't been seen in hours serve no purpose beyond memory consumption.

**Remediation:** Add a staleness threshold to the sweep: entries where `bannedUntil` expired more than e.g. 1 hour ago AND no recent failures should be eligible for cleanup regardless of `banCount`. The escalation information is lost, but an attacker returning after an hour of inactivity getting a fresh counter is an acceptable trade-off vs. unbounded memory growth.

```typescript
const STALE_THRESHOLD_MS = 3_600_000; // 1 hour
if (
  tracker.bannedUntil < now &&
  now - tracker.firstFailure > windowMs &&
  (tracker.banCount === 0 || now - tracker.bannedUntil > STALE_THRESHOLD_MS)
) {
  this.authTracker.delete(ip);
}
```

---

### [INFO] Anope GETKEY probe callback has no timeout

**File:** `plugins/chanmod/anope-backend.ts:169-179`
**Category:** Resource leak

**Description:** When `requestRemoveKey()` registers a callback in `probeState.pendingGetKey`, there is no timeout to clean it up if ChanServ never responds (ChanServ down, network split, unrecognized response format). Unlike ACCESS/FLAGS/INFO probes which use `markProbePending()` with a 10-second timeout, GETKEY callbacks accumulate indefinitely.

Each failed join recovery attempt for a +k channel adds one callback. Over many reconnect cycles or repeated join failures, this leaks closures holding references to the `api` and channel state.

**Remediation:** Use `markProbePending()` for GETKEY probes (adding a `pendingGetKey` branch), or add a dedicated setTimeout that deletes the callback after `PROBE_TIMEOUT_MS` and logs the timeout.

---

### [INFO] ChanServ probe FIFO ordering can misattribute access levels

**File:** `plugins/chanmod/chanserv-notice.ts:443-447`
**Category:** Correctness / defense-in-depth

**Description:** The `consumeFirstPendingProbe()` function assumes ChanServ responses arrive in the same order probes were sent. For response formats that include the channel name (Atheme "not found", "not registered"; Anope "not registered"), the correct channel is matched directly. But for the Atheme numeric format (`"2 hexbot +flags"`) and Anope ACCESS numeric/XOP formats, there's no channel identifier in the response — the first pending probe is consumed.

If multiple channels are probed simultaneously (e.g., bot reconnects and fails to join several channels at once, triggering parallel access probes), out-of-order ChanServ responses could attribute an access level to the wrong channel. The worst case is a false positive: the bot believes it has ChanServ access on a channel where it doesn't, causing ChanServ commands that will be denied (noisy but not harmful).

This is an inherent limitation of the ChanServ response format, not a design bug.

**Remediation:** No immediate fix needed — the failure mode is benign (ChanServ denies unauthorized commands). If multi-channel probing becomes common, consider serializing probes with a small inter-probe delay so only one probe is pending at a time.

---

### [INFO] Core INVITE handler uses JS toLowerCase() instead of ircLower()

**File:** `src/core/connection-lifecycle.ts:258`
**Category:** Correctness

**Description:** The INVITE auto-rejoin handler compares channel names using JavaScript's `.toLowerCase()`:

```typescript
const ch = configuredChannels.find((c) => c.name.toLowerCase() === channel.toLowerCase());
```

IRC casemapping (rfc1459) treats `[]\~` and `{}|^` as case-equivalent, which `.toLowerCase()` does not. A channel like `#FOO[bar]` would not match `#foo{bar}` even though they're the same channel on an rfc1459-casemapped server.

This is an edge case that only affects channels with bracket/tilde characters in their names. Pre-existing issue (not introduced by recent commits, but refactored into current location by `d1bfc4c`).

**Remediation:** Replace with the IRC-aware `ircLower()` utility. The `applyCasemapping` callback could expose the casemapping to the handler, or the comparison can use rfc1459 as a safe default (it's the superset of all mappings).

---

## Passed checks

- **Input validation:** All IRC input flows through `sanitize()` in `irc-bridge.ts` before reaching the dispatcher. Join-error events sanitize channel names and reasons. ChanServ notice text is not interpolated into IRC output.
- **Protocol injection:** ChanServ commands use `api.say()` (typed method), never `raw()`. Channel names in ChanServ commands come from the bot's own config or trusted channel state.
- **Permissions:** Join-error and mode handlers correctly use `'-'` flags (no privilege requirement) since they react to IRC events, not user commands. ChanServ protection actions are gated on `chain.canX()` access checks.
- **Plugin isolation:** Scoped API is `Object.freeze()`d. Channel keys are hidden from plugins (only `api.getChannelKey()` exposes them). The scoped unbind fix (`2ad7440`) correctly keys the wrapper map by `(handler, type, mask)` to prevent reference identity mismatches.
- **Credentials:** `_env` suffix convention properly resolves secrets from environment. `validateResolvedSecrets()` fails loudly on missing required secrets. Zod strict-object validation catches typos. Passwords never logged (confirmed in botlink auth flow and config loader).
- **Config security:** Zod schema (`parseBotConfigOnDisk`) rejects unknown keys (typo guard). World-readable check on bot.json. Channel key*env validation via `validateChannelKeys()`. `HEX*` prefix convention for env vars.
- **DoS protection:** BotLink hub has per-IP pending handshake limits, handshake timeout (10s), auth failure rate limiting with escalating bans, and per-frame-type rate limiting in steady state.
- **IRC-specific:** `isBotNick()` checks prevent self-triggering loops in mode-enforce. `wildcardMatch` with case-insensitive flag for ban mask comparison. IRC-aware `ircLower()` used throughout chanmod (except the INVITE handler noted above).
- **Immediate unban on +b** (`handleBotBannedThreat`): Correctly checks `!isNodesynch` and `!isBotNick(setter)` to avoid reacting to friendly bans. Only triggers when the ban mask actually matches the bot's hostmask via `wildcardMatch`. Fails safe when bot hostmask is unknown.

## Recommendations

1. **Fix join recovery backoff** (WARNING finding #1) — highest priority. An attacker with channel ops can abuse this now.
2. **Add TTL sweep for auth tracker** (WARNING finding #2) — medium priority. Only relevant for long-running hubs exposed to scanning.
3. **Add GETKEY timeout** (INFO finding #3) — low priority, minor resource leak.
4. Consider adding a per-channel or global cap on ChanServ requests per time window as a defense-in-depth measure independent of the backoff fix.
