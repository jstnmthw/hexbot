# Should the ai-chat rate limiter be burst-oriented instead of cooldown-oriented?

## Context

The ai-chat plugin currently uses a layered rate limiter with four tiers:

1. **Per-user cooldown** (30s) -- a hard timestamp: one user, one response, then
   wait 30 seconds. No burst allowance.
2. **Per-channel cooldown** (10s) -- same model: any response in a channel blocks
   all users in that channel for 10 seconds.
3. **Global RPM** (10/min) -- sliding window of timestamps. Blocks at capacity.
4. **Global RPD** (800/day) -- sliding window. Blocks at capacity.

Admin bypass was recently added: users with `+m` skip layers 1 and 2, but layers
3 and 4 still apply. The engagement window (60s) lets a user who just got a
response continue talking to the bot without re-addressing it, but the user
cooldown still applies -- so the engagement window lets you _trigger_ a response
without saying the bot's name, but you still wait 30 seconds between responses.

### The problem

IRC conversation is bursty. A user asks a question, the bot answers, the user
follows up with "wait, what about X?", and the bot should answer again. This
exchange might produce 4-5 bot responses in 2 minutes, then nothing for 20
minutes. The current cooldown model forces this:

```
00:00  alice: hexbot, what's the difference between TCP and UDP?
00:02  hexbot: TCP is connection-oriented with reliable delivery... [LLM ~2s]
00:05  alice: but when would I actually use UDP?
       (engagement window sees this as continuation, triggers response)
       (user cooldown: 30s - 3s elapsed = blocked for 27 more seconds)
00:32  hexbot: UDP is great for real-time applications... [finally allowed]
00:33  alice: oh interesting, like video streaming?
       (blocked again for 30s)
01:03  hexbot: Exactly, also gaming, DNS lookups...
```

That 27-second gap kills the conversation. Alice is going to lose interest or
change topics. Meanwhile the bot has used 3 of its 10 RPM budget and has plenty
of headroom.

With two users the problem is worse. Bob tries to join the conversation:

```
00:05  alice: but when would I actually use UDP?
00:06  bob: hexbot, is QUIC basically UDP?
       (channel cooldown: 10s since alice's response at 00:02, OK)
       (user cooldown for bob: first call, OK)
       (but alice is still blocked for 27s)
```

The per-channel cooldown also means that alice triggering a response can block
bob's entirely separate question, even though the two have nothing to do with
each other.

### What this analysis covers

1. What algorithm should replace the per-user/per-channel cooldown?
2. How should multiple simultaneous users in the same channel be handled?
3. How should the bot transition from "active conversation" to "cooling down"?
4. What abuse protection replaces the cooldown?

---

## Option A: Token Bucket per User (Burst-Oriented)

_Replace cooldowns with a per-user token bucket that allows bursts but enforces a
sustained rate._

### How it works

Each user gets a token bucket with:

- **Capacity** (burst): 3 tokens (3 rapid-fire exchanges)
- **Refill rate**: 1 token per 15 seconds (sustained rate: 4/min)
- Bucket starts full

```
00:00  alice asks  -> spend 1 token (2 remaining)
00:02  hexbot responds
00:05  alice follows up -> spend 1 token (1 remaining)
00:07  hexbot responds
00:10  alice follows up -> spend 1 token (0 remaining)
00:12  hexbot responds
00:13  alice follows up -> bucket empty, wait ~3 seconds for next token
00:15  hexbot responds (token refilled at 00:15)
00:18  alice follows up -> bucket empty again, wait 12 seconds
00:30  hexbot responds
```

The conversation flows for the first 3 exchanges with no artificial delay.
After the burst is consumed, the user naturally slows to one response per 15
seconds -- still faster than the current 30-second cooldown, but rate-limited.

### Channel isolation

Drop the per-channel cooldown entirely. Each user has their own independent
bucket. Bob's question doesn't interfere with alice's conversation and vice
versa. The global RPM cap (10/min) is the shared ceiling.

### Configuration

