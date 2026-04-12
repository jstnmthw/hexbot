# chanmod

Channel operator tools: auto-op/halfop/voice on join, mode enforcement, timed bans, ChanServ-integrated channel protection, takeover detection, and manual moderation commands.

## Commands

All commands require the caller to have `+o` (op) flag in the channel.

| Command     | Usage                      | Description                              |
| ----------- | -------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `!op`       | `!op [nick]`               | Op a nick (or yourself if omitted)       |
| `!deop`     | `!deop [nick]`             | Deop a nick (or yourself if omitted)     |
| `!halfop`   | `!halfop [nick]`           | Halfop a nick (or yourself if omitted)   |
| `!dehalfop` | `!dehalfop [nick]`         | Dehalfop a nick (or yourself if omitted) |
| `!voice`    | `!voice [nick]`            | Voice a nick (or yourself if omitted)    |
| `!devoice`  | `!devoice [nick]`          | Devoice a nick (or yourself if omitted)  |
| `!kick`     | `!kick <nick> [reason]`    | Kick a nick with an optional reason      |
| `!ban`      | `!ban <nick                | mask> [minutes]`                         | Ban a nick or explicit mask, optionally timed   |
| `!unban`    | `!unban <nick              | mask>`                                   | Remove a ban by nick (if present) or exact mask |
| `!kickban`  | `!kickban <nick> [reason]` | Ban and kick in one step                 |
| `!bans`     | `!bans [channel]`          | List tracked bans and their expiry       |

## Per-channel settings (.chanset)

Most chanmod behaviors can be tuned per-channel using `.chanset` (requires `m` flag):

```
.chanset #chan <key>               — show current value
.chanset #chan +<flag>             — enable a flag
.chanset #chan -<flag>             — revert flag to default
.chanset #chan <key> <value>       — set a string or int value
.chanset #chan                     — list all settings with current values
```

| Setting                  | Type   | Default  | Description                                                                             |
| ------------------------ | ------ | -------- | --------------------------------------------------------------------------------------- |
| `auto_op`                | flag   | on       | Auto-op/halfop/voice flagged users on join                                              |
| `bitch`                  | flag   | off      | Strip `+o`/`+h` from anyone without the required flag                                   |
| `enforce_modes`          | flag   | off      | Re-apply channel modes and user modes if removed                                        |
| `channel_modes`          | string | `""`     | Mode string to enforce, e.g. `"+nt-s"`; unmentioned modes left alone                    |
| `channel_key`            | string | `""`     | Channel key (`+k`) to enforce (empty = remove unauthorized keys)                        |
| `channel_limit`          | int    | `0`      | Channel user limit (`+l`) to enforce (0 = remove unauthorized limits)                   |
| `protect_ops`            | flag   | off      | Punish unauthorized users who deop a flagged op (users without op authority themselves) |
| `enforcebans`            | flag   | off      | Kick users whose hostmask matches a newly-set ban                                       |
| `revenge`                | flag   | off      | Kick/deop/kickban whoever kicks the bot                                                 |
| `chanserv_access`        | string | `"none"` | Bot's ChanServ access tier: `none`/`op`/`superop`/`founder`                             |
| `chanserv_unban_on_kick` | flag   | on       | Request UNBAN from services when bot is kicked                                          |
| `mass_reop_on_recovery`  | flag   | on       | Mass re-op flagged users after regaining ops during elevated threat                     |
| `takeover_punish`        | string | `"deop"` | Response to hostile actors: `none`/`deop`/`kickban`/`akick`                             |
| `takeover_detection`     | flag   | on       | Enable threat scoring and automatic escalation                                          |
| `protect_topic`          | flag   | off      | Restore pre-attack topic after takeover recovery                                        |
| `invite`                 | flag   | off      | Accept IRC INVITE from ops/masters and join the channel                                 |

**Example** -- set up mode enforcement and takeover protection for `#mychan`:

```
.chanset #mychan +enforce_modes
.chanset #mychan channel_modes +nt-s
.chanset #mychan chanserv_access founder
.chanset #mychan +takeover_detection
.chanset #mychan takeover_punish kickban
```

## Auto-op, auto-halfop, and auto-voice

When a user joins a channel where the bot has ops (or halfop), chanmod checks their hostmask against the permissions database. The first matching tier wins:

