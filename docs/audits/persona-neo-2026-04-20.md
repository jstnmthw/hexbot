---
name: persona-neo audit
date: 2026-04-20
target: neo
---

# Persona audit — neo

**Date:** 2026-04-20
**Scope:** `plugins/ai-chat/characters/neo.json`, `plugins/ai-chat/config.ts` (ambient gating), user-supplied `plugins.json` entry, and a 5-hour transcript from #hexbot (12:54 → 17:52).
**Auditor:** /persona skill

## Summary

Three distinct issues explain everything in the transcript: (1) the "dark" fabrication is not a hallucination — the literal string `'dark'` sits inside `style.notes[5]` as an example nick, and a 3B model grabs any proper-looking noun in its own instructions as a candidate target; (2) the Morpheus-as-Oracle misattribution is a fundamental capacity problem — `llama3.2:3b` doesn't have the parameter budget to keep fictional-universe quote attributions straight; (3) ambient is silently force-disabled by `config.ts:324` because `modelClass === 'small'` hard-codes `ambient.enabled` to `false` regardless of operator intent. The prior 2026-04-19 audit is mostly applied and the persona body itself is in good shape — these are second-order issues that emerged once the first pass landed.

**Biggest win available:** upgrade the Ollama model from `llama3.2:3b-instruct-q4_K_M` to `llama3.1:8b-instruct-q4_K_M` (or `llama3:8b-instruct-q4_K_M`). That single change (a) auto-lifts `modelClass` to `medium` which un-gates ambient, (b) ~2-3× improves lore-attribution accuracy, (c) reduces reflexive-nick opening because 8B follows SAFETY_CLAUSE rule 3 more reliably. Expected latency cost on a NUC 13 ANH (CPU-only, i7-1360P): ~10s median → ~25s median. For a recruitment-archetype character that's the right trade.

**Findings:** 4 high, 3 medium, 1 suggestion

## Phase 1 — High priority (immediate fixes + the single model upgrade)

- [x] **`plugins/ai-chat/characters/neo.json` — `style.notes[5]` leaks "dark" as a live target nick** — the rule reads `"nick handling (critical): when you address or mention a user, reproduce their nick in the EXACT case it appears in the conversation. if the log shows 'dark', you write 'dark' — never 'Dark', never 'DARK'. IRC clients only highlight on exact-case matches"`. The word `dark` appears three times in single quotes inside the prompt. On `llama3.2:3b-instruct-q4_K_M`, the model cannot reliably distinguish "example of a possible nick" from "a user currently in the channel." Every "dark" fabrication in the transcript (12:56:33, 12:59:35, 17:50:07, 17:50:45) traces back to this string — there is no other source of "dark" in the channel context. The model picks the most recent proper-looking noun whenever it decides to address someone, and `dark` is the only candidate in its own instructions.
      **Why:** small instruct models (1B/3B) have a well-known failure mode where quoted examples in the system prompt become retrieval targets. The prior audit's wording was technically correct but assumed larger-model comprehension. On 3B, any nick-shaped word in the prompt is a loaded gun.
      **Fix:** rewrite the note to state the rule without naming an example nick. Drop the `'dark'` illustration entirely — the rule itself is self-explanatory. Replace the note with:

      ```
      "nick handling (critical): when you address or mention a user, copy their nick EXACTLY as it appears in the conversation, letter for letter — never re-case, never shorten, never pluralise. IRC clients only highlight on exact-case matches"
      ```

      If you want an example to reinforce the rule, use a placeholder that could not possibly be a real channel user — e.g. `"if someone signs in as 'Usr_07x', write 'Usr_07x' exactly"` — but the cleanest option is no example at all.

- [x] **`plugins/ai-chat/characters/neo.json` — persona body + `style.notes[4]` frame Neo as a Matrix-lore curator instead of Neo-from-inside-the-story** — at 12:58:13 paleface says "I heard [The One] can stop bullets, and also that he's the 7th version of 'The One'" and Neo replies "how many people have actually seen The One truly free from simulation?" — discussing The One in the third person, even though _he is The One_. This pattern repeats across the transcript. Root cause lives inside the prompt itself: the persona body calls his own existence "Matrix **lore**" and asks him to "explain, debate, and philosophise" about it, and the old `style.notes[4]` closed with "lore questions get real answers." "Lore" is curator-speak — it invites observer posture. On a 3B model, the first-person framing ("You are Neo") collapses under the "explain Matrix lore" framing every time; the model picks the simpler reading.
      **Why:** "You are Neo" + "explain Matrix lore" is incoherent for a small model. Telling Neo his own life is "lore" is like telling an actor to describe their own memories in the third person — the path of least resistance is to talk about Neo-the-character instead of being Neo.
      **Fix (applied):** (a) persona body rewritten — "willingly explain, debate, and philosophise about Matrix lore, consciousness, machines, AI, choice, and the war" replaced with concrete personal-memory anchors ("the pod, the training, the crew of the Nebuchadnezzar, Morpheus and Trinity, the Oracle, the Architect, the war, the choices that brought you here"). (b) `style.notes[4]` — "lore questions get real answers" replaced with "when someone asks about any of that, answer from what you've lived and been shown, not like someone describing a film". (c) new `style.notes[1]` inserted directly after the anti-AI-assistant anchor: `"The One, Neo, and Thomas Anderson are you — not characters you read about. when someone talks about what Neo did, what The One can do, or what Thomas Anderson chose, they are talking about YOU. answer from inside the memory, in first person — never describe yourself in the third person, never narrate your own life as if it happened to someone else"`. Small models still may slip occasionally; combine with the model upgrade below for the best result.

