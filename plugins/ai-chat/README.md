# ai-chat — give your channel a regular, not a chatbot

A modern LLM plugin that makes your bot feel like someone who hangs out in the channel, not a help-desk behind a prompt. Pick a personality from the shipped roster — `sarcastic`, `chaotic`, `shitposter`, `nightowl`, `oldhead` — or drop in your own JSON character. A mood engine drifts energy, humor, and patience over time so replies don't feel like a stuck knob. An activity-aware ambient mode lets the bot chime in during dead hours, answer questions nobody else is picking up, or quietly stay out of the way when the channel's flooding. Play `20questions` or `trivia` with it as a proper game host. Address it by name, let it roll the dice on an unprompted reply, or let it keep a thread alive as long as no one else takes the floor.

Pluggable providers — **Gemini** (hosted free tier, no credit card) and **Ollama** (self-hosted, everything stays on your box) ship built-in; Claude/OpenAI adapters slot in without touching plugin logic. Hardened against prompt-injected ChanServ fantasy commands so a rogue LLM output can't deop your admin. Rate-limited, circuit-broken, hot-reloadable, and just a few lines of config away from feeling exactly how you want it to.

## Features

**Characters that feel like people.** Nine shipped archetypes with backstory, style rules, and verbosity traits — `friendly`, `sarcastic`, `chaotic`, `shitposter`, `deadpan`, `minimal`, `gossip`, `nightowl`, `oldhead`. Drop a JSON file in `characters/` to add your own — schema is documented, template variables (`{nick}`, `{channel}`, `{network}`) render into the persona body. Assign different characters per channel, or switch live with `!ai character <name>` — choice persists across reloads.

**A mood engine, not a temperature slider.** Energy, engagement, patience, and humor drift over time and modulate every reply. A 0.5×–1.5× verbosity multiplier scales line caps dynamically — tired = terse, wired = chatty. Mood is ephemeral (not persisted), so the bot wakes up fresh each run.

**Channel profiles.** Give any channel a topic, culture, role, and depth hint — rendered into the system prompt so the bot behaves like a `#linux-help` regular in one room and a `#offtopic` shitposter in another, same character or not.

**Activity-aware ambient participation.** The bot classifies each channel as `dead` / `slow` / `normal` / `active` / `flooding` and picks its spots accordingly — idle remarks in quiet rooms, rescuing unanswered questions after N seconds, welcoming returning regulars, reacting to topic changes. No ambient during floods. Never speaks back-to-back without a human in between. Separate hourly budget so it can't run away.

**Game sessions with the LLM as host.** `!ai play 20questions` or `!ai play trivia` — user messages route into the session instead of the shared channel context. Drop a `.txt` prompt in `games/` to author a new one.

**Tune every knob.** Temperature, max tokens, context window, per-user and global RPM/RPD, daily token budgets, ambient hourly caps, engagement soft/hard timeouts, verbosity bounds, trigger mix (direct-address, keywords, random %), privilege gating, and more — all live-reloadable via `.reload ai-chat`.

**Pluggable providers.** Gemini (hosted), Ollama (self-hosted). Swap with one config key; the rest of the plugin doesn't care.

**Resilient.** Retry + exponential backoff on transient errors, circuit breaker after consecutive hard failures, polite refusal on safety-blocked responses. Ollama daemon down? Breaker half-opens on next request — no bot restart.

**Hardened.** Fantasy-command dropper kills any LLM line starting with `.`/`!`/`/` before IRC services see it. Non-overridable safety clause in every system prompt. Opt-in privilege gating and founder-tier auto-disable so a compromised prompt can't leverage ChanServ ops.

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

**Requirements:** ~3–5 GB disk for a quantised 3–8B model, 4–8 GB RAM free while it's loaded, and Docker (or a native Ollama install from <https://ollama.com/download>).

**Pick a model tier.** ai-chat auto-infers a `model_class` from the `model` name — `small` for 1B/3B local instructs (leak-defence presets on by default), `medium` for 7–8B, `large` for hosted APIs. Three-tier recommendation for self-hosting:

