# Plan: RSS Feed Plugin

## Summary

A plugin that polls RSS/Atom feeds and announces new items to configured IRC channels. Feeds are defined in `plugins.json` config with per-feed channels, polling intervals, and formatting options. Operators can also add/remove/list feeds at runtime via IRC commands. Deduplication is handled via the KV store so items are never announced twice, and the bot picks up where it left off across restarts.

## Feasibility

- **Alignment**: Fits cleanly into the existing plugin model — `time` binds for polling, `db` for deduplication, `api.say()` for announcements, `pub` binds for admin commands. No core changes needed.
- **Dependencies**: All required core modules (dispatcher, db, plugin-loader) are already built. Needs one new npm package (`rss-parser`).
- **Blockers**: None. Plugin can be fully self-contained.
- **Complexity estimate**: L (a couple of days — admin commands add meaningful scope)
- **Risk areas**:
  - Feed polling must not block the event loop — all fetches are async/await
  - Deduplication key design must survive feed item edge cases (missing guid, duplicate links)
  - Multiple feeds at different intervals handled by one `time` bind with last-poll tracking, not one bind per feed (more reliable, avoids bind count growing unbounded with config changes)
  - Flood protection: `api.say()` is already queued, but announcing many items at once still needs a per-poll cap
  - Network errors and malformed feeds must be caught and logged without crashing the bot
  - Runtime-added feeds (via `!rss add`) live in the KV store; feeds from config.json are always authoritative on load but runtime additions persist separately

## Dependencies

- [x] `src/types.ts` — PluginAPI interface
- [x] `src/database.ts` — KV store
- [x] Dispatcher `time` bind type
- [x] `api.say()` / message queue
- [ ] `rss-parser` npm package (new dependency)

## Phases

### Phase 1: Dependency and skeleton

**Goal:** Install `rss-parser`, scaffold the plugin structure, define config schema.

- [ ] Run `pnpm add rss-parser` (ships its own TypeScript types, no `@types/` package needed)
- [ ] Create `plugins/rss/index.ts` with `name`, `version`, `description`, `init`, `teardown` exports
- [ ] Create `plugins/rss/config.json` with defaults (`dedup_window_days: 30`, `max_title_length: 300`, `request_timeout_ms: 10000`, `max_per_poll: 5`, `feeds: []`)
- [ ] Create `plugins/rss/README.md` with config documentation
- [ ] Verify plugin loads with `pnpm dev` and empty feeds list (should log startup and do nothing)

### Phase 2: Feed polling and deduplication

**Goal:** Fetch feeds, detect new items, store seen items in the KV store.

**KV key design:**

- `rss:last_poll:<feed_id>` → ISO timestamp of last successful poll (for interval tracking)
- `rss:seen:<feed_id>:<item_hash>` → ISO timestamp when first seen

Where `feed_id` is the feed's `id` field (user-defined slug), and `item_hash` is the first 16 hex chars of a SHA-1 of the item's `guid` (falling back to `title + link` if guid is absent).

**First-run behavior:** On the very first `init()`, all existing feed items are fetched and marked seen _without_ announcing. Only items that appear in subsequent polls are announced. This prevents flooding the channel with historical backlog when the plugin is first enabled.

**Implementation:**

- [ ] Write `hashItem(item: FeedItem): string` — `createHash('sha1')` on guid or title+link, return first 16 hex chars
- [ ] Write `hasSeen(api, feedId, hash): boolean` — checks `api.db.get('rss:seen:<feedId>:<hash>')`
- [ ] Write `markSeen(api, feedId, hash): void` — `api.db.set(...)` with current ISO timestamp
- [ ] Write `getLastPoll(api, feedId): number` — parses KV timestamp, returns 0 if absent
- [ ] Write `setLastPoll(api, feedId): void` — stores current ISO timestamp
- [ ] Write `pollFeed(api, feed, config, announce): Promise<FeedItem[]>` — fetches URL with `rss-parser`, filters unseen items, marks them seen, caps at `max_per_poll`; when `announce = false`, marks all items seen and returns `[]`
- [ ] In `init()`: call `pollFeed(..., false)` for each feed (silent first-run seeding), then register a single `time` bind at `'60'` seconds that polls feeds whose interval has elapsed
- [ ] Verification: Load plugin, observe KV populated with seen entries; reload plugin, confirm no items re-announced

### Phase 3: IRC announcement and formatting

**Goal:** Format and send new feed items to the configured channels.

**Default format:** `\x02[{feed_name}]\x02 {title} — {link}`

Where `\x02` is IRC bold. Title is truncated to `max_title_length` chars with `…` appended if cut.

- [ ] Write `formatItem(feed, item, config): string` — strips HTML from title (`/<[^>]*>/g`), truncates, applies bold feed name prefix
- [ ] Write `announceItems(api, feed, items): Promise<void>` — `api.say(channel, formatted)` for each item × each channel, with a 500ms delay between sends to avoid bursting
- [ ] If `feeds[].channels` is empty, skip and log a warning; don't announce to channels the feed isn't configured for
- [ ] Verification: Configure a known feed, trigger a `!rss check` (Phase 5), observe formatted announcements in the test channel

### Phase 4: Cleanup and error handling

**Goal:** Prevent stale KV entries from accumulating; handle network/parse failures gracefully.