1. **Auto-op** -- user has a flag in `op_flags`; requires bot to have `+o`
2. **Auto-halfop** -- user has a flag in `halfop_flags` (and no op flag); requires bot to have `+h` or `+o`; disabled by default (`halfop_flags: []`)
3. **Auto-voice** -- user has a flag in `voice_flags` (and no op/halfop flag); requires bot to have `+o`

The `d` (deop) flag suppresses auto-op and auto-halfop. A user with `+d` will not be opped or halfopped on join, regardless of other flags. Auto-voice still works if the user also has an explicit `+v` flag (`n` does not imply `v` when `d` is active). Example: an owner with `+ndv` gets voiced but not opped.

If the bot configuration includes `identity.require_acc_for` containing `+o`, `+h`, or `+v`, chanmod will verify the user with NickServ before applying the mode. If verification fails, the user is silently skipped (or notified if `notify_on_fail` is true).

## Mode enforcement

With `enforce_modes: true`, the bot watches for `-o`, `-h`, and `-v` mode changes. If a flagged user is deopped, dehalfopped, or devoiced by someone else, the bot re-applies the mode after `enforce_delay_ms`. To prevent mode wars, enforcement is capped at 3 times per user per 10-second window before being suppressed with a warning.

Modes applied by `!deop`, `!dehalfop`, and `!devoice` are marked intentional and are never re-enforced.

### Channel mode enforcement

When `enforce_modes` is on, the bot enforces channel modes using an additive/subtractive model. The `channel_modes` setting uses `"+nt-s"` syntax:

- Modes after `+` are ensured set (re-applied if removed)
- Modes after `-` are ensured unset (removed if added)
- **Modes not mentioned are left alone** -- the bot won't fight server-set modes, ChanServ MLOCK, or network-specific modes (e.g. `+z` on Rizon/UnrealIRCd)

Three settings control what gets enforced -- all configurable globally via the config file or per-channel via `.chanset`:

| Setting         | Type   | What it enforces                                                                   |
| --------------- | ------ | ---------------------------------------------------------------------------------- |
| `channel_modes` | string | Additive/subtractive modes -- e.g. `"+nt-s"` ensures `+n +t` and removes `+s`      |
| `channel_key`   | string | Channel key (`+k`) -- re-applied if removed or changed to a different value        |
| `channel_limit` | int    | Channel user limit (`+l`) -- re-applied if removed or changed to a different value |

All three are independent. You can enforce just `+nt-s`, just `+k`, just `+l`, or any combination.

**Migration from legacy format:** The old format `"nt"` (no `+`/`-` prefix) is auto-detected and treated as `"+nt"` -- additive only, with no removals. To also remove specific modes, switch to the new format: `"+nt-si"`. Operators who relied on the old exact-match behavior (where unmentioned modes were removed) must now explicitly list modes to remove.

When `enforce_modes` is on and `channel_key` is empty, any `+k` set by a user is treated as unauthorized and removed (using `-k <the_key>`). Likewise, when `channel_limit` is `0`, any `+l` is removed. This applies both reactively (the bot sees the mode change and reverts it) and proactively (on join, the bot queries the server for current modes and cleans up stale keys/limits).

Nicks in `nodesynch_nicks` (default: `["ChanServ"]`) are always exempt as setters, so ChanServ mode grants are never overridden.

## Bitch mode

With `bitch: true`, the bot strips `+o` and `+h` from anyone who receives them without the corresponding flag in `op_flags` or `halfop_flags`. This is a strict op-control mode: only users already in the permissions database may hold ops.

Exemptions:

- The bot itself is never stripped
- Nicks in `nodesynch_nicks` (default: `["ChanServ"]`) are exempt as setters -- ops granted by ChanServ are not reverted

## Punish deop

With `punish_deop: true`, the bot responds to unauthorized deops: when someone without op authority (`op_flags`) removes ops from a flagged user, the bot punishes the setter according to `punish_action`. This is independent of `enforce_modes` -- both can be enabled together, causing the bot to simultaneously re-op the victim and kick the offender.

- `punish_action: "kick"` (default) -- kicks the setter
- `punish_action: "kickban"` -- bans then kicks the setter

Rate-limited to 2 punishments per setter per 30 seconds to avoid escalation. Nicks in `nodesynch_nicks` are always exempt.

## Enforcebans

With `enforcebans: true`, the bot kicks any users already in the channel whose hostmask matches a newly-set ban mask. This ensures that setting `+b *!*@evil.host` actually removes the matching user rather than just preventing them from rejoining.

The ban mask is tested against `nick!ident@hostname` using IRC-aware wildcard matching (`*` and `?`). The bot itself is never kicked.