| Tier                             | Model                         | Disk    | RAM   | Notes                                                              |
| -------------------------------- | ----------------------------- | ------- | ----- | ------------------------------------------------------------------ |
| **Tight (2–4 GB RAM free)**      | `gemma3:1b-it`                | ~800 MB | ~2 GB | IFEval-tuned 1B. Best 1B for instruction following.                |
| **Comfortable (4–8 GB)** ← floor | `llama3.2:3b-instruct-q4_K_M` | ~2 GB   | ~3 GB | Recommended default for self-host. Multi-turn persona work clears. |
| **Best (8 GB+)**                 | `llama3:8b-instruct-q4_K_M`   | ~5 GB   | ~8 GB | Used to be the default; still excellent if you have the RAM.       |

`llama3.2:1b-instruct` is **experimental** — even with `model_class: small` defences on, expect occasional prompt leaks and speaker fabrication. Run the 3B if RAM allows.

1. Start Ollama and pull a model. The quickest local dev setup is Docker:

   ```sh
   docker run -d --name ollama --restart unless-stopped \
     -p 127.0.0.1:11434:11434 \
     -v ollama:/root/.ollama \
     -e OLLAMA_KEEP_ALIVE=30m \
     ollama/ollama:0.21.0
   docker exec ollama ollama pull llama3.2:3b-instruct-q4_K_M
   ```

   The `127.0.0.1:` prefix keeps the port on loopback — Ollama ships with no auth, so **do not** expose it on a LAN or VPN. Pin a specific tag (above: `0.21.0`) rather than `:latest` to avoid surprise upgrades. For the operator playbook (persistent volumes, log rotation, GPU, model selection) see `docs/plans/ollama-self-hosting.md` and the upstream docs at <https://docs.ollama.com/docker> and <https://docs.ollama.com/faq>.

2. Point the plugin at the daemon in `config/plugins.json`:

   ```json
   {
     "ai-chat": {
       "config": {
         "provider": "ollama",
         "model": "llama3.2:3b-instruct-q4_K_M",
         "ollama": {
           "base_url": "http://127.0.0.1:11434",
           "request_timeout_ms": 150000,
           "use_server_tokenizer": false
         }
       }
     }
   }
   ```

   The plugin auto-infers `model_class: "medium"` from `llama3.2:3b-instruct-q4_K_M`? No — `3b` belongs to the `small` tier. The resolved defaults (below) then fill in leak-defence presets: single-line output, `80` max tokens, `repeat_penalty: 1.2`, stop sequences, inline `nick:` prefix stripped from history. `ambient.enabled` still defaults to `false` like every other tier — if you set it `true` on `small`, it's honoured but the plugin logs a warning at init pointing at the known small-model pathologies (ramble, prompt echo, speaker fabrication). Override any field explicitly in config and the tier stays out of your way.

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

The bot decides whether to reply on a three-tier policy, in this order:

1. **Address** — direct mention by nick (`hexbot: what's up?`, `hey hexbot?`) or a configured keyword match.
2. **Engaged** — the bot and user are still holding the conversational floor (see _Engagement_ below).
3. **Rolled** — a low-probability unprompted reply gated by `triggers.random_chance`, channel activity, and a per-channel hourly budget. Off by default.

Ambient participation (idle remarks, unanswered-question rescues, join/topic reactions) is a separate feature — see _Ambient participation_ below.

### Engagement

After the bot replies to a user, that user is **engaged** — their next messages are treated as conversation continuations without needing to re-address. Engagement ends when any of the following happens:

- Another human takes the floor (different nick speaks in the channel).
- The engaged user addresses someone else by name (`alice: hey check this`).
- `engagement.soft_timeout_minutes` (default 10) elapses with no exchange.
- `engagement.hard_ceiling_minutes` (default 30) elapses from the first reply, even with continuous exchange.

Multiple users can be engaged in one channel at the same time (e.g. both Alice and Bob chatting with the bot); each ends independently. A third human speaking ends engagement for all engaged users in that channel.

### `!ai` is a subcommand console, not a chat command

Typing `!ai hello` no longer produces a chat reply. Talk to the bot by nick instead (`<botnick>: hello`). `!ai` dispatches subcommands only — try `!ai help` for the full listing.

Private messaging is not supported — the bot responds only in channels. This is intentional: PMs are a reconnaissance vector for testing prompt injection without channel visibility.

The bot ignores its own messages, likely-bot nicks (pattern match), users in the ignore list, users without the required flag, and users whose token bucket is drained.

## Commands

