# seen

Tracks when users were last seen talking in a channel.

## Usage

```
!seen <nick>
```

Reports when the user was last active, in which channel, and what they said.

## How it works

The plugin silently records every channel message via a `pubm` bind (stackable, doesn't interfere with other plugins). Data is stored in the bot's database, namespaced to this plugin. Records persist across plugin reloads and bot restarts.

Stale records older than `max_age_days` are automatically cleaned up when a `!seen` query is made. Expired records are also excluded from query results.

## Config

| Key            | Type   | Default | Description                                                        |
| -------------- | ------ | ------- | ------------------------------------------------------------------ |
| `max_age_days` | number | `365`   | Records older than this are purged. Set to `0` to disable cleanup. |

Example override in `config/plugins.json`:

```json
{
  "seen": {
    "enabled": true,
    "config": {
      "max_age_days": 180
    }
  }
}
```
