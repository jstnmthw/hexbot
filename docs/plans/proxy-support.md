# Plan: Proxy Support

## Summary

Add configurable proxy support so hexbot can tunnel its IRC connection through
a SOCKS5 (or SOCKS4) proxy. Common use cases: Tor hidden services, SSH dynamic
tunnels (`ssh -D`), corporate firewall traversal, or VPN exit nodes. The
implementation is intentionally small because **irc-framework already contains
built-in SOCKS support** — we only need to expose that capability through the
bot config.

## Feasibility

- **Alignment**: Fits cleanly into the existing config-driven architecture. No
  new core modules, no plugin changes, no database schema changes. One new
  optional config block, a few lines in `bot.ts`.
- **Dependencies**: `socks@2.8.7` is already in the pnpm store as a transitive
  dependency of irc-framework. No new packages needed for SOCKS5.
- **Blockers**: None — all required code is already present in the tree.
- **Complexity estimate**: S (hours).
- **Risk areas**:
  - irc-framework's transport hardcodes `type: 5` (SOCKS5 only). SOCKS4/4a is
    not reachable via this path without patching irc-framework — document this
    limitation clearly.
  - Proxy credentials must never appear in logs.
  - `auto_reconnect` still works through the proxy (irc-framework re-calls
    `connect()` on the transport, which re-reads `options.socks`) — no special
    handling needed.
  - HTTP CONNECT proxies are **not** supported by irc-framework's built-in
    transport. Deferred to a future phase; see Open Questions.

## Dependencies

- [x] `src/bot.ts` — exists and is where the IRC `connect()` call lives
- [x] `src/types.ts` — exists, `BotConfig` is defined here
- [x] `config/bot.example.json` — exists, needs a new `proxy` section
- [x] `socks` npm package — already available as transitive dep of irc-framework

## Phases

### Phase 1: Types and config schema

**Goal:** Declare `ProxyConfig` and wire it into `BotConfig` so the config is
well-typed and validated at load time.

- [x] Add `ProxyConfig` interface to `src/types.ts`:
  ```ts
  export interface ProxyConfig {
    type: 'socks5'; // only supported value; irc-framework hardcodes SOCKS5
    host: string;
    port: number;
    username?: string; // optional SOCKS5 auth
    password?: string; // optional SOCKS5 auth
  }
  ```
- [x] Add `proxy?: ProxyConfig` as an optional field to the `BotConfig`
      interface in `src/types.ts`.
- [x] **Verification**: `pnpm typecheck` passes with no new errors.

### Phase 2: Wire proxy into the IRC connection

**Goal:** When `config.proxy` is set, pass the SOCKS5 options to the irc-framework
`connect()` call. When it is absent, behaviour is unchanged.

- [x] In `src/bot.ts` `connect()`, after the base `connectOptions` object is
      built, add a conditional block:
  ```ts
  if (this.config.proxy) {
    const p = this.config.proxy;
    connectOptions.socks = {
      host: p.host,
      port: p.port,
      ...(p.username ? { user: p.username } : {}),
      ...(p.password ? { pass: p.password } : {}),
    };
    this.botLogger.info(`Using SOCKS5 proxy: ${p.host}:${p.port}`);
  }
  ```
- [x] Ensure proxy credentials are **not** logged (the log line above must only
      print host:port, never username/password).
- [x] **Verification**: Start the bot with a proxy block pointing at a local
      `nc -l` or `ssh -D` tunnel; confirm the `[bot] Using SOCKS5 proxy:` line
      appears and the bot attempts connection through the proxy.

### Phase 3: Config example and documentation

**Goal:** Make it easy to discover and use proxy support.

- [x] Add a `_proxy_note` hint to `config/bot.example.json` explaining the
      `proxy` config block and its fields (JSON has no comments; used a
      `_proxy_note` key as a conventional documentation field).
- [x] **Verification**: `prettier --check config/bot.example.json` passes.

### Phase 4: Tests

**Goal:** Validate the proxy wiring logic without a real SOCKS server.

- [x] In `tests/bot-proxy.test.ts` (new file), test the exported
      `buildSocksOptions` helper directly (5 tests covering all cases).
- [x] Test that when credentials are absent, no `user`/`pass` keys are added.
- [x] Test that `username`/`password` map correctly to `socks.user`/`socks.pass`.
- [x] Test that no `undefined` values exist in the returned object.
- [x] **Verification**: all 5 proxy tests pass (`vitest run tests/bot-proxy.test.ts`).

## Config changes

New optional top-level key in `config/bot.json`:

```json
"proxy": {
  "type": "socks5",
  "host": "127.0.0.1",
  "port": 9050,
  "username": "optionalUser",
  "password": "optionalPass"
}
```

`username` and `password` are optional. Omit entirely if no auth is needed
(common for local Tor / SSH tunnels).

## Database changes

None.

## Test plan

| Test                                             | What it verifies     |
| ------------------------------------------------ | -------------------- |
| proxy config present → `socks` in connectOptions | Core wiring          |
| proxy config absent → no `socks` key             | No-regression        |
| username/password map to user/pass               | Field name mapping   |
| missing creds → no undefined keys                | Clean options object |

Tests should spy on `client.connect()` (already mocked in `tests/helpers/`) and
inspect the argument; no real SOCKS server needed.

## Open questions

1. ~~**SOCKS4 support**~~ — **Resolved**: SOCKS5 only is acceptable.

2. ~~**HTTP CONNECT support**~~ — **Resolved**: Not needed for now.

3. ~~**Proxy auth credential storage**~~ — **Resolved**: Credentials live in
   `bot.json` alongside NickServ password.

4. **Per-network proxies**: Out of scope — hexbot is single-network. Noted for
   future multi-network support.
