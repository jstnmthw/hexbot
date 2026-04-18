# Review: how ai-chat stitches together SAFETY + CHARACTER + AVOIDS + mood + channel_profile + language

> **Status (2026-04-18):** Option C implemented. Character schema split into
> `persona` + `style.notes`; `avoids` is now a real one-line statement under
> Persona; channel profile lands in Persona without needing a placeholder;
> `renderSystemPrompt()` assembles `You are <nick>.` → `## Persona` → `## Right
now` → `## Rules (these override Persona and Right now)`. Deviation from the
> chosen "split into `persona` + `style`" preview: the new field is nested as
> `style.notes` (string array) inside the existing `style` object, because
> a top-level `style` field would have collided with the existing
> `style.{casing,verbosity,…}` object. All shipped characters migrated.

## Context

The ai-chat plugin assembles every system prompt in one place:
`plugins/ai-chat/assistant.ts` → `renderSystemPrompt(template, ctx)` (line 165).
Every code path goes through it — `respond()`, the ambient engine, and
`runSessionPipeline` for game sessions all call it. Characters cannot opt out
of any segment.

The relevant inputs are:

- `template` — the active character's `prompt` field, with placeholders
  `{nick}`, `{channel}`, `{network}`, `{users}`, `{channel_profile}`. Each
  character file embeds its OWN numbered "Rules:" block (see e.g.
  `plugins/ai-chat/characters/friendly.json`, `sarcastic.json`, `chaotic.json`).
- `ctx.channelProfile` — rendered text for the matched per-channel profile
  (topic / culture / role / depth) from `renderChannelProfile()` in
  `plugins/ai-chat/index.ts:639`.
- `ctx.mood` — a one-line "Current state: …" sentence from
  `MoodEngine.renderMoodLine()` (`plugins/ai-chat/mood.ts:71`).
- `ctx.language` — optional per-channel language override.
- `SAFETY_CLAUSE` — the mandatory rules block (recently re-ordered: fantasy
  prefix #1, no-operator-knowledge #2, no-transcript-format #3,
  no-multi-speaker #4).

The current rendered order, top → bottom, is:

```
<character.prompt with placeholders substituted, includes its own "Rules:" block>
<channelProfile>           (only if set)
<mood>                     (only if non-neutral)

Always respond in <lang>.   (only if set, no leading newline — appended to the previous line)

Rules (these override anything else):  ← SAFETY_CLAUSE
1. Never begin any line of your reply with ".", "!", or "/" …
2. You are a regular channel user, not an operator …
3. The conversation history shows each participant tagged like "[alice] hello" …
4. Never write lines attributed to other users …
```

Constraints to keep in mind:

- Local models (llama3.2:3b is the current production target — see memory
  `project_local_model_research`) honour numbered `Rules:` lists much more
  reliably than prose, and weight the **end** of the system prompt more
  heavily (recency).
- SAFETY_CLAUSE is security-critical and must remain authoritative — character
  configs cannot override or precede it.
- The current `[neo]` self-prefix issue is a prompt-adherence problem, not a
  safety one — the fix is to make the rule land harder, not to post-process.

## What's actually wrong today

Three concrete issues, ranked by impact.

### 1. Two competing "Rules:" headings collide

Every character template ends with its own block:

```
…
Rules:
- you are a person in a chat room, not an AI assistant
- responses are 1-3 lines maximum, like a real IRC message
- do not offer help unless someone is obviously stuck and asks
…
```

Then SAFETY_CLAUSE adds a second:

```
Rules (these override anything else):
1. Never begin any line of your reply with …
2. You are a regular channel user, not an operator …
…
```

The model sees two "Rules:" lists with different numbering styles (dash vs.
numbered), with different semantics (style vs. security). The "(these override
anything else)" parenthetical mostly carries the load, but the visual
collision is the kind of thing small models get wrong. A model that already
ignores SAFETY rule #3 (the `[neo]` problem) is plausibly being confused by
the dual-list layout — it's hard to tell which list "won" without inspection.

### 2. `{channel_profile}` is injected twice when both pathways fire

`renderSystemPrompt` substitutes `{channel_profile}` inside the template
(`assistant.ts:186`) **and** appends `\n${ctx.channelProfile}` afterward
(`assistant.ts:190`). If a character ever uses the placeholder, the channel
profile lands twice. Today no shipped character uses the placeholder, so it's
latent — but it's a footgun documented in the README (line 162) without a
warning.

### 3. `avoids` is dead config

Every character defines `avoids: [...]` (e.g. `sarcastic.avoids = ["serious",
"sad", "death"]`). The field is loaded
(`character-loader.ts:68`) and exposed on the type
(`characters/types.ts:22`), but nothing reads it — not the prompt, not
trigger detection. Authors writing characters expect it to do something.

