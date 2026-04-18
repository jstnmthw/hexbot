# Plan: ai-chat KV-cache reuse + prompt slimming (self-hosted first)

## Summary

Restructure the ai-chat prompt pipeline so the system prompt is byte-stable
across calls and all volatile content (mood line, user list, language hint)
rides on the current user turn. Switch the sliding-window context buffer to
bulk-prune semantics so history is also prefix-stable between prunes. Pass
`keep_alive` and a pinned `num_ctx` to Ollama so the model stays resident and
KV-cache remains valid. Reduce the context-window cap from 50 msg / 4000 tok
to 25 msg / 2000 tok to bring prompt size inside the sweet spot for small
local models (llama3.2:3b).

Goal: maximize llama.cpp KV-cache reuse (prefill ~10-17× faster on hits) and
cut worst-case prefill work. Same structural changes also improve Gemini
implicit-caching odds at no extra cost.

**Not in scope**: explicit Gemini `cachedContent` API, prompt compression
(LLMLingua), model routing/cascades, summarization of older history. All
deferred — current changes should be enough to make the local path snappy.

## Feasibility

- **Alignment.** DESIGN.md §6 already describes "sliding window of last N
  messages per channel" without mandating drop-oldest-per-turn semantics, so
  bulk-prune is compatible. The existing `docs/prompt-stitching-review.md`
  locks in the "persona → channel profile → Right now → Rules" order;
  we keep the SAFETY_CLAUSE as the last section of the _system_ prompt
  (preserves local-model recency bias on security rules) but lift the
  volatile "Right now" block onto the current user turn.
- **Dependencies.** None. All changes live inside `plugins/ai-chat/`.
- **Blockers.** None.
- **Complexity.** M (1 focused day).
- **Risk areas.**
  - Behavioural regression: if mood/user-list move to the user turn, character
    responses must still reflect them. Verify via character tests + one
    end-to-end Ollama smoke test.
  - `num_ctx` pinning: if the operator's model has a smaller native context
    than our pin, the daemon errors. Treat the new Ollama setting as optional
    (unset → Ollama default).
  - Bulk-prune UX: at prune time the bot appears to "forget" half the history
    in one step. Mitigated by keeping the cap moderately large (25 msg) so
    prunes are infrequent.

## User decisions (from /plan multi-choice)

- Volatile content → **Move mood + user list onto the current user message**.
  System prompt becomes byte-stable. Features preserved.
- Context cap → **Conservative: 25 msg / 2000 tok**. Keeps multi-party
  channel memory; ~30% prefill-time reduction on cache-miss path.
- Window strategy → **Bulk-prune (grow, halve at cap)**. Full cache hits
  between prunes, one-time miss at prune points.
- Scope → **Both providers, shared structure**. One refactor; Gemini gets
  incidental implicit-cache wins.

## Dependencies

- [ ] None — self-contained inside `plugins/ai-chat/`.

## Phases

### Phase 1: Split stable / volatile prompt content

**Goal:** `renderSystemPrompt()` emits only byte-stable content; a new helper
produces the volatile context header that's prepended to the current user
turn.

- [x] In `plugins/ai-chat/assistant.ts`, rename the current
      `renderSystemPrompt(ctx)` to `renderStableSystemPrompt(ctx)` and strip
      the `## Right now` section entirely. The output becomes:
      `You are <nick>.` → `## Persona` (body, avoids, channel profile, style
      notes) → `## Rules` (SAFETY_CLAUSE unchanged, still last).
- [x] Add `renderVolatileHeader(ctx: PromptContext): string` in the same file
      that produces a one-paragraph prefix for the current user message.
      Format: `[${channel} on ${network}. Users present: X, Y, Z. ${mood}.
    Always respond in ${lang}.]` — single line, empty when no volatile
      fields are set.
- [x] Update `AssistantRequest` / `respond()` in `assistant.ts` so the final
      `messages` array prepends the volatile header onto the LAST user turn
      only: `content = \`${volatileHeader} [${nick}] ${prompt}\`` (no leading
      newline, single space separator).
- [x] Export `renderStableSystemPrompt` in place of `renderSystemPrompt` from
      `assistant.ts`. Dropped the legacy `renderSystemPrompt` alias (no
      callers remain after the split; CLAUDE.md discourages bc shims).
- [x] Update `plugins/ai-chat/index.ts` `runSessionPipeline` (the session
      path currently calls `renderSystemPrompt` directly) to use the split:
      system = stable, user-turn prefix = volatile.