## Rejoin on kick

With `rejoin_on_kick: true` (default), the bot rejoins any channel it is kicked from after `rejoin_delay_ms`. To prevent a kick loop, rejoins are rate-limited: if the bot is kicked more than `max_rejoin_attempts` times within `rejoin_attempt_window_ms`, it stops trying.

When `chanserv_unban_on_kick` is enabled (default) and the bot has ChanServ access, the bot immediately requests UNBAN and INVITE from ChanServ on kick, then rejoins with a shorter delay. If the first rejoin fails (still banned), a backup retry sends another UNBAN after `chanserv_unban_retry_ms`. This defeats the common attack pattern of ban+kick.

## Join error recovery

When the bot cannot join a channel (on startup or after a kick), chanmod asks ChanServ for help based on the error type:

| Error             | Numeric | Action                                                                           |
| ----------------- | ------- | -------------------------------------------------------------------------------- |
| Banned (+b)       | 474     | UNBAN + MODE -k + INVITE, then rejoin (handles full attacker stack +b+k+i+l)     |
| Invite only (+i)  | 473     | INVITE, then rejoin (bypasses +i and +l)                                         |
| Bad channel key   | 475     | MODE -k + INVITE if backend access; else retry with configured key from bot.json |
| Channel full (+l) | 471     | INVITE if backend access (bypasses +l); else wait for periodic retry             |
| Need registered   | 477     | No remedy -- NickServ identification is separate                                 |

All recovery goes through the ProtectionBackend chain. On Atheme networks, the backend sends `MODE -k` to surgically strip attacker-set keys. On Anope networks, the backend uses `GETKEY` to retrieve the current key and join with it (available at AOP+).

Recovery attempts use exponential backoff (30s -> 60s -> 120s -> 5min cap) to avoid spamming ChanServ. The backoff resets when the bot successfully joins the channel. When the bot has no known ChanServ access for a channel, a proactive access probe is sent before the first recovery attempt; the bot waits for the probe response (up to 11s) and retries if access is detected.

## Revenge

With `revenge_on_kick: true`, after rejoining the bot takes action against the user who kicked it. The action is taken `revenge_delay_ms` after the rejoin, giving time for ChanServ to restore ops first. Revenge is skipped if the kicker has left the channel, the bot has no ops, or the kicker has a flag in `revenge_exempt_flags` (default: `"nm"` -- owners and masters).

| `revenge_action` | Behavior                                    |
| ---------------- | ------------------------------------------- |
| `"deop"`         | Removes ops from the kicker (default)       |
| `"kick"`         | Kicks the kicker with `revenge_kick_reason` |
| `"kickban"`      | Bans (`*!*@host`) then kicks the kicker     |

## Takeover detection

The takeover detection engine tracks a per-channel rolling threat score that detects coordinated channel takeover attempts by watching for correlated hostile events within a configurable time window.

### Threat levels

| Level | Name     | Score threshold | Escalation action                      |
| ----- | -------- | --------------- | -------------------------------------- |
| 0     | Normal   | 0               | No action                              |
| 1     | Alert    | 3               | Request ops via ProtectionChain        |
| 2     | Active   | 6               | Request unban (bot may be banned)      |
| 3     | Critical | 10              | Full RECOVER (requires founder access) |

### Threat event scoring

Each hostile event adds points to the channel's threat score:

| Event type               | Points | Trigger                                             |
| ------------------------ | ------ | --------------------------------------------------- |
| `bot_banned`             | 5      | Ban set matching the bot's hostmask                 |
| `bot_kicked`             | 4      | Bot kicked from channel                             |
| `bot_deopped`            | 3      | Bot deopped by a non-nodesynch nick                 |
| `friendly_deopped`       | 2      | Flagged op deopped by a non-nodesynch nick          |
| `unauthorized_op`        | 2      | Bitch mode strips +o from an unflagged user         |
| `enforcement_suppressed` | 2      | Mode enforcement rate limit hit (possible mode war) |
| `mode_locked`            | 1      | Non-nodesynch nick sets +i, +s, or +k               |

Events expire after `takeover_window_ms` (default 30s). Thresholds are configurable via `takeover_level_1_threshold`, `takeover_level_2_threshold`, and `takeover_level_3_threshold`; they must be strictly ascending.

Enabled per-channel via `.chanset #chan +takeover_detection` (on by default).

## Mass re-op on recovery

