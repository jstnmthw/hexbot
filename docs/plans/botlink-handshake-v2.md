# Botlink HELLO Handshake v2 — Rewrite Plan

## Overview

**What.** Replace the fixed-salt-`scrypt` HELLO auth with an HMAC challenge-response
handshake, add a hub-side `fromHandle` re-check for BSAY fanout, expand
per-frame rate limiting across the steady-state frames, flip the `listen.host`
default to loopback, gate `RELAY_REQUEST` on a live DCC party session, and add a
defence-in-depth CMD cap on the leaf.

**Why.** Two CRITICAL findings from the 2026-04-24 security audit:

- **CRITICAL-BOTLINK-HELLO** — the current HELLO carries a single deterministic
  `scrypt:<hex>` derived from the shared password and the fixed salt
  `'hexbot-botlink-v1'`. Anyone who captures one HELLO (tunnel pre-roll, log
  grep, pcap, misconfigured relay) can replay it from any non-banned IP and
  assume the full identity of any leaf, including permission-mutation fanout
  via ADDUSER/SETFLAGS/DELUSER once inside.
- **CRITICAL-BSAY** — `handleBsay` at `src/core/botlink/hub-bsay-router.ts:30-50`
  broadcasts without re-checking the sender has `+m` on the target channel. A
  compromised leaf (or one that got in via the above replay) can craft a raw
  BSAY frame and bypass the only existing check, which lives on the originating
  leaf only.

Bundled into the same change window: a handful of smaller botlink-hardening
items from the same audit that would be expensive to retrofit after the
handshake lands.

**Scope.** `src/core/botlink/*.ts`, `src/types/config.ts`, `src/config/schemas.ts`,
`config/bot.example.json`, `config/examples/multi-bot/libera/hub.json`,
`config/examples/multi-bot/rizon/leaf.json`, relevant `tests/core/botlink-*.test.ts`
fixtures, `docs/BOTLINK.md`, and `docs/SECURITY.md` §11. No mixed-version
fallback: every leaf updates in lockstep with the hub, and the old
fixed-salt `hashPassword()` helper is deleted in the same commit that
replaces its call sites (clean-cut posture).

**Non-goals.** TLS transport, per-leaf distinct passwords, hub authentication
to leaves beyond the current WELCOME. Those remain follow-ups.

---

## Phase 0 — Read-first (do this before coding)

- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/protocol.ts` — current
      `hashPassword` at lines 112-117, HUB_ONLY_FRAMES at 28-42, KNOWN_FRAME_TYPES
      at 51-101 (two new frame types — `HELLO_CHALLENGE` and `HELLO_RESPONSE`? —
      decision deferred to Open Questions).
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/hub.ts` —
      `listen()` default at lines 131-134, `beginHandshake` at 441-497,
      `acceptHandshake` at 504-605, rate-counter construction at 560-569.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/leaf.ts` —
      `initProtocol` HELLO send at lines 273-282, steady state at 366-411.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/hub-frame-dispatch.ts`
      — existing rate gates at 195-208, registry at 162-170.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/hub-bsay-router.ts`
      — TODO and full handler at 30-50.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/relay-router.ts` —
      `routeRelayFrame` RELAY_REQUEST branch at 211-228, `hasRemoteSession`
      at 207-209.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/relay-handler.ts`
      — RELAY_REQUEST handler at 76-100 (target-side, no gate today).
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/hub-cmd-relay.ts`
      — mirror pattern for gating: the remote-session re-check at lines 62-71
      is the template the new RELAY_REQUEST gate should match.
- [ ] Read `/home/justin/Projects/hexbot/src/core/botlink/auth.ts` —
      `verifyPassword` at 222-233 (will be replaced by `verifyHmac`),
      `expectedHash` field at 118 and 151 (fed by the deleted helper).
- [ ] Read `/home/justin/Projects/hexbot/docs/SECURITY.md` §11 (lines 323-376)
      — replay-able language at 373 must be removed, not paraphrased.
- [ ] Read `/home/justin/Projects/hexbot/DESIGN.md` lines 83-104 — the file-
      inventory block references the old botlink module names (still accurate
      for the files we touch).
- [ ] Grep check (expected set): `grep -n "hashPassword" src/core/botlink/`
      should return only `protocol.ts:114`, `leaf.ts:13`, `leaf.ts:280`,
      `index.ts:15`, and `auth.ts:20`, `auth.ts:151`. If anything else shows
      up, treat it as a Phase 2 blocker.

