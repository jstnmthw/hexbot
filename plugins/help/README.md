# help

Provides `!help` — a ChanServ-style command listing. Shows only the commands a user has
permission to run. Works in channels and PMs.

## Usage

| Command            | Description                               |
| ------------------ | ----------------------------------------- |
| `!help`            | List all commands available to you        |
| `!help <category>` | Show all commands in a category           |
| `!help <command>`  | Show detailed help for a specific command |

`<command>` and `<category>` are matched case-insensitively. The leading `!` is optional —
`!help op` and `!help !op` are equivalent. If the argument matches a command, the command
detail view is shown; otherwise it is tried as a category name.

### Example output (`!help`, default config — compact mode)

```
-Bot- HexBot Commands — !help <category> or !help <command>
-Bot-  FUN  8ball
-Bot-  INFO  seen
-Bot-  MODERATION  op deop halfop dehalfop voice devoice kick ban unban kickban bans
```

With `compact_index: false` the index opens with a wrapped intro
paragraph instead, then lists the categories as uppercased topic rows
with short descriptions — the ChanServ base-help shape shared with the
core `.help` built-in.

### Example output (`!help moderation`)

```
-Bot- MODERATION — Channel bans and enforcement
-Bot-
-Bot-     op    Op a nick (or yourself if omitted)
-Bot-     deop  Deop a nick (or yourself if omitted)
-Bot-     ...
-Bot-
-Bot- Type !help moderation <command> for more information on a
-Bot- particular command.
```

### Example output (`!help op`)

```
-Bot- Syntax: !op [nick]
-Bot-
-Bot- Op a nick (or yourself if omitted)
-Bot-
-Bot- Requires: o
```

Unflagged commands omit the `Requires:` block — the absence is the
signal.

### Permission filtering

The list view only shows commands the requesting user can actually run:

- Commands with `flags: '-'` are always shown (open to everyone).
- Commands with `flags: 'o'`, `'m'`, etc. are shown only if the user holds those flags.
- Users with the `n` (owner) flag see all commands — owner implies every other flag.
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
      "compact_index": true,
      "header": "",
      "footer": "*** End of Help ***"
    }
  }
}
```

| Key             | Type    | Default                 | Description                                                                                    |
| --------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `reply_type`    | string  | `"notice"`              | How help output is delivered (see below).                                                      |
| `cooldown_ms`   | number  | `30000`                 | Per-user cooldown for the list view, in ms.                                                    |
| `compact_index` | boolean | `true`                  | Show a one-line-per-category index instead of the full command list.                           |
| `header`        | string  | `""`                    | Custom index header. Empty = standard intro (verbose) or a `HexBot Commands` banner (compact). |
| `footer`        | string  | `"*** End of Help ***"` | Last line shown when `compact_index: false`. Empty = no footer.                                |

### Reply modes

`reply_type` controls where the list view output is sent:

| Value                | List view target  | Detail view target | Example IRC output                |
| -------------------- | ----------------- | ------------------ | --------------------------------- |
| `"notice"` (default) | NOTICE to nick    | NOTICE to nick     | `-Bot- HexBot Commands …`         |
| `"privmsg"`          | PRIVMSG to nick   | NOTICE to nick     | `<Bot> HexBot Commands …`         |
| `"channel_notice"`   | NOTICE to channel | NOTICE to nick     | `-Bot- [#chan] HexBot Commands …` |

When `reply_type` is `"channel_notice"` and `!help` is invoked via PM, it falls back to
private NOTICE.

## For plugin authors

Plugins register their commands with `api.registerHelp(entries)` in `init()`:

```typescript
api.registerHelp([
  {
    command: '!mycommand',
    flags: '-', // '-' = anyone, 'o' = needs o flag, 'm' = needs m flag
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

Flag strings are literal character checks, not privilege levels. The supported formats:

| Format   | Meaning                                   | Example         |
| -------- | ----------------------------------------- | --------------- |
| `'-'`    | No flags required — anyone can run it     | `flags: '-'`    |
| `'o'`    | User must have the `o` flag               | `flags: 'o'`    |
| `'om'`   | User must have **both** `o` and `m` flags | `flags: 'om'`   |
| `'o\|m'` | User must have **either** `o` or `m`      | `flags: 'o\|m'` |

Example using OR syntax:

```typescript
api.registerHelp([
  {
    command: '!moderate',
    flags: 'o|m', // op OR master may run this
    usage: '!moderate <action>',
    description: 'Perform a moderation action',
    category: 'moderation',
  },
]);
```

Entries are automatically removed when the plugin is unloaded or reloaded.