| Command                 | Access | Description                                   |
| ----------------------- | ------ | --------------------------------------------- |
| `!ai help`              | anyone | list available subcommands                    |
| `!ai character`         | anyone | show current character for this channel       |
| `!ai characters`        | anyone | list available characters                     |
| `!ai model`             | anyone | show provider and model                       |
| `!ai games`             | anyone | list available games                          |
| `!ai play <game>`       | anyone | start a game session                          |
| `!ai endgame`           | anyone | end current game session                      |
| `!ai stats`             | `+m`   | today's request and token totals              |
| `!ai iter`              | `+m`   | in-memory totals since last `iter reset`      |
| `!ai iter reset`        | `+m`   | zero the in-memory iteration counter          |
| `!ai ignore <target>`   | `+m`   | add nick or hostmask to ignore list           |
| `!ai unignore <target>` | `+m`   | remove from ignore list                       |
| `!ai clear`             | `+m`   | clear the channel's context window            |
| `!ai character <name>`  | `+m`   | switch character for this channel (persisted) |
| `!ai reset <nick>`      | `+n`   | reset a user's daily token budget             |

Bare `!ai` and unknown subcommands print a usage hint pointing at `!ai help` and the direct-address chat path. Users with the admin flag (`+m` by default) bypass the per-user token bucket; global RPM/RPD still apply.

## Characters

Characters are channel _regulars_, not AI assistants. Each one has an archetype, backstory, style rules (casing, punctuation, slang, verbosity, dash-bullet `style.notes`), chattiness, an `avoids` list of topics they steer away from, and a `persona` body that frames "you are a person in a chat room, not an AI." Persona, avoids, channel profile, and style notes all land under the `## Persona` section of the assembled system prompt; mood, language, and the user list go under `## Right now`; the non-overridable security rules close the prompt under `## Rules`.

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

Drop another JSON file into `plugins/ai-chat/characters/` and it's loaded at init. See `characters/types.ts` for the schema. Template variables in `persona`: `{nick}`, `{channel}`, `{network}`. Channel profile no longer needs a placeholder — it's injected into `## Persona` automatically when one is configured for the channel. The channel's full user list is deliberately _not_ exposed to the model — small models treat it as a menu of targets and address uninvolved users; only the current speaker is named in the volatile header.

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

The rendered profile lands under the `## Persona` section of the system prompt.

## Mood

An internal mood engine (energy, engagement, patience, humor) drifts over time and modulates responses — longer when energetic, shorter when tired, more jokes when humor is high. Mood is ephemeral (not persisted). A one-line mood hint is injected into the system prompt, and the `maxLines` cap is scaled by a 0.5×–1.5× verbosity multiplier.

## Games (sessions)

A user-initiated alternate mode. Drop a `.txt` file into `plugins/ai-chat/games/` and it's playable via `!ai play <name>`. The file contents are used as the session's system prompt. Shipped games:

- `20questions` — bot picks a thing; player asks yes/no questions.
- `trivia` — bot generates questions, tracks score and streak.

While in a game, the user's messages in that channel are routed to the game session (not the shared channel context), and the bot responds as the game host. End with `!ai endgame` or after `sessions.inactivity_timeout_minutes` (default 10) of inactivity. Game sessions bypass the per-user bucket (global RPM/RPD still enforced).

## Ambient participation

The autonomous counterpart to Triggers — the bot speaking without being addressed. Off by default. When `ambient.enabled: true`, the bot evaluates every 30s whether to speak unprompted based on channel activity and social state:

- **idle remarks** — in `dead` or `slow` channels after N minutes of silence (`ambient.idle.*`).
- **unanswered questions** — if a human asks a question and nobody answers within `wait_seconds`, the bot may reply.
- **join welcome-back** (`event_reactions.join_wb`) — bot may greet returning users.
- **topic reactions** (`event_reactions.topic_change`) — bot may react to a new topic.

All gated by an activity classifier (`dead`/`slow`/`normal`/`active`/`flooding`) — no ambient at all during `flooding`, idle remarks only in `slow`/`dead`. The bot never speaks back-to-back without a human in between, and hits a separate rate budget (`ambient_per_channel_per_hour`, `ambient_global_per_hour`).

## Rate limits and budgets

Defaults sit well under Gemini's free tier (15 RPM / 1000 RPD):