When the bot regains ops during an elevated threat level (Alert or higher), it mass re-ops all flagged users who lost ops during the attack. If bitch mode is also enabled, unauthorized ops are stripped in the same pass. Flagged users are also re-halfopped and re-voiced as appropriate.

Enabled per-channel via `.chanset #chan +mass_reop_on_recovery` (on by default).

## Hostile response

At threat level Active (2) or higher, after the bot regains ops it takes action against all hostile actors recorded in the threat event log. The response is configurable per-channel via `takeover_punish`:

| `takeover_punish` | Behavior                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `"none"`          | No action against hostile actors                                        |
| `"deop"`          | Deop hostile actors (default); falls back to backend DEOP if no bot ops |
| `"kickban"`       | Ban and kick hostile actors                                             |
| `"akick"`         | ChanServ AKICK (persistent ban surviving rejoin); falls back to kickban |

Hostile actors with `revenge_exempt_flags` (default `nm`) and nodesynch nicks are never counter-attacked.

## Topic recovery

Chanmod snapshots the channel topic at threat level 0 (Normal). During elevated threat, the snapshot is frozen -- topic changes are treated as vandalism. When the bot regains ops during elevated threat and `protect_topic` is enabled, the pre-attack topic is restored automatically.

Enabled per-channel via `.chanset #chan +protect_topic` (off by default).

## Post-RECOVER cleanup

After Atheme RECOVER, ChanServ sets `+i +m` on the channel to lock it down. When the bot receives `+o` after RECOVER, it automatically removes `+i +m` to restore normal channel access.

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

| Mode | Behavior                                                                        |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Disabled (default)                                                              |
| `1`  | **isoptest** -- deop anyone granted `+o` who is not in the permissions database |
| `2`  | **wasoptest** -- deop anyone granted `+o` who did not have ops before the split |

A netsplit is detected when 3+ split-format quit messages arrive within 5 seconds. Once detected, the bot monitors `+o` grants for `split_timeout_ms` (default 5 minutes).

## ChanServ integration

Chanmod integrates with ChanServ through a ProtectionBackend abstraction that supports both Atheme and Anope services. The `chanserv_access` per-channel setting tells the bot what level of access it has on each channel:

| Access tier | Atheme capabilities               | Anope capabilities               |
| ----------- | --------------------------------- | -------------------------------- |
| `none`      | No ChanServ commands              | No ChanServ commands             |
| `op`        | OP, UNBAN, INVITE, MODE -k, AKICK | OP, UNBAN, INVITE, GETKEY, AKICK |
| `superop`   | + DEOP others, FLAGS, SET         | + DEOP others, access management |
| `founder`   | + RECOVER, CLEAR BANS             | + MODE CLEAR (synthetic RECOVER) |

### Auto-detection

When `chanserv_access` has never been explicitly set for a channel, the bot probes ChanServ to determine its actual access:

- **Atheme:** Sends `FLAGS #channel <bot_nick>` and maps the flag string to a tier (`+R`/`+F` = founder, `+a`/`+f`/`+s` = superop, `+o` = op)
- **Anope:** Sends `ACCESS #channel LIST` to check numeric levels, plus `INFO #channel` to detect founder status (Anope does not list founders in ACCESS/XOP lists)

Access is verified on bot join and proactively before join-error recovery.

### Backend-assisted recovery

The ProtectionChain dispatches recovery requests to the first capable backend. During takeover escalation, the chain is used for requesting ops (Level 1+), unbans (Level 2+), and full recovery (Level 3). Atheme uses its native `RECOVER` command; Anope synthesizes recovery from `MODE CLEAR ops` -> `UNBAN` -> `INVITE` -> `OP` with configurable step delays.

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
| `enforce_delay_ms`      | number   | `500`           | Delay before re-applying a mode, in milliseconds                                                        |
| `enforce_channel_modes` | string   | `""`            | Channel modes to enforce globally (e.g. `"+nt-s"`)                                                      |
| `enforce_channel_key`   | string   | `""`            | Channel key (`+k`) to enforce globally (empty = remove unauthorized keys when enforce_modes is on)      |
| `enforce_channel_limit` | number   | `0`             | Channel user limit (`+l`) to enforce globally (0 = remove unauthorized limits when enforce_modes is on) |
| `nodesynch_nicks`       | string[] | `["ChanServ"]`  | Nicks exempt from bitch mode and channel mode enforcement                                               |

### Bitch / punish deop / enforcebans

