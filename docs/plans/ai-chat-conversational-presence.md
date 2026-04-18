# Plan: ai-chat Conversational Presence (Option C)

## Summary

Replace ai-chat's three overlapping reply mechanisms (timer-based engagement, `!ai <freeform>` command, and `detectTrigger` random-chance) with a single unified policy:

1. **Addressed / engaged → always reply** (direct address, mention of bot nick, active thread where bot↔user are still trading turns without another human taking the floor).
2. **Otherwise → probabilistic roll** modulated by channel activity, bot↔user recency, and a back-to-back guard.

The `!ai` prefix is retained **for privileged subcommands only** (`!ai stats`, `!ai ignore`, `!ai character`, `!ai play`, `!ai endgame`, `!ai help`, etc.). Typing `!ai what's the weather?` no longer generates a reply — users address the bot by nick instead.

This is a clean break — no `triggers.model` compatibility flag, no dual paths. The 0.5.0 release notes call out the breaking change.

## Feasibility

**Alignment.** Fits DESIGN.md §4 — all reply gating stays inside the ai-chat plugin. No core module changes. No database schema change.

**Dependencies.** All required pieces exist:

- `SocialTracker` (`plugins/ai-chat/social-tracker.ts`) already tracks `lastWasBot`, activity level, and the "different nick spoke → thread broken" logic in `pendingQuestions`. Engagement can reuse the same signal.
- `RateLimiter.checkAmbient` / `recordAmbient` already exist and are the right home for rolled-reply budget accounting.
- `ChannelState` via `api.getUsers(channel)` gives us a nick list for "addresses someone else by name" detection.
- `AmbientEngine` event-reactions (join/topic/idle/unanswered-question) remain intact and keep their current budget.

**Blockers.** None. Pure plugin refactor.

**Complexity.** **M.** ~1 day of focused work. Biggest surface is tests — the existing `ai-chat-triggers.test.ts`, `ai-chat-plugin.test.ts`, and `ai-chat-admin.test.ts` all reference the old shape.

**Risk areas:**

- **Silent regression in `!ai` muscle memory.** Operators who land 0.5.0 without reading the CHANGELOG will wonder why `!ai hello` stopped working. Mitigation: `!ai` with unrecognised args replies once with a usage hint (`!ai is now a subcommand console — type "neo: hello" to chat, or "!ai help" for subcommands.`) instead of silently dropping.
- **Probabilistic reply tuning.** A miscalibrated `random_chance` default could feel spammy on day one. Mitigation: default stays low (0.02), modulated downward in `active`/`flooding` channels.
- **Engagement semantics interact with game sessions.** A user in a game session is already routed through `runSessionPipeline`; engagement state should not overlap. The session check runs first in `pubm`, so this is already ordered correctly — document and assert it in tests.
- **Two-user concurrent engagement.** Two users can both be engaged simultaneously in the same channel (Alice and Bob both chatting with the bot). Track as a small `Set<string>` per channel, each ending independently.

## Dependencies

- [x] None (all prerequisites exist)

## Phases

### Phase 1: Thread-based engagement tracker

**Goal:** Replace the `engagement: Map<string, number>` timer with a state object that encodes "floor-holding" semantics — engagement ends on another human speaking, user addressing someone else, or configurable soft/hard timeouts.

- [x] Create `plugins/ai-chat/engagement-tracker.ts` exporting `EngagementTracker` class with:
  - `onBotReply(channel: string, nick: string, now?: number): void` — mark user engaged.
  - `onHumanMessage(channel: string, nick: string, text: string, channelNicks: string[], now?: number): void` — called on every non-bot channel message; ends other users' engagement if this is a new speaker, extends this user's engagement if they're engaged, ends this user's engagement if they address someone else by name.
  - `isEngaged(channel: string, nick: string, now?: number): boolean` — true if user is in the channel's engaged set and within soft/hard ceilings.
  - `endEngagement(channel: string, nick: string): void` — explicit end (e.g., on part/kick).
  - `dropChannel(channel: string): void` — clear on bot part/kick.
  - `clear(): void` — teardown.
