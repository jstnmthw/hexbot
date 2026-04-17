# Plan: Ollama provider for ai-chat

## Summary

Add an `OllamaProvider` that implements the existing `AIProvider` interface in `plugins/ai-chat/providers/types.ts`, register it in the factory, and extend the plugin config so operators can select `"provider": "ollama"` and point it at a local Ollama endpoint. No plugin-core changes — the adapter pattern was designed for exactly this. The operator-side setup lives in `docs/plans/ollama-self-hosting.md`.

## Feasibility

- **Alignment:** The `AIProvider` interface is already the abstraction boundary. README explicitly advertises "Claude/OpenAI/Ollama adapters can be added without touching plugin logic." This plan honours that.
- **Dependencies:**
  - `createProvider()` in `providers/index.ts` — add a `case 'ollama'` branch.
  - `AIProviderConfig` in `providers/types.ts` — currently carries `apiKey`, `model`, `maxOutputTokens`, `temperature`. For Ollama we need `baseUrl` too (and `apiKey` is meaningless). See Config changes below.
  - `plugins/ai-chat/index.ts` currently passes `apiKey: process.env[config.api_key_env]` to the factory — we need a provider-agnostic config resolver.
  - `ResilientProvider` works unchanged; its retry/breaker semantics are provider-neutral.
- **Blockers:** None — all required infrastructure exists.
- **Complexity:** **S–M** (half day incl. tests).
- **Risk areas:**
  - **Tokenizer mismatch.** `AIProvider.countTokens()` is called from `token-tracker` / `context-manager` to enforce the context-window cap and daily token budgets. Ollama's `/api/tokenize` exists but isn't portable across models, and some older server builds lack it. Plan: estimate with a 4-chars-per-token heuristic by default, with an optional config flag to use `/api/tokenize` when available. The estimate is conservative (rounds up on whitespace-heavy text), which is what we want for budget enforcement.
  - **Timeout semantics.** Local inference is slower than Gemini — a 256-token reply on CPU may take 10–20 s. The Gemini provider uses a 30 s per-request timeout; Ollama needs a higher ceiling (configurable, default 60 s) or ambient replies will flap.
  - **Error surface.** Ollama returns HTTP 404 when the model isn't pulled, connection-refused when the daemon is down, and plain 500 with an error body for overload. These must map cleanly to `AIProviderError` kinds so `ResilientProvider` reacts correctly (retry on `network`, don't retry on `auth`/`other`).
  - **No "safety" concept.** Ollama has no safety-filter response like Gemini's. Drop the `safety` kind entirely on this path — it's fine, `ResilientProvider` treats it as a blacklist entry, not a required kind.
  - **Bundling.** The plugin is built with tsup. Prefer the native `fetch` (Node 20+) over adding an SDK dependency to keep the bundle lean and match how `isAIProviderError` already guards cross-bundle identity.

## Dependencies

- [x] Node 20+ (already required by the project)
- [x] Decide config shape — single flat `ollama_base_url` field vs. nested `ollama: { ... }` block (recommended; matches `ambient`, `security`, etc.)

## Phases

### Phase 1: Extend the provider-config surface

**Goal:** Non-API-key providers can be configured without the plugin hard-coding Gemini's assumptions.

- [x] In `plugins/ai-chat/providers/types.ts`, widen `AIProviderConfig`:

  ```ts
  export interface AIProviderConfig {
    model: string;
    maxOutputTokens: number;
    temperature: number;
    /** API key — required by hosted providers (Gemini, Claude, OpenAI); ignored by Ollama. */
    apiKey?: string;
    /** Base URL — required by Ollama; ignored by hosted providers. */
    baseUrl?: string;
    /** Per-request timeout in ms. Defaults vary by provider. */
    requestTimeoutMs?: number;
    /** Extra sampling options passed through to the provider. Free-form; each provider pulls what it understands. */
    samplingOptions?: Record<string, number | string | boolean>;
  }
  ```

- [x] Update `GeminiProvider.initialize()` to read `apiKey` as optional and throw the existing `'auth'` error if missing. No behavioural change on the Gemini path.
- [x] Update `plugins/ai-chat/index.ts` where `createResilientProvider(...)` is called to build the config object from the plugin config rather than assuming `apiKey` is always present. Use a small resolver that dispatches on `config.provider`:
  - `gemini` → pull `process.env[config.api_key_env]`, set `apiKey`.
  - `ollama` → set `baseUrl` from `config.ollama.base_url`, leave `apiKey` unset.
- [x] Verification: type-check passes (`pnpm typecheck`); existing ai-chat tests pass unchanged.

### Phase 2: Implement `OllamaProvider`

**Goal:** `createProvider('ollama')` returns a working adapter that speaks to a local Ollama endpoint.

