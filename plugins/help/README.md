# help

Provides `!help` — a ChanServ-style command listing. Shows only the commands a user has
permission to run. Works in channels and PMs.

## Usage

| Command           | Description                               |
| ----------------- | ----------------------------------------- |
| `!help`           | List all commands available to you        |
| `!help <command>` | Show detailed help for a specific command |

`<command>` is matched case-insensitively. The leading `!` is optional — `!help op` and
`!help !op` are equivalent.

### Example output (`!help`, default config)

```
-Bot- *** Help ***
-Bot- [fun]
-Bot-   !8ball <question> — Ask the magic 8-ball a yes/no question
-Bot- [info]
-Bot-   !seen <nick> — Show when a nick was last seen in channel
-Bot- [moderation]
-Bot-   !op [nick] — Op a nick (or yourself if omitted)
-Bot-   ...
-Bot- *** End of Help ***
```

### Example output (`!help op`)

```
-Bot- Usage: !op [nick]
-Bot- Flags: o
-Bot- Op a nick (or yourself if omitted)
```

### Permission filtering

The list view only shows commands the requesting user can actually run:

- Commands with `flags: '-'` are always shown (open to everyone).
- Commands with `flags: 'o'`, `'m'`, etc. are shown only if the user holds those flags.
- The detail view (`!help <command>`) always shows the entry regardless of flags — including
  the required flags — so users can look up what permissions a command needs.

### Cooldown

To prevent queue flooding, the list view enforces a per-user cooldown (default 30 s).
Requests within the cooldown window are silently dropped. The detail view bypasses the
cooldown.

## Config

In `config/plugins.json`:

```json
{
  "help": {
    "enabled": true,
    "config": {
      "reply_type": "notice",
      "cooldown_ms": 30000,
      "header": "*** Help ***",
      "footer": "*** End of Help ***"
    }
  }
}
```

| Key           | Type   | Default                 | Description                                 |
| ------------- | ------ | ----------------------- | ------------------------------------------- |
| `reply_type`  | string | `"notice"`              | How help output is delivered (see below).   |
| `cooldown_ms` | number | `30000`                 | Per-user cooldown for the list view, in ms. |
| `header`      | string | `"*** Help ***"`        | First line of the list view.                |
| `footer`      | string | `"*** End of Help ***"` | Last line of the list view.                 |

### Reply modes

`reply_type` controls where the list view output is sent:

| Value                | List view target  | Detail view target | Example IRC output           |
| -------------------- | ----------------- | ------------------ | ---------------------------- |
| `"notice"` (default) | NOTICE to nick    | NOTICE to nick     | `-Bot- *** Help ***`         |
| `"privmsg"`          | PRIVMSG to nick   | NOTICE to nick     | `<Bot> *** Help ***`         |
| `"channel_notice"`   | NOTICE to channel | NOTICE to nick     | `-Bot- [#chan] *** Help ***` |

When `reply_type` is `"channel_notice"` and `!help` is invoked via PM, it falls back to
private NOTICE.

## For plugin authors

Plugins register their commands with `api.registerHelp(entries)` in `init()`:

```typescript
api.registerHelp([
  {
    command: '!mycommand',
    flags: '-', // '-' = anyone, 'o' = op+, 'm' = master+, etc.
    usage: '!mycommand <arg>',
    description: 'One-line description shown in the list view',
    detail: [
      // optional — extra lines shown in !help mycommand
      'Additional usage notes here',
    ],
    category: 'fun', // groups commands in the list view
  },
]);
```

Entries are automatically removed when the plugin is unloaded or reloaded.
