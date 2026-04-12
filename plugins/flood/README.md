# flood

Inbound flood protection. Detects message floods, join spam, part spam, and nick-change spam, and responds with escalating actions. When multiple distinct users trip the join/part flood detector, the plugin can lock the channel with `+R` (registered-only) or `+i` (invite-only) to stop the attack.

## How it works

Four independent trackers monitor activity using sliding-window counters:

| Tracker          | Trigger                   | Key               |
| ---------------- | ------------------------- | ----------------- |
| Message flood    | `pubm` — channel messages | `nick@channel`    |
| Join flood       | `join` — user joins       | `join:<hostmask>` |
| Part flood       | `part` — user parts       | `part:<hostmask>` |
| Nick-change spam | `nick` — nick changes     | `nick:<hostmask>` |

When a threshold is exceeded, the plugin records an **offence** and selects an action from the `actions` list in order. Repeated offences within `offence_window_ms` escalate through the list.

**Default escalation:** warn → kick → tempban

Users with `n`, `m`, or `o` flags are exempt when `ignore_ops` is `true` (the default). The bot must hold ops in the channel to kick or ban.

Temporary bans are stored in the plugin's database namespace and automatically lifted on the next timer tick (every 60 seconds) once they expire.

### Channel lockdown

When `flood_lock_count` or more distinct hostmasks trip the join or part flood detector within `flood_lock_window` seconds, the plugin sets `+R` (registered-only joins) on the channel. The mode is automatically removed after `flood_lock_duration` seconds.

If the network doesn't support `+R`, configure `flood_lock_mode` to `i` (invite-only) globally or per-channel via `.chanset #channel flood_lock_mode i`.

Lockdown is disabled when `flood_lock_count` is `0`.

## Config

| Key                    | Type     | Default                     | Description                                                  |
| ---------------------- | -------- | --------------------------- | ------------------------------------------------------------ |
| `msg_threshold`        | number   | `5`                         | Max messages before flood triggers                           |
| `msg_window_secs`      | number   | `3`                         | Sliding window for message flood                             |
| `join_threshold`       | number   | `3`                         | Max joins before flood triggers                              |
| `join_window_secs`     | number   | `60`                        | Sliding window for join flood                                |
| `part_threshold`       | number   | `3`                         | Max parts before flood triggers                              |
| `part_window_secs`     | number   | `60`                        | Sliding window for part flood                                |
| `nick_threshold`       | number   | `3`                         | Max nick changes before flood triggers                       |
| `nick_window_secs`     | number   | `60`                        | Sliding window for nick spam                                 |
| `ban_duration_minutes` | number   | `10`                        | How long tempbans last. `0` = permanent (never auto-lifted)  |
| `ignore_ops`           | boolean  | `true`                      | Exempt users with `n`/`m`/`o` flags                          |
| `actions`              | string[] | `["warn","kick","tempban"]` | Escalation sequence                                          |
| `offence_window_ms`    | number   | `300000`                    | Window for offence count decay (5 min)                       |
| `flood_lock_count`     | number   | `3`                         | Distinct flooders needed to trigger lockdown. `0` = disabled |
| `flood_lock_window`    | number   | `60`                        | Window (seconds) for counting distinct flooders              |
| `flood_lock_duration`  | number   | `60`                        | How long (seconds) the channel stays locked                  |
| `flood_lock_mode`      | string   | `R`                         | Channel mode for lockdown (`R` = registered, `i` = invite)   |

## Per-channel settings

Override the lockdown mode per-channel using `.chanset`:

```
.chanset #channel flood_lock_mode i
```

| Key               | Type   | Default | Description                                         |
| ----------------- | ------ | ------- | --------------------------------------------------- |
| `flood_lock_mode` | string | `R`     | `R` (registered-only) or `i` (invite-only) lockdown |

## Notes

- **Bot ops required** — Flood actions (kick, tempban, lockdown) require the bot to have ops in the channel. Actions fail silently without ops.
- **Hostmask fallback** — If the bot cannot retrieve a hostmask during a tempban action, it falls back to a kick instead.
- **Empty actions list** — If the `actions` list is empty, it defaults to `warn`.
- **Unrecognized actions** — Any action string not matching `warn` or `kick` is treated as `tempban`.
- **Lockdown is per-channel** — Each channel tracks its own distinct-flooder count independently.
- **No double-lock** — If a channel is already locked, additional flooders do not reset the unlock timer or re-set the mode.

Example override in `config/plugins.json`:

```json
{
  "flood": {
    "enabled": true,
    "config": {
      "msg_threshold": 8,
      "msg_window_secs": 5,
      "ban_duration_minutes": 30,
      "actions": ["kick", "tempban"],
      "flood_lock_count": 5,
      "flood_lock_duration": 120,
      "flood_lock_mode": "i"
    }
  }
}
```
