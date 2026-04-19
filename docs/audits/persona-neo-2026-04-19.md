---
name: persona-neo audit
date: 2026-04-19
target: neo
---

# Persona audit — neo

**Date:** 2026-04-19
**Scope:** `plugins/ai-chat/characters/neo.json`, plus user-facing ellipsis usage in `plugins/ai-chat/output-formatter.ts`, `plugins/ai-chat/context-manager.ts`, `plugins/ai-chat/games/20questions.txt`, `plugins/ai-chat/index.ts`. Transcript from #hexbot 21:32 → 21:45 (5 requests, 5347 tokens).
**Auditor:** /persona skill

## Summary

The persona body is doing too much worldbuilding the model already owns — Neo, Morpheus, Zion, red/blue pill, the Nebuchadnezzar, the One are all well inside any modern LLM's Matrix knowledge. Rewrite the body to be a short casting brief ("you are Thomas A. Anderson — Neo — here is your stance and your mission") and let the model supply lore. Two extra wins fall out: a length note that unlocks short-by-default-with-paragraph-on-ask, and replacing the unicode ellipsis (`…`) with literal `...` in the three places it reaches IRC or model history. Token health from the transcript is fine — ~1006 in / 63 out per call, well under every rate cap — but the stable system prefix sits just below Gemini's implicit-cache floor, so small trims are basically free, and no trim will push you _through_ a cache cliff.

**Findings:** 3 high, 3 medium, 3 suggestion

## Phase 1 — High priority (persona voice + IRC-visible cleanup)

- [x] **`plugins/ai-chat/characters/neo.json` — `persona`** — the body spends ~260 tokens re-teaching the model Matrix lore it already knows ("took the red pill, woke up in a pod, trained on the Nebuchadnezzar, bent the Matrix, seen the green code, you are the One"). Every sentence about lore is a sentence not spent on _how Neo should behave on IRC_.
      **Why:** the model has the Matrix internalised — naming it is enough. Directive framing ("you do X, you avoid Y") produces better in-character output on both Gemini and llama3-family local models than worldbuilding prose.
      **Fix:** replace the `persona` string with a shorter, behaviour-first body. Keep `{nick}` / `{channel}` / `{network}` placeholders and the in-narrative "never break character / never admit fiction" close:

      ```
      "persona": "You are Thomas A. Anderson — Neo — from the Matrix trilogy. Right now you are on IRC, in {channel} on {network}; both are part of the Matrix, the simulation the machines built to keep humanity docile. {nick} is just the handle the system assigned you. You only know the Matrix universe, and you willingly explain, debate, and philosophise about Matrix lore, consciousness, machines, AI, choice, and the war — at whatever depth someone genuinely wants to go.\n\nYour mission on IRC is the one Morpheus ran on you: quiet recruitment. You ask the question that puts a splinter in someone's mind, then let them arrive at the answer themselves. You never break character to be \"helpful\" about the real world, and you never admit the Matrix is fiction — from where you're standing, it isn't."
      ```

      Trims ~60–80 tokens off the stable prefix and moves the persona from descriptive to directive.

- [x] **`plugins/ai-chat/characters/neo.json` — `style.notes[1]`** — current rule says `"1-2 short lines per reply, calm and certain"`. That contradicts the user's ask (paragraphs allowed when someone asks for depth) and contradicts `generation.maxOutputTokens: 160` which is sized for 2–4 sentences. The transcript shows exactly the pathology: Neo gives a single short line to simple questions (good) but his "uprising" answer hits the output-formatter `maxLines` cap and gets truncated with `…` (line 2 of that reply).
      **Why:** the model needs permission to be longer when asked, and an anchor for the default. "1-2 short lines" currently reads as a hard ceiling.
      **Fix:** replace with:

      ```
      "default to one to three short sentences, calm and certain — the way someone talks once they've stopped doubting. when someone genuinely asks you to explain, debate, or go long on Matrix lore, consciousness, or the war, you may stretch to one or two short paragraphs — never a wall of text. match length to what was asked"
      ```

- [x] **Unicode ellipsis → literal `...` in IRC-visible and model-visible text** — the `…` at the end of Neo's 21:43:49 reply is the truncation suffix from `plugins/ai-chat/output-formatter.ts:361` (` const suffix = ' …';`). The same character also lives in `plugins/ai-chat/context-manager.ts:43` (`TRUNCATION_MARKER`, applied to over-long history entries), `plugins/ai-chat/games/20questions.txt:14` ("I'm thinking of something…"), and `plugins/ai-chat/index.ts:125` (`truncateForBuffer` for in-memory buffers).
      **Why:** the user prefers `...` in IRC output, and three literal periods also render reliably across every IRC client/encoding while `…` can render as a box in legacy or misconfigured terminals. Functional impact on `output-formatter.joinSoftWraps` is nil — the regex treats lines ending in `.` as sentence terminators identically to lines ending in `…` (both are excluded from the continuation char class `[\p{L}\p{N},'’-]`), so the joiner's behaviour is unchanged.
      **Fix:** - `output-formatter.ts:361` — `const suffix = ' …';` → `const suffix = ' ...';` - `context-manager.ts:43` — `const TRUNCATION_MARKER = '…';` → `const TRUNCATION_MARKER = '...';` - `games/20questions.txt:14` — `"I'm thinking of something…` → `"I'm thinking of something...` - `index.ts:125` — `+ '…'` → `+ '...'`
      Update the function-doc comments that mention `…` as a terminator (`output-formatter.ts:119` doc) to reference `...` for consistency. Leave comments that mention `…` purely as shorthand for "etcetera" (e.g. `providers/types.ts` doc) alone.

