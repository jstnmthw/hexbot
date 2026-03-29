# Plan: Bot Linking (Hub/Leaf Botnet)

## Summary

This feature implements bot-to-bot linking: a TCP link protocol where multiple HexBot instances connect to each other, share channel/user/permission state, relay privileged commands across the network, and form a hub-and-leaf topology. This is entirely separate from the existing DCC CHAT console feature.

---

## 1. Naming Decision

The word "botnet" has been used in two distinct senses in Eggdrop's tradition and in this codebase, and the collision causes confusion:

### What to call each feature

| Feature                                           | Current name in code                            | Correct name              | Rationale                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Human DCC CHAT admin sessions with shared console | "botnet" (in messages, comments, command names) | **console**               | A management-forward name that emphasises bot control over chat. The `.console` command lists connected admins. |
| Bot-to-bot TCP link protocol (this feature)       | not yet implemented                             | **bot link** / **botnet** | The bot-to-bot link network. Linked bots are "linked bots" or "bot links".                                      |

### Rename summary for existing code

The following strings in `src/core/dcc.ts` referred to the console incorrectly as "botnet" and have been renamed to "console":

- `*** Botnet: ${botnets}` → `*** Console: ${connected}` ✓
- `.botnet` command → `.console` (`.who` alias kept) ✓
- `Botnet (${list.length}):` → `Console (${list.length}):` ✓
- `has left the botnet` → `has left the console` ✓
- `has joined the botnet` → `has joined the console` ✓

`DESIGN.md`, `docs/DCC.md`, and `src/types.ts` have all been updated. **Phase 1 is complete.**

---

## Feasibility

- **Alignment**: Strong. DESIGN.md section 2.12 anticipates multiple transports feeding the same parser. The `CommandHandler` is transport-agnostic. Bot linking is listed as post-MVP scope.
- **Dependencies**: All present — `CommandHandler`, `Permissions`, `ChannelState`, `BotEventBus`, `DCCManager.announce()`, `sanitize()`, `net` module (Node built-in). No new npm dependencies.
- **Blockers**: None. The console rename in Phase 1 is cosmetic only and does not block Phase 2+.
- **Complexity**: L — the protocol and sync layers are new; command relay adds moderate complexity; integration with existing modules is well-defined.
- **Risk areas**:
  - Permission sync conflict if a leaf mutates its own DB independently — mitigated by hub-authoritative design.
  - `ChannelState` not designed for synthetic event injection — needs new public method.
  - Reconnect logic must avoid thundering-herd if many leaves reconnect simultaneously after hub restart.
  - SHA-256 password hashing is not replay-resistant — document that the link should be on a private network.

---

## Dependencies

- [x] `CommandHandler` — exists, transport-agnostic
- [x] `Permissions.addUser/removeUser/setGlobalFlags/addHostmask` — exist
- [x] `ChannelState` — exists (needs `injectEvent` public method added)
- [x] `BotEventBus` — exists (needs new event types)
- [x] `DCCManager.announce()` — exists
- [x] `sanitize()` — exists at `src/utils/sanitize.ts`
- [x] `net` module — Node built-in

---

## Phases

### Phase 1: Rename console references ✅ Complete

**Goal:** Clean up the "botnet" naming before adding the real botnet feature so there is no confusion.

- [x] `src/core/dcc.ts` — rename `.botnet` command to `.console`; update all user-visible strings from "botnet" to "console"
- [x] `src/types.ts` — update `DccConfig` JSDoc comment from "DCC CHAT / botnet settings" to "DCC CHAT / console settings"
- [x] `DESIGN.md` — replace all "botnet" in console context
- [x] `docs/DCC.md` — replace all "botnet" occurrences with "console"
- [x] `docs/plans/dcc-botnet.md` — update decision #3 to point to this plan
- [x] **Verify**: `pnpm exec tsc --noEmit` passes; existing DCC tests still pass.

---

### Phase 2: Type system additions

**Goal:** Extend the type system to support bot linking without breaking existing compilation.