- [x] State shape: `Map<channelKey, Map<nickKey, { startedAt: number; lastExchangeAt: number }>>`. Size-cap both levels (hard cap per channel ~8, hard cap channels ~256) so nick-rotation floods can't blow memory.
- [x] Constructor takes `{ softTimeoutMs: number; hardCeilingMs: number; now?: () => number }` — no module-level `Date.now()`.
- [x] "Addresses someone else by name" rule: message starts with `<otherNick>:` or `<otherNick>,` where `otherNick` is in `channelNicks` and is not the bot and not the engaged user. Reuses the regex approach from `detectTrigger`.
- [x] "Another human took the floor" rule: message from a nick that is NOT in the channel's engaged set ends all currently-engaged users' engagement in that channel. This is the IRC-native "thread is over" signal — mirrors the `pendingQuestions` clear logic already in `SocialTracker.onMessage`.
- [x] Write `tests/plugins/ai-chat-engagement-tracker.test.ts` covering:
  - Fresh state: `isEngaged` returns false.
  - `onBotReply` marks user engaged; `isEngaged` returns true.
  - `onHumanMessage` from same engaged user extends engagement.
  - `onHumanMessage` from a different human ends other users' engagement.
  - `onHumanMessage` where engaged user addresses a third nick ends that user's engagement.
  - Soft timeout: engaged user silent for `softTimeoutMs` → `isEngaged` false.
  - Hard ceiling: even with continuous exchanges, engagement ends after `hardCeilingMs` from `startedAt`.
  - `dropChannel` clears that channel's engaged set.
  - Two concurrent engaged users in one channel, ended independently.
  - Size caps enforced.
- [x] **Verification:** `pnpm test tests/plugins/ai-chat-engagement-tracker.test.ts` passes. No changes to `index.ts` yet.

### Phase 2: Unified reply policy and rolled-ambient path

**Goal:** Collapse trigger detection + engagement + random-chance into a single decision in the `pubm` handler. Merge rolled-reply budget accounting into the existing ambient budget.

- [x] Delete `isEngaged` / `recordEngagement` / `ENGAGEMENT_MAP_CAP` from `plugins/ai-chat/index.ts:556-581` and the `engagement` field from `PluginState` (`index.ts:52`). Replace the state slot with an `EngagementTracker` instance.
- [x] Wire `EngagementTracker` into `init()`:
  - Inject via `AIChatDeps.engagementTracker` (optional, like existing deps).
  - Default construction reads `config.engagement.softTimeoutMinutes` and `config.engagement.hardCeilingMinutes`.
  - Clear in `teardown()`.
- [x] Update `detectTrigger` in `plugins/ai-chat/triggers.ts`:
  - Remove the `engaged` kind from `TriggerMatch` — engagement is no longer a trigger kind, it's an orthogonal "always reply" predicate.
  - Remove `randomChance` probability logic from `detectTrigger` — move it into a new function `shouldRollReply(ctx, tracker, social) → boolean` (see below).
  - Remove the `command` / `commandPrefix` freeform-match branch from `detectTrigger` — `!ai <foo>` is no longer a chat trigger. The `commandPrefix` field stays (still used by the subcommand console), but `detectTrigger` ignores it.
  - Remove `engagementSeconds` from `TriggerConfig`.
  - `TriggerConfig` becomes: `{ directAddress, keywords, randomChance }`.
- [x] Add `plugins/ai-chat/reply-policy.ts` exporting a pure `decideReply(input) → 'address' | 'engaged' | 'rolled' | 'skip'` function. Inputs: trigger match, engagement state, social tracker snapshot (activity level, lastWasBot, recency), character chattiness, config. Output drives the pipeline branch.
- [x] Probability calculation for `rolled`: `p = randomChance × character.chattiness × activityScale × recencyBoost`, where:
  - `activityScale`: `dead=0.5`, `slow=1.0`, `normal=1.0`, `active=0.5`, `flooding=0` (no rolled reply at all).
  - `recencyBoost`: `1.5×` if `SocialTracker.hasInteractedWithBot(nick)` AND `UserInteraction.lastBotInteraction` within last 15 min, else `1.0×`.
  - Back-to-back guard: if `SocialTracker.isLastMessageFromBot(channel)`, return 0 (same rule `AmbientEngine` enforces).
  - Command-sigil guard: if text starts with `[!./~@%$&+]`, return 0 (matches existing `startsWithCommandSigil` logic — covers `!help`, `.chanset`, `/quit`, etc.).
