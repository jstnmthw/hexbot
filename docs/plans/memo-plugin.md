# Plan: Memo System — MemoServ Proxy

## Summary

A core memo system that acts as a **MemoServ proxy** for bot admins. Two layers:

1. **MemoServ relay** — When MemoServ sends the bot a notice (e.g. vhost approval, new memo), forward it live to online owners/masters via NOTICE and DCC console. No local storage.

2. **MemoServ proxy commands** — `.memo` dot-command with subcommands lets admins interact with MemoServ through the bot's console (DCC/REPL). The bot sends commands to MemoServ, captures the response notices, and relays them back to the requesting admin session.

**Who can use it:** Only users with `n` (owner) or `m` (master) flags. This is an admin tool, not a public messaging platform.

**No local storage:** The bot does not maintain its own memo database. MemoServ is the source of truth. The bot tracks only a `pendingMemoCount` (parsed from MemoServ's "You have N new memo(s)" notices) for join/connect notifications.

## Feasibility

- **Alignment**: Core module is appropriate — needs DCC console integration (`CommandHandler`), direct access to `Permissions` for flag checking.
- **Dependencies**: All required infrastructure exists — `CommandHandler` (DCC/REPL/IRC), `Permissions`, `notice` dispatcher type for MemoServ relay, `DCCManager` for console delivery.
- **Blockers**: None.
- **Complexity estimate**: S — streamlined proxy with no DB layer.

## Dependencies

- [x] `CommandHandler` — shared command router for REPL/DCC/IRC
- [x] `Permissions` — flag checking, `findByHostmask()`, `listUsers()`
- [x] `DCCManager` — deliver notifications on DCC console connect
- [x] `notice` bind type in dispatcher — intercept MemoServ notices
- [x] `join` bind type — trigger delivery notification on channel join
- [x] `ChannelState` — find online n/m users across channels for relay

## Implementation

### MemoServ relay

- [x] Register `notice` bind via dispatcher
  - Only process private notices (`ctx.channel === null`)
  - Match sender nick against configurable `memoserv_nick` (default `"MemoServ"`)
  - Parse "You have N new memo(s)" to update `pendingMemoCount`
  - Route through `handleMemoServNotice()` which either captures (if pending request) or relays

### Response capture mechanism

- [x] `pendingRequest` state: tracks requesting `CommandContext`, response buffer, and timeout
- [x] When admin runs a `.memo` subcommand that talks to MemoServ:
  1. Set `pendingRequest` with their session context
  2. Send `/msg MemoServ <COMMAND>` via `client.say()`
  3. MemoServ notices append to buffer (timeout resets on each line)
  4. After timeout (default 3s): deliver buffered lines to requesting session
- [x] Only one pending request at a time — concurrent requests get "try again in a moment"
- [x] Unsolicited MemoServ notices (no pending request) relay to all admins as normal

### `.memo` command (single command, switch-case subcommands)

- [x] `.memo` — shows pending count (default, no subcommand)
- [x] `.memo help` — shows available subcommands
- [x] `.memo read [new|last|<id>]` — `/msg MemoServ READ <arg>` (default: LAST), resets pending count
- [x] `.memo list` — `/msg MemoServ LIST`, resets pending count
- [x] `.memo del <id|all>` — `/msg MemoServ DEL <id|ALL>`
- [x] `.memo send <nick> <message>` — `/msg MemoServ SEND <nick> <message>`
- [x] `.memo info` — `/msg MemoServ INFO`
- [x] Unknown subcommand → error with help pointer

### Notifications

- [x] MemoServ notice → relay to DCC console + NOTICE online n/m users
- [x] DCC connect → "MemoServ reports N unread memo(s). Type .memo list to view."
- [x] IRC join → same, with per-handle cooldown (default 60s)

## Config

Optional key in `config/bot.json`:

```json
"memo": {
  "memoserv_relay": true,
  "memoserv_nick": "MemoServ",
  "delivery_cooldown_seconds": 60,
  "response_timeout_ms": 3000
}
```

## Database changes

None — no local memo storage.

## Test plan

| Test area        | What it verifies                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| MemoServ relay   | Relays to NOTICE + DCC, ignores non-MemoServ, parses pending count, ignores channel notices, can be disabled           |
| `.memo` command  | All subcommands: status, help, read, list, del, send, info, unknown                                                    |
| Response capture | Buffers multi-line, delivers on timeout, rejects concurrent, doesn't relay captured to others, resets timeout per line |
| Join delivery    | Notifies admin with pending count, respects cooldown, ignores non-admin, no notification when count=0                  |
| DCC connect      | Shows pending count, silent when count=0                                                                               |

## Resolved decisions

1. **No local storage**: MemoServ is the source of truth. Bot is a proxy, not a mailbox.
2. **No public IRC commands**: This is an admin console feature only. No `!memo` in channel.
3. **No inter-admin notes**: Admins don't send memos to each other through the bot.
4. **Single `.memo` command**: Switch-case subcommands, not separate dot-commands.
5. **Response capture**: Temporary notice buffer with timeout-based delivery. One request at a time.
6. **Pending count**: Parsed from MemoServ's "You have N new memo(s)" notices. Used for join/connect notifications. Reset on `.memo read` or `.memo list`.
