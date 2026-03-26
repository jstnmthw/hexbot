# greeter

Greets users when they join a channel. Registered users can set a personal greeting
that replaces the default message when they join.

## Usage

Automatic — fires on every JOIN event.

Optional user commands (when `allow_custom: true`):

| Command                | Flags       | Description                    |
| ---------------------- | ----------- | ------------------------------ |
| `!greet`               | anyone      | Show your current custom greet |
| `!greet set <message>` | `min_flag`+ | Set your custom greet          |
| `!greet del`           | `min_flag`+ | Remove your custom greet       |

`!greet` is listed in `!help` output regardless of the `allow_custom` setting.

Custom greet messages support the same `{channel}` and `{nick}` template substitutions
as the default message.

## Config

In `config/plugins.json`:

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "message": "Welcome to {channel}, {nick}!",
      "allow_custom": true,
      "min_flag": "v"
    }
  }
}
```

| Key            | Type    | Default                         | Description                                                |
| -------------- | ------- | ------------------------------- | ---------------------------------------------------------- |
| `message`      | string  | `Welcome to {channel}, {nick}!` | Default greeting template. Supports `{channel}`, `{nick}`. |
| `delivery`     | string  | `"say"`                         | How the public greeting is sent (see below).               |
| `join_notice`  | string  | `""`                            | Optional private NOTICE to the joining user (empty = off). |
| `allow_custom` | boolean | `false`                         | Enable user-settable custom greets.                        |
| `min_flag`     | string  | `"v"`                           | Minimum bot flag required to set/remove a greet.           |

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

### `min_flag` values

Uses the `n > m > o > v` privilege hierarchy. Setting `"o"` means op or higher can set greets.

| Value | Who can set a greet |
| ----- | ------------------- |
| `"n"` | Owner only          |
| `"m"` | Master or higher    |
| `"o"` | Op or higher        |
| `"v"` | Voice or higher     |

> Note: the bot's flag system (`n/m/o/v`) has no halfop level. "Above halfop" maps to `"o"`.
