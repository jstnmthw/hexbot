# ai-chat

AI-powered chat plugin. The bot listens for direct address (e.g. `hexbot: hi`), the `!ai <message>` command, or configured triggers, and replies using an LLM. It also acts as a channel _regular_ — an opinionated character with mood and social awareness — rather than a help-desk bot.

Ships with a pluggable provider adapter — Gemini (hosted free tier) and Ollama (self-hosted) are built in; Claude/OpenAI adapters can be added without touching plugin logic.

## Setup

### Gemini (hosted)

1. Get a free Gemini API key: <https://aistudio.google.com/apikey>. No credit card required.

2. Add the key to `config/bot.env`:

   ```
   HEX_GEMINI_API_KEY=your-api-key-here
   ```

3. Start the bot — `pnpm start` loads `config/bot.env` via `--env-file-if-exists`.

4. Enable the plugin for your channel in `config/plugins.json`:

   ```json
   {
     "ai-chat": {
       "enabled": true,
       "channels": ["#mychannel"]
     }
   }
   ```

No key? The plugin loads in degraded mode (every trigger replies with "AI chat is currently unavailable").

### Ollama (self-hosted, private)

Ollama keeps every prompt and response on your own hardware. No API key, no per-request quota — only latency and VRAM.

1. Install Ollama and pull a model. See `docs/plans/ollama-self-hosting.md` for the server-side setup.

2. Point the plugin at the daemon in `config/plugins.json`:

   ```json
   {
     "ai-chat": {
       "config": {
         "provider": "ollama",
         "model": "llama3:8b-instruct-q4_K_M",
         "ollama": {
           "base_url": "http://127.0.0.1:11434",
           "request_timeout_ms": 60000,
           "use_server_tokenizer": false
         }
       }
     }
   }
   ```

3. Because local inference has no external quota but is latency-bound, raise the rate-limit ceilings so one slow reply doesn't drain the per-user bucket:

   ```json
   "rate_limits": {
     "user_burst": 5,
     "user_refill_seconds": 6,
     "global_rpm": 60,
     "global_rpd": 20000,
     "rpm_backpressure_pct": 90
   }
   ```

4. Reload the plugin — `.reload ai-chat`. Flipping `provider` between `gemini` and `ollama` needs a reload, not a bot restart.

Token counting defaults to a conservative 4-chars-per-token heuristic (no server round-trip). Set `use_server_tokenizer: true` to use `/api/tokenize` instead — slightly more accurate, one extra request per budget check.

## Triggers

| Trigger          | Example                                                              |
| ---------------- | -------------------------------------------------------------------- |
| Direct address   | `hexbot: what's up?`, `hey hexbot?`                                  |
| Command          | `!ai tell me a joke` (prefix configurable)                           |
| Engagement       | bot's own reply window — the addressed user's next messages continue |
| Keyword (opt-in) | any configured substring match                                       |
| Random (opt-in)  | small % chance on any message                                        |
| Ambient (opt-in) | bot speaks unprompted — see _Ambient participation_                  |

After the bot replies to someone, that user's next messages in the same channel are treated as conversation continuations for `triggers.engagement_seconds` (default 60s) — no re-address needed.

Private messaging is not supported — the bot responds only in channels. This is intentional: PMs are a reconnaissance vector for testing prompt injection without channel visibility.

The bot ignores its own messages, likely-bot nicks (pattern match), users in the ignore list, users without the required flag, and users whose token bucket is drained.

## Commands

| Command                 | Access | Description                                   |
| ----------------------- | ------ | --------------------------------------------- |
| `!ai <message>`         | anyone | ask a question                                |
| `!ai character`         | anyone | show current character for this channel       |
| `!ai characters`        | anyone | list available characters                     |
| `!ai model`             | anyone | show provider and model                       |
| `!ai games`             | anyone | list available games                          |
| `!ai play <game>`       | anyone | start a game session                          |
| `!ai endgame`           | anyone | end current game session                      |
| `!ai stats`             | `+m`   | today's request and token totals              |
| `!ai ignore <target>`   | `+m`   | add nick or hostmask to ignore list           |
| `!ai unignore <target>` | `+m`   | remove from ignore list                       |
| `!ai clear`             | `+m`   | clear the channel's context window            |
| `!ai character <name>`  | `+m`   | switch character for this channel (persisted) |
| `!ai reset <nick>`      | `+n`   | reset a user's daily token budget             |

Users with the admin flag (`+m` by default) bypass the per-user token bucket; global RPM/RPD still apply.