---

## Phase 1 — Config schema: per-botnet salt + `listen.host` default

Adds a required `link_salt` field to `BotlinkConfig`, adds schema validation,
plumbs it into example configs, and switches `listen.host` default to
`127.0.0.1`. No behaviour yet — just the knob.

- [ ] Add `link_salt: string` (runtime) to `BotlinkConfig` in
      `/home/justin/Projects/hexbot/src/types/config.ts` at line 186-215.
      Required when `enabled: true` and `role: 'hub'`; required when
      `enabled: true` and `role: 'leaf'` too (leaves need it to derive K).
- [ ] Add `link_salt: z.string().min(16)` to `BotlinkConfigOnDiskSchema` in
      `/home/justin/Projects/hexbot/src/config/schemas.ts` at lines 121-142.
      Inline salt is acceptable (it is non-secret by itself, only meaningful
      combined with the password) — no `_env` variant needed.
- [ ] Extend `validateResolvedSecrets` in
      `/home/justin/Projects/hexbot/src/config.ts` at lines 210-215: reject
      startup when `botlink.enabled && !botlink.link_salt`. Error message must
      name the field and point at the hub's logged salt-generation line (see
      Phase 2 first-boot generation task).
- [ ] Update `/home/justin/Projects/hexbot/config/bot.example.json` at lines
      59-85: add a placeholder `"link_salt": "REPLACE_WITH_64_HEX_CHARS"`
      comment-free entry and flip `listen.host` at line 68 from `0.0.0.0` to
      `127.0.0.1`.
- [ ] Update `/home/justin/Projects/hexbot/config/examples/multi-bot/libera/hub.json`
      at line 37: change `"listen": { "host": "0.0.0.0", "port": 5051 }` to
      `"127.0.0.1"` and add `"link_salt": "..."` (same 64-hex placeholder).
- [ ] Update `/home/justin/Projects/hexbot/config/examples/multi-bot/rizon/leaf.json`
      at lines 33-46: add `"link_salt": "..."` matching the hub's example
      placeholder (the two example files must line up so the copy-paste reader
      sees the salt is shared).
- [ ] Grep `grep -rn "listen.*0.0.0.0" docs/ config/` — expect zero hits after
      this phase (docs update happens in Phase 9).

---

## Phase 2 — Delete `hashPassword()` and rewrite HELLO

Challenge-response flow:

```
leaf  ──TCP connect──▶ hub
hub   ──HELLO_CHALLENGE { nonce: <32 random bytes hex>, hubBotname }──▶ leaf
leaf  ──HELLO { botname, hmac: HMAC-SHA256(K, nonce_hex) as hex, version }──▶ hub
hub   ──WELCOME | ERROR──▶ leaf
        where K = scryptSync(password, Buffer.from(link_salt, 'hex'), 32)
```

Key points:

- Nonce generated with `crypto.randomBytes(32)`; hub emits hex string on the
  wire but HMACs over the raw bytes on verify.
- Nonce is per-connection, stored in the handshake closure, cleared on
  `finish()`. No nonce cache needed — the window is bounded by
  `handshake_timeout_ms` and the `max_pending_handshakes` per-IP cap.
- `timingSafeEqual` on the computed-vs-received HMAC (same length-check
  pattern that `verifyPassword` already uses).
