# Plan: ChanServ-Assisted Join Error Recovery

## Summary

When the bot can't join a channel (banned, invite-only, bad key), it currently logs a warning and retries blindly every 30 seconds. It never asks ChanServ for help, even when chanmod knows the bot has ChanServ access. This is the Eggdrop `need-unban` / `need-invite` / `need-key` pattern — one of its oldest features, and a critical gap in HexBot's channel protection.

**Trigger:** Bot was banned while in-channel. On restart, ChanServ blocked the join. The bot sat retrying uselessly despite being the channel founder with full ChanServ access.

---

## Design Decisions

| Decision                  | Choice                                               | Rationale                                                                                      |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Event delivery to plugins | New `join_error` dispatcher type                     | Consistent with existing architecture. Any plugin can bind to it. Clean separation.            |
| Channel key handling      | Expose configured keys to plugins via PluginAPI      | Fixes the existing gap where kick-rejoin and presence-check retry without keys.                |
| `channel_is_full` (471)   | No ChanServ remedy                                   | ChanServ can't fix a full channel. Periodic rejoin handles it naturally.                       |
| Cooldown strategy         | Exponential backoff (30s -> 60s -> 120s -> 5min cap) | Prevents long-term ChanServ spam if the bot genuinely can't rejoin. Resets on successful join. |

---

## Scope

**In scope:**

- `banned_from_channel` (474) -> ChanServ UNBAN + INVITE + rejoin
- `invite_only_channel` (473) -> ChanServ INVITE + rejoin
- `bad_channel_key` (475) -> ChanServ INVITE (preferred) or retry with configured key (fallback)
- `channel_is_full` (471) -> ChanServ INVITE (when access available)
- Expose channel keys to plugins (read-only)
- Exponential backoff cooldown on recovery attempts
- Works with both Atheme and Anope backends

**Out of scope:**

- `need_registered_nick` (477) — NickServ identification is a separate concern
- Custom keys set at runtime (only configured keys from `bot.json`)

---

## Phase 1: Add `join_error` dispatcher event type

**Goal:** Make join failure events visible to plugins through the standard bind system.

### 1.1 Add `join_error` to BindType

**File:** `src/types.ts`

Add `'join_error'` to the `BindType` union (after `'invite'`).

The `HandlerContext` for `join_error` events:

- `channel` — the channel the bot failed to join
- `command` — the error reason string (`banned_from_channel`, `invite_only_channel`, `bad_channel_key`, `channel_is_full`)
- `text` — the full server error message
- `nick` — bot's own nick

### 1.2 Dispatch join errors from IRC bridge

**File:** `src/irc-bridge.ts`

Add an `irc error` listener that dispatches `join_error` events for the four join-error numerics. Map irc-framework's error names to `command` values:

```
channel_is_full       -> join_error, command='channel_is_full'
invite_only_channel   -> join_error, command='invite_only_channel'
banned_from_channel   -> join_error, command='banned_from_channel'
bad_channel_key       -> join_error, command='bad_channel_key'
```

Also handle the 477 numeric (`need_registered_nick`) via the `unknown command` listener — same dispatch pattern.

### 1.3 Add mask matching for `join_error` in dispatcher

**File:** `src/dispatcher.ts`

Add a case in `matchesMask()` for `join_error`. Mask matches against `command` (the error reason), similar to how `mode` matches against the mode string. Wildcard `*` matches all join errors.

### 1.4 Tests

- Verify `join_error` events are dispatched for each of the 4 error types
- Verify mask matching: `bind('join_error', '-', 'banned_from_channel', handler)` fires only for bans
- Verify `bind('join_error', '-', '*', handler)` fires for all error types

**Checklist:**

- [x] Add `'join_error'` to `BindType` union in `src/types.ts`
- [x] Add `irc error` listener in `src/irc-bridge.ts` that dispatches `join_error` for 471/473/474/475
- [x] Add `unknown command` handler for 477 -> `join_error` with `command='need_registered_nick'`
- [x] Add `join_error` case in `matchesMask()` in `src/dispatcher.ts`
- [x] Add tests: dispatch, mask matching, wildcard

---

## Phase 2: Expose configured channel keys to plugins