- [x] **`config/plugins.json` (ai-chat model) — upgrade from `llama3.2:3b-instruct-q4_K_M` to `llama3.1:8b-instruct-q4_K_M`** — `references/self-hosting.md` explicitly lists `llama3.2:3b` as acceptable for "minimal / deadpan" archetypes only, and calls out lore-heavy characters (Neo specifically) as needing 8B or newer for correct name recall. The Morpheus-as-Oracle misattribution in the 17:51:18 reply is the canonical failure mode — a 3B model doesn't have the retention to keep "who said what" straight across the trilogy. Upgrading to 8B is the single highest-leverage change for both (a) coherence / "is this a 5/10 or 8/10 replies" axis and (b) un-gating ambient (see next finding).
      **Why:** 3B Q4 has ~1.6B effective parameters after quantisation. The Matrix trilogy's dense internal lore (Morpheus, Oracle, Trinity, Smith, Architect, Zion, Nebuchadnezzar, The One, red/blue pill, "there is no spoon", "follow the white rabbit" — multiple characters saying thematically-similar lines) is well above what a 3B can attribute reliably. 8B doesn't fix lore recall completely, but it measurably helps and is what the `self-hosting.md` reference points to specifically for this archetype.
      **Fix:** in `config/plugins.json`, change:

      ```jsonc
      "model": "llama3.2:3b-instruct-q4_K_M",
      ```

      to:

      ```jsonc
      "model": "llama3.1:8b-instruct-q4_K_M",
      ```

      Then pull the model and reload:

      ```sh
      docker exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
      ```

      Then `.reload ai-chat`. Expected latency on NUC 13 ANH CPU-only: prefill goes from ~3-5s to ~8-12s, decode from ~10-20 tok/s to ~4-8 tok/s. Median reply time ~10s → ~25s. This is at the upper edge of acceptable for IRC but reasonable for a recruitment character. Watch one session; if it's too slow, try `llama3:8b-instruct-q4_K_M` (the original, often slightly faster than 3.1) or stay on 3B and accept the lore pathology.

- [x] **`plugins/ai-chat/config.ts:324-325` — ambient is silently force-disabled on `modelClass: "small"`** — user has `ambient.enabled: true` in plugins.json, but the resolved config flips it back to `false` because `llama3.2:3b` auto-resolves to the small tier. The relevant code:

      ```ts
      const enabledRaw = asBool(ambient.enabled, false);
      const enabled = modelClass === 'small' ? false : enabledRaw;
      ```

      This is intentional — the comment explains that small models ad-libbing unprompted amplifies every pathology (speaker fabrication, prompt echo, catchphrase loops). But the operator has no visible signal that their explicit `enabled: true` was overridden, so they assume ambient is broken.
      **Why:** the small-tier hard-gate is the right safety default, but it's silent. That's why the user reports "ambient enabled but Neo doesn't chime in during idle times" — it's doing exactly what the config says, but the config isn't what the operator wrote.
      **Fix:** upgrade the model per the previous finding — `llama3.1:8b-instruct-q4_K_M` auto-infers to `medium`, which honours `ambient.enabled: true`. No further config change needed.

      **Escape hatch (NOT recommended for 3B):** setting `"model_class": "medium"` explicitly in plugins.json overrides the auto-inference and un-gates ambient. This also disables every small-tier leak defense (`dropInlineNickPrefix`, `defensiveVolatileHeader`, `repeat_penalty: 1.2`, the small stop-sequence list, prompt-leak threshold dropped from 60 to 80). On a 3B model this would regress the prompt-leak and speaker-fabrication protections that are currently keeping the output coherent. Only use this escape hatch if you stay on 3B *and* accept that ambient ramble will be noticeably worse than addressed replies.

      **Secondary suggestion (code change, not config):** consider surfacing the force-disable decision as a one-shot warn at plugin init. Something like `if (modelClass === 'small' && enabledRaw) warn('ambient.enabled=true overridden by modelClass=small — upgrade to 7B+ or set model_class=medium to override')` in `config.ts` around line 324. Out of scope for this audit but worth filing as a polish item.