```json
{
  "rate_limits": {
    "user_burst": 3,
    "user_refill_seconds": 15,
    "global_rpm": 10,
    "global_rpd": 800,
    "ambient_per_channel_per_hour": 5,
    "ambient_global_per_hour": 20
  }
}
```

### Analysis

- **Pro**: First 3 exchanges feel instant -- matches IRC conversation rhythm
- **Pro**: Simple to understand, implement, and explain to users
- **Pro**: Per-user isolation means multi-user conversations Just Work
- **Pro**: Naturally degrades: burst for conversation, steady-state rate for
  sustained use
- **Pro**: Token bucket is the same pattern used by `message-queue.ts` for IRC
  output flood protection -- proven in this codebase
- **Con**: No awareness of conversation context -- a user gets the same burst
  whether they're having a real conversation or spamming questions
- **Con**: A troll with 3 accounts gets 3x the burst
- **Con**: With 3 active users each at burst, you hit 9 RPM instantly
  (10 RPM cap gives ~1 RPM of headroom)
- Complexity: **Low**

---

## Option B: Per-Channel Conversation Slots

_The bot allocates attention per-channel: one active conversation at a time,
with a queue for others._

### How it works

Each channel has a **conversation slot**. When alice addresses the bot:

1. She claims the slot. Her messages get fast-tracked (no per-user cooldown).
2. The slot has an inactivity timeout (e.g. 30s with no messages from alice).
3. While alice holds the slot, bob's message gets a brief reply:
   `"Give me a sec, talking to alice"` or is silently queued.
4. When alice's slot expires (she stops talking), the next queued user gets it.

### The "IRC regular" parallel

This mimics how humans work on IRC. If someone asks you a question and you're
answering, a second person's question gets a "one sec" or gets answered after
the first conversation naturally ends. Bots that try to interleave two
conversations in the same channel look schizophrenic.

### Analysis

- **Pro**: Prevents the bot from looking chaotic in busy channels
- **Pro**: Conversation context stays coherent (no interleaving)
- **Pro**: Natural rate limiting -- one conversation at a time caps throughput
- **Con**: Terrible UX when alice walks away without "ending" the conversation --
  bob waits 30 seconds for nothing
- **Con**: Frustrating for bob: "the bot is ignoring me"
- **Con**: Doesn't match how the context manager works -- it already tracks
  all speakers in a channel and sends multi-user history to the LLM
- **Con**: The bot can actually handle interleaved conversations because the
  LLM sees `[alice]` and `[bob]` prefixes in the context window
- **Con**: Artificially limits throughput when headroom exists
- **Con**: What happens in PM? Slots don't apply.
- Complexity: **Medium-High**

This is over-engineered for the problem. IRC bots that try to lock onto one
user per channel feel worse than ones that freely respond to whoever addresses
them.

---

## Option C: Hybrid Burst + Conversation-Aware Cooldown

_Token bucket for burst, with the cooldown adapting based on whether the user is
in an active conversation._

### How it works

Two modes per user per channel:

**Conversation mode** (entered when the bot responds to a user):

- Token bucket: 4 burst, refill 1 per 10 seconds
- Engagement window: 60 seconds (already exists)
- Mode exits after 60 seconds of silence from the user

**Background mode** (default when not in conversation):

- Flat cooldown of 15 seconds (lower than the current 30s)
- First message switches to conversation mode

The key insight: once a conversation starts, the rate limiter relaxes to allow
natural back-and-forth. When the conversation ends (user goes quiet), the bot
returns to a more conservative posture.

### Multi-user handling

Each user independently enters/exits conversation mode. The channel cooldown is
removed. Multiple users can be in conversation mode simultaneously -- the global
RPM cap is the ceiling.

### Burst protection at the RPM level

With 4 burst per user and potentially 3 users in conversation mode
simultaneously, the burst could hit 12 requests in 30 seconds -- exceeding the
15 RPM Gemini limit. The global RPM layer already handles this: when global RPM
is near capacity, individual requests queue or get a "busy" response.