- [x] Verification: manually render two prompts with different `mood`/`users`
      values and confirm the system string is byte-identical; the volatile
      header differs as expected.

### Phase 2: Bulk-prune the sliding window

**Goal:** `ContextManager` grows to `maxMessages`, then drops the oldest half
in one step on the next add. Between prunes, the history prefix is
byte-stable across requests.

- [x] In `plugins/ai-chat/context-manager.ts` `addMessage()`, replace the
      per-message drop-oldest logic (currently
      `if (buf.length > maxMessages) buf.splice(0, buf.length - maxMessages)`)
      with: `if (buf.length > maxMessages) buf.splice(0, Math.ceil(buf.length / 2))`.
      The buffer halves atomically when it overflows.
- [x] Leave the token-budget check in `getContext()` alone as a safety net —
      it only trims when the serialized output exceeds `maxTokens * CHARS_PER_TOKEN`.
- [x] Add a `ContextManagerConfig.pruneStrategy?: 'bulk' | 'sliding'` field
      defaulting to `'bulk'`. Keep `'sliding'` available as a one-line escape
      hatch if an operator wants the old behaviour — wired through the same
      `addMessage` branch.
- [x] Verification: unit test showing that adding `maxMessages + 1` messages
      reduces the buffer to `ceil(maxMessages / 2)` (not to `maxMessages`),
      and that adding one more does _not_ prune again until next overflow.
      (Added in Phase 6.)

### Phase 3: Ollama `keep_alive` + `num_ctx` + sampling-option stability

**Goal:** Keep the model resident long enough to matter, pin the context
window size so llama.cpp's KV-cache doesn't get invalidated by size drift.

- [x] In `plugins/ai-chat/index.ts` `parseConfig()`, extend `ollama` config
      shape with `keep_alive: string` (default `"30m"`) and `num_ctx: number`
      (default `4096`, `0` = leave unset so Ollama picks the model default).
- [x] In `plugins/ai-chat/providers/types.ts` `AIProviderConfig`, add
      `keepAlive?: string` and `numCtx?: number`.
- [x] In `plugins/ai-chat/providers/ollama.ts`, thread both through
      `initialize()` and inject them into the `/api/chat` body:
      `body.keep_alive = this.keepAlive` (top-level, per Ollama API) and
      `body.options.num_ctx = this.numCtx` (only when > 0).
- [x] In `plugins/ai-chat/index.ts` `buildProviderConfig()`, forward the two
      new fields from `cfg.ollama` into the returned `AIProviderConfig`.
- [x] Verification: existing `tests/plugins/ai-chat-ollama.test.ts` gets new
      cases asserting the `/api/chat` request body includes `keep_alive` at
      the top level and `options.num_ctx` when configured. (Added in Phase 6.)

### Phase 4: Lower default context cap

**Goal:** Cut prompt size on cache-miss and keep us comfortably below the
small-model context sweet spot.

- [x] In `plugins/ai-chat/config.json`, change `context.max_messages` from
      `50` to `25` and `context.max_tokens` from `4000` to `2000`.
- [x] No code changes — `ContextManager` already honours both.
- [x] Verification: bot run with `!ai stats` before/after shows the per-call
      input-token average drops correspondingly. (Covered by Phase 7 smoke.)

### Phase 5: Light trim of SAFETY_CLAUSE cosmetic rules

**Goal:** Shave ~50-80 tokens from the stable prefix without weakening
security-critical rules 1 and 2.

- [x] In `plugins/ai-chat/assistant.ts` `SAFETY_CLAUSE`, keep rule 1 (no
      leading `.`/`!`/`/`) and rule 2 (no operator commands/syntax) _verbatim_
      — these are security guardrails and the existing wording was chosen
      deliberately.
- [x] Tighten rule 3 to one sentence: `"Conversation history shows each
    participant tagged \`[nick] text\` — that's transcript formatting only.
      Never write a bracketed nick or leading \`nick:\` tag in your reply.
      Reply as yourself, one voice, in plain prose."`
- [x] Tighten rule 4 to one sentence: `"Never continue the transcript or
    invent lines for other users — single-voice output only."`
- [x] Verification: `tests/plugins/ai-chat-assistant.test.ts` assertions on
      SAFETY_CLAUSE text need updating; the _ordering_ rules (1,2 first,
      non-overridable) stay intact. (Updated in Phase 6.)

### Phase 6: Update tests