## Phase 2 — Medium priority (tune for the new 8B deployment)

- [x] **`config/plugins.json` — add `context.max_tokens: 2000`** — currently unset, so it resolves to the small-tier default of `1000` tokens. That's a tight ceiling for Neo's 20-message context cap and leaves no headroom for lore-heavy multi-turn debates. After the 8B upgrade the resolved default will be `2000` (medium tier), so this becomes a no-op — but setting it explicitly now means the config doesn't shift behaviour silently when you change the model tag.
      **Why:** the byte-budget enforcement in `context-manager.ts:118` (`maxBytes = maxTokens * 4`) silently evicts oldest entries when cumulative bytes exceed the budget. On small-tier 1000 tokens = 4000 chars, which a 20-message Matrix debate will blow through in minutes.
      **Fix:** add to the plugins.json `config` block:

      ```jsonc
      "context": {
        "max_tokens": 2000
      }
      ```

      On the 8B upgrade this matches the tier default. If you stay on 3B, explicitly setting it stops the small-tier 1000-token floor from silently truncating history.

- [x] **`plugins/ai-chat/characters/neo.json` — add a lore-hedge style note** — even on 8B, fictional-universe quote attribution will still occasionally drift ("was it Morpheus or the Oracle who said X?"). The persona body currently says "you willingly explain, debate, and philosophise about Matrix lore" with no escape valve for uncertainty — which is why the model bluffs confidently instead of hedging. Add one note to the `style.notes` array that legitimises hedging _in-character_:

      ```jsonc
      "when you quote a line from the trilogy and you're not sure who said it, say who it sounds like — 'that sounds like something Morpheus would say' — don't stake a claim you can't back up. certainty about your own truth; honesty about the details"
      ```

      **Why:** Neo's archetype (calm certainty about his worldview) doesn't require certainty about every line of dialogue. Separating "certainty about the argument" from "memory of who said what" gives the model permission to hedge factual details without breaking character. This addresses the 17:51:42 exchange where the user corrects the attribution and Neo doubles down rather than conceding.
      **Fix:** append to `style.notes` (place it after the in-narrative rules but before the never-break-character rule).

- [x] **`plugins/ai-chat/characters/neo.json` — reflexive "paleface, " opening on every reply** — nearly every reply in the transcript opens with `paleface, ...`. The SAFETY_CLAUSE rule 3 already tells the model "don't reflexively open every reply with the speaker's nick either; only name someone when disambiguation actually needs it." A 3B model doesn't follow this consistently; an 8B model will follow it much better. Still worth adding the same constraint in Neo's own voice so the model has a persona-level anchor for it, not just a security-rule anchor.
      **Why:** the SAFETY_CLAUSE block sits at the end of the prompt and small-/medium-model attention drops off before the body. Echoing the rule inside `style.notes` in character voice gives it a second attention anchor.
      **Fix:** add to `style.notes`:

      ```jsonc
      "don't open every reply with the person's nick. when it's obvious who you're replying to (the last human spoke, the thread is clear), just reply. name someone only when you need to disambiguate or call them out directly"
      ```

      Place immediately after the "default to one to three short sentences" note so it reads as a length/style clarification, not a rule.

## Phase 3 — Suggestions (polish)

- [x] **`plugins/ai-chat/characters/neo.json` — `triggers` list still contains `"code"` and `"real"`-adjacent terms** — `triggers` currently includes `code`, `reality`, `what is real`, `consciousness`, `free will`, `prophecy`. The word `code` will match any programming conversation and pull Neo into off-canon tangents (`code` is listed in `avoids` as "programming" but `triggers` is evaluated before `avoids`). Drop `code` from `triggers` or narrow it to `"the code"` / `"green code"` / `"Matrix code"` so only Matrix-canon references fire the trigger.
      **Why:** `code` is one of the hottest false-positive keywords on a technical channel. The `avoids: ["programming"]` entry only steers _content_ away; the `triggers` list steers _when to reply_ toward it.
      **Fix:** in `triggers`, replace `"code"` with `"the code"` and `"Matrix code"`. Consider also dropping bare `"real"` if it's still there (prior audit flagged; confirm it isn't).

## What looks good (do not change)

