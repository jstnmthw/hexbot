# Plan: Core Message Queue with Flood Protection

## Summary

Add a `MessageQueue` core module that sits between the bot's outgoing IRC methods (`say`, `notice`, `action`, `raw`) and the irc-framework client. All outbound messages pass through a rate-limited queue that drains at a safe interval, preventing the bot from getting killed by servers for excess flood. The queue is transparent — existing plugins and core modules require no changes to their call sites.

## Feasibility

- **Alignment**: DESIGN.md §2.9 explicitly calls for "flood protection" on IRC command wrappers. This fills that gap.
- **Dependencies**: None — this sits underneath existing modules and wraps the IRC client.
- **Blockers**: None.
- **Complexity**: S (hours) — single new file, config addition, wiring changes in bot.ts + plugin-loader.ts + irc-bridge.ts.
- **Risk areas**: Tuning defaults — too slow feels laggy, too fast gets killed. Token-bucket algorithm handles this well with burst allowance. Shutdown must drain or discard the queue cleanly.

## Dependencies

- [x] irc-framework client (exists)
- [x] Bot orchestrator wiring (exists)
- [x] PluginAPI say/notice/action/raw (exists)

## Phases

### Phase 1: MessageQueue module

**Goal:** Create the queue with token-bucket rate limiting.

- [x] Create `src/core/message-queue.ts`
  - Token-bucket algorithm: configurable `rate` (messages/sec), `burst` (max tokens), `delay` (ms between sends)
  - `enqueue(fn: () => void)` — push a send operation onto the queue
  - `drain()` — timer-driven, pops and executes one item per tick
  - `flush()` — send everything remaining (for shutdown)
  - `clear()` — discard everything (for reconnect)
  - `pending` getter — number of queued messages
  - Sensible defaults: 2 msgs/sec, burst of 4, 500ms drain interval
- [x] Verify: unit test — enqueue 10 messages, confirm they drain at the expected rate and burst behaves correctly

### Phase 2: Wire into bot

**Goal:** All outgoing messages flow through the queue transparently.

- [x] Add `queue` config section to `BotConfig` type in `src/types.ts`
- [x] In `src/bot.ts`: instantiate `MessageQueue` before other modules, pass it to `PluginLoader` and `IRCBridge`
- [x] In `src/plugin-loader.ts`: wrap `api.say()`, `api.notice()`, `api.action()` calls through the queue instead of calling `ircClient` directly. `api.raw()` and `api.topic()` bypass the queue (control messages should not be delayed).
- [x] In `src/irc-bridge.ts`: wrap `ctx.reply()` and `ctx.replyPrivate()` through the queue
- [x] In `src/bot.ts` shutdown: call `queue.flush()` before quit, then `queue.stop()`
- [x] On reconnect (`reconnecting` event): call `queue.clear()` to discard stale messages
- [x] Verify: start bot, trigger topic preview — messages arrive at a steady pace instead of instant burst

### Phase 3: Topic plugin cleanup

**Goal:** The topic preview "just works" now with no plugin-level changes needed.

- [x] Verify `!topics preview` sends all themes via PM without getting flood-killed
- [x] No code changes needed in the topic plugin — the queue is transparent

## Config changes

New optional `queue` section in `config/bot.json`:

```json
{
  "queue": {
    "rate": 2,
    "burst": 4
  }
}
```

Both fields optional with sensible defaults. Added to `bot.example.json`.

## Database changes

None.

## Test plan

- **Unit test** (`tests/core/message-queue.test.ts`):
  - [x] Enqueue N messages, verify they execute in order
  - [x] Verify burst: first `burst` messages send immediately, then throttled
  - [x] Verify `flush()` sends all remaining immediately
  - [x] Verify `clear()` discards pending messages
  - [x] Verify `stop()` clears the drain timer
- **Integration**: manual test on Rizon — run `!topics preview` and confirm no disconnect

## Resolved questions

1. **`raw()` bypasses the queue** — confirmed. Control messages (TOPIC, MODE, JOIN) should not be delayed.
2. **Single global queue** — confirmed. Server rate limit is per-connection, not per-channel.
