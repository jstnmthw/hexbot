# Plan: Phase 3 — Bot Core + IRC Connection + REPL

## Summary
Wire up `irc-framework`, bridge IRC events to the dispatcher, implement the REPL, and get the bot connecting to a real IRC server. This is the first phase where the bot actually comes alive. At the end, the bot connects, joins channels, responds to admin commands via IRC and the REPL, and you can see it in your IRC client.

## Dependencies
- [x] Phase 0 complete (scaffolding)
- [x] Phase 1 complete (database + dispatcher)
- [x] Phase 2 complete (permissions + command handler)

---

## Phase 3A: Internal event bus

**Goal:** A typed EventEmitter for internal bot events (separate from IRC dispatcher).

- [ ] Create `src/event-bus.ts`:
  - Export a typed `EventEmitter` using a `BotEvents` interface (no wrapper class needed — use TypeScript's typed EventEmitter pattern)
  - Event names: `bot:connected`, `bot:disconnected`, `bot:error`, `plugin:loaded`, `plugin:unloaded`, `plugin:reloaded`, `mod:op`, `mod:kick`, `mod:ban`, `user:identified`
  - The bot instantiates one and passes it to modules that need it
- [ ] No tests needed for this — it's a typed emitter. Will be tested through integration.

## Phase 3B: IRC bridge

**Goal:** Translate irc-framework events into dispatcher events. This is the adapter layer between the IRC library and the bind system.

- [ ] Create `src/irc-bridge.ts` implementing the `IRCBridge` class:
  - Constructor takes `{ client, dispatcher, eventBus, botNick }`
  - `attach()` — register all irc-framework event listeners:
    - `message` → parse into pub/pubm or msg/msgm, build `HandlerContext`, dispatch both
    - `join` → dispatch join
    - `part` → dispatch part
    - `kick` → dispatch kick
    - `nick` → dispatch nick
    - `mode` → dispatch mode (break compound modes into individual dispatches)
    - `raw` → dispatch raw
    - `notice` → dispatch notice
    - `ctcp request` → dispatch ctcp
  - `detach()` — remove all listeners (for clean shutdown)
  - Each event handler builds a proper `HandlerContext` from irc-framework's event data
  - This module owns the translation logic and nothing else
  - **Security:** See `docs/SECURITY.md` section 2. The bridge is the trust boundary — all IRC data entering the dispatcher passes through here. Key rules:
    - Strip `\r` and `\n` from all text fields when building `HandlerContext`
    - Strip IRC formatting/control characters from command text before parsing
    - The `reply()` function in `HandlerContext` must use `api.say()` / `api.notice()`, never `raw()`
    - Validate that channel names match expected patterns (start with `#` or `&`)

## Phase 3C: Bot class

**Goal:** Thin orchestrator that wires modules together. The Bot creates and connects the pieces but delegates all real work.

- [ ] Create `src/bot.ts` implementing the `Bot` class:
  - Constructor takes config path (default `./config/bot.json`)
  - `async start()`:
    1. Load and validate config from JSON file
    2. Open database
    3. Initialize permissions, load from DB
    4. Create event dispatcher (pass permissions)
    5. Create command handler (pass dispatcher, permissions)
    6. Connect to IRC via `_connect()`
    7. Create IRCBridge, call `bridge.attach()`
    8. Each module registers its own commands (see Phase 2B changes)
    9. (Plugin loader comes in Phase 4 — skip for now)
  - `_connect()`:
    - Create `irc-framework` Client
    - Configure from `config.irc`: host, port, tls, nick, username, realname
    - Configure SASL if `config.services.sasl` is true
    - Set up auto-reconnect
    - On `registered`: join configured channels, emit `bot:connected`
    - Return a promise that resolves on successful connect
  - `async shutdown()`: bridge.detach(), disconnect, close database
  - Expose `client`, `dispatcher`, `permissions`, `db`, `commandHandler`, `config`, `eventBus` as readonly properties

- [ ] Handle config file not found: print helpful error message and exit
- [ ] Handle config file invalid JSON: print parse error with line number and exit
- [ ] Handle IRC connection failure: log error, retry based on auto-reconnect settings

## Phase 3D: REPL

**Goal:** Interactive terminal REPL when started with `--repl` flag.

- [ ] Create `src/repl.ts` implementing the `BotREPL` class:
  - Constructor takes the `Bot` instance
  - `start()`:
    - Create readline interface on stdin/stdout
    - Set prompt to `n0xb0t> `
    - On each line: pass to `bot.commandHandler.execute(line, { source: 'repl', reply: console.log })`
    - Handle special REPL-only commands:
      - `.quit` or `.exit` — graceful shutdown
      - `.clear` — clear terminal
    - Display bot log output between prompts (don't clobber the prompt line)
  - `stop()` — close readline interface

## Phase 3E: Entry point

**Goal:** Wire everything together in `src/index.ts`.

- [ ] Update `src/index.ts`:
  - Parse command-line args: `--repl`, `--config <path>`
  - Create Bot instance
  - Call `bot.start()`
  - If `--repl` flag: create BotREPL, call `repl.start()`
  - Handle SIGINT/SIGTERM: call `bot.shutdown()`, exit cleanly
  - Handle uncaught exceptions: log and exit
  - Handle unhandled promise rejections: log and exit

## Phase 3F: Manual verification

This phase requires a real IRC connection. Either:
- Connect to Libera Chat (public, free)
- Run a local ngIRCd/InspIRCd instance
- Use any IRC network you have access to

- [ ] Create `config/bot.json` from the example (fill in real server details)
- [ ] Start the bot: `pnpm run dev` (starts with REPL)
- [ ] Verify: bot connects and joins the configured channel
- [ ] Verify: bot appears in the channel in your IRC client
- [ ] Verify: typing `.status` in the REPL shows bot info
- [ ] Verify: typing `.help` in the REPL lists available commands
- [ ] Verify: typing `.adduser testuser *!*@some.host ov` in the REPL adds a user
- [ ] Verify: typing `.users` in the REPL shows the added user
- [ ] Verify: typing `.say #channel Hello from REPL!` in the REPL sends a message to the channel
- [ ] Verify: typing `.help` in the IRC channel (as a message) — bot responds (if your hostmask matches an `+n` user)
- [ ] Verify: Ctrl+C triggers graceful shutdown (bot sends QUIT, database closes)
- [ ] Verify: bot reconnects automatically if you kill the IRC connection

## Phase 3G: Automated tests (where possible)

- [ ] Create `tests/helpers/mock-irc.ts`:
  - Mock irc-framework Client that captures outgoing messages
  - Can simulate incoming events
  - Tracks join/part/mode/say calls
- [ ] Create `tests/helpers/mock-bot.ts`:
  - Creates a Bot-like object with real dispatcher, real permissions, real database (temp file), real command handler
  - Uses mock IRC client instead of real connection
  - Returns `{ bot, messages, events }` for assertions
- [ ] Create `tests/irc-bridge.test.ts`:
  - Test that IRC message events are correctly bridged to dispatcher pub/pubm
  - Test that private messages are bridged to msg/msgm
  - Test that join/part/kick events are dispatched
  - Test that HandlerContext is built correctly from irc-framework event data
- [ ] Create `tests/bot.test.ts`:
  - Test that admin commands via IRC route through command handler
  - Test that `.say` sends a message via the IRC client
  - Test startup sequence creates all modules
  - Test shutdown cleans up bridge, database, connection
- [ ] **Verify:** `pnpm test` — all tests pass (Phase 1 + 2 + 3)

---

## Verification

**This phase is complete when:**
1. `pnpm run dev` starts the bot, connects to IRC, joins channels, and presents the REPL
2. REPL commands (`.help`, `.status`, `.adduser`, `.users`, `.say`) work
3. IRC admin commands work when sent by a user with matching hostmask and `+n` flags
4. Bot reconnects automatically after disconnection
5. Ctrl+C triggers graceful shutdown
6. `pnpm test` — all automated tests pass
7. Mock helpers (`mock-irc.ts`, `mock-bot.ts`) are working and usable by future phases

## Next phase
Phase 4: Plugin Loader + Example Plugins
