# flood

Inbound flood protection. Detects message floods, join spam, and nick-change spam, and responds with escalating actions.

## How it works

Three independent trackers monitor activity using sliding-window counters:

| Tracker          | Trigger                   | Key               |
| ---------------- | ------------------------- | ----------------- |
| Message flood    | `pubm` — channel messages | `nick@channel`    |
| Join flood       | `join` — user joins       | `join:<hostmask>` |
| Nick-change spam | `nick` — nick changes     | `nick:<hostmask>` |

When a threshold is exceeded, the plugin records an **offence** and selects an action from the `actions` list in order. Repeated offences within `offence_window_ms` escalate through the list.

**Default escalation:** warn → kick → tempban

Users with `n`, `m`, or `o` flags are exempt when `ignore_ops` is `true` (the default). The bot must hold ops in the channel to kick or ban.

Temporary bans are stored in the plugin's database namespace and automatically lifted on the next timer tick (every 60 seconds) once they expire.

## Config

| Key                    | Type     | Default                     | Description                                                 |
| ---------------------- | -------- | --------------------------- | ----------------------------------------------------------- |
| `msg_threshold`        | number   | `5`                         | Max messages before flood triggers                          |
| `msg_window_secs`      | number   | `3`                         | Sliding window for message flood                            |
| `join_threshold`       | number   | `3`                         | Max joins before flood triggers                             |
| `join_window_secs`     | number   | `60`                        | Sliding window for join flood                               |
| `nick_threshold`       | number   | `3`                         | Max nick changes before flood triggers                      |
| `nick_window_secs`     | number   | `60`                        | Sliding window for nick spam                                |
| `ban_duration_minutes` | number   | `10`                        | How long tempbans last. `0` = permanent (never auto-lifted) |
| `ignore_ops`           | boolean  | `true`                      | Exempt users with `n`/`m`/`o` flags                         |
| `actions`              | string[] | `["warn","kick","tempban"]` | Escalation sequence                                         |
| `offence_window_ms`    | number   | `300000`                    | Window for offence count decay (5 min)                      |

## Notes

- **Bot ops required** — Flood actions (kick, tempban) require the bot to have ops in the channel. Actions fail silently without ops.
- **Hostmask fallback** — If the bot cannot retrieve a hostmask during a tempban action, it falls back to a kick instead.
- **Empty actions list** — If the `actions` list is empty, it defaults to `warn`.
- **Unrecognized actions** — Any action string not matching `warn` or `kick` is treated as `tempban`.

Example override in `config/plugins.json`:

```json
{
  "flood": {
    "enabled": true,
    "config": {
      "msg_threshold": 8,
      "msg_window_secs": 5,
      "ban_duration_minutes": 30,
      "actions": ["kick", "tempban"]
    }
  }
}
```
