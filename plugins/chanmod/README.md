# chanmod

Channel operator tools: auto-op/halfop/voice on join, mode enforcement, timed bans, and manual moderation commands.

## Commands

All commands require the caller to have `+o` (op) flag in the channel.

| Command     | Usage                         | Description                                   |
| ----------- | ----------------------------- | --------------------------------------------- |
| `!op`       | `!op [nick]`                  | Op a nick (or yourself if omitted)            |
| `!deop`     | `!deop [nick]`                | Deop a nick (or yourself if omitted)          |
| `!halfop`   | `!halfop [nick]`              | Halfop a nick (or yourself if omitted)        |
| `!dehalfop` | `!dehalfop [nick]`            | Dehalfop a nick (or yourself if omitted)      |
| `!voice`    | `!voice [nick]`               | Voice a nick (or yourself if omitted)         |
| `!devoice`  | `!devoice [nick]`             | Devoice a nick (or yourself if omitted)       |
| `!kick`     | `!kick <nick> [reason]`       | Kick a nick with an optional reason           |
| `!ban`      | `!ban <nick\|mask> [minutes]` | Ban a nick or explicit mask, optionally timed |
| `!unban`    | `!unban <mask>`               | Remove a ban by exact mask                    |
| `!kickban`  | `!kickban <nick> [reason]`    | Ban and kick in one step                      |
| `!bans`     | `!bans [channel]`             | List tracked bans and their expiry            |

## Auto-op, auto-halfop, and auto-voice

When a user joins a channel where the bot has ops (or halfop), chanmod checks their hostmask against the permissions database. The first matching tier wins:

1. **Auto-op** — user has a flag in `op_flags`; requires bot to have `+o`
2. **Auto-halfop** — user has a flag in `halfop_flags` (and no op flag); requires bot to have `+h` or `+o`; disabled by default (`halfop_flags: []`)
3. **Auto-voice** — user has a flag in `voice_flags` (and no op/halfop flag); requires bot to have `+o`

If the bot configuration includes `identity.require_acc_for` containing `+o`, `+h`, or `+v`, chanmod will verify the user with NickServ before applying the mode. If verification fails, the user is silently skipped (or notified if `notify_on_fail` is true).

## Mode enforcement

With `enforce_modes: true`, the bot watches for `-o`, `-h`, and `-v` mode changes. If a flagged user is deopped, dehalfopped, or devoiced by someone else, the bot re-applies the mode after `enforce_delay_ms`. To prevent mode wars, enforcement is capped at 3 times per user per 10-second window before being suppressed with a warning.

Modes applied by `!deop`, `!dehalfop`, and `!devoice` are marked intentional and are never re-enforced.

With `enforce_channel_modes` set (e.g. `"nt"`), the bot re-applies those channel modes if they are ever removed. This is enforced at join and on any `-mode` change. Nicks in `nodesynch_nicks` (default: `["ChanServ"]`) are exempt.

## Timed bans

`!ban` and `!kickban` store a ban record in the bot's database. Every 60 seconds, and on startup, chanmod lifts any expired bans in channels where it holds ops. Duration defaults to `default_ban_duration` (120 minutes). Pass `0` for a permanent ban.

```
!ban badnick          — ban for default duration (120m)
!ban badnick 30       — ban for 30 minutes
!ban *!*@1.2.3.4 0    — permanent ban by explicit mask
```

Ban masks are built from the target's hostmask according to `default_ban_type`:

| Type          | Pattern             | Example                  |
| ------------- | ------------------- | ------------------------ |
| `1`           | `*!*@host`          | `*!*@1.2.3.4`            |
| `2`           | `*!*ident@host`     | `*!*~user@1.2.3.4`       |
| `3` (default) | `*!*ident@*.domain` | `*!*~user@*.example.net` |

Cloaked hosts (containing `/`) always use type 1 regardless of the setting.

## Cycle on deop

With `cycle_on_deop: true`, if the bot itself is deopped three times within 10 seconds in a channel (without invite-only mode set), it will part and rejoin after `cycle_delay_ms` to attempt to regain ops via ChanServ. This is a recovery mechanism for channels with auto-op services.

## Config

| Key                     | Type     | Default         | Description                                                              |
| ----------------------- | -------- | --------------- | ------------------------------------------------------------------------ |
| `auto_op`               | boolean  | `true`          | Auto-op/halfop/voice flagged users on join                               |
| `op_flags`              | string[] | `["n","m","o"]` | Flags that grant auto-op                                                 |
| `halfop_flags`          | string[] | `[]`            | Flags that grant auto-halfop (between op and voice; disabled by default) |
| `voice_flags`           | string[] | `["v"]`         | Flags that grant auto-voice (when no op/halfop flag matches)             |
| `enforce_modes`         | boolean  | `false`         | Re-op/halfop/voice flagged users if externally deopped/devoiced          |
| `enforce_channel_modes` | string   | `""`            | Channel modes to enforce (e.g. `"nt"`)                                   |
| `nodesynch_nicks`       | string[] | `["ChanServ"]`  | Nicks exempt from channel mode enforcement                               |
| `enforce_delay_ms`      | number   | `500`           | Delay before re-applying a mode, in milliseconds                         |
| `notify_on_fail`        | boolean  | `false`         | NOTICE the user if NickServ verification fails on join                   |
| `default_kick_reason`   | string   | `"Requested"`   | Kick reason when none is given                                           |
| `default_ban_duration`  | number   | `120`           | Default ban duration in minutes; `0` = permanent                         |
| `default_ban_type`      | number   | `3`             | Ban mask style (1, 2, or 3 — see above)                                  |
| `cycle_on_deop`         | boolean  | `false`         | Part and rejoin to recover ops after repeated deops                      |
| `cycle_delay_ms`        | number   | `5000`          | Delay before cycling, in milliseconds                                    |

Example `config/plugins.json` entry:

```json
{
  "chanmod": {
    "enabled": true,
    "channels": ["#mychannel"],
    "config": {
      "auto_op": true,
      "enforce_modes": true,
      "enforce_channel_modes": "nt",
      "default_ban_duration": 60,
      "cycle_on_deop": true
    }
  }
}
```

## Caveats

- All commands silently fail (or reply with an error) if the bot does not currently hold ops in the channel.
- `!ban` by nick requires the target to be present in the channel so their hostmask can be resolved. For absent users, pass an explicit mask: `!ban *!*@1.2.3.4`.
- `!unban` requires the exact mask stored by chanmod. Use `!bans` to list tracked masks.
- Timed bans are only lifted in channels where the bot has ops at the time the timer fires. Bans in channels the bot has left, or where it has lost ops, will not be lifted until it regains them.
