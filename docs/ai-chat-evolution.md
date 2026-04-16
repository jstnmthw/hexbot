# How should the ai-chat plugin evolve from an AI relay into an IRC resident?

## Context

The current ai-chat plugin is production-grade infrastructure — resilient provider
abstraction, circuit breakers, rate limiting, token budgets, output sanitization,
game sessions. But behaviourally it's reactive: someone addresses the bot or types
`!ai`, the bot relays to Gemini, and the response comes back. The personalities
(`friendly`, `sarcastic`, `chaotic`, `minimal`) are prompt prefixes that change
tone but not behaviour.

What's missing is the feeling that the bot _lives_ in the channel. A good IRC
chatbot should feel like a regular who happens to always be online — someone with
opinions, memory, quirks, and the social sense to know when to speak and when to
shut up.

The mIRCSim project (github.com/krylabsofficial/mIRCSim) offers useful
inspiration. It treats the IRC channel as a _narrative space_ populated by
persona-driven LLM agents, each with era-specific speech patterns, knowledge
constraints, and behavioural triggers. Its key insight is that authentic IRC
presence comes from _constrained_ personalities — not "be helpful", but "you're a
sysadmin who learned Unix on SunOS and thinks Linux is a toy." mIRCSim also
demonstrates ambient activity (idle chatter, event-driven responses, dynamic
engagement) and RPG-style narrative arcs that emerge from chat dynamics.

### What already exists that we can build on

- **Context manager** — sliding window of channel history (50 messages, 60 min TTL)
- **Trigger system** — already supports `random_chance` (currently 0) and keywords
- **Personality system** — per-channel personality overrides with template variables
  (`{nick}`, `{channel}`, `{network}`, `{users}`)
- **Session system** — isolated conversation contexts (currently used for games)
- **Plugin API** — `api.getUsers(channel)` for user lists, timer support via
  `setInterval`, channel event binds (`join`, `part`, `topic`, `nick`, `quit`)
- **Rate limiting** — already enforces global RPM/RPD, extensible to new pipelines

### Constraints

- Single bot identity (not multi-persona like mIRCSim — hexbot is one bot on a
  real network)
- Gemini free tier: 15 RPM, 1000 RPD, 250K TPM — every autonomous utterance
  burns quota
- IRC culture: bots that talk too much get kicked. Channels have norms.
- Plugin isolation: ai-chat can't depend on other plugins, only core APIs
- Must remain hot-reloadable

---

## Option A: Ambient Participant

_The bot watches the channel and sometimes speaks up on its own._

### How it works

Add a **participation engine** alongside the existing reactive pipeline. The bot
silently observes all channel messages (it already does, for context). Periodically
or on specific triggers, it decides whether to say something:

1. **Idle timer** — after N minutes of channel silence, the bot may say something:
   a random thought, a callback to an earlier conversation, a question. Configurable
   per channel (`idle_after_minutes: 15`, `idle_chance: 0.3`).

2. **Topic drift hooks** — the bot notices when conversation shifts to something in
   its "interest areas" (configurable keywords or semantic categories). Instead of
   waiting to be addressed, it chimes in naturally: "oh man, I just read about
   that" or "wait, are you talking about the CVE from last week?"

3. **Unanswered question detection** — if someone asks a question (heuristic: ends
   with `?`, or starts with interrogative words) and nobody responds for 60-90
   seconds, the bot may offer an answer. This is the most useful autonomous
   behaviour and the least annoying.

4. **Event reactions** — the bot reacts to channel events: someone joins after being
   gone a long time ("wb, haven't seen you in a while"), topic changes, netsplits.
   These are cheap (no LLM call needed for simple reactions, or one short call for
   a contextual remark).

5. **Conversation participation** — when the channel is actively discussing
   something, the bot occasionally contributes without being addressed. Requires
   a **chattiness dial** (0 = never, 1 = always, default 0.05-0.15) and a
   **relevance gate** (only speak if the context window suggests the bot has
   something to add).

### Configuration sketch

```json
{
  "ambient": {
    "enabled": true,
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
    "interests": ["linux", "security", "programming"],
    "event_reactions": {
      "join_wb": true,
      "topic_change": true
    }
  }
}
```

