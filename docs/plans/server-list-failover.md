# Plan: Server List with Failover Rotation

## Summary

Add support for multiple IRC servers per network with sequential failover rotation. When a connection fails or drops, the bot advances to the next server in the list instead of hammering the same one. Uses exponential backoff per full cycle through the list, and never gives up — a headless bot has no human to manually reconnect it.

This mirrors how Eggdrop, WeeChat, and irssi handle server lists: sequential rotation, wrap at end, back off on full cycles.

## Feasibility

- **Alignment**: Fully compatible with DESIGN.md — the connection layer is isolated in `bot.ts` and `connection-lifecycle.ts`. No architectural changes needed.
- **Dependencies**: All affected modules are built and tested.
- **Blockers**: None.
- **Complexity**: **M** (day) — config change + connection orchestration + lifecycle rework + tests.
- **Risk areas**:
  - irc-framework's internal reconnect fights with our own rotation. Must disable `auto_reconnect` and manage retries ourselves, or intercept the reconnect to swap server.
  - Per-server TLS/password differences need clean config design.
  - The `registered` log line currently hardcodes `cfg.host:cfg.port` — needs to reflect the active server.

## Dependencies

- [x] `src/core/connection-lifecycle.ts` — exists, handles reconnect state machine
- [x] `src/bot.ts` — exists, builds options and calls connect
- [x] `src/types.ts` — exists, defines IrcConfig

## Phases

### Phase 1: Config schema — add `servers` array

**Goal:** Extend IrcConfig to accept a server list while remaining backwards-compatible with the current single `host`/`port` format.

- [ ] Add `ServerEntry` interface to `src/types.ts`:
  ```typescript
  export interface ServerEntry {
    host: string;
    port: number;
    /** Override the top-level tls setting for this server. */
    tls?: boolean;
    /** Server-specific password (IRC PASS, not NickServ). */
    password?: string;
  }
  ```
- [ ] Add optional `servers?: ServerEntry[]` field to `IrcConfig`
- [ ] Update `config/bot.example.json` with a commented example showing the `servers` array alongside the existing single `host`/`port` (which remains the default/simple form)
- [ ] **Verification:** `pnpm test` passes (no runtime changes yet, just types)

### Phase 2: Server rotation state — new `ServerRotation` utility

**Goal:** Encapsulate server selection and backoff logic in a small, testable class. This is a pure state machine with no IRC dependencies.

- [ ] Create `src/utils/server-rotation.ts` with a `ServerRotation` class:
  ```typescript
  export class ServerRotation {
    constructor(servers: ServerEntry[]);
    /** Return the current server. */
    current(): ServerEntry;
    /** Advance to the next server. Returns true if the list wrapped (full cycle). */
    advance(): boolean;
    /** Calculate the backoff delay in ms for the current cycle. */
    getBackoffDelay(): number;
    /** Reset cycle count (called on successful registration). */
    resetBackoff(): void;
    /** Total server count. */
    get length(): number;
    /** Current index (for logging). */
    get index(): number;
  }
  ```
- [ ] Backoff algorithm: on each full cycle through the list, delay = `min(10_000 * 2^cycleCount, 600_000)` + jitter (0–5000ms). First pass through untried servers has no inter-server delay (try the next one immediately). This matches WeeChat's approach.
- [ ] Write unit tests in `tests/utils/server-rotation.test.ts`:
  - Sequential advancement wraps at end
  - `advance()` returns `true` only on wrap
  - Backoff grows exponentially per cycle, caps at 600s
  - `resetBackoff()` clears cycle count
  - Single-server list works (always returns the same server)
- [ ] **Verification:** `pnpm test -- tests/utils/server-rotation.test.ts`

### Phase 3: Wire rotation into bot.ts

**Goal:** Replace the single-server connection logic with rotation-aware connection.

