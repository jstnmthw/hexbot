# Plan: Token-Bucket Rate Limiter for ai-chat

## Summary

Replace the ai-chat plugin's flat per-user and per-channel cooldowns with a
per-user token bucket that allows natural conversational bursts (3 rapid
exchanges) followed by a sustained refill rate (1 token per 12 seconds). Drop
the per-channel cooldown entirely so users are independently rate-limited. Add
RPM backpressure that halves the effective burst when global RPM usage exceeds
80%, preventing burst storms from multiple simultaneous users. This is a
breaking config change — the pre-release plugin drops `user_cooldown_seconds`
and `channel_cooldown_seconds`, replacing them with `user_burst`,
`user_refill_seconds`, and `rpm_backpressure_pct`.

See `docs/ai-chat-rate-limiting.md` for the full analysis and rationale.

## Feasibility

- **Alignment**: Internal plugin refactor. No DESIGN.md changes needed — the
  plugin architecture doesn't prescribe rate limiting strategy. The token bucket
  pattern is already proven in `src/core/message-queue.ts`.
- **Dependencies**: None beyond what exists. `RateLimiter` is self-contained.
- **Blockers**: None.
- **Complexity**: **S** — the rate limiter is ~166 lines, the new implementation
  is a straightforward token bucket. Call sites are well-mapped (3 files).