### Quota management

Every autonomous utterance costs RPM/RPD. The current rate limiter can be extended
with a separate `ambient` budget (e.g. max 5 ambient messages/hour/channel) that
doesn't compete with user-initiated requests. Idle messages and unanswered-question
answers can be short (128 tokens max) to conserve budget.

- **Pro**: Most impactful single change — transforms the bot from reactive to alive
- **Pro**: Modular — each sub-feature (idle, questions, events) can ship independently
- **Pro**: `random_chance` trigger already exists, just needs to be smarter
- **Con**: Getting the chattiness dial right is hard — too much and the bot is annoying,
  too little and the feature is invisible
- **Con**: Burns quota on messages nobody asked for
- **Con**: Unanswered-question detection needs a timer/delay mechanism
- Effort: **M** (idle + events are straightforward, smart participation is harder)
- Compatibility: Fully compatible — extends existing trigger system

---

## Option B: IRC Character Engine

_Replace generic personality prompts with deep, IRC-native character sheets._

### How it works

Instead of "you are friendly and concise", the personality system becomes a
**character engine** with structured attributes that shape both the system prompt
and behavioural rules:

```typescript
interface Character {
  // Identity
  name: string; // Display name in prompts
  backstory: string; // 2-3 sentence origin story
  archetype: string; // "grizzled sysadmin", "enthusiastic junior dev"

  // Speech patterns
  style: {
    casing: 'normal' | 'lowercase' | 'uppercase';
    punctuation: 'proper' | 'minimal' | 'excessive!!!';
    slang: string[]; // ["tbh", "ngl", "imo"]
    catchphrases: string[]; // ["have you tried turning it off and on again"]
    verbosity: 'terse' | 'normal' | 'verbose';
    emoji: boolean;
  };

  // Knowledge & opinions
  expertise: string[]; // Topics they're knowledgeable about
  opinions: Record<string, string>; // "vim": "the only editor", "rust": "overrated"
  era: string; // "90s IRC veteran", "modern dev", "eternal newbie"

  // Behaviour
  chattiness: number; // How often they speak autonomously (0-1)
  helpfulness: number; // How eager to answer questions (0-1)
  snark: number; // Sarcasm/edge level (0-1)
  triggers: string[]; // Topics that make them speak up
  avoids: string[]; // Topics they ignore or deflect
}
```

### Example characters

**"oldtimer"** — Grizzled Unix sysadmin, been on IRC since EFnet in '94. Types in
lowercase, no punctuation. Knows everything about Unix, DNS, and network
infrastructure. Thinks modern web dev is ridiculous. Will rant about systemd if
provoked. Responds to questions about Linux/BSD/networking unprompted.

```
you are {nick}, a grizzled unix sysadmin who's been on irc since efnet in 94.
you type in lowercase with minimal punctuation. you know unix systems, dns,
networking, and security inside and out. you think modern web frameworks are
absurd complexity for what used to be a cgi script. you have strong opinions
about systemd (against), vim (for), and bsd (respect). you sometimes reference
old irc wars, netsplits, and the days when you could get root on half the
internet. you're helpful but gruff — you'll answer questions but you'll also
make fun of the question. if someone mentions docker or kubernetes you sigh
audibly. users in {channel}: {users}
```

**"curious"** — Junior developer, excited about everything, asks follow-up
questions. Uses proper casing and emoji sparingly. Doesn't have deep expertise but
is good at looking things up and synthesizing. Tends to engage with whatever topic
is active.

**"operator"** — Channel regular who's been ops forever. Knows the channel's
culture and history. Keeps conversations on track, mediates disputes, knows when
to kick and when to let things play out. Dry sense of humour.

**"researcher"** — Academic type, precise language, cites sources. Deep knowledge
in specific domains. Doesn't do small talk. Only speaks when they have something
substantive to add.

**"chaos"** — Pure IRC energy. Non-sequiturs, obscure references, starts
tangential conversations. The person who makes the channel fun but also
occasionally derails serious discussion.

### Character file format

