# RSS Plugin

Polls RSS/Atom feeds and announces new items to configured IRC channels.

## Config

Add to `config/plugins.json`:

```json
"rss": {
  "enabled": true,
  "config": {
    "feeds": [
      {
        "id": "hackernews",
        "url": "https://news.ycombinator.com/rss",
        "name": "Hacker News",
        "channels": ["#tech"],
        "interval": 900
      }
    ],
    "dedup_window_days": 30,
    "max_title_length": 300,
    "request_timeout_ms": 10000,
    "max_per_poll": 5
  }
}
```

### Feed fields

| Field      | Required | Default | Description                                             |
| ---------- | -------- | ------- | ------------------------------------------------------- |
| `id`       | yes      | —       | Unique slug (used as KV namespace and command argument) |
| `url`      | yes      | —       | RSS/Atom feed URL                                       |
| `name`     | no       | `id`    | Display name in IRC announcements                       |
| `channels` | yes      | —       | Channels to announce new items to                       |
| `interval` | no       | `3600`  | Polling interval in seconds (min recommended: 720)      |

### Top-level config

| Field                | Default | Description                           |
| -------------------- | ------- | ------------------------------------- |
| `dedup_window_days`  | `30`    | Days to remember seen items           |
| `max_title_length`   | `300`   | Max title chars before truncation     |
| `request_timeout_ms` | `10000` | HTTP fetch timeout                    |
| `max_per_poll`       | `5`     | Max items announced per feed per poll |

## Commands

All commands respond via notice to the invoking user. Feed announcements go to channels via PRIVMSG.

| Command                                     | Flags | Description                 |
| ------------------------------------------- | ----- | --------------------------- |
| `!rss list`                                 | `m`   | List all active feeds       |
| `!rss add <id> <url> <#channel> [interval]` | `m`   | Add a feed at runtime       |
| `!rss remove <id>`                          | `m`   | Remove a runtime-added feed |
| `!rss check [id]`                           | `m`   | Manually trigger a poll     |

## Announcement format

```
[Feed Name] Article title here — https://example.com/article
```

`[Feed Name]` is IRC bold. Titles are stripped of HTML and truncated at `max_title_length`.

## First-run behavior

On first load (or after adding a new feed), all existing items are silently marked as seen without announcing. Only items that appear in subsequent polls are announced.

## Deduplication

Items are identified by SHA-1 hash of their `guid` (falling back to `title + link`). Seen hashes are stored in the KV store and cleaned up after `dedup_window_days`.
