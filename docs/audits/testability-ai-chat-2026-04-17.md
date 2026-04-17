## Testability Report — ai-chat plugin

_Scanned: 17 source files (`plugins/ai-chat/**/*.ts`), 17 test files (`tests/plugins/ai-chat-*.test.ts`), ~16 `as ...` cast sites_
_Date: 2026-04-17_

## Summary

ai-chat is the **healthiest large module in the codebase for testability**. Zero `as unknown as ClassName` partial-class mocks, zero `(x as unknown as { privateField })` reaches into privates. Every test uses plain object literals or `vi.fn()` against the already-exported `AIProvider` interface. The casts that do exist are `ReturnType<typeof vi.fn>` to access `.mock.calls` — that is standard vitest instrumentation, not a design smell.

The remaining friction is **seed-state ergonomics**, not mock ergonomics: `MoodEngine`, `SocialTracker`, and the module-level engagement/character maps in `index.ts` can only be driven to a specific state by replaying events, because their private collections have no injection path. Tests work — they are just slower and noisier than they could be.

Biggest actionable wins: (1) let `MoodEngine` accept a seeded mood in its constructor, (2) freeze `SocialTracker.getState()` returns to `Readonly<…>`, (3) collapse `createProvider` + `new ResilientProvider(...)` into one factory, (4) accept dependencies (provider + engagement/character state) as an optional `init()` arg to retire the `__setProviderOverrideForTesting` hatch.

---

## Real gaps — deeper look

Three patterns keep showing up. Each one is small on its own; together they are the reason ai-chat tests are longer than they need to be.

### Gap 1 — Opaque private state with no seed path

**Where:** `MoodEngine.mood` (`mood.ts:32-34`), `SocialTracker.channels` (`social-tracker.ts:67`), `SocialTracker.activeUsers`/`pendingQuestions` (same file).

**What testing looks like today:** To exercise `MoodEngine.getVerbosityMultiplier()` when mood is `"cranky"`, a test has to construct a `now` that sits at the right point on the drift curve, then call `renderMoodLine` enough times with the right events to drive the mood there. The test ends up exercising `applyTimeDrift()` as collateral — mood math becomes test scaffolding instead of the thing being tested.

**Why it's not a cast problem yet:** the suite is small. Nobody has written the test that _forces_ a cast by reaching into private fields yet. But the shape of the module guarantees that when someone needs "start the engine in state X", they will either (a) cast into privates, or (b) add a test-only setter.

**Recommended approach — `initialState` constructor arg (user-confirmed):**

```typescript
// mood.ts
export class MoodEngine {
  private mood: BotMood;

  constructor(now: NowFn = Date.now, initialMood?: Partial<BotMood>) {
    this.mood = { ...DEFAULT_MOOD, ...initialMood };
    this.now = now;
  }
}

// social-tracker.ts
export class SocialTracker {
  private channels = new Map<string, ChannelSocialState>();

  constructor(
    db: PluginDB | null,
    now: NowFn = Date.now,
    initialChannels?: Iterable<readonly [string, ChannelSocialState]>,
  ) {
    if (initialChannels) this.channels = new Map(initialChannels);
    this.db = db;
    this.now = now;
  }
}
```

**Why this shape:**

- Optional — zero impact on production call sites.
- `Partial<BotMood>` for mood means tests write `{ label: 'cranky' }` without caring about every field.
- `Iterable<[string, ChannelSocialState]>` for social-tracker mirrors `Map`'s own constructor signature, so tests can pass `[['#chan', { ...state }]]` directly.
- No `_seedForTest()` methods, no underscored exports. The seam lives in the public API where DI already lives.

### Gap 2 — `init()` is not injectable

**Where:** `index.ts:482-558` (the init block), `index.ts:57` (`__setProviderOverrideForTesting`).

**What testing looks like today:** The test must call `init()`, then immediately call `__setProviderOverrideForTesting()` before any user-message event can fire. The hatch exists specifically because `init()` reaches for `createProvider()` itself. It works, but it's a test-only export and it only solves the provider — there is no equivalent for `ContextManager`, `MoodEngine`, etc., so a test that wants to use a spy `MoodEngine` has no way to inject one.

**Recommended approach — `init()` takes an optional deps bag (user-confirmed):**

