# Security Audit: Full Codebase vs. docs/SECURITY.md

**Date:** 2026-08-23
**Scope:** Every `.ts` file in `src/` and `plugins/`, audited against each control documented in `docs/SECURITY.md`. Nine parallel domain audits: core input validation & injection, permissions & identity, DCC auth, bot link, config/secrets/STS, output/flood/logging, plugin isolation, chanmod (highest-risk auto-op), and remaining plugins.

## Summary

HexBot's security posture is strong and closely matches its documented model. The large majority of controls in SECURITY.md are implemented as described and were verified against source — the dispatcher's NickServ verification gate, SASL/STS/TLS handling, botlink HMAC handshake and rate limiting, plugin API freezing and namespace isolation, SQL parameterization, SSRF defense in rss, and the DCC scrypt auth architecture are all sound.

The audit found **three critical issues**, all of the same shape: a well-built primary security control that is **bypassed on a secondary code path**. In each case the documented guarantee holds on the path the docs describe, but a sibling path reaches the same privileged action without the check.

1. **chanmod re-op paths bypass the auto-op verification hard gate** — `+o` granted on hostmask match alone during recovery/re-enforcement, reintroducing the exact NickServ race §3.2 forbids. (Verified against source.)
2. **REPL `.chpass` leaks the plaintext password** to logs, `mod_log`, and every connected DCC console — the documented primary path for setting DCC passwords. (Verified.)
3. **Bot link cross-leaf CMD relay skips the `hasRemoteSession` forgery gate** — a compromised leaf can execute privileged commands as any handle across the whole botnet. (Verified.)

All three were confirmed by reading the cited source, not just reported. None is a "documentation says X, code does Y" mismatch — they are real gaps between the security model and its enforcement.

**Findings:** 3 critical, 22 warning, 15 info.

