# How should the bot decide when to reply — engagement window vs. conversational presence?

## Context

The current ai-chat plugin has three orthogonal "when do I reply?" mechanisms stapled together:

1. **`detectTrigger`** (`plugins/ai-chat/triggers.ts`) — direct address, `!ai` command, keyword match, random roll.
2. **`isEngaged`** (`plugins/ai-chat/index.ts:556`) — a fixed-duration timer: after the bot replies to user X in channel C, X's next messages for the next `engagement_seconds` (default **60s**) are treated as conversation continuations and bypass re-addressing.
3. **`AmbientEngine`** (`plugins/ai-chat/ambient.ts`) — separate 30s tick loop that picks spots to speak unprompted: idle remarks, unanswered questions, join/topic reactions, gated by an activity classifier (`dead`/`slow`/`normal`/`active`/`flooding`).

The user (and operator) reports that (2) is a footgun. Real IRC conversations do not respect a 60-second boundary:

- A asks the bot something, reads the reply, gets distracted for three minutes, comes back and types a follow-up with `it` / `that` pronouns. Bot ignores it.
- Meanwhile in a busier channel, 60s is _too long_: Bob has already hijacked the thread into a different topic, and the bot happily replies to A's unrelated follow-up because the clock hasn't expired.

The window is a fixed timer in a domain where there is no fixed "conversation length." It answers the wrong question.

The operator is also considering removing `!ai <message>` as a freeform command and replacing it with: **every channel message gets a probabilistic roll to reply, unless the user is currently engaged (being addressed by / actively addressing the bot), in which case always reply.** Admin/info subcommands (`!ai stats`, `!ai ignore`, `!ai play`, `!ai character`) would remain, only the freeform form would go away.

### Constraints

- **DESIGN.md §4** places all reply gating inside the plugin — core doesn't know about AI.
- **Rate limits and budgets are independent** of engagement (`RateLimiter`, `TokenTracker`). Engagement only decides "would we try"; the limiters decide "can we afford to."
- **Ambient budgets are separate** from triggered replies. If we push more traffic through the "unaddressed" path, that budget line will need to move with it or be re-partitioned.
- **Per-channel character + language** is keyed by channel, not by conversation — no schema change needed for any of the options below.
- **Security carve-out already lives here**: founder post-gate, ignored users, privilege gating, bot-nick filtering, self-talk guard. Any new reply path has to route through `shouldRespondReason()` unchanged.

### What the existing state model already knows

`SocialTracker` (`plugins/ai-chat/social-tracker.ts`) is the underused asset here. It already maintains per-channel:

- Rolling 5-minute activity level (`dead` / `slow` / `normal` / `active` / `flooding`).
- `lastWasBot` — was the most recent message the bot's own?
- `pendingQuestions[]` — unanswered-question queue, with "consumed if another human replies" logic.
- `activeUsers` map — per-nick `lastSeen` + message count inside the 5-minute window.

Ambient participation already uses this; the triggered-reply path ignores it entirely.

## Options

### Option A: Tune the knob (long timer, keep everything else)

Bump `engagement_seconds` default from 60 to 300–900, leave the rest of the machinery intact.

- **Pro** — one-line change, solves the common footgun for the "user is thinking" case.
- **Pro** — easy to revert.
- **Con** — trades the short-window footgun for a long-window footgun: the bot will reply to a user's unrelated side-chat minutes after the original exchange ended, with no awareness that the thread died or someone else took the floor.
- **Con** — still has no concept of "someone else replied, so the thread is over."
- **Con** — doesn't address the `!ai` removal question.
- **Effort** — S. Config default only.
- **Compat** — fully backwards-compatible.

### Option B: Thread-based engagement (replace timer with floor-holding)

Replace the fixed timer with state that tracks who "has the floor" in a channel:

- **Start**: when the bot replies to user X addressing it (direct / keyword / `!ai` / random-picked-X), X becomes the _engaged_ user.
- **Extend**: each bot↔X exchange resets a soft "silence" clock.
- **End** when any of:
  - **Another human speaks in the channel** (the canonical "thread is over" signal in IRC — also how `SocialTracker` already clears `pendingQuestions`).
  - **X addresses someone else by name** (opt-out by the engaged user themselves).
  - **X hasn't said anything in the channel for N minutes** (soft ceiling — 5–10 min feels right).
  - **Hard ceiling** of 30 min since last exchange regardless of activity (stops stale engagement from haunting the channel forever).
  - **X parts / kicks / disconnects**.

