# chanmod

Channel operator tools: auto-op/halfop/voice on join, mode enforcement, timed bans, channel protection, and manual moderation commands.

## Commands

All commands require the caller to have `+o` (op) flag in the channel.

| Command     | Usage                         | Description                                     |
| ----------- | ----------------------------- | ----------------------------------------------- |
| `!op`       | `!op [nick]`                  | Op a nick (or yourself if omitted)              |
| `!deop`     | `!deop [nick]`                | Deop a nick (or yourself if omitted)            |
| `!halfop`   | `!halfop [nick]`              | Halfop a nick (or yourself if omitted)          |
| `!dehalfop` | `!dehalfop [nick]`            | Dehalfop a nick (or yourself if omitted)        |
| `!voice`    | `!voice [nick]`               | Voice a nick (or yourself if omitted)           |
| `!devoice`  | `!devoice [nick]`             | Devoice a nick (or yourself if omitted)         |
| `!kick`     | `!kick <nick> [reason]`       | Kick a nick with an optional reason             |
| `!ban`      | `!ban <nick\|mask> [minutes]` | Ban a nick or explicit mask, optionally timed   |
| `!unban`    | `!unban <nick\|mask>`         | Remove a ban by nick (if present) or exact mask |
| `!kickban`  | `!kickban <nick> [reason]`    | Ban and kick in one step                        |
| `!bans`     | `!bans [channel]`             | List tracked bans and their expiry              |

## Per-channel settings (.chanset)

Most chanmod behaviors can be tuned per-channel using `.chanset` (requires `m` flag):

```
.chanset #chan <key>               — show current value
.chanset #chan +<flag>             — enable a flag
.chanset #chan -<flag>             — revert flag to default
.chanset #chan <key> <value>       — set a string or int value
.chanset #chan                     — list all settings with current values
```

| Setting         | Type   | Default | Description                                                           |
| --------------- | ------ | ------- | --------------------------------------------------------------------- |
| `enforce_modes` | flag   | off     | Re-apply channel modes and user modes if removed                      |
| `channel_modes` | string | `""`    | Mode string to enforce, e.g. `"+nt-s"`; unmentioned modes left alone  |
| `channel_key`   | string | `""`    | Channel key (`+k`) to enforce (empty = remove unauthorized keys)      |
| `channel_limit` | int    | `0`     | Channel user limit (`+l`) to enforce (0 = remove unauthorized limits) |
| `bitch`         | flag   | off     | Strip `+o`/`+h` from anyone without the required flag                 |
| `auto_op`       | flag   | on      | Auto-op/halfop/voice flagged users on join                            |
| `protect_ops`   | flag   | off     | Kick/kickban anyone who deops a flagged user                          |
| `enforcebans`   | flag   | off     | Kick users whose hostmask matches a newly-set ban                     |
| `revenge`       | flag   | off     | Kick/deop/kickban whoever kicks the bot                               |
| `chanserv_op`   | flag   | off     | Ask ChanServ to re-op the bot when it loses ops                       |
| `invite`        | flag   | off     | Accept IRC INVITE from ops/masters and join the channel               |

**Example** — set up mode enforcement for `#mychan`:

```
.chanset #mychan +enforce_modes
.chanset #mychan channel_modes +nt-s
.chanset #mychan channel_key s3cr3t
.chanset #mychan channel_limit 50
```

## Auto-op, auto-halfop, and auto-voice

When a user joins a channel where the bot has ops (or halfop), chanmod checks their hostmask against the permissions database. The first matching tier wins:

1. **Auto-op** — user has a flag in `op_flags`; requires bot to have `+o`
2. **Auto-halfop** — user has a flag in `halfop_flags` (and no op flag); requires bot to have `+h` or `+o`; disabled by default (`halfop_flags: []`)
3. **Auto-voice** — user has a flag in `voice_flags` (and no op/halfop flag); requires bot to have `+o`

If the bot configuration includes `identity.require_acc_for` containing `+o`, `+h`, or `+v`, chanmod will verify the user with NickServ before applying the mode. If verification fails, the user is silently skipped (or notified if `notify_on_fail` is true).

## Mode enforcement

With `enforce_modes: true`, the bot watches for `-o`, `-h`, and `-v` mode changes. If a flagged user is deopped, dehalfopped, or devoiced by someone else, the bot re-applies the mode after `enforce_delay_ms`. To prevent mode wars, enforcement is capped at 3 times per user per 10-second window before being suppressed with a warning.