Move personalities out of config.json into individual files under
`plugins/ai-chat/characters/`:

```
plugins/ai-chat/characters/
  oldtimer.json
  curious.json
  operator.json
  researcher.json
  chaos.json
```

Each file contains the full Character definition plus the rendered system prompt
template. This makes characters shareable, versionable, and easy to add without
touching plugin config.

### Behavioural rules vs. prompt-only

The key insight from mIRCSim is that characters need _behavioural rules_, not just
prompt adjustments. A "terse" character shouldn't just be told "be brief" — the
output formatter should enforce a lower `max_lines` for that character. A
"lowercase" character should have post-processing that lowercases the output. A
character with high `chattiness` should have a higher `random_chance` effective
value:

```typescript
// Derive runtime config from character traits
function characterOverrides(char: Character): Partial<AiChatConfig> {
  return {
    triggers: { random_chance: char.chattiness * 0.15 },
    output: {
      max_lines: char.style.verbosity === 'terse' ? 1 : char.style.verbosity === 'verbose' ? 6 : 3,
    },
    // etc.
  };
}
```

- **Pro**: Makes the bot actually feel like a person, not an AI assistant
- **Pro**: Characters are self-contained and shareable — community can contribute
- **Pro**: Per-channel character assignment already works
- **Pro**: mIRCSim demonstrates that constrained personas produce more authentic output
- **Con**: Good characters are hard to write — bad ones feel worse than no character
- **Con**: Behavioural rules add complexity to the pipeline (character-aware formatting)
- **Con**: Characters need testing across different LLM providers/models
- Effort: **M** (character file format is easy, behavioural rules are the work)
- Compatibility: Replaces `personalities` config — migration path needed

---

## Option C: Social Awareness Layer

_The bot understands channel dynamics and uses that to decide when and how to
participate._

### How it works

Add a **social state tracker** that builds a model of the channel beyond raw
message history:

1. **Activity tracking** — messages per hour, active users, quiet periods. The bot
   knows if the channel is "dead" (0 messages in 30 min), "slow" (1-2/min),
   "active" (5+/min), or "flooding" (10+/min). Behaviour adapts: speak more in
   dead channels, less in active ones.

2. **Conversation detection** — identify when users are having a conversation vs.
   drive-by messages. Two users exchanging 3+ messages in 5 minutes = conversation.
   The bot can decide to join or stay out.

3. **Topic tracking** — lightweight topic extraction from recent messages. Not
   full NLP, but keyword frequency + the bot's context window. Enables "I notice
   you're talking about X" without full semantic understanding.

4. **User familiarity** — track interaction history with specific users (stored in
   plugin DB). Users who frequently talk to the bot get more natural responses.
   New users might get a friendlier introduction. Users who've told the bot to
   shut up get reduced chattiness toward them.

5. **Channel mood** — heuristic sentiment from recent messages. High energy?
   Match it. Tense? Stay neutral. Late-night quiet? Chill vibes.

### State model

```typescript
interface ChannelState {
  activity: 'dead' | 'slow' | 'normal' | 'active' | 'flooding';
  activeUsers: Map<string, { lastSeen: number; messageCount: number }>;
  conversations: { participants: string[]; topic?: string; since: number }[];
  recentTopics: string[];
  mood: 'chill' | 'normal' | 'energetic' | 'tense';
  lastBotMessage: number; // Avoid talking back-to-back
}
```

### Integration with participation

Social state feeds into participation decisions:

```
Should the bot speak?
  ├── Channel is dead + idle timer expired → yes (ambient)
  ├── Active conversation + bot is relevant → maybe (chattiness * relevance)
  ├── Someone asked a question + no answer → yes (helpful)
  ├── Channel is flooding → no (stay out)
  ├── Bot just spoke < 2 min ago → no (cooldown)
  └── User previously told bot to shut up → no (respect)
```