While X is engaged, any message from X in that channel bypasses the random roll and triggers a reply. Direct address from anyone (even a non-engaged user) still works as today.

- **Pro** — matches how IRC conversations actually end: someone else talks, or everyone drifts away.
- **Pro** — reuses `SocialTracker.lastWasBot` and can reuse the "different nick spoke" logic already in `onMessage()`.
- **Pro** — solves both footguns: the 3-min-reply case (still engaged if no one else spoke) and the 60s-but-Bob-stole-the-thread case (engagement ended).
- **Pro** — per-channel state, not per-user-timer — naturally handles multi-user channels.
- **Con** — more state. The `engagement: Map<string,number>` in index.ts:556 grows to a small object with last-exchange-at + "is this still live?" derivation. Not much more code, but more test surface.
- **Con** — "addresses someone else by name" needs a nick list from `ChannelState`; cheap but a new dependency.
- **Con** — edge case: two users both engaged concurrently. Need to decide — allow (track a small Set of engaged nicks per channel, each ending independently) or serialize (most recent wins). I'd allow it; it's rare and serializing is surprising.
- **Effort** — M. One new module (engagement-tracker) or folded into `SocialTracker`. Replaces the existing ~25 lines of timer logic.
- **Compat** — `engagement_seconds` config key retires (or becomes the hard-ceiling value). Everything else unchanged.

### Option C: Roll-based ambient + thread engagement + drop `!ai <freeform>` (the operator's proposal)

Build on Option B, plus:

