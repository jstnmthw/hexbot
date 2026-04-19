# Should HexBot identify with services before joining channels, and reconcile user flags when an already-joined user authenticates later?

Two related problems, one doc. They share the same underlying cause — the bot treats identity as a snapshot taken at `JOIN` time, not as a stream that evolves after.

## Context

### Problem 1: Bot joins channels before NickServ identify completes

Current sequence (see `src/bot.ts:360–412` and `src/core/connection-lifecycle.ts:212–245`):

1. `client.connect()` opens the socket.
2. CAP LS → SASL (if enabled) → NICK/USER → `registered` event.
3. `onRegistered()` fires `bot:connected`, applies ISUPPORT/CASEMAPPING, and **immediately calls `joinConfiguredChannels()`**.
4. After `connect()` resolves, `Bot.start()` calls `this.services.identify()` — which sends `PRIVMSG NickServ :IDENTIFY <pw>` if we aren't using SASL.

Consequence split by auth mode:

- **SASL PLAIN / EXTERNAL** (the default path on Libera, OFTC, modern Atheme networks) — the server has already authenticated the bot _before_ step 3. JOIN after registration is correct: the bot is identified, cloaked, and ChanServ sees it as logged-in. **No problem here.**
- **Non-SASL (legacy NickServ IDENTIFY)** — the bot joins as an un-identified nick, then sends IDENTIFY a few ms later. In this window:
  - ChanServ won't auto-op the bot (the bot has to re-request once identified, or rely on `chanserv_access` probes in chanmod).
  - A `+r` (registered-only) channel rejects the JOIN with 477.
  - The bot's un-cloaked hostmask is briefly visible to channel users.

### Problem 2: Late-arriving authentication doesn't trigger reconciliation

