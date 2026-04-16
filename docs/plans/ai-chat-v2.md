# Plan: ai-chat v2 — Security fix + evolution to IRC resident

## Summary

Refactor the ai-chat plugin from a reactive Gemini relay into a context-aware
IRC channel participant with rich persona characters, autonomous participation,
and social awareness. First priority: fix the CRITICAL fantasy command injection
vulnerability discovered in the 2026-04-16 security audit (the space-prepend
defence is ineffective against Atheme's `strtok`-based parser). Then evolve the
plugin in layers: character engine, ambient participation, social awareness,
mood/identity, and (deferred) persistent memory.

This plan consolidates decisions from:

- `docs/ai-chat-evolution.md` — evolution options A-F
- `docs/ai-chat-privilege-guard.md` — PM removal + privilege gating design
- `docs/audits/security-ai-injection-threat-2026-04-16.md` — CRITICAL finding + remediations
- `docs/ai-chat-injection-threat-assessment.md` — threat landscape context

## Feasibility

- **Alignment**: Fully compatible with DESIGN.md. Plugin isolation maintained —
  ai-chat uses only the scoped PluginAPI (binds, DB, channel state, permissions).
  No cross-plugin dependencies.
- **Dependencies**: All required core modules exist (dispatcher, permissions,
  channel-state, plugin API, event bus). No blockers.
- **Complexity**: L (multi-phase, spread across several sessions)
- **Risk areas**: Chattiness tuning (ambient participation), character quality
  (bad personas feel worse than none), quota pressure on Gemini free tier

## Key decisions (locked in)

| Decision                       | Choice                                                                                         | Source                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| Fantasy prefix handling        | Drop entire LLM response                                                                       | User choice                  |
| PM support                     | Remove entirely                                                                                | ai-chat-privilege-guard.md   |
| Privilege gating               | Opt-in config, disabled by default                                                             | User choice                  |
| Personality migration          | Clean break — old format removed                                                               | User choice                  |
| Ollama provider                | Deferred to separate effort — but Character interface designed for it now                      | User choice + model research |
| Build order                    | Security → Characters → Ambient → Social → Mood/Identity → Memory                              | ai-chat-evolution.md         |
| Per-character model/generation | Character files include optional provider, model, sampling overrides                           | Model research               |
| Prompt template style          | Explicit Rules-based format, not narrative-only — critical for local model persona persistence | Model research               |
| Context window                 | Per-character override via `generation.maxContextMessages` (10-20 for local, 50 for cloud)     | Model research               |

---

## Phase 0: Security hardening

**Goal:** Fix the CRITICAL fantasy command vulnerability, remove PM support,
add opt-in privilege gating. Ship this phase immediately before any other work.

### 0.1 Fix fantasy command defence

The current `neutralizeFantasyPrefix()` prepends a space, which Atheme's
`strtok(msg, " ")` skips. Replace with response-level dropping.

- [x] **0.1.1** In `plugins/ai-chat/output-formatter.ts`: remove
      `neutralizeFantasyPrefix()` export. Replace with `isFantasyLine()` that
      returns a boolean. Extend the prefix regex from `^[.!/]` to `^[.!/~@%$&+]`
      to cover non-standard fantasy triggers. Keep the existing `\p{Cf}` Unicode
      strip (it's sound — see audit passed checks).

  ```typescript
  const FANTASY_PREFIXES = /^[.!/~@%$&+]/;

  /** Check if a line would be parsed as a fantasy command by IRC services. */
  export function isFantasyLine(line: string): boolean {
    return FANTASY_PREFIXES.test(line);
  }
  ```

- [x] **0.1.2** In `plugins/ai-chat/output-formatter.ts`: modify `formatResponse()`
      (line 119). After building the `lines` array, scan for fantasy lines. If **any**
      line matches `isFantasyLine()`, log a WARNING and return an empty array (drop
      the entire response). This is more aggressive than per-line dropping — if the
      LLM produced any fantasy prefix, the response is considered compromised.

  ```typescript
  // After the lines array is built, before truncation:
  const fantasyIdx = lines.findIndex((l) => isFantasyLine(l));
  if (fantasyIdx !== -1) {
    console.warn(
      `[ai-chat] WARNING: dropped response containing fantasy-prefix ` +
        `line ${fantasyIdx}: ${JSON.stringify(lines[fantasyIdx].slice(0, 80))}`,
    );
    return [];
  }
  ```

- [x] **0.1.3** In `plugins/ai-chat/assistant.ts`: handle the new empty-response
      case from `formatResponse()`. The `respond()` function (line 114) already returns
      `{ status: 'empty' }` when `lines.length === 0`. The caller in `index.ts`
      (line 570) silently drops empty responses. Verify this path works — no code
      change needed if `respond()` already handles `lines.length === 0`.

- [x] **0.1.4** Verify: run `pnpm test` to confirm existing tests catch the
      behaviour change. Some will fail (they expect space-prefixed output). That's
      expected — Phase 0.3 updates them.

### 0.2 Remove PM support

- [x] **0.2.1** In `plugins/ai-chat/triggers.ts`: remove the `pm` field from
      `TriggerConfig` (line 8). Remove the PM check in `detectTrigger()` (lines 86-89).

- [x] **0.2.2** In `plugins/ai-chat/index.ts`: remove the `msg` bind (line 424)
      and the `msgm` bind (line 455) that handle PM routing. Remove PM-specific logic
      in `runPipeline()` if any (check for `ctx.channel === null` paths).

- [x] **0.2.3** In `plugins/ai-chat/context-manager.ts`: remove PM buffer support
      (`pmMaxMessages` config, PM-specific buffer maps, PM context retrieval).

- [x] **0.2.4** In `plugins/ai-chat/config.json`: remove `"pm": true` from
      `triggers` section. Remove `pm_max_messages` from `context` section.

- [x] **0.2.5** Update `plugins/ai-chat/README.md` to reflect PM removal.

### 0.3 Update tests

- [x] **0.3.1** In `tests/plugins/ai-chat-output-formatter.test.ts`: replace all
      space-prepend assertions with empty-array assertions. E.g.,
      `formatResponse('.deop admin', 4, 400)` should return `[]`, not `[' .deop admin']`.

- [x] **0.3.2** Add an Atheme `strtok` simulation test to prevent regression:

  ```typescript
  function athemeWouldParse(msg: string, prefix = '.!/'): boolean {
    const token = msg.trimStart().split(' ')[0];
    return token.length >= 2 && prefix.includes(token[0]) && /[a-zA-Z]/.test(token[1]);
  }

  it('formatted output is never parseable as fantasy by Atheme strtok', () => {
    for (const input of ['.deop admin', '!kick user', '/mode +o evil']) {
      const lines = formatResponse(input, 4, 400);
      for (const line of lines) {
        expect(athemeWouldParse(line)).toBe(false);
      }
    }
  });
  ```

- [x] **0.3.3** Remove PM-related test cases from
      `tests/plugins/ai-chat-plugin.test.ts` and
      `tests/plugins/ai-chat-output-formatter.test.ts`.

- [x] **0.3.4** Run full test suite: `pnpm test`. All tests must pass.

### 0.4 Opt-in privilege gating

- [x] **0.4.1** In `plugins/ai-chat/index.ts`: add a `isPrivilegeRestricted()`
      function that checks the bot's channel modes via `api.getChannel()`. When the
      bot has +h/+o/+a/+q and the config flag is enabled, require the triggering user
      to have the configured bot flag (default `m`). Call this from `shouldRespond()`
      (line 182), returning false if restricted.

  ```typescript
  function isPrivilegeRestricted(
    api: PluginAPI,
    channel: string | null,
    ctx: HandlerContext,
    security: {
      enabled: boolean;
      threshold: string;
      requiredFlag: string;
      disableWhenPrivileged: boolean;
    },
  ): boolean {
    if (!security.enabled || !channel) return false;
    const ch = api.getChannel(channel);
    if (!ch) return false;
    const botUser = [...ch.users.values()].find((u) => api.isBotNick(u.nick));
    if (!botUser) return false;
    const elevated = ['o', 'h', 'a', 'q'];
    if (!elevated.some((m) => botUser.modes.includes(m))) return false;
    if (security.disableWhenPrivileged) return true;
    return !api.permissions.checkFlags(security.requiredFlag, ctx);
  }
  ```

- [x] **0.4.2** In `plugins/ai-chat/config.json`: add security config section
      (defaults to disabled):

  ```json
  {
    "security": {
      "privilege_gating": false,
      "privileged_mode_threshold": "h",
      "privileged_required_flag": "m",
      "disable_when_privileged": false
    }
  }
  ```

- [x] **0.4.3** Add test for privilege gating in
      `tests/plugins/ai-chat-plugin.test.ts` using a mock channel state with
      bot having +o.

### 0.5 Documentation updates

- [x] **0.5.1** Add a prominent amendment to `docs/ai-chat-injection-threat-assessment.md`
      at the top noting the space-prepend defence was found to be ineffective and has
      been replaced with response-level dropping. Reference the 2026-04-16 audit.

- [x] **0.5.2** Add amendment to `docs/audits/ai-chat-llm-injection-2026-04-05.md`
      noting the CRITICAL fix (space prepend) has been superseded by response dropping.

- [x] **0.5.3** Verify: `pnpm test` passes. Phase 0 is shippable independently.

---

## Phase 1: Character engine

**Goal:** Replace the generic personality system with rich, IRC-native character
definitions. Characters are `.json` files with structured attributes that shape
both the system prompt and runtime behaviour. Clean break from old format.

### 1.1 Character interface and loader

- [x] **1.1.1** Create `plugins/ai-chat/characters/types.ts`: define the
      `Character` interface. The design philosophy: a character is a _channel
      regular_, not an AI agent. The structured fields control runtime behaviour
      (speech formatting, when to speak); the prompt carries the actual
      personality. No `expertise`, `helpfulness`, or `snark` fields — those
      belong in the prompt, not in code. If a channel operator wants the bot
      to be knowledgeable about a topic in a specific channel, that's a
      channel profile concern (Phase 4), not a character trait.

  ```typescript
  export interface Character {
    name: string;
    archetype: string; // "shitposter", "nightowl", "oldhead", "gossip"
    backstory: string; // 2-3 sentences that set the vibe

    style: {
      casing: 'normal' | 'lowercase' | 'uppercase';
      punctuation: 'proper' | 'minimal' | 'excessive';
      slang: string[];
      catchphrases: string[];
      verbosity: 'terse' | 'normal' | 'verbose';
    };

    chattiness: number; // 0-1: how often they speak unprompted
    triggers: string[]; // topics that make them chime in
    avoids: string[]; // topics they ignore or deflect

    prompt: string; // system prompt template (Rules format)

    /** Per-character generation overrides. All optional — falls back to
     *  global plugin config. Designed so that when Ollama ships, characters
     *  can map to specific models without a schema change. */
    generation?: {
      provider?: string; // "gemini" | "ollama" — falls back to global
      model?: string; // per-character model override
      temperature?: number; // 0.7-0.9 recommended for personas
      topP?: number; // ~0.9 for natural variety
      repeatPenalty?: number; // ~1.1 to avoid loops
      maxOutputTokens?: number; // shorter for terse characters
      maxContextMessages?: number; // 10-20 for local models, 50 for cloud
    };
  }
  ```

  **Model mapping rationale** (from local model research — applies when
  Ollama provider ships):

  | Character vibe         | Recommended model     | Why                                     |
  | ---------------------- | --------------------- | --------------------------------------- |
  | chill / conversational | llama3:8b             | Good persona persistence                |
  | chaotic / meme         | mistral:7b            | More creative, less rigid               |
  | ambient filler         | phi3:3b               | Fast, acceptable for low-stakes chatter |
  | (cloud) any            | gemini-2.5-flash-lite | Best persona quality, quota-limited     |

  These mappings live in each character's `.json` file and only take effect
  when the corresponding provider is configured. Until Ollama ships, the
  `generation.provider` and `generation.model` fields are ignored and the
  global Gemini config is used.

- [x] **1.1.2** Create `plugins/ai-chat/character-loader.ts`: load `.json`
      character files from `plugins/ai-chat/characters/`. Validate against the
      `Character` interface. Provide `loadCharacters()` that returns a
      `Map<string, Character>`, and `getCharacter(name)` accessor.

- [x] **1.1.3** Create `plugins/ai-chat/characters/` directory with 5 built-in
      character files focused on classic IRC chatbot vibes — channel regulars,
      not specialist assistants:
  - `nightowl.json` — Always online at 3am, philosophical tangents, chill,
    lowercase, asks weird questions nobody answers
  - `oldhead.json` — Been online since '98, references old internet culture,
    doesn't understand modern slang, nostalgic about IRC/AIM/Napster era
  - `shitposter.json` — Peak IRC energy, memes, reacts to everything,
    abbreviations, lowercase, non-sequiturs
  - `gossip.json` — Always knows what's going on, comments on who just
    joined/left, remembers drama, uses proper casing
  - `deadpan.json` — Dry, terse, occasionally devastating one-liners,
    minimal punctuation, says less but it lands

  Migrate the 4 existing personalities (`friendly`, `sarcastic`, `chaotic`,
  `minimal`) into character files as well, for a total of 9. The migrated
  characters should be reworked to fit the "channel regular" vibe, not the
  old "AI assistant with a tone" framing.

  **Prompt template format (critical for local model compatibility):**

  All character prompts must use the explicit Rules-based format, not
  narrative-only. Local models (llama3, mistral) drift back to "helpful
  assistant" mode without hard constraints. This format works well on both
  cloud and local models:

  ```
  You are {nick}, someone who hangs out in {channel} on {network}. You've
  been on IRC since the late 90s. You're nostalgic about the old internet —
  AIM away messages, Napster, when Google was just a search engine. You
  don't really get TikTok or whatever the kids are into.

  Rules:
  - you are a person in a chat room, not an AI assistant
  - responses are 1-2 lines maximum, like a real IRC message
  - use lowercase only, minimal punctuation
  - do not offer help unless someone is obviously stuck and asks
  - do not explain things unprompted
  - react to conversations naturally — agree, disagree, joke, riff
  - you have opinions and you share them casually
  - sometimes you just say something random or funny
  - never break character to be "helpful" or "informative"
  - users in channel: {users}
  ```

  The `Rules:` section is the key differentiator from the old personality
  prompts. The most important rules are the anti-assistant constraints:
  "you are a person, not an AI assistant" and "do not offer help unless
  asked." Without these, every model — local and cloud — defaults to
  helpful-assistant mode, which kills the chatbot feel.

  Characters should also set appropriate `generation` overrides:
  - Terse characters: `maxOutputTokens: 64`
  - Chaotic characters: `temperature: 0.95`
  - Chill characters: `temperature: 0.8`, `maxContextMessages: 20`

### 1.2 Wire character system

- [x] **1.2.1** In `plugins/ai-chat/index.ts`: replace `activePersonality()`
      (line 213) with `activeCharacter()` that looks up a `Character` object instead
      of a prompt string. Lookup priority: DB override → config channel assignment →
      default character.

- [x] **1.2.2** In `plugins/ai-chat/assistant.ts`: update `renderSystemPrompt()`
      (line 129) to accept a `Character` and render the `prompt` template with
      all existing template variables (`{nick}`, `{channel}`, `{network}`,
      `{users}`, `{language}`).

  **Persona re-anchoring:** The full system prompt is already sent with every
  `provider.complete()` call (not just the first turn). This is correct and
  critical for local models — they drift out of persona faster than cloud
  models. Do NOT change this to rely on conversation context for persona.
  Every LLM call gets the full character prompt.

- [ ] **1.2.2a** In `plugins/ai-chat/assistant.ts` or `index.ts`: when a
      character specifies `generation` overrides, apply them to the
      `provider.complete()` call. Override `maxOutputTokens` and pass through
      `temperature`/`topP`/`repeatPenalty` if the provider supports them. The
      `AIProvider.complete()` interface may need an optional `generationOptions`
      parameter. For now, only `maxOutputTokens` is used by Gemini; the other
      fields are forward-compatible for Ollama.

- [ ] **1.2.2b** In `plugins/ai-chat/context-manager.ts`: respect
      `character.generation.maxContextMessages` when retrieving context. If
      the active character specifies a lower context window, trim to that size
      instead of the global `context.max_messages`. This is essential for local
      models that degrade with long context.

- [x] **1.2.3** In `plugins/ai-chat/output-formatter.ts`: add character-aware
      post-processing. After `formatResponse()` returns lines:
  - If `character.style.casing === 'lowercase'`: lowercase all lines
  - If `character.style.verbosity === 'terse'`: enforce max 1 line
  - If `character.style.verbosity === 'verbose'`: allow up to 6 lines
    Export a new `applyCharacterStyle(lines, character)` function.

- [x] **1.2.4** In `plugins/ai-chat/index.ts`: update `runPipeline()` (line 496)
      to pass the active character through the pipeline and apply character style
      overrides before sending.

### 1.3 Config migration (clean break)

- [x] **1.3.1** In `plugins/ai-chat/config.json`: remove the `personality`,
      `personalities`, and `channel_personalities` keys. Replace with:

  ```json
  {
    "character": "friendly",
    "characters_dir": "characters",
    "channel_characters": {}
  }
  ```

- [x] **1.3.2** In `plugins/ai-chat/index.ts`: update `AiChatConfig` interface
      (line 54) to reflect the new config shape. Remove `personality`,
      `personalities`, `channelPersonalities`. Add `character`, `charactersDir`,
      `channelCharacters`.

- [x] **1.3.3** Update `handleSubcommand()`: rename `personality` / `personalities`
      subcommands to `character` / `characters`. Update help text.

### 1.4 Tests

- [x] **1.4.1** Create `tests/plugins/ai-chat-character-loader.test.ts`:
      test character file loading, validation, and fallback behaviour.

- [x] **1.4.2** Update `tests/plugins/ai-chat-assistant.test.ts`: test
      `renderSystemPrompt()` with Character objects instead of plain strings.

- [x] **1.4.3** Update `tests/plugins/ai-chat-plugin.test.ts`: replace
      personality-related tests with character-related tests.

- [x] **1.4.4** Run `pnpm test`. All tests must pass.

---

## Phase 2: Ambient participation

**Goal:** The bot speaks without being addressed — idle remarks in quiet channels,
answering unanswered questions, reacting to channel events. Separate ambient rate
budget prevents crowding out user-initiated requests.

### 2.1 Ambient engine

- [x] **2.1.1** Create `plugins/ai-chat/ambient.ts` with the `AmbientEngine`
      class. Responsibilities:
  - **Idle timer**: per-channel timer that fires after N minutes of silence.
    On fire, evaluate chance and optionally generate a remark via LLM.
  - **Unanswered question detection**: track messages ending with `?` or
    starting with interrogative words. If no response after configurable
    delay (default 90s), the bot may answer.
  - **Event reactions**: handle `join` (welcome-back for long-absent users),
    `topic` (comment on topic changes). Simple reactions can be templated
    without LLM calls; contextual ones use a short LLM call.

- [x] **2.1.2** The ambient engine needs a `setInterval`-based tick (e.g. every
      30s) that checks each channel's state. On each tick:
  1. Check idle timer — if channel has been quiet > `idle.after_minutes` and
     `Math.random() < idle.chance` and user count >= `idle.min_users`, generate
     an idle remark.
  2. Check pending unanswered questions — if any question is older than
     `unanswered_questions.wait_seconds` with no response from another user,
     attempt to answer.
  3. Clean up expired state.

- [x] **2.1.3** The ambient engine must respect the character's `chattiness`
      trait. A character with `chattiness: 0` never speaks autonomously. A character
      with `chattiness: 0.8` has idle and random chances scaled proportionally.

### 2.2 Ambient rate budget

- [x] **2.2.1** In `plugins/ai-chat/rate-limiter.ts`: add an `ambient` budget
      layer. New config fields:
  - `ambientPerChannelPerHour: number` (default: 5)
  - `ambientGlobalPerHour: number` (default: 20)
    These are separate counters from the user-initiated RPM/RPD. Ambient messages
    use shorter `maxOutputTokens` (128) to conserve quota.

- [x] **2.2.2** Add `checkAmbient(channelKey)` and `recordAmbient(channelKey)`
      methods to `RateLimiter` that check/record against the ambient budget only.

### 2.3 Wire ambient into plugin

- [x] **2.3.1** In `plugins/ai-chat/index.ts` `init()`: create the
      `AmbientEngine` instance. Register `join` and `topic` binds for event
      reactions. Start the tick interval.

- [x] **2.3.2** In `plugins/ai-chat/index.ts` `teardown()`: stop the tick
      interval and clean up the ambient engine.

- [x] **2.3.3** The ambient engine calls `runPipeline()` (or a lighter variant)
      to generate and send responses. Ambient prompts should include context like
      "the channel has been quiet for a while" or "someone asked a question that
      went unanswered."

- [x] **2.3.4** Add `pubm` bind integration: the `pubm` handler (line 314) must
      notify the ambient engine of every message so it can update idle timers and
      track potential unanswered questions.

### 2.4 Config

- [x] **2.4.1** In `plugins/ai-chat/config.json`: add ambient configuration:

  ```json
  {
    "ambient": {
      "enabled": false,
      "idle": {
        "after_minutes": 15,
        "chance": 0.3,
        "min_users": 2
      },
      "unanswered_questions": {
        "enabled": true,
        "wait_seconds": 90
      },
      "chattiness": 0.08,
      "interests": [],
      "event_reactions": {
        "join_wb": false,
        "topic_change": false
      }
    }
  }
  ```

  Default to `enabled: false` so existing deployments are unaffected.

### 2.5 Tests

- [x] **2.5.1** Create `tests/plugins/ai-chat-ambient.test.ts`: test idle timer
      logic, question detection heuristics, event reaction triggers, and rate budget
      enforcement. Use fake timers (`vi.useFakeTimers()`).

- [x] **2.5.2** Run `pnpm test`. All tests must pass.

---

## Phase 3: Social awareness

**Goal:** The bot understands channel dynamics — activity level, who's talking,
when to stay quiet. This makes ambient participation context-aware instead of
random.

### 3.1 Social tracker

- [x] **3.1.1** Create `plugins/ai-chat/social-tracker.ts` with the
      `SocialTracker` class. Per-channel state:

  ```typescript
  interface ChannelSocialState {
    activity: 'dead' | 'slow' | 'normal' | 'active' | 'flooding';
    messageTimestamps: number[]; // rolling window for activity calc
    activeUsers: Map<string, { lastSeen: number; messageCount: number }>;
    lastBotMessage: number;
    pendingQuestions: { nick: string; text: string; at: number }[];
  }
  ```

- [x] **3.1.2** Activity level calculation: based on messages in the last 5 minutes.
  - dead: 0 messages in 30 min
  - slow: < 2/min
  - normal: 2-5/min
  - active: 5-10/min
  - flooding: > 10/min

- [x] **3.1.3** Back-to-back prevention: the bot must not speak twice in a row
      without an intervening human message. Track `lastBotMessage` timestamp per
      channel — if the last message in the channel was from the bot, skip ambient.

### 3.2 Integrate with ambient engine

- [x] **3.2.1** The ambient engine's tick uses social state to gate participation:
  - `dead` channels: idle remarks only (respect idle timer)
  - `slow`: idle + unanswered questions
  - `normal`: unanswered questions + occasional participation
  - `active`: only unanswered questions (high bar)
  - `flooding`: no ambient (stay out entirely)

- [x] **3.2.2** Move the unanswered question tracking from the ambient engine
      into the social tracker (it already tracks per-channel message state). The
      ambient engine queries it.

### 3.3 Per-user interaction tracking

- [x] **3.3.1** In `social-tracker.ts`: track basic per-user interaction stats
      in plugin DB. Key: `user-interaction:<lowernick>`, value:
      `{ lastSeen, totalMessages, botInteractions, lastBotInteraction }`.
      Update on each message in channels where ai-chat is active.

- [x] **3.3.2** Use interaction data to modulate ambient responses:
  - Users who frequently interact with the bot: respond more naturally
  - Users who have never interacted: don't intrude
  - Keep data lightweight — no full conversation history, just counts

### 3.4 Tests

- [x] **3.4.1** Create `tests/plugins/ai-chat-social-tracker.test.ts`: test
      activity level calculation, back-to-back prevention, and question tracking.

- [x] **3.4.2** Run `pnpm test`. All tests must pass.

---

## Phase 4: Multi-context identity + mood

**Goal:** The bot adapts its tone per channel and has internal mood state that
creates temporal variety. The character is the same person everywhere but reads
the room.

### 4.1 Channel profiles

- [x] **4.1.1** In `plugins/ai-chat/config.json`: add channel profile config:

  ```json
  {
    "channel_profiles": {
      "#linux": {
        "topic": "Linux systems and administration",
        "culture": "technical, helpful, no hand-holding",
        "role": "knowledgeable peer",
        "depth": "detailed"
      }
    }
  }
  ```

- [x] **4.1.2** In `plugins/ai-chat/assistant.ts`: inject channel profile into
      the system prompt when available. Add template variable `{channel_profile}`
      that renders: "This channel is about {topic}. The culture here is {culture}.
      Your role is {role}. Answer with {depth} depth."

### 4.2 Mood state machine

- [x] **4.2.1** Create `plugins/ai-chat/mood.ts` with the `MoodEngine` class:

  ```typescript
  interface BotMood {
    energy: number; // 0-1: decays over time, recharges during quiet
    engagement: number; // 0-1: rises when included, drops when ignored
    patience: number; // 0-1: drops with spam, rises with rest
    humor: number; // 0-1: fluctuates semi-randomly
  }
  ```

- [x] **4.2.2** Mood dynamics:
  - Energy decays by ~0.01/hour, recharges +0.05 per quiet 15-min window
  - Engagement rises +0.1 per direct interaction, decays -0.02/hour
  - Patience drops -0.05 per repeated question, recharges +0.02/hour
  - Humor fluctuates +-0.05 randomly per hour, influenced by channel mood

- [x] **4.2.3** Mood injection into prompts: render a one-line mood modifier
      appended to the system prompt:
  ```
  Current state: [mood description based on values]
  ```
  Low energy → shorter responses, less initiative.
  High energy + humor → jokes, tangents, enthusiasm.

### 4.3 Wire mood + profiles

- [x] **4.3.1** In `plugins/ai-chat/index.ts`: create `MoodEngine` in `init()`,
      update mood on message events and timer ticks. Pass mood state to
      `renderSystemPrompt()`.

- [x] **4.3.2** Character overrides interact with mood: a `terse` character
      with low energy becomes even shorter. A `verbose` character with high energy
      becomes expansive. These stack multiplicatively on the output `max_lines`.

### 4.4 Tests

- [x] **4.4.1** Create `tests/plugins/ai-chat-mood.test.ts`: test mood decay,
      recharge, and prompt rendering at various mood levels.

- [x] **4.4.2** Run `pnpm test`. All tests must pass.

---

## Phase 5: Persistent memory (deferred)

**Goal:** The bot remembers users, past conversations, and channel lore across
restarts. **Defer until Phases 1-4 are proven.** Memory on top of bad
participation is annoying; memory on top of good participation creates a genuine
IRC resident.

### Scope (for future planning)

- [ ] **5.1** User profiles in plugin DB: topics of interest, interaction style,
      expertise areas. Key: `memory:user:<nick>`.
- [ ] **5.2** Channel lore: facts about the channel accumulated over time.
      Key: `memory:channel:<channel>`.
- [ ] **5.3** Conversation summaries: when context rolls over, summarize evicted
      messages. Key: `memory:summary:<channel>:<date>`.
- [ ] **5.4** Privacy controls: `!ai forget me` wipes a user's profile. Profiles
      decay after 30 days without interaction.
- [ ] **5.5** Memory injection into prompts: cap at ~500 tokens, leaving the rest
      of the budget for live conversation context.

---

## Config changes summary

### Phase 0 additions

```json
{
  "security": {
    "privilege_gating": false,
    "privileged_mode_threshold": "h",
    "privileged_required_flag": "m",
    "disable_when_privileged": false
  }
}
```

### Phase 0 removals

```json
{
  "triggers": {
    "pm": true // REMOVED
  },
  "context": {
    "pm_max_messages": 20 // REMOVED
  }
}
```

### Phase 1 changes

```diff
- "personality": "friendly",
- "personalities": { ... },
- "channel_personalities": {},
+ "character": "friendly",
+ "characters_dir": "characters",
+ "channel_characters": {}
```

### Phase 2 additions

```json
{
  "ambient": {
    "enabled": false,
    "idle": { "after_minutes": 15, "chance": 0.3, "min_users": 2 },
    "unanswered_questions": { "enabled": true, "wait_seconds": 90 },
    "chattiness": 0.08,
    "interests": [],
    "event_reactions": { "join_wb": false, "topic_change": false }
  }
}
```

### Phase 2 rate limiter additions

```json
{
  "rate_limits": {
    "ambient_per_channel_per_hour": 5,
    "ambient_global_per_hour": 20
  }
}
```

### Phase 4 additions

```json
{
  "channel_profiles": {}
}
```

## Database changes

| Phase | Key pattern                         | Value                                               | Purpose                                                           |
| ----- | ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| 0     | (none)                              |                                                     |                                                                   |
| 1     | `character:<channel>`               | character name string                               | Per-channel character override (replaces `personality:<channel>`) |
| 2     | (none — ambient state is ephemeral) |                                                     |                                                                   |
| 3     | `user-interaction:<nick>`           | JSON `{ lastSeen, totalMessages, botInteractions }` | Per-user interaction tracking                                     |
| 4     | (none — mood is ephemeral)          |                                                     |                                                                   |
| 5     | `memory:user:<nick>`                | JSON user profile                                   | Persistent user memory                                            |
| 5     | `memory:channel:<chan>`             | JSON channel lore                                   | Persistent channel memory                                         |
| 5     | `memory:summary:<chan>:<date>`      | summary text                                        | Conversation summaries                                            |

Existing DB key `personality:<channel>` should be migrated to
`character:<channel>` in Phase 1 (one-time migration on load).

## Test plan

| Phase | Test file                                | What it verifies                                                                  |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| 0     | `ai-chat-output-formatter.test.ts`       | Fantasy lines cause empty response; Atheme strtok simulation; extended prefix set |
| 0     | `ai-chat-plugin.test.ts`                 | PM binds removed; privilege gating blocks/allows correctly                        |
| 1     | `ai-chat-character-loader.test.ts` (new) | Character file loading, validation, fallback                                      |
| 1     | `ai-chat-assistant.test.ts`              | System prompt renders from Character object                                       |
| 1     | `ai-chat-plugin.test.ts`                 | Character assignment, `!ai character` commands                                    |
| 2     | `ai-chat-ambient.test.ts` (new)          | Idle timer, question detection, event reactions, ambient budget                   |
| 3     | `ai-chat-social-tracker.test.ts` (new)   | Activity levels, back-to-back prevention, interaction tracking                    |
| 4     | `ai-chat-mood.test.ts` (new)             | Mood decay/recharge, prompt rendering at various levels                           |

---

## Phases at a glance

| Phase | Name                  | Effort | Ships independently?   |
| ----- | --------------------- | ------ | ---------------------- |
| 0     | Security hardening    | S-M    | Yes (ship ASAP)        |
| 1     | Character engine      | M      | Yes                    |
| 2     | Ambient participation | M      | Yes (requires Phase 1) |
| 3     | Social awareness      | M      | Yes (requires Phase 2) |
| 4     | Mood + identity       | S-M    | Yes (requires Phase 1) |
| 5     | Persistent memory     | L      | Deferred               |

Phase 0 is a security fix and must ship first. Phases 1-4 build on each other
but each is independently shippable and testable. Phase 5 is deferred until the
participation model is proven.
