# ai-chat

AI-powered chat plugin. The bot listens for direct address (e.g. `hexbot: hi`), the `!ai <message>` command, or private messages, and replies using an LLM.

Ships with a pluggable provider adapter — Gemini (free tier) is built in; Claude/OpenAI/Ollama adapters can be added without touching plugin logic.

## Setup

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

## Triggers

| Trigger          | Example                        |
| ---------------- | ------------------------------ |
| Direct address   | `hexbot: what's up?`           |
| Command          | `!ai tell me a joke`           |
| Keyword (opt-in) | any configured substring match |
| Random (opt-in)  | small % chance on any message  |

Private messaging is not supported — the bot responds only in channels. This is intentional: PMs are a reconnaissance vector for testing prompt injection without channel visibility.

The bot ignores its own messages, likely-bot nicks (pattern match), users in the ignore list, users without the required flag, and users mid-cooldown.

## Commands

| Command                  | Access | Description                         |
| ------------------------ | ------ | ----------------------------------- |
| `!ai <message>`          | anyone | ask a question                      |
| `!ai personality`        | anyone | show current personality            |
| `!ai personalities`      | anyone | list available personalities        |
| `!ai model`              | anyone | show provider and model             |
| `!ai games`              | anyone | list available games                |
| `!ai play <game>`        | anyone | start a game session                |
| `!ai endgame`            | anyone | end current game session            |
| `!ai stats`              | `+m`   | today's token/request totals        |
| `!ai reset <nick>`       | `+n`   | reset a user's daily token budget   |
| `!ai ignore <target>`    | `+m`   | add nick or hostmask to ignore list |
| `!ai unignore <target>`  | `+m`   | remove from ignore list             |
| `!ai clear`              | `+m`   | clear the channel's context window  |
| `!ai personality <name>` | `+m`   | switch personality for this channel |

## Personalities

Built-in presets (configurable per-channel):

- `friendly` (default) — helpful, concise
- `sarcastic` — dry humor, playful roasts
- `chaotic` — absurdist, meme-aware
- `minimal` — short, deadpan, signal-only

Per-channel overrides in `plugins.json`:

```json
"ai-chat": {
  "config": {
    "channel_personalities": {
      "#serious": "friendly",
      "#games": "chaotic",
      "#french": { "personality": "friendly", "language": "French" }
    }
  }
}
```

Add your own — each preset is just a named system-prompt string in `personalities`. Template variables: `{nick}`, `{channel}`, `{network}`, `{users}`.

## Games

Drop a `.txt` file into `plugins/ai-chat/games/` and it's playable via `!ai play <name>`. The file contents are used as the session's system prompt. Shipped games:

- `20questions` — bot picks a thing; player asks yes/no questions.
- `trivia` — bot generates questions, tracks score and streak.

While in a game, the user's messages in that channel are routed to the game session (not the shared channel context), and the bot responds as the game host. End with `!ai endgame` or after 10 minutes of inactivity.

## Rate limits and budgets

Defaults sit well under Gemini's free tier (15 RPM / 1000 RPD):

- Per-user cooldown: 30s
- Per-channel cooldown: 10s
- Global RPM: 10
- Global RPD: 800
- Per-user daily tokens: 50,000
- Global daily tokens: 200,000

Game sessions bypass the per-user/per-channel cooldowns (but still hit RPM/RPD).

## Resilience

The provider is wrapped in a retry + circuit-breaker layer:

- Transient errors (429 rate-limit, 5xx network) are retried up to 2 times with exponential backoff.
- 5 consecutive hard failures → circuit opens for 5 minutes (the bot responds "AI is temporarily unavailable" until it closes).
- Safety-blocked responses get a polite refusal.

## Security — ChanServ fantasy-command defense

Any channel message starting with `.`, `!`, `/`, `~`, `@`, `%`, `$`, `&`, or `+` can be parsed by IRC services (Atheme ChanServ, Anope BotServ, etc.) as a **fantasy command** and executed against the **sender's** ACL. Since the bot typically has ChanServ op access (for auto-op and takeover recovery), a prompt-injected LLM emitting `.deop admin` would have ChanServ deop the admin on the bot's behalf.

**Defense (automatic):** `output-formatter.ts` scans every line of the LLM response for fantasy-command prefixes. If **any** line starts with one, the **entire response is dropped** and a WARNING is logged. This is intentionally aggressive — if the LLM produced a fantasy prefix, the response is considered compromised. Unicode format characters (`\p{Cf}`) are stripped before the check to prevent invisible character smuggling.

**Defense-in-depth (`SAFETY_CLAUSE`):** Every system prompt is suffixed with a non-overridable two-part clause appended last in `renderSystemPrompt()`, so no character template can pre-empt it. The first sentence tells the model never to begin a line with `.`, `!`, or `/` (closes the machine-execution path even before the output-formatter drops it). The second sentence frames the bot as a regular channel user with no knowledge of operator commands, services syntax (ChanServ/NickServ/BotServ/etc.), channel mode letters, or ban masks — so when a human asks "what's the command to transfer founder?" the bot answers with honest ignorance instead of a working recipe an unwary admin might paste.

See `docs/audits/security-ai-injection-threat-2026-04-16.md` for the full security audit.

**Privilege gating (opt-in):** When the bot has elevated channel modes (half-op or above), you can restrict AI responses to users with a specific bot flag:

```json
{
  "security": {
    "privilege_gating": true,
    "privileged_mode_threshold": "h",
    "privileged_required_flag": "m",
    "disable_when_privileged": false
  }
}
```

Set `disable_when_privileged: true` to disable AI responses entirely when the bot has ops.

**Operator note:** Do not grant this bot `founder` access on any channel where ai-chat runs. Ops-level access limits the blast radius to kicks/bans/deops — damaging but recoverable. Founder loss is not. For maximum isolation, run an unprivileged AI bot alongside a separate chanmod/ops bot.

## Privacy

Gemini's free tier may use submitted content to improve models. Don't send sensitive data. If you need stricter privacy, switch to a paid tier (Vertex AI) or a local provider (Ollama adapter planned).

## Configuration reference

See `config.json` in this directory for the full default config with all keys.