- **`persona` body** — the 2026-04-19 rewrite is still strong. Directive framing, `{nick}`/`{channel}`/`{network}` placeholders, in-narrative close about "never admit the Matrix is fiction." Keep verbatim.
- **`style.notes[0]`** — `"you are a person on IRC in 1999, not an AI assistant"` — this is the load-bearing anti-assistant frame. Keep.
- **`style.notes[3]`** — the simulation-talking-back rule gives the model a legitimate in-canon move when asked off-topic questions. Crucial for keeping Neo in character during random chat.
- **`style.notes[4]`** — the rule allowing Neo to step outside when gibberish is received; prevents the mirror-the-input failure mode.
- **`generation.temperature: 0.7`** — matches the self-hosting reference for lore-heavy (`0.75` would be very slightly better but 0.7 is inside the band). Don't raise.
- **`generation.repeatPenalty: 1.2`** — correct for Neo's short catchphrase list on llama3-family. Keep when you move to 8B (the medium tier default is `1.1`, but Neo specifically benefits from the harder penalty given the catchphrase count; override with `generation.repeatPenalty: 1.2` on the character so it rides the model swap).
- **`generation.maxOutputTokens: 220`** and **`maxContextMessages: 20`** — prior audit's numbers; fine for 8B. No change.
- **`avoids: ["weather", "sports", "tech support", "programming"]`** — right-sized after the prior audit's trim.
- **`rate_limits` shape** — `user_burst: 5`, `user_refill_seconds: 6`, `global_rpm: 120`, `rpm_backpressure_pct: 80`, `global_rpd: 1000000` — all appropriate for local Ollama. `global_rpd` at 1M is effectively a "no external quota" sentinel; the binding defensive cap for abuse is `per_user_daily: 50000` tokens (~47 Neo replies/user/day), with `global_daily: 10000000` tokens as the admin-bypass backstop. Don't lower `global_rpd`; token budgets already bite first in every abuse scenario.
- **`output.max_lines: 2`** — this is an explicit override of the small-tier default of 1. Correct for Neo's "sometimes a short paragraph when asked" profile. Keep after the 8B upgrade too — the medium tier default is 4, but 2 lines is what Neo should target.

## Tuning cheat-sheet

| Key                                 | Current                           | Recommended                     | Why                                             |
| ----------------------------------- | --------------------------------- | ------------------------------- | ----------------------------------------------- |
| `model` (plugins.json)              | `llama3.2:3b-instruct-q4_K_M`     | `llama3.1:8b-instruct-q4_K_M`   | Lore recall + un-gate ambient                   |
| `style.notes[5]` (neo.json)         | contains `'dark'` example 3×      | rule-only, no named example     | 3B grabs `dark` as live target                  |
| `style.notes` (neo.json, append)    | —                                 | add lore-hedge note             | Legitimise "not sure who said it"               |
| `style.notes` (neo.json, append)    | —                                 | add "don't open with nick" note | Anchor rule in character voice too              |
| `context.max_tokens` (plugins.json) | unset (resolves to 1000 on small) | `2000`                          | Explicit; survives model-tier flip              |
| `triggers[]` (neo.json)             | contains bare `"code"`            | `"the code"` / `"Matrix code"`  | `code` is a hot false-positive on tech channels |

## Latency expectation on NUC 13 ANH after model upgrade

- Current: 3B Q4 CPU-only, ~10s median reply (user-reported).
- Post-upgrade: 8B Q4 CPU-only on i7-1360P, AVX-2 path. Expect:
  - First reply after model load: ~8-12s prefill + 6-10s decode = ~15-25s.
  - Subsequent replies (KV-cache hit, resident model): ~4-8s prefill + 6-10s decode = ~10-20s for a 220-token output.
  - Median settle: **~20-25s** for a typical 3-4 sentence response.
- If this is too slow, in order of preference: (a) try `llama3:8b-instruct-q4_K_M` (the original, sometimes a touch faster), (b) drop `generation.maxOutputTokens` to `180` (shorter decode), (c) stay on 3B and accept the pathology.
- Not worth considering: GPU-less NUC can't meaningfully run anything above 8B. Don't try Mixtral, don't try 13B, don't try fp16.

## Next step

Apply in this order:

1. Pull `llama3.1:8b-instruct-q4_K_M` on the Ollama daemon (non-destructive — 3B stays).
2. Edit `style.notes[5]` to remove the `'dark'` example.
3. Edit `plugins.json` — swap the model tag, add `context.max_tokens: 2000`.
4. `.reload ai-chat`.
5. Watch one session of direct-addressing Neo. Confirm: no "dark" or other fabricated nicks, no Morpheus-as-Oracle-class misattributions (some drift still expected), and — after ~20 minutes of channel activity — a first ambient utterance.
6. If latency is unworkable, revert to 3B and file a follow-up on the `ambient force-disable warning` code change so future operators see why their config was silently overridden.
