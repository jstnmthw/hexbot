# seen

Tracks when users were last seen talking in a channel.

## Usage

```
!seen <nick>
```

Reports when the user was last active, in which channel, and what they said. If the query is made from a different channel than where the user was last seen, the reply only shows relative time (the message text is omitted for privacy).

## How it works

The plugin silently records every channel message via a `pubm` bind (stackable, doesn't interfere with other plugins). Stored message text is truncated to 200 characters. Data is stored in the bot's database, namespaced to this plugin. Records persist across plugin reloads and bot restarts.

Stale records older than `max_age_days` are automatically cleaned up both when a `!seen` query is made and on a background timer that runs every hour. Expired records are also excluded from query results.

## Config

| Key            | Type   | Default | Description                                                                                                                                               |
| -------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_age_days` | number | `365`   | Records older than this are purged. Setting to `0` expires all records immediately. Use a very large value (e.g. `99999`) to effectively disable cleanup. |

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