Modes applied by `!deop`, `!dehalfop`, and `!devoice` are marked intentional and are never re-enforced.

### Channel mode enforcement

When `enforce_modes` is on, the bot enforces channel modes using an Eggdrop-style additive/subtractive model. The `channel_modes` setting uses `"+nt-s"` syntax:

- Modes after `+` are ensured set (re-applied if removed)
- Modes after `-` are ensured unset (removed if added)
- **Modes not mentioned are left alone** — the bot won't fight server-set modes, ChanServ MLOCK, or network-specific modes (e.g. `+z` on Rizon/UnrealIRCd)

Three settings control what gets enforced — all configurable globally via the config file or per-channel via `.chanset`:

| Setting         | Type   | What it enforces                                                                  |
| --------------- | ------ | --------------------------------------------------------------------------------- |
| `channel_modes` | string | Additive/subtractive modes — e.g. `"+nt-s"` ensures `+n +t` and removes `+s`      |
| `channel_key`   | string | Channel key (`+k`) — re-applied if removed or changed to a different value        |
| `channel_limit` | int    | Channel user limit (`+l`) — re-applied if removed or changed to a different value |

All three are independent. You can enforce just `+nt-s`, just `+k`, just `+l`, or any combination.

**Migration from legacy format:** The old format `"nt"` (no `+`/`-` prefix) is auto-detected and treated as `"+nt"` — additive only, with no removals. To also remove specific modes, switch to the new format: `"+nt-si"`. Operators who relied on the old exact-match behavior (where unmentioned modes were removed) must now explicitly list modes to remove.

When `enforce_modes` is on and `channel_key` is empty, any `+k` set by a user is treated as unauthorized and removed (using `-k <the_key>`). Likewise, when `channel_limit` is `0`, any `+l` is removed. This applies both reactively (the bot sees the mode change and reverts it) and proactively (on join, the bot queries the server for current modes and cleans up stale keys/limits).

Nicks in `nodesynch_nicks` (default: `["ChanServ"]`) are always exempt as setters, so ChanServ mode grants are never overridden.

## Bitch mode

With `bitch: true`, the bot strips `+o` and `+h` from anyone who receives them without the corresponding flag in `op_flags` or `halfop_flags`. This is a strict op-control mode: only users already in the permissions database may hold ops.

Exemptions:

- The bot itself is never stripped
- Nicks in `nodesynch_nicks` (default: `["ChanServ"]`) are exempt as setters — ops granted by ChanServ are not reverted

## Punish deop

With `punish_deop: true`, the bot responds to unauthorized deops: when someone without op authority (`op_flags`) removes ops from a flagged user, the bot punishes the setter according to `punish_action`. This is independent of `enforce_modes` — both can be enabled together, causing the bot to simultaneously re-op the victim and kick the offender.

- `punish_action: "kick"` (default) — kicks the setter
- `punish_action: "kickban"` — bans then kicks the setter

Rate-limited to 2 punishments per setter per 30 seconds to avoid escalation. Nicks in `nodesynch_nicks` are always exempt.

## Enforcebans

With `enforcebans: true`, the bot kicks any users already in the channel whose hostmask matches a newly-set ban mask. This ensures that setting `+b *!*@evil.host` actually removes the matching user rather than just preventing them from rejoining.

The ban mask is tested against `nick!ident@hostname` using IRC-aware wildcard matching (`*` and `?`). The bot itself is never kicked.

## Rejoin on kick

With `rejoin_on_kick: true` (default), the bot rejoins any channel it is kicked from after `rejoin_delay_ms`. To prevent a kick loop, rejoins are rate-limited: if the bot is kicked more than `max_rejoin_attempts` times within `rejoin_attempt_window_ms`, it stops trying.

## Revenge

With `revenge_on_kick: true`, after rejoining the bot takes action against the user who kicked it. The action is taken `revenge_delay_ms` after the rejoin, giving time for ChanServ to restore ops first. Revenge is skipped if the kicker has left the channel, the bot has no ops, or the kicker has a flag in `revenge_exempt_flags` (default: `"nm"` — owners and masters).

| `revenge_action` | Behavior                                    |
| ---------------- | ------------------------------------------- |
| `"deop"`         | Removes ops from the kicker (default)       |
| `"kick"`         | Kicks the kicker with `revenge_kick_reason` |
| `"kickban"`      | Bans (`*!*@host`) then kicks the kicker     |

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

## Nick recovery