- [ ] `src/types.ts` — add `BotlinkConfig` interface (see Config Changes section)
- [ ] `src/types.ts` — add `botlink?: BotlinkConfig` to `BotConfig`
- [ ] `src/event-bus.ts` — add new event types: `botlink:connected`, `botlink:disconnected`, `botlink:syncComplete`, `user:removed`, `user:flagsChanged`, `user:hostmaskAdded`, `user:hostmaskRemoved`
- [ ] `src/command-handler.ts` — add `'botlink'` to `CommandContext.source` union type
- [ ] `config/bot.example.json` — add disabled `botlink` block (see Config Changes section)
- [ ] **Verify**: `pnpm exec tsc --noEmit` passes clean.

---

### Phase 3: `src/core/botlink.ts` — protocol layer

**Goal:** Frame serialization, connection management, handshake — no state sync yet.

Three classes in one file, following the `DCCManager`/`DCCSession` pattern from `src/core/dcc.ts`:

**`BotLinkProtocol`** (internal socket wrapper)

- [ ] Wraps `net.Socket` with `readline` line framing
- [ ] Serializes/deserializes JSON frames; enforces 64 KB max frame size
- [ ] Strips `\r`/`\n` from all string fields via `sanitize()`
- [ ] Emits typed events: `message`, `close`, `error`

**`BotLinkHub`** (hub role)

- [ ] `listen(port, host)` — starts `net.Server`
- [ ] Accepts connections, runs four-step handshake (see Protocol Design)
- [ ] Authenticates password (`sha256:<hex>` format; never logged)
- [ ] Maintains `Map<string, BotLinkLeafConnection>` keyed by botname
- [ ] On auth success: broadcasts `BOTJOIN`, initiates state sync (Phase 4)
- [ ] Fan-out: frame from one leaf forwarded to all other leaves
- [ ] `close()` — tears down all leaf connections and server
- [ ] Rate-limit `CMD` frames: max 10/sec per leaf

**`BotLinkLeaf`** (leaf role)

- [ ] Connects to hub; sends `HELLO`, waits for `WELCOME` or `ERROR`
- [ ] Reconnect with exponential backoff (`reconnect_delay_ms` → `reconnect_max_delay_ms`)
- [ ] Exposes `sendCommand(cmd, args, fromHandle, channel)` for command relay (Phase 5)
- [ ] `disconnect()` — closes socket, cancels reconnect timer

- [ ] **Verify**: `tests/core/botlink.test.ts` — handshake success, auth failure, frame size limit, reconnect logic.

---

### Phase 4: `src/core/botlink-sync.ts` — state synchronization

**Goal:** Channel state and permission sync frames.

- [ ] `src/core/channel-state.ts` — add `injectEvent(event: string, data: Record<string, unknown>): void` public method (or typed `processJoin`, `processPart`, `processMode` methods)
- [ ] `src/core/botlink-sync.ts` — `ChannelStateSyncer.buildSyncFrames(channelState)` → `LinkFrame[]`
- [ ] `src/core/botlink-sync.ts` — `ChannelStateSyncer.applyFrame(frame, channelState)`
- [ ] `src/core/botlink-sync.ts` — `PermissionSyncer.buildSyncFrames(permissions)` → `LinkFrame[]`
- [ ] `src/core/botlink-sync.ts` — `PermissionSyncer.applyFrame(frame, permissions)`
- [ ] `src/core/botlink.ts` — implement `SYNC_START`/`SYNC_END` sequence in hub and leaf
- [ ] **Verify**: sync serialization roundtrip tests; permission sync tests; `pnpm exec tsc --noEmit` clean.

---

### Phase 5: Command relay

**Goal:** Permission commands on a leaf are relayed to the hub for execution.