- [ ] In `src/bot.ts` constructor, build the server list from config:
  - If `config.irc.servers` exists and is non-empty, use it
  - Otherwise, synthesize a single-entry list from `config.irc.host`/`port`/`tls`
  - Store a `ServerRotation` instance on the Bot
- [ ] Modify `buildClientOptions()` to accept a `ServerEntry` parameter instead of reading from `this.config.irc` directly. The method still reads nick/username/realname/channels/tls_verify/tls_cert/tls_key from `this.config.irc`, but takes host/port/tls from the provided entry.
- [ ] Modify `connect()`:
  - Get `rotation.current()` for the active server
  - Pass it to `buildClientOptions(server)`
  - Update the "Connecting to..." log to show the active server (with index: `[1/3]`)
- [ ] Update the startup banner in `printBanner()` to show all configured servers (or just the first + count)
- [ ] **Verification:** Bot starts and connects with existing single-server config (no `servers` array). `pnpm test` passes.

### Phase 4: Rotation on disconnect — rework connection lifecycle

**Goal:** When a connection fails, advance to the next server and retry. Never give up.

This is the core change. Currently irc-framework handles post-registration reconnects internally (its own `auto_reconnect`), and hexbot handles pre-registration retries via the `reconnect` callback. We need to unify both paths to use server rotation.

- [ ] **Disable irc-framework's built-in auto-reconnect**: set `auto_reconnect: false` in `buildClientOptions()`. We will manage all retry logic ourselves so we can swap servers between attempts.
- [ ] Add a `rotateServer` callback to `ConnectionLifecycleDeps`:
  ```typescript
  /** Advance to the next server and return the backoff delay in ms.
   *  Returns 0 if the next server should be tried immediately (not a full cycle wrap). */
  rotateServer: () => {
    server: ServerEntry;
    delay: number;
  };
  ```
- [ ] Rework the `close` handler in `connection-lifecycle.ts`:
  - **Pre-registration failure:** Call `rotateServer()`, log the next server, schedule reconnect after the returned delay. No retry limit — cycle forever.
  - **Post-registration disconnect (was `expectingReconnect`):** Same rotation logic. The `reconnecting` event from irc-framework no longer fires (we disabled auto_reconnect), so remove the `expectingReconnect` tracking.
  - **Remove `process.exit(1)`** — a bot should never give up. Log at error level on each full cycle wrap so the operator knows all servers failed.
- [ ] Update the `registered` handler to call `rotation.resetBackoff()` (via a new `onRegistered` callback or directly) and log the connected server.
- [ ] Remove the `startupAttempt` / `maxStartupRetries` tracking — replaced by the rotation's cycle-based backoff.
- [ ] In `bot.ts`, wire the new `rotateServer` dep:
  ```typescript
  rotateServer: () => {
    const wrapped = this.serverRotation.advance();
    const server = this.serverRotation.current();
    const delay = wrapped ? this.serverRotation.getBackoffDelay() : 0;
    return { server, delay };
  };
  ```
- [ ] The `reconnect` callback now needs to call `this.client.connect(this.buildClientOptions(server))` with the new server's options.
- [ ] **Verification:**
  - Unit tests: close before registration → rotates to next server
  - Unit tests: close after registration → rotates to next server
  - Unit tests: full cycle wrap → backoff delay applied
  - Unit tests: successful registration → backoff reset
  - Manual test: configure 2 servers (one invalid), verify bot tries the bad one, rotates to the good one, connects

### Phase 5: Update status command and logging

**Goal:** Expose the active server info through the bot's status mechanisms.

- [ ] Update `.status` command output (in `src/core/commands/irc-commands-admin.ts`) to show the active server and index (e.g., `Server: irc.rizon.net:6697 [2/3]`)
- [ ] Add the current server to the `bot:connected` event bus payload so plugins/botlink can see it
- [ ] **Verification:** `.status` shows the active server. `pnpm test` passes.

### Phase 6: Update existing tests

