# Plan: CTCP Replies (VERSION, PING, TIME)

## Summary

Handle incoming CTCP requests (VERSION, PING, TIME) and send proper CTCP responses. VERSION replies with `n0xb0t v0.1`, PING echoes the sender's timestamp back, and TIME replies with the bot's local time. This is handled in `irc-bridge.ts` as core behavior — not a plugin — since CTCP replies are fundamental bot identity.

## Feasibility

- **Alignment**: Perfect fit. DESIGN.md already defines `ctcp` as a bind type, and `irc-bridge.ts` already listens for `ctcp request` events and dispatches them. The infrastructure is 100% in place.
- **Dependencies**: None — all required modules are built.
- **Blockers**: None. The only consideration is that `irc-framework` auto-replies to VERSION if `connection.options.version` is set — we don't set it, so our handler will fire.
- **Complexity**: **S** (hours) — straightforward wiring.
- **Risk areas**:
  - irc-framework swallows the `ctcp request` event for VERSION if `connection.options.version` is set in connect options. We must NOT set that option, or our handler won't fire. Currently we don't — just need to keep it that way.
  - CTCP PING reply must echo the exact payload back (typically a unix timestamp). Some clients send the timestamp as the message body.
  - CTCP responses use `NOTICE` with `\x01` delimiters — irc-framework's `ctcpResponse(target, type, ...params)` handles this correctly. We need to expose it.

## Dependencies

- [x] `src/irc-bridge.ts` — already listens for `ctcp request` and dispatches `ctcp` type
- [x] `src/dispatcher.ts` — already handles `ctcp` bind type with exact-match on command
- [x] `src/types.ts` — `ctcp` is already a BindType

## Phases

### Phase 1: Expose `ctcpResponse` on the IRC client interface

**Goal:** Make `ctcpResponse()` callable from the bridge and from plugins.

- [ ] Add `ctcpResponse(target: string, type: string, ...params: string[]): void` to the `IRCClient` interface in `src/irc-bridge.ts`
- [ ] Add `ctcpResponse(target: string, type: string, ...params: string[]): void` to the irc-framework type declarations in `src/types/irc-framework.d.ts`
- [ ] Add `ctcpResponse(target: string, type: string, message: string): void` to `PluginAPI` in `src/types.ts` — so plugins can also send CTCP responses
- [ ] Wire `ctcpResponse` in the plugin loader's API builder (`src/plugin-loader.ts`)
- [ ] **Verify:** TypeScript compiles with no errors (`pnpm exec tsc --noEmit`)

### Phase 2: Register built-in CTCP handlers in the bridge

**Goal:** The bridge auto-replies to VERSION, PING, and TIME CTCP requests.

- [ ] In `IRCBridge`, after `attach()` registers the event listener, register three `ctcp` binds on the dispatcher:
  - `VERSION` → replies with `n0xb0t v0.1` (version string from `package.json` or hardcoded)
  - `PING` → echoes `ctx.text` back (the sender's timestamp payload)
  - `TIME` → replies with the bot's local time formatted as an ISO 8601 string (e.g. `2026-03-21T15:04:05-05:00`)
- [ ] Use `client.ctcpResponse(ctx.nick, type, payload)` for replies — this handles the `\x01` NOTICE wrapping
- [ ] Register these binds with pluginId `'core'` so they show up in `.binds` output as core binds
- [ ] Unbind them in `detach()` (or rely on the existing listener cleanup — the dispatcher binds are separate from the IRC event listeners, so we need explicit cleanup)
- [ ] **Verify:** Unit tests pass, manual test with `/ctcp botname VERSION` on a real IRC client

### Phase 3: Tests

**Goal:** Confirm CTCP replies work correctly.

- [ ] Add tests in `tests/irc-bridge.test.ts`:
  - VERSION request → bot sends CTCP VERSION response with version string
  - PING request → bot echoes the payload back as CTCP PING response
  - TIME request → bot sends CTCP TIME response with a time string
  - Plugins can still bind to `ctcp` type and their handlers also fire (stackable)
- [ ] **Verify:** `pnpm test` passes

## Config changes

None. CTCP replies are unconditional core behavior — every IRC bot should respond to these. No configuration needed.

## Database changes

None.

## Test plan

1. **Unit tests** (Phase 3): Verify the bridge sends correct CTCP responses via the mock client
2. **Manual test**: Connect to an IRC server, `/ctcp n0xb0t VERSION` → expect `n0xb0t v0.1`. `/ctcp n0xb0t PING` → expect ping reply. `/ctcp n0xb0t TIME` → expect current time.

## Open questions

1. **Version string source**: Hardcode `n0xb0t v0.1` or read from `package.json`? Reading from package.json is more maintainable but adds a file read. Recommendation: read from `package.json` version field at startup, format as `n0xb0t v${version}`.
2. **TIME format**: Standard CTCP TIME has no mandated format. Common choices:
   - ISO 8601: `2026-03-21T15:04:05-05:00` — unambiguous, machine-parseable
   - RFC 2822: `Fri, 21 Mar 2026 15:04:05 -0500` — more human-readable, traditional
   - Eggdrop uses locale-dependent `strftime` output

   Recommendation: Use JS `new Date().toString()` which produces something like `Fri Mar 21 2026 15:04:05 GMT-0500 (Central Daylight Time)` — human-readable and includes timezone. This is the most common format other bots use.
3. **Should plugins be able to override these?** Since `ctcp` is stackable, plugin binds would fire alongside the core ones. If a plugin wants to replace the VERSION string, that's currently not possible without removing the core bind. This seems fine for now — revisit if needed.