- HELLO no longer carries `password`. If a field named `password` arrives,
  drop the frame with `ERROR { code: 'PROTOCOL' }` (loud, because it means a
  pre-v2 leaf is talking to a v2 hub — operator hasn't updated everywhere).

### 2a — `src/core/botlink/protocol.ts`

- [ ] Delete the `hashPassword` export (lines 112-117). Remove the
      `scryptSync` import at line 7 if no other code in this file uses it
      after deletion (it's used only by `hashPassword` today).
- [ ] Add two exported helpers: - `deriveLinkKey(password: string, linkSaltHex: string): Buffer` —
      runs `scryptSync(password, Buffer.from(linkSaltHex, 'hex'), 32)`.
      Validates salt hex is ≥ 16 bytes decoded; throws otherwise. - `computeHelloHmac(key: Buffer, nonce: Buffer): string` — returns
      hex string; uses `createHmac('sha256', key).update(nonce).digest('hex')`. - `verifyHelloHmac(key: Buffer, nonce: Buffer, sentHex: string): boolean`
      — computes expected hex, compares via `timingSafeEqual` after length
      check. Mirror the exact pattern in `auth.ts:228-233`.
- [ ] Add `'HELLO_CHALLENGE'` to `KNOWN_FRAME_TYPES` at lines 51-101. Do NOT
      add it to `HUB_ONLY_FRAMES` — the leaf needs to receive it. (The frame
      naturally only flows hub→leaf so fanout isn't at risk regardless.)
- [ ] Update the file-level JSDoc header at lines 1-5 to name the new helpers
      in place of `hashPassword`.

### 2b — `src/core/botlink/auth.ts`

- [ ] Remove the `hashPassword` import at line 20.
- [ ] Replace the `expectedHash` field (line 118) with `linkKey: Buffer` and
      compute it in the constructor at line 151 via `deriveLinkKey(password,
  config.link_salt)`. Zero the old `expectedHash` reference.
- [ ] Replace `verifyPassword(sent: string)` at lines 222-233 with
      `verifyHelloHmac(nonce: Buffer, sentHex: string): boolean` that
      delegates to the protocol helper. The method MUST continue to be the
      single place failures are computed so `noteFailure` bookkeeping is
      intact.
- [ ] Audit the docstring at lines 104-111 — renumber so the "three questions"
      list reflects the new verifyHelloHmac signature and mentions the nonce.

### 2c — `src/core/botlink/hub.ts`

- [ ] In `beginHandshake` at lines 441-497, generate a per-connection nonce
      with `randomBytes(32)`, send `HELLO_CHALLENGE { nonce: nonce.toString('hex'),
  hubBotname: this.config.botname }` immediately after `protocol` is
      installed (before the `protocol.onFrame = …` block). The closure captures
      the `nonce` Buffer so `acceptHandshake` can see it.
- [ ] Pass the captured `nonce: Buffer` through to `acceptHandshake` as a new
      parameter (update the call at line 489 and the method signature at 504-
      509).
- [ ] In `acceptHandshake`, replace the `verifyPassword(password)` call at
      line 514 with `this.auth.verifyHelloHmac(nonce, String(frame.hmac ?? ''))`.
      The `password` field is removed from the HELLO shape — reject the frame
      (`PROTOCOL` error) if it contains any `password` key at all.
- [ ] Tighten the "missing botname" check at line 522 to also reject a missing
      or non-string `hmac` field before the verify call (pattern-match
      `acceptHandshake` to always fail closed on malformed frames).

### 2d — `src/core/botlink/leaf.ts`

- [ ] Remove the `hashPassword` import at line 13.
- [ ] Replace the unconditional HELLO send at lines 277-282: the leaf must
      instead wait for `HELLO_CHALLENGE` from the hub, derive K once via
      `deriveLinkKey(this.config.password, this.config.link_salt)` (cache on
      the instance — compute on construct and reuse, never log), compute
      `computeHelloHmac(K, Buffer.from(frame.nonce, 'hex'))`, and reply with
      `{ type: 'HELLO', botname, hmac, version }`.
- [ ] Add an early-frame branch in the handshake `protocol.onFrame` at lines
      309-336: `HELLO_CHALLENGE` must be the first frame. Any other type before
      challenge arrives → close with `PROTOCOL` and reconnect.
- [ ] Extend the 15s `handshakeTimeoutMs` comment at lines 289-295 so a future
      reader sees the timeout now covers "no CHALLENGE" as well as "no
      WELCOME".
- [ ] Zero-out the derived key on `disconnect()` / `reconnect()` (lines 229-259)
      — not security-critical in Node (GC is not zeroing), but it keeps the
      cached key tied to the current botlink lifecycle and makes a future
      key-rotation story easier.

### 2e — exports and call sites

- [ ] Update `/home/justin/Projects/hexbot/src/core/botlink/index.ts` line 15:
      remove the `hashPassword` re-export. Add `deriveLinkKey`,
      `computeHelloHmac`, `verifyHelloHmac` if they need to be visible to
      tests; otherwise leave protocol-private.
- [ ] Update test fixtures that construct `HELLO` frames by hand to use the
      new shape. Files that currently reference `hashPassword` and must be
      rewritten: - `tests/core/botlink-auth.test.ts:5,35` - `tests/core/botlink-relay.test.ts:6,17` - `tests/core/botlink.test.ts:13,31,62-77` (the whole
      `describe('hashPassword', …)` block deletes; new equivalent lands in
      Phase 8). - `tests/core/commands/botlink-commands.test.ts:7,19`

---

## Phase 3 — BSAY `fromHandle` + hub re-check

Closes CRITICAL-BSAY. `fromHandle` rides on every BSAY frame; the hub re-runs
`permissions.checkFlagsByHandle(fromHandle, 'm', channel)` before fanout,
where `channel` is the BSAY `target` when it starts with `#`/`&` and null
otherwise (PM target — global `+m` applies).

- [ ] Extend `LinkFrame` typing in `/home/justin/Projects/hexbot/src/core/botlink/types.ts`
      so the BSAY shape declares `fromHandle: string` (or add it to a
      dedicated `BsayFrame` extraction — match whichever pattern
      `types.ts` already uses for other frames that carry handles).
- [ ] In `/home/justin/Projects/hexbot/src/core/commands/botlink-commands.ts`
      at line 628, the `.bsay` admin command must include the caller's handle
      on the outgoing frame. Look up `ctx`'s handle via `permissions.findByHostmask`
      (same pattern used at `leaf.ts:175`) and set it on the frame. Refuse to
      send the frame if we cannot resolve a handle — fail loud.
- [ ] In `/home/justin/Projects/hexbot/src/core/botlink/hub-bsay-router.ts`
      lines 30-50: - Remove the TODO at lines 35-40. - Extend `HubBsayContext` with a `checkFlags(handle: string, flags: string,
    channel: string | null) => boolean` callback. The hub wires this to
      `this.cmdPermissions.checkFlagsByHandle` (see `permissions.ts:421`). - Add a `fromHandle = String(frame.fromHandle ?? '')` at the top of
      `handleBsay`. If it is empty, drop the frame with an audit log line
      (`[security] BSAY from leaf missing fromHandle — dropping`). - Re-check `+m`: compute `channel = target.startsWith('#') ||
    target.startsWith('&') ? target : null`; if
      `!ctx.checkFlags(fromHandle, 'm', channel)`, drop + audit-log the
      rejection. Include `fromBot`, `fromHandle`, `target` in the log.
- [ ] In `/home/justin/Projects/hexbot/src/core/botlink/hub.ts`
      `frameDispatchContext()` at lines 616-629: pass the new `checkFlags`
      callback down. The hub wires it to `this.cmdPermissions` (null-check —
      if `cmdPermissions` is null, BSAY must fail closed, which is the safe
      direction for pre-wiring early startup).
- [ ] Leaf-side BSAY construction: the steady-state frame dispatcher itself
      doesn't originate BSAY — today only the `.bsay` command emits it, and
      that path lands on the hub via the admin leaf. No change to
      `leaf.ts`'s steady state, but audit the file for `type: 'BSAY'` to
      confirm — expected hit count: 0.
- [ ] Identity stamping: the hub already overwrites `fromBot` for every leaf
      frame at `hub.ts:638`. Extend that block to also overwrite `fromHandle`?
      NO — that would break the admin-provided handle. Instead, validate at
      frame receipt that if a `fromHandle` is present, it matches a user on
      the leaf's side (we cannot check that cheaply here) — defer to the
      `checkFlagsByHandle` call which rejects unknown handles naturally.

---

## Phase 4 — Per-frame rate buckets

Mirror the existing `cmdRate`/`partyRate`/`protectRate` pattern at
`hub.ts:560-569` and the gate block at `hub-frame-dispatch.ts:195-208`.

New buckets and budgets:

| Frame        | Budget | On overflow           |
| ------------ | ------ | --------------------- |
| BSAY         | 10/s   | drop + audit-log once |
| ANNOUNCE     | 5/s    | silent drop           |
| RELAY_INPUT  | 30/s   | silent drop           |
| RELAY_OUTPUT | 30/s   | silent drop           |
| PARTY_JOIN   | 5/s    | silent drop           |
| PARTY_PART   | 5/s    | silent drop           |

Budgets track existing posture: chat-class is 5/s, command-class is 10/s,
relay-class is bursty-but-not-flood (30/s is well above the fastest
human-typist stream and well below denial-of-service territory).

- [ ] Add `bsayRate`, `announceRate`, `relayInputRate`, `relayOutputRate`,
      `partyJoinRate`, `partyPartRate` to `LeafConnection` in
      `/home/justin/Projects/hexbot/src/core/botlink/hub.ts` at lines 31-46.
- [ ] Construct them inside `acceptHandshake` at lines 560-569 (next to the
      existing `cmdRate`/`partyRate`/`protectRate` lines).
- [ ] Extend `LeafLike` in
      `/home/justin/Projects/hexbot/src/core/botlink/hub-frame-dispatch.ts`
      lines 34-40 with the six new fields.
- [ ] Thread them through `dispatchSteadyStateFrame` arguments at
      `hub.ts:640-650`.
- [ ] Add gate branches in `dispatchSteadyStateFrame` at
      `hub-frame-dispatch.ts:195-208`, matching the existing style: - `BSAY` → silent drop + `ctx.logger?.warn` (we don't have a logger on
      context today; if that's a 30-line refactor, gate via a counter on
      the leaf object and log once per N drops — pick whichever is less
      invasive at build time). - `ANNOUNCE`, `RELAY_INPUT`, `RELAY_OUTPUT`, `PARTY_JOIN`, `PARTY_PART`
      → silent drop (matches `PARTY_CHAT` precedent).
- [ ] Update any tests that pump BSAY/ANNOUNCE/etc at > budget without
      expecting to be throttled — expected hits via
      `grep -rn "ANNOUNCE\|BSAY" tests/core/botlink*` should be short.

---

## Phase 5 — `listen.host` default + non-loopback warning

- [ ] In `/home/justin/Projects/hexbot/src/core/botlink/hub.ts` at lines 131-134,
      change the default from `'0.0.0.0'` to `'127.0.0.1'`.
- [ ] Immediately after the successful `listen()` callback at line 138-141,
      check the resolved `host`. If it is neither loopback (`127.0.0.0/8`,
      `::1`) nor RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
      emit a logger.warn line prefixed `[security]` naming the bound address
      and instructing the operator to front it with a tunnel. Reuse
      `isWhitelisted()` from `auth.ts:67-88` by passing the RFC1918 CIDR list,
      or write a small `isPrivateOrLoopback(host)` helper in `auth.ts`
      (whichever keeps the warning logic out of `hub.ts`).
- [ ] Example config updates are covered in Phase 1.
- [ ] Add a note in the new-or-updated `docs/BOTLINK.md` (Phase 9) that
      operators explicitly choosing to bind `0.0.0.0` must have a tunnel in
      front; don't muddy the warning itself with config advice.

---

## Phase 6 — RELAY_REQUEST hub-side gate

`relay-router.ts:215-228` currently registers a relay session purely on
`hasLeaf(targetBot)`. A compromised leaf can trigger relay sessions against
any target, which on the target side (`relay-handler.ts:76-100`) creates a
virtual session for any handle known to the target's permissions, effectively
allowing a leaf to execute commands on another bot as any handle.

Mirror the pattern at `hub-cmd-relay.ts:62-71` — require an active remote
party-line session for `handle@fromBot` before the hub will register the
relay.

- [ ] In `/home/justin/Projects/hexbot/src/core/botlink/relay-router.ts` at
      lines 211-228, before calling `this.activeRelays.set(...)` and
      forwarding: require `this.hasRemoteSession(handle, fromBot)`. If
      missing, reply with
      `RELAY_END { handle, reason: 'No active DCC party session for handle on fromBot' }`
      and return. Audit-log the rejection at `warn` level with `fromBot`,
      `handle`, `targetBot`.
- [ ] Confirm `relay-handler.ts:76-100` does not independently create relays;
      it only responds to requests routed through `relay-router.ts`. No code
      change needed there, but add a one-line comment pointing at the
      router-side gate so a future reader knows where the auth lives.
- [ ] Re-review `registerHubRelay` at `relay-router.ts:117-123` — that path is
      triggered by the local `.relay` command and does NOT need the remote-
      session gate (the gate exists precisely to reject frames from compromised
      leaves; a local command run via `+m` is already gated by the command
      handler's flag check).

---

## Phase 7 — Leaf-side CMD cap (optional, defence-in-depth)

The hub already enforces 10/s per leaf on CMD. A malicious hub is out of
scope by our trust model (hub compromise = full compromise). This phase is a
cap on the _inbound_ direction — what the leaf is willing to execute in a
second — so a bug in the hub cannot accidentally flood a leaf with CMD
frames and exhaust command-handler queues.

- [ ] Add `cmd_inbound_rate?: number` to `BotlinkConfig` in
      `/home/justin/Projects/hexbot/src/types/config.ts` (default 50/s when
      unset). Corresponding zod entry in
      `/home/justin/Projects/hexbot/src/config/schemas.ts`.
- [ ] In `/home/justin/Projects/hexbot/src/core/botlink/leaf.ts` at the
      `private` fields block (~35-53), add `private cmdInboundRate: RateCounter`.
      Construct in the constructor around lines 62-77 with
      `new RateCounter(config.cmd_inbound_rate ?? 50, 1_000)`.
- [ ] In `onSteadyState` at lines 366-411, add a gate in the `CMD` branch at
      line 403: `if (!this.cmdInboundRate.check()) { this.logger?.warn(...);
  this.send({ type: 'ERROR', code: 'RATE_LIMITED', ... }); return; }`.
- [ ] Document the new field in `docs/BOTLINK.md` (Phase 9).

---

## Phase 8 — Tests

Every behavioural change above needs a test that would fail without the
corresponding fix. Use the existing `botlink*.test.ts` patterns (socket
`Duplex` mock, `pushFrame` helper).

### 8a — HELLO v2 tests (new file or extend `botlink.test.ts`)

- [ ] Happy path — leaf receives CHALLENGE, returns valid HMAC, gets WELCOME.
- [ ] Replay rejection — capture a valid HELLO from run A, replay it in a
      fresh connection (which got a different nonce), expect `AUTH_FAILED`
      and the connection to be closed + counted against `noteFailure`.
- [ ] Nonce uniqueness — spin up 100 back-to-back handshakes, collect the
      server-emitted CHALLENGE nonces, assert all 100 distinct. This guards
      against an accidental `Math.random` regression.
- [ ] Wrong salt — hub and leaf configured with different `link_salt` must
      fail auth even with the same password. Confirms the salt is actually
      in the HMAC keystream.
- [ ] Missing `hmac` field on HELLO — expect `PROTOCOL` error, no auth attempt
      counted.
- [ ] Pre-v2 leaf (sends `password` instead of `hmac`) → `PROTOCOL` error,
      connection closed.
- [ ] No crash on malformed nonce hex from a malicious hub (leaf-side) —
      `Buffer.from('zzz', 'hex')` must not throw uncaught; reconnect path
      fires.

### 8b — BSAY re-check

- [ ] Leaf sends BSAY `fromHandle=eve, channel=#ops` where `eve` has no
      flags on the hub → frame is dropped, NOT broadcast.
- [ ] Leaf sends BSAY `fromHandle=admin, channel=#ops` where admin has `+m`
      on hub → broadcast + local delivery both fire.
- [ ] Leaf sends BSAY with empty `fromHandle` → dropped, audit-log fired.
- [ ] PM-target BSAY (`target=someNick`) uses the handle's global `+m` flag.

### 8c — Per-frame rate limits

- [ ] BSAY floods at 20/s → only 10 broadcast, rest dropped.
- [ ] ANNOUNCE floods at 20/s → only 5 delivered.
- [ ] RELAY_INPUT floods at 60/s → only 30 routed to target.
- [ ] PARTY_JOIN floods at 20/s → only 5 tracked in `remotePartyUsers`.
- [ ] Existing `cmdRate` test still passes unchanged (regression guard).

### 8d — RELAY_REQUEST hub gate

- [ ] Leaf A sends `RELAY_REQUEST handle=eve toBot=leafB` without any prior
      `PARTY_JOIN` for `eve` → hub replies `RELAY_END reason='No active DCC
  party session…'`, never forwards to leaf B.
- [ ] Same request AFTER a `PARTY_JOIN handle=eve` from leaf A → forwarded
      normally, relay registered.

### 8e — Hub listen warning

- [ ] `listen('1.2.3.4', 5051)` logs a `[security]` warning.
- [ ] `listen('127.0.0.1', 5051)` does NOT warn.
- [ ] `listen('10.0.0.5', 5051)` does NOT warn (RFC1918 carve-out).

### 8f — Cleanup

- [ ] Delete `describe('hashPassword', …)` at `tests/core/botlink.test.ts:62-77`
      — the symbol no longer exists. Replace with a `describe('deriveLinkKey +
  computeHelloHmac round-trip', …)` block covering: same
      password+salt+nonce → same HMAC; different nonce → different HMAC.
- [ ] `grep -rn "hashPassword" tests/core/botlink*` after Phase 2e +
      Phase 8 → zero hits.

---

## Phase 9 — Docs

- [ ] Update `/home/justin/Projects/hexbot/docs/SECURITY.md` §11: - Replace the "Authentication" block (lines 333-337) with the
      challenge-response flow, naming the per-botnet salt and the fact the
      password is never transmitted (not even hashed). - Delete or rewrite the "Network considerations" bullet at line 373
      that says HELLO is replay-able — the whole phrase is false after
      this patch. - Update the `listen.host` bullet at line 375 to note the new loopback
      default and the non-loopback warning. - Add a bullet under "Frame validation" that lists the six new per-
      frame rate buckets and their budgets (match the table in Phase 4). - Add a bullet under "Relay sessions" noting the hub now gates
      `RELAY_REQUEST` on a live DCC party session for the handle.
- [ ] Update `/home/justin/Projects/hexbot/docs/BOTLINK.md`: - Add `link_salt` to the hub setup table (line 57-75) and the leaf
      table (line 100+). - Change the `listen.host` row to show `127.0.0.1` as the default and
      add the warning note. - Document the new frame types (`HELLO_CHALLENGE`) in the "Protocol"
      section if one exists; otherwise add a short one. - Document the optional `cmd_inbound_rate` leaf setting.
- [ ] Update `/home/justin/Projects/hexbot/DESIGN.md` lines 83-90 only if the
      module inventory list mentions `hashPassword` or the old HELLO shape
      — expected: no change, the inventory is file-level, not function-level.
- [ ] CHANGELOG entry under a BOTLINK section naming both CRITICAL audit IDs
      (CRITICAL-BOTLINK-HELLO, CRITICAL-BSAY) and summarising the breaking
      change: "every bot in a botnet must update together; add `link_salt` to
      your `botlink` config".

---

## Open questions

1. **Where should the per-botnet salt live?**
   - (a) Inline in `config/bot.json` under `botlink.link_salt` (proposed
     here). Pro: simple, mirrors password_env pattern, non-secret alone.
     Con: operators must remember to copy it to every leaf.
   - (b) Stored in the hub DB on first boot, exposed via a `.botlink salt`
     admin command so operators paste it into leaves. Pro: auto-generated.
     Con: adds a DB migration and a first-boot UX we haven't validated.
   - (c) Derived from `scrypt(password, 'hexbot-botlink-salt-v2')` — defeats
     the point (back to a well-known salt). Reject.
   - **Default chosen for this plan: (a). Revisit before Phase 1 lands if you
     want (b).**

2. **Should `link_salt` have a `_env` variant?**
   - The salt is not a secret on its own; inline is fine. Skipping `_env`
     keeps the config schema smaller. Flag: confirm before Phase 1.

3. **New frame type name: `HELLO_CHALLENGE` or repurpose `HELLO` bidirectionally?**
   - (a) Add `HELLO_CHALLENGE` as a distinct hub→leaf frame (cleaner, proposed
     above, one more entry in `KNOWN_FRAME_TYPES`).
   - (b) Reuse `HELLO` as the single frame name, with the hub's copy carrying
     `nonce` and no `botname`, and the leaf's copy carrying `botname`+`hmac`.
     Pro: one frame type. Con: the two shapes diverge enough that a single
     validator gets messy.
   - **Default chosen: (a).**

4. **RELAY_REQUEST gate: what if `hasRemoteSession` is false because the
   leaf hasn't yet fanned out its `PARTY_JOIN`?**
   - Order-of-events concern. Expected flow: DCC user joins party →
     `PARTY_JOIN` frame to hub → hub tracks in `remotePartyUsers` →
     user types `.relay` → `RELAY_REQUEST`. The join _must_ precede the
     relay request; if it doesn't, that's a leaf bug. **Gate rejects
     per-plan, but confirm the DCC → party → relay ordering in
     `src/core/dcc.ts` before Phase 6 lands.**

5. **Non-loopback warning — warn on `::` too?**
   - Current auth.ts CIDR helpers are IPv4-only. If the operator binds an
     IPv6 wildcard (`::`), the warning helper should either treat it as
     non-loopback and warn, or we explicitly skip IPv6 (noisy). Proposed:
     warn on any IPv6 that isn't `::1`. **Confirm before Phase 5.**

6. **Leaf-side CMD cap default — 50/s or tighter?**
   - The hub sends bursts on `.bot` + multi-line help expansions. 50/s is
     comfortably above that. 25/s or 100/s are plausible alternatives.
     **50/s chosen, configurable; tune after deployment feedback.**