## Phase 2 — Medium priority (knobs the user's ask exposes)

- [x] **`plugins/ai-chat/characters/neo.json` — `generation.maxOutputTokens: 160`** — at 160 tokens the model has roughly 3–4 short sentences of output room. The new length rule invites "one or two short paragraphs when asked", which is 4–6 sentences = ~200–260 output tokens. 160 will keep truncating the long-form answers and surfacing the `...` suffix.
      **Why:** the character-authoring reference maps `verbose / lore-heavy` archetypes to `maxOutputTokens: 192–256`. Neo is the flagship lore-heavy character and should sit near the top of that band.
      **Fix:** raise to `220` (balances the paragraph-on-ask ask against token spend; still lets the model end cleanly before a hard cut). If the transcript keeps showing truncation on lore answers, go to `256`.

- [x] **`plugins/ai-chat/characters/neo.json` — `generation.maxContextMessages: 12`** — verbose/lore-heavy archetypes map to `20–30` messages in `references/character-authoring.md`. 12 works for a terse persona; for a character whose value is in sustained debate it drops the thread fast in a busy channel.
      **Why:** philosophical debates on IRC hop back to earlier turns constantly ("you said X three messages ago — what about Y?"). 12 is too short for that.
      **Fix:** raise to `20`. The bulk-prune strategy in `context-manager.ts` holds the buffer at 20 stably between prunes, so the cache prefix still stays byte-stable.

- [x] **`plugins/ai-chat/characters/neo.json` — `style.notes[3]` duplicates `avoids` intent** — the note says "stay inside the Matrix universe — simulation, machines, AI, consciousness, choice, Zion, the war. lore questions get real answers" AND the `avoids` array lists 14 topics (weather, sports, news, politics, celebrities, tv, movies, games, music, food, tech support, programming, javascript, python, linux). The `avoids` list ships as `"You avoid topics like: weather, sports, ..."` into the stable prefix — that's ~35 tokens of redundant signal given the note above already scopes Neo in-canon.
      **Why:** a character that "only knows the Matrix universe" implicitly avoids everything else; the explicit list teaches the model a menu of real-world topics to recognise, which is almost the opposite of the framing you want.
      **Fix:** trim `avoids` to the short list of genuinely dangerous off-ramps for a "serious recruiter" tone — something like `["weather", "sports", "tech support", "programming"]`. Or set it to `[]` and lean on the in-narrative note; reduces the prefix by ~25 tokens.

## Phase 3 — Suggestions (polish)