The critical fixes and the several nick-keyed rate-limit gaps (flood, DCC lockout — all inconsistent with the project's _own_ CTCP fix) should land before the next deployment to a real network.

---

## Critical findings

### - [x] [CRITICAL] chanmod: auto-op verification hard gate bypassed by mass re-op and reactive re-op paths

> **FIXED (2026-08-23):** Extracted the two-stage hard gate from `applyGrant` into a shared `verifyGrantEligibility()` in `auto-op.ts`. `performMassReop` (now async) and `handleUserModeEnforcement` (now async) both route every `+o/+h/+v` re-grant through it, threading the channel-state `accountName` into `findByHostmask`. Regression tests: `mass-reop.test.ts` ("does NOT re-op a flagged user whose only mask is too weak to trust") and `index.test.ts` ("should NOT re-op a deopped user whose only mask is too weak to trust").

**File:** `plugins/chanmod/mode-enforce-recovery.ts:230-251`, `plugins/chanmod/mode-enforce-user.ts:123-131`
**Category:** Permissions / NickServ race (§3.2)

`applyGrant()` in `auto-op.ts:114+` enforces a documented two-stage hard gate before any prefix-mode grant (account-tag/`$a:` match → `verifyUser()` await → `AUTO_OP_WEAK_HOSTMASK_THRESHOLD` specificity floor), precisely because the JOIN bind uses flag `-` and bypasses the dispatcher's `VerificationProvider`. **Verified:** the join path genuinely gates (auto-op.ts:128-183).

But two other paths reach `api.op()` without any of it, calling `findByHostmask(hostmask)` with **no account argument** and no specificity floor:

- `performMassReop` (mode-enforce-recovery.ts:231) — re-ops every hostmask-matching user in the channel. Fires when `mass_reop_on_recovery` (default **true**) triggers on elevated threat, which is trivially inducible (one bot-deop event = 3 points = ALERT).
- `handleUserModeEnforcement` `-o` path (mode-enforce-user.ts:129, `api.op(channel, target)`) — re-ops a flagged user whenever anyone deops them.

**Exploitation:** a user record with a weak mask (`nick!*@*` — exactly what the auto-op floor neutralizes) is refused on join, but a nick-squatter matching that mask gets `+o` from the bot as soon as (a) any op deops them, or (b) threat rises and mass-reop sweeps. This is the NickServ race the auto-op gate closes, reintroduced on the recovery path.

**Remediation:** route these grants through the same identity gate — pass the channel-state `accountName` into `findByHostmask` and enforce the specificity floor + verification before any `api.op()`. Ideally funnel both through `grantMode()` rather than calling `api.op()` directly.

### - [x] [CRITICAL] REPL `.chpass` leaks the plaintext DCC password to logs, mod_log, and every connected DCC session

> **FIXED (2026-08-23):** New shared `src/core/commands/secret-commands.ts` (`SECRET_COMMANDS` + `redactCommandLine`) is the single source of truth for secret-bearing verbs. `repl.ts` now redacts the line via `redactCommandLine()` before all three sinks (logger, DCC announce, mod_log) while still passing the raw line to the command handler for hashing. `botlink-commands.ts` re-checks its redaction set against the same `SECRET_COMMANDS` so they can't drift. Regression tests: `secret-commands.test.ts` and `repl.test.ts` ("never leaks the password to the log, the botnet announce stream, or mod_log").

**File:** `src/repl.ts:245-258`
**Category:** Credentials / logging (§3.4, §5.3)

`.chpass <handle> <newpass>` from the REPL is the documented primary way to set DCC passwords (§3.4; the no-hash migration notice in `dcc/index.ts:1989` explicitly points users there). **Verified:** the REPL runs the full command line through three sinks before dispatch:

- `this.logger?.info(`Command: ${trimmed}`)` (repl.ts:245) — console + file sinks, and fanned to every active DCC console via the logger sink installed at `dcc/index.ts:1470`.
- `this.bot.dccManager?.announce(`*** REPL: ${trimmed}`)` (repl.ts:248) — broadcast verbatim to every connected DCC session, including lower-privileged `+m` party-line users.
- `tryAudit(..., { action: 'repl-command', reason: trimmed.slice(0, 256) })` (repl.ts:255) — persisted to `mod_log`; scrubbing only removes `\r\n\0`, so the password survives in the DB.

This directly violates §3.4 ("Never logged. `mod_log` records ... with no plaintext or hash material") and §5.3, defeating the scrypt hashing entirely. Any DCC-connected user watches new passwords scroll by live; anyone with later read access to the DB or log files recovers every REPL-set password.

**Remediation:** redact sensitive command arguments before all three sinks. Cleanest is a `sensitive: true` flag on command registration so the REPL (and any future transport echo) redacts arguments generically; the audit row should keep only the command name. A targeted stopgap: `trimmed.replace(/^(\s*\.\s*chpass\b).*/i, '$1 [redacted]')`.

### - [x] [CRITICAL] Bot link: cross-leaf CMD relay skips the `hasRemoteSession` forgery gate

> **FIXED (2026-08-23):** The hub now performs an authoritative authorization decision before forwarding a cross-leaf CMD — mirroring the documented BSAY re-check. In `hub-cmd-relay.ts` the `toBot != self` branch looks up the command and calls `cmdPermissions.checkFlagsByHandle(entry.options.flags, handle, channel)`, refusing unknown commands and handles that lack the required flags (fail-closed, `[security]`-logged) instead of blind-forwarding. `hasRemoteSession` is deliberately NOT reused here (it would break legitimate pub/msg `.bot <leaf> <cmd>`, which has no DCC party session). Regression tests in `botlink.test.ts` ("refuses to relay a cross-leaf CMD when the claimed handle lacks the required flags", "refuses to relay an unknown cross-leaf CMD"). **Residual (inherent to the semi-trusted-leaf model, same as BSAY):** a compromised leaf can still relay under a handle that genuinely holds the flags on the synced DB; closing that fully needs per-session tokens or a destructive-command relay denylist — tracked as a follow-up, not a regression of this fix.

**File:** `src/core/botlink/hub-cmd-relay.ts:46-71`
**Category:** Bot linking / lateral movement (§11)

**Verified:** the `hasRemoteSession(handle, fromBot)` gate (documented to "prevent a compromised leaf from forging commands as arbitrary handles") is at hub-cmd-relay.ts:64 — **after** the `toBot && toBot !== ctx.botname` branch at :48-60, which forwards the frame to the named leaf (`ctx.send(toBot, frame)`) and returns without any session check. The receiving leaf runs it (`leaf.ts:549` → `cmd-exec.ts:46`) after checking only `checkFlagsByHandle(flags, handle, channel)`.

**Exploitation:** a compromised leaf L1 crafts a raw wire frame `{type:'CMD', command:'die', fromHandle:'owner', toBot:'L2', ref:'x'}`, bypassing its own command handler and `+m` gate. The hub forwards it to L2; L2 executes because the `owner` handle — synced to every bot via permission sync — has the flags. `fromBot` is authenticated (`hub.ts:805`) but never consulted here; the attacker-chosen `fromHandle` is trusted for the flag lookup. Result: full cross-bot command execution as any sufficiently-flagged handle across the botnet, limited only by the 10/s CMD rate limit. This is exactly the lateral-movement §11 claims to prevent — and `RELAY_REQUEST` (`relay-router.ts:266`) and hub-local CMD both _do_ gate.

**Remediation:** cross-leaf CMD needs a distinct authorization signal (reusing `hasRemoteSession` verbatim would break legitimate `.bot <leaf> <cmd>` from pub/msg operators who have no DCC party session). Have the hub re-resolve and re-check the caller's flags against its authoritative permission DB before forwarding (the hub is the documented source of truth), and/or require the frame be attributable to a live session/relay for `handle` on `fromBot`. At minimum, do not forward an attacker-chosen `fromHandle` to a sibling without a hub-side authorization decision.

---

## Warning findings

> **ALL WARNINGS REMEDIATED (2026-08-23).** Every warning below is fixed and
> covered by the passing suite (typecheck + lint clean, 4412 tests green). Two
> fixes deviate from the finding's literal suggestion, by design:
>
> - **`CommandHandler` ACC gate for `source:'irc'`** — implemented as an
>   optional `VerificationProvider` on `CommandHandler` (mirroring
>   `EventDispatcher`), wired in `bot.ts`, rather than hard-rejecting the
>   source: `source:'irc'` is the intended-but-unbuilt IRC command transport
>   the unit suite already exercises, so rejecting it would contradict the
>   design. `verify-flags` additionally fails closed on unrecognized flag
>   characters.
> - **`enforcebans` hardening** — kept the two robust defenses (mask
>   specificity floor + never-kick opped/voiced/flagged members) and
>   deliberately dropped a bot-flag-on-setter gate: setting `+b` already
>   requires channel `+o`, and enforcebans exists to amplify a channel op's
>   ban, so a bot-flag requirement would break the ordinary human-op case.
> - **Reply-frame responder binding (CMD_RESULT / PROTECT_ACK)** — CMD_RESULT
>   is now bound to the leaf the request was sent to (both `pendingCmds` and
>   `cmdRoutes`), so a compromised leaf can't resolve another's pending
>   command. PROTECT_ACK is **not** responder-bound: `PROTECT_*` requests are
>   broadcast to every leaf, so there is no single expected responder to
>   validate against — closing that requires per-request unguessable tokens
>   (tracked as a follow-up alongside the botlink CMD-forgery residual).

### Permissions & identity

- [x] **[WARNING] Unknown bind-flag characters silently disable the ACC verification gate** — `src/dispatcher.ts:209`, `src/utils/verify-flags.ts:55-58`. Neither `bind()`, `registerCommand()`, nor `api.bind()` validates flag chars against `VALID_FLAGS`. A bind with flags `"z"`/`"O"` (uppercase typo) is enforceable only via owner-implies-all, yet `requiresVerificationForFlags()` maps the unknown char to level 0 → the ACC gate never runs. The code comment claiming upstream rejection is not implemented anywhere. Fix: validate flags at bind/register time, or make `requiresVerificationForFlags` fail closed on unknown non-empty flags.
  - _Fixed 2026-08-23:_ `requiresVerificationForFlags` now imports `VALID_FLAGS` and returns `true` (gate on) for any bind-flag char outside it; `d` and other recognized-but-neutral flags still map to level 0. Test: `dispatcher-verification.test.ts` ("fails closed when bindFlags contains an unrecognized character").
- [x] **[WARNING] `CommandHandler.execute()` has no ACC verification — a future `'irc'` transport would ship the NickServ race** — `src/command-handler.ts:247-305`. The gate lives only in `EventDispatcher.dispatch()`. No production code constructs `source: 'irc'` today (not exploitable now), but the surface is designed to be wired (`ctx.account` threaded at :283, `modlog-commands.ts:472` branches on it). Fix: add a VerificationProvider to CommandHandler and gate `source==='irc'`, or hard-reject that source.
  - _Fixed 2026-08-23:_ `CommandHandler` gained an optional `VerificationProvider` (`setVerification`, mirroring the dispatcher's fast-path/slow-path/second-pass) that gates `source:'irc'` commands; `bot.ts` shares the same provider it installs on the dispatcher.
- [x] **[WARNING] `.flags` owner-guard re-resolves the caller by hostmask without the account tag** — `src/core/commands/permission-commands.ts:199-204`. Because account matches outrank hostmask matches, dropping `ctx.account` here can pick a different record than the gate that admitted the caller — a `+m` user whose hostmask matches another user's weak owner pattern can pass the master/owner-touch guard. Fix: `findByHostmask(mask, ctx.account ?? null)`, or reuse `ctx.handle`.
  - _Fixed 2026-08-23:_ the guard now resolves the caller by `ctx.handle` (the record the flag check already admitted), falling back to an account-aware `findByHostmask(mask, ctx.account ?? null)`.
- [x] **[WARNING] DCC command authorization uses hostmask resolution, not the password-authenticated handle** — `src/core/dcc/index.ts:893-905`, `src/command-handler.ts:293-300`. The session proved a handle via scrypt, but each command is flag-checked via `findByHostmask()` on the session hostmask; with overlapping patterns the session can execute with a more-privileged record's flags than the handle it authenticated as (the Rizon cloak-reuse scenario §3.4 documents, carried post-auth). Fix: for `source==='dcc'`, authorize via `checkFlagsByHandle(flags, session.handle, channel)`.
  - _Fixed 2026-08-23:_ `checkCommandPermissions` authorizes `source:'dcc'` via `checkFlagsByHandle(flags, ctx.dccSession.handle, channel)` (and stamps `ctx.handle`), falling through to the hostmask path only for test doubles lacking that method.
- [x] **[WARNING] `services.type === 'none'` makes `api.verifyUser()` fail open for plugin callers** — `src/core/services.ts:404-406`. Returns `verified: true, account: <nick>` for anyone on a no-services network; the fabricated account (attacker-chosen nick) could satisfy `$a:` logic in plugin code. The dispatcher correctly never installs the gate on type `none`, but plugins reach this branch directly. Fix: return `{ verified: false, account: null }` (fail closed).
  - _Fixed 2026-08-23:_ `verifyUser` returns `{verified:false, account:null}` on `type:'none'`. The auto-op and spotify paths are unaffected (both guard on `isAvailable()`). Test updated in `services.test.ts`.
- [x] **[WARNING] NickServ reply authentication is nick-only unless `services_host_pattern` is set** — `src/core/services.ts:616, 648`. With the pattern unset (the default), a client holding the nick `NickServ` during a services split can answer a pending verify with `<nick> ACC 3` and pass the gate. Within the letter of §3.2 (the pattern is a "recommendation"), but fail-open by default. Fix: startup `[security]` warning when services are enabled and the pattern is empty; consider defaulting known networks' patterns.
  - _Fixed 2026-08-23:_ new `warnServicesHostPatternRisk()` fires a startup `[security]` warning whenever services are enabled, the pattern is empty, and the bot trusts NickServ replies (password set or `require_acc_for` active). Pulled out of the TLS-gated plaintext-risk check so it fires regardless of TLS.
- [x] **[WARNING] `.flags <handle> <spec> &channel` silently applies globally** — `src/core/commands/permission-commands.ts:169`. `&`-prefixed channels (valid RFC 2812) fail the `#`-only check, so a channel-scoped grant becomes a global grant — silent scope escalation. Fix: accept `[#&]`, reject a channel-shaped third arg that matched neither.
  - _Fixed 2026-08-23:_ the third argument is accepted as a channel only when it starts with `#`/`&`; any other non-empty third arg is rejected with an error instead of silently falling through to a global grant.

### DCC

- [x] **[WARNING] `.chpass` caller identity resolved by hostmask, not the password-authenticated session handle** — `src/core/commands/password-commands.ts:249-254`. On cloak-persistent networks, overlapping hostmask patterns let a session authenticated as handle A be resolved as handle B and rotate B's password (self-rotation path) without knowing it. Fix: `if (ctx.dccSession) return ctx.dccSession.handle;`. (Same root cause as the DCC permissions warning above.)
  - _Fixed 2026-08-23:_ `resolveCallerHandle` returns `ctx.dccSession.handle` when a DCC session is present, before falling back to the hostmask lookup.
- [x] **[WARNING] Auth-lockout key includes the attacker-controlled nick — backoff bypass by nick rotation** — `src/core/dcc/index.ts:460, 1956`. `DCCAuthTracker` keyed on full `nick!ident@host`; a nick-rotating brute-forcer against a nick-wildcarded pattern gets a fresh key with zero failures each `/nick`, so the exponential lockout never engages. §10.2 already keys CTCP on `ident@host` for exactly this. Fix: key the tracker on `ident@host`.
  - _Fixed 2026-08-23:_ new `authLockoutKey()` strips the nick to `ident@host` for every tracker `check`/`recordFailure`/`recordSuccess`; the full `nick!ident@host` key is retained only for session identity, audit metadata, and logs. Tests updated in `dcc.test.ts`.
- [x] **[WARNING] DCC socket input is not sanitized before command handlers or the party line** — `src/core/dcc/index.ts:892-911`. The IRC bridge strips `\r\n\0` from every field; the DCC path does not. NUL, ANSI escapes (`\x1b[...`), and IRC formatting pass through — an authenticated DCC user can inject terminal escapes into every operator's console via party-line chat, and the same text flows to remote bots via `onPartyChat`. Fix: `sanitize()` + control-strip each DCC line before dispatch/broadcast.
  - _Fixed 2026-08-23:_ `onLine` now runs post-auth input through `stripFormatting()` then a C0/DEL control-byte strip (`DCC_CONTROL_BYTES_RE`) before command dispatch and party-line broadcast; the password phase still runs on the raw line.

### Input validation & injection (core)

- [x] **[WARNING] IRCv3 `account` tag value is never sanitized before entering ctx and channel state** — `src/core/irc-event-helpers.ts:29-41`, `src/irc-bridge.ts:628-636`. Every other inbound field goes through `sanitizeField()`, but `extractAccountTag()` returns the raw value; irc-framework unescapes tag `\r`/`\n` into real CR/LF, so a malicious/compromised server can inject control bytes into `$a:` matching, the account map, and any log/reply that renders it. Fix: `sanitize()` (ideally + `stripFormatting`) both return paths.
  - _Fixed 2026-08-23:_ `extractAccountTag` runs both return paths through `cleanAccount` = `stripFormatting(sanitize(...))`; a value that sanitizes to empty is treated as "not identified" (`null`). `checkAccount` inherits the fix at the single source.
- [x] **[WARNING] `raw()` line builders for KICK/INVITE/JOIN/TOPIC accept token-breaking params — unlike `sendModeRaw`** — `src/core/irc-commands.ts:218, 232, 282, 289`. `sanitize()` strips only line separators; `sendModeRaw()` additionally rejects whitespace/comma/leading-`:`, but these four builders don't, enabling same-verb parameter smuggling (`kick(chan, 'bob,alice')`, `join('#a,#b', key)`, nick `bob extra`). Fix: extract a shared `assertSafeRawParam()` and apply to every positional value.
  - _Fixed 2026-08-23:_ new module-level `assertSafeRawParam()` (rejects whitespace/comma/leading-`:`) is applied to every positional param of `join`, `kick`, `invite`, `topic`, and `sendMode`; trailing free-text args (kick reason, topic body) keep `sanitize`+byte-clamp.
- [x] **[WARNING] Command flood-limit key includes the nick — nick rotation resets the window** — `src/irc-bridge.ts:664`. Inconsistent with the CTCP limiter's deliberate `ident@host` keying (irc-bridge.ts:474-484). An attacker rotating nicks gets a fresh sliding window per nick. Fix: key on `ident@host`. (Reported by two independent domains.)
  - _Fixed 2026-08-23:_ `dispatchMessage` keys the flood check on `ident@host` (bare nick only when both are missing), matching the CTCP limiter.

### Config, secrets, connection

- [x] **[WARNING] SASL auth failure (904/908) retries twice before exiting — contradicts documented "fatal exit, not a retry loop"** — `src/core/reconnect-driver.ts:123-124, 190-204`. `FATAL_BUDGET = 3` re-submits the bad credential two more times (~5 min backoff) before exiting; the classifier comment still says "must fire on first hit, before the account-lockout counter ticks." On networks with services-side failure counters this triples lockout pressure. Fix: split fatal classes so credential-rejection exits first-hit while infrastructure fatals (cert, DNS) keep the budget, or document the budget as an accepted trade-off and reconcile the comment.
  - _Fixed 2026-08-23:_ the classifier tags SASL-rejection fatals with `firstHit: true` (TLS/DNS fatals leave it unset); the driver exits immediately on a `firstHit` fatal, bypassing `FATAL_BUDGET`, while infrastructure fatals keep the budget. Tests added in `connection-lifecycle.test.ts` and `reconnect-driver.test.ts`.
- [x] **[WARNING] `services.services_host_pattern` cannot be set in bot.json — strict schema rejects the documented hardening field** — `src/config/schemas.ts:61-80`. The field is a `z.strictObject` omission, so an operator following §3.2 and adding it to bot.json gets a fatal `Unrecognized key` at startup; the only working path (runtime settings registry) is undocumented in the security guide. Fix: add `services_host_pattern: z.string().optional()` to the schema.
  - _Fixed 2026-08-23:_ `services_host_pattern: z.string().optional()` added to `ServicesConfigOnDiskSchema`; it flows through the loader's spread into the runtime `ServicesConfig` the ServicesManager already reads.
- [x] **[WARNING] Shipped example uses the exact `services_host_pattern` wildcard the guide warns against** — `config/plugins.example.json:4` (`"services.*"`). §3.2 explicitly says pin to a full mask, not `services.*`; on networks with user-settable vhosts a user with hostname `services.example.evil` passes the chanmod impostor guard. Fix: ship a full-mask network-specific value with a comment pointing at §3.2.
  - _Fixed 2026-08-23:_ the example now ships the concrete `services.libera.chat` (an exact host a user vhost can't satisfy) instead of `services.*`. (JSON can't carry a comment; the tighter default value is the guard.)

### Output, flood, logging

- [x] **[WARNING] DCC console log lines are not control-stripped, contradicting the code's own comment** — `src/logger.ts:366-373`. The comment says `dccFormatted` is scrubbed; only `plain` actually is, and the DCC sink delivers `record.dccFormatted` verbatim (`dcc/index.ts:715`). User-controlled text (e.g. the CTCP payload logged at irc-bridge.ts:480) carries mIRC bytes into operator consoles. Broken control, one-line fix: wrap `dccFormatted` in `stripLogControls`.
  - _Fixed 2026-08-23:_ `write()` scrubs the caller-supplied string args (`safeArgs`) with `stripLogControls` _before_ chalk colors the prefix, so `formatted`, `plain`, and `dccFormatted` are all protected while the intended prefix ANSI (and DCC color) survives.
- [x] **[WARNING] `stripLogControls` misses ESC (`\x1b`), `\x04`, `\x11` — terminal-escape injection into log sinks** — `src/logger.ts:15-18`. A channel message containing `\x1b]0;pwned\x07` or `\x1b[2J` survives into log args; even the "scrubbed" `plain` retains `\x1b`. §5.3 requires stripping control chars from user data in logs. Fix: strip all C0 controls except `\n`/`\t` (e.g. `/[\x00-\x08\x0b-\x1f\x7f]/g` minus tab), and scrub user-data args before chalk coloring.
  - _Fixed 2026-08-23:_ `stripLogControls` now strips every C0 control + DEL except `\n`/`\t` (`/[\x00-\x08\x0b-\x1f\x7f]/g`), and is applied to user args pre-chalk (see the finding above) so ESC never reaches a sink from user data.
- [x] **[WARNING] Input flood limiting is off by default — no `flood` block in schema defaults or bot.example.json** — `src/config/schemas.ts:253`, `src/bot.ts:570-572`. `FloodLimiter.check()` returns `{ blocked: false }` when config is null, and the example ships no flood section, so a bot deployed from the example has command flood protection entirely disabled despite `FLOOD_DEFAULTS` existing. Violates §7 secure-defaults. Fix: call `setFloodConfig({})` unconditionally or default the schema to `{}`; add a flood block to the example.
  - _Fixed 2026-08-23:_ `bot.ts` now calls `setFloodConfig(this.config.flood ?? {})` unconditionally, so an omitted `flood` block applies `FLOOD_DEFAULTS` (5/10s) instead of disabling limiting; `bot.example.json` gained an explicit `flood` block for discoverability.
- [x] **[WARNING] Ban/unban/invite/deluser confirmations echo user-controlled strings without `stripFormatting()`** — `ban-commands.ts:189` (+231,256,259,285,288), `irc-commands-admin.ts:231`, `permission-commands.ts:113,143`. §5.2 lists these exact contexts (permission revoke, ban action messages) as strip-required; sibling paths (`adduser` :70, bans list) strip, so it's an inconsistency. Fix: wrap mask/channel/nick/handle in `stripFormatting()`.
  - _Fixed 2026-08-23:_ wrapped the echoed mask/channel/nick/handle in `stripFormatting()` across `ban-commands.ts` (banned/unbanned/stick/unstick/no-tracked-bans), `irc-commands-admin.ts` (invite), and `permission-commands.ts` (deluser + `.flags` not-found).
- [x] **[WARNING] Audit fallback buffer stores unscrubbed rows** — `src/core/mod-log.ts:392-394, 489-493`. `scrubModLogField()` runs after the `writesDisabled` early-out and the catch path forwards original options, so `AuditFallbackBuffer` holds raw `by`/`target`/`reason` with CR/LF and mIRC bytes. The first command that renders `snapshot()` inherits a log-injection vector. Fix: hoist the scrub above the `writesDisabled` check.
  - _Fixed 2026-08-23:_ both fallback paths (writes-disabled early-out and the BUSY/FULL catch) now pass `scrubOptionsForFallback(options)` — a copy with `by`/`plugin`/`channel`/`target`/`reason` run through `scrubModLogField` — to `auditFallback`.

### chanmod

- [x] **[WARNING] Re-op/re-voice enforcement re-grants modes on hostmask alone even for `$a:`-only records** — `mode-enforce-user.ts:103,125,151-167`, `helpers.ts:118-126`. `getUserFlags` → `findByHostmask` with no account argument; a record meant to be identity-bound via `$a:` won't match by account but will match any hostmask pattern it also carries, silently defeating `$a:` pinning on reactive enforcement. Same root cause as the critical, lower severity (steady-state, requires a co-present hostmask pattern). Fix: thread `accountName` into `getUserFlags`/`findByHostmask` and apply the specificity floor.
  - _Fixed 2026-08-23:_ `getUserFlags` resolves the nick's channel-state `accountName` and threads it into `findByHostmask(hostmask, account)`, so `$a:`-pinned records resolve by account on every flag-read authorization decision. (The re-grant path itself is already gated by the critical fix's `verifyGrantEligibility`.)
- [x] **[WARNING] `enforcebans` trusts an attacker-supplied `+b` mask to select kick targets** — `mode-enforce.ts:142-160`. With `enforcebans` on, any op (including a hostile one) setting `+b *!*@*` makes the bot kick every non-bot user — no flagged-user exemption, no specificity floor, no setter authorization check. Default off, but partial-takeover-with-ops is exactly chanmod's target scenario. Fix: skip op/exempt-flag holders, apply a specificity floor to the mask, honor `+b` only from authorized setters.
  - _Fixed 2026-08-23:_ `handleEnforceBans` now refuses masks below a specificity floor (`ENFORCEBANS_MIN_MASK_SPECIFICITY`, blocks `*!*@*`-class) and never kicks a currently-opped/voiced member or one holding an exempt chanmod flag (`nmov`). The bot-flag-on-setter gate was deliberately not added (setting `+b` already needs channel `+o`, and the feature exists to enforce a human op's ban) — see the deviation note at the top of this section.

### Bot link

- [x] **[WARNING] Reply frames (`CMD_RESULT`, `PROTECT_ACK`) matched by ref alone with no responder validation** — `hub-frame-dispatch.ts:102-114`, `relay-router.ts:198-205`. Refs are non-secret sequential counters (and leaf refs from different leaves collide); neither reply is rate-limited. A compromised leaf can resolve an operator's pending `.bot` command with forged output or ACK a peer's `PROTECT_*` as `success:true`. Deception, not code execution. Fix: record the expected responder bot per pending/route entry and drop replies whose authenticated `leaf.botname` doesn't match.
  - _Fixed 2026-08-23 (CMD_RESULT):_ `PendingRequestMap.create`/`resolve` and `BotLinkRelayRouter.trackCmdRoute`/`popCmdRoute` now carry an expected responder; `hub.ts` records the target leaf and `handleCmdResult` passes `leaf.botname`, so a mismatched (forged) reply is dropped without consuming the pending entry. **PROTECT_ACK not responder-bound** — `PROTECT_*` is broadcast to every leaf so there is no single expected responder; see the deviation note at the top of this section (follow-up: per-request tokens).

### Plugin isolation & other plugins

- [x] **[WARNING] `help` plugin imports runtime code directly from `src/`** — `plugins/help/index.ts:5-12`. A value import of `lookup`/`render*` from `../../src/core/help-render`, violating §4.1 (every other plugin uses `import type`). tsup bundles the core code into the plugin's dist, so it runs outside the frozen PluginAPI and a hot-reloaded help plugin runs a stale inlined copy after a core change. Fix: expose the helpers on the scoped API; add a CI check rejecting non-`import type` `../../src/` specifiers under `plugins/`. (Reported by two domains.)
  - _Fixed 2026-08-23:_ new scoped `api.help` namespace (`PluginHelp`) exposes `lookup`/`renderCommand`/`renderCategory`/`renderScope`/`renderNotFound`/`renderIndex`; the help plugin uses it and drops the `src/` value import. An ESLint override on `plugins/**` (`@typescript-eslint/no-restricted-imports`, `allowTypeImports`) now rejects value imports from `src/` (verified firing).
- [x] **[WARNING] Scoped `api.unbind()` compares masks with `===` while the dispatcher case-folds** — `src/plugin-api-factory.ts:389-394`. A channel-scoped plugin that binds `!Foo` then unbinds `!foo` leaks the live bind and its tracking entry until unload — defeats a §4.3 cleanup guarantee. Fix: use `caseCompare(e.mask, mask, getCasemapping())` in the findIndex predicate.
  - _Fixed 2026-08-23:_ `unbind` now uses `caseCompare(e.mask, mask, getCasemapping())` in the `findIndex` predicate, matching the scoped-bind path.
- [x] **[WARNING] rss DOCTYPE guard scans only the first 4 KiB — bypassable with a padded prolog** — `plugins/rss/feed-fetcher.ts:343-348`. The XML prolog may legally hold arbitrary-length comments before the DOCTYPE, so a hostile feed can pad 4 KiB+ then deliver an entity-expansion DOCTYPE into the parser. Moderated (feeds added by `+m` only; sax doesn't resolve external entities) but the guard exists to stop exactly this. Fix: full-body `/<!DOCTYPE/i` test (body is already `max_feed_bytes`-capped).
  - _Fixed 2026-08-23:_ `containsDoctype` tests the whole (`max_feed_bytes`-capped) body; the `DOCTYPE_SCAN_WINDOW` constant was removed.
- [x] **[WARNING] ai-chat social-tracker persists one KV row per speaking nick with no count cap** — `plugins/ai-chat/social-tracker.ts:305-331`. Only reaper is a 90-day age-out; a nick-rotation flood mints unbounded rows (§2.4 storage exhaustion). The sibling `seen` plugin caps at 10k for the same threat. Fix: mirror seen's hard cap + oldest-`lastSeen` eviction in `retainUserInteractionRows`.
  - _Fixed 2026-08-23:_ new `enforceUserInteractionCap()` (cap `MAX_USER_INTERACTION_ROWS = 10_000`, oldest-`lastSeen` eviction) runs whenever a new nick's row is minted — bounding the O(n) sweep to once per unique nick, which is exactly the flood case.

---

## Info findings

> **ALL INFO FINDINGS RESOLVED (2026-08-23).** Code fixes landed for 20;
> the remainder are accepted-risk or already-well-guarded dispositions,
> each noted inline. Suite green after the batch (typecheck + lint clean,
> 4422 tests, 10 new regression tests).

- [x] **[INFO] `onAction` does not extract the `account` tag** — `src/irc-bridge.ts:258-286`. ACTION traffic doesn't prime the account fast path; degrades to the slow verification path (never to a grant). Fix: call `checkAccount` in `onAction`.
  - _Fixed 2026-08-23:_ `onAction` calls `checkAccount(event, nick)` and stamps `ctx.account`, matching `onMessage`/`onNotice`/`onJoin`.
- [x] **[INFO] `MAX_INPUT_BYTES` clip compares UTF-16 code units against a byte-named constant** — `src/utils/split-message.ts:27, 52-54`. Admits ~2× the intended byte ceiling; harmless given per-line early truncation. Fix: `Buffer.byteLength` or rename.
  - _Fixed 2026-08-23:_ renamed to `MAX_INPUT_CODE_UNITS` with a doc comment stating the ~3× byte slack is deliberate — it's a DoS backstop where an O(1) code-unit slice beats a second full byte scan; downstream per-line truncation enforces the real byte limits.
- [x] **[INFO] `.say`/`.msg` target validation permits comma multi-target and leading `:`** — `src/utils/parse-args.ts:108`, `irc-commands-admin.ts:190`. `+o`-gated, hygiene gap only.
  - _Fixed 2026-08-23:_ `isValidCommandTarget` rejects `,` and `:` anywhere (RFC 2812 excludes both from channels and nicks); `.msg` keeps its looser services-target shape but rejects commas and a leading `:`. Regression tests for both commands.
- [x] **[INFO] `CommandHandler.execute` does not formatting-strip the command word** — `src/command-handler.ts:203-209`. REPL/DCC/botlink pass the line verbatim; a `\x02`-wrapped command fails lookup (fail-closed). Consistency only.
  - _Fixed 2026-08-23:_ `execute()` runs the parsed command word through `stripFormatting()` so a wrapped verb resolves identically on every transport. Test added.
- [x] **[INFO] Slow-path verification conflates account name with nick — grouped nicks break `$a:` matching** — `src/core/services.ts:673, 680-684`. ACC/STATUS carry no account name, so a grouped alt nick won't match their `$a:<primary>` record; fail closed (denial), not escalation. Worth a comment/doc note.
  - _Fixed 2026-08-23:_ KNOWN LIMITATION comment added at the ACC/STATUS parse site documenting the fail-closed behavior and the account-tag fast path as the grouped-nick escape hatch.
- [x] **[INFO] `verifyUser` interpolates the nick into `ACC`/`STATUS` without `sanitize()`** — `src/core/services.ts:546-549`. Sibling IDENTIFY/GHOST paths sanitize; `api.verifyUser(nick)` accepts arbitrary plugin strings. Fix: `sanitize(nick)`.
  - _Fixed 2026-08-23:_ both the ACC and STATUS sends sanitize the nick, matching IDENTIFY/GHOST.
- [x] **[INFO] `services_host_pattern`/NickServ-sender comparisons use default casemapping, not the network's** — `src/core/services.ts:593, 616, 648`. Negligible (services identities are ASCII); folding-contract inconsistency.
  - _Accepted 2026-08-23:_ comment added at the sender-compare site documenting that `toLowerCase()` is deliberate — services identities are ASCII on every target network and contain none of the `[]\~` chars where rfc1459 folding diverges.
- [x] **[INFO] SASL secure-defaults are required fields, not defaults** — `src/config/schemas.ts:35, 65, 56-58`. `irc.tls`/`services.sasl`/`require_acc_for` are mandatory (fail-closed, arguably stronger); the "default" lives only in the example. §7 doc/code wording mismatch.
  - _Fixed 2026-08-23 (docs):_ SECURITY.md §7 table now marks these rows as required-explicit (fail-closed: omission is a startup error, not a silent default).
- [x] **[INFO] §7 says admin commands are `+n`; the IRC admin commands are `+o`** — `src/core/commands/irc-commands-admin.ts`. Permission-mutating commands are `+n` as documented; `.say`/`.join`/`.part`/`.status` are `+o` (`.say` lets any op speak as the bot). Clarify the table or raise `.say`.
  - _Fixed 2026-08-23 (docs):_ SECURITY.md §7 table split into "permission-mutating commands `+n`" and "operational IRC commands `+o`" rows, with the `.say` implication called out.
- [x] **[INFO] Multi-bot per-instance env files escape the dotenv permission check** — `src/config/file-permissions.ts:55`. `config/<net>/<bot>.env` paths aren't in the candidate list, so a world-readable per-bot env file starts the bot without the fatal check. Fix: `HEX_ENV_FILE` hint or scan `config/**/*.env`.
  - _Fixed 2026-08-23:_ both suggestions landed — `checkDotenvPermissions` now sweeps `config/` (depth 3) for env-shaped files (`.env`, `*.env`, `*.env.*`; `*example*` excluded so fresh checkouts don't trip the fatal check) and honors an operator-set `HEX_ENV_FILE` for files outside the tree.
- [x] **[INFO] Logger redaction list omits `pass`** — `src/logger.ts:28-38`, the key the SOCKS credential travels under (`socks.ts:46`). No current path logs it; defense-in-depth only. Fix: add `'pass'` (and `'link_salt'`).
  - _Fixed 2026-08-23:_ `pass` and `link_salt` added to `REDACT_FIELDS`.
- [x] **[INFO] `.modlog show` prints by/target/reason without read-time stripping; legacy migrated rows never scrubbed** — `src/core/commands/modlog-commands.ts:724-739`. Write-time scrubbing covers new rows; apply `stripFormatting()` in `runShow` as `renderRow` already does.
  - _Fixed 2026-08-23:_ `runShow` strips `by`/`channel`/`target`/`reason`/`plugin` at read time (metadata was already stripped).
- [x] **[INFO] CTCP events are logged before the rate-limit check** — `src/irc-bridge.ts:480-485`. Every inbound CTCP (incl. attacker payload) logs at the sender's rate. Fix: log after `ctcpAllowed`, or demote blocked hits to debug.
  - _Fixed 2026-08-23:_ both — the info log moved after `ctcpAllowed`, and blocked hits log a payload-free line at debug.
- [x] **[INFO] `MessageQueue.flush()` bypasses the token bucket on shutdown** — `src/core/message-queue.ts:174-188`. Up to 500 unpaced sends on `.restart`; accepted-risk per its comment (disconnect path uses `flushWithDeadline`).
  - _Accepted 2026-08-23:_ unchanged — operator-initiated `.restart` only, the in-code comment already documents the trade-off, and the disconnect path uses `flushWithDeadline`.
- [x] **[INFO] Second racing DCC TCP connection is never destroyed** — `src/core/dcc/index.ts:1909-1913`. A connection accepted from the backlog before `close()` is emitted with no listener and left dangling. No auth impact. Fix: `server.maxConnections = 1`.
  - _Fixed 2026-08-23:_ `server.maxConnections = 1` set on the per-offer listener, making the kernel-backlog race unrepresentable.
- [x] **[INFO] `awaiting_password` DCC sessions don't count toward `max_sessions`** — `src/core/dcc/index.ts:1756-1760`. Bounded in practice by port range + 30s timeout. Optional: include `pendingSessions.size`.
  - _Fixed 2026-08-23:_ `checkSessionLimit` counts `sessionStore.size + pendingSessions.size`.
- [x] **[INFO] botlink `sweepStaleTrackers()` runs on every `admit()` before the ban check** — `src/core/botlink/auth.ts:304-305`. Contradicts §11's "banned IPs = zero resource cost"; O(n≤10000) per SYN, attacker-amplifiable. Fix: check ban state first, return before sweeping.
  - _Fixed 2026-08-23:_ the sweep moved after the ban/CIDR-ban rejections (and out of the whitelisted/unknown lanes); banned SYNs are back to near-zero cost, and boundedness is preserved by the sweep on every admitted connection plus the 5-minute timer.
- [x] **[INFO] botlink `ANNOUNCE` payload not stripped of formatting before DCC delivery** — `src/core/relay-orchestrator.ts:403-405`. PARTY_* strip; ANNOUNCE doesn't (no line injection — `sanitizeFrame` ran). Cosmetic. Fix: `stripFormatting()`.
  - _Fixed 2026-08-23:_ ANNOUNCE delivery runs `stripFormatting()` for parity with the PARTY_* paths.
- [x] **[INFO] botlink `normalizeIP` does not lowercase, contradicting comments** — `src/core/botlink/auth.ts:48-51`. Uppercase IPv6 ULA/link-local literals misclassify; fails safe in every direction. Fix: lowercase, or drop the misleading comments.
  - _Fixed 2026-08-23:_ `normalizeIP` lowercases its result, making the `isPrivateOrLoopback` prefix checks (and their comments) correct for uppercase literals. Tests added.
- [x] **[INFO] botlink `unknown` remote address bypasses per-IP tracking** — `src/core/botlink/auth.ts:308-311`. Untracked lane, but must still pass HMAC (not an auth bypass). Low impact under loopback-only default.
  - _Accepted 2026-08-23:_ unchanged — a socket with no kernel-reported remote address has no key to track by; the HMAC handshake, handshake timeout, and global pending caps still apply, and the loopback-only default keeps the lane unreachable from outside.
- [x] **[INFO] chanmod takeover hostile-response targets nicks from the threat log** — `mode-enforce-recovery.ts:327-463`. Correctly skips bot/nodesynch/exempt-flag holders and confirms presence; narrow residual window, well-guarded.
  - _Accepted 2026-08-23:_ no change — the audit's own assessment is that the existing guards (bot/nodesynch/exempt skip + presence confirmation) cover the path; the residual is inherent to reacting to observed mode events.
- [x] **[INFO] chanmod `!unban` with explicit mask issues `-b` after only `!`/`@` presence check** — `ban-commands.ts:215-276`. `-b` only removes bans and needs `+o` + bot ops. Low risk.
  - _Accepted 2026-08-23:_ no change — `-b` is strictly permission-reducing, and the caller already holds `+o`.
- [x] **[INFO] flood nick-flood enforcement targets the new nick by name** — `plugins/flood/index.ts:271-300`. A bystander adopting the just-vacated nick inside the enqueue window could be kicked/tempbanned. Core rate keys are hostmask-based so floods can't be attributed to others. Fix: build the ban mask from the triggering event's hostmask.
  - _Fixed 2026-08-23:_ `enforcement.apply()` gained an `offenderHostmask` parameter (passed by the nick-flood handler): kick/tempban now verify the nick still resolves to the offending `ident@host` in channel state (mismatch = skip with log — a bystander never eats the punishment), and the tempban mask is built from the pinned hostmask instead of a by-nick re-lookup. Three regression tests.
- [x] **[INFO] greeter emits stored greet text without display-time formatting strip** — `plugins/greeter/index.ts:214-225, 249`. Strip happens only on write; pre-3.0 rows render raw. Formatting-spoofing only. Fix: strip at emit time.
  - _Fixed 2026-08-23:_ both the greet template and the join notice are `stripFormatting()`-ed at emit, covering legacy rows.
- [x] **[INFO] `!topics preview` echoes unstripped sample text** — `plugins/topic/index.ts:245-252`. NOTICEd only to the `+o` invoker. Fix: strip for parity.
  - _Fixed 2026-08-23:_ `sampleText` is stripped before theme rendering.
- [x] **[INFO] Unthrottled public reply commands** — `spotify-radio/index.ts:196-198` (`!listen`), `ai-chat/index.ts:1130-1134`, `8ball/index.ts:58-68`. Noise, not DoS (message queue caps output). The help plugin's ident@host cooldown is the house pattern worth copying for `!listen`.
  - _Fixed 2026-08-23 (`!listen`):_ 30s per-`ident@host` cooldown with inline expiry sweep (silent drop — a notice would defeat the point), copying the help-plugin house pattern. ai-chat (pre-spend rate limiting already in place) and 8ball (single-line reply, queue-paced) left as-is per the finding's own assessment.
- [x] **[INFO] ai-chat accepts an inline `api_key` in config** — `plugins/ai-chat/config.ts:247`. An operator can set it inline in plugins.json, sidestepping §6 with no warning. Fix: warn when `api_key` is present raw rather than resolved from `api_key_env`.
  - _Fixed 2026-08-23 (generalized):_ the warning lives in the plugin loader, not ai-chat — after `_env` resolution the plugin can no longer tell inline from resolved, so `warnInlineSecrets()` inspects the pre-resolution merged config for every plugin and `[security]`-warns on secret-shaped keys (`*_key`, `*_token`, `*_secret`, `*password*`) holding inline string values without an `_env` sibling.
- [x] **[INFO] `api.mode()` carries no actor — plugin-driven mode changes lose triggering-user attribution** — `src/plugin-api-factory.ts:724-726`. Core `IRCCommands.mode` signature gap (not a spoofing hole). Fix: thread an optional actor through.
  - _Fixed 2026-08-23:_ both `IRCCommands.mode` and `api.mode` accept a trailing actor object in the variadic tail (unambiguous — real mode params are always strings), keeping the trailing-actor convention of `op`/`kick`/`ban` without breaking the ~25 existing variadic call sites. The factory re-stamps `source`/`plugin` via `resolveActor()` as for every other mutator. Test added.
- [x] **[INFO] Dispatcher auto-trips repeat-throwing binds — stricter than §4.2's "logged but not auto-unloaded"** — `src/dispatcher.ts:447-454`. A reasonable circuit breaker, but an automatic containment action §4.2 assigns to the admin. Fix: document the thresholds in §4.2, or emit an event-bus notice.
  - _Fixed 2026-08-23 (docs):_ SECURITY.md §4.2 now documents the per-bind circuit breaker (consecutive-failure threshold, `[tripped]` visibility in `.binds`, reload-to-reset) as the intended containment behavior.

---

## Documentation-accuracy notes (fix the docs, not the code)

These are places where the code is correct/stronger than SECURITY.md states — worth reconciling so future audits don't re-flag them:

> **ALL RECONCILED (2026-08-23)** — SECURITY.md updated in the same pass as the INFO fixes.

- [x] §4.1 says DB namespace isolation is enforced "at the `BotDatabase` class level"; it's actually enforced in the plugin-API factory closure (`plugin-api-factory.ts:550-565`) plus loader name rules. Isolation holds (no escape found — the plugin never supplies a namespace), but the wording is imprecise. Optionally add a `PluginScopedDatabase` wrapper to make the claim literally true.
  - _Fixed 2026-08-23 (docs):_ §4.1 now names the factory closure + loader name rules as the enforcement point.
- [x] §7 secure-defaults table rows for `irc.tls`/`services.sasl` (required, not defaulted) and "admin commands `+n`" (mutating `+n`, operational `+o`) — see the two INFO items above.
  - _Fixed 2026-08-23 (docs):_ both table corrections landed — see the corresponding INFO entries.
- [x] §11 "banned IPs = zero resource cost" — see the `sweepStaleTrackers` INFO.
  - _Fixed 2026-08-23 (code):_ the code was fixed to match the doc (sweep moved after the ban check), so the §11 claim stands as written.
- [x] §10.1 per-user flood protection is documented as per-user but implemented per-nick — see the flood-key warning.
  - _Fixed 2026-08-23:_ the flood key moved to `ident@host` (warning fix); §10.1 now states the keying explicitly.

---

## Passed checks (high-confidence, verified against source)

The following documented controls were confirmed correctly implemented. This is a summary; each domain scratch report carries the file:line evidence.

- **Input/injection (§2, §5, §8):** every inbound bridge field sanitized via `sanitizeField()`; command word formatting-stripped before dispatch; `stripFormatting` covers all documented codes incl. color/hex params; `splitMessage` measures UTF-8 bytes, preserves surrogate pairs, 4-line cap; all SQL parameterized with LIKE escaping; account-tag reads only server-set tags (client `+`-tags never match); `wildcardMatch` DoS caps; `rawHandleForTests` runtime-gated.
- **Permissions/identity (§3, §8):** dispatcher gate ordered flag→verify→handler and awaited; account-tag fast path with known-not-identified fail-closed and confirmed-account second pass; fail-closed on verify timeout, pending-verify cap, spoofed sender, bot-unidentified, and no-permissions-provider; owner `n` implies all; `-`/empty as the only skip cases; no cross-user short-circuit (most-specific winner, `$a:` outranks hostmask); `nick!*@*` warnings + boot sweep; last-owner guards; NickServ sender spoof guard with anchored ACC/STATUS parsers; account map cleared on reconnect.
- **DCC (§3.4/§3.5):** scrypt 16-byte salt / N=16384,r=8,p=1 / `scrypt$` prefix / `timingSafeEqual` / min-length 8; 30s listener timeout; exactly-one-connection accept; flags checked before port offered; `awaiting_password` blocks commands and party line; exponential-backoff lockout; no-hash users rejected with migration notice; `.chpass` IRC PRIVMSG hard-rejected and never crosses botlink; TOCTOU closed via live-hash refetch + session eviction; prompt-phase DoS caps; REPL has no network exposure.
- **Bot link (§11):** fresh 32-byte nonce per connection; scrypt(password, link_salt) with `timingSafeEqual`; salt ≥32 hex enforced; leaf validates 64-hex nonce; doubling bans to 24h with success-decrement; ban check before protocol setup; pending/timeout caps; IPv4-only whitelist with warnings; `sanitizeFrame` in and out; 64KB frame cap; all documented per-frame-type rate limits; hub-only frames never fanned out; hub never applies leaf permission mutations; BSAY `+m` re-check fail-closed; relay `hasRemoteSession` gate (on `RELAY_REQUEST`); PROTECT acts only on known nicks by hostmask+account; loopback default with non-RFC1918 warning; authenticated `fromBot` overwrite; bounded state everywhere.
- **Config/secrets/STS (§3.2, §6, §7, §9):** `_env` resolution for all secret fields with name-only warnings; `validateResolvedSecrets` names the missing var; SASL PLAIN + plaintext refused at startup; SASL EXTERNAL requires TLS+cert; plaintext-IDENTIFY/GHOST `[security]` warnings; world-readable bot.json refused; no secrets logged; gitignore + example configs clean; STS persisted in `_sts`, enforced pre-connect, upgrade/refusal/duration=0/clamp all correct; proxy password via `_env` only with connect-timeout watchdog.
- **Output/flood/logging (§5, §10):** token bucket 2/s burst 4 with per-target round-robin and depth caps; UTF-8 split with 4-line cap; outbound replies sanitized+split; flood check once per message before paired dispatch with owner bypass and one-time NOTICE; CTCP 3/10s keyed `ident@host`; SlidingWindowCounter bounded; mod_log write-time scrubbing, action/source vocabulary enforcement, parameterized queries; `auditActor`/`tryAudit` convention; `.modlog` per-cell stripping and channel-scoped permission matrix.
- **Plugin isolation (§4, §6.1):** top-level API and every sub-object frozen; `PluginBotConfig` omits NickServ password and filesystem paths; outbound methods sanitize; permissions sub-API read-only; actor spoofing prevented; loader export/name validation with path-traversal guard; teardown continues on throw; `unbindAll` removes timers; full listener cleanup on unload; per-handler try/catch with `(pluginId, type:mask)` logging; no plugin reads `process.env`, uses `eval`, or imports runtime `src/` (except the help-plugin warning above).
- **Plugins:** ai-chat layered output sanitization (NFKC → protocol-unsafe strip → fantasy/prompt-leak drop), pre-spend rate limiting, fail-closed founder re-check, identity-bound game sessions; rss full SSRF defense (default-deny non-unicast, per-hop redirect re-validation, socket pinning, downgrade refusal, circuit breaker); spotify-radio URL allowlists + double-gated mutating commands + secret hygiene; flood hostmask-based rate keys (can't frame innocents), shape-validated ban masks, ban-before-kick ordering, persistent lockdown; seen 10k cap + sighting-oracle defense; ctcp echo cap + NOTICE replies; bounded state and teardown hygiene throughout.

---

## Recommendations

1. **Fix the three criticals before the next network deploy.** All share the pattern "primary control is solid, secondary path skips it" — the fixes route the secondary path through the existing control (chanmod → the auto-op gate; botlink → a hub-side authorization decision; REPL → redact sensitive args before all sinks).
2. **Standardize rate-limit keys on `ident@host`.** The flood limiter and DCC auth-tracker still embed the rotatable nick; the project already fixed this for CTCP and knows the pattern. Doing all three at once closes a consistent bypass class.
3. **Fail closed on unknown flag characters.** Validate at `bind()`/`registerCommand()`/`api.bind()` and make `requiresVerificationForFlags` fail closed — a single typo shouldn't silently disable the ACC gate.
4. **Turn on flood protection and fix the log-control gaps by default.** Default the flood limiter on, strip `dccFormatted` and `\x1b` in the logger — both are one-to-few-line changes that harden the out-of-the-box posture (§7).
5. **Reconcile the doc-accuracy notes** so the next audit starts from a clean baseline.