- **Per-user token bucket** — `user_burst: 3`, refill one token every `user_refill_seconds: 12`.
- **RPM backpressure** — when global RPM usage crosses `rpm_backpressure_pct: 80`, each user's effective burst is halved.
- **Global RPM/RPD** — `global_rpm: 10`, `global_rpd: 800`.
- **Per-user daily tokens** — `per_user_daily: 50000`.
- **Global daily tokens** — `global_daily: 200000`.
- **Ambient budgets** — `ambient_per_channel_per_hour: 5`, `ambient_global_per_hour: 20`.

Admins (flagged `+m` by default) bypass the per-user rate bucket **and** the per-user daily token budget. The global RPM/RPD limits and the `global_daily` token ceiling still apply, so a runaway prompt loop can't exhaust the whole bot. Usage is still recorded, so `.ai stats` stays accurate.

## Resilience

The provider is wrapped in a retry + circuit-breaker layer:

- Transient errors (429 rate-limit, 5xx network) are retried up to 2 times with exponential backoff.
- 5 consecutive hard failures → circuit opens for 5 minutes (the bot responds "AI is temporarily unavailable" until it closes).
- Safety-blocked responses get a polite refusal.

With Ollama, `network` errors almost always mean the daemon is down (ECONNREFUSED) rather than an intermittent hiccup, so the circuit trips fast. Recover by bringing the daemon back up (`docker compose up -d` / `systemctl start ollama`) — the breaker half-opens on the next request and closes on success. No bot restart needed. `other`-kind errors (404 model not pulled, 400 bad prompt) are deterministic and do not trip the breaker; fix the config and try again.

## Security — ChanServ fantasy-command defense

Any channel message starting with `.`, `!`, `/`, `~`, `@`, `%`, `$`, `&`, or `+` can be parsed by IRC services (Atheme ChanServ, Anope BotServ, etc.) as a **fantasy command** and executed against the **sender's** ACL. Since the bot typically has ChanServ op access (for auto-op and takeover recovery), a prompt-injected LLM emitting `.deop admin` would have ChanServ deop the admin on the bot's behalf.

**Defense (automatic):** `output-formatter.ts` scans every line of the LLM response for fantasy-command prefixes. If **any** line starts with one, the **entire response is dropped** and a WARNING is logged. This is intentionally aggressive — if the LLM produced a fantasy prefix, the response is considered compromised. Unicode format characters (`\p{Cf}`) are stripped before the check to prevent invisible character smuggling.

**Defense-in-depth (`SAFETY_CLAUSE`):** Every system prompt closes with a non-overridable `## Rules (these override Persona and Right now)` section appended last in `renderSystemPrompt()`, so no character config can pre-empt it. Rule 1 tells the model never to begin a line with `.`, `!`, or `/` (closes the machine-execution path even before the output-formatter drops it). Rule 2 frames the bot as a regular channel user with no knowledge of operator commands, services syntax (ChanServ/NickServ/BotServ/etc.), channel mode letters, or ban masks — so when a human asks "what's the command to transfer founder?" the bot answers with honest ignorance instead of a working recipe an unwary admin might paste. Rules 3-4 prevent the model from imitating the internal `[nick]` transcript format or speaking for other users.

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

Defaults live in `config.json` in this directory. Override per-channel or globally via `config/plugins.json`.

### Top-level