- [ ] `src/command-handler.ts` — add `relayToHub?: boolean` to `CommandOptions`
- [ ] `src/core/commands/permission-commands.ts` — mark `.adduser`, `.deluser`, `.flags`, `.addhost`, `.delhost` with `relayToHub: true`
- [ ] `src/core/botlink.ts` — leaf: intercepts `relayToHub` commands, sends `CMD` frame, waits for `CMD_RESULT`, displays output to originating session
- [ ] `src/core/botlink.ts` — hub: receives `CMD` frame, validates `fromHandle` flags against hub's own `Permissions`, executes via `CommandHandler`, sends `CMD_RESULT` back to originating leaf
- [ ] `src/core/permissions.ts` — emit `BotEventBus` events (`user:added`, `user:removed`, `user:flagsChanged`, etc.) after each mutation
- [ ] `src/core/botlink.ts` — hub: subscribe to `user:*` events on eventBus; broadcast `ADDUSER`/`DELUSER`/`SETFLAGS` frames to all leaves after successful permission command
- [ ] **Verify**: leaf `.adduser` test — user appears in both hub and leaf `.users` after relay; permission denial test.

---

### Phase 6: Bot.ts wiring and botlink commands

**Goal:** Wire botlink into the bot lifecycle; register admin commands.

- [ ] `src/bot.ts` — `private _botLinkHub: BotLinkHub | null = null` and `private _botLinkLeaf: BotLinkLeaf | null = null` with public getters
- [ ] `src/bot.ts` — in `start()`, after `dccManager` setup: instantiate and start the appropriate role based on `config.botlink.role`
- [ ] `src/bot.ts` — in `shutdown()`: call `hub.close()` or `leaf.disconnect()` before bridge detach
- [ ] `src/core/commands/botlink-commands.ts` — implement commands (see table below)
- [ ] `src/bot.ts` — register `BotlinkCommands` alongside other command modules
- [ ] **Verify**: bot starts with `botlink.enabled: false` — no behaviour change. Hub starts and accepts leaf connection in integration smoke test.

**Botlink commands:**

| Command                                 | Flags | Description                                              |
| --------------------------------------- | ----- | -------------------------------------------------------- |
| `.botlink status`                       | `m`   | Show hub/leaf connection status and linked bot list      |
| `.botlink disconnect <botname>`         | `n`   | (Hub only) Disconnect a specific leaf                    |
| `.botlink reconnect`                    | `m`   | (Leaf only) Force reconnect to hub                       |
| `.bsay <botname\|*> <target> <message>` | `m`   | Send a message via another (or all) linked bots          |
| `.bannounce <message>`                  | `m`   | Broadcast to all console sessions across all linked bots |

---

### Phase 7: Documentation

- [ ] `docs/BOTLINK.md` — user-facing guide: prerequisites, hub setup, leaf setup, firewall rules, admin commands, troubleshooting
- [ ] `DESIGN.md` — add section 2.16 (Bot Linking): topology, protocol, sync strategy, command relay rules
- [ ] `docs/plans/dcc-botnet.md` — update decision #3 to link here
- [ ] `CHANGELOG.md` — entry under `### Added`

---

## Protocol Design

### Transport

Plain TCP, line-oriented (`\r\n` terminators), JSON-framed. Maximum frame size: 64 KB. Frames exceeding this are treated as protocol errors and the link is dropped.

### Handshake

```
Hub listens on TCP port (e.g. 5051)
Leaf connects

Leaf → Hub:  {"type":"HELLO","botname":"leaf1","password":"sha256:<hex>","version":"0.1.0"}
Hub  → Leaf: {"type":"WELCOME","botname":"hub","version":"0.1.0"}   (success)
          or {"type":"ERROR","code":"AUTH_FAILED","message":"bad password"}

Hub  → Leaf: {"type":"SYNC_START"}
Hub  → Leaf: [CHAN frames, ADDUSER frames, ...]
Hub  → Leaf: {"type":"SYNC_END"}

Link enters steady state: bidirectional event and command relay
```

Password is transmitted as `sha256:<hex-of-shared-secret>`. The `password` field is **never logged** — mask as `[REDACTED]` in any debug output.

Handshake timeout: 30 seconds. If `HELLO` is not received within 30 seconds, close the socket.

### Message Types (steady state)

