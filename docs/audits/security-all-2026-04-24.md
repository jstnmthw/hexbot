# Security Audit: full codebase

**Date:** 2026-04-24
**Scope:** every `.ts` file under `src/` and `plugins/` (excluding `node_modules`, `tsup.config.ts`, and generated `.d.ts` files). Audit dispatched as 12 parallel agents, one per subsystem, each briefed with `docs/SECURITY.md` as baseline. Every finding below is a `- [ ]` checkbox so downstream skills (`/build`, `/refactor`, `/typecheck`) can tick it off when the fix lands.

## Summary

Hexbot's defensive foundation is strong: the dispatcher enforces `require_acc_for` before calling privileged handlers; the IRC bridge sanitizes every inbound field; the plugin API is frozen with hardcoded namespace scoping; mod_log uses parameterised statements and scrubs display fields; DCC authentication gates command dispatch on an explicit `awaiting_password` phase; botlink rate-limits CMD frames and runs exponential-backoff IP bans. Most of the severity density lives in three areas:

1. **Trust-on-first-use gaps** during services outages (ChanServ pin, auto-op `+o` conditional, STS downgrade over plaintext).
2. **Replay / injection footguns** in primitives (`sanitize()` UTF-16 LS gap, botlink HELLO fixed-salt replay, unsanitized memo-send and `.bsay` audit, BSAY fanout without hub re-check).
3. **Attribution gaps** — chanmod's entire mutation surface writes `mod_log` rows with `by = NULL` because `auditActor(ctx)` is never passed to `api.op/ban/kick`.

No finding is exploitable on the currently-deployed single-bot topology over a TLS + SASL EXTERNAL link; several become exploitable on WAN-exposed botlink, multi-tenant services outages, or operator misconfigurations that the code does not detect.

**Findings:** 4 critical · 64 warning · 60 info (128 actionable `[ ]` items).

### - [ ] Build progress (2026-04-24, /build pass)

Batches 2, 3, 4, 5 landed in one pass — 39 checkbox items ticked `[x]` below (2 of the 4 CRITICALs, the 4 downgraded CRITICAL/WARNINGs, and the majority of chanmod / plugin-API / defence-in-depth / plugin-polish WARNINGs and a handful of INFOs). Batch 1 (botlink handshake rewrite + BSAY fromHandle + per-frame rate limits + `listen.host` default + RELAY_REQUEST hub gate) is scoped into a dedicated plan at `docs/plans/botlink-handshake-v2.md` — implementation deferred to a follow-up /build on that plan.

**Follow-up refinement (2026-04-24, post-build):** the services-unavailable branch of `grantMode()` originally fell through to hostmask-only with no floor — raised during review as still-permissive on services-free networks. Tightened in three rounds:

1. Require `patternSpecificity(matchedHostmask) >= 100` on the services-unavailable path; lift IRCv3 `$a:` account-tag matching out of the services-available conditional (authoritative regardless of `services.type`); expose `api.util.patternSpecificity()` on the plugin API.
2. Extend the specificity floor to **every** grant path that isn't an `$a:` account-tag match — services-available + weak mask + identified is now refused too. Rationale: `verifyUser`/account-tag proves "someone legitimate holds this nick," but on a record with only weak masks the hostmask alone isn't strong enough to bind that identity to the record. Belt-and-suspenders with the `auditWeakHostmasks()` startup sweep. Records should pin either a strong hostmask (`alice!ident@stable.cloak`) or an account pattern (`$a:AliceAcct`) — weak masks are no longer eligible for auto-op regardless of services availability.
3. **`chanmod.services_host_pattern` made hard-required at config load.** Original Batch 2 fell back to warn-and-continue because ~96 test load sites didn't set the field — that's a test-fixture smell, not a production constraint. Centralised chanmod plugin-load overrides in `tests/helpers/chanmod-plugin-config.ts` (`makeChanmodPluginOverrides`, `makeChanmodConfig`) and migrated all 96 load/construct sites to the fixture, then flipped `readConfig()` to throw when the pattern is empty. Production gets the clean-cut enforcement; future required fields only touch the fixture.

Tests cover weak-refuse and specific-allow paths on auto-op, plus two regressions for the new `services_host_pattern` hard-fail. Post-refinement: 3855/3855.

### - [ ] Build progress (2026-04-25, hardening sweep)

A hardening sweep against the residual WARNING/INFO list landed in one pass — 46 additional checkboxes ticked `[x]` below across the primitives/utils layer, core dispatch + permissions, IRC runtime, core commands, botlink defensive, DCC, ai-chat attribution, RSS entity decode, and the smaller INFO items (regex anchors, pending-verify audit, GHOST ack race, reserved-namespace list, STS first-contact tls_verify gate, identify_before_join clamp + disconnect arm, DCC port/mirror tightening). Key behaviour changes worth calling out:

- `EventDispatcher.checkFlags` now fails closed when `permissions` is null — test harnesses that skipped wiring one up must attach `{ checkFlags: () => true }` (or similar) explicitly.
- The verification gate re-runs `permissions.checkFlags` with the confirmed account bound to `ctx.account`, so a weak hostmask record paired with "someone else's identified session" no longer passes.
- `auditActor(ctx)` now prefers `ctx.handle` (populated by `CommandHandler.execute` via a live `findByHostmask`) over `ctx.nick` so mod_log rows attribute actions to the stable handle.
- `.chpass <handle> <password>` rejects whitespace-carrying passwords in the explicit-target form — use `.chpass --self <password>` for self-rotation with spaces.
- `BanStore.reconcileChannelBans()` is exposed but not wired to RPL_BANLIST ingestion yet — the API is ready; a follow-up should call it from the chanmod ban-list probe.
- Botlink: `PROTECT_TAKEOVER`/`PROTECT_REGAIN` now NACK explicitly instead of silently dropping; leaf-side CMD cap (`botlink.leaf_cmd_rate_limit`, default 50/s) caps hub blast radius.

Remaining open checkboxes after this sweep: the four CRITICAL botlink rewrite items scoped into `docs/plans/botlink-handshake-v2.md` (Batch 1, dedicated plan doc); per-frame rate limits for BSAY/ANNOUNCE/RELAY\_\* (same plan); a handful of accepted-limitation INFOs (IPv4-only CIDR, `Math.random()` reconnect jitter, flood `isPrivileged` hostmask trust on non-account networks). Post-sweep: 3857/3857.

---

## Meta-review (2026-04-24, post-scan)

After the 12 parallel agents reported, I spot-checked each CRITICAL against the actual code at the cited lines. Four were downgraded to WARNING — they describe defensive gaps or caller-contract fragility, but do not meet the skill's bar of "Exploitable now. Fix before deploying." The finding bodies are unchanged; only the severity label and section placement moved.

- [x] **C1 `sanitize()` U+2028/2029** → WARNING. Not an IRC wire delimiter; log-injection risk is downstream and speculative. Non-string coercion is hardening.
- [x] **C2 `parseTargetMessage` unsanitized target** → WARNING. All current callers validate via `isValidCommandTarget`. Agent text itself said "one refactor away."
- [x] **C3 `.memo send` raw interpolation** → WARNING. `ctx.args` is bridge-sanitized before reaching memo; `nick` is regex-validated; irc-framework's `Message` class strips newlines on emission; command is `+m|+n` flag-gated. Triple-defense; defence-in-depth failure, not live escalation.
- [x] **C4 STS `duration=0` via plaintext** → merged into the existing WARNING (STS first-contact without `tls_verify` check). `enforceSTS()` returns `'upgrade'` or `'refuse'` when a policy exists and `tls=false`, so the `registered` handler never fires on plaintext; the true exploitable path is first-contact poisoning against `tls_verify=false`, which was already a WARNING.

CRITICALs that stand: botlink HELLO fixed-salt replay, BSAY hub re-check gap, ChanServ pin bootstrap race, auto-op `+o` conditional verification.

No WARNING was escalated — the warning list as written matches the skill's bar.