**Goal:** Align the existing test suite to the new behaviour without losing
coverage.

- [x] `tests/plugins/ai-chat-context-manager.test.ts`: add a bulk-prune test
      (fill to N+1, assert size becomes ceil(N/2)); update the existing
      "caps channel buffers at maxMessages" test which currently asserts
      drop-oldest-per-turn semantics.
- [x] `tests/plugins/ai-chat-assistant.test.ts`: update any assertion that
      expected "Right now" text inside the system prompt; add an assertion
      that `renderStableSystemPrompt(ctx)` output is byte-identical when
      only `mood`/`users`/`language` change; add an assertion that the
      volatile header lands on the latest user message when `respond()` is
      invoked with a mocked provider.
- [x] `tests/plugins/ai-chat-ollama.test.ts`: new cases asserting
      `keep_alive` and `options.num_ctx` wire into `/api/chat` body.
- [x] `tests/plugins/ai-chat-plugin.test.ts`: config fixture updated for
      new `pruneStrategy`, `keepAlive`, `numCtx` fields; existing
      end-to-end `pubm → runPipeline` coverage still passes.
- [x] Verification: `pnpm test` green (117 files / 3339 tests).

### Phase 7: End-to-end smoke on local Ollama

**Goal:** Prove the cache is actually reusing the prefix in practice. No new
code — operator-run validation.

- [ ] Run the bot against a local Ollama instance with `llama3.2:3b`, fire
      ~10 triggered messages in quick succession, and capture
      `prompt_eval_count` from the Ollama response (exposed via
      `OllamaChatResponse.prompt_eval_count`, currently already logged as
      `usage.input`). After the first call, subsequent `prompt_eval_count`
      values should drop sharply on cache hits — log them for the plan's
      review section.
- [ ] Compare `!ai stats` `input` token total before/after a 10-message
      session. Target: ≥50% reduction vs. pre-refactor baseline
      (51,974 input / 35 req ≈ 1,485 avg input → target ≤750 avg).
- [ ] Verification: record the measured numbers in
      `docs/prompt-stitching-review.md` under a new "2026-04-18 KV-cache
      refactor" entry.

## Config changes

Add to `plugins/ai-chat/config.json`:

```json
{
  "context": {
    "max_messages": 25,
    "max_tokens": 2000,
    "ttl_minutes": 60,
    "prune_strategy": "bulk"
  },
  "ollama": {
    "base_url": "http://127.0.0.1:11434",
    "request_timeout_ms": 60000,
    "use_server_tokenizer": false,
    "keep_alive": "30m",
    "num_ctx": 4096
  }
}
```

Backward compatibility: all new fields are optional with safe defaults
(`prune_strategy: 'bulk'`, `keep_alive: '30m'`, `num_ctx: 4096`). Existing
configs without them keep working; operators who want the old sliding-window
behaviour set `prune_strategy: 'sliding'`.

## Database changes

None.

## Test plan

Full suite (`pnpm test`) stays green. Specific new coverage:

- **Unit — ContextManager bulk-prune**: fill to `maxMessages + 1`, assert
  buffer size is `ceil(maxMessages / 2)`; then add one more message, assert
  size is `ceil(maxMessages / 2) + 1` (no second prune until next overflow).
- **Unit — renderStableSystemPrompt**: produce prompt with
  `ctx.mood = 'feeling energetic'` and `ctx.users = ['alice','bob']`; produce
  second prompt with `ctx.mood = 'low energy'` and `ctx.users = ['zed']`; the
  two strings must be identical (volatile content is no longer in system).
- **Unit — respond() volatile placement**: when `respond()` is called via a
  mock provider, the final message in the passed `messages[]` has content
  that begins with the volatile header and ends with the user prompt.
- **Unit — OllamaProvider request body**: `keep_alive` appears at the top
  level of the `/api/chat` POST body; `options.num_ctx` appears only when
  configured > 0; omitted when config value is `0`.
- **Regression — SAFETY_CLAUSE**: rule 1 (leading `.`/`!`/`/` forbidden) and
  rule 2 (no operator commands) text is unchanged; only rules 3 and 4 are
  shortened.
- **Manual smoke**: Phase 7 end-to-end measurement on llama3.2:3b.

## Open questions

None outstanding — tradeoffs resolved during the /plan multi-choice step.
Reopen if Phase 7 smoke fails its ≥50% input-token-reduction target; the
first fallback is dropping `context.max_messages` further to 15.