However, the current RPM check is binary (allow/block). A smarter approach:
when RPM usage is above 80% capacity (8 of 10 used in the current minute),
reduce the per-user burst to 1. This creates graceful degradation instead of
hard-blocking.

### Configuration

```json
{
  "rate_limits": {
    "conversation_burst": 4,
    "conversation_refill_seconds": 10,
    "background_cooldown_seconds": 15,
    "engagement_window_seconds": 60,
    "global_rpm": 10,
    "global_rpd": 800,
    "rpm_backpressure_threshold": 0.8,
    "ambient_per_channel_per_hour": 5,
    "ambient_global_per_hour": 20
  }
}
```

### Analysis

- **Pro**: Best of both worlds: fast conversations, conservative background
- **Pro**: Conversation mode aligns with the engagement window that already exists
- **Pro**: RPM backpressure prevents burst storms from multiple users
- **Pro**: Naturally self-regulating: conversations end, budget recovers
- **Con**: Two modes means more state to track and more edge cases
- **Con**: Mode transitions need careful handling (what if user sends one message
  every 59 seconds -- do they stay in conversation mode forever?)
- **Con**: Harder to explain to users than a simple token bucket
- Complexity: **Medium**

---

## Option D: Simple Token Bucket + Adaptive RPM Sharing

_Option A's simplicity, with a mechanism to prevent burst storms when multiple
users are active._

### How it works

Per-user token bucket (same as Option A):

- Burst: 3 tokens
- Refill: 1 per 12 seconds (5/min sustained)

Plus **adaptive RPM sharing**: the effective per-user refill rate is divided by
the number of recently-active users. "Recently active" = had a bot response in
the last 2 minutes.

```
1 active user:  refill = 1 per 12s  (5/min effective)
2 active users: refill = 1 per 24s  (2.5/min each, 5/min total)
3 active users: refill = 1 per 36s  (1.7/min each, 5/min total)
```

The burst is unaffected -- everyone gets their initial 3 rapid exchanges. The
adaptive rate only kicks in after the burst is consumed, and only when multiple
users are competing for the same global RPM budget.

### Why this works for the Gemini free tier

With 15 RPM hard limit and 10 RPM configured limit (leaving 5 RPM headroom for
ambient + overhead):

- 1 user: 3 burst + 5/min sustained. Can sustain a long conversation.
- 2 users: 3 burst each (6 total burst), then 2.5/min each. Comfortable.
- 3 users: 3 burst each (9 total burst), then 1.7/min each. Tight but works.
- 4+ users: burst still works, sustained rate drops below 1.5/min each. At this
  point one response every 40 seconds per user is OK -- the channel is busy
  enough that no one is staring at the bot waiting.

### Analysis

- **Pro**: Elegant scaling -- more users = slower per-user rate, but total
  throughput stays bounded
- **Pro**: Burst is always available, never degraded for the first N messages
- **Pro**: No mode transitions, no conversation tracking -- just math
- **Pro**: Global RPM becomes the authoritative limit; per-user buckets ensure
  fairness