With `nick_recovery: true` (default), chanmod watches for NICK and QUIT events. When the configured nick becomes free, the bot reclaims it after a 30-second backoff. If `nick_recovery_ghost: true` and `nick_recovery_password` is set, it first sends `GHOST <nick> <password>` to NickServ, then changes nick 2 seconds later.

The NickServ password is never written to logs.

## Stopnethack

Stopnethack detects netsplits and deops suspicious operator grants that arrive during or just after the split window. Set `stopnethack_mode` to enable:

| Mode | Behavior                                                                       |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | Disabled (default)                                                             |
| `1`  | **isoptest** — deop anyone granted `+o` who is not in the permissions database |
| `2`  | **wasoptest** — deop anyone granted `+o` who did not have ops before the split |

A netsplit is detected when 3+ split-format quit messages arrive within 5 seconds. Once detected, the bot monitors `+o` grants for `split_timeout_ms` (default 5 minutes).

## Invite

With `invite: true` (or `.chanset #chan +invite`), the bot accepts IRC INVITE messages from registered users with `+o`, `+m`, or `+n` flags and joins the invited channel. If the bot is already in the channel, the invite is silently ignored.

## Cycle on deop

With `cycle_on_deop: true`, if the bot itself is deopped three times within 10 seconds in a channel (without invite-only mode set), it will part and rejoin after `cycle_delay_ms` to attempt to regain ops via ChanServ. This is a recovery mechanism for channels with auto-op services.

## Config

### Auto-op / mode enforcement

| Key                     | Type     | Default         | Description                                                                                             |
| ----------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `auto_op`               | boolean  | `true`          | Auto-op/halfop/voice flagged users on join                                                              |
| `op_flags`              | string[] | `["n","m","o"]` | Flags that grant auto-op                                                                                |
| `halfop_flags`          | string[] | `[]`            | Flags that grant auto-halfop (disabled by default)                                                      |
| `voice_flags`           | string[] | `["v"]`         | Flags that grant auto-voice (when no op/halfop flag matches)                                            |
| `notify_on_fail`        | boolean  | `false`         | NOTICE the user if NickServ verification fails on join                                                  |
| `enforce_modes`         | boolean  | `false`         | Re-op/halfop/voice flagged users if externally deopped/devoiced                                         |
| `enforce_channel_modes` | string   | `""`            | Channel modes to enforce globally (e.g. `"+nt-s"`)                                                      |
| `enforce_channel_key`   | string   | `""`            | Channel key (`+k`) to enforce globally (empty = remove unauthorized keys when enforce_modes is on)      |
| `enforce_channel_limit` | number   | `0`             | Channel user limit (`+l`) to enforce globally (0 = remove unauthorized limits when enforce_modes is on) |
| `nodesynch_nicks`       | string[] | `["ChanServ"]`  | Nicks exempt from bitch mode and channel mode enforcement                                               |
| `enforce_delay_ms`      | number   | `500`           | Delay before re-applying a mode, in milliseconds                                                        |
| `bitch`                 | boolean  | `false`         | Strip `+o`/`+h` from anyone without the appropriate flag                                                |

### Kick / ban defaults

| Key                    | Type   | Default       | Description                                      |
| ---------------------- | ------ | ------------- | ------------------------------------------------ |
| `default_kick_reason`  | string | `"Requested"` | Kick reason when none is given                   |
| `default_ban_duration` | number | `120`         | Default ban duration in minutes; `0` = permanent |
| `default_ban_type`     | number | `3`           | Ban mask style (1, 2, or 3 — see above)          |

### Punish deop / enforcebans

| Key                  | Type               | Default                    | Description                                       |
| -------------------- | ------------------ | -------------------------- | ------------------------------------------------- |
| `punish_deop`        | boolean            | `false`                    | Kick/kickban anyone who deops a flagged user      |
| `punish_action`      | `"kick"│"kickban"` | `"kick"`                   | Action taken against the setter                   |
| `punish_kick_reason` | string             | `"Don't deop my friends."` | Kick reason used when punishing                   |
| `enforcebans`        | boolean            | `false`                    | Kick users whose hostmask matches a newly-set ban |

### Rejoin / revenge

