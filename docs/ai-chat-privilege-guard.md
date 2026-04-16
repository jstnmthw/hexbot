# Should ai-chat restrict itself when the bot holds elevated channel privileges?

## Context

The ai-chat plugin has solid output sanitisation — fantasy command prefixes (`.`,
`!`, `/`) are neutralised before sending, markdown is stripped, control characters
are removed. But this is a single layer of defence. If the bot holds channel
operator status (+o, +h, +a, +q), a successful prompt injection bypassing the
output formatter could cause the bot to execute destructive IRC commands: kicks,
bans, mode changes, topic overwrites. The bot has the _capability_ to do these
things because the IRC server trusts its status.

Defence-in-depth says: don't just sanitise the output — also reduce the attack
surface by restricting _who_ can trigger AI responses when the bot is in a
position to do damage.

Two related decisions:

1. **Drop PM support entirely** — PMs bypass channel visibility and moderation
2. **Auto-restrict AI triggers based on the bot's channel status** — if the bot
   has ops, limit who can make it speak

### Existing defences

- Output formatter prepends space to lines starting with `.`, `!`, `/` (breaks
  ChanServ/BotServ fantasy command parsing)
- System prompt includes `SAFETY:` clause forbidding those prefixes
- Permission system can gate AI usage behind bot flags (`required_flag` config)
- Ignore list (config + DB) can block specific users
- Bot-nick pattern matching auto-ignores likely bots
- Rate limiting bounds total output volume

### What the channel-state module provides

The plugin API already exposes everything needed:

- `api.getChannel(name)` → `ChannelState` with bot's own user entry and modes
- `api.getUsers(channel)` → all users with their channel modes (`o`, `v`, etc.)
- `api.isBotNick(nick)` → identify the bot's own nick
- `api.permissions.checkFlags(flags, ctx)` → check bot-level user flags

The bot can look up its own channel modes at response time:

```typescript
const ch = api.getChannel(channel);
const botUser = ch?.users.get(api.ircLower(botNick));
const botHasOps = botUser?.modes.includes('o') ?? false;
const botHasHalfop = botUser?.modes.includes('h') ?? false;
// etc.
```

---

## Decision 1: Drop PM support

### Why

- **No oversight**: Channel operators can't see PM conversations. Prompt injection
  attempts are invisible to the channel community.
- **No social accountability**: In a channel, other users see the interaction and
  can intervene. In PM, it's one-on-one with no witnesses.
- **Extraction vector**: An attacker could use PMs to probe the system prompt,
  test injection techniques, and extract information without anyone noticing.
- **Scope creep**: The bot is a channel participant, not a personal assistant.
  PM support pulls it toward a different product.
- **Quota abuse**: PM conversations don't benefit the channel community but
  consume the same RPM/RPD budget.

### What to keep

- **Admin commands in PM**: Bot administration commands (`.flags`, `.adduser`,
  etc.) should still work in PM — those are gated by bot flags, not the AI
  pipeline. This decision is ai-chat specific.
- **Notice responses**: The bot can still send notices to users (e.g. rate limit
  warnings). This is one-way, not AI-generated.

### Implementation

Remove the `pm` trigger from config and the PM pipeline from the plugin. The
context manager's PM buffer (`pmMaxMessages`) and the PM codepath in
`detectTrigger` and `runPipeline` can be removed entirely.

---

## Decision 2: Privilege-aware response gating

### The threat model

When the bot has +v (voice) only, prompt injection is mostly harmless — the bot
can speak but can't do anything destructive. Channel modes above +v escalate the
risk:

| Mode | Capability                      | Injection risk                           |
| ---- | ------------------------------- | ---------------------------------------- |
| +v   | Can speak in +m channels        | Low — can only produce text              |
| +h   | Can kick, set some modes        | Medium — can disrupt users               |
| +o   | Full channel control            | High — kicks, bans, mode, topic          |
| +a   | Protected operator (UnrealIRCd) | High — same as +o, harder to remove      |
| +q   | Channel owner (UnrealIRCd)      | Critical — full control, can't be deoped |

### Options

#### Option A: Flag-gated when privileged

When the bot has any mode above +v in a channel, only respond to users who hold
specific bot-level flags (checked via `api.permissions.checkFlags()`).

```
Bot has +v or lower → normal operation (existing config applies)
Bot has +h/+o/+a/+q → only respond to users with +m flag (or +n/+o)
```

**Configuration:**

```json
{
  "security": {
    "privileged_mode_threshold": "h",
    "privileged_required_flag": "m"
  }
}
```

This means: when the bot has halfop or higher, only users with the `m` (master)
flag in the bot's permission system can trigger AI responses. Effectively, only
trusted users get to interact with the AI in channels where the bot has power.