- [x] Refactor the `api.bind('pubm', ...)` handler in `index.ts:925` to:
  1. Run `shouldRespondReason` (unchanged — still the security gate).
  2. Call `engagementTracker.onHumanMessage(...)` on every non-bot, non-ignored message (needs nicklist from `api.getUsers(channel)`).
  3. Session-route if `sessionManager.isInSession(...)` (unchanged).
  4. Compute `decideReply(...)`:
     - `'address'` → direct address / keyword match / mention — run pipeline with per-user budget via `rateLimiter.check()` / `record()` (the current triggered path).
     - `'engaged'` → user in engagement tracker — run pipeline with per-user budget (same as address).
     - `'rolled'` → probabilistic roll succeeded — run pipeline BUT gate on `rateLimiter.checkAmbient(channel)` first and `recordAmbient(channel)` on success (merges rolled into ambient budget).
     - `'skip'` → debug log and return.
  5. On successful pipeline `ok`, call `engagementTracker.onBotReply(channel, nick)` instead of the deleted `recordEngagement` call.
- [x] `runPipeline` signature gains a `source: 'address' | 'engaged' | 'rolled'` parameter so it knows which rate-limit path to use. The existing `noticeOnBlock` boolean can merge into this (`noticeOnBlock = source !== 'rolled'`).
- [x] Remove the `!ai` command pipeline branch from the `pub` handler that calls `runPipeline(..., true, ...)` — subcommands are handled entirely in `handleSubcommand` (see Phase 3).
- [x] **Verification:**
  - A test-harness pubm replay of "hexbot: hi" → reply (address).
  - Reply followed by same-nick "and also this" within soft window → reply (engaged).
  - Another human speaks between bot and user's follow-up → user's follow-up no longer engaged, falls to rolled path.
  - `randomChance = 0` → zero rolled replies.
  - `randomChance > 0` with `ambient_global_per_hour = 0` → rolled path always blocked.
  - `SocialTracker.lastWasBot = true` → rolled path skipped.

### Phase 3: Retire `!ai <freeform>`, keep subcommand console

**Goal:** `!ai` only dispatches known subcommands. Anything else → one-line usage hint. `handleSubcommand` retains every existing subcommand.

- [x] In `init()`, the `api.bind('pub', ...)` for `cfg.triggers.commandPrefix` (currently `index.ts:1038-1093`) is restructured:
  - Keep the self-talk / bot-nick guards.
  - Keep `contextManager.addMessage(...)` — the user's `!ai foo` message still belongs in context.
  - Call `handleSubcommand(api, cfg, ctx, args)`:
    - If handled → return.
    - If `args` is empty or unrecognised → `ctx.reply` with a short usage string listing subcommands (or a pointer to `.help`), then return.
  - Delete the trailing `runPipeline(..., true, ...)` call — no more freeform reply path from `!ai`.
- [x] `handleSubcommand`: add a `help` subcommand that lists the others (`stats`, `iter`, `reset`, `ignore`, `unignore`, `clear`, `character`, `characters`, `model`, `games`, `play`, `endgame`, `help`). Anyone can run `help`; admin-only entries are marked `[admin]` in the listing.
- [x] `handleSubcommand` unrecognised-sub fallthrough currently returns `false` (which previously meant "treat as freeform prompt"). Change semantics: unknown subcommand → reply with `Unknown subcommand "<x>". Try "!ai help".` and return true.
- [x] Update `registerHelp` entry in `init()` (`index.ts:790-802`):
  - `usage`: `!ai <subcommand>` (not `<message>`).
  - `description`: `AI chat admin + game console (talk to the bot by nick instead)`.
  - `detail`: listing of subcommands grouped by permission tier.
