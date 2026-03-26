# Plan: DCC CHAT + Console

## Summary

Users with sufficient flags (default `+m`) can `/dcc chat hexbot` from their IRC client to open a persistent admin session. The bot accepts via **passive DCC** — it opens a TCP port, sends the user a CTCP token, and the user's client connects in. Once connected the user sees a banner, gets a `.`-prefixed command prompt routed through the existing `CommandHandler` with their real permission flags, and joins the **console**: a shared session where all connected DCC users can manage the bot and chat in real time. This uses Node's `net` module for the TCP layer and the existing dispatcher for CTCP intercept.

---

## Feasibility

- **Alignment**: Strong. DESIGN.md section 2.12 explicitly anticipates _"a future socket server (Option B) would feed it socket data — same parser, multiple transports"_. The `CommandHandler` is already transport-agnostic. DCC is listed as post-MVP scope (section 4.2).
- **Dependencies**: All present — `CommandHandler`, `Permissions`, `Services`, `dispatcher`, `IRCClient` (CTCP), `net` module (Node built-in).
- **Blockers**: None. The CTCP `DCC` event already flows through the dispatcher; the `ctcp` plugin plugin already demonstrates binding to CTCP events.
- **Complexity**: M — the TCP/DCC plumbing is new but straightforward; the command routing integration is minimal.
- **Risk areas**:
  - Passive DCC token format varies slightly between IRC clients (irssi, WeeChat, HexChat, mIRC all support it but with minor quirks).
  - IP encoding: DCC requires the IPv4 address as a 32-bit unsigned decimal integer.
  - Port exhaustion if `port_range` is too small and sessions linger.
  - Socket half-open detection (idle timeout handles this).

---

## Dependencies

- [x] `CommandHandler` — exists, transport-agnostic
- [x] `Permissions.findByHostmask()` — exists
- [x] `Services.verifyUser()` — exists
- [x] CTCP dispatcher events — exist (`ctcp` bind type, `command: 'DCC'`)
- [x] `bot.ts` wiring pattern — established (REPL model)

---

## Phases

### Phase 1: Config types and CommandHandler update