- [ ] Write `cleanupSeen(api, config): void` — `api.db.list('rss:seen:')` → delete entries older than `dedup_window_days` days
- [ ] Register a `time` bind at `'86400'` (daily) that calls `cleanupSeen`
- [ ] Wrap each `pollFeed` call in try/catch — on error, log `[plugin:rss] Error polling <url>: <msg>` and skip; do NOT update `last_poll` so it retries on the next tick
- [ ] Handle `rss-parser` parse errors (malformed XML, non-RSS responses) the same way
- [ ] Set fetch timeout via `rss-parser`'s `timeout` option (`request_timeout_ms` from config)
- [ ] Verification: Point at a non-existent URL, confirm bot logs an error and doesn't crash or update `last_poll`

### Phase 5: Admin commands

**Goal:** Let operators manage feeds at runtime via IRC and manually trigger polls.

**Commands** (all require `m` master flags, except `!rss check` which requires `o` op):

| Command                                     | Description                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `!rss list`                                 | List all active feeds (config + runtime-added), their channels and intervals |
| `!rss add <id> <url> <#channel> [interval]` | Add a new feed at runtime; stored in KV under `rss:feed:<id>`                |
| `!rss remove <id>`                          | Remove a runtime-added feed (cannot remove config-file feeds)                |
| `!rss check [id]`                           | Manually trigger a poll; if `id` omitted, polls all feeds                    |

**Runtime feed persistence:** Runtime-added feeds are stored in KV as `rss:feed:<id>` (JSON-stringified feed config). On `init()`, the plugin merges KV-stored feeds with config-file feeds (config-file takes precedence on ID collision).

**Implementation:**

- [ ] Write `loadRuntimeFeeds(api): FeedConfig[]` — `api.db.list('rss:feed:')` → parse JSON values
- [ ] Write `saveRuntimeFeed(api, feed): void` — `api.db.set('rss:feed:<id>', JSON.stringify(feed))`
- [ ] Write `deleteRuntimeFeed(api, id): void` — `api.db.del('rss:feed:<id>')`
- [ ] In `init()`, call `loadRuntimeFeeds` and merge with config feeds into a mutable `activeFeedsMap`
- [ ] Register `pub` bind on `!rss` with `m` flags — dispatch to subcommand handlers based on `ctx.args`
- [ ] Implement `!rss list` handler — formats and replies with feed table
- [ ] Implement `!rss add` handler — validates args, creates `FeedConfig`, saves to KV, calls `pollFeed(..., false)` to seed without announcing, adds to `activeFeedsMap`
- [ ] Implement `!rss remove` handler — checks feed is runtime-added (not from config), deletes from KV and `activeFeedsMap`
- [ ] Implement `!rss check` handler (requires `o` flags) — calls `pollFeed(..., true)` for the specified feed(s), announces any new items
- [ ] Register help entries for all `!rss` subcommands via `api.registerHelp()`
- [ ] Verification: Add a feed via `!rss add`, observe it in `!rss list`, trigger `!rss check`, remove with `!rss remove`

### Phase 6: Tests

**Goal:** Unit-test the pure functions; integration-test polling logic with a mock feed.

- [ ] Create `tests/plugins/rss.test.ts`
- [ ] Test `hashItem()` — deterministic hash for same guid, fallback to title+link, 16-char hex output
- [ ] Test `formatItem()` — HTML stripping, title truncation at `max_title_length`, bold feed name prefix
- [ ] Test `hasSeen()` / `markSeen()` — KV round-trip with in-memory SQLite
- [ ] Test `cleanupSeen()` — old entries deleted, recent entries kept
- [ ] Integration test `pollFeed()` with mocked `rss-parser` — first poll (announce=false) marks all seen and returns `[]`; second poll returns `[]` (already seen); new item on third poll returns one item
- [ ] Test `!rss add` / `!rss remove` / `!rss list` command handlers
- [ ] Error handling: mocked `rss-parser` throws → no crash, no `last_poll` update
- [ ] Verification: `pnpm test` passes all new tests

## Config changes

New entry in `config/plugins.example.json`:

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

**Feed fields:**
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | yes | — | Unique slug for this feed (used as KV namespace and command argument) |
| `url` | yes | — | RSS/Atom feed URL |
| `name` | no | `id` | Display name shown in IRC announcements |
| `channels` | yes | — | Channels to announce new items to |
| `interval` | no | `3600` | Polling interval in seconds (minimum recommended: 720) |

**Top-level config fields:**
| Field | Default | Description |
|-------|---------|-------------|
| `dedup_window_days` | `30` | How long to remember seen items before cleanup |
| `max_title_length` | `300` | Max title chars before truncation |
| `request_timeout_ms` | `10000` | HTTP fetch timeout |
| `max_per_poll` | `5` | Max items announced per feed per poll cycle |

## Database changes

No new tables. Uses existing KV store with namespaced keys:

- `rss:seen:<feed_id>:<item_hash>` — deduplication records (ISO timestamp value)
- `rss:last_poll:<feed_id>` — last successful poll time (ISO string)
- `rss:feed:<feed_id>` — runtime-added feed configs (JSON-stringified `FeedConfig`)

## Test plan

- `hashItem()`: pure function, deterministic hash, fallback behavior
- `formatItem()`: HTML stripping, truncation, bold formatting
- `hasSeen()` / `markSeen()`: KV read/write round-trip with in-memory SQLite
- `cleanupSeen()`: age-based deletion using in-memory SQLite
- `pollFeed()` integration: mock `rss-parser`, verify first-run silent seeding, dedup, and `max_per_poll` cap
- Admin command handlers: `!rss add`, `!rss remove`, `!rss list`, `!rss check`
- Error handling: mock `rss-parser` throwing, confirm no crash and no `last_poll` update
