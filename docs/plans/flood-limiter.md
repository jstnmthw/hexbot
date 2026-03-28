# Plan: Per-User Input Flood Limiter

## Summary

Add a per-user input flood limiter inside `EventDispatcher`. When a user exceeds a configurable rate (default: 5 commands in 10 seconds) on `pub`/`pubm` or `msg`/`msgm` bind types, the dispatcher silently drops further dispatches for the remainder of the sliding window. On the **first** dropped message per cooldown window, the dispatcher sends a single IRC NOTICE to the offending user. Users with the `n` (owner) flag bypass the limiter entirely. Configuration lives in `config/bot.json` under a top-level `"flood"` key; if absent, hardcoded defaults apply.

## Feasibility

- **Alignment:** The dispatcher is already the natural rate-limiting layer — it is the single chokepoint through which every `pub`/`pubm`/`msg`/`msgm` event passes. Putting flood protection here (rather than in every plugin) is architecturally correct and matches how the CTCP rate limiter works in `irc-bridge.ts`.
- **Dependencies:** `SlidingWindowCounter` already exists at `src/utils/sliding-window.ts` and is exactly right for this use case. No new npm packages needed.
- **Blockers:** None. The only design question is how the dispatcher sends NOTICEs; resolved via a narrow `FloodNoticeProvider` callback interface (same pattern as `PermissionsProvider` already in the dispatcher).
- **Complexity estimate:** **S (hours)** — all primitives exist; work is wiring them correctly and writing tests.
- **Risk areas:**
  - The dispatcher has no reference to the IRC client. Giving it one directly would create a dependency cycle. Resolved via injected `FloodNoticeProvider` interface.
  - `pub` and `pubm` are dispatched as two separate `dispatch()` calls for the same IRC PRIVMSG (from `onPrivmsg` in `irc-bridge.ts`). The counter must increment only once per originating message. Resolved by calling `dispatcher.floodCheck()` **once** in the bridge before both dispatch calls.

## Dependencies

- [x] `SlidingWindowCounter` — `src/utils/sliding-window.ts` — exists, correct API
- [x] `PermissionsProvider` interface — already defined and injected in dispatcher
- [x] `MessageQueue.enqueue()` — exists, used for notice delivery
- [x] `IRCClient.notice()` — exists on irc-framework client

## Design decisions

### How the dispatcher sends NOTICEs

Define a narrow `FloodNoticeProvider` interface injected via a setter. In `bot.ts`:

```typescript
this.dispatcher.setFloodNotice({
  sendNotice: (nick, msg) => {
    this.messageQueue.enqueue(() => this.client.notice(nick, msg));
  },
});
```

This keeps the dispatcher free of IRC-specific imports and avoids circular references.

### Counter grouping: one check per IRC message

`irc-bridge.ts` `onPrivmsg()` calls `dispatch('pub', ctx)` then `dispatch('pubm', ctx)` sequentially for the same physical PRIVMSG. To avoid double-counting, `floodCheck()` is called **once in the bridge** before both dispatch calls. This is analogous to how `ctcpAllowed()` in the bridge calls `this.ctcpRateLimiter.check()` — the state lives in the dispatcher, the bridge calls one gate method.

### Admin bypass

`floodCheck()` receives a `HandlerContext`. If a `PermissionsProvider` is attached, it calls `checkFlags('n', ctx)` — users with the owner flag bypass flood protection.

### `floodWarned` cleanup

When `counter.check()` returns false for a key that is in `floodWarned`, remove it. This means on the first non-blocked call after the window expires, the key is evicted. The user's next flood episode will send a fresh notice.

### `onAction()` exemption

`/me` actions dispatch only `pubm`/`msgm`. They are not commands and unlikely to be abused like command floods. Flood checking is scoped to `onPrivmsg()` only.

## Phases

### Phase 1: Types and config

**Goal:** Add config shapes and update `BotConfig`.

- [ ] Add `FloodWindowConfig` and `FloodConfig` interfaces to `src/types.ts`
- [ ] Add `flood?: FloodConfig` to the `BotConfig` interface in `src/types.ts`
- [ ] Add a `"flood"` example block to `config/bot.example.json`
- [ ] **Verify:** `pnpm tsc --noEmit` passes cleanly

### Phase 2: Dispatcher flood infrastructure

**Goal:** Implement all flood state and logic inside `EventDispatcher`.

- [ ] Add `FloodNoticeProvider` and `FloodCheckResult` interfaces to `src/dispatcher.ts`
- [ ] Add private flood fields to `EventDispatcher`:
  - `private floodNotice: FloodNoticeProvider | null = null`
  - `private floodConfig: { pub: Required<FloodWindowConfig>; msg: Required<FloodWindowConfig> } | null = null`
  - `private pubFlood = new SlidingWindowCounter()`
  - `private msgFlood = new SlidingWindowCounter()`
  - `private floodWarned = new Set<string>()`