**Goal:** Add `DccConfig` to the type system and make `CommandHandler` aware of the `'dcc'` source so DCC sessions get real flag checking (not the REPL's implicit owner bypass).

- [x] `src/types.ts` — Add `DccConfig` interface
- [x] `src/types.ts` — Add `dcc?: DccConfig` to `BotConfig`
- [x] `src/command-handler.ts` — Add `'dcc'` to `CommandContext.source` union type: `'repl' | 'irc' | 'dcc'`
- [x] `src/command-handler.ts` — Flag checks skip only for `source === 'repl'`; `'dcc'` gets real flag enforcement (no code change needed — verified).
- [x] `config/bot.example.json` — Add disabled `dcc` block
- [x] **Verify**: `pnpm exec tsc --noEmit` passes clean.

---

### Phase 2: `src/core/dcc.ts` — DCCManager and DCCSession

**Goal:** The complete DCC implementation as a single core module. Two classes: `DCCManager` (lifecycle, CTCP handling, port allocation, console broadcast) and `DCCSession` (per-connection readline loop, command routing, idle timer).

#### 2a: Helpers and types (top of file)

- [x] `src/core/dcc.ts` — `DCCSession` class with all required fields
- [x] Helper: `ipToDecimal(ip: string): number` — exported for testability
- [x] Helper: `parseDccChatPayload(args: string)` — exported for testability
- [x] Helper: `isPassiveDcc(ip: number, port: number): boolean` — exported for testability

#### 2b: `DCCManager` class

- [x] Constructor accepts: `{ client, dispatcher, permissions, services, commandHandler, config, version, logger }`
- [x] `private sessions: Map<string, DCCSession>` keyed by `nick.toLowerCase()`
- [x] `private allocatedPorts: Set<number>` — ports currently in use (pending or active)
- [x] `attach()` — binds `ctcp` event for mask `DCC` on the dispatcher under tag `'core:dcc'`
- [x] `detach()` — `dispatcher.unbindAll('core:dcc')`, then calls `closeAll()`
- [x] `private async onDccCtcp(ctx: HandlerContext)` — validates passive, hostmask, flags, sessions, NickServ; allocates port; opens net.Server; sends CTCP token; 30s accept timeout
- [x] `private openSession(user, ctx, socket)` — creates `DCCSession`, adds to sessions, announces join
- [x] `broadcast(fromHandle, message)` — sends to all sessions except sender
- [x] `announce(message)` — sends to all sessions
- [x] `getSessionList()` — returns array for `.console` command
- [x] `private allocatePort(): number | null`
- [x] `closeAll(reason?)` — calls `session.close()` on all sessions

#### 2c: `DCCSession` class

- [x] Constructor with all required fields
- [x] `start()` — readline interface, banner, idle timer, line/close/error handlers
- [x] `private onLine(line)` — idle reset, .quit/.exit, .console/.who, command routing, console broadcast, prompt
- [x] `writeLine(line)` — writes `line + '\r\n'`; no-op if socket destroyed
- [x] `private resetIdle()` — clears and restarts idle timer
- [x] `close(reason?)` — clears timer, destroys socket, removes from sessions, announces leave

**Verify Phase 2**: TypeScript compiles clean. Unit-testable helpers exercised directly. ✓

---

### Phase 3: Wire into `bot.ts`

**Goal:** `DCCManager` starts after connect (if enabled) and shuts down cleanly.

- [x] `src/bot.ts` — Import `DCCManager` from `./core/dcc.js`
- [x] `src/bot.ts` — `private _dccManager: DCCManager | null` with public `dccManager` getter
- [x] `src/bot.ts` — In `start()`, after `this.bridge.attach()`: create and attach DCCManager if enabled
- [x] `src/bot.ts` — In `shutdown()`: detach and null DCCManager before bridge detach
- [x] `.botnet` / `.who` are **DCC-only** — handled in `DCCSession.onLine()` before `CommandHandler`
- [x] **Verify**: Bot starts with `dcc.enabled: false` — no behaviour change. ✓

---

### Phase 4: REPL botnet integration

**Goal:** When the REPL runs a command, the botnet sees a brief activity announcement.

- [x] `src/bot.ts` — `dccManager` exposed as readonly getter
- [x] `src/repl.ts` — after executing a command: `bot.dccManager?.announce(`\*\*\* REPL: ${trimmed}`)`
- [x] **Verify**: DCC-connected user sees REPL commands in their session. ✓

---

### Phase 5: Documentation

- [x] `docs/DCC.md` — User-facing guide: firewall setup, client instructions (irssi/WeeChat/HexChat/mIRC), session interface, security notes
- [x] `CHANGELOG.md` — Entry added under `### Added`
- [x] `DESIGN.md` — Section 2.15 added (DCC/Botnet), section 2.12 updated (CLI/REPL), section 2.9 updated (halfop), section 4.2 updated (DCC removed from not-in-MVP)

---

## Config changes

New optional section in `config/bot.json`:

```json
"dcc": {
  "enabled": true,
  "ip": "203.0.113.42",
  "port_range": [50000, 50010],
  "require_flags": "m",
  "max_sessions": 5,
  "idle_timeout_ms": 300000,
  "nickserv_verify": false
}
```

| Key               | Type             | Default  | Description                                        |
| ----------------- | ---------------- | -------- | -------------------------------------------------- |
| `enabled`         | boolean          | `false`  | Enable DCC CHAT                                    |
| `ip`              | string           | —        | Bot's public IPv4 address (required if enabled)    |
| `port_range`      | [number, number] | —        | Port range for passive DCC listeners (required)    |
| `require_flags`   | string           | `"m"`    | Minimum flags to connect (`m` = master)            |
| `max_sessions`    | number           | `5`      | Maximum concurrent DCC sessions                    |
| `idle_timeout_ms` | number           | `300000` | Idle timeout in ms before disconnecting (5 min)    |
| `nickserv_verify` | boolean          | `false`  | Require NickServ ACC verification before accepting |

---

## Database changes

None. DCC sessions are ephemeral (in-memory only). No persistence required.

---

## Test plan

**Unit tests** (`tests/core/dcc.test.ts`) — all passing:

- [x] `ipToDecimal('1.2.3.4')` → `16909060`
- [x] `ipToDecimal('0.0.0.0')` → `0`
- [x] `parseDccChatPayload('CHAT chat 0 0 12345')` → `{ subtype: 'CHAT', ip: 0, port: 0, token: 12345 }`
- [x] `parseDccChatPayload('CHAT chat 16909060 50000')` → `{ subtype: 'CHAT', ip: 16909060, port: 50000, token: 0 }`
- [x] `parseDccChatPayload('FILE foo.txt 0 0')` → `null` (not CHAT)
- [x] `parseDccChatPayload('')` → `null`
- [x] `isPassiveDcc(0, 0)` → `true`
- [x] `isPassiveDcc(16909060, 50000)` → `false`
- [x] Port allocation: allocate all ports in range → returns `null` when exhausted
- [x] Session rejection when `max_sessions` reached
- [x] `broadcast()` sends to all sessions except sender
- [x] `announce()` sends to all sessions

**Integration tests** (mock TCP socket) — deferred; DCCManager unit tests cover the validation paths:

- [ ] Connect to DCCManager: verify banner lines, prompt sent
- [ ] Send `.help`: verify reply lines written to socket
- [ ] Send plain text: verify `manager.broadcast()` called
- [ ] Send `.quit`: verify socket destroyed, session removed from map, announce sent
- [ ] Idle timeout: advance fake timers → verify socket destroyed

---

## Decisions

1. **`.console` / `.who` scope**: DCC-only. Handled inside `DCCSession` before CommandHandler routing. Not registered on `CommandHandler` — the REPL is a development convenience, not a production admin interface; DCC is the real remote session.
2. **IPv6**: Out of scope. IPv4-only (decimal integer encoding). IPv6 passive DCC uses a hex string format and can be a follow-up.
3. **Bot-to-bot linking**: Not in scope. See `docs/plans/bot-linking.md` for the full Eggdrop-style hub/leaf botnet plan.
4. **Port forwarding docs**: Include a firewall callout in `docs/DCC.md` (`ufw allow 50000:50010/tcp`).