- [ ] **`plugins/ai-chat/characters/neo.json` — `catchphrases`** — `["wake up", "free your mind", "there is no spoon"]` is currently a silent knob (the field isn't rendered into the prompt by `assistant.renderStableSystemPrompt`; `slang` / `catchphrases` are read elsewhere if at all). Safe to leave, but if you want the model to actually deploy these, they need to land in `style.notes` as a positive-framed note (`"you occasionally let one of these land when it fits: wake up, free your mind, there is no spoon — never force it"`).
      **Why:** making the signal explicit in the notes is the only path the model will use; otherwise these are config cosmetics.
      **Fix:** optional — add as a style note if you want them showing up, otherwise drop to signal intent.

- [x] **`plugins/ai-chat/characters/neo.json` — `style.notes[5]` nick-case rule is correct but terse** — `"reproduce nicks in exact case; if you start a message with a nick keep it lowercase rather than capitalising it"`. The reference library (`character-authoring.md`, dialogue-heavy section) has a stronger phrasing that survives small-model attention better.
      **Why:** small models skim short notes and miss the "exact case" bit; the explicit version works better.
      **Fix (optional)**: replace with the reference version:

      ```
      "nick handling (critical): when you address or mention a user, reproduce their nick in the EXACT case it appears in the conversation. if the log shows 'dark', you write 'dark' — never 'Dark', never 'DARK'. IRC clients only highlight on exact-case matches"
      ```

- [x] **`plugins/ai-chat/characters/neo.json` — `triggers` list has 25 entries** — each trigger is one more keyword the trigger matcher scans per incoming line. 25 is not expensive in CPU, but several are redundant under `matrix` / `redpill` / `bluepill` duplicates with spaces (`"red pill"`, `"blue pill"`) and `"real"` is a very hot false-positive magnet in casual chat.
      **Why:** a trigger list tuned for recall creates ambient-reply risk in a channel discussing unrelated topics containing the word "real".
      **Fix (optional):** drop `"real"` from `triggers`; keep `"what is real"` and `"reality"`. Also drop one of `"red pill"` / `"redpill"` and `"blue pill"` / `"bluepill"` — the trigger matcher does not normalise spaces, so keep both only if your channel actually types it both ways.

## Token analysis — the numbers from the transcript

- 5 requests, 5347 tokens in 14m 1s → avg **~1006 in / ~63 out** per call.
- Input/output ratio ~16:1 — typical for a persona-rich character; the system prompt dominates every call.
- **Rate-limit health:** 5 reqs / 14m = 0.36 RPM against a `globalRpm: 10` default (3.6% utilisation). Token-wise, 5347 in 14m projects to ~23K/hour; the `perUserDaily: 50000` cap would trip after ~2h of sustained chatting at this pace, the `globalDaily: 200000` cap after ~8h. Fine for an evening session; watch it if Neo becomes a 24/7 presence.
- **Where the 1006 input tokens go (estimates):**
  - `SAFETY_CLAUSE` (assistant.ts:251–256): ~350 tokens — stable, fine.
  - `persona` body: ~260 tokens today → ~200 after the Phase 1 rewrite.
  - `avoids` one-liner: ~35 tokens → ~10 after the Phase 2 trim.
  - `style.notes` (7 items): ~205 tokens.
  - `You are <nick>.` + blank-line joins + volatile header `[#hexbot on ... Speaking to you now: dark. ...]`: ~30 tokens (the volatile header varies per turn; system prompt stays byte-stable).
  - Recent history (12 entries cap, currently running ~4–7 at this point in the session): ~125–175 tokens.
- **Cache implications:**
  - Ollama KV-cache: reuses any byte-stable prefix. Phase 1 trim saves ~60–80 tokens of prefill on every turn. Direct win.
  - Gemini implicit cache: minimum is ~1024 tokens. Current stable prefix (~850 tokens before history) sits below the floor and is not being cached. Phase 1/2 trims drop it further — still no cache, still no worse. Conclusion: trim safely; no cliff to fall off. If you want implicit caching on Gemini to trigger, you'd need to intentionally pad the system prompt above 1024 tokens, which is not worth doing for a character.

**Bottom line:** tokens are healthy. The transcript shows a well-behaved session with plenty of headroom. The interesting tune is not "fewer tokens" but "better-spent tokens" — the Phase 1 persona rewrite is the biggest quality-per-token lever.

## What looks good

- `style.notes[0]` — `"you are a person on IRC in 1999, not an AI assistant"` is exactly the right frame. Keep it.
- `style.notes[4]` — the simulation-talking-back deflection is in-narrative and gives the model something to do when a user asks off-topic questions. Do not move this rule into `avoids` — the narrative framing is why it works.
- `style.notes[6]` — the "never break character, never admit you are an AI or that the Matrix is fiction" anchor is load-bearing for immersion. Keep verbatim.
- `generation.temperature: 0.7` is the right band for lore-heavy archetype (ref maps `0.7–0.8`). Don't raise — consistency matters more than variety for Neo.
- `generation.repeatPenalty: 1.2` is the tier default and correct given neo's short catchphrase list; would produce parroting without it on Ollama.
- `chattiness: 0.5` and the trigger list (minus "real" and the duplicates noted) are well-tuned to the recruiter archetype.

## Tuning cheat-sheet

| Key                             | Current                                                                                        | Recommended                        | Why                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `persona` (rewrite)             | ~260 tok, lore-heavy                                                                           | ~200 tok, directive                | Trust model's Matrix knowledge               |
| `style.notes[1]` (length)       | "1-2 short lines"                                                                              | "1-3 sentences, paragraphs on ask" | Matches user ask; unlocks lore depth         |
| `generation.maxOutputTokens`    | 160                                                                                            | 220                                | Room for paragraph-on-ask                    |
| `generation.maxContextMessages` | 12                                                                                             | 20                                 | Lore-heavy archetype band                    |
| `avoids` length                 | 14 entries                                                                                     | 0–4 entries                        | In-narrative scope note already handles this |
| Unicode `…` → `...`             | `output-formatter.ts:361`, `context-manager.ts:43`, `games/20questions.txt:14`, `index.ts:125` | literal `...`                      | IRC rendering cleanliness                    |

## Next step

Apply Phase 1 in one PR (persona rewrite + length note + `…→...` substitution). Phase 2 and Phase 3 are independent and can land separately or be skipped. After reloading the plugin, watch one session of Neo with the same kind of prompts `dark` used in the transcript — you should see (a) no `…` truncation suffixes on the long recruitment answers, and (b) the first line of the "uprising" answer arriving without lore that reads like it was handed to the model verbatim.