- [x] `triggers.command` config field is removed from `AiChatConfig` and `parseConfig` — the `!ai` console is always enabled (unconditional). `triggers.command_prefix` stays (drives the bind pattern).
- [x] **Verification:**
  - `!ai` alone → usage reply.
  - `!ai hello there` (no matching subcommand) → `Unknown subcommand "hello". Try "!ai help".`
  - `!ai stats` (admin) → existing behaviour unchanged.
  - `!ai play blackjack` (flagged user) → existing behaviour unchanged.
  - `!ai help` → subcommand listing.

### Phase 4: Config migration and examples

**Goal:** Retire the dead config fields; warn on their presence; update all examples.

- [x] In `parseConfig`, detect legacy keys and `api.warn` once per key: `triggers.engagement_seconds` (moved), `triggers.command` (removed — no longer toggleable). Do not throw — warn and ignore.
- [x] Add new config block:
  ```json
  "engagement": {
    "soft_timeout_minutes": 10,
    "hard_ceiling_minutes": 30
  }
  ```
  Soft = "quiet user who is still engaged because no one else spoke" cutoff. Hard = "stop even if they're still going" ceiling.
- [x] `plugins.example.json` — the `ai-chat` block currently only sets `provider` / `model` / `temperature`. No legacy trigger keys to remove. Add a comment-worthy example of `triggers.random_chance`, `engagement.*`, and note that `command` no longer exists. Keep the example minimal.
- [x] Bump `AiChatConfig`'s `triggers` shape to `{ directAddress, commandPrefix, keywords, randomChance }`. `commandPrefix` default stays `!ai`.
- [x] Grep for `engagement_seconds` / `engagementSeconds` across the tree — update remaining callers (notably `plugins/ai-chat/README.md`).
- [x] **Verification:** `pnpm typecheck` clean. Loading a config file with legacy `triggers.engagement_seconds` prints the warning once and the plugin starts normally.

### Phase 5: Tests — reply policy matrix + subcommand-only `!ai`

**Goal:** Lock the new behaviour down. Delete obsolete tests that encoded the old model.

- [x] Delete `engagementSeconds` from the `BASE` fixture in `tests/plugins/ai-chat-triggers.test.ts`. Add the new trigger-shape fixture.
- [x] Remove tests in `ai-chat-triggers.test.ts` that assert the `engaged` / `command` trigger kinds. Keep direct-address / keyword / ignore / bot-nick tests.
- [x] Add `tests/plugins/ai-chat-reply-policy.test.ts` covering `decideReply`:
  - Direct-address match → `'address'`.
  - Engaged user, no other signal → `'engaged'`.
  - Neither, `randomChance = 0` → `'skip'`.
  - Neither, `randomChance = 1`, quiet channel → `'rolled'`.
  - Neither, `flooding` channel → `'skip'` (activity scale = 0).
  - `lastWasBot = true` → `'skip'` regardless of roll.
  - Recency boost increases probability (deterministic via injected RNG).
  - Command-sigil text → `'skip'`.
- [x] Update `tests/plugins/ai-chat-plugin.test.ts` cases that used `!ai <freeform>` to test the new path instead (`neo: <message>`). Add cases for:
  - `!ai hello world` → reply is `Unknown subcommand "hello"...`, no pipeline call.
  - `!ai stats` / `!ai play ...` unchanged.
  - Engagement continues across a 3-minute same-user gap in an otherwise quiet channel.
  - Engagement ends when another human speaks.
- [x] Update `tests/plugins/ai-chat-admin.test.ts` if any cases depend on `!ai foo` freeform.
- [x] **Verification:** `pnpm check` clean — all existing tests updated, new tests pass, typecheck passes, lint passes.

### Phase 6: Docs, CHANGELOG, version bump

**Goal:** Ship 0.5.0 with the breaking change called out clearly.

- [x] Update `plugins/ai-chat/README.md`:
  - Rewrite the "Engagement" section around floor-holding semantics (10-min soft / 30-min hard, ends on another human speaking).
  - Rewrite the "Triggers" section — three-tier rule (address / engaged / rolled).
  - Rewrite the "`!ai` command" section to list it as a subcommand console, not a chat command.
  - Update the config-table rows: remove `engagement_seconds`, add `engagement.soft_timeout_minutes` / `engagement.hard_ceiling_minutes`. Note `triggers.command` removal.