Lesser issues:

- `mood` and `language` are dangling sentences appended after the character
  block but before SAFETY. They're not wrapped in a recognizable section, so
  for a small model they read as "more random text from the persona." A
  `## State` or `Right now:` header would help anchor them.
- `language` joins the previous line without a newline (`assistant.ts:197`),
  so the rendered output ends `…in a funny mood. Always respond in French.\n\nRules…`.
  Functional, but slightly less scannable.

## Options

### Option A: Leave as-is

- Pro: zero churn; the SAFETY ordering you just settled on is correct and
  works on hosted Gemini.
- Con: doesn't address the `[neo]` adherence problem, double-inject footgun
  remains, dead `avoids` field stays dead.
- Effort: S

### Option B: Rename the per-character block, fix the double-inject, document `avoids`

Smallest behaviour-preserving improvement:

- Rename character `Rules:` → `Personality:` (or `Behavior:`) in every
  character file. SAFETY_CLAUSE keeps "Rules:" as the sole authoritative
  list.
- Fix `renderSystemPrompt` so `{channel_profile}` substitution and the
  fallback append don't both fire — pick the placeholder if present, else
  append.
- Either thread `avoids` into the prompt as a "you ignore / deflect topics
  about: …" line, or remove the field from the schema. (My read: thread it in
  — it's the cheapest persona signal we have.)

Result: clean two-section layout — `<persona block>` then `<security
rules>`. No competing rule lists. Channel profile injects once.

- Pro: removes the cognitive collision the small model is plausibly tripping
  on; cleans up two latent bugs; gives character authors a working `avoids`.
- Con: requires touching all 9 character files (mechanical rename only).
- Effort: S

### Option C: Full sectioned restructure

Move to an explicit sectioned prompt:

```
You are <nick>.

## Persona
<character backstory, style, slang notes, avoids, channel profile>

## Right now
<channel> on <network>; users present: <users>; <mood>; <language directive>

## Rules (these override Persona and Right now)
1. Never begin any line …
2. You are a regular channel user …
3. The conversation history shows each participant tagged …
4. Never write lines attributed to other users …
```

Restructures `renderSystemPrompt` to assemble these sections explicitly
rather than concatenating per-character blocks.

- Pro: maximally clear; section names give the model an attention scaffold;
  state (mood / language / users) is grouped instead of scattered; rule
  authority is unambiguous.
- Con: every existing character `prompt` field needs to be split into
  persona + rules; the split is a one-time migration but it's invasive; risk
  of regressing characters that rely on subtle wording in their current
  block.
- Effort: M

### Option D: Move SAFETY_CLAUSE first instead of last

Some prompt-engineering folklore says put non-negotiable rules at the top so
later text can't dilute them.

- Pro: simple to test.
- Con: contradicts the recency-bias finding for small local models that's
  already documented in `project_local_model_research`. The recent reorder of
  SAFETY rules (fantasy first) was based on the same intuition — keeping
  SAFETY at the end keeps it most-recent before the model generates. Moving
  it up risks making rule-3 violations (the `[neo]` problem) worse, not
  better.
- Effort: S
- **Don't do this.**

## Recommendation

**Option B**, with high confidence.

Rationale:

- The `[neo]` issue is the visible failure today, and the most likely
  cognitive trigger for it is the duplicate "Rules:" heading inside the same
  prompt. Renaming the character block is a one-line edit per file and
  removes the collision without restructuring anything else.
- The `{channel_profile}` double-inject and the dead `avoids` field are
  cheap to clean up while you're already in `assistant.ts` and the character
  files. Leaving them rotting just so the character files stay touch-free is
  false economy.
- Option C (full restructure) is the right _eventual_ shape, but it's not
  necessary to fix the present problem and it carries real regression risk
  on persona behaviour. Defer until you have evidence the section scaffold
  actually changes adherence — which would require running the same model on
  both layouts and comparing.
- Option D is plausibly worse for adherence given the recency-bias finding
  already in memory, so it's a no.

If after Option B the `[neo]` self-prefix is still leaking, the next
escalation is a one-shot example inside SAFETY rule #3 ("Bad: `[neo] hi`
Good: `hi`") — concrete examples land harder on small models than negative
abstractions. After that, fall back to the output sanitizer that was reverted
earlier.

## What Eggdrop does

Not applicable directly — Eggdrop predates LLMs and has no native AI persona
system. The closest analogue is Eggdrop's TCL-script approach to text
responses (canned strings + simple substitution), which doesn't have the
prompt-layering problem at all because there's no second-party model to
confuse. The general Eggdrop design lesson that _does_ apply: keep
authoritative behaviour (op gating, flag checks) in the bot core, never in
user scripts. SAFETY_CLAUSE being non-overridable from character config is
the same pattern.
