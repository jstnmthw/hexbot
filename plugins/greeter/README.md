# greeter

Greets users when they join a channel. Registered users can set a personal greeting
that replaces the default message when they join.

## Usage

Automatic — fires on every JOIN event (the bot's own joins are ignored).

Greeting precedence (highest to lowest):

1. User's custom greet (set via `!greet set`)
2. Per-channel `greet_msg` setting (set via `.chanset`)
3. Global default `message` from plugin config

Optional user commands:

| Command                | Flags | Description                                    |
| ---------------------- | ----- | ---------------------------------------------- |
| `!greet`               | `-`   | View, set, or delete your custom join greeting |
| `!greet set <message>` | `-`   | Set your custom greet                          |
| `!greet del`           | `-`   | Remove your custom greet                       |

> `!greet set` and `!greet del` check the `min_flag` permission internally — any user can run the base `!greet` command, but setting or deleting requires the configured flag level.

Custom greet messages support the same `{channel}` and `{nick}` template substitutions
as the default message. Custom greetings are silently truncated to 200 characters, and
`\r` and `\n` characters are stripped from both custom greetings and private join notices.

## Config

In `config/plugins.json`:

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "message": "Welcome to {channel}, {nick}!",
      "min_flag": "v"
    }
  }
}
```

| Key           | Type   | Default                         | Description                                                |
| ------------- | ------ | ------------------------------- | ---------------------------------------------------------- |
| `message`     | string | `Welcome to {channel}, {nick}!` | Default greeting template. Supports `{channel}`, `{nick}`. |
| `delivery`    | string | `"say"`                         | How the public greeting is sent (see below).               |
| `join_notice` | string | `""`                            | Optional private NOTICE to the joining user (empty = off). |
| `min_flag`    | string | `"v"`                           | Minimum bot flag required to set/remove a greet.           |

### Delivery modes

`delivery` controls the public channel greeting visible to everyone:

| Value              | IRC call           | How clients show it               |
| ------------------ | ------------------ | --------------------------------- |
| `"say"` (default)  | `PRIVMSG #channel` | `<Bot> Welcome, nick!`            |
| `"channel_notice"` | `NOTICE #channel`  | `-Bot- [#channel] Welcome, nick!` |

### Private join notice

`join_notice` is independent of `delivery` — when non-empty, the bot also sends a `NOTICE` directly to the joining user. Nobody else in the channel sees it. Supports `{channel}` and `{nick}` substitutions.

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "delivery": "channel_notice",
      "join_notice": "Hi {nick}! Type !help to see available commands."
    }
  }
}
```

Result when alice joins `#lobby`:

```
-Bot- [#lobby] Welcome to #lobby, alice!          (visible to everyone)
-Bot- Hi alice! Type !help to see available commands.  (private to alice)
```

### Per-channel greeting

The default greeting can be overridden per-channel using `.chanset` (requires `m` flag):

```
.chanset #chan greet_msg Welcome to {channel}, {nick}! Check !help for commands.
.chanset #chan greet_msg           — show current value
.chanset #chan -greet_msg          — revert to global default
```

Supports the same `{channel}` and `{nick}` substitutions as the global `message` config key.

### `min_flag` values

Uses the `n > m > o > v` privilege hierarchy. Setting `"o"` means op or higher can set greets.

| Value | Who can set a greet |
| ----- | ------------------- |
| `"n"` | Owner only          |
| `"m"` | Master or higher    |
| `"o"` | Op or higher        |
| `"v"` | Voice or higher     |

> Note: the bot's flag system (`n/m/o/v`) has no halfop level. "Above halfop" maps to `"o"`.