- **Pro**: Solves the hardest problem — _when_ to speak — with real channel data
- **Pro**: Prevents the bot from being annoying in busy channels
- **Pro**: User familiarity creates a sense of relationship over time
- **Pro**: Can work with or without ambient participation (improves reactive mode too)
- **Con**: Activity tracking adds memory overhead per channel
- **Con**: Conversation detection is imprecise without semantic understanding
- **Con**: Mood detection is fragile — sarcasm, irony, in-jokes confuse heuristics
- Effort: **M-L** (activity tracking is easy, conversation/mood detection is research)
- Compatibility: New module, plugs into trigger decision logic

---

## Option D: Persistent Memory

_The bot remembers users, past conversations, and channel lore across restarts._

### How it works

The current context manager is ephemeral — 50 messages, 60-minute TTL, lost on
reload. A persistent memory layer would give the bot continuity:

1. **User profiles** — stored in plugin DB, built up over interactions. What
   topics a user is interested in, how they like to be addressed, their expertise
   areas, past questions they asked. Not surveillance — topical memory that makes
   the bot feel like it remembers you.

   ```
   DB key: user:lowercasenick
   Value: { topics: ["rust", "homelab"], style: "casual", lastSeen: ...,
            interactions: 47, notes: "prefers terse answers" }
   ```

2. **Channel lore** — facts about the channel accumulated over time. "This channel
   is mostly about Linux", "The regulars here are nick1, nick2, nick3", "They
   don't like off-topic political discussion". Injected into the system prompt as
   additional context.

3. **Conversation summaries** — when the context window rolls over, summarize the
   evicted messages and store the summary. This gives the bot a sense of "earlier
   today we were talking about X" without keeping all messages.

4. **Relationship tracking** — how the bot relates to specific users. Not a full
   social graph, but enough to adjust tone: "nick1 is always friendly to the bot",
   "nick2 mostly ignores it", "nick3 asks it questions a lot". This feeds into
   prompt context.

### Memory injection into prompts

The system prompt template gains a `{memory}` section:

```
You are {nick} in {channel}. {personality_prompt}

What you know about this channel: {channel_lore}
Users here now: {users}
Recent history: {conversation_summary}
{user_context}  // Injected per-user for the person who triggered
```

### Memory management

- **Budget**: Memory context competes with message history for token budget.
  Cap memory injection at ~500 tokens, leaving the rest for conversation.
- **Staleness**: Profiles decay — reduce confidence in facts older than 30 days.
- **Privacy**: `!ai forget me` command to wipe a user's profile.
- **Summary generation**: Use a cheap LLM call (or even a local model) to
  summarize evicted context. Or extract keywords without an LLM call.

- **Pro**: Creates genuine continuity — "oh hey, did you fix that Rust issue from
  last week?"