- [x] Create `plugins/ai-chat/providers/ollama.ts` implementing `AIProvider`:

  ```ts
  export class OllamaProvider implements AIProvider {
    readonly name = 'ollama';
    private baseUrl = 'http://127.0.0.1:11434';
    private modelName = '';
    private temperature = 0.9;
    private maxOutputTokens = 256;
    private requestTimeoutMs = 60_000;
    private extraOptions: Record<string, number | string | boolean> = {};
    private useServerTokenizer = false;
    // ...
  }
  ```

  - [x] `initialize(config)` — validates `baseUrl`, strips trailing slash, stores sampling options, pings `GET /api/tags` with a short (5 s) timeout to fail fast if the daemon is down. If the configured `model` isn't in the tag list, log a WARNING but **do not throw** — the user might pull it after the bot starts. The first `complete()` call will surface a clear 404-to-`network`-or-`other` error.
  - [x] `complete(systemPrompt, messages, maxTokens)` — POSTs to `/api/chat` with `stream: false`:

    ```json
    {
      "model": "<modelName>",
      "messages": [
        {"role":"system","content":"<systemPrompt>"},
        ...mapped history
      ],
      "stream": false,
      "options": {
        "temperature": <temperature>,
        "num_predict": <maxTokens>,
        ...extraOptions
      }
    }
    ```

    Use `AbortController` + `setTimeout` to enforce `requestTimeoutMs`. Parse `response.message.content` for `text`, and `prompt_eval_count` / `eval_count` for usage. If either field is missing (older Ollama), return `0` — `TokenTracker` handles zero as "unknown" already.

  - [x] `countTokens(text)` — if `useServerTokenizer`, POST `/api/tokenize` with `{ model, prompt: text }`, return `tokens.length`. Otherwise return `Math.ceil(text.length / 4)`. The 4-char heuristic is standard and intentionally conservative.
  - [x] `getModelName()` — return the configured model.

