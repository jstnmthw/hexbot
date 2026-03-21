# Plan: Phase 5 — Core Modules + Auto-Op Plugin (MVP Complete)

## Summary
Build the remaining core modules (services integration, IRC command helpers, channel state tracking) and the auto-op plugin that ties everything together. This is the final MVP phase. At the end, the bot connects, manages users, verifies identity via NickServ (on supporting networks), and automatically ops users based on their flags.

## Dependencies
- [x] Phase 0 complete (scaffolding)
- [x] Phase 1 complete (database + dispatcher)
- [x] Phase 2 complete (permissions + command handler)
- [x] Phase 3 complete (bot core + IRC + REPL)
- [x] Phase 4 complete (plugin loader + example plugins)

---

## Phase 5A: Channel state core module

**Goal:** Track who is in each channel, their modes, and hostmasks. Updated in real time from IRC events.

- [x] Create `src/core/channel-state.ts` implementing the `ChannelState` class:
  - Constructor takes the bot's IRC client and event bus
  - Maintains a `Map<channelName, ChannelInfo>` where:
    ```typescript
    ChannelInfo = {
      name: '#channel',
      topic: 'channel topic',
      modes: '+nt',
      users: Map<nick, UserInfo>
    }
    UserInfo = {
      nick: 'User',
      ident: 'ident',
      hostname: 'host.name',
      hostmask: 'User!ident@host.name',  // computed
      modes: ['o', 'v'],  // channel modes this user has
      joinedAt: Date
    }
    ```
  - Listen to IRC events and update state:
    - `join` → add user to channel
    - `part` → remove user from channel
    - `quit` → remove user from all channels
    - `kick` → remove user from channel
    - `nick` → update nick in all channels
    - `mode` → update user modes (+o, -o, +v, -v, etc.)
    - `userlist` / `names` → bulk populate on channel join
    - `who` response → fill in ident/hostname for users
  - `getChannel(name)` → return ChannelInfo or undefined
  - `getUser(channel, nick)` → return UserInfo or undefined
  - `getUserHostmask(channel, nick)` → return `nick!ident@host` string
  - `isUserInChannel(channel, nick)` → boolean
  - `getUserModes(channel, nick)` → array of mode chars
  - Emit `channel:userJoined`, `channel:userLeft`, `channel:modeChanged` on event bus

- [x] Create `tests/core/channel-state.test.ts`:
  - Test: user join adds them to state
  - Test: user part removes them
  - Test: user quit removes them from all channels
  - Test: nick change updates across all channels
  - Test: mode +o adds 'o' to user's modes
  - Test: mode -o removes 'o' from user's modes
  - Test: getUser returns correct info
  - Test: getUserHostmask returns formatted string
  - Test: state is empty for unknown channels
- [x] **Verify:** tests pass

## Phase 5B: IRC commands core module

**Goal:** Convenience wrappers for common IRC operations with flood awareness.

- [x] Create `src/core/irc-commands.ts` implementing the `IRCCommands` class:
  - Constructor takes the bot's IRC client and channel state
  - `join(channel, key?)` — join a channel
  - `part(channel, message?)` — leave a channel
  - `kick(channel, nick, reason?)` — kick a user
  - `ban(channel, mask)` — set +b on a mask
  - `unban(channel, mask)` — set -b on a mask
  - `op(channel, nick)` — set +o
  - `deop(channel, nick)` — set -o
  - `voice(channel, nick)` — set +v
  - `devoice(channel, nick)` — set -v
  - `mode(channel, modeString, ...params)` — raw mode change
  - `topic(channel, text)` — set channel topic
  - `quiet(channel, mask)` — set +q if supported (check ISUPPORT)
  - All commands log to mod_log table when they involve user actions (kick, ban, op, deop)
  - Respect ISUPPORT `MODES` value — batch mode changes if setting multiple modes at once

- [x] Create `tests/core/irc-commands.test.ts`:
  - Test: op() sends correct MODE command via mock IRC client
  - Test: kick() sends KICK with reason
  - Test: ban() sends correct +b MODE
  - Test: mode batching respects MODES limit
  - Test: mod actions are logged to database
- [x] **Verify:** tests pass

## Phase 5C: Services core module

**Goal:** NickServ integration — bot authentication and user identity verification.

- [x] Create `src/core/services.ts` implementing the `Services` class:
  - Constructor takes `{ client, config, permissions, eventBus }`
  - **Bot authentication:**
    - If `config.services.sasl` is true: SASL is handled by irc-framework (just pass config)
    - If SASL is false/unavailable: send `PRIVMSG NickServ :IDENTIFY <password>` on connect
    - Adapter for NickServ target: uses `config.services.nickserv` (default `'NickServ'`, DALnet uses `'nickserv@services.dal.net'`)
  - **User verification (NickServ ACC):**
    - `async verifyUser(nick)` → returns `{ verified: boolean, account: string|null }`
    - Sends `PRIVMSG NickServ :ACC <nick>` (Atheme) or `STATUS <nick>` (Anope)
    - Listens for the response notice
    - Returns a promise that resolves with the result (with timeout)
    - ACC response codes: `3` = identified to the nick, `2` = recognized, `1`/`0` = not identified
    - Only ACC level `3` counts as verified
  - **Configurable strictness:**
    - `config.identity.method`: `'hostmask'` | `'nickserv'` | `'both'`
    - `config.identity.require_acc_for`: array of flags that require ACC verification (e.g., `['+o', '+n']`)
    - When method is `'hostmask'`: only hostmask matching (default, works everywhere)
    - When method is `'nickserv'`: only NickServ ACC
    - When method is `'both'`: hostmask AND NickServ must pass
  - **Services type adapter:**
    - `'atheme'`: `ACC <nick>` command, parse `<nick> ACC <level>` response
    - `'anope'`: `STATUS <nick>` command, parse `STATUS <nick> <level>` response
    - `'none'`: skip NickServ entirely (for networks without services)
  - `getServicesType()` — return configured type
  - `isAvailable()` — return true if services are configured and the network appears to have NickServ