```typescript
// index.ts
export interface AIChatDeps {
  provider?: AIProvider;
  moodEngine?: MoodEngine;
  socialTracker?: SocialTracker;
  // ...only the ones a test actually wants to override
}

export async function init(api: PluginAPI, deps: AIChatDeps = {}): Promise<void> {
  const provider = deps.provider ?? createResilientProvider(cfg);
  const moodEngine = deps.moodEngine ?? new MoodEngine();
  // ...etc
}
```

**Why this shape:**

- Every field is optional — production code calls `init(api)` exactly as today.
- Tests pass `init(api, { provider: fakeProvider })` instead of calling `__setProviderOverrideForTesting` afterward; one call site instead of two, and the test is obvious at a glance.
- Adds a path for test spies on every internal collaborator, not just the provider. The hatch can be deleted.
- Extensible: new collaborators just add an optional field. No proliferation of `__setXForTesting` exports.

**Follow-on:** once this lands, `__setProviderOverrideForTesting` becomes dead code and should be removed in the same PR.

### Gap 3 — Module-level state has no lifecycle hook between tests

**Where:** `index.ts:36-47` (`engagementMap`, `characters`).

**What testing looks like today:** `teardown()` clears them, but `teardown()` is heavy (disconnects timers, nulls everything). Tests that want per-case isolation without a full teardown/init cycle have no option.

**Recommended approach — fold into the same `AIChatDeps`/`init()` lifecycle (user-preferred: clean + extensible, not over-engineered):**

```typescript
interface PluginState {
  engagement: Map<string, Set<string>>;
  characters: Map<string, Character>;
}

let state: PluginState | null = null;

export async function init(api: PluginAPI, deps: AIChatDeps = {}): Promise<void> {
  state = deps.state ?? { engagement: new Map(), characters: new Map() };
  // ...
}
```

**Why this shape (and why this much, not more):**

- No new abstraction type — `PluginState` is just the two maps that already exist, named.
- Tests that want a fresh state between cases call `init()` again with `{ state: { engagement: new Map(), characters: new Map() } }` — same injection path as every other dep, no `__resetStateForTesting` hatch.
- Future state (e.g., a mute list, a user-preference cache) goes into `PluginState` instead of adding another module-level `let`. Extensible.
- We are _not_ adding: a `PluginState` class, getter/setter methods, cross-cutting observers, or lifecycle events. Just a named bag of maps owned by `init`.

**Companion bug fix — `recordEngagement()` case normalization:** `isEngaged()` lowercases the channel; `recordEngagement()` does not. This is a prod correctness bug (mixed-case channel recorded as `"#Foo"` reads as not-engaged on `"#foo"` lookup). Fix: normalize in `recordEngagement()` to match `isEngaged()`. No multi-choice needed — it's a bug.

---

## Chaos Detector — coupling smells in source

### Will Bite

| Smell                             | Location                                                           | What                                                                                                                                                                                                 | Fix                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Mutable return over private state | `plugins/ai-chat/social-tracker.ts:67` → `getState()` at ~line 100 | `private channels = Map<string, ChannelSocialState>`; `getState()` hands the mutable entry back. Future tests (or plugin consumers) can silently mutate the tracker's internals.                     | Return `Readonly<ChannelSocialState>` (or deep clone) from `getState()`.                                                   |
| Hardcoded state factory           | `plugins/ai-chat/social-tracker.ts:191-207`                        | Private `getOrCreate()` fills `ChannelSocialState` with hardcoded defaults — tests cannot seed a channel into a specific activity/question/back-to-back state without replaying N `onMessage` calls. | Accept an optional `stateFactory?: (ch: string) => ChannelSocialState` constructor dep; default to current inline builder. |
| Tight consumer coupling           | `plugins/ai-chat/index.ts:~517` + `~524`                           | `index.ts` imports both `createProvider` and `ResilientProvider` separately, then `new ResilientProvider(createProvider(...))`. Two symbols, one concern.                                            | Export `createResilientProvider(cfg)` from `providers/index.ts`; ai-chat imports one function.                             |

### Already Biting