Scenario from the user: BlueAngel joins `#main` unauthenticated, then `/msg NickServ IDENTIFY <pw>` a few seconds later. HEX should pick this up and apply `+v` (based on BlueAngel's flags) — and conversely, should demote/devoice if flags are reduced while the user is present.

What exists today:

- **Channel-state tracks account changes** (`src/core/channel-state.ts:586–607`). `onAccount` updates `networkAccounts` and every per-channel `UserInfo.accountName` when `account-notify` fires.
- **Flag-change reconciliation works** (`plugins/chanmod/auto-op.ts:246–252` → `reconcileHandleAcrossChannels`). When `.flags` or `.adduser` changes a user record, `onPermissionsChanged` fires and chanmod walks every channel to upgrade/downgrade prefixes.
- **But account-change reconciliation is missing.** `channel-state.onAccount` updates the cache but emits nothing on the event bus. `user:identified` is only emitted from `Services.resolveVerification` — the explicit ACC/STATUS round-trip path — which fires when _chanmod/dispatcher calls `verifyUser()`_, not when the user identifies on their own initiative.

So the BlueAngel flow actually stalls at the channel-state layer: the data arrives, nothing acts on it.

### Relevant prior decisions

- **Eggdrop's bind system is the core abstraction** — plugins react to IRC events, they don't poll.
- **Plugin isolation** — chanmod already owns auto-op/devoice logic and has a reconciler. It's the right home for account-triggered reconciliation too.
- **Fast-path account-tag** — `grantMode` already prefers IRCv3 account data over a NickServ round-trip (`plugins/chanmod/auto-op.ts:45–89`). So any new path should stay on the IRCv3 rails.

## Options

### Problem 1: Identify before joining

#### Option A — SASL + move `services.identify()` into the `registered` handler (chosen)

Keep the current sequence for SASL networks (already correct). For non-SASL networks, move the `this.services.identify()` call out of `Bot.start()` (where it fires _after_ `connect()` resolves, which is _after_ JOINs have already been issued) into the `onRegistered` path in `connection-lifecycle.ts`, **before** `joinConfiguredChannels()`.

The IDENTIFY line still races the JOIN over the wire — servers route `PRIVMSG NickServ` and `JOIN` as separate messages — but in practice NickServ processes IDENTIFY fast enough that on most networks the account-bind / cloak is applied before the JOIN is acknowledged. No notice parsing, no timeout, no new config.

- Pro: ~5-line change. Closes most of the non-SASL race without adding a gate.
- Pro: No new parser surface, no timeout to tune, no config knob.
- Pro: Document SASL as the supported path for strict identify-before-join; this reorder is a best-effort improvement on top.
- Con: Not deterministic — on a laggy services provider, JOIN can still land before the cloak is applied. The remaining window is the same order of magnitude as the existing `services.verify` timeout (~5s worst case).
- Effort: **S**.

#### Option B — Defer joins behind a "NickServ IDENTIFY acknowledged" gate

After `registered`, if `services.type !== 'none'` and SASL is off, send IDENTIFY first and wait for one of:

- NickServ notice "You are now identified" / "Password accepted" / similar (regex per services adapter, same way ACC/STATUS replies are already parsed in `src/core/services-parser.ts`).
- A bounded timeout (suggest 3s — shorter than the existing 5s `verifyUser` timeout because this one blocks startup).

On ack: join channels. On timeout: log a warning and join anyway — we don't want the bot permanently stuck because NickServ is lagged.

- Pro: Solves the race for the non-SASL path on the networks where it matters.
- Pro: Uses the same NickServ-notice-parser surface we already maintain.
- Con: Adds startup latency (up to 3s) on non-SASL networks.
- Con: Each services package has a different "identified" confirmation string — new adapter surface area, new test matrix.
- Con: If we guess wrong (unknown services package), we fall through to the timeout and the 3s startup penalty happens on every boot.
- Effort: **M**.

#### Option C — Option A + optional config gate

`services.wait_for_identify_before_join: true` makes the bot behave like Option B; default `false` keeps Option A.

- Pro: Operators who need it get it; everyone else pays nothing.
- Con: One more knob. DESIGN.md's "convention over configuration" principle argues against it unless there's a real operator asking.
- Effort: **M**.

### Problem 2: Reconcile on late authentication

#### Option X — Emit `user:identified` / `user:deidentified` from `channel-state.onAccount` (chosen)

Emit two events from `channel-state.onAccount` when the tracked account actually changes value:

- `null | undefined → string` — emit `user:identified` (same event the explicit `verifyUser` path already uses). Carries `(nick, account)`.
- `string → null` — emit a new `user:deidentified` event carrying `(nick, previousAccount)`.

Chanmod subscribes to both in `setupAutoOp` and routes each to the existing `reconcileHandleAcrossChannels` path. Both promotion (`null → string`) and demotion (`string → null`) end up in the same reconciler, which already handles upgrade _and_ downgrade symmetrically.

- Pro: Reuses the existing event for the promotion case. No ambiguity — handlers that only care about "is identified now" don't need to null-check an argument.
- Pro: Symmetric with the verifyUser path — both fire `user:identified` for the successful case, both trigger the same reconciler.
- Pro: Other plugins (seen, greeter, potential future auth-aware plugins) can subscribe to either event without special-casing.
- Con: Slightly overloads the semantics of `user:identified` — it now means "the bot noticed identification" rather than "we actively verified." The existing callers of `user:identified` don't distinguish these, so in practice it's a no-op.
- Effort: **S**.

#### Option Y — New event `user:accountChanged`

Emit a distinct event that carries `(nick, account | null, previousAccount)`. Chanmod subscribes to that.

- Pro: Clean separation. `user:identified` stays for "we actively called verifyUser," the new event covers passive observation.
- Pro: Carries the previous account so handlers can distinguish "first-time login" from "switched accounts."
- Con: Two events with ~95% overlapping subscribers.
- Con: More API surface, more docs, more plugins to update.
- Effort: **M**.

#### Option Z — New `account` bind type on the dispatcher

Add a `'account'` bind type alongside `join`/`part`/`nick`. Plugins register `api.bind('account', '-', '*', handler)`.

- Pro: Symmetric with other IRC events — an account change _is_ an IRC event (`account-notify`).
- Con: Overkill for the handful of subscribers that will care. The event bus is already the right tool for bot-internal state changes.
- Con: Every new bind type expands the dispatcher's test matrix and the plugin API surface.
- Effort: **L**.

## Recommendation

**Problem 1: Option A — SASL plus reorder.** Document SASL as the supported identify-before-join mechanism, and move `this.services.identify()` into the `onRegistered` path in `connection-lifecycle.ts` so the IDENTIFY line is sent _before_ `joinConfiguredChannels()` rather than after `connect()` resolves. On non-SASL networks this closes most of the race with no new parser surface. Confidence: **high**.

**Problem 2: Option X.** Emit `user:identified` from `channel-state.onAccount` when the account transitions `null|undefined → string`, and emit a symmetric `user:deidentified` event for the `string → null` transition. Chanmod subscribes to both in `setupAutoOp` and routes each to `reconcileHandleAcrossChannels`. Confidence: **high**.

Concrete deltas:

### Problem 1

1. `src/bot.ts:409` — remove `this.services.identify();` from the tail of `Bot.start()`.
2. `src/core/connection-lifecycle.ts:onRegistered` — add a call to the services identify path before `joinConfiguredChannels(deps)`. The lifecycle layer doesn't import `Services` directly today; the cleanest wiring is to pass a `services: { identify(): void }` dep through `ConnectionLifecycleDeps` (alongside the existing `messageQueue`/`dispatcher` deps) and have `Bot.attachBridge()` wire the real services instance. A simpler but slightly leakier alternative is to add an `onRegisteredHook` callback to deps that `bot.ts` populates with `() => this.services.identify()`.
3. Update `docs/SECURITY.md` and/or `README.md` to state that SASL is the supported identify-before-join mechanism; the NickServ IDENTIFY path is best-effort and should not be relied on for `+r` channels.

### Problem 2

1. `src/event-bus.ts:43` — add `'user:deidentified': [nick: string, previousAccount: string]` to `BotEvents`.
2. `src/core/channel-state.ts:587` — in `onAccount`, capture the previous account from the network map _before_ updating it, then after updating emit:
   - `user:identified(nick, account)` when `previous` was `null` or `undefined` and the new account is a string.
   - `user:deidentified(nick, previous)` when `previous` was a string and the new account is `null`.
   - Emit nothing when the value didn't change (duplicate account-notify lines) or when the transition is account-A → account-B (rare but possible on some networks — treat as deidentify-then-identify and emit both, in order).
3. `src/plugin-api-factory.ts` — add `onUserIdentified(cb)` and `onUserDeidentified(cb)` wrappers alongside the existing `onPermissionsChanged` wrapper, with the same per-plugin listener-tracking so reload doesn't leak.
4. `plugins/chanmod/auto-op.ts:246` — subscribe to both events. Handler: resolve the nick to a user record via `permissions.findByHostmask` (the existing `setAccountLookup` wiring makes `$a:accountname` masks match), then call `reconcileHandleAcrossChannels(api, config, record.handle)`. The reconciler already handles both upgrade and downgrade paths, so BlueAngel's +v on identify and the corresponding -v on deidentify fall out without new logic.
5. Tests in `tests/core/channel-state.test.ts` for the new transitions (identify, deidentify, duplicate no-op, A→B), and in `tests/plugins/chanmod.test.ts` for the reconcile path triggered by the new events.

This gives you BlueAngel's +v without ever touching the auto-op bind type, and the symmetric deidentify path gives you demotion for free.

## What Eggdrop does

**Identify-before-join:** Eggdrop does not wait. Configured channels are added via `channel add` in `eggdrop.conf` and joined as soon as the bot is registered on the server. The `nickserv.tcl` script (community-maintained, not in the default distribution) patches this by delaying `channel set` active until NickServ confirms identification via a notice matcher — essentially Option B above. The fact that 30 years of Eggdrop deployments use SASL or rely on ChanServ auto-op to recover from the race suggests the race isn't worth special-casing in-core.

**Late-auth reconciliation:** Eggdrop's `matchattr` / `matchwho` checks the nick→handle binding every time an `account-notify` (or the equivalent pre-IRCv3 NickServ status poll) fires. The stock `irc` module does call its `need-op`/`need-voice` handlers on the account change — so Eggdrop does reconcile on late identification. Option X brings HexBot to parity with this long-standing Eggdrop behaviour.