- **Con**: The adaptive refill adds complexity over a pure token bucket
- **Con**: User might not understand why their rate changed ("I was getting fast
  responses and now it's slow" -- because bob started talking)
- **Con**: Need to define "recently active" carefully to avoid ghost users
  dragging down the rate
- Complexity: **Low-Medium**

---

## Recommendation

### Build Option A (Simple Token Bucket) with elements of Option D's adaptive sharing.

**Confidence: High**

Here is the specific design:

### Per-user token bucket

Replace `userCooldownSeconds` and `channelCooldownSeconds` with a single
per-user token bucket:

```typescript
interface UserBucket {
  tokens: number; // current available tokens
  lastRefill: number; // timestamp of last refill calculation
}
```

Parameters:

- `userBurst`: 3 (default) -- max tokens a user can accumulate
- `userRefillSeconds`: 12 (default) -- seconds per token refill

Bucket mechanics (same as `message-queue.ts`):

1. On check: refill tokens based on elapsed time since last refill
2. If tokens >= 1: allow, then deduct 1 on record()
3. If tokens < 1: block, retryAfterMs = time until next token

### Drop the per-channel cooldown

The per-channel cooldown was protecting against "one user triggers a response,
blocking the whole channel for 10 seconds." With per-user buckets, this is
unnecessary. Each user has their own bucket. The global RPM is the shared
ceiling.

### Keep the engagement window

The engagement window (60 seconds) already exists and serves a different
purpose: it determines whether a follow-up message triggers a response without
re-addressing the bot. It does not need to interact with the rate limiter at all
-- it is a trigger-layer concern, not a rate-limit-layer concern.

### Admin bypass: unchanged

Admins already bypass per-user/per-channel cooldowns via `checkGlobal()`. With
the new model, admins bypass the per-user token bucket. Global RPM/RPD still
applies.

### Session/game bypass: unchanged

Game sessions already use `checkGlobal()` to bypass per-user cooldowns. This
continues to work.

### Global RPM backpressure (from Option D)

Add a soft backpressure mechanism when the RPM window is filling up:

```typescript
checkWithBackpressure(userKey: string, now?: number): RateCheckResult {
  // Check global RPM/RPD first (hard limits)
  const global = this.checkGlobal(now);
  if (!global.allowed) return global;

  // Soft backpressure: if RPM > 80% capacity, halve the effective burst
  const rpmUsage = this.minuteWindow.length / this.config.globalRpm;
  const effectiveBurst = rpmUsage > 0.8
    ? Math.max(1, Math.floor(this.config.userBurst / 2))
    : this.config.userBurst;

  // Check user bucket with effective burst
  return this.checkUserBucket(userKey, effectiveBurst, now);
}
```

This prevents 3 users all bursting at once from slamming into the RPM hard
limit. When RPM is under pressure, each user's effective burst drops from 3 to
1, smoothing the demand curve without hard-blocking anyone.

### Abuse protection

The current cooldown model provides implicit abuse protection: a user can only
get one response per 30 seconds. With burst, a troll can get 3 responses in 10
seconds. Mitigations:

1. **Token budget (already exists)**: 50,000 tokens/user/day. A troll burning
   burst tokens at 3 per burst is also burning token budget 3x faster. The
   budget cap still applies.

2. **Ignore list (already exists)**: `!ai ignore <nick|hostmask>` for persistent
   trolls.

3. **Bot detection (already exists)**: `isLikelyBot()` pattern matching.

4. **Dispatcher flood check (already exists)**: The dispatcher's own
   `floodCheck()` (5 messages per 10 seconds) fires before the ai-chat plugin
   even sees the message. A user spamming the channel fast enough to be abusive
   will be flood-blocked at the dispatcher level.

5. **RPM cap**: Even with burst, 10 RPM is the ceiling. A troll with one nick
   can burn 3 burst tokens and then is rate-limited to 5/min sustained. That is
   30 seconds of disruption at most before the system self-corrects.

No additional abuse protection is needed. The existing layers handle it.

### What about Eggdrop?

Eggdrop's approach to bot flood protection is relevant background:

- **Output flood protection**: Eggdrop has a message queue with configurable
  burst and sustained rate (`flood-msg` and `flood-ctcp` settings). HexBot
  already has this in `message-queue.ts` with the same token-bucket pattern.

- **Input flood protection**: Eggdrop uses per-user message rate limits with
  configurable thresholds (`flood-chan`, `flood-deop`, `flood-kick`, etc.) that
  trigger an ignore or ban on the offending user. HexBot's dispatcher already
  has input flood checks.

- **No per-module cooldown**: Eggdrop does not rate-limit individual TCL script
  binds. The flood protection is at the transport layer (input flood) and output
  layer (message queue). Individual scripts can fire as fast as they want; the
  message queue throttles what actually goes to the network.

This supports the design: let the transport layers (dispatcher flood check for
input, message queue for output) handle flood protection. The ai-chat rate
limiter should focus on protecting the LLM API budget, not duplicating IRC flood
protection.

### Migration path

The `RateLimiter` class needs these changes:

1. Replace `userLastCall` Map with `userBuckets: Map<string, UserBucket>`
2. Replace `channelLastCall` Map with nothing (drop it)
3. Replace `check(userKey, channelKey)` with `check(userKey)` (channel key
   no longer needed for the cooldown check)
4. Add `refillBucket()` method (same math as `message-queue.ts`)
5. Add backpressure logic to `check()`
6. Keep `checkGlobal()`, `checkAmbient()`, `recordAmbient()`, `record()`,
   `reset()` unchanged

Config migration:

```json
// Old
"rate_limits": {
  "user_cooldown_seconds": 30,
  "channel_cooldown_seconds": 10,
  "global_rpm": 10,
  "global_rpd": 800
}

// New
"rate_limits": {
  "user_burst": 3,
  "user_refill_seconds": 12,
  "global_rpm": 10,
  "global_rpd": 800,
  "rpm_backpressure_pct": 80
}
```

The `RateLimiterConfig` interface drops `userCooldownSeconds` and
`channelCooldownSeconds`, adds `userBurst`, `userRefillSeconds`, and
`rpmBackpressurePct`. The `RateCheckResult.limitedBy` type drops `'channel'`
as a possible value.

Call sites in `index.ts` and `assistant.ts` that pass `channelKey` to
`check()` simplify to just passing `userKey`.

### Concrete conversation comparison

Current system (30s user cooldown, 10s channel cooldown):

```
00:00  alice: hexbot, explain TCP vs UDP
00:02  hexbot: [response]
00:04  alice: what about QUIC?        -- BLOCKED (26s remaining)
00:30  hexbot: [response]             -- 26s wait
00:31  bob: hexbot, unrelated question -- BLOCKED (channel: 1s left)
00:32  hexbot: [response to bob]
```

Proposed system (3 burst, 12s refill):

```
00:00  alice: hexbot, explain TCP vs UDP  -- spend 1 (2 left)
00:02  hexbot: [response]
00:04  alice: what about QUIC?            -- spend 1 (1 left)
00:06  hexbot: [response]
00:08  alice: and how does QUIC handle loss? -- spend 1 (0 left)
00:10  hexbot: [response]
00:12  alice: one more question           -- 0 tokens, refill at 00:12, spend 1
00:14  hexbot: [response]
00:15  bob: hexbot, unrelated question    -- bob's bucket: 3 tokens, spend 1
00:17  hexbot: [response to bob]
```

Four bot responses in 14 seconds for alice. Bob is not blocked at all. Total: 5
responses in 17 seconds = ~18 RPM instantaneous, but the burst is over and both
users are now on sustained rate. Global RPM (10/min) would start soft-blocking
at this point via backpressure.

---

## Appendix: Gemini free tier budget math

Hard limits:

- 15 RPM (requests per minute)
- 1000 RPD (requests per day)
- 250,000 TPM (tokens per minute)

Configured limits (conservative, leaving headroom):

- 10 RPM
- 800 RPD

Daily budget at 800 RPD:

- 8 hours of active use: 100 RPH = ~1.7 RPM average
- 16 hours of light use: ~25 RPH = ~0.4 RPM average
- Ambient budget: 5 per channel per hour, 20 global per hour

The burst model does not change the daily budget. It changes the _distribution_:
instead of evenly-spaced responses (one every 30s), responses cluster during
conversations and go silent between them. Total daily usage stays the same or
decreases (because conversations complete faster, reducing the number of
follow-up messages needed to get an answer).

## Appendix: Token bucket implementation sketch

```typescript
interface UserBucket {
  tokens: number;
  lastRefill: number;
}

class BurstRateLimiter {
  private userBuckets = new Map<string, UserBucket>();
  private minuteWindow: number[] = [];
  private dayWindow: number[] = [];

  constructor(private config: {
    userBurst: number;        // max tokens per user (default 3)
    userRefillSeconds: number; // seconds per token refill (default 12)
    globalRpm: number;
    globalRpd: number;
    rpmBackpressurePct: number; // 0-100, default 80
  }) {}

  check(userKey: string, now = Date.now()): RateCheckResult {
    // 1. Prune global windows
    this.minuteWindow = this.minuteWindow.filter(t => now - t < 60_000);
    this.dayWindow = this.dayWindow.filter(t => now - t < 86_400_000);

    // 2. Global RPD check (hard limit)
    if (this.config.globalRpd > 0 && this.dayWindow.length >= this.config.globalRpd) {
      return { allowed: false, limitedBy: 'rpd', retryAfterMs: /* ... */ };
    }

    // 3. Global RPM check (hard limit)
    if (this.config.globalRpm > 0 && this.minuteWindow.length >= this.config.globalRpm) {
      return { allowed: false, limitedBy: 'rpm', retryAfterMs: /* ... */ };
    }

    // 4. Per-user token bucket with backpressure
    const bucket = this.getOrCreateBucket(userKey, now);
    this.refillBucket(bucket, now);

    // Backpressure: reduce effective burst when RPM is high
    const rpmPct = this.minuteWindow.length / this.config.globalRpm;
    const threshold = this.config.rpmBackpressurePct / 100;
    const effectiveBurst = rpmPct > threshold
      ? Math.max(1, Math.floor(this.config.userBurst / 2))
      : this.config.userBurst;

    // Cap tokens at effective burst
    bucket.tokens = Math.min(bucket.tokens, effectiveBurst);

    if (bucket.tokens < 1) {
      const refillMs = this.config.userRefillSeconds * 1000;
      const elapsed = now - bucket.lastRefill;
      const waitMs = refillMs - elapsed;
      return { allowed: false, limitedBy: 'user', retryAfterMs: Math.max(0, waitMs) };
    }

    return { allowed: true };
  }

  record(userKey: string, now = Date.now()): void {
    const bucket = this.getOrCreateBucket(userKey, now);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    this.minuteWindow.push(now);
    this.dayWindow.push(now);
  }

  private getOrCreateBucket(userKey: string, now: number): UserBucket {
    let bucket = this.userBuckets.get(userKey);
    if (!bucket) {
      bucket = { tokens: this.config.userBurst, lastRefill: now };
      this.userBuckets.set(userKey, bucket);
    }
    return bucket;
  }

  private refillBucket(bucket: UserBucket, now: number): void {
    const refillMs = this.config.userRefillSeconds * 1000;
    const elapsed = now - bucket.lastRefill;
    const newTokens = Math.floor(elapsed / refillMs);
    if (newTokens > 0) {
      bucket.tokens = Math.min(this.config.userBurst, bucket.tokens + newTokens);
      bucket.lastRefill += newTokens * refillMs;  // avoid drift
    }
  }
}
```

## Summary

| Aspect                    | Current                               | Proposed                                            |
| ------------------------- | ------------------------------------- | --------------------------------------------------- |
| Per-user model            | 30s flat cooldown                     | 3-burst token bucket, 12s refill                    |
| Per-channel model         | 10s flat cooldown                     | Removed (per-user buckets are independent)          |
| First exchange latency    | 0s (good)                             | 0s (same)                                           |
| Second exchange latency   | 30s (bad)                             | 0s (burst available)                                |
| Third exchange latency    | 60s (very bad)                        | 0s (burst available)                                |
| Fourth exchange           | 90s                                   | ~12s (first refill wait)                            |
| Multi-user isolation      | No (channel cooldown blocks everyone) | Yes (independent buckets)                           |
| Admin bypass              | Skip user+channel cooldown            | Skip user bucket                                    |
| Abuse protection          | Cooldown is implicit limit            | Token budget + dispatcher flood + RPM cap           |
| RPM overload protection   | Hard block at limit                   | Backpressure at 80% + hard block at limit           |
| Implementation complexity | Low                                   | Low (same token bucket pattern as message-queue.ts) |
| Config change             | Breaking (drop 2 keys, add 3)         | Non-breaking if defaults match old behavior         |