| Smell                                | Location                                                          | What                                                                                                                                                                                                                                                                                      | Cast site it maps to                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Opaque seed-only state               | `plugins/ai-chat/mood.ts:32-34`                                   | `private mood: BotMood` — tests can only read via `getMood()`, cannot pre-set a mood to exercise drift/cap logic. They work around it by advancing `now()` until drift naturally produces the target mood — slow and fragile.                                                             | No cast site today (tests eat the cost). Counts as a missing seam.                                                       |
| Module-level state drives public API | `plugins/ai-chat/index.ts:36-47`                                  | `engagementMap` and `characters` live at module scope with no accessor; `isEngaged()` / `activeCharacter()` read them, but tests cannot reset them between cases without calling `teardown()`. Also: `isEngaged()` lower-cases the channel, `recordEngagement()` does not — inconsistent. | No cast site today, but any test that wants to pre-seed engagement has to call `recordEngagement()` with the right args. |
| Test-only escape hatch               | `plugins/ai-chat/index.ts:57` (`__setProviderOverrideForTesting`) | An export that exists solely because there is no real injection point for the provider — the plugin instantiates it inside `init()`. Works, but documents that init is not injectable.                                                                                                    | Pattern bleeds into every test that uses a mock provider.                                                                |

### Low Risk

| Smell                       | Location                                                                | Why tolerated                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8-concrete-class init block | `plugins/ai-chat/index.ts:482-558`                                      | All 8 collaborators (`RateLimiter`, `TokenTracker`, `ContextManager`, `SessionManager`, `SocialTracker`, `MoodEngine`, `ResilientProvider`, `AmbientEngine`) are plain data/logic classes tested individually. No test needs to mock more than the provider. |
| Private circuit state       | `plugins/ai-chat/providers/resilient.ts:24-25`                          | `circuitOpenedAt` and `consecutiveFailures` are observable via behavior (next `complete()` fails fast). Tests already inject `now`/`sleep`; no private-access casts in the test file.                                                                        |
| Private init fields         | `plugins/ai-chat/providers/gemini.ts:21-25`                             | `client`, `model`, etc. are private-after-init. Tests use `vi.mock('@google/generative-ai')` — the SDK, not the class — so they never poke at private fields.                                                                                                |
| Private bucket maps         | `plugins/ai-chat/rate-limiter.ts:45-49`                                 | 4 maps + 2 windows, all driven through `check`/`record`/`checkAmbient`. Test file has zero casts and full coverage.                                                                                                                                          |
| Private session Map         | `plugins/ai-chat/session-manager.ts:19`                                 | Tested end-to-end via public API; no cast pressure.                                                                                                                                                                                                          |
| Private context buffers     | `plugins/ai-chat/context-manager.ts:34`                                 | Same — pruning observable through `getContext()`.                                                                                                                                                                                                            |
| Pure modules                | `plugins/ai-chat/triggers.ts`, `output-formatter.ts`, `games-loader.ts` | No state, no classes. Test via input/output only.                                                                                                                                                                                                            |

---

## Cast Archaeology — existing test casts

### Finding: no partial-class mocks, no private-field reaches

The entire test suite uses **one cast pattern**, and it is the legitimate one:

```typescript
(mockProvider.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(...)
(mockProvider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
```

This cast exists to access vitest's `.mock` metadata (which is not part of the `AIProvider` interface by design). It is not a sign of a testability problem. The underlying mock is built from a plain object literal that matches `AIProvider` — no class inheritance, no `as unknown as`.

| Cast family                                              | Occurrences                                                                               | Class/interface mocked                                                | Surface actually used                     | Verdict                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `as ReturnType<typeof vi.fn>` on `mockProvider.complete` | ~14 across `ai-chat-plugin.test.ts`, `ai-chat-admin.test.ts`, `ai-chat-assistant.test.ts` | `AIProvider` (already an interface in `providers/types.ts`)           | `complete()` only; `.mock.calls` metadata | **Legitimate** — vitest idiom, not a coupling smell |
| `as never`                                               | 1 at `tests/plugins/ai-chat-character-loader.test.ts:21-22`                               | `CharacterJson` (invalid-input negative test)                         | None (type narrowing only)                | Leave                                               |
| `as unknown as number`                                   | 1 at `tests/plugins/ai-chat-character-loader.test.ts:72`                                  | `Character.generation.temperature` (testing invalid config rejection) | Field read                                | Leave — this IS the test (forcing bad type in)      |

### Per-class aggregation