- [ ] Add `setFloodNotice(provider: FloodNoticeProvider): void` setter
- [ ] Add `setFloodConfig(config: FloodConfig): void` setter (merges with defaults `{ count: 5, window: 10 }`)
- [ ] Add public `floodCheck(floodType: 'pub' | 'msg', key: string, ctx: HandlerContext): FloodCheckResult`:
  - If `floodConfig` is null → `{ blocked: false, firstBlock: false }`
  - If permissions provider returns true for `'n'` flag → `{ blocked: false, firstBlock: false }`
  - If `counter.check(key, windowMs, limit)` is false (not exceeded): remove key from `floodWarned` if present; return `{ blocked: false, firstBlock: false }`
  - If exceeded and key NOT in `floodWarned`: add to `floodWarned`, send notice via `floodNotice`, log `[dispatcher] flood: ${key} (${floodType}) — blocked`; return `{ blocked: true, firstBlock: true }`
  - If exceeded and key IS in `floodWarned`: return `{ blocked: true, firstBlock: false }`
- [ ] **Verify:** Unit tests (Phase 4)

### Phase 3: Wire into irc-bridge and bot

**Goal:** Activate flood checking in the message path.

- [ ] In `src/irc-bridge.ts`, modify `onPrivmsg()`:
  - Build flood key: `nick!ident@hostname` when both ident and hostname are non-empty, else `nick`
  - Channel path: call `this.dispatcher.floodCheck('pub', floodKey, ctx)` before both dispatch calls; if `blocked`, return early
  - PM path: same with `'msg'`
- [ ] In `src/bot.ts`, wire flood providers in the constructor (after queue and client are created):
  ```typescript
  if (this.config.flood) {
    this.dispatcher.setFloodConfig(this.config.flood);
  }
  this.dispatcher.setFloodNotice({
    sendNotice: (nick, msg) => {
      this.messageQueue.enqueue(() => this.client.notice(nick, msg));
    },
  });
  ```
- [ ] **Verify:** `pnpm tsc --noEmit` passes

### Phase 4: Tests

**Goal:** Full coverage of flood logic.

New test file: `tests/core/dispatcher-flood.test.ts`

- [ ] **Disabled by default:** Without `setFloodConfig()`, `floodCheck()` always returns `blocked: false`
- [ ] **Below threshold:** 4 rapid calls at `count: 5` — all return `blocked: false`
- [ ] **Threshold hit:** 6th call returns `{ blocked: true, firstBlock: true }`
- [ ] **Subsequent blocks:** 7th, 8th calls return `{ blocked: true, firstBlock: false }`
- [ ] **Notice sent exactly once:** Mock `FloodNoticeProvider`, verify `sendNotice` called exactly once across multiple blocked calls
- [ ] **Window expiry resets:** Advance fake timers past `window` seconds; new calls return `blocked: false`; re-triggering flood sends fresh notice (`firstBlock: true` again)
- [ ] **Owner bypass:** Permissions mock returns true for `'n'`; verify `floodCheck` always returns `blocked: false`
- [ ] **Non-owner not bypassed:** Same setup, `checkFlags` returns false; flood fires normally
- [ ] **pub and msg counters are independent:** Flooding `pub` does not block `msg` calls for same key
- [ ] **Different keys are independent:** Flooding one hostmask does not affect another
- [ ] **Null permissions provider:** No bypass, flood fires normally

Update `tests/irc-bridge.test.ts`:

- [ ] Verify that after N messages from the same nick!ident@host, dispatcher.dispatch is not called
- [ ] Verify owner-flagged users are not blocked at the bridge level

### Phase 5: Documentation

- [ ] Update `DESIGN.md` section on the event dispatcher to note per-user input flood limiting and the `flood` config key
- [ ] Add a doc comment above `floodCheck()` in `dispatcher.ts` describing semantics, grouping rule, and owner bypass

## Config changes

### `config/bot.example.json`

Add after the `"queue"` block:

```json
"flood": {
  "pub": { "count": 5, "window": 10 },
  "msg": { "count": 5, "window": 10 }
}
```

### `src/types.ts`

```typescript
export interface FloodWindowConfig {
  /** Max events allowed within the window. */
  count: number;
  /** Window size in seconds. */
  window: number;
}

export interface FloodConfig {
  pub?: FloodWindowConfig; // covers pub + pubm channel commands
  msg?: FloodWindowConfig; // covers msg + msgm private messages
}
```

Add `flood?: FloodConfig` to `BotConfig`.

## Database changes

None.

## Files to modify

| File                                  | Change                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `src/types.ts`                        | Add `FloodWindowConfig`, `FloodConfig`; add `flood?` to `BotConfig`          |
| `src/dispatcher.ts`                   | Add interfaces, flood state fields, setters, and `floodCheck()`              |
| `src/irc-bridge.ts`                   | Call `dispatcher.floodCheck()` in `onPrivmsg()` before paired dispatch calls |
| `src/bot.ts`                          | Wire `setFloodConfig()` and `setFloodNotice()` in constructor                |
| `config/bot.example.json`             | Add `"flood"` example block                                                  |
| `tests/core/dispatcher-flood.test.ts` | New — all flood scenarios                                                    |
| `tests/irc-bridge.test.ts`            | Add flood integration scenarios                                              |
| `DESIGN.md`                           | Note flood protection in dispatcher section                                  |

## Open questions

None — design is fully resolved. Ready to build.