1. **Remove the freeform `!ai <message>` path.** Direct address (`neo: …`, `neo?`) is already the natural "I want to talk to the bot" signal. `!ai play`, `!ai ignore`, `!ai character`, `!ai stats`, `!ai iter`, `!ai clear`, `!ai games`, `!ai endgame`, `!ai model`, `!ai characters` all remain — `!ai` becomes a **console for privileged subcommands**, not a chat command.
2. **Make the random-chance roll the primary ambient path.** Every non-bot, non-ignored message in an eligible channel gets a roll. The probability is not flat — it's modulated:
   - **Baseline** — `triggers.random_chance` (currently 0 by default; bump to ~0.02–0.05 for active deployments, plus the character's chattiness trait).
   - **Channel activity** — dampen in `flooding`, boost slightly in `slow`/`normal` (bot feels present in quiet rooms, restrained in busy ones). Already a distinction the ambient engine makes; reuse the same classifier.
   - **Recency bias** — if the message is from someone the bot has interacted with in the last ~15 min (but isn't currently engaged), give a small boost. Reuses `SocialTracker.hasInteractedWithBot` / `UserInteraction`.
   - **Back-to-back prevention** — if `SocialTracker.lastWasBot`, skip the roll entirely (same rule `AmbientEngine` enforces).
3. **Merge the budget accounting** — rolled replies count against the same rate limits that ambient replies currently count against (`ambient_per_channel_per_hour`, `ambient_global_per_hour`), since they have the same "bot speaking unprompted" character. Addressed / engaged replies stay on the per-user bucket.

Result: the reply decision becomes one three-tier rule:

```
if direct_address or is_engaged(user, channel) → always reply (per-user budget)
elif roll(base × channel × recency) succeeds     → reply (ambient budget)
else                                               → skip
```

- **Pro** — collapses three orthogonal mechanisms (trigger detection, engagement timer, ambient engine) into one coherent policy. The bot has "conversational presence" — it's just in the room.
- **Pro** — removes the last footgun of the `!ai` form: users won't accidentally invoke the AI when typing `!ai` as part of a message; they won't be surprised by having two ways to talk to the bot that behave differently.
- **Pro** — aligns with 30 years of IRC chatbot UX (Markov bots, Hailo, etc. all rolled per-message).
- **Pro** — keeps ambient's current event-reaction features (join welcomes, topic reactions) intact — those are still unprompted and benefit from the same budget.
- **Con** — a channel dry-run with a non-zero base chance will feel noisy until operators re-tune. Default must stay low (suggest 0.02, not 0.05).
- **Con** — losing `!ai foo` removes an explicit "I know I'm talking to the bot" affordance for users who don't like tag-based address. Mitigation: direct address already handles this; keyword triggers remain for specific invocations.
- **Con** — "rolled reply" and "triggered reply" now share the founder / ignore / privilege gates at the same point in the pipeline — that's fine, they already do — but the _rate-limit_ story needs to be clearly described so operators know rolled chatter burns the ambient budget, not the user bucket.
- **Con** — the "unanswered-question" ambient path overlaps with rolled-reply-on-a-question. Need to decide which path owns it. Simplest: rolled-reply wins if it fires (same pipeline), ambient fallback is still there for questions nobody rolled for.
- **Effort** — L. Biggest of the three, but most of the pieces exist. Mostly wiring + one config migration + docs.
- **Compat** — config migration: `triggers.command` removes the freeform path (`!ai foo` with no known subcommand can warn once and do nothing, or be dropped silently). `triggers.random_chance` default changes. `ambient.chattiness` stays. Back-compat for deployments with `!ai`-shaped muscle memory is the main friction — acceptable for a 1.x plugin, but document loudly in the CHANGELOG.

### Option D: Keep `!ai` as an escape hatch, add thread engagement and probabilistic ambient

Option C without removing the freeform `!ai`. `!ai foo` still works as an explicit "guaranteed reply" invocation, but the default reply policy is the same three-tier rule.

- **Pro** — least disruptive migration path — nothing that used to work stops working.
- **Pro** — gives users a guaranteed-reply escape hatch when they want one.
- **Con** — doesn't resolve the redundancy — now there are two "guaranteed reply" paths (direct address + `!ai`) doing the same job.
- **Con** — keeps the surprise where users treating `!ai` as a casual prefix trigger get a different pipeline (e.g., admin detection, own rate-limit path) than their next message which falls through to the rolled path.
- **Effort** — L (same as C).
- **Compat** — fully back-compat.

## Recommendation

**Option C, with two caveats:**

1. **Ship it behind a config flag first** — `triggers.model: "legacy" | "presence"` (or similar). `"legacy"` = current fixed-timer + `!ai` freeform behavior. `"presence"` = the three-tier rule. Make `"presence"` the default for new configs via `bot.example.json`; leave existing deployments on `"legacy"` until the operator flips it. This buys you the tuning runway without forcing a breaking change. Retire `"legacy"` in the next major version once the tuning is proven.
2. **Keep `!ai` for subcommands only**, not as a freeform prompt entry point. Users type `!ai` by itself and get `Usage: !ai <subcommand>` plus a short list. Anyone whose muscle memory types `!ai what's the weather` gets no reply — and then types `neo: what's the weather` and gets one. This is the migration teaching itself.

The engagement-window footgun is the real problem the operator is feeling. Option A makes the pain less frequent without fixing the cause. Option B fixes the cause but keeps three separate "reply or not" systems in play. Option C is the unification that the operator's proposal is reaching for — not because `!ai` is evil, but because the current model has three systems answering the same question with three different (and sometimes conflicting) heuristics. Collapse them.

**Confidence: medium-high.** I'm confident the timer is wrong and should be replaced with "floor-holding" semantics (Option B is floor-of-the-room). I'm moderately confident that removing `!ai` freeform is the right call — the one thing that would change my mind is if there's a user group that strongly prefers command-style bots over conversational ones (e.g., channels where `!ai` is used in front of non-regulars who don't know the bot's nick). If that user group matters, land Option D first, watch the telemetry, and drop `!ai` in a follow-up.

## What Eggdrop does

Eggdrop is not an AI chatbot — it's deterministic TCL scripts that bind to PUBM events, so the base case is uninformative. But two relevant patterns from the ecosystem:

- **`pubm` vs `pub` binds** already encode the right split: `pub` is for command prefixes (explicit, authoritative), `pubm` is for pattern-matching channel text (ambient, pattern-gated). The `!ai <freeform>` form is using `pub` as a `pubm` — a Markov chain masquerading as a command. That's exactly the friction the operator feels.
- **MegaHAL / Hailo / classic Markov bots** (community TCL scripts on top of Eggdrop) rolled a per-message probability to speak, with the probability boosted when addressed and a floor-holding rule to avoid back-to-back replies. This is the Option C model, predating this decision by ~25 years. The long-standing default was 1–5% random chance plus "always reply when nick matched." That's the vocabulary Option C is reaching for.

---

**Summary:** Rework engagement from "60-second timer" into "thread-based floor-holding" (Option B), roll the random-chance path into the primary ambient mechanism, and retire `!ai <freeform>` — keeping `!ai` only for admin/info/game subcommands. Ship behind `triggers.model` flag so existing deployments don't break.
