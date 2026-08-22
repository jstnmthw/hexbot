# Why is the bot silent in a dead channel, and should model_class stop gating "chattiness"?

## Context

Symptom: a `novaforgeai/gemma2:2b-optimized` deployment (`model_class: "small"`)
sits in `#hexbot` and never speaks unprompted. The operator config sets ambient
rate-limit keys (`ambient_per_channel_per_hour`, `ambient_global_per_hour`) and
suspects `model_class` is what suppresses chattiness on smaller models.

What the code actually does (as of `main`, 2026-08-22):

1. **Ambient is off by default and off in this config.** `parseConfig`
   defaults `ambient.enabled` to `false` (`plugins/ai-chat/config.ts:328`), and
   the operator config has **no `ambient` block at all**. The `AmbientEngine`
   is never constructed unless `cfg.ambient.enabled` is true
   (`plugins/ai-chat/index.ts:431`). The two ambient rate-limit keys in the
   current config are budget caps for a feature that is disabled — dead
   config.
2. **Rolled (random) replies are also off.** `triggers.random_chance` defaults
   to `0`, which disables the `'rolled'` tier of `decideReply` entirely
   (`plugins/ai-chat/reply-policy.ts:106`). No `triggers` block is set.
3. **`model_class` does not gate chattiness anywhere.** The tier table
   (`config.ts` `TIER_DEFAULTS`) drives sampling, output size, context size,
   leak defenses, and engagement windows — not ambient, not `random_chance`,
   not `chattiness`. The only ambient-adjacent behavior is a **log warning**
   when `ambient.enabled=true` on `modelClass=small` (`index.ts:438`) — it
   warns and proceeds; nothing is blocked.
4. **The tier that _feels_ like chattiness is the engagement window.** Small
   tier defaults `engagement.soft_timeout_minutes=2` / `hard_ceiling=5`
   (vs 10/30 for medium/large), plus `max_lines=1` and `max_output_tokens=80`.
   So on `small`, conversations die 5× faster and replies are one short line —
   the bot isn't less _willing_ to talk, its turns are shorter and its
   conversational memory of "we're mid-thread" expires quickly. All of these
   are operator-overridable; a set key always beats the tier default.
5. **Two ambient knobs are dead code**: `idle.min_users` is parsed
   (`config.ts:332`) and typed (`ambient.ts:22`) but never checked in
   `tickInner()` — idle remarks would fire in a 1-person channel. `interests`
   is likewise parsed but unused by the engine. (In a _dead_ channel this is
   accidentally in your favor, but it's a lie in the config surface.)

So the diagnosis is simple: the bot is silent because every unprompted-speech
path ships disabled, not because the model is small.

## Options

### Option A: Config-only — turn ambient on, leave the code alone

Add to the `ai-chat` config:

```json
"ambient": {
  "enabled": true,
  "idle": { "after_minutes": 45, "chance": 0.25 },
  "unanswered_questions": { "enabled": true, "wait_seconds": 90 },
  "chattiness": 0.3,
  "event_reactions": { "join_wb": true, "topic_change": true }
},
"triggers": { "random_chance": 0.08 }
```

and optionally pick a higher-`chattiness` character (`nightowl`/`chaotic` are
0.6, `shitposter` 0.8; default `friendly` is 0.3). If small-tier conversations
feel like they end abruptly, also set `engagement.soft_timeout_minutes: 5`.
The existing ambient hourly caps (5/channel, 20 global) then become live and
are sane ceilings.

- **Pro:** zero code change; this is exactly what the knobs are for. The
  small-model warning still fires once at load, which is fine — the small-tier
  leak defenses (stop sequences, fantasy-drop, prompt-leak dropper, 1-line cap)
  all still apply to ambient output.
- **Con:** doesn't fix the dead `min_users`/`interests` knobs; the load-time
  warning may mislead a future operator into thinking small+ambient is
  unsupported.
- **Effort:** S. **Compatibility:** trivially yes.

### Option B: A + prune the dishonest surface (recommended follow-up)

Same config change, plus a small cleanup: either enforce `idle.min_users` in
`tickInner()` (needs a channel-population source the engine currently doesn't
have — channel-state lookup via the plugin API) or delete `min_users` and
`interests` from `AmbientConfig`/`parseConfig` outright, per the project's
clean-cut posture. Soften the `small`+ambient warning to mention that the
tier defenses already constrain ambient output.

- **Pro:** config surface tells the truth; ambient in tiny channels behaves
  deliberately rather than accidentally.
- **Con:** enforcing `min_users` would _suppress_ ambient in a 2-person dead
  channel — the exact scenario being fixed — so for this deployment deletion
  (or `min_users: 1`) is the right call, not enforcement.
- **Effort:** S–M. **Compatibility:** yes; config keys are additive/removable
  in early dev.

### Option C: Make model_class actively gate chattiness (what the question assumed exists)

E.g. have `small` force ambient off or scale `chattiness` down by tier.

- **Pro:** none for this deployment — it's the opposite of the goal.
- **Con:** conflates two orthogonal axes. `model_class` answers "how much can
  this model be trusted with prompts and long output"; chattiness answers "how
  much does this channel want to hear from the bot." A 2B in a dead hobby
  channel should be chatty; a 70B in a busy support channel should be quiet.
  Coupling them removes exactly the freedom being asked for.
- **Effort:** S to write, ongoing cost to live with. **Rejected.**

## Recommendation

**Option A now, Option B when convenient. Do not "do away with" `model_class` —
there is nothing chattiness-related in it to do away with.** (Confidence:
high — verified against `config.ts`, `ambient.ts`, `reply-policy.ts`,
`index.ts`.)

The instinct behind "even smaller models should get to be chatty" is already
how the code works: chattiness is 100% operator/character config, and the tier
system's job is orthogonal — it keeps a 2B's _individual utterances_ safe and
short (leak stops, 1-line cap, 80 tokens), which is precisely what makes
frequent ambient chatter from a small model tolerable rather than risky. Keep
the tier; flip the ambient switches. The one tier default worth overriding for
a chatty small-model deployment is the engagement window (`soft_timeout_minutes`
up from 2 to ~5) so back-and-forths don't cut off mid-thread.

One honest caveat: ambient prompts ("say something casual") are the hardest
prompt shape for a 2B — no user text to anchor on. Expect the fantasy-drop /
prompt-leak droppers to eat some fraction of ambient attempts (they log via
`api.warn`, so it's observable). If the drop rate is annoying, the earlier
local-model research pointed at 7–8B (`mistral`, `llama3:8b`) as the floor
where unanchored generation gets reliable — that's a model upgrade decision,
not a config one.

## What Eggdrop does

Eggdrop itself never speaks unprompted — chatter came from script add-ons
(MegaHAL/seborrhea-style), which universally exposed a flat operator-set
"talk chance" percentage per channel, sometimes scaled by channel traffic.
No script tiered chattiness by model capability (there was none to tier by);
willingness-to-speak was always channel policy, set by the op. That's the
30-year precedent for keeping chattiness in operator config and out of the
model-capability axis — which is where HexBot already has it.