## Characters

Characters are channel _regulars_, not AI assistants. Each one has an archetype, backstory, style rules (casing, punctuation, slang, verbosity), chattiness trait, and a `prompt` template with a strict "you are a person in a chat room, not an AI" framing.

Built-in roster (configurable per-channel):

| Character    | Vibe                                                   |
| ------------ | ------------------------------------------------------ |
| `friendly`   | approachable regular, answers when asked, doesn't push |
| `sarcastic`  | dry wit, playful roasts, never cruel                   |
| `chaotic`    | absurdist, non-sequiturs, peak IRC energy              |
| `shitposter` | memes, abbreviations, reacts to everything             |
| `deadpan`    | terse one-liners, minimal punctuation                  |
| `minimal`    | signal-only, speaks when it's worth it                 |
| `gossip`     | comments on joins/leaves, remembers drama              |
| `nightowl`   | 3am philosophical tangents, weird questions            |
| `oldhead`    | online since '98, references old internet culture      |

Drop another JSON file into `plugins/ai-chat/characters/` and it's loaded at init. See `characters/types.ts` for the schema. Template variables in `prompt`: `{nick}`, `{channel}`, `{network}`, `{users}`, `{channel_profile}`.

### Per-channel assignment

```json
"ai-chat": {
  "config": {
    "character": "friendly",
    "channel_characters": {
      "#serious": "friendly",
      "#games": "chaotic",
      "#french": { "character": "friendly", "language": "French" }
    }
  }
}
```

Admins can also switch at runtime with `!ai character <name>` — the choice persists in the plugin DB and overrides `channel_characters`.

### Channel profiles

Give the LLM hints about what a channel is for and how to answer there:

```json
"channel_profiles": {
  "#linux-help": {
    "topic": "Linux administration",
    "culture": "technical, no-nonsense",
    "role": "helpful but never condescending",
    "depth": "deep"
  }
}
```

The rendered profile is appended to the system prompt.

## Mood

An internal mood engine (energy, engagement, patience, humor) drifts over time and modulates responses — longer when energetic, shorter when tired, more jokes when humor is high. Mood is ephemeral (not persisted). A one-line mood hint is injected into the system prompt, and the `maxLines` cap is scaled by a 0.5×–1.5× verbosity multiplier.

## Ambient participation

Off by default. When `ambient.enabled: true`, the bot evaluates every 30s whether to speak unprompted based on channel activity and social state:

- **idle remarks** — in `dead` or `slow` channels after N minutes of silence (`ambient.idle.*`).
- **unanswered questions** — if a human asks a question and nobody answers within `wait_seconds`, the bot may reply.
- **join welcome-back** (`event_reactions.join_wb`) — bot may greet returning users.
- **topic reactions** (`event_reactions.topic_change`) — bot may react to a new topic.

All gated by an activity classifier (`dead`/`slow`/`normal`/`active`/`flooding`) — no ambient at all during `flooding`, idle remarks only in `slow`/`dead`. The bot never speaks back-to-back without a human in between, and hits a separate rate budget (`ambient_per_channel_per_hour`, `ambient_global_per_hour`).

## Games (sessions)

Drop a `.txt` file into `plugins/ai-chat/games/` and it's playable via `!ai play <name>`. The file contents are used as the session's system prompt. Shipped games:

- `20questions` — bot picks a thing; player asks yes/no questions.
- `trivia` — bot generates questions, tracks score and streak.

While in a game, the user's messages in that channel are routed to the game session (not the shared channel context), and the bot responds as the game host. End with `!ai endgame` or after `sessions.inactivity_timeout_minutes` (default 10) of inactivity. Game sessions bypass the per-user bucket (global RPM/RPD still enforced).

## Rate limits and budgets

Defaults sit well under Gemini's free tier (15 RPM / 1000 RPD):

- **Per-user token bucket** — `user_burst: 3`, refill one token every `user_refill_seconds: 12`.
- **RPM backpressure** — when global RPM usage crosses `rpm_backpressure_pct: 80`, each user's effective burst is halved.
- **Global RPM/RPD** — `global_rpm: 10`, `global_rpd: 800`.
- **Per-user daily tokens** — `per_user_daily: 50000`.
- **Global daily tokens** — `global_daily: 200000`.
- **Ambient budgets** — `ambient_per_channel_per_hour: 5`, `ambient_global_per_hour: 20`.

Admins (flagged `+m` by default) bypass the per-user bucket.

## Resilience

