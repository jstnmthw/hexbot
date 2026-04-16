# topic plugin

Sets channel topics using pre-built IRC color theme borders. Ships with 29 built-in themes.
Includes optional topic protection: lock the current topic and the bot will restore it if anyone
changes it without operator privileges.

## Commands

| Command                         | Flags | Description                                                      |
| ------------------------------- | ----- | ---------------------------------------------------------------- |
| `!topic <theme> <text>`         | `o`   | Set the channel topic wrapped in the theme's color border        |
| `!topic lock`                   | `o`   | Lock the current topic — restores it on unauthorized changes     |
| `!topic unlock`                 | `o`   | Disable topic protection                                         |
| `!topic preview <theme> <text>` | `o`   | Preview the themed topic as a channel message                    |
| `!topics`                       | `-`   | List all available theme names                                   |
| `!topics preview [text]`        | `-`   | PM all themes rendered with optional sample text (60 s cooldown) |

## Typical workflow

```
!topic rune Welcome to #hexbot | https://hexbot.net
!topic lock
```

Then if anyone changes the topic without `+o`, the bot immediately restores it.
If a user **with** `+o` changes the topic directly (e.g. via their IRC client), the stored
topic text automatically updates to match their new text — the lock follows the change rather
than reverting it.

To change the locked topic from the bot, set a new one and re-lock:

```
!topic rune Updated topic text
!topic lock
```

To stop protecting:

```
!topic unlock
```

The protection state is also readable and writable via the REPL:

```
.chaninfo #channel          — shows topic_lock and topic_text
.chanset #channel +topic_lock   — enable protection (does not set topic_text)
.chanset #channel -topic_lock   — disable protection
```

> **Note**: `!settopic` was removed in v2.1.0. Use `!topic <theme> <text>` followed by
> `!topic lock` instead.

## Requirements

The bot must have channel operator status (or the channel must have mode `-t`) to set topics.

## Limits

- **Topic length**: The bot warns when a topic exceeds 390 characters (typical IRC server limit).
  Topics longer than this may be silently truncated by the server.
- **Preview cooldown**: `!topics preview` has a 60-second per-user cooldown to prevent flooding.

## Theme list

amethyst, arctic, arrowhead, aurora, baroque, beacon, blaze, bloodrune, charcoal, crimson,
deepblue, dusk, ember, emerald, filigree, frost, fuchsia, grove, obsidian, orchid, prism, rune,
seafoam, silverscreen, spectral, sterling, sunset, tropical, whisper