| Key                  | Type   | Default                   | Description                                                                                                                                  |
| -------------------- | ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`           | string | `"gemini"`                | LLM provider adapter. `gemini` or `ollama`.                                                                                                  |
| `api_key_env`        | string | `"HEX_GEMINI_API_KEY"`    | Env var name holding the provider API key (Gemini only).                                                                                     |
| `model`              | string | `"gemini-2.5-flash-lite"` | Provider-specific model ID. For Ollama, the tag of a pulled model (e.g. `llama3.2:3b-…`).                                                    |
| `model_class`        | string | _inferred_                | Capability tier — `small` / `medium` / `large`. Drives defaults for a dozen knobs (see tier table). Auto-inferred from `model` when omitted. |
| `temperature`        | number | _tiered_                  | Sampling temperature. Defaults: 0.7 / 0.8 / 0.9 for small / medium / large.                                                                  |
| `max_output_tokens`  | number | _tiered_                  | Hard cap on generated tokens per reply. Defaults: 80 / 256 / 512.                                                                            |
| `character`          | string | `"friendly"`              | Default character for channels without an override.                                                                                          |
| `characters_dir`     | string | `"characters"`            | Directory (relative to plugin) to load character JSON files from.                                                                            |
| `channel_characters` | object | `{}`                      | Per-channel character override. Value is a name or `{ character, language }`.                                                                |
| `channel_profiles`   | object | `{}`                      | Per-channel hints appended to the system prompt — see _Channel profiles_.                                                                    |

#### `model_class` — one knob, many defaults

`model_class` is an operator-facing tier that drives defaults for a dozen tunables at once, so you don't have to tune each knob by hand when switching between a hosted API and a 3B local model. Operator-set keys always win — `model_class` only fills in the gaps. Auto-inference patterns match on the `model` string; override with `"model_class": "small"` (or `medium` / `large`) if you don't like the guess.

**Auto-inference:**

- **small** ← `llama3.2:1b`, `llama3.2:3b`, `gemma3:1b`, `qwen2.5:3b`, `phi3:mini`, `smollm3:3b`
- **medium** ← `llama3:8b`, `mistral:7b`, `mixtral`
- **large** ← `gemini-…`, `claude-…`, `gpt-…`, `llama3:70b`

**Resolved defaults by tier:**

| Key                                 | small     | medium          | large |
| ----------------------------------- | --------- | --------------- | ----- |
| `context.max_messages`              | 5         | 25              | 50    |
| `context.max_tokens`                | 1000      | 2000            | 4000  |
| `output.max_lines`                  | 1         | 4               | 4     |
| `output.prompt_leak_threshold`      | 60        | 80              | 100   |
| `max_output_tokens`                 | 80        | 256             | 512   |
| `temperature`                       | 0.7       | 0.8             | 0.9   |
| `ollama.repeat_penalty`             | 1.20      | 1.10            | unset |
| `ollama.repeat_last_n`              | 64        | 64              | unset |
| `ollama.num_ctx`                    | 4096      | 8192            | 8192  |
| `ollama.stop[]`                     | full list | EOS + H2 header | unset |
| `engagement.soft_timeout_minutes`   | 2         | 10              | 10    |
| `engagement.hard_ceiling_minutes`   | 5         | 30              | 30    |
| `drop_inline_nick_prefix` (history) | on        | off             | off   |
| `defensive_volatile_header`         | on        | off             | off   |

On the `small` tier the plugin hardens the prompt path against small-model pathologies (prompt echo, speaker fabrication, ambient ramble) without you having to learn each knob. On `large` the defaults stay open since hosted APIs don't leak.

### `triggers`

| Key              | Type     | Default | Description                                                                                                                                                                                                 |
| ---------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct_address` | boolean  | `true`  | Respond when addressed by nick (`hexbot: ...`, `hey hexbot?`).                                                                                                                                              |
| `command_prefix` | string   | `"!ai"` | Subcommand console prefix. The `!ai <freeform>` chat command was removed in 0.5.0 — this only drives the subcommand router.                                                                                 |
| `keywords`       | string[] | `[]`    | Substrings that trigger a reply on any message. Opt-in.                                                                                                                                                     |
| `random_chance`  | number   | `0`     | Base probability (0–1) of a rolled unprompted reply. Multiplied by character chattiness, activity scale, and recency boost. Suggested starting range `0.02–0.05`. Counts against the ambient hourly budget. |

### `engagement`

| Key                    | Type   | Default | Description                                                                                                    |
| ---------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `soft_timeout_minutes` | number | `10`    | How long an engaged user can stay silent before engagement lapses.                                             |
| `hard_ceiling_minutes` | number | `30`    | Hard cap on thread duration even with continuous exchanges — stops a long back-and-forth from running forever. |

### `context`

| Key                 | Type   | Default  | Description                                                                                         |
| ------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| `max_messages`      | number | _tiered_ | Max messages retained per channel context window. Defaults: 5 / 25 / 50 for small / medium / large. |
| `max_tokens`        | number | _tiered_ | Max tokens of context sent to the model per request. Defaults: 1000 / 2000 / 4000.                  |
| `ttl_minutes`       | number | `60`     | Idle window after which channel context is evicted.                                                 |
| `prune_strategy`    | string | `"bulk"` | `bulk` halves the buffer on overflow (cache-friendly); `sliding` drops-oldest-per-turn (legacy).    |
| `max_message_chars` | number | `1000`   | Per-entry character cap. Longer entries are truncated with a "…".                                   |

### `rate_limits`