The provider is wrapped in a retry + circuit-breaker layer:

- Transient errors (429 rate-limit, 5xx network) are retried up to 2 times with exponential backoff.
- 5 consecutive hard failures → circuit opens for 5 minutes (the bot responds "AI is temporarily unavailable" until it closes).
- Safety-blocked responses get a polite refusal.

With Ollama, `network` errors almost always mean the daemon is down (ECONNREFUSED) rather than an intermittent hiccup, so the circuit trips fast. Recover by bringing the daemon back up (`docker compose up -d` / `systemctl start ollama`) — the breaker half-opens on the next request and closes on success. No bot restart needed. `other`-kind errors (404 model not pulled, 400 bad prompt) are deterministic and do not trip the breaker; fix the config and try again.

## Security — ChanServ fantasy-command defense

Any channel message starting with `.`, `!`, `/`, `~`, `@`, `%`, `$`, `&`, or `+` can be parsed by IRC services (Atheme ChanServ, Anope BotServ, etc.) as a **fantasy command** and executed against the **sender's** ACL. Since the bot typically has ChanServ op access (for auto-op and takeover recovery), a prompt-injected LLM emitting `.deop admin` would have ChanServ deop the admin on the bot's behalf.

**Defense (automatic):** `output-formatter.ts` scans every line of the LLM response for fantasy-command prefixes. If **any** line starts with one, the **entire response is dropped** and a WARNING is logged. This is intentionally aggressive — if the LLM produced a fantasy prefix, the response is considered compromised. Unicode format characters (`\p{Cf}`) are stripped before the check to prevent invisible character smuggling.

**Defense-in-depth (`SAFETY_CLAUSE`):** Every system prompt is suffixed with a non-overridable two-part clause appended last in `renderSystemPrompt()`, so no character template can pre-empt it. The first sentence tells the model never to begin a line with `.`, `!`, or `/` (closes the machine-execution path even before the output-formatter drops it). The second sentence frames the bot as a regular channel user with no knowledge of operator commands, services syntax (ChanServ/NickServ/BotServ/etc.), channel mode letters, or ban masks — so when a human asks "what's the command to transfer founder?" the bot answers with honest ignorance instead of a working recipe an unwary admin might paste.

**Privilege gating (opt-in):** When the bot has elevated channel modes (half-op or above), you can restrict AI responses to users with a specific bot flag:

```json
{
  "security": {
    "privilege_gating": true,
    "privileged_mode_threshold": "h",
    "privileged_required_flag": "m",
    "disable_when_privileged": false,
    "disable_when_founder": true
  }
}
```

Set `disable_when_privileged: true` to disable AI responses entirely when the bot has ops.

**Founder-disable gate (`disable_when_founder`, default `true`):** ai-chat refuses to respond in any channel where the bot's ChanServ tier is `founder`. The check runs twice — once at trigger time, once right before each line is sent to IRC — so a ChanServ probe that resolves mid-request still blocks the response. The tier is read from the `chanserv_access` chanset written by chanmod's auto-detect probe (or by a manual `.chanset <chan> chanserv_access founder` override). See `docs/CHANNEL_PROTECTION.md` §"Founder access and bot-nick compromise" for the full rationale.

Operator responsibilities:

- **chanmod only probes ChanServ on channel JOIN.** If you grant the bot founder mid-session, you must immediately run `.chanset <chan> chanserv_access founder` yourself — nothing will correct the stale chanset until the bot next rejoins the channel. Treat the founder grant and the `.chanset` write as a single atomic action.
- If you deliberately want ai-chat to run at founder tier anyway (you accept the trade-off), set `disable_when_founder: false`. Keep in mind the fantasy-command dropper remains the only defence at that point.
- The cleanest topology for wanting both ai-chat _and_ full founder-level takeover recovery is two bots: an unprivileged AI bot, and a separate chanmod-only bot with founder access and no LLM / DCC / user-input surfaces.

## Privacy

Gemini's free tier may use submitted content to improve models. Don't send sensitive data. For strict privacy, switch `provider` to `ollama` — every prompt and response stays on your own hardware. The hosted Gemini path remains available for deployments where self-hosting isn't practical (e.g. running the bot off a laptop during travel).

## Configuration reference

See `config.json` in this directory for the full default config with all keys. Top-level sections: `provider`, `model`, `triggers`, `character`, `channel_characters`, `channel_profiles`, `context`, `rate_limits`, `token_budgets`, `output`, `permissions`, `ambient`, `security`, `sessions`.