- [x] Create `tests/core/services.test.ts`:
  - Test: bot auth sends IDENTIFY on connect (non-SASL mode)
  - Test: verifyUser sends correct ACC command for atheme
  - Test: verifyUser sends correct STATUS command for anope
  - Test: ACC response code 3 → verified = true
  - Test: ACC response code 1 → verified = false
  - Test: verification timeout → verified = false
  - Test: services type 'none' → verifyUser always returns verified = true
  - Test: DALnet adapter uses correct NickServ target
  - All tests use mock IRC client — no real network needed
- [x] **Verify:** tests pass

## Phase 5D: Wire core modules into Bot

- [x] Update `src/bot.ts`:
  - Instantiate `ChannelState` after IRC connection
  - Instantiate `IRCCommands` after IRC connection
  - Instantiate `Services` with config
  - Expose all three on the bot instance
  - Update the scoped plugin API to include channel state and IRC commands:
    - `api.getChannel()` now returns real data from ChannelState
    - `api.getUsers()` now returns real data from ChannelState
  - Update command handler: `.say`, `.join`, `.part` now use IRCCommands

## Phase 5E: Auto-op plugin

**Goal:** The MVP plugin. User joins → bot checks flags → verifies identity → ops/voices them.

- [x] Create `plugins/auto-op/index.ts`:
  - Binds `join` on `*` — triggers on any join in any channel
  - On join:
    1. Look up the user's hostmask against permissions
    2. If user has flags for this channel:
       - If `config.identity.require_acc_for` includes their flag level AND services are available:
         - Query NickServ ACC
         - Wait for verification (with configurable timeout, default 5s)
         - If verified: apply modes
         - If not verified: do nothing (or optionally notify the user via notice)
       - If ACC not required: apply modes immediately based on hostmask
    3. Apply modes: `+o` if user has `o` or `n` or `m` flag, `+v` if user has `v` flag
  - Don't op/voice the bot itself
  - Log all auto-op actions to mod_log
  - **Security:** This plugin is the highest-risk component — it grants channel operator status. See `docs/SECURITY.md` section 3.2. Critical rules:
    - NEVER skip NickServ verification when `require_acc_for` is configured — even if it's slower
    - On verification timeout, default to NOT granting ops (fail closed, not open)
    - Verify the hostmask matches BEFORE querying NickServ (don't ACC-check every joiner)
    - Log failed verification attempts (potential impersonation)

- [x] Create `plugins/auto-op/config.json`:
  ```json
  {
    "verify_timeout_ms": 5000,
    "notify_on_fail": false,
    "op_flags": ["n", "m", "o"],
    "voice_flags": ["v"]
  }
  ```
- [x] Create `plugins/auto-op/README.md`
- [x] Create `tests/plugins/auto-op.test.ts`:
  - Test: user with `o` flag joins → gets opped
  - Test: user with `v` flag joins → gets voiced
  - Test: user with `n` flag joins → gets opped (owner implies op)
  - Test: unknown user joins → nothing happens
  - Test: user with flags for different channel → nothing happens in this channel
  - Test: NickServ verification flow (mock the ACC response)
  - Test: verification timeout → user not opped
  - Test: bot doesn't op itself
- [x] **Verify:** tests pass

## Phase 5F: Full MVP verification

- [x] Run `pnpm test` — entire test suite passes (all phases)
- [ ] Start bot on a real IRC network
- [ ] Add yourself as owner: `.adduser myadmin *!myident@my.host nmov`
- [ ] Part and rejoin the channel → bot ops you
- [ ] Have someone else join who isn't in the user list → nothing happens
- [ ] Add them with voice: `.adduser friend *!their@host v`
- [ ] They rejoin → bot voices them
- [ ] Test hot-reload of auto-op: change a config value, `.reload auto-op`, verify new behavior
- [ ] Test all example plugins still work alongside auto-op
- [ ] `.plugins` shows all four plugins loaded with correct versions
- [ ] `.binds` shows all registered binds from all plugins
- [ ] `.status` shows bot uptime, channels, loaded plugins

---

## Verification

**This phase is complete when:**
1. All core module tests pass (channel-state, irc-commands, services)
2. Auto-op plugin tests pass
3. `pnpm test` — full suite passes
4. Bot connects to a real network, auto-ops users based on flags
5. NickServ verification works (on networks with services)
6. All four plugins work simultaneously without conflicts
7. REPL admin commands all function correctly
8. IRC admin commands all function correctly
9. Hot-reload works for all plugins

## MVP is complete! 🎉

The bot is now a functional, plugin-based IRC bot framework with:
- Eggdrop-style bind/event system
- Hot-reloadable plugins with scoped API
- Hostmask-based permissions with optional NickServ verification
- Network-agnostic design
- Interactive REPL for development
- Four working plugins (8ball, greeter, seen, auto-op)
- Full test suite

### Post-MVP roadmap (from DESIGN.md):
- **Phase 6:** Channel protection plugins (flood detection, anti-spam)
- **Phase 7:** Admin web panel (Express + Socket.IO)
- **Phase 8:** AI chat module (Gemini adapter)