```typescript
// Heartbeat
{ type: 'PING', seq: number }
{ type: 'PONG', seq: number }

// Channel state
{ type: 'CHAN', channel: string, topic: string, modes: string, users: UserSyncRecord[] }
{ type: 'JOIN', channel: string, nick: string, ident: string, hostname: string }
{ type: 'PART', channel: string, nick: string, reason: string }
{ type: 'QUIT', nick: string, reason: string }
{ type: 'NICK', oldNick: string, newNick: string }
{ type: 'MODE', channel: string, modes: string, params: string[] }
{ type: 'KICK', channel: string, nick: string, by: string, reason: string }
{ type: 'TOPIC', channel: string, topic: string, by: string }

// Ban list
{ type: 'BAN', channel: string, mask: string, setBy: string, setAt: number }
{ type: 'UNBAN', channel: string, mask: string }

// Permissions
{ type: 'ADDUSER', handle: string, hostmasks: string[], globalFlags: string, channelFlags: Record<string,string> }
{ type: 'DELUSER', handle: string }
{ type: 'SETFLAGS', handle: string, globalFlags: string, channelFlags: Record<string,string> }

// Command relay
{ type: 'CMD', command: string, args: string, fromHandle: string, fromBot: string, channel: string | null }
{ type: 'CMD_RESULT', ref: string, output: string[] }

// Bot presence
{ type: 'BOTJOIN', botname: string }
{ type: 'BOTPART', botname: string, reason: string }

// Party line relay
{ type: 'ANNOUNCE', message: string, fromBot: string }

// Error
{ type: 'ERROR', code: string, message: string }
```

---

## Config Changes

New optional section in `config/bot.json`:

```json
"botlink": {
  "enabled": false,
  "role": "leaf",
  "botname": "leaf1",
  "hub": {
    "host": "192.168.1.10",
    "port": 5051
  },
  "listen": {
    "host": "0.0.0.0",
    "port": 5051
  },
  "password": "changeme-shared-secret",
  "reconnect_delay_ms": 5000,
  "reconnect_max_delay_ms": 60000,
  "max_leaves": 10,
  "sync_permissions": true,
  "sync_channel_state": true,
  "ping_interval_ms": 30000,
  "link_timeout_ms": 90000
}
```

| Key                      | Type                | Role | Description                                                   |
| ------------------------ | ------------------- | ---- | ------------------------------------------------------------- |
| `enabled`                | boolean             | both | Enable bot linking. Default: `false`                          |
| `role`                   | `"hub"` \| `"leaf"` | both | This bot's role in the network                                |
| `botname`                | string              | both | Unique name for this bot on the link network (not IRC nick)   |
| `hub.host`               | string              | leaf | Hub's hostname/IP to connect to                               |
| `hub.port`               | number              | leaf | Hub's TCP port                                                |
| `listen.host`            | string              | hub  | Interface to listen on                                        |
| `listen.port`            | number              | hub  | Port to listen on                                             |
| `password`               | string              | both | Shared secret for link auth (same value on all bots)          |
| `reconnect_delay_ms`     | number              | leaf | Initial reconnect delay. Default: 5000                        |
| `reconnect_max_delay_ms` | number              | leaf | Max reconnect delay (exponential backoff cap). Default: 60000 |
| `max_leaves`             | number              | hub  | Maximum concurrent leaf connections. Default: 10              |
| `sync_permissions`       | boolean             | both | Sync user permissions over the link. Default: true            |
| `sync_channel_state`     | boolean             | both | Sync channel user lists over the link. Default: true          |
| `ping_interval_ms`       | number              | both | Heartbeat interval. Default: 30000                            |
| `link_timeout_ms`        | number              | both | Drop link if no message received in this time. Default: 90000 |

New `BotlinkConfig` interface in `src/types.ts`:

```typescript
interface BotlinkConfig {
  enabled: boolean;
  role: 'hub' | 'leaf';
  botname: string;
  hub?: { host: string; port: number };
  listen?: { host: string; port: number };
  password: string;
  reconnect_delay_ms?: number;
  reconnect_max_delay_ms?: number;
  max_leaves?: number;
  sync_permissions?: boolean;
  sync_channel_state?: boolean;
  ping_interval_ms?: number;
  link_timeout_ms?: number;
}
```

---

## Database Changes

None. Bot link sessions and topology are ephemeral (in-memory only). Permission changes that arrive via link sync are persisted to the local bot's existing SQLite DB via the normal `Permissions` API — no schema changes needed.

---