| Class / Module               | Test files | Cast sites                                    | Minimum interface                                    | Verdict                                                           |
| ---------------------------- | ---------- | --------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `AIProvider`                 | 3          | 14 (all vi.fn idiom)                          | Already an exported interface                        | **Already clean**                                                 |
| `GeminiProvider`             | 1          | 0 (uses `vi.mock` for SDK)                    | n/a                                                  | **Already clean**                                                 |
| `ResilientProvider`          | 1          | 0 (uses inline `AIProvider` literal as inner) | n/a                                                  | **Already clean**                                                 |
| `ContextManager`             | 1          | 0                                             | Public API only                                      | **Already clean**                                                 |
| `SessionManager`             | 1          | 0                                             | Public API only                                      | **Already clean**                                                 |
| `RateLimiter`                | 1          | 0                                             | Public API only                                      | **Already clean**                                                 |
| `TokenTracker`               | 1          | 0                                             | Public API only                                      | **Already clean**                                                 |
| `SocialTracker`              | 4          | 0                                             | Public API only (but see `getState()` mutation risk) | Already clean _today_ — will bite once a test wants to seed state |
| `MoodEngine`                 | 1          | 0                                             | Public API only                                      | Already clean _today_ — expensive seed ergonomics                 |
| `AmbientEngine`              | 1          | 0                                             | Depends on `SocialTracker` via its public interface  | **Already clean**                                                 |
| `CharacterLoader` (pure fns) | 1          | 2 (type-narrowing only)                       | n/a                                                  | **Already clean**                                                 |
| `PluginDB`                   | several    | 0 (already an interface in `src/types.ts`)    | n/a                                                  | **Already clean**                                                 |

---

## Phases

Every item below is a `- [ ]` checkbox so `/refactor` or `/build` can tick it off when the work lands.

### Phase 1 — Extract Interface

No interface extractions are warranted. `AIProvider` is already a narrow interface, `PluginDB` and `PluginPermissions` are already interfaces, and the remaining classes are consumed only by their own module or by `index.ts` (no external consumers that would benefit from narrowing).

- [ ] _(no action — documented for completeness)_

### Phase 2 — Inject via Deps

Seed-state ergonomics. Each item below makes the corresponding class cheaper to drive to a specific state in tests without changing any production call site. See **Real gaps — deeper look** above for the recommended shapes.

- [ ] **`MoodEngine` — accept `initialMood?: Partial<BotMood>` in constructor.** `plugins/ai-chat/mood.ts:32-34`. Merge over `DEFAULT_MOOD`. **Why:** tests currently advance `now()` until drift produces the target mood; mood math becomes test-scaffolding instead of test-subject. **Approach chosen:** optional constructor arg (not `_seedForTest()`) — keeps the seam in the public DI path. **Risk:** None — purely additive optional param.

- [ ] **`SocialTracker` — accept `initialChannels?: Iterable<[string, ChannelSocialState]>` in constructor.** `plugins/ai-chat/social-tracker.ts:67-72`. Signature mirrors `Map`'s own constructor so tests pass `[['#chan', {...state}]]` verbatim. **Why:** today a test that wants "channel has 4 unanswered questions and last message was bot" must replay 4+ carefully ordered `onMessage` calls. **Approach chosen:** `initialState` over `stateFactory` — simpler, covers 100% of current test needs, matches the Mood pattern. **Risk:** None.

- [ ] **`SocialTracker` — freeze `getState()` return type to `Readonly<ChannelSocialState>`.** `plugins/ai-chat/social-tracker.ts` (the `getState` method). **Why:** the current mutable return is a latent bug: any consumer (prod or test) can silently mutate the tracker's internal map entry. Compile-time fix surfaces any existing mutating caller as a prod bug. **Risk:** Low — type-only change.

- [ ] **`index.ts` — accept an optional `AIChatDeps` bag in `init()`.** `plugins/ai-chat/index.ts:482-558`. Define `AIChatDeps { provider?, moodEngine?, socialTracker?, contextManager?, sessionManager?, rateLimiter?, tokenTracker?, ambientEngine?, state? }`; each field falls back to `new X(...)` when absent. **Why:** today `init()` reaches for `createProvider()` itself, which forced `__setProviderOverrideForTesting` into existence. This seam gives tests one call site (`init(api, { provider: fake })`) instead of two, and extends the same pattern to every other collaborator. **Risk:** None — every field optional; prod call `init(api)` unchanged.