- **Pro**: Surgical — only restricts in channels where the risk exists
- **Pro**: Uses the existing permission system, no new concepts
- **Pro**: Trusted users (who presumably won't attempt injection) can still use AI
- **Con**: Requires users to be registered in the bot's permission system
- **Con**: Casual users in a mixed channel can't use AI even if the channel is friendly

#### Option B: Disable when privileged

When the bot has any mode above +v, disable AI responses entirely in that channel.

```
Bot has +v or lower → normal operation
Bot has +h/+o/+a/+q → AI completely silent (still observes for context)
```

**Configuration:**

```json
{
  "security": {
    "disable_when_privileged": true
  }
}
```

- **Pro**: Simplest — zero attack surface when bot has power
- **Pro**: No edge cases or configuration subtlety
- **Con**: Throws the baby out with the bathwater — can't use AI in ops channels
- **Con**: Many bots _need_ ops for their core function (chanmod, autovoice) and
  also want AI in the same channel

#### Option C: Channel-mode-gated when privileged

When the bot has elevated status, only respond to users who also have a minimum
channel mode (e.g. +v or +o in the IRC channel, not the bot's flag system).

```
Bot has +o → only respond to users with +v or higher in the channel
Bot has +h → only respond to users with +v or higher
```

- **Pro**: Uses channel trust hierarchy — voiced users are already trusted by ops
- **Pro**: No bot-level registration required
- **Con**: +v is handed out liberally in many channels — doesn't filter much
- **Con**: Mixes two trust systems (bot permissions vs. channel modes)
- **Con**: Gives AI access based on channel status, which may be given for
  non-trust reasons (e.g. +v for speaking in +m channels)

#### Option D: Configurable policy per channel

Let the admin choose per channel: `"normal"`, `"flag_gated"`, `"mode_gated"`,
or `"disabled"` when the bot is privileged.

```json
{
  "security": {
    "privileged_policy": "flag_gated",
    "privileged_required_flag": "m",
    "channel_overrides": {
      "#ops": "disabled",
      "#casual": "normal"
    }
  }
}
```

- **Pro**: Maximum flexibility
- **Con**: Configuration complexity — more knobs to get wrong
- **Con**: Operators may misconfigure and create false sense of security

---

## Recommendation

**Decision 1: Yes, drop PMs.** Clear win with no real downside for the intended
use case. The bot is a channel resident. Admin commands in PM are unaffected.

**Decision 2: Option A (flag-gated when privileged), with Option B as fallback.**
Confidence: High.

The default should be: when the bot holds +h or above in a channel, only users
with the `m` flag can trigger AI responses. This is the right balance:

- It uses the trust system the bot already has (flags)
- It doesn't require channel-mode-level trust judgments
- Operators who have `+m` are trusted enough to manage the bot — trusting them
  with AI prompts is consistent
- It's automatic — admins don't have to remember to configure it per channel
- The `m` flag threshold is appropriate: these users can already manage channel
  settings, ignores, and see stats — they're trusted operators

For admins who want the nuclear option, expose `"disable_when_privileged": true`
as an override that trumps flag-gating. Some deployments may prefer this.

### Implementation sketch

In the `shouldRespond` check (early in the pipeline, before any LLM call):

```typescript
function isPrivilegeRestricted(api: PluginAPI, channel: string, ctx: HandlerContext, config: SecurityConfig): boolean {
  if (!channel) return false; // PM already removed, but safety check

  const ch = api.getChannel(channel);
  if (!ch) return false;

  const botNick = /* from api */;
  const botUser = ch.users.get(api.ircLower(botNick));
  if (!botUser) return false;

  // Check if bot has elevated status (above +v)
  const elevatedModes = ['o', 'h', 'a', 'q'];
  const botIsPrivileged = elevatedModes.some(m => botUser.modes.includes(m));

  if (!botIsPrivileged) return false; // Bot is +v or unvoiced — normal operation

  if (config.disableWhenPrivileged) return true; // Nuclear option

  // Flag-gated: check if user has required flag
  const requiredFlag = config.privilegedRequiredFlag || 'm';
  return !api.permissions.checkFlags(requiredFlag, ctx);
}
```

This check runs before rate limiting, token budgets, or LLM calls — rejected
messages cost nothing.

### Logging

When a message is blocked by privilege restriction, log it at debug level (not
warning — it's expected behaviour, not an attack):

```
[ai-chat] privilege-guard: skipped nick=someuser channel=#ops (bot has +o, user lacks +m)
```

---

## What Eggdrop does

Eggdrop doesn't have AI chat, but its permission model is relevant:

- Eggdrop has always separated **bot flags** (global/channel user records) from
  **IRC channel modes** (+o/+v). Bot flags determine what the user can make the
  bot do; channel modes determine what the IRC server lets the user do.

- Eggdrop's TCL scripts can check both: `matchattr $handle m|m $chan` checks bot
  flags, while `isop $nick $chan` checks IRC status. The convention is to use bot
  flags for bot-related access control and IRC modes for channel-related decisions.

- This maps directly to Option A: use bot flags (`+m`) to gate AI access, because
  the decision is about what the _bot_ does, not what the _IRC server_ allows.

- Eggdrop scripts that perform destructive channel actions (mass kicks, ban
  sweeps) universally require high bot flags (+m or +n), not just IRC ops. This
  is the same principle: bot capabilities require bot-level trust, not just
  channel-level trust.

---

## Summary

| Decision               | Choice                                                   | Confidence |
| ---------------------- | -------------------------------------------------------- | ---------- |
| Drop PM support        | Yes                                                      | High       |
| Privilege-aware gating | Flag-gated (+m when bot is +h or above)                  | High       |
| Fallback option        | `disable_when_privileged: true` for paranoid deployments | High       |
| Gate threshold         | +h (halfop) and above triggers restriction               | High       |
| Required flag          | `m` (master/moderator) by default, configurable          | High       |