| Key                        | Type                      | Default            | Description                                                              |
| -------------------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `rejoin_on_kick`           | boolean                   | `true`             | Rejoin after being kicked                                                |
| `rejoin_delay_ms`          | number                    | `5000`             | Delay before rejoining, in milliseconds                                  |
| `max_rejoin_attempts`      | number                    | `3`                | Max rejoins within `rejoin_attempt_window_ms` before giving up           |
| `rejoin_attempt_window_ms` | number                    | `300000`           | Window for the rejoin rate limit, in milliseconds                        |
| `revenge_on_kick`          | boolean                   | `false`            | Take action against whoever kicked the bot                               |
| `revenge_action`           | `"deop"│"kick"│"kickban"` | `"deop"`           | Action taken against the kicker                                          |
| `revenge_delay_ms`         | number                    | `3000`             | Extra delay after rejoin before taking revenge, in milliseconds          |
| `revenge_kick_reason`      | string                    | `"Don't kick me."` | Kick reason used for kick/kickban revenge                                |
| `revenge_exempt_flags`     | string                    | `"nm"`             | Flags that exempt the kicker from revenge (each char is a separate flag) |

### Nick recovery

| Key                   | Type    | Default | Description                                                       |
| --------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `nick_recovery`       | boolean | `true`  | Reclaim the configured nick when the holder changes nick or quits |
| `nick_recovery_ghost` | boolean | `false` | Send `GHOST` to NickServ before reclaiming (requires a password)  |

> **Note:** The NickServ password for GHOST is stored in `config/bot.json` under `chanmod.nick_recovery_password`, not in the plugin config. This follows SECURITY.md §6: plugin configs should not contain secrets.

### Stopnethack

| Key                | Type   | Default  | Description                                                                 |
| ------------------ | ------ | -------- | --------------------------------------------------------------------------- |
| `stopnethack_mode` | number | `0`      | `0` = off, `1` = isoptest (db check), `2` = wasoptest (pre-split ops check) |
| `split_timeout_ms` | number | `300000` | How long after a detected split to monitor suspicious `+o` grants, in ms    |

### ChanServ integration

| Key                    | Type    | Default      | Description                                          |
| ---------------------- | ------- | ------------ | ---------------------------------------------------- |
| `chanserv_op`          | boolean | `false`      | Request ops from ChanServ when the bot is deopped    |
| `chanserv_nick`        | string  | `"ChanServ"` | Nick of the ChanServ service to message for ops      |
| `chanserv_op_delay_ms` | number  | `1000`       | Delay before sending the op request, in milliseconds |

### Invite

| Key      | Type    | Default | Description                                           |
| -------- | ------- | ------- | ----------------------------------------------------- |
| `invite` | boolean | `false` | Accept IRC INVITE from registered ops/masters to join |

### Cycle on deop

| Key              | Type    | Default | Description                                         |
| ---------------- | ------- | ------- | --------------------------------------------------- |
| `cycle_on_deop`  | boolean | `false` | Part and rejoin to recover ops after repeated deops |
| `cycle_delay_ms` | number  | `5000`  | Delay before cycling, in milliseconds               |

## Example config

```json
{
  "chanmod": {
    "enabled": true,
    "config": {
      "auto_op": true,
      "enforce_modes": true,
      "enforce_channel_modes": "+nt-s",
      "enforce_channel_key": "",
      "enforce_channel_limit": 0,
      "bitch": false,
      "punish_deop": false,
      "enforcebans": true,
      "rejoin_on_kick": true,
      "rejoin_delay_ms": 5000,
      "revenge_on_kick": false,
      "revenge_action": "deop",
      "cycle_on_deop": true,
      "default_ban_duration": 60,
      "nick_recovery": true,
      "nick_recovery_ghost": false,
      "chanserv_op": false,
      "stopnethack_mode": 0,
      "invite": false
    }
  }
}
```

## Caveats

- All moderation commands (`!op`, `!deop`, `!halfop`, `!dehalfop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`) reply with an error message if the bot does not currently hold ops in the channel. `!bans` has no ops requirement (it is read-only).
- `!ban` by nick requires the target to be present in the channel so their hostmask can be resolved. For absent users, pass an explicit mask: `!ban *!*@1.2.3.4`.
- `!unban <nick>` works if the target is still in the channel — chanmod derives candidate masks from their hostmask and removes whichever one matches a stored record (or tries all three if no record is found). For absent users, provide an explicit mask: `!unban *!*@1.2.3.4`. Use `!bans` to list stored masks.
- Timed bans are only lifted in channels where the bot has ops at the time the timer fires. Bans in channels the bot has left, or where it has lost ops, will not be lifted until it regains them.
- Revenge fires after `rejoin_delay_ms + revenge_delay_ms`. If the bot has not received ops by then (e.g. ChanServ is slow), revenge is skipped silently.
- `bitch` and `punish_deop` both exempt nicks in `nodesynch_nicks` to avoid conflicting with ChanServ mode grants.