- [ ] **`index.ts` — remove `__setProviderOverrideForTesting` once `init()` accepts deps.** `plugins/ai-chat/index.ts:57`. Dead code after the dep bag lands; update the 3 test files that use it to pass via `init()` instead. **Risk:** None — mechanical test update.

- [ ] **`index.ts` — fold `engagementMap` and `characters` into a named `PluginState` owned by `init()`.** `plugins/ai-chat/index.ts:36-47`. Replace the two module-level `let`s with a single `PluginState { engagement: Map, characters: Map }` reference; accept `deps.state?` so tests can pass a fresh bag per case. **Why:** cleaner and extensible (future state lands in the same bag), but not over-engineered — no class, no accessors, just a named record owned by the same lifecycle as every other dep. **Risk:** None — all call sites are internal.

- [ ] **`index.ts` — normalize channel key in `recordEngagement()`.** `plugins/ai-chat/index.ts:~44`. `isEngaged()` lowercases, `recordEngagement()` does not — mixed-case channel recorded as `"#Foo"` reads as not-engaged on `"#foo"` lookup. Correctness bug, not just testability. **Risk:** Low — align to `isEngaged` behavior.

### Phase 3 — Chaos Detector — Will Bite

- [ ] **Collapse `createProvider` + `new ResilientProvider(...)` into one factory.** `plugins/ai-chat/providers/index.ts:19-20` and `plugins/ai-chat/index.ts:~517, ~524`. Export `createResilientProvider(cfg)` from `providers/index.ts`; ai-chat imports a single symbol. **Why:** today ai-chat is the one place that knows "wrap bare provider in resilient wrapper" — the next provider will repeat that logic. **Risk:** None — internal refactor.

- [ ] **Freeze `SocialTracker.getState()` return type** — _listed in Phase 2; also the Will-Bite mutation risk._

### Phase 4 — Leave As-Is

Documented reasons so we don't revisit these:

- [ ] **`RateLimiter`, `TokenTracker`, `ContextManager`, `SessionManager`** — private Maps/counters tested entirely through public APIs, zero cast pressure. No refactor.
- [ ] **`GeminiProvider`** — private SDK client is fine; tests mock the SDK at the module boundary via `vi.mock('@google/generative-ai')`, not the class.
- [ ] **`ResilientProvider`** — already accepts `now` and `sleep` as injectable deps; circuit state is observable through behavior. Could bundle `now`+`sleep` into a `Clock` interface for aesthetics, but low value.
- [ ] **`index.ts` 8-class init block** — not constructor bloat in the problematic sense: each collaborator is tested standalone, and the only runtime-swappable one (`AIProvider`) already has an injection seam (`__setProviderOverrideForTesting`).
- [ ] **`triggers.ts`, `output-formatter.ts`, `games-loader.ts`** — pure functions, no state, no classes. Nothing to improve.

---

## Patterns to address across the codebase

The ai-chat audit is unusually clean, so the patterns here are mostly _positive_:

1. **Provider-layer pattern is exemplary.** `AIProvider` is a narrow interface, consumers depend on the interface, and the only place that depends on a concrete class (`GeminiProvider`) is the factory. This is the model to replicate for any future pluggable surface (storage backends, DCC transports, etc.).

2. **`now`/`sleep` injection is uniformly applied.** Every time-sensitive module (`ContextManager`, `SessionManager`, `RateLimiter`, `TokenTracker`, `MoodEngine`, `SocialTracker`, `AmbientEngine`, `ResilientProvider`) takes `now?: NowFn`. This is the cleanest thing in the plugin. Same pattern should be required of any new module that reads the clock.

3. **The one recurring gap is seed-state ergonomics, not mocking.** Where there is friction, it is _never_ "I can't mock this class" — it is "I can't make this class start in state X without replaying its history." Going forward, any module with a private Map/Set that a test would want to pre-populate should take an optional `initialState` or `stateFactory` constructor arg.

4. **`__setProviderOverrideForTesting` is a signal, not a solution.** When a module needs a named test-only setter to be testable, the real fix is usually a factory or DI. The provider will outgrow this hatch the moment a second provider ships.

5. **No `as unknown as ClassName` appears anywhere in this suite.** If this becomes the codebase norm, it should be called out in the testing section of `CLAUDE.md` / `DESIGN.md` as a non-negotiable: "mocks are plain objects against exported interfaces; if you need `as unknown as`, extract the interface first."