| Key                  | Type               | Default                    | Description                                              |
| -------------------- | ------------------ | -------------------------- | -------------------------------------------------------- |
| `bitch`              | boolean            | `false`                    | Strip `+o`/`+h` from anyone without the appropriate flag |
| `punish_deop`        | boolean            | `false`                    | Kick/kickban anyone who deops a flagged user             |
| `punish_action`      | `"kick"/"kickban"` | `"kick"`                   | Action taken against the setter                          |
| `punish_kick_reason` | string             | `"Don't deop my friends."` | Kick reason used when punishing                          |
| `enforcebans`        | boolean            | `false`                    | Kick users whose hostmask matches a newly-set ban        |

### Kick / ban defaults

| Key                    | Type   | Default       | Description                                      |
| ---------------------- | ------ | ------------- | ------------------------------------------------ |
| `default_kick_reason`  | string | `"Requested"` | Kick reason when none is given                   |
| `default_ban_duration` | number | `120`         | Default ban duration in minutes; `0` = permanent |
| `default_ban_type`     | number | `3`           | Ban mask style (1, 2, or 3 -- see above)         |

### Rejoin / revenge

| Key                        | Type                      | Default            | Description                                                              |
| -------------------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `rejoin_on_kick`           | boolean                   | `true`             | Rejoin after being kicked                                                |
| `rejoin_delay_ms`          | number                    | `5000`             | Delay before rejoining, in milliseconds                                  |
| `max_rejoin_attempts`      | number                    | `3`                | Max rejoins within `rejoin_attempt_window_ms` before giving up           |
| `rejoin_attempt_window_ms` | number                    | `300000`           | Window for the rejoin rate limit, in milliseconds                        |
| `revenge_on_kick`          | boolean                   | `false`            | Take action against whoever kicked the bot                               |
| `revenge_action`           | `"deop"/"kick"/"kickban"` | `"deop"`           | Action taken against the kicker                                          |
| `revenge_delay_ms`         | number                    | `3000`             | Extra delay after rejoin before taking revenge, in milliseconds          |
| `revenge_kick_reason`      | string                    | `"Don't kick me."` | Kick reason used for kick/kickban revenge                                |
| `revenge_exempt_flags`     | string                    | `"nm"`             | Flags that exempt the kicker from revenge (each char is a separate flag) |

### ChanServ integration

| Key                            | Type               | Default      | Description                                                                       |
| ------------------------------ | ------------------ | ------------ | --------------------------------------------------------------------------------- |
| `chanserv_nick`                | string             | `"ChanServ"` | Nick of the ChanServ service to message                                           |
| `chanserv_op_delay_ms`         | number             | `1000`       | Delay before sending the OP request after deop, in milliseconds                   |
| `chanserv_services_type`       | `"atheme"/"anope"` | `"atheme"`   | Services package the network runs (affects command syntax and recovery strategy)  |
| `chanserv_unban_retry_ms`      | number             | `2000`       | Delay before backup UNBAN retry if first rejoin after kick fails, in milliseconds |
| `chanserv_unban_max_retries`   | number             | `3`          | Maximum UNBAN retries before giving up                                            |
| `chanserv_recover_cooldown_ms` | number             | `60000`      | Cooldown between RECOVER requests for the same channel, in milliseconds           |
| `anope_recover_step_delay_ms`  | number             | `200`        | Delay between steps in Anope's synthetic RECOVER sequence, in milliseconds        |

> **Deprecated:** The `chanserv_op` config key has been removed. ChanServ op-recovery is now handled automatically when `chanserv_access` is set to `op` or higher. You can safely delete `chanserv_op` from your `plugins.json`.

### Takeover detection

| Key                          | Type   | Default | Description                                                                  |
| ---------------------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| `takeover_window_ms`         | number | `30000` | Rolling window for threat event scoring, in milliseconds                     |
| `takeover_level_1_threshold` | number | `3`     | Score threshold for Alert level (request ops)                                |
| `takeover_level_2_threshold` | number | `6`     | Score threshold for Active level (request unban)                             |
| `takeover_level_3_threshold` | number | `10`    | Score threshold for Critical level (full RECOVER)                            |
| `takeover_response_delay_ms` | number | `0`     | Delay before recovery actions (mass re-op, hostile response) after bot opped |

### Nick recovery

| Key                   | Type    | Default | Description                                                       |
| --------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `nick_recovery`       | boolean | `true`  | Reclaim the configured nick when the holder changes nick or quits |
| `nick_recovery_ghost` | boolean | `false` | Send `GHOST` to NickServ before reclaiming (requires a password)  |