**Goal:** Plugins can look up the configured key for a channel, fixing the existing gap where kick-rejoin calls `api.join(channel)` without a key.

### 2.1 Add `getChannelKey()` to PluginAPI

**File:** `src/types.ts` (PluginAPI interface)

```typescript
/** Get the configured channel key (from bot.json), or undefined if none. */
getChannelKey(channel: string): string | undefined;
```

### 2.2 Implement in plugin-loader

**File:** `src/plugin-loader.ts`

Implement `getChannelKey` by looking up the channel in `bot.configuredChannels` (case-insensitive via `ircLower`). Return the `key` property if present.

### 2.3 Fix existing kick-rejoin to use key

**File:** `plugins/chanmod/protection.ts`

Update the two `api.join(channel)` calls in the kick handler (lines ~146, ~158) to pass the configured key:

```typescript
api.join(channel, api.getChannelKey(channel));
```

### 2.4 Tests

- Verify `getChannelKey` returns the key for a keyed channel
- Verify `getChannelKey` returns undefined for a keyless channel
- Verify case-insensitive lookup

**Checklist:**

- [x] Add `getChannelKey(channel: string): string | undefined` to `PluginAPI` in `src/types.ts`
- [x] Implement in `src/plugin-loader.ts` using `bot.configuredChannels`
- [x] Fix `api.join(channel)` -> `api.join(channel, api.getChannelKey(channel))` in kick-rejoin (2 call sites)
- [x] Add tests: keyed channel, keyless channel, case-insensitive lookup

---

## Phase 3: Join error recovery in chanmod

**Goal:** When chanmod sees a `join_error`, it asks ChanServ for help and retries.

### 3.1 Join error handler

**File:** `plugins/chanmod/protection.ts` (or new file `plugins/chanmod/join-recovery.ts`)

Bind to `join_error` with mask `*` and dispatch based on `ctx.command`:

| Error                  | Guard                      | Action                                      | Retry                                          |
| ---------------------- | -------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `banned_from_channel`  | `chain.canUnban(channel)`  | UNBAN + INVITE (bypasses +k/+i/+l stacking) | Join after 3s delay                            |
| `invite_only_channel`  | `chain.canInvite(channel)` | INVITE (also bypasses +k and +l)            | Join after 3s delay                            |
| `bad_channel_key`      | `chain.canInvite(channel)` | INVITE (bypasses +k without needing key)    | Join after 3s delay                            |
| `bad_channel_key`      | configured key exists      | — (fallback when no ChanServ)               | `api.join(channel, key)` after 1s delay        |
| `channel_is_full`      | `chain.canInvite(channel)` | INVITE (bypasses +l)                        | Join after 3s delay                            |
| `need_registered_nick` | —                          | Log only                                    | No retry (NickServ identification is separate) |

**Key insight:** ChanServ INVITE bypasses +i, +k, AND +l simultaneously. An attacker who sets `+k +i +l +b` and kicks the bot can be defeated with UNBAN + INVITE — the bot never needs to know the attacker's key. The configured key from `bot.json` is only used as a fallback when there is no ChanServ access.

The 3-second delay after ChanServ requests gives services time to process the UNBAN/INVITE before the bot retries the join.

### 3.2 Exponential backoff cooldown

Track per-channel recovery attempts:

```typescript
interface JoinRecoveryState {
  lastAttempt: number;
  backoffMs: number; // starts at 30_000, doubles each attempt, caps at 300_000
}
```