### Fix-lock decisions (user-confirmed 2026-04-24)

The four open shape decisions were locked to these answers and are load-bearing for downstream `/build`, `/refactor`, and `/plan` skills consuming this doc.

**Project posture:** early-dev, solo-dev. **Clean-cut replacement preferred over backward-compat shims** — no protocol versioning, no deprecated re-exports, no mixed-version migration windows. Delete old code in the same commit as the replacement. (See `feedback_clean_cut.md` in memory.)

- [ ] **Botlink HELLO → replace in place with HMAC challenge-response.** No `HELLO_V2` frame type; the existing `HELLO` frame gets rewritten. No backward-compat shim for old leaves — every leaf in the botnet updates together. Delete the fixed-salt `hashPassword()` helper; the new handshake uses `scryptSync(password, per-botnet-salt, 32)` as the HMAC key against a hub-issued 32-byte nonce. The `listen.host: 127.0.0.1` default + public-bind warning land in the same commit. **Needs a dedicated plan doc** (`docs/plans/botlink-handshake-v2.md`) before implementation.
- [x] **Auto-op `+o` gate → hard gate AND startup warning.** In `chanmod/auto-op.ts:grantMode`, unconditionally await ACC verification for `+o/+h/+v` grants regardless of `require_acc_for` (skip only when `ctx.account` already matches the record's `$a:` pattern). Separately, at startup log a `[security]` warning when auto-op is enabled but `require_acc_for` is missing the grant flag, so operators see the misconfig even though it's neutralised.
- [x] **`auditActor()` → expose on plugin API.** Add `api.auditActor(ctx)` returning `{by, source}`. Plugins pass it as the `actor` arg on `api.op/ban/kick/mode`. Update chanmod at every mutation call site in the same commit. Update `docs/PLUGIN_API.md` and CLAUDE.md's audit-logging convention.
- [x] **`botConfig` plugin view → remove `owner` block entirely.** Plugins have no legitimate need for owner handle/hostmask/password. Strip the whole sub-object from `PluginBotConfig` and from `PluginBotConfig` type in `src/types/plugin-api.ts`. Grep for `botConfig.owner` / `config.owner` in plugins; fix any reader (there should be none). Strip `tls_cert` / `tls_key` from `PluginIrcConfig` in the same commit.

---

## Critical findings

### - [x] [WARNING, was CRITICAL] `sanitize()` misses U+2028 / U+2029 and throws on non-string inputs

**File:** `src/utils/sanitize.ts:2-4`
**Category:** Primary injection defence (hardening)
**Description:** The function runs `text.replace(/[\r\n\0]/g, '')`. Because SECURITY.md §2.3 describes this as "the primary injection defence," every regression is load-bearing. Two gaps:

1. `text.replace` throws on numbers / null / undefined. Any bridge field that is not pre-coerced to string would crash the receive path.
2. Unicode line separators (U+2028, U+2029) and `\x85` are not stripped. Harmless on the IRC wire itself, but these bytes become line terminators in downstream contexts (JSON logs, DCC consoles rendered with certain terminal modes, REPL pretty-printers), so an attacker can wrap an apparent log row around an injected line in operator-facing views.

**Remediation:** Change to `String(text ?? '').replace(/[\r\n\0\x85]/g, '')`. Add a unit test covering numeric input, `null`, and each of the three Unicode separators.

### - [x] [WARNING, was CRITICAL] `parseTargetMessage` returns a `target` that may still contain `\r\n`

**File:** `src/utils/parse-args.ts:16-17`
**Category:** Injection, caller-contract fragility
**Description:** By design the parser does not treat `\r\n` as separators — the JSDoc expects every caller to either run `sanitize()` or `isValidCommandTarget()` on the result. Relying on caller discipline to avoid injection is exactly what SECURITY.md §2.3 warns against. Today's callers appear to validate, but a future caller that reads `.target` and passes it to `client.raw()` or a plugin-constructed string is one refactor away from CRLF injection.
**Remediation:** Strip `\r\n\0` from `target` inside the parser (`target = sanitize(target)`), and keep the existing validator as defence-in-depth. Update the JSDoc to state "target is returned already sanitized."

### - [x] [WARNING, was CRITICAL] `.memo send` builds the NickServ PRIVMSG from untrusted message text without `sanitize()`

**File:** `src/core/memo.ts:336-345`
**Category:** IRC protocol injection (defence-in-depth)
**Description:** `MemoIRCClient.say(memoserv_nick, \`SEND ${nick} ${message}\`)`interpolates the caller's message straight into a services command line.`MemoIRCClient`is the raw`irc-framework`client, not the plugin-API wrapper, so the bridge-level`sanitize()` does not apply. irc-framework does strip newlines internally, but SECURITY.md §2.3 explicitly refuses to rely on that as the only guard. An admin (`+m`) using `.memo send`is already trusted, so this is a defence-in-depth failure rather than a live escalation, but "nothing in the transport sanitizes" is exactly the failure shape that recurs once the code is copied elsewhere.
**Remediation:** Run`sanitize(message)`(and add a 400-byte length cap) before passing to`client.say()`. Validate `nick` with the same regex already used elsewhere in the module.

### - [x] [WARNING, was CRITICAL — merged with first-contact WARNING below] STS directive ingested over plaintext can clear a live TLS policy

**File:** `src/core/sts.ts:141-155`, `src/core/connection-lifecycle.ts:423`
**Category:** TLS downgrade, IRCv3 STS
**Description:** The originally-proposed attack (MITM-served plaintext session clearing a live policy via `duration=0`) is blocked in practice: `enforceSTS()` returns `'upgrade'` or `'refuse'` when a policy exists and `tls=false`, so the `registered` handler that calls `ingestSTSDirective()` never fires on plaintext. The exploitable path is first-contact poisoning against `tls_verify=false`, which is already tracked as a WARNING under Channel / IRC runtime. Keep the additional hardening below.
**Remediation:** Still worthwhile as defence-in-depth: in `ingestSTSDirective()`, short-circuit when `currentTls === false` and a policy already exists for the host, so that a future refactor of the enforcer can't reintroduce the path.

### - [ ] [CRITICAL] Botlink HELLO password hash uses a fixed salt — passive-capture replay from any non-banned IP

**File:** `src/core/botlink/protocol.ts:114-117`
**Category:** Botlink authentication
**Description:** `hashPassword` calls `scryptSync(password, 'hexbot-botlink-v1', 32)`. The salt is a compile-time constant; the wire-format hash is identical for every bot on every network. Anyone who captures a single HELLO (tcpdump on an unencrypted tunnel, one diff of a leaf's `.env`) can replay the `scrypt:<hex>` string as-is from any non-banned IP and assume full leaf identity — including enqueuing `ADDUSER`/`SETFLAGS`/`DELUSER` via the hub's permission-mutation paths. SECURITY.md §11 already acknowledges this and says "must not run the link over a network you do not control," but this is a foot-of-gun waiting on an operator misconfig (e.g., the `listen.host: 0.0.0.0` default, below).
**Remediation:** Move to a challenge-response handshake: hub sends a 32-byte random nonce, leaf returns `HMAC-SHA256(scryptSync(password, per-botnet-salt, 32), nonce)`. Phase it in with a versioned HELLO frame so old leaves negotiate the same mechanism. Track as a dedicated plan.

### - [ ] [CRITICAL] BSAY fanout re-executes on the hub without re-checking `+m`

**File:** `src/core/botlink/hub-bsay-router.ts:30-50`, `src/core/botlink/hub-frame-dispatch.ts:211-212`
**Category:** Botlink authorisation, TODO in code
**Description:** BSAY is hub-only (good — not blindly fanned out) but the hub handler dispatches to targets without reverifying the sender's flag. The source file contains a TODO at `hub-bsay-router.ts:35-40` that spells this out: "a compromised leaf can craft a raw BSAY frame and bypass that gate." Chained with the HELLO replay above, a single captured password yields "shout into any channel on any linked bot" amplification.
**Remediation:** Add `fromHandle` to the BSAY frame (requires protocol bump), validate it against the leaf's authenticated `ctx.botname`, and re-run `permissions.checkFlagsByHandle(fromHandle, 'm', channel)` on the hub before fan-out.

### - [x] [CRITICAL] ChanServ trust pin can latch onto an impostor during a services outage

**File:** `plugins/chanmod/chanserv-notice.ts:167`
**Category:** Chanmod identity
**Description:** The first NOTICE matching the configured ChanServ nick sets `trustedServicesSource = { ident, hostname }` permanently. If the bot starts while ChanServ is split, an attacker on the same network can grab the nick and be pinned. Subsequent FLAGS/ACCESS/INFO responses they craft promote the bot to `founder` in the backend's `accessLevels` map, unlocking `requestRecover` / `requestClearBans`.
**Remediation:** Require the first NOTICE to also match a configured services-host suffix (e.g., `services.*`, `*.libera.chat`) before latching. Expose the suffix as `services.services_host_pattern` with a sensible per-network default.

### - [x] [CRITICAL] Auto-op only awaits NickServ verification when `require_acc_for` lists the grant flag

**File:** `plugins/chanmod/auto-op.ts:53-89,172`
**Category:** Chanmod NickServ race
**Description:** The join handler binds with flags `-`, so the dispatcher's verification gate never fires. `grantMode()` then decides whether to call `verifyUser()` by checking `requireAccFor.includes(flagToApply)`. An operator who configures `require_acc_for: ["+n"]` (reasonable if they think `+o` auto-op is already gated) silently disables the ACC race guard for `+o` — auto-op proceeds on a hostmask match alone. A nick-squatter who targets an op in the seconds between connect and NickServ identify becomes opped.
**Remediation:** Inside `grantMode()`, refuse to ever grant `+o/+h/+v` without at least one of (a) IRCv3 `account-tag` match against the permission record's `$a:` pattern, or (b) a completed NickServ ACC/STATUS that returned `verified:true`. Make the gate unconditional, independent of `require_acc_for`.

---

## Warning findings

### Core dispatch / orchestration

- [x] [WARNING] **`wireDispatcher` silently ignores `require_acc_for` when `services.type === 'none'`** — `src/bot.ts:304`. Operators who configure `require_acc_for: ["+o","+n"]` but leave services off lose the gate with no log. Fix: fail startup or log a loud `[security]` warning when both are set.
- [x] [WARNING] **Verification gate confirms "identified to some account," not the expected one** — `src/dispatcher.ts:331-346`. `checkVerification()` discards the account returned by `verifyUser`; a weak `nick!*@*` record paired with any services-identified attacker still passes. Fix: pass `result.account` back into a second `findByHostmask(..., account)` pass and require the same record still matches.

### Database / config

- [x] [WARNING] **Plugin-facing `botConfig.irc` still exposes `tls_cert` / `tls_key`** — `src/plugin-api-factory.ts:201-206`, `src/types/plugin-api.ts:487-489`. The CertFP key path leaks to every plugin. Fix: narrow `PluginIrcConfig` to `Pick<IrcConfig, 'host'|'port'|'tls'|'nick'|'username'|'realname'> & { channels }`.
- [x] [WARNING] **Owner seed password forwarded to every plugin** — `src/plugin-api-factory.ts:207`. `owner: { ...botConfig.owner }` leaks the resolved `owner.password_env` seed before the hash is established. Fix: `owner: { handle, hostmask }` only.

### Permissions / identity

- [x] [WARNING] **NickServ NOTICE source trusted by nick alone** — `src/core/services.ts:440-451`. No check on sender ident/host. On non-services-reserved networks, a user can `/nick NickServ` and resolve pending `verifyUser()` calls with a crafted ACC reply. Fix: add `services.services_host` pattern and require the notice's hostmask to match.
- [x] [WARNING] **`nick!*@*` warning trivially bypassed** — `src/core/permissions.ts:558-568`. Only catches two literal spellings; `nick!?@*`, `nick!*@*.com`, `*!*@*` all slip through. Fix: use the existing `patternSpecificity()` score with a threshold.
- [x] [WARNING] **`auditActor()` trusts `ctx.nick` as the actor identity** — `src/core/audit.ts:44-46`. Should prefer the resolved `UserRecord.handle`. Fix: thread the resolved handle through `CommandContext` and fall back to `ctx.nick` only when none resolves.
- [x] [WARNING] **`syncUser()` from botlink bypasses the insecure-hostmask warning** — `src/core/permissions.ts:174-189`. A hub push installs weak patterns silently. Fix: call `warnInsecureHostmask()` inside `syncUser` for each hostmask in the sync payload.
- [x] [WARNING] **`isValidPasswordFormat` guarantees length — comment is load-bearing** — `src/core/password.ts:93-103`. A future refactor that drops the length check would make `timingSafeEqual` throw on mismatch and leak timing via exception vs boolean. Fix: add an explicit `if (actual.length !== expected.length) return {ok:false, reason:'mismatch'}`.

### Channel / IRC runtime

- [x] [WARNING] **Kick/topic reasons not byte-capped** — `src/core/irc-commands.ts:154-158, 205-212`. A long reason pushes the KICK line past 512 bytes and the server drops it silently; `mod_log` still records the kick. Fix: cap `reason` at ~250 bytes before `raw()`.
- [x] [WARNING] **`IRCCommands.mode()` param expansion** — `src/core/irc-commands.ts:245-302`. A param containing a space lets a caller turn one op into two via `MODE #c +o alice bob`. Fix: reject spaces / `,` / leading `:` in mode params at the batcher.
- [x] [WARNING] **`memoserv_nick` not validated at config time** — `src/core/memo.ts:218,301-351`. A typo like `memoserv_nick: "#channel"` leaks READ commands to the channel; an operator setting it to a real user's nick routes their notices as admin spam. Fix: validate bare-nick shape at config-resolve time.
- [x] [WARNING] **INVITE re-join handler uses static `rfc1459` casemapping** — `src/core/connection-lifecycle.ts:584`. Should use live casemapping. Fix: pass `bot.casemapping` through.
- [x] [WARNING] **Ban-store has no reconciliation against `RPL_BANLIST`** — `src/core/ban-store.ts:104-129`. External unbans leave stale records that a sync step could reapply. Fix: periodic reconciliation after join/mode-init.
- [x] [WARNING] **`ChannelSettings.set()` writes no audit row** — `src/core/channel-settings.ts:118-125`. Plugin-level mutations bypass `mod_log`. Fix: audit from inside `set()` (or forbid plugin-side `.set` without an actor argument).
- [x] [WARNING] **`MessageQueue` has no per-sender/per-target quota** — `src/core/message-queue.ts:125-145`. Global `MAX_DEPTH=500` lets one plugin starve others. Fix: per-target depth cap (e.g., 50).
- [x] [WARNING] **`channel-state` `onAway`/`onUserUpdated` write unsanitized values** — `src/core/channel-state.ts:641-670`. `chghost` events from irc-framework bypass the bridge sanitize. Fix: `sanitize()` the write site as defence-in-depth.
- [x] [WARNING] **`identify_before_join_timeout_ms` is trusted unbounded** — `src/core/connection-lifecycle.ts:265-273`. No `disconnect` arm on the race. Fix: clamp to ≤ 60 s; include `bot:disconnected` in the race.
- [x] [WARNING] **STS directive ingested without `tls_verify` check on first contact** — `src/core/connection-lifecycle.ts:426`. An operator who ships `tls_verify=false` lets a MITM-served CAP LS pin a fake STS policy. Fix: only accept first-contact STS when `tls_verify=true`.

### Core commands

- [x] [WARNING] **`.chpass` self-rotation collapses whitespace** — `src/core/commands/password-commands.ts:200-205`. A caller running `.chpass myhandle hunter2 extra` silently sets password to "hunter2 extra" or interprets the first token as a different target handle. Fix: require explicit `--self` sentinel.
- [x] [WARNING] **`.adduser` reply does not strip formatting from echoed hostmask** — `src/core/commands/permission-commands.ts:67`. Colour codes in the mask are rendered back. Fix: wrap the reply's `hostmask`/`flags` in `stripFormatting()`.
- [x] [WARNING] **`.invite` channel validator too loose** — `src/core/commands/irc-commands-admin.ts:191-202`. Defence-in-depth regex from SECURITY.md §2.2 not applied. Fix: add `/^[#&]?\w[\w\-\[\]\\\`^{}]{0,49}$/`.
- [x] [WARNING] **`.bsay` audit metadata not stripped** — `src/core/commands/botlink-commands.ts:617-621`. Inconsistent with `.say`/`.msg` which do strip. Fix: `stripFormatting(message)` before `tryAudit`.
- [x] [WARNING] **`.bannounce` message unsanitized on the wire and in audit** — `src/core/commands/botlink-commands.ts:677-695`. Fix: `sanitize(message)` for the wire path, `stripFormatting(message)` for the mod_log copy.
- [x] [WARNING] **`.console` cross-handle gate reads stale session snapshot** — `src/core/commands/dcc-console-commands.ts:162-165`. A `+n` revoked mid-session still passes. Fix: re-resolve via `permissions.findByHostmask(...)` at the time of the mutation.

### Botlink

- [ ] [WARNING] **`RELAY_REQUEST` / `RELAY_INPUT` bypass the `hasRemoteSession` gate** — `src/core/botlink/relay-router.ts:215-228`, `src/core/botlink/relay-handler.ts:76-100`. A compromised leaf can open a relay under any valid handle's name. Fix: require the originating leaf to prove a live DCC party session for the handle (mirror `hub-cmd-relay.ts:62-71`).
- [ ] [WARNING] **`listen.host` default is `0.0.0.0`** — `src/core/botlink/hub.ts:131-134`, `config/bot.example.json`, `config/examples/multi-bot/libera/hub.json`. Combined with the fixed-salt replay, the example config exposes a replay-auth hub to every interface. Fix: default `listen.host` to `127.0.0.1`; log a loud warning if the resolved bind is non-loopback and non-RFC1918.
- [x] [WARNING] **`PROTECT_TAKEOVER` / `PROTECT_REGAIN` have no handlers** — `src/core/botlink/protocol.ts:93-94` lists them but `protect.ts:81-142` has no cases. Safe today (no-op), dangerous when a future implementer forgets `isRecognized()`. Fix: either delete the types or add explicit "not implemented" handlers with the same nick-existence check the OP/INVITE cases use.
- [ ] [WARNING] **Unbounded rate limits on `BSAY`, `ANNOUNCE`, `RELAY_INPUT`, `RELAY_OUTPUT`, `PARTY_JOIN`/`PART`** — `src/core/botlink/hub-frame-dispatch.ts:195-208`. A compromised leaf can flood any of these. Fix: add per-frame-type rate buckets consistent with the existing CMD/PARTY*CHAT/PROTECT*\* buckets.
- [x] [WARNING] **Leaves accept unlimited CMD frames from hub** — `src/core/botlink/leaf.ts:366-411`. A compromised hub gets unbounded command execution on every leaf. Acceptable under the documented trust model; worth an explicit CPU ceiling nonetheless. Fix: add a soft per-second CMD cap on the leaf side, configurable, defaulting to 50/s.

### DCC

DCC had no warnings — see "Passed checks" below.

### Utils

- [x] [WARNING] **`parseDuration` does not support multi-unit durations** — `src/utils/duration.ts:31-36`. `"1h30m"` returns `null`. Not a bug, just an operator footgun. Fix: document in the JSDoc (or extend the regex).
- [x] [WARNING] **`buildSocksOptions` accepts asymmetric credentials / no `remoteDns:true`** — `src/utils/socks.ts:15-22`. Sends only `user` when password is missing; does not force remote DNS, so a leaky default in irc-framework could resolve hostnames locally. Fix: require both-or-neither; force `remoteDns: true` in the returned options.
- [x] [WARNING] **`formatTable` does not strip control chars** — `src/utils/table.ts:46`. Cells propagate ANSI / IRC formatting into terminal / REPL output. Fix: strip `\x00-\x1f\x7f` inside the formatter, or require callers to pre-sanitize.
- [x] [WARNING] **`parseHostmask` partial fallback** — `src/utils/irc-event.ts:48-58`. On `@host` (no `!`) returns `{ ident:'', hostname:'host' }`, which a caller could turn into `*!*@host`. Fix: return `{ident:'',hostname:''}` uniformly when the shape is wrong.
- [x] [WARNING] **`wildcardMatch` has no length cap on pattern or text** — `src/utils/wildcard.ts:59-103`. Worst-case O(n·m); no algorithmic DoS, but a plugin storing a large pattern can waste CPU. Fix: cap input sizes (e.g., pattern ≤ 512 bytes, text ≤ 4 KB).
- [x] [WARNING] **`splitMessage` scans untrimmed input before truncation** — `src/utils/split-message.ts:65`. `Buffer.byteLength` runs on the full string; a plugin-supplied 100 MB string still incurs an O(n) byte scan. Fix: add a hard entry cap (`text.length > 10 MB → drop and log`).
- [x] [WARNING] **`verify-flags.ts` treats unknown flags as level 0** — `src/utils/verify-flags.ts:50-55`. Fail-open shape (returns false → no verification), but paired with the flag-check path also rejecting unknown flags → net reject. Fragile. Fix: document; add a JSDoc sentence stating the invariant.

### Chanmod

- [x] [WARNING] **`invite.ts:46` passes channel without shape validation** — plausible today because the bridge sanitizes, but defence-in-depth regex missing. Fix: reject channels failing `/^[#&]\S+$/`.
- [x] [WARNING] **`commands.ts`, `ban-commands.ts` never pass `auditActor(ctx)` to `api.op`/`api.ban`/`api.kick`** — every chanmod `mod_log` row has `by = NULL`. Fix: expose `auditActor` on the plugin API (or let plugins construct `{ by, source }` directly) and thread it through every mutation call site.
- [x] [WARNING] **No `stripFormatting` on user-controlled nicks in `api.log` output** — `auto-op.ts:97`, `mode-enforce-user.ts:63`, `mode-enforce-recovery.ts:293`, `commands.ts:63`, `ban-commands.ts:106`. Nicks with colour / reverse codes reshape log rows. Fix: wrap all user-controlled identifiers in `api.stripFormatting()`.
- [x] [WARNING] **`.ban` duration parse is ambiguous with the last positional arg** — `plugins/chanmod/ban-commands.ts:60-64`. Low impact but documented footgun. Fix: require explicit `-t <duration>` flag, or warn when the tail looks numeric.
- [x] [WARNING] **`.ban` accepts overbroad masks like `*!*@*`** — `plugins/chanmod/ban-commands.ts:71`. No warning on whole-network bans. Fix: warn and require a `--force` confirmation when `patternSpecificity(mask)` is below a threshold.
- [x] [WARNING] **`performHostileResponse` has no cap on hostile actor count** — `plugins/chanmod/mode-enforce-recovery.ts:261-265`. A large chaotic burst produces a same-tick kick+ban flood that can trip the bot's own send-rate limiter and cause a net-wide flood disconnect. Fix: cap `hostileActors.size` to ~5 per recovery round; spill the remainder to a delayed second pass.

### Plugin ai-chat

- [x] [WARNING] **History attribution uses raw `e.nick`** — `plugins/ai-chat/context-manager.ts:175`. The volatile-header speaker filter is not applied to historical entries. IRC server rules make this safe in practice, but the filter is applied inconsistently. Fix: use the same `safeSpeaker` regex on history entries.
- [x] [WARNING] **Coalescer 8 KB cap vs 2000-char prompt cap mismatch** — `plugins/ai-chat/message-coalescer.ts:85-88`. Large bursts silently lose ~6 K of content. Fix: align the coalescer cap to `cfg.input.maxPromptChars` (bytes-aware).
- [x] [WARNING] **Session pipeline `[nick]` attribution uses unfiltered `ctx.nick`** — `plugins/ai-chat/pipeline.ts:478`. Intentional per comment, but inconsistent with the chat path's `safeSpeaker`. Fix: pass session speakers through `safeSpeaker` too.

### Plugin flood + rss

- [x] [WARNING] **RSS redirect handling lacks visited-origin / cross-host policy** — `plugins/rss/feed-fetcher.ts:134-149`. `for (let r=0; r<=MAX_REDIRECTS; r++)` also allows 6 iterations instead of 5. Fix: add a `visited:Set` check; cap loop at `< MAX_REDIRECTS`; refuse `https:→http:` downgrade on redirect even when `allow_http=true`.
- [x] [WARNING] **RSS content-type allowlist too permissive** — `plugins/rss/feed-fetcher.ts:248-253`. `text` substring matches `text/html`, `text/plain`. Missing Content-Type passes entirely (`contentType && …`). Fix: tighten to an explicit list; reject missing CT.
- [x] [WARNING] **RSS audit / notice paths skip `stripFormatting` on URL** — `plugins/rss/commands.ts:227-232, 99-103`. `new URL()` tolerates some control bytes in path/fragment. Fix: strip before persisting; wrap notices in `api.stripFormatting()`.
- [x] [WARNING] **RSS `stripHtmlTags` does not decode entities before stripping** — `plugins/rss/feed-formatter.ts:9-31`. Informational only (IRC-format injection via entities not exploitable), but confusing behaviour. Fix: decode first, then strip.
- [x] [WARNING] **Flood `buildFloodBanMask` allows `[`, `]`, `/` in host** — `plugins/flood/enforcement-executor.ts:377`. IPv6-wrapped literals produce masks that never match; long cloaks with no length cap. Fix: add max-length cap (~256 chars); strip bracket wrappers for IPv6.
- [x] [WARNING] **Flood `handleNickFlood` iterates only startup channels** — `plugins/flood/index.ts:248`. Dynamically-joined channels get no nick-flood enforcement. Fix: iterate the bot's current channel set from `channel-state`.
- [ ] [WARNING] **Flood `isPrivileged` trusts hostmask alone on non-account-tag networks** — `plugins/flood/index.ts:128-141`. Inherited from the permission model (documented), but weak-pattern users can evade flood enforcement. Accept the limitation; document in the plugin README.

### Small plugins

- [x] [WARNING] **seen — cross-channel sighting oracle** — `plugins/seen/index.ts:64-133`. The `pubm *` bind stores every sighting globally, and the reply reveals sightings even from channels the querier doesn't share. Private-channel membership leaks. Fix: only report sightings from channels the querier currently shares with the bot.
- [x] [WARNING] **seen — 200-char slice corrupts surrogate pairs** — `plugins/seen/index.ts:66`. Fix: slice by code point (`Array.from`).
- [x] [WARNING] **seen — querier's own `!seen foo` line is immediately recorded** — records the user asking about whom. Fix: filter outbound-queries by bot-trigger prefix.
- [x] [WARNING] **topic — length warning uses `.length` (UTF-16), not bytes** — `plugins/topic/index.ts:103,180,183`. Topics with multibyte chars silently truncate server-side. Fix: `Buffer.byteLength(str, 'utf8')`, honour ISUPPORT `TOPICLEN`.
- [x] [WARNING] **topic — restore loop attempts even when bot is unopped** — `plugins/topic/index.ts:248-250`. Burns message-queue budget. Fix: skip restore when the bot lacks `+o` on the channel.
- [x] [WARNING] **topic — `String.replace('$text', …)` back-ref exposure on `preview`** — `plugins/topic/index.ts:217`. `sampleText` may contain `$&` / `$n`. Fix: escape `$` before substitution, or pass the function form of `replace`.
- [x] [WARNING] **help — cooldown keyed on nick, not `ident@host`** — `plugins/help/index.ts:129,142`. Nick-rotation bypasses the cooldown. Fix: key on `ident@host`.

---

## Info findings

### Core dispatch

- [x] [INFO] Plugin-facing `botConfig` sub-objects (`irc`, `owner`, `identity`, `services`, `logging`, `chanmod`) are not individually `Object.freeze()`-d, contrary to SECURITY.md §4.1. They are spread copies per-plugin, so mutation doesn't leak across — but the documented guarantee is stronger than the implementation.
- [x] [INFO] No startup sweep for weak hostmask patterns (`permissions.auditWeakHostmasks()`). SECURITY.md §3.1 expects a `[security]` warning; only `.adduser`/`.addhostmask` paths warn today.
- [x] [INFO] `EventDispatcher.checkFlags` returns `true` when `permissions` is null (`src/dispatcher.ts:443-444`). Production always supplies one; a future test harness is the only risk. Consider flipping to fail-closed.
- [x] [INFO] `CommandHandler.checkCommandPermissions` bypasses flag checks for `source: 'botlink'`. Correct under the hub-authoritative model; add a comment upgrade pointing at the specific authenticator so future maintainers don't relax it further.

### Database / config

- [x] [INFO] World-readable check covers `config/bot.json` but not `.env*` — `src/bot.ts:962-974`. Fix: extend to `.env`, `.env.local`, `.env.<NODE_ENV>`; treat group-readable (`0o040`) as at least a warning.
- [x] [INFO] `nick_recovery_password` not covered by `validateResolvedSecrets`. Intentional — chanmod validates at load — but the symmetry break is non-obvious.
- [x] [INFO] LIKE escape order in `database.ts:320-329` is correct but fragile; extract `escapeLikePattern()` helper with unit tests. `mod-log.ts:494` duplicates the same escape.
- [x] [INFO] Reserved DB namespaces (`_bans`, `_sts`, `_permissions`) are protected only by `SAFE_NAME_RE` on plugin names. Add an explicit reserved-prefix list.
- [x] [INFO] `BotDatabase.rawHandleForTests()` has no `NODE_ENV=test` guard (`src/database.ts:205-208`). Guard it.

### Permissions / identity

- [x] [INFO] Pending-verify cap rejection is silent — `src/core/services.ts:312-319`. No `mod_log` row. Fix: emit a `nickserv-verify-cap` row.
- [x] [INFO] `ghostAndReclaim` 1500 ms sleep is best-effort — `src/core/services.ts:615-623`. Fix: listen for GHOST ack and proceed on signal with the sleep as upper bound.
- [x] [INFO] `tryParseAccResponse`/`tryParseStatusResponse` accept trailing text — `src/core/services-parser.ts:22-33`. Anchor with `(?:\s|$)` or `$`.
- [x] [INFO] `$a:` matcher uses RFC1459 casemapping — correct, but account names aren't nicks. Document in SECURITY.md §3.1.

### Channel / IRC runtime

- [ ] [INFO] Reconnect driver uses `Math.random()` for jitter (`src/core/reconnect-driver.ts:118`). Acceptable (not crypto-sensitive).
- [ ] [INFO] Reconnect fatal-exit confirmed for SASL 904/908 and the four TLS cert classes.
- [ ] [INFO] Flood limiter owner bypass correctly uses live `permissions.checkFlags('n', ctx)`; deidentify-in-session recovers automatically.
- [ ] [INFO] Memo delivery cooldown keyed on handle (not nick) — correct.
- [ ] [INFO] STS expiry correctly clamps on read, ports validated 1-65535 on load.

### Core commands

- [ ] [INFO] `.modlog show` cross-row access check blocks masters from rows with no channel — correct fail-closed.
- [x] [INFO] `.audit-tail` REPL output skips `stripFormatting` in `renderRow`. REPL-only, so attacker value is limited to terminal colour injection. Fix for symmetry with `.modlog show`.
- [x] [INFO] `.botlink ban` is IPv4-only. Documented limitation.
- [x] [INFO] `.bans` prints shared-ban entries without `stripFormatting`. Sanitized at the botlink frame boundary; add `stripFormatting` for defence-in-depth.

### Botlink

- [ ] [INFO] CIDR whitelist is IPv4-only — IPv6 leaves can never be whitelisted. Document in BOTLINK.md.
- [ ] [INFO] Manual permanent bans use `Number.MAX_SAFE_INTEGER` sentinel — correct handling throughout.
- [ ] [INFO] Ban-doubling math (`baseBanMs * 2 ** banCount`) — bounded by `BAN_COUNT_MAX=8` and `maxBanMs`. No overflow path.
- [ ] [INFO] `RateCounter` filter-on-every-check — fine given single-threaded Node + bounded timestamp arrays.
- [ ] [INFO] `LRUMap` at 10k tracker entries — distributed scanner can evict stale-but-hot entries; acceptable (worst-case: reset of a long-quiet offender's `banCount`).

### DCC

- [x] [INFO] Port/IP range validation in `parseDccChatPayload` (`src/core/dcc/protocol.ts:63-69`) is lenient — no exploit because passive mode requires `port===0`. Tighten to `Number.isInteger(port) && port >= 0 && port <= 65535` for clarity.
- [x] [INFO] `ipToDecimal` silently returns 0 on malformed IPs — operator misconfig only. Add a config-load validator.
- [x] [INFO] `onDccCtcp` logs `ctx.args` verbatim at debug — bridge strips `\r\n\0` so no injection, but IRC-format codes survive. Apply `stripFormatting`.
- [x] [INFO] IRC mirror has no rate-limit on the mirror path itself — bounded by upstream rate limiters and by the IRC message queue; still worth adding a DCC-side cap.

### Utils

- [ ] [INFO] `sliding-window` uses `Date.now()` (wall clock). NTP slew / manual time set can nudge windows. Acceptable for flood limiting; `DCCAuthTracker` lockout would also drift slightly.
- [ ] [INFO] `listener-group` per-entry try/catch correct; `size` accessor reliable.
- [ ] [INFO] `strip-formatting` regex is spec-compliant; no ReDoS — each alternation branch starts with a distinct literal control byte.
- [ ] [INFO] `irc-event.ts` type guards admit `param: 123` — document that callers must not treat `param` as a string without re-check.

### Chanmod

- [ ] [INFO] Mode-enforce loops bounded by `enforcementCooldown` (MAX_ENFORCEMENTS=3 / 10 s).
- [ ] [INFO] `buildBanMask` returns null on malformed input; callers check it.
- [ ] [INFO] `auto-op.ts:239-243` catches `grantMode` rejections to protect sibling joins.

### Plugin ai-chat

- [ ] [INFO] No user-controlled path to Ollama `base_url`. SSRF guard removal confirmed consistent.
- [ ] [INFO] Gemini API key redaction (`redactGeminiKey`) applied on every error emission path.
- [ ] [INFO] Character loader: regex + size cap + symlink reject.
- [ ] [INFO] Games loader: same defences.
- [ ] [INFO] Output formatter strips all IRC format codes + invisible Unicode formatters; fantasy-prefix drop runs after character-style transform.
- [ ] [INFO] Sender uses `ctx.reply` / `api.say` — no `raw()` anywhere.
- [ ] [INFO] SAFETY_CLAUSE wired on every pipeline (chat + ambient + session) per memory.
- [ ] [INFO] Per-user/global rate limits + non-queueing concurrency semaphore.
- [ ] [INFO] Permission gates enforced at every entry point; post-gate founder check re-runs per line.
- [ ] [INFO] All in-memory collections bounded with eviction.
- [ ] [INFO] Reply-loop defences in place (bot-nick skip, `lastWasBot` suppression).
- [ ] [INFO] Ambient honours `cfg.ambient.enabled`; teardown aborts in-flight calls.
- [ ] [INFO] No `process.env` reads in the plugin tree; config goes through `api.config`.
- [ ] [INFO] `stripFormatting()` applied on 6 user-facing reply call sites.

### Plugin flood + rss

- [ ] [INFO] RSS `rss:feed:<id>` stored as-is; revalidation happens on fetch (correct).
- [ ] [INFO] RSS circuit-breaker state keyed by internal id only.
- [ ] [INFO] Flood enforcement nick->`api.kick` not additionally stripped — bridge handles `\r\n\0`; IRC nicks can't contain control chars per server rules.
- [ ] [INFO] Lockdown doesn't explicitly exempt operators — `+R` requires services identification (admins should have it); `+i` forces `.invite` for absent operators. Intentional.

### Small plugins

- [ ] [INFO] 8ball has no per-user cooldown — relies on dispatcher flood protection.
- [ ] [INFO] ctcp respects bridge-level CTCP rate limit; safe response strings; reads `package.json` from CWD (no env-var leak).
- [ ] [INFO] help does not leak privileged-command existence (symmetric "no help for X" response).
- [ ] [INFO] help case-insensitive command lookup confirmed.

---

## Passed checks (summary by group)

### Core dispatch / orchestration

- Bridge strips `\r\n\0` from every inbound field via `sanitizeField()` before the dispatcher runs.
- Command word passes through `stripFormatting()` before dispatch — `\x03`-disguised commands can't escape.
- Dispatcher ordering invariant: flag check → verification gate → handler call, with per-handler try/catch.
- Timer binds floor at 10 s, auto-disable after 10 consecutive failures.
- `unbind`/`unbindAll` clear associated `setInterval`s.
- Flood check runs once per IRC message, before paired pub/pubm or msg/msgm dispatch.
- CTCP rate limit keyed on `ident@host`, not nick.
- Plugin loader rejects path-traversal names and canonicalises resolved paths against `absPluginDir`.
- Plugin init / teardown wrapped in try/catch; timer/resource cleanup runs on load failure.
- Plugin API frozen + every method wrapped in a `disposedCell` guard.
- `nick_recovery_password` stripped for every plugin except chanmod; SASL/NickServ password omitted from `pluginBotConfig.services`.
- `PluginDB` hardcodes `pluginId` as namespace.
- Outbound `say`/`notice`/`action`/`ctcpResponse` sanitize and route through `MessageQueue`.
- REPL has no network listener; every line audited.
- Logger redacts credential fields (`password`, `sasl_password`, `token`, `secret`, `api_key`, etc.).
- Uncaught exceptions / unhandled rejections trigger rate-limited `fatalExit` → `shutdownWithTimeout`.
- `tls_verify=false` emits a prominent MITM warning at startup.
- `EventBus.trackListener` / `removeByOwner` drain listeners by owner on teardown.

### Database / config

- All queries parameterised (KV + mod_log). Dynamic `IN (?,?,...)` build still binds via `params`.
- Plugin DB namespace isolation enforced at API-creation time (not convention).
- Env-var resolver never logs values; resolved `_env` keys dropped from the object.
- All documented `_env` suffixes covered; `validateResolvedSecrets` runs after resolve.
- SASL-PLAIN-without-TLS refusal implemented.
- `config/bot.json` world-readable refusal implemented.
- Zod schemas strict-object throughout; compile-time schema/interface drift check.
- mod_log migration transactional; `scrubModLogField` on every display-bound field; 8 KiB metadata cap with `truncated:true`.
- Retention prune uses `LIMIT 10000` batches.
- SQLITE_FULL → fail-closed KV writes; SQLITE_CORRUPT/NOTADB/IOERR → `process.exit(2)`.
- Channel keys / `nick_recovery_password` stripped from plugin view (except chanmod itself).

### Permissions / identity

- `wildcardMatch` fully anchored — `*` cannot escape boundary.
- Specificity scoring: `findByHostmask` returns highest-scoring match; account bonus beats any hostmask.
- `$a:` silently skips when no account known.
- `$a:*` excluded from insecure-hostmask warning.
- `checkFlags` fail-closed on unknown user; `-` and `''` short-circuit before lookup.
- Owner flag (`n`) implies all others; channel-local `n` also applied.
- Password: scrypt N=16384/r=8/p=1, 16-byte random salt, `scrypt$` prefix, `timingSafeEqual`; never logged.
- Owner bootstrap idempotent; only configured owner gets `+n`.
- NickServ verify deduplicates concurrent callers on same nick.
- Fail-closed on verify timeout + pending cap; bot-identify state tracked separately.
- mod_log inputs scrubbed; 8 KiB metadata cap; `plugin`/`source` cross-validated.
- Permissions persistence transactional; `isUserRecord` runtime validation on load.

### Channel / IRC runtime

- `IRCCommands.kick/ban/op/deop/voice/quiet/invite/topic/mode` all sanitize inputs; no unsanitized `raw()`.
- `MODES` batching respects ISUPPORT with per-direction segmentation.
- Channel/nick storage case-insensitive via injected `ircLower`.
- `clearNetworkAccounts()` on reconnect prevents stale identity data.
- SASL/TLS fatal classes → `process.exit(2)`.
- `AdminListStore.list()` skips corrupt rows.
- `BanStore.migrateFromPluginNamespace()` runtime-validates records.
- `RelayOrchestrator.handleIncomingFrame` strips formatting on party-line fields from leaves.
- ISUPPORT bounds enforced: `MODES_HARD_CEILING=100`, `TARGMAX_HARD_CEILING=10000`.

### Core commands

- `.load`/`.unload`/`.reload` plugin names regex-validated + canonical-path checked against `pluginDir`.
- `.chpass` refuses IRC/botlink transport; minimum length 8; no plaintext or hash in audit.
- `.adduser`/`.addhostmask`/`.flags` warn on `nick!*@*` for elevated users.
- `.deluser` last-owner guard.
- Every mutating command uses `tryAudit(db, ctx, …)` / `auditActor()`; no hand-rolled `{ by, source }` found.
- `.binds`/`.users` output `stripFormatting`-wrapped.
- `.chanset` value sanitized + type-checked + allowed-values enum.
- `.ban` mask capped at 200 chars.
- `.say`/`.msg` target validated + message sanitized + metadata stripped.
- Botlink permission gating: hub-only admin actions require `+m` + `requireHub()`; `.chpass` relay hard-blocked.
- `.modlog` refuses IRC source; channel-scoped filters honoured on both query and show.

### Botlink

- Password never plaintext; leaf always `hashPassword()`.
- Constant-time hash compare with length pre-check; hub pre-computes expected hash once.
- Per-IP exponential backoff 5 m→24 h cap; BAN_COUNT_MAX=8 safeguard.
- Ban-count decay (1 half-step/hour) prevents shared-NAT permanent escalation.
- Handshake timeout + per-IP pending-handshake cap enforced before protocol allocation.
- Banned IPs rejected before `BotLinkProtocol` allocation (zero-cost rejection).
- `sanitizeFrame` depth-capped at 16 recursion levels; 64 KB cap inbound+outbound.
- `HUB_ONLY_FRAMES` excluded from fanout; broadcast excludes sender; per-leaf send error containment.
- Leaf botname spoof prevention: `fromBot` rewritten to authenticated name.
- CMD frames gated by `checkFlagsByHandle` AND `hasRemoteSession` at the hub.
- CMD 10/s, PARTY*CHAT 5/s, PROTECT*\* 20/s per leaf.
- `PROTECT_OP/INVITE` require `isRecognized()`; `PROTECT_UNBAN` rejects `*!*@*` and wildcard-only masks.
- Relay session re-checks `getUser(handle)` on every RELAY_INPUT; deleted handle → RELAY_END.
- TTL sweeps for protect/cmd/relay/party routes; bounded caps everywhere.
- `AUTH_FAILED` does NOT trigger reconnect — prevents hash-replay loops against locked accounts.
- Permission-mutation frames hub-only; fanout blocked for `ADDUSER`/`SETFLAGS`/`DELUSER`.
- Ban mask validator rejects `*!*@*`; autoban + manual ban/unban audited with IP + tier.

### DCC

- Authentication gate airtight: `awaiting_password` routes every line to `handlePasswordLine`; command dispatch, party-line fan-out, and DCC-only commands gated on `phase === 'active'`.
- Log sink short-circuits for `awaiting_password`.
- Password never logged; failure metadata is `{peer, failures}` only.
- Pre-auth TCP writes are all constant / bot-side-controlled strings.
- Lockout key is `nick!ident@host` — attackers can't burn a target's handle via lockout.
- Exponential-backoff math: `2**8 * 300_000 ms ≈ 21 h`, bounded by `maxLockMs = 86_400_000`.
- Lockout resets on success; `maxEntries` eviction prevents churn OOM.
- 30 s pending timer always closes listener; single-accept `once('connection')`.
- Missing-password handle rejected at connect with migration notice.
- Flags checked before CTCP offer is sent.
- Session limits enforced (`max_sessions`, per-nick cap with stale eviction).
- `teardownSession` clears all timers, readline, map entry, party-part, pager/audit-tail.
- Line-length guard (4096 B) and blank-prompt cap (3) close buffer-DoS paths.
- Sessions close on password rotation / user removal.
- Cross-handle `.console` mutation requires `+n`.
- IRC mirror sanitizes nick + message; NickServ-internal chatter filtered.
- Login summary scopes `mod_log` queries to the authenticated handle.

### Utils

- `wildcardMatch` is DP (no ReDoS); full-string anchored by state machine.
- `parseDuration` clamps at `MAX_DURATION_MS` (1 year); negatives rejected.
- `splitMessage` measures UTF-8 byte length, iterates by code point, preserves surrogate pairs, caps at 4 lines.
- `SlidingWindowCounter` bounded at 8192 keys with opportunistic eviction + FIFO fallback.
- `ListenerGroup` refuses emitters lacking `off`/`removeListener`; per-entry try/catch.
- `splitN` refuses > 8192 bytes; keeps `\r\n` in target for validator to reject.
- `isValidCommandTarget` rejects whitespace / control chars.
- `strip-formatting` covers all mainline IRC codes including hex-colour parameters.
- `validateRequireAccFor` drops unknown flags with a loud log line.
- `ircLower` applies correct strict-rfc1459 vs rfc1459 folding.

### Plugin chanmod

- Dispatcher verification gate wired via `+n|+m|+o` on invite bind.
- ChanServ source-of-notice pin (modulo bootstrap race above).
- Auto-op respects IRCv3 account-tag fast path; refuses grant when `ctx.account===null`.
- `grantMode` awaits NickServ `verifyUser` when account-tag unknown and services available.
- Deidentify revocation path strips `+o/+h/+v`.
- Takeover escalation only on upward level transitions.
- Join-recovery has per-channel exponential backoff (30 s → 5 m cap).
- Ban mask shape-validated; nick validated before kick/mode.
- Channel key restore has explicit wipe guard.
- Rejoin rate-limited via persisted DB record.
- `ChanServBackendBase.requestAkick` rejects whitespace in mask, caps reason.
- Only type-only imports from `src/`.
- `teardown()` clears probe state, shared state, backend callbacks.
- Sticky ban re-apply is cooldown-saturated.
- Topic recovery snapshot frozen at elevated threat.
- `performMassReop` batches mode changes.

### Plugin ai-chat

- No direct `process.env` reads.
- No `raw()` IRC calls — all output through `api.say` / `ctx.reply`.
- SAFETY_CLAUSE wired into every system prompt (chat + ambient + session).
- Fantasy-prefix drop fires on all three pipelines before send.
- Prompt-leak detector tiered via `promptLeakThreshold`.
- History format is `role:user` with `nick: text` (not a system rule); bracket-tag `[nick]` reserved for game sessions.
- Character / games loaders path-validated.
- Gemini API key redacted on every error emission.
- Ollama base URL is operator-config only; no user-controlled fetch path.
- All in-memory collections bounded + eviction.
- Permission gates enforced at pubm/pub/session creator + per-line founder re-check.
- Session identity binding prevents nick-takeover hijack.
- Reply-loop guards: bot-nick skip, `lastWasBot` suppression.
- Ambient honours `cfg.ambient.enabled`; teardown aborts in-flight calls.
- Input prompt capped at `cfg.input.maxPromptChars`.
- Concurrency semaphore rejects rather than queues.
- `stripFormatting()` on user-controlled strings in 6 reply call sites.
- Ignore-target shape/length validation blocks key injection.

### Plugin flood + rss

- SSRF defence via `ipaddr.js` default-deny — covers RFC1918, loopback, link-local (including 169.254.169.254), ULA, IPv4-mapped IPv6, CGN, multicast, Teredo, 6to4, rfc6052, benchmarking.
- DNS pinning per-hop; DNS timeout race 5 s with `.unref()`.
- URL credentials rejected; scheme allowlist (https only by default); port allowlist (80/443/8080/8443).
- Body size cap 5 MiB with destroy on exceed.
- DOCTYPE / billion-laughs defence via first-4 KiB scan.
- Wall-clock timeout prevents slow-drip DoS.
- Per-feed in-flight guard prevents concurrent polls.
- Teardown aborts in-flight fetches.
- Dedup-seen cap 1000/feed with oldest-first eviction.
- Error messages stripped of control bytes before IRC.
- Feed id regex, URL length cap (2048), channel-shape validation, interval bounds (60-86400 s).
- `+m` permission required on every `!rss` mutation; `api.audit.log` on add/remove.
- Ops-required before every flood enforcement mode/kick/ban.
- Bot-lockout prevention on part/kick.
- Stable rfc1459 flood keys (CASEMAPPING-change resistant).
- Offence tracker hard cap (2000) with oldest eviction.
- Per-channel action rate cap.
- Terminal-action suppression (no duplicate KICK racing +b).
- Teardown async drain before disposal.

### Small plugins

- 8ball: fixed `RESPONSES`; relies on dispatcher flood control; clean.
- ctcp: `api.ctcpResponse()` sanitizes; PING echo safe after bridge; no `process.env`.
- greeter: `api.stripFormatting(ctx.nick)` in substitutions; strips `[\r\n\0]` on user-supplied greets; 200-char cap; massjoin debounce.
- help: permission-filters list + detail; no existence leak on privileged commands; `init()`-scoped cooldown (no reload leak).
- seen: `DEFAULT_MAX_ENTRIES=10_000` + age sweep; corrupt JSON defensively deleted; `stripFormatting` on echoed text.
- topic: `+o` on all mutation; theme list is internal; reentrancy guard; `stripFormatting` on `$text`; length warning before send; lock/unlock audited.

---

## Recommendations

The four CRITICALs take a dedicated batch apiece; the remaining fixes cluster into a hardening batch. Order reflects the user-locked decisions in "Fix-lock decisions" above.

### Batch 1 — Botlink handshake rewrite (CRITICAL, plan-first)

Write a dedicated plan in `docs/plans/botlink-handshake-v2.md` before code. Clean-cut: rewrite `HELLO` in place; no compat shim; every leaf updates together. Covers:

- HMAC challenge-response HELLO (hub sends 32-byte nonce, leaf returns `HMAC-SHA256(scryptSync(password, per-botnet-salt, 32), nonce)`).
- Delete the fixed-salt `hashPassword()` helper from `protocol.ts`.
- Add `fromHandle` to the BSAY frame; hub re-verifies `+m` before fan-out (the other botlink CRITICAL lands in the same commit).
- Per-frame rate limits for `BSAY`, `ANNOUNCE`, `RELAY_INPUT`, `RELAY_OUTPUT`, `PARTY_JOIN`/`PART` (mirror existing CMD/PARTY_CHAT/PROTECT pattern).
- Default `listen.host` to `127.0.0.1` in example configs; add a loud `[security]` warning when the resolved bind is non-loopback and non-RFC1918.
- Delete `RELAY_REQUEST` trust-leaf-blindly path; require hub-side `hasRemoteSession` check (same pattern as `hub-cmd-relay.ts:62-71`).

### Batch 2 — Chanmod hardening (CRITICAL)

- Make `grantMode()` hard-gate `+o/+h/+v` on account-tag or completed ACC verification unconditionally; skip only when `ctx.account` matches the record's `$a:` pattern.
- Add a startup `[security]` warning when auto-op is enabled but `require_acc_for` is missing the grant flag.
- Add the ChanServ services-host pattern check (`services.services_host_pattern`) with per-network default; refuse to latch the `trustedServicesSource` pin on notices that don't match.
- Wire `api.auditActor(ctx)` through every `api.op/ban/kick/mode` call site in chanmod.

### Batch 3 — Plugin API surface narrowing (WARNING / info)

- Add `api.auditActor(ctx)` to the plugin API; document in `docs/PLUGIN_API.md` and CLAUDE.md.
- Remove the `owner` block entirely from `PluginBotConfig`. Strip `tls_cert` / `tls_key` from `PluginIrcConfig`. Grep first to confirm no plugin reads them (and fix/delete if they do — no deprecation path).
- Freeze `pluginBotConfig` sub-objects individually (matches SECURITY.md §4.1's documented guarantee).
- While here: delete `BotDatabase.rawHandleForTests()` if no production code calls it — grep to confirm, then remove (per clean-cut posture, better than adding a NODE_ENV guard).

### Batch 4 — Defence-in-depth hardening (WARNING / info)

Low individual risk, high count. Land as a batch:

- Harden `sanitize()` to strip U+2028/U+2029/`\x85` and coerce non-string inputs.
- Sanitize `target` inside `parseTargetMessage()`; drop the caller-contract fragility.
- Inline `sanitize()` on memo-send and `stripFormatting()` on `.bannounce`/`.bsay` audit metadata.
- Defence-in-depth STS ingestion: short-circuit when `currentTls === false` and a policy already exists (still worth landing even though the enforcer blocks the live attack).
- Weak-hostmask warning: replace the literal-spelling check in `permissions.ts:558-568` with `patternSpecificity()`-based thresholding. Run a startup sweep logging one line per `(handle, weakPattern)` at or above the `require_acc_for` threshold. Call `warnInsecureHostmask()` inside `syncUser()` to cover botlink-pushed records.
- `MessageQueue` per-target cap (e.g., 50) to prevent one plugin starving others.
- `.env*` world-readable refusal at startup (extend the existing `config/bot.json` check).
- `escapeLikePattern()` helper shared by `database.ts` and `mod-log.ts`.
- `auto-op.ts:97`, `mode-enforce-user.ts:63`, `mode-enforce-recovery.ts:293`, `commands.ts:63`, `ban-commands.ts:106` — wrap user-controlled identifiers in `api.stripFormatting()` before log output.
- `.ban` mask specificity warning (`patternSpecificity(mask) < N`) + `--force` confirmation for overbroad masks.
- Cap `hostileActors.size` in `performHostileResponse` (e.g., ≤5 per round) to prevent flood-disconnect cascade.

### Batch 5 — Plugin polish (WARNING, mostly privacy/correctness)

- seen cross-channel sighting: only reply for channels the querier currently shares with the bot.
- seen code-point-aware 200-char slice.
- seen filter out `!seen foo` queries from being stored as the querier's own sighting.
- topic byte-aware length check using `Buffer.byteLength`; honour ISUPPORT `TOPICLEN`.
- topic `.preview` `$` escaping.
- help / topic preview cooldown keyed on `ident@host`.
- RSS tighter content-type allowlist, visited-origin check on redirects, `https:→http:` downgrade refusal.
- Flood `buildFloodBanMask` length cap + IPv6 bracket handling.
- Flood `handleNickFlood` iterates current channel set (not startup config).
