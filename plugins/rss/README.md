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

| Field                | Default           | Description                                                                                                                                |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `dedup_window_days`  | `30`              | Days to remember seen items                                                                                                                |
| `max_title_length`   | `300`             | Max title chars before truncation                                                                                                          |
| `request_timeout_ms` | `10000`           | HTTP fetch inactivity timeout (wall-clock deadline is 3× this value)                                                                       |
| `max_per_poll`       | `5`               | Max items announced per feed per poll                                                                                                      |
| `max_feed_bytes`     | `5242880` (5 MiB) | Max response body size before the fetch is aborted                                                                                         |
| `allow_http`         | `false`           | Opt-in to plaintext `http://` feeds. **Do not enable except for trusted internal feeds** — plaintext feeds can be tampered with in transit |

### SSRF protections

The plugin refuses to fetch any URL that fails the following checks (see `plugins/rss/url-validator.ts`):

- **Scheme**: `https://` only by default. `http://` requires `allow_http: true`.
- **Port**: only the standard web ports (`80`, `443`, `8080`, `8443`) are allowed. Non-web ports (SSH, SMTP, IRC, database) are rejected.
- **Userinfo**: URLs containing `user:pass@` are rejected — credentials would land in the KV store and audit log.
- **Address range**: every resolved IP must be publicly routable. Loopback, RFC1918, CGNAT, link-local, ULA, cloud metadata (`169.254.169.254`), IPv4-mapped IPv6 pointing at private space, and all reserved ranges are rejected (classified via `ipaddr.js`).
- **DNS rebinding**: the resolved address is pinned on the socket, so the HTTP connect uses the validated IP rather than re-resolving the hostname. Each redirect is re-validated end-to-end.

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