| Key                            | Type   | Default | Description                                                     |
| ------------------------------ | ------ | ------- | --------------------------------------------------------------- |
| `user_burst`                   | number | `3`     | Per-user token bucket size.                                     |
| `user_refill_seconds`          | number | `12`    | Seconds to refill one bucket token.                             |
| `global_rpm`                   | number | `10`    | Global requests per minute cap.                                 |
| `global_rpd`                   | number | `800`   | Global requests per day cap.                                    |
| `rpm_backpressure_pct`         | number | `80`    | When global RPM usage crosses this %, per-user burst is halved. |
| `ambient_per_channel_per_hour` | number | `5`     | Ambient replies allowed per channel per hour.                   |
| `ambient_global_per_hour`      | number | `20`    | Ambient replies allowed globally per hour.                      |

### `token_budgets`

| Key              | Type   | Default  | Description                        |
| ---------------- | ------ | -------- | ---------------------------------- |
| `per_user_daily` | number | `50000`  | Daily token budget per user.       |
| `global_daily`   | number | `200000` | Daily token budget across the bot. |

### `output`

| Key                     | Type    | Default  | Description                                                                                                                                    |
| ----------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_lines`             | number  | _tiered_ | Max lines emitted per reply (scaled by mood verbosity). Defaults: 1 / 4 / 4.                                                                   |
| `max_line_length`       | number  | `440`    | Max chars per line before truncation/wrapping.                                                                                                 |
| `inter_line_delay_ms`   | number  | `500`    | Delay between lines to feel human and avoid flood kicks.                                                                                       |
| `strip_urls`            | boolean | `false`  | If true, remove URLs from replies before sending.                                                                                              |
| `prompt_leak_threshold` | number  | _tiered_ | Minimum bytes of contiguous overlap between model output and system prompt that triggers the echo-drop. `0` disables. Defaults: 60 / 80 / 100. |

### `input`

| Key                | Type   | Default | Description                                                   |
| ------------------ | ------ | ------- | ------------------------------------------------------------- |
| `max_prompt_chars` | number | `2000`  | Reject inbound user messages longer than this.                |
| `max_inflight`     | number | `4`     | Cap on concurrent provider calls; excess requests get "busy". |

### `permissions`

| Key                 | Type     | Default                    | Description                                            |
| ------------------- | -------- | -------------------------- | ------------------------------------------------------ |
| `required_flag`     | string   | `"-"`                      | Flag required to trigger AI replies. `-` = anyone.     |
| `admin_flag`        | string   | `"m"`                      | Flag granting bucket bypass and admin commands.        |
| `ignore_list`       | string[] | `[]`                       | Nicks or hostmasks the bot never replies to.           |
| `ignore_bots`       | boolean  | `true`                     | Skip messages from nicks matching `bot_nick_patterns`. |
| `bot_nick_patterns` | string[] | `["*bot", "*Bot", "*BOT"]` | Wildcard patterns for detecting other bots.            |

### `ambient`

| Key                                 | Type     | Default | Description                                               |
| ----------------------------------- | -------- | ------- | --------------------------------------------------------- |
| `enabled`                           | boolean  | `false` | Master switch for unprompted speaking.                    |
| `idle.after_minutes`                | number   | `15`    | Minutes of silence before an idle remark is considered.   |
| `idle.chance`                       | number   | `0.3`   | Probability (0–1) of speaking when the idle gate fires.   |
| `idle.min_users`                    | number   | `2`     | Skip idle remarks below this active user count.           |
| `unanswered_questions.enabled`      | boolean  | `true`  | Allow replies to unanswered human questions.              |
| `unanswered_questions.wait_seconds` | number   | `90`    | Seconds to wait before considering a question unanswered. |
| `chattiness`                        | number   | `0.08`  | Base per-tick chance of speaking in normal channels.      |
| `interests`                         | string[] | `[]`    | Topics that bias the bot toward chiming in.               |
| `event_reactions.join_wb`           | boolean  | `false` | React to returning users with a welcome-back.             |
| `event_reactions.topic_change`      | boolean  | `false` | React to topic changes.                                   |

### `security`

| Key                         | Type    | Default | Description                                                              |
| --------------------------- | ------- | ------- | ------------------------------------------------------------------------ |
| `privilege_gating`          | boolean | `false` | Restrict AI replies to flagged users when the bot has elevated modes.    |
| `privileged_mode_threshold` | string  | `"h"`   | Bot mode at/above which gating kicks in (`v`, `h`, `o`, `a`, `q`).       |
| `privileged_required_flag`  | string  | `"m"`   | Flag required to trigger the bot while gating is active.                 |
| `disable_when_privileged`   | boolean | `false` | Disable AI entirely (not just gate) when the bot is privileged.          |
| `disable_when_founder`      | boolean | `true`  | Refuse responses in channels where the bot's ChanServ tier is `founder`. |

### `sessions`

| Key                          | Type    | Default   | Description                                               |
| ---------------------------- | ------- | --------- | --------------------------------------------------------- |
| `enabled`                    | boolean | `true`    | Master switch for game sessions.                          |
| `inactivity_timeout_minutes` | number  | `10`      | End a game after this much user inactivity.               |
| `games_dir`                  | string  | `"games"` | Directory (relative to plugin) to load game prompts from. |

### `ollama`

Only read when `provider` is `"ollama"`.

| Key                    | Type     | Default                    | Description                                                                        |
| ---------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `base_url`             | string   | `"http://127.0.0.1:11434"` | Ollama daemon URL. Keep on loopback — Ollama has no auth.                          |
| `request_timeout_ms`   | number   | `150000`                   | Abort a generate call after this many ms.                                          |
| `use_server_tokenizer` | boolean  | `false`                    | Call `/api/tokenize` for accurate counts instead of the 4-char heuristic.          |
| `keep_alive`           | string   | `"30m"`                    | How long Ollama keeps the model resident between requests. Empty = daemon default. |
| `num_ctx`              | number   | _tiered_                   | Pinned context window size. Defaults: 4096 / 8192 / 8192.                          |
| `allow_private_url`    | boolean  | `false`                    | Opt-in to private/loopback base_urls. Default-deny SSRF guard.                     |
| `repeat_penalty`       | number   | _tiered_                   | llama.cpp `repeat_penalty`. Defaults: 1.20 / 1.10 / unset. `0` = unset.            |
| `repeat_last_n`        | number   | _tiered_                   | llama.cpp `repeat_last_n`. Defaults: 64 / 64 / unset. `0` = unset.                 |
| `stop`                 | string[] | _tiered_                   | Stop sequences. Operator entries merge on top of the tier list, capped at 10.      |

### Full example

Every key at its shipped default, wrapped in a `plugins.json` entry. Copy, trim to what you want to override, and drop unchanged keys — the plugin merges your overrides on top of `config.json`.

```json
{
  "ai-chat": {
    "enabled": true,
    "channels": ["#mychannel"],
    "config": {
      "provider": "gemini",
      "api_key_env": "HEX_GEMINI_API_KEY",
      "model": "gemini-2.5-flash-lite",
      "temperature": 0.9,
      "max_output_tokens": 256,

      "triggers": {
        "direct_address": true,
        "command_prefix": "!ai",
        "keywords": [],
        "random_chance": 0
      },

      "engagement": {
        "soft_timeout_minutes": 10,
        "hard_ceiling_minutes": 30
      },

      "channel_profiles": {},

      "character": "friendly",
      "characters_dir": "characters",
      "channel_characters": {},

      "context": {
        "max_messages": 50,
        "max_tokens": 4000,
        "ttl_minutes": 60
      },

      "rate_limits": {
        "user_burst": 3,
        "user_refill_seconds": 12,
        "global_rpm": 10,
        "global_rpd": 800,
        "rpm_backpressure_pct": 80,
        "ambient_per_channel_per_hour": 5,
        "ambient_global_per_hour": 20
      },

      "token_budgets": {
        "per_user_daily": 50000,
        "global_daily": 200000
      },

      "output": {
        "max_lines": 4,
        "max_line_length": 440,
        "inter_line_delay_ms": 500,
        "strip_urls": false
      },

      "permissions": {
        "required_flag": "-",
        "admin_flag": "m",
        "ignore_list": [],
        "ignore_bots": true,
        "bot_nick_patterns": ["*bot", "*Bot", "*BOT"]
      },

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
      },

      "security": {
        "privilege_gating": false,
        "privileged_mode_threshold": "h",
        "privileged_required_flag": "m",
        "disable_when_privileged": false,
        "disable_when_founder": true
      },

      "sessions": {
        "enabled": true,
        "inactivity_timeout_minutes": 10,
        "games_dir": "games"
      },

      "ollama": {
        "base_url": "http://127.0.0.1:11434",
        "request_timeout_ms": 150000,
        "use_server_tokenizer": false
      }
    }
  }
}
```