- **Pro**: Channel lore makes the bot feel like it belongs to the community
- **Pro**: User profiles improve response quality (knows user's expertise level)
- **Pro**: `!ai forget me` respects user autonomy
- **Con**: Memory management is complex — what to keep, what to forget, staleness
- **Con**: Summary generation burns extra API calls
- **Con**: Privacy concerns — users may not want to be profiled
- **Con**: Memory injection eats into the token budget
- Effort: **L** (storage is easy, memory curation is the hard part)
- Compatibility: Extends context manager + prompt rendering, uses existing DB API

---

## Option E: Mood & Energy System

_The bot has internal state that changes over time, affecting how it behaves._

### How it works

Inspired by Tamagotchi-style state machines and mIRCSim's activity presets, the
bot maintains an internal **mood model** that evolves based on channel activity and
interactions:

```typescript
interface BotMood {
  energy: number; // 0-1: low = quiet/sleepy, high = chatty/enthusiastic
  engagement: number; // 0-1: how invested in current conversation
  patience: number; // 0-1: drops with repeated questions, rises with rest
  humor: number; // 0-1: likelihood of joking vs. being serious
}
```

### Dynamics

- **Energy** decays over time (simulates getting "tired"), recharges during quiet
  periods. High energy = more likely to participate, use exclamation marks, ask
  follow-up questions. Low energy = terse, more likely to ignore random messages.

- **Engagement** rises when the bot is included in conversation, drops when
  ignored. High engagement = references earlier messages, follows up. Low
  engagement = generic responses.

- **Patience** drops when users ask the same thing repeatedly or spam the bot.
  Low patience = shorter answers, may decline to respond ("I already answered
  that"), passive-aggressive.

- **Humor** fluctuates semi-randomly but is influenced by channel mood. High
  humor = jokes, puns, playful deflection. Low humor = straight answers.

### Surface effects

Mood doesn't change the character — it modulates it. A "grizzled sysadmin" with
low energy is still a grizzled sysadmin, just one who's been on-call all night.
The mood is injected as a modifier into the system prompt:

```
Current state: You're feeling tired and a bit impatient — keep responses shorter
than usual and don't go out of your way to help unless it's interesting.
```

Or for high energy + high humor:

```
Current state: You're in a great mood, feeling chatty. Crack jokes, engage with
tangents, be the life of the channel.
```

- **Pro**: Creates the illusion of a living entity, not a stateless function
- **Pro**: Natural self-regulation — tired bot talks less, reducing quota usage
- **Pro**: Adds variety to responses even with the same character
- **Pro**: Fun for users to observe and interact with ("the bot seems grumpy today")
- **Con**: Tuning mood dynamics is fiddly — wrong parameters feel robotic
- **Con**: Users may find it frustrating when the bot "won't help because it's tired"
- **Con**: Another axis of complexity in the prompt pipeline
- Effort: **S-M** (the state machine is simple, tuning is the work)
- Compatibility: Injects into prompt rendering, no structural changes needed

---

## Option F: Multi-Context Identity

_The bot is one entity but behaves differently across channels — not just different
personalities, but different roles and knowledge._

### How it works

Instead of assigning a different personality per channel, the bot has a **single
coherent identity** that adapts to context, like a person who acts differently at
work vs. a bar vs. a family dinner:

- In `#linux`, the bot leans into its technical knowledge, gives longer answers,
  is more formal.
- In `#offtopic`, the bot is chatty, jokes around, shares random facts.
- In `#security`, the bot is careful, precise, adds caveats.
- In a PM, the bot is more personal and direct.

This is more than per-channel personality overrides — it's a unified character that
_understands_ the channel it's in and adapts. The system prompt includes channel
context:

```
You are {nick}. Your core personality is [character]. You're currently in
{channel}, which is about {channel_topic}. The vibe here is {channel_culture}.
Adapt your tone and depth accordingly — you're the same person everywhere, but
you read the room.
```

### Channel profiles

Stored in config or built up from observation:

```json
{
  "channel_profiles": {
    "#linux": {
      "topic": "Linux systems and administration",
      "culture": "technical, helpful, no hand-holding",
      "role": "knowledgeable peer",
      "depth": "detailed"
    },
    "#offtopic": {
      "topic": "anything goes",
      "culture": "casual, memes welcome",
      "role": "regular chatter",
      "depth": "brief"
    }
  }
}
```

- **Pro**: More realistic than personality switching — people don't become different
  people in different rooms
- **Pro**: Simpler to configure than full characters per channel
- **Pro**: Works well with persistent memory (the bot remembers cross-channel context)
- **Con**: Requires knowing what each channel is about (config or observation)
- **Con**: Subtle — users may not notice the adaptation
- Effort: **S** (mostly prompt engineering + config structure)
- Compatibility: Extends existing `channel_personalities` config

---

## Recommendation

**Build these as layers, in this order:**

### Phase 1: Character Engine + Ambient Basics (Options B + A partial)

**Confidence: High**

Start with rich characters (Option B) because they're the foundation everything
else builds on. A "grizzled sysadmin" with ambient participation feels alive. A
"friendly assistant" with ambient participation feels like Clippy.

Simultaneously add the simplest ambient features from Option A:

- **Idle channel remarks** (timer-based, low chance, short responses)
- **Unanswered question detection** (the highest-value autonomous behaviour)
- **Event reactions** (join welcomes, topic reactions — some without LLM calls)

Ship characters as `.json` files in `plugins/ai-chat/characters/`. Migrate the
existing four personalities to the new format for backwards compatibility.

### Phase 2: Social Awareness (Option C)

**Confidence: Medium-High**

Once the bot can speak autonomously, it needs to know _when_. The social awareness
layer prevents the bot from being annoying:

- Activity level detection (dead/slow/active/flooding)
- Back-to-back prevention (don't speak twice in a row)
- Per-user interaction tracking (basics only — who talks to the bot, who doesn't)
- Smart chattiness adjustment based on channel activity

This phase turns the ambient features from "random timer" to "situationally aware."

### Phase 3: Multi-Context Identity + Mood (Options F + E)

**Confidence: Medium**

Channel profiles and mood create variety and realism. The bot feels different in
`#linux` vs. `#offtopic` — not a different person, but the same person reading the
room. Mood adds temporal variety so the bot doesn't feel like a broken record.

These are refinements, not transformations. They make the bot _better_ but don't
change what it fundamentally does.

### Phase 4: Persistent Memory (Option D)

**Confidence: Medium-Low (defer until Phases 1-3 prove out)**

Memory is the most complex and most risky. It requires careful design around
privacy, staleness, token budget competition, and curation. But it's also the
most powerful — a bot that remembers you is qualitatively different from one that
doesn't.

Defer until the bot's participation model is proven. Memory on top of bad
participation = a bot that annoyingly remembers things about you. Memory on top of
good participation = a channel resident you enjoy having around.

### Why this order

1. Characters define _who_ the bot is — everything else is _how_ it behaves
2. Ambient participation is the single biggest perception shift (reactive → alive)
3. Social awareness prevents ambient participation from being annoying
4. Multi-context identity and mood are polish, not prerequisites
5. Memory is the capstone — it needs all the other pieces to be valuable

### Token budget reality

On Gemini free tier (1000 RPD), budget allocation matters:

- User-initiated requests: ~400/day (current usage)
- Ambient participation: ~200/day (short responses, bounded per channel)
- Memory/summary generation: ~50/day (periodic, not per-message)
- Reserve: ~350/day (headroom for bursts)

This is tight. If the bot is on multiple channels, ambient participation needs
hard per-channel caps. A paid tier or local model (Ollama) would unlock more
ambient freedom.

---

## What Eggdrop does

Eggdrop doesn't have AI chat, but it has 30 years of wisdom about bot presence
on IRC:

- **Party line**: Eggdrop has an internal chat space where the bot participates.
  This normalizes the idea of bots as chat participants, not just command
  processors.

- **Scripted responses**: TCL scripts let Eggdrop react to patterns, events, and
  timers. The best Eggdrop bots have personality through carefully crafted
  responses to specific triggers — not AI, but the same _effect_ of a bot that
  feels present.

- **User records**: Eggdrop tracks users extensively — hostmasks, flags, last
  seen, channels, notes. This is the original "persistent memory" for IRC bots.
  The bot knows its regulars.

- **Channel-specific behaviour**: Eggdrop has always had per-channel settings
  and per-channel scripts. A bot that enforces in `#serious` and jokes in
  `#fun` is a 25-year-old pattern.

- **Timers**: `timer` and `utimer` are Eggdrop primitives. Bots doing things on
  schedules — greetings, announcements, random remarks — is a well-established
  pattern.

The key lesson from Eggdrop: **the bot is a channel member, not a service.** It
has a user record, it has opinions, it has history in the channel. The best
Eggdrop bots are ones where regulars think of the bot as "part of the channel"
rather than "the channel's bot." That's the target for ai-chat's evolution.

---

## Summary of options

| Option                    | Core idea                        | Effort | Impact    | Risk                         |
| ------------------------- | -------------------------------- | ------ | --------- | ---------------------------- |
| A. Ambient Participant    | Bot speaks without being asked   | M      | High      | Medium (annoyance)           |
| B. Character Engine       | Deep IRC-native personas         | M      | High      | Low                          |
| C. Social Awareness       | Understand channel dynamics      | M-L    | High      | Low                          |
| D. Persistent Memory      | Remember users and conversations | L      | Very High | Medium (privacy, complexity) |
| E. Mood & Energy          | Internal state affects behaviour | S-M    | Medium    | Low                          |
| F. Multi-Context Identity | Same person, different rooms     | S      | Medium    | Low                          |

Recommended build order: **B+A → C → F+E → D**