> **Note:** The NickServ password for GHOST is stored in `config/bot.json` under `chanmod.nick_recovery_password`, not in the plugin config. This follows SECURITY.md: plugin configs should not contain secrets.

### Stopnethack

| Key                | Type   | Default  | Description                                                                 |
| ------------------ | ------ | -------- | --------------------------------------------------------------------------- |
| `stopnethack_mode` | number | `0`      | `0` = off, `1` = isoptest (db check), `2` = wasoptest (pre-split ops check) |
| `split_timeout_ms` | number | `300000` | How long after a detected split to monitor suspicious `+o` grants, in ms    |

### Cycle on deop

| Key              | Type    | Default | Description                                         |
| ---------------- | ------- | ------- | --------------------------------------------------- |
| `cycle_on_deop`  | boolean | `false` | Part and rejoin to recover ops after repeated deops |
| `cycle_delay_ms` | number  | `5000`  | Delay before cycling, in milliseconds               |

### Invite

| Key      | Type    | Default | Description                                           |
| -------- | ------- | ------- | ----------------------------------------------------- |
| `invite` | boolean | `false` | Accept IRC INVITE from registered ops/masters to join |

## Example config

```json
{
  "chanmod": {
    "enabled": true,
    "config": {
      // Auto-op flagged users, enforce modes reactively
      "auto_op": true,
      "enforce_modes": true,
      "enforce_channel_modes": "+nt-s",
      "bitch": true,
      "enforcebans": true,

      // Rejoin after kick, take revenge on kickers
      "rejoin_on_kick": true,
      "rejoin_delay_ms": 5000,
      "revenge_on_kick": true,
      "revenge_action": "kick",

      // ChanServ integration (Atheme network)
      "chanserv_nick": "ChanServ",
      "chanserv_services_type": "atheme",

      // Takeover detection thresholds (defaults are usually fine)
      "takeover_window_ms": 30000,
      "takeover_level_1_threshold": 3,
      "takeover_level_2_threshold": 6,
      "takeover_level_3_threshold": 10,

      // Bans and kicks
      "default_ban_duration": 60,
      "default_ban_type": 3,

      // Nick recovery with GHOST
      "nick_recovery": true,
      "nick_recovery_ghost": true,

      // Cycle as last-resort op recovery
      "cycle_on_deop": true
    }
  }
}
```

Per-channel settings (`.chanset`) override global config. Set `chanserv_access` per-channel to enable backend-assisted recovery:

```
.chanset #mychan chanserv_access founder
.chanset #mychan +takeover_detection
.chanset #mychan takeover_punish akick
.chanset #mychan +protect_topic
```

## Caveats

- All moderation commands (`!op`, `!deop`, `!halfop`, `!dehalfop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`, `!bans`) require the caller to have `+o` flag. Commands that change channel state also require the bot to hold ops.
- `!ban` by nick requires the target to be present in the channel so their hostmask can be resolved. For absent users, pass an explicit mask: `!ban *!*@1.2.3.4`.
- `!unban <nick>` works if the target is still in the channel -- chanmod derives candidate masks from their hostmask and removes whichever one matches a stored record (or tries all three if no record is found). For absent users, provide an explicit mask: `!unban *!*@1.2.3.4`. Use `!bans` to list stored masks.
- Timed bans are only lifted in channels where the bot has ops at the time the timer fires. Bans in channels the bot has left, or where it has lost ops, will not be lifted until it regains them.
- Revenge fires after `rejoin_delay_ms + revenge_delay_ms`. If the bot has not received ops by then (e.g. ChanServ is slow), revenge is skipped silently.
- `bitch` and `punish_deop` both exempt nicks in `nodesynch_nicks` to avoid conflicting with ChanServ mode grants.
- `chanserv_access` must be set (either manually via `.chanset` or auto-detected) for backend-assisted recovery to work. Without it, the bot cannot request UNBAN, INVITE, or RECOVER from ChanServ.
- `protect_topic` requires `takeover_detection` to be useful -- topic restoration only triggers during elevated threat levels.
- RECOVER (Level 3 escalation) requires `founder` access. On Atheme this uses the native RECOVER command; on Anope it synthesizes recovery from MODE CLEAR + UNBAN + INVITE + OP.
- On Anope networks, `GETKEY` (used for +k join recovery) works at AOP level and above. On Atheme networks, `MODE -k` (surgical key removal) works at op level and above.