**Goal:** Fix any tests broken by the lifecycle rework and add comprehensive coverage.

- [ ] Update `tests/core/connection-lifecycle.test.ts`:
  - Remove/update tests that depend on `expectingReconnect` if that state is removed
  - Add tests for `rotateServer` callback invocation on close
  - Add tests for backoff delay passed through correctly
  - Add test: single-server config still works (rotation of 1 is a no-op)
- [ ] Update any `bot.ts` integration tests if they exist
- [ ] **Verification:** `pnpm test` — all tests pass, no regressions

## Config changes

### New format (optional `servers` array)

```json
{
  "irc": {
    "servers": [
      { "host": "irc.rizon.net", "port": 6697 },
      { "host": "irc2.rizon.net", "port": 6697 },
      { "host": "irc3.rizon.net", "port": 6697, "tls": false, "password": "serverpass" }
    ],
    "tls": true,
    "nick": "HexBot",
    "username": "hexbot",
    "realname": "HexBot IRC Bot",
    "channels": ["#hexbot"]
  }
}
```

### Backwards-compatible format (unchanged)

```json
{
  "irc": {
    "host": "irc.rizon.net",
    "port": 6697,
    "tls": true,
    "nick": "HexBot",
    ...
  }
}
```

When `servers` is absent, the bot synthesizes a single-entry list from `host`/`port`/`tls`. The `host` and `port` fields remain required in the type for backwards compatibility but are ignored when `servers` is present.

### Per-server overrides

Each `ServerEntry` can override `tls` and provide a server `password` (IRC PASS). All other settings (nick, username, channels, SASL, proxy) are shared across all servers — you're connecting to the same network, just different endpoints.

## Database changes

None.

## Test plan

| Test                               | File                                      | What it verifies                                             |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| ServerRotation sequential advance  | `tests/utils/server-rotation.test.ts`     | Index advances 0→1→2→0, `advance()` returns true on wrap     |
| ServerRotation backoff per cycle   | `tests/utils/server-rotation.test.ts`     | Delay grows 10s, 20s, 40s... caps at 600s. Jitter in range.  |
| ServerRotation reset on success    | `tests/utils/server-rotation.test.ts`     | `resetBackoff()` clears cycle count                          |
| ServerRotation single server       | `tests/utils/server-rotation.test.ts`     | List of 1 works, advance wraps immediately                   |
| Close before registration → rotate | `tests/core/connection-lifecycle.test.ts` | `rotateServer` called, reconnect scheduled                   |
| Close after registration → rotate  | `tests/core/connection-lifecycle.test.ts` | `rotateServer` called, reconnect scheduled (no process.exit) |
| Full cycle → backoff delay         | `tests/core/connection-lifecycle.test.ts` | Delay from `rotateServer` is respected                       |
| Successful registration → reset    | `tests/core/connection-lifecycle.test.ts` | Backoff counter reset after connect                          |
| Config fallback to host/port       | `tests/core/connection-lifecycle.test.ts` | Single host/port config works                                |

## Open questions

1. **Should `tls_verify`, `tls_cert`, `tls_key` be per-server overridable?** The current plan keeps them global (same network = same CA). CertFP (SASL EXTERNAL) uses the same cert everywhere. But if someone connects to two different networks via the same bot config... that's not a use case we support (one bot = one network).

2. **Should we keep `host`/`port` required in IrcConfig when `servers` is present?** Making them optional complicates the type (every reader needs `!` or guards). Keeping them required but documenting "ignored when `servers` is present" is simpler. The example config can show both forms.

3. **Connection timeout per server?** Eggdrop has `server-timeout` (60s). Currently irc-framework uses its own `ping_timeout` (120s) but that's for post-connection keepalive. We might want a shorter timeout for initial connection attempts (e.g., 30s) so we don't wait 2 minutes on a dead server before trying the next one. This could be a follow-up.