- [x] Create `plugins/ai-chat/providers/ollama-errors.ts` (or inline — your call) with a `mapOllamaError(err, status?)` helper mirroring `mapGeminiError()`:
  - `ECONNREFUSED` / `ENOTFOUND` / `fetch failed` / `AbortError` → `network`
  - HTTP `404` → `other` with message `"Ollama model '<name>' not pulled"` (deterministic — don't retry)
  - HTTP `400` → `other` (prompt shape is wrong — bug, not transient)
  - HTTP `500`+ → `network` (retry-eligible)
  - Anything else → `other`
- [ ] Verification: run the new provider by hand from a one-off script against a live Ollama; confirm a 3-message conversation round-trips and usage counts are non-zero.

### Phase 3: Register in factory; wire config

**Goal:** `"provider": "ollama"` in `config/plugins.json` activates the new path end-to-end.

- [x] `plugins/ai-chat/providers/index.ts`:

  ```ts
  case 'ollama':
    return new OllamaProvider();
  ```

- [x] `plugins/ai-chat/config.json` — add defaults (do **not** flip `provider` from `gemini`):

  ```json
  "ollama": {
    "base_url": "http://127.0.0.1:11434",
    "request_timeout_ms": 60000,
    "use_server_tokenizer": false
  }
  ```

- [x] Plugin config resolver (in `index.ts`) reads `config.ollama.*` and passes them through to `AIProviderConfig`. Keep the Gemini keys (`api_key_env`) working — they're only consulted when `provider === 'gemini'`.
- [x] Add a runtime guard: if `provider === 'ollama'` and `config.ollama?.base_url` is missing, refuse to load with a clear error (same style as the current missing-API-key fallback).
- [ ] Verification: flip `provider` to `"ollama"` in a local test config, `.reload ai-chat`, send `!ai hi` — bot replies via Ollama. Flip back to `"gemini"`, reload, bot works via Gemini. No restart needed.

### Phase 4: Tune rate limits and resilience for local inference

**Goal:** Defaults appropriate for a local, quota-free-but-latency-bound provider.

- [x] Ollama has no external RPM/RPD. The existing `rate_limits.global_rpm` / `global_rpd` still serve as **abuse ceilings** (one user can't ddos the NUC), but we'll recommend raising them. Add an example profile in README (do not change defaults — the default is conservative and correct for Gemini):

  ```json
  "rate_limits": {
    "user_burst": 5,
    "user_refill_seconds": 6,
    "global_rpm": 60,
    "global_rpd": 20000,
    "rpm_backpressure_pct": 90
  }
  ```

- [x] `ResilientProvider` defaults are fine, but with local inference `network` errors are often immediate (daemon down) rather than flaky — 2 retries with 500 ms backoff will trip the breaker fast on an outage, which is the behaviour we want. No code change; just confirm with a test.
- [x] Document in the README that when Ollama is down, the circuit opens for 5 min — operator is expected to `docker compose up -d` and let the next request half-open the circuit. No bot restart required.

### Phase 5: Tests

**Goal:** Regression coverage for the Ollama path at parity with Gemini.

- [x] `plugins/ai-chat/providers/ollama.test.ts` — mock `fetch`. Cover:
  - [x] `initialize` rejects when `baseUrl` is missing; logs (not throws) when the model isn't in `/api/tags`.
  - [x] `complete` maps a successful response to `AIResponse` with correct usage fields.
  - [x] `complete` maps `404` to `AIProviderError{ kind: 'other' }` (not retryable).
  - [x] `complete` maps `ECONNREFUSED` / `AbortError` to `kind: 'network'` (retryable).
  - [x] `complete` honours `AbortController` timeout — fake timers, `vi.useFakeTimers()`.
  - [x] `countTokens` with `useServerTokenizer: false` uses the 4-char heuristic.
  - [x] `countTokens` with `useServerTokenizer: true` calls `/api/tokenize` and returns `tokens.length`.
- [x] `plugins/ai-chat/providers/index.test.ts` (extend) — `createProvider('ollama')` returns `OllamaProvider`; unknown provider still throws.
- [x] `plugins/ai-chat/providers/resilient.test.ts` (extend, not replace) — add a case that an `OllamaProvider`-style `network` error retries and then trips the breaker after threshold. (Mostly already covered by Gemini tests — just assert it's provider-agnostic.)
- [x] Verification: `pnpm test` green; coverage on `ollama.ts` ≥ what Gemini has.

### Phase 6: Docs

**Goal:** A user landing on `plugins/ai-chat/README.md` can switch providers without reading source.

- [x] Update README `## Setup` — add an "Ollama" subsection with the config block and a pointer to `docs/plans/ollama-self-hosting.md` for the server side.
- [x] Update README `## Privacy` — note that Ollama is the private default when self-hosted.
- [x] Update README `## Resilience` — note that "network" errors from Ollama mean the daemon is down, and circuit-breaker behaviour is the same.
- [x] Update `CHANGELOG.md` under the `feature/ai-chat-plugin` section.
- [ ] Verification: paste the README Ollama steps into a clean local setup — they work without extra lookup.

### Phase 7 (optional): Gemini fallback chain

**Goal:** If the user keeps a Gemini key configured, fall back to it when the Ollama circuit is open.

- [ ] **Only if you want this.** Adds a `FallbackProvider` that holds `[primary, secondary]` and routes to `secondary` when `primary.isOpen()` (needs a typed hook — `ResilientProvider` already exposes `isOpen()`).
- [ ] Config shape: `"fallback_provider": "gemini"`.
- [ ] Skip unless operating experience after Phase 5 says it's worth the complexity — memory notes suggest local models are good enough that a fallback may be overkill.

## Config changes

```json
// plugins/ai-chat/config.json additions
{
  "provider": "ollama",
  "model": "llama3:8b-instruct-q4_K_M",
  "ollama": {
    "base_url": "http://127.0.0.1:11434",
    "request_timeout_ms": 60000,
    "use_server_tokenizer": false
  }
}
```

`api_key_env` becomes provider-specific: required for `gemini`, ignored for `ollama`. No breaking change — Gemini users' existing configs keep working.

## Database changes

None.

## Test plan

See Phase 5 above. Summary of invariants under test:

- Provider factory returns the right class for `"ollama"`.
- `OllamaProvider.complete()` produces a valid `AIResponse` on 200 and throws a correctly-tagged `AIProviderError` on every documented failure mode.
- `ResilientProvider` behaviour is unchanged — retries `network`, doesn't retry `other`/`auth`, trips the breaker only on non-deterministic failures.
- Token counting is monotonic (longer text → more tokens) and the heuristic doesn't underestimate dangerously (quick spot-check: a 1000-char English paragraph should report ≥200 tokens).

## Resolved decisions

- **Config shape:** nested `ollama: { ... }` block, matching `ambient` / `security` / `sessions` conventions.
- **Default model:** hardcode `llama3:8b-instruct-q4_K_M` in `config.json` so operators get a working default out of the box.
- **Server tokenizer:** default **off** — use the 4-char heuristic. `use_server_tokenizer: true` remains available as an opt-in.
- **Phase 7 (Gemini fallback):** **skipped.** Local models are good enough (per memory notes); revisit only if operating experience shows it's needed.
- **Keep Gemini adapter long-term:** yes — useful for networks where the self-hosted endpoint is unavailable (e.g. running the bot off a laptop during travel).