- **Risk areas**:
  - `check()` and `record()` signatures lose `channelKey` — 3 call sites in
    `assistant.ts` and `index.ts` must update.
  - `RateCheckResult.limitedBy` drops `'channel'` — callers displaying this
    value need no change (it's already a union string).
  - Backpressure math must be correct — wrong thresholds could over/under-limit.
  - Test suite is tightly coupled to cooldown semantics — full rewrite needed.

## Dependencies

- [x] Token bucket pattern exists in codebase (`src/core/message-queue.ts`)
- [x] `checkGlobal()` for admin/game bypass — unchanged
- [x] `checkAmbient()` / `recordAmbient()` — unchanged (separate budget)

## Phases

### Phase 1: Rewrite `rate-limiter.ts` + tests

**Goal:** Replace the cooldown-based rate limiter with a token bucket. This
phase is self-contained — the module and its tests can be verified in isolation.

#### 1a: Update interfaces

- [ ] In `plugins/ai-chat/rate-limiter.ts`, replace `RateLimiterConfig`:
  - Drop: `userCooldownSeconds`, `channelCooldownSeconds`
  - Add: `userBurst` (number, default 3), `userRefillSeconds` (number, default
    12), `rpmBackpressurePct` (number, default 80)
  - Keep: `globalRpm`, `globalRpd`, `ambientPerChannelPerHour`,
    `ambientGlobalPerHour`
- [ ] In `RateCheckResult`, drop `'channel'` from `limitedBy` union:
      `'user' | 'rpm' | 'rpd'`

#### 1b: Rewrite `RateLimiter` class internals

- [ ] Add `UserBucket` interface: `{ tokens: number; lastRefill: number }`
- [ ] Replace `userLastCall: Map<string, number>` with
      `userBuckets: Map<string, UserBucket>`
- [ ] Remove `channelLastCall: Map<string, number>` entirely
- [ ] Add private `getOrCreateBucket(userKey, now)` method — returns existing
      bucket or creates one at full burst capacity
- [ ] Add private `refillBucket(bucket, now)` method — calculates tokens earned
      since `lastRefill`, caps at `userBurst`, advances `lastRefill` by
      `newTokens * refillMs` to avoid drift (same pattern as `message-queue.ts`)

#### 1c: Rewrite `check()` method

- [ ] New signature: `check(userKey: string, now?: number): RateCheckResult`
      (drop `channelKey` parameter)
- [ ] Order: RPD → RPM → per-user bucket (same precedence as before minus
      channel)
- [ ] After RPM passes, compute backpressure:
  ```
  rpmPct = minuteWindow.length / globalRpm
  threshold = rpmBackpressurePct / 100
  effectiveBurst = rpmPct > threshold
    ? max(1, floor(userBurst / 2))
    : userBurst
  ```
- [ ] Cap `bucket.tokens` at `effectiveBurst` before checking
- [ ] If `bucket.tokens < 1`: return blocked with `limitedBy: 'user'` and
      `retryAfterMs` = time until next refill
- [ ] If tokens available: return `{ allowed: true }`

#### 1d: Update `record()` method

- [ ] New signature: `record(userKey: string, now?: number): void`
      (drop `channelKey` parameter)
- [ ] Deduct 1 token from user's bucket (refill first, then deduct)
- [ ] Push to `minuteWindow` and `dayWindow` as before

#### 1e: Update `reset()` method

- [ ] Clear `userBuckets` instead of `userLastCall`
- [ ] Remove `channelLastCall.clear()`
- [ ] Keep all other clears (minuteWindow, dayWindow, ambient windows)

#### 1f: Update `setConfig()` method

- [ ] Accept new `RateLimiterConfig` shape (no code change needed — it just
      stores the config reference)

#### 1g: Rewrite `tests/plugins/ai-chat-rate-limiter.test.ts`

- [ ] Update `makeLimiter()` helper for new config shape (default: `userBurst: 3,
userRefillSeconds: 12, globalRpm: 10, globalRpd: 100`)
- [ ] **Burst tests**: first N calls (up to burst) are allowed with no delay
- [ ] **Refill test**: after burst exhausted, wait `refillSeconds` and one more
      call is allowed
- [ ] **Sustained rate test**: verify that after burst, calls are rate-limited to
      1 per refillSeconds
- [ ] **Multi-user isolation**: alice and bob have independent buckets — alice
      exhausting hers doesn't affect bob
- [ ] **RPM still enforced**: RPM limit blocks when window is full
- [ ] **RPD still enforced**: RPD limit blocks when window is full
- [ ] **RPD before RPM precedence**: unchanged behavior
- [ ] **Backpressure test**: when RPM usage > 80%, effective burst is halved
      (e.g. burst 3 → 1)
- [ ] **Backpressure recovery**: when RPM usage drops below threshold, full burst
      is restored
- [ ] **Zero-valued limits**: `userBurst: 0` disables per-user limiting;
      `globalRpm: 0` disables RPM
- [ ] **`checkGlobal()` unchanged**: still ignores per-user bucket, enforces
      RPM/RPD only
- [ ] **`reset()` clears buckets**: verify full burst is available after reset
- [ ] **`setConfig()` hot-reload**: config change takes effect on next check
- [ ] **Verify**: `pnpm vitest run tests/plugins/ai-chat-rate-limiter.test.ts`
      passes

### Phase 2: Update config layer and call sites

**Goal:** Wire the new rate limiter into the plugin's config parsing and all
call sites.

#### 2a: Config changes

- [ ] In `plugins/ai-chat/config.json`, replace:
  ```json
  "rate_limits": {
    "user_burst": 3,
    "user_refill_seconds": 12,
    "global_rpm": 10,
    "global_rpd": 800,
    "rpm_backpressure_pct": 80,
    "ambient_per_channel_per_hour": 5,
    "ambient_global_per_hour": 20
  }
  ```
- [ ] In `plugins/ai-chat/index.ts`, update `AiChatConfig.rateLimits` type to
      match new `RateLimiterConfig`
- [ ] In `parseConfig()`, update the `rateLimits` block:
  - Drop: `asNum(rl.user_cooldown_seconds, 30)`,
    `asNum(rl.channel_cooldown_seconds, 10)`
  - Add: `userBurst: asNum(rl.user_burst, 3)`,
    `userRefillSeconds: asNum(rl.user_refill_seconds, 12)`,
    `rpmBackpressurePct: asNum(rl.rpm_backpressure_pct, 80)`

#### 2b: Update `assistant.ts` call sites

- [ ] `respond()` line ~72: drop `channelKey` variable (no longer needed)
- [ ] Line ~77: `rateLimiter.check(userKey)` instead of
      `rateLimiter.check(userKey, channelKey)`
- [ ] Line ~127: `rateLimiter.record(userKey)` instead of
      `rateLimiter.record(userKey, channelKey)`

#### 2c: Update `index.ts` call sites

- [ ] Session handler (~line 831): `rateLimiter.record(userKey)` instead of
      `rateLimiter.record(userKey, channelKey)`
- [ ] Drop `channelKey` variable in session handler if unused after this change

#### 2d: Update downstream tests

- [ ] `tests/plugins/ai-chat-assistant.test.ts`: update any `RateLimiterConfig`
      construction to use new fields; update `check()`/`record()` call assertions
      if mocked
- [ ] `tests/plugins/ai-chat-plugin.test.ts`: update config fixtures for new
      `rateLimits` shape
- [ ] `tests/plugins/ai-chat-admin.test.ts`: update config fixtures if present
- [ ] `tests/plugins/ai-chat-ambient.test.ts`: ambient tests use
      `checkAmbient()`/`recordAmbient()` — no signature change, but config
      fixtures may need updating

#### 2e: Verify

- [ ] Run `pnpm check` (build + typecheck + lint + tests) — all pass

### Phase 3: Rebuild and verify

**Goal:** Final verification that everything is clean.

- [ ] Run `pnpm run build:plugins` to rebuild ai-chat dist
- [ ] Run `pnpm check` — full pass (typecheck + lint + 3234+ tests)
- [ ] Verify no type errors related to `'channel'` in `limitedBy` anywhere

## Config changes

```json
// BEFORE (removed)
"rate_limits": {
  "user_cooldown_seconds": 30,
  "channel_cooldown_seconds": 10,
  "global_rpm": 10,
  "global_rpd": 800,
  "ambient_per_channel_per_hour": 5,
  "ambient_global_per_hour": 20
}

// AFTER
"rate_limits": {
  "user_burst": 3,
  "user_refill_seconds": 12,
  "global_rpm": 10,
  "global_rpd": 800,
  "rpm_backpressure_pct": 80,
  "ambient_per_channel_per_hour": 5,
  "ambient_global_per_hour": 20
}
```

## Database changes

None.

## Test plan

| Test                       | What it verifies                                                 |
| -------------------------- | ---------------------------------------------------------------- |
| Burst allows N rapid calls | Token bucket grants `userBurst` calls without delay              |
| Burst exhaustion blocks    | Call N+1 returns `limitedBy: 'user'` with correct `retryAfterMs` |
| Refill restores tokens     | After waiting `userRefillSeconds`, one more call is allowed      |
| Sustained rate             | After burst, effective rate is 1 per `userRefillSeconds`         |
| Multi-user independence    | Alice and Bob have separate buckets                              |
| RPM enforcement            | Global RPM still blocks at capacity                              |
| RPD enforcement            | Global RPD still blocks at capacity                              |
| RPD > RPM precedence       | RPD block reported before RPM when both full                     |
| Backpressure activates     | When RPM > 80%, burst halves (3 → 1)                             |
| Backpressure deactivates   | When RPM drops below 80%, full burst restores                    |
| `checkGlobal()` bypass     | Admins/games skip per-user bucket, hit RPM/RPD only              |
| `checkAmbient()` unchanged | Ambient budget is independent of user buckets                    |
| `reset()` clears buckets   | After reset, full burst is available                             |
| `setConfig()` hot-reload   | New burst/refill values take effect immediately                  |
| Zero values disable        | `userBurst: 0` → per-user check always passes                    |

## Open questions

None — all decisions resolved.