- On `join_error`: check if `Date.now() - lastAttempt < backoffMs`. If within cooldown, skip.
- On recovery attempt: update `lastAttempt = Date.now()`, double `backoffMs` (cap at 5 min).
- On successful join (`join` event for bot's own nick): reset the backoff for that channel.

Store in `SharedState` (in-memory, not DB — resets on restart which is the right behavior since the ban state may have changed).

### 3.3 Integration with existing kick handler

The kick handler in `protection.ts` already does UNBAN + rejoin. The new join-error handler covers a different case: the bot was banned _before_ joining (e.g., on startup, or after a netsplit rejoin). These two paths should share:

- The same `ProtectionChain` for ChanServ requests
- The same backoff state (a kick-rejoin that fails with 474 shouldn't reset the backoff)

### 3.4 Log messages

```
[plugin:chanmod] Cannot join #channel: banned — requesting ChanServ UNBAN (backoff: 30s)
[plugin:chanmod] Cannot join #channel: invite only — requesting ChanServ INVITE (backoff: 30s)
[plugin:chanmod] Cannot join #channel: bad key — retrying with configured key
[plugin:chanmod] Cannot join #channel: channel is full — no remedy, waiting for periodic rejoin
[plugin:chanmod] Join recovery for #channel on cooldown (next attempt in 45s)
```

### 3.5 Tests

- `banned_from_channel` -> UNBAN requested + rejoin after delay
- `invite_only_channel` -> INVITE requested + rejoin after delay
- `bad_channel_key` -> rejoin with key (no ChanServ)
- `channel_is_full` -> no action, just log
- Backoff: first attempt at 30s, second at 60s, third at 120s, caps at 300s
- Backoff resets on successful join
- No ChanServ request when `canUnban()` returns false (no access)
- No recovery when chanmod is not configured for the channel

**Checklist:**

- [x] Create `plugins/chanmod/join-recovery.ts` with `setupJoinRecovery()` function
- [x] Bind to `join_error` with mask `*`
- [x] Handle `banned_from_channel`: guard on `canUnban`, request UNBAN, delayed rejoin with key
- [x] Handle `invite_only_channel`: guard on `canInvite`, request INVITE, delayed rejoin with key
- [x] Handle `bad_channel_key`: guard on `getChannelKey`, retry with key
- [x] Log-only for `channel_is_full` and `need_registered_nick`
- [x] Implement exponential backoff state in `SharedState` (30s -> 60s -> 120s -> 300s cap)
- [x] Reset backoff on successful join (bind `join` for bot's own nick)
- [x] Wire into chanmod `init()` — pass ProtectionChain and SharedState
- [x] Add tests: all 5 error types, backoff progression, backoff reset, access guards

---

## Phase 4: Fix periodic presence check to use keys

**Goal:** The bot-level periodic rejoin (every 30s) should always pass the configured key.

This is already correct in `connection-lifecycle.ts:303`:

```typescript
client.join(ch.name, ch.key);
```

The `configuredChannels` array carries keys. Verify this works and add a test if missing.

**Checklist:**

- [x] Verify `startChannelPresenceCheck` passes `ch.key` (already does — line 303)
- [x] Add test if not already covered (tests/core/channel-presence.test.ts:147-152)

---

## Phase 5: Documentation

- [x] Update `docs/BOTLINK.md` or chanmod README with join-error recovery behavior
- [x] Update `docs/SECURITY.md` if relevant (ChanServ recovery as defense-in-depth) — not security-relevant, skipped
- [x] Add CHANGELOG entry under `[Unreleased] > Added`

---

## Verification

After all phases:

1. Start bot with a channel where it's banned -> should UNBAN + join automatically
2. Start bot with a +i channel where it has ChanServ access -> should INVITE + join
3. Start bot with a +k channel with correct key in config -> should retry with key
4. Verify backoff: disconnect bot, ban it, reconnect. First recovery at 30s, second at 60s.
5. Verify backoff reset: after successful join, next failure starts at 30s again.
6. `pnpm test` — full suite passes
7. `pnpm exec tsc --noEmit` — no type errors

---

## What Eggdrop Does

Eggdrop has four channel-level flags that fire TCL scripts when the bot can't join:

| Flag          | Trigger                    | Default action                                |
| ------------- | -------------------------- | --------------------------------------------- |
| `need-unban`  | Bot is banned from channel | `putserv "PRIVMSG ChanServ :unban #channel"`  |
| `need-invite` | Channel is invite-only     | `putserv "PRIVMSG ChanServ :invite #channel"` |
| `need-key`    | Bad or missing channel key | Retry with configured key                     |
| `need-limit`  | Channel is full            | No default (TCL script can request invite)    |

These are some of the most commonly configured Eggdrop features. They fire on the IRC 471-475 numerics. The bot retries the join after a configurable delay. HexBot's implementation follows the same model but integrates with the existing ProtectionChain backend system instead of raw TCL scripts.