## Security Considerations

1. **Password never logged** — the `HELLO` frame's `password` field must be masked as `[REDACTED]` in all debug output.
2. **Input validation from link** — all string fields from link frames must be sanitized with `sanitize()` before use; nick/ident/hostname validated against IRC character sets before injecting into `ChannelState`.
3. **Hub re-checks permissions** — `CMD` relay uses `fromHandle` to look up flags in the hub's own database; a compromised leaf cannot spoof elevated permissions.
4. **DoS mitigations** — 64 KB frame limit; 30s handshake timeout; 10 CMD/sec rate limit per leaf; `max_leaves` cap.
5. **TLS future** — initial implementation is plaintext TCP; document that the link should be on a private network or VPN. A future `botlink.tls: true` option can use `tls.connect()`/`tls.createServer()`.
6. **SHA-256 password** — not replay-resistant; document. A future improvement is HMAC challenge-response.
7. **File permissions** — `config/bot.json` must be `chmod 600`; the existing world-readable check in `bot.ts` already warns on this.

---

## Test Plan

**Unit tests** (`tests/core/botlink.test.ts`):

- [ ] `BotLinkProtocol`: frame serialization roundtrip, oversized frame rejected, `\r\n` stripped from string fields
- [ ] Handshake: valid password accepted, wrong password → `ERROR` frame, handshake timeout fires at 30s
- [ ] Hub fan-out: frame from leaf1 forwarded to leaf2 and leaf3 but not back to leaf1
- [ ] Leaf reconnect: failure triggers retry after delay; succeeds on second attempt
- [ ] `ChannelStateSyncer`: `buildSyncFrames` → `applyFrame` roundtrip without data loss
- [ ] `PermissionSyncer`: `buildSyncFrames` → `applyFrame` roundtrip; `SETFLAGS` overrides; `DELUSER` removes user

**Integration tests** (mock TCP sockets):

- [ ] Full handshake between mock hub and mock leaf over loopback
- [ ] Sync complete: hub sends `CHAN` + `ADDUSER` frames, leaf's `ChannelState` and `Permissions` populated
- [ ] Command relay: leaf sends `.adduser`, hub executes, both have the user after `CMD_RESULT`
- [ ] Announce relay: hub's `DCCManager.announce()` called on `ANNOUNCE` frame receipt
- [ ] Idle timeout: no ping → link dropped after `link_timeout_ms`

---

## Open Questions

1. **Ban enforcement across bots**: The plan syncs ban awareness but not enforcement. Should a future plugin (`chanmod`?) automatically mirror bans to all linked bots' channels? Or keep it purely informational for now?
2. **Hub chaining**: Should the hub also be able to connect to another hub (forming a chain of hubs)? Deferred for now — hub-and-leaf covers the primary use case.
3. **NickServ verification for relayed commands**: Should the hub require NickServ ACC verification for the originating handle before executing a relayed command? Or is the shared-secret link authentication sufficient?
4. **Channel state scope**: Should leaves receive sync frames for channels the leaf-bot is not in? (Eggdrop does send this.) Useful for global ban lists; noisy for large networks. Default: sync all channels the hub knows about.

---

## Decisions

1. **Hub-and-leaf only, no mesh** — avoids cycle-detection complexity. Future improvement can add hub chaining.
2. **JSON framing over custom binary** — development simplicity and debuggability over marginal performance improvement.
3. **Hub is authoritative for permissions** — prevents split-brain. Leaves relay permission commands to hub; hub executes and rebroadcasts.
4. **No automatic cross-bot ban enforcement** — link layer syncs awareness only. A plugin handles enforcement. Keeps link scope clean.
5. **Plaintext TCP initially, TLS later** — avoids certificate management complexity. Document: use on private network or VPN.
6. **No leaf-to-leaf direct connections** — all traffic routes through hub. Simpler topology.
7. **Console announce relay** — `ANNOUNCE` frames carry console messages across bots; receiving bot calls `DCCManager.announce()`. Keeps the shared admin session feel across linked bots.
8. **`.botnet` → `.console` rename** — completed in Phase 1 before any bot-link code lands, so the two features are never confused in the codebase.