- [x] Update `DESIGN.md` if it references `engagement_seconds` or the old trigger shape.
- [x] Add a `CHANGELOG.md` entry under 0.5.0:
  - **BREAKING: ai-chat `!ai <freeform>` removed.** Talk to the bot by nick (`neo: hello`).
  - **BREAKING: `triggers.engagement_seconds` replaced with `engagement.{soft_timeout_minutes, hard_ceiling_minutes}`.** Legacy key triggers a warning and is ignored.
  - **BREAKING: `triggers.command` field removed.** `!ai` subcommands are always enabled.
  - New: conversation stays engaged until another user takes the floor.
  - New: rolled-ambient replies — `triggers.random_chance` is now the primary unprompted-reply path, counted against the ambient budget.
- [x] Bump `package.json` version to `0.5.0`.
- [x] **Verification:** `pnpm check` clean. Manual smoke: start bot, trigger `!ai` with junk args, address bot by nick, let engagement lapse, confirm rolled replies fire at configured rate.

## Config changes

**Removed:**

- `triggers.engagement_seconds` (legacy-warned, ignored)
- `triggers.command` (always enabled now)

**Changed:**

- `triggers.random_chance` semantics — now the primary rolled-ambient path, gated by ambient budget, scaled by activity + recency + back-to-back guard.

**Added:**

```json
{
  "ai-chat": {
    "config": {
      "engagement": {
        "soft_timeout_minutes": 10,
        "hard_ceiling_minutes": 30
      },
      "triggers": {
        "random_chance": 0.02
      }
    }
  }
}
```

## Database changes

None. Engagement state is ephemeral (in-memory Map), lifecycle-bound to the plugin instance. Existing `user-interaction:` rows in the SocialTracker-owned `UserInteraction` table continue to be written — now read by the recency-boost computation.

## Test plan

- **Unit** — `engagement-tracker.test.ts` (new), `reply-policy.test.ts` (new).
- **Revised unit** — `ai-chat-triggers.test.ts` drops `engaged` + `command` kinds; trigger shape fixture updated.
- **Integration** — `ai-chat-plugin.test.ts` gains reply-policy scenarios; `!ai <freeform>` assertions flipped to "no reply, usage hint only."
- **Regression** — full existing suite passes (rate limiter, token tracker, social tracker, session manager, ambient engine, mood engine — none of these change behaviour).
- **Manual smoke** — connect to test IRC, confirm:
  - `neo: hi` → reply.
  - `and also` (same user, 3 min later, quiet channel) → reply.
  - Another user speaks between bot and follow-up → follow-up not engaged.
  - `!ai hello` → usage hint, not a chat reply.
  - `!ai stats`, `!ai character swan`, `!ai play blackjack` → subcommands still work.
  - Lurker channel with `random_chance: 0.05` → occasional unprompted reply, counted against `ambient_global_per_hour`.

## Open questions

- **Soft/hard defaults.** Proposed: 10 min soft, 30 min hard. Tunable per deployment. Confirm these feel right.
- **Keyword triggers when engaged.** Currently keywords always trigger. Does that still hold, or should keywords be subordinate to engagement (i.e., "engaged user mentioning a keyword" is just engaged, not doubly-triggered)? Proposal: keywords are an `address`-tier signal in `decideReply`; engagement simply means "never needed a keyword to reply in the first place." No change to keyword semantics.
- **Random-chance default.** Proposal: ship `random_chance` default at `0` (opt-in) for safety; operators who want presence flip it to `0.02`. Alternative: ship at `0.02` so new deployments feel alive out of the box. My lean: `0` default, document `0.02–0.05` as the suggested starting point.
- **Ambient engine overlap.** Unanswered-question ambient and rolled-reply-on-a-question can both fire on the same message. Rolled path runs first (synchronous, in `pubm`); ambient path is the 30s fallback. Proposal: leave as-is — if rolled fires, the bot has already replied and ambient's `lastWasBot` back-to-back guard covers it.
