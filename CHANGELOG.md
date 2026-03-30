# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Enforce unauthorized `+k`/`+l` removal**: when `enforce_modes` is on and no `channel_key`/`channel_limit` is configured, the bot now removes unauthorized `+k` and `+l` mode changes — both reactively (real-time) and proactively (on join via RPL_CHANNELMODEIS)
- **Channel mode tracking in channel-state**: `ChannelInfo` now tracks the channel mode string, key, and limit; updated from `MODE` events and the `channel info` (RPL_CHANNELMODEIS) reply; new `channel:modesReady` event on the internal event bus
- **`requestChannelModes(channel)`** on PluginAPI: sends `MODE #channel` to query the server; response populates channel-state and fires `channel:modesReady`
- **`onModesReady(callback)`** on PluginAPI: register a callback for when channel modes are received from the server; auto-cleaned on plugin unload
- **Proactive mode sync on join**: bot sends `MODE #channel` on join; `syncChannelModes()` chains to `channel:modesReady` instead of a timer, guaranteeing channel-state is populated before enforcement runs

### Changed

- `syncChannelModes()` now removes unauthorized simple modes, keys, and limits (previously only added missing ones)
- `channel_key` and `channel_limit` setting descriptions updated to clarify that empty/zero means "remove unauthorized" when `enforce_modes` is on

## [0.1.0] - 2026-03-29

### Added

- **`chanmod` channel key and limit enforcement**: `channel_key` (string) and `channel_limit` (int) per-channel settings enforce `+k` and `+l` when `enforce_modes` is on — re-applied if removed or changed to a different value; `enforce_channel_key` and `enforce_channel_limit` global config defaults added alongside the existing `enforce_channel_modes`
- `chanmod` README: new "Per-channel settings (.chanset)" section documents all `.chanset`-configurable keys with syntax examples; "Channel mode enforcement" subsection updated to cover all supported modes (`+imnpst`, `+k`, `+l`) in a unified table
- **INVITE handling**: `invite` BindType added to dispatcher and irc-bridge; core registers a bind that auto-rejoins any configured channel on invite (key-aware, no permission check); `chanmod` `invite` per-channel setting (default off) accepts invites from users holding `o`/`m`/`n` flags by matching the sender's hostmask directly against the permissions DB — no shared channel required
- **ChanServ OP recovery in `chanmod`**: new `chanserv_op` per-channel setting (default off); when enabled, sends `PRIVMSG ChanServ :OP <channel>` to recover ops when the bot is deopped and ChanServ is present in the channel; `chanserv_nick` (default `ChanServ`) and `chanserv_op_delay_ms` (default `1000`) global config fields added; also moves `revenge` into per-channel settings; `.chanset <channel>` with no key lists all registered settings
- **Per-user input flood limiter in dispatcher**: `pub`/`pubm` and `msg`/`msgm` events gated by a per-hostmask sliding-window counter; first blocked message per window sends a one-time NOTICE warning to the user; owners (`n` flag) bypass limits; configurable via optional `flood` block in `bot.json`; also adds `pnpm check` script (typecheck + lint + test) and wires `on`/`removeListener` into `DCCIRCClient` so the DCC manager mirrors incoming private notices/messages to open sessions

### Changed

- Project display name standardized to "HexBot" (capitalized) in all prose, file headers, and display strings; IRC nick values, package name, and file paths unchanged
- Unreachable null/`??` defensive guards replaced with TypeScript non-null assertions across `irc-bridge.ts`, `channel-state.ts`, and `chanmod`; `/* v8 ignore */` blocks removed; test suite significantly expanded across `channel-state`, `chanmod`, `flood`, `dispatcher`, DCC, and irc-bridge to cover real code paths
- Dead `if (!ctx.channel) return` guards removed from all plugins — `pub`/`pubm`/`join`/`topic`/`invite` handlers use `ctx.channel!` since irc-bridge guarantees channel is set for these types; stale `user.global ?? ''` and `ctx.args || ctx.nick` fallbacks also removed
- `createPluginApi()` refactored into focused sub-factories (`createPluginIrcActionsApi`, `createPluginChannelStateApi`, `createPluginChannelSettingsApi`, `createPluginHelpApi`, `createPluginLogApi`) — drops from 231 to 47 lines; no behaviour change
- `flood` plugin: extracted `FloodConfig` type and `isFloodTriggered` helper; lifted three bind handlers out of `init()` as module-level functions; `init()` drops from 85 to 33 lines
- `dcc`: passive-DCC guard moved into `validateDccRequest()` as first check; `onDccCtcp()` drops from 26 to 12 lines
- `.claude/` removed from version control and added to `.gitignore` — skills and local settings are local-only
- Dependency bumps: vitest 4.1.0 → 4.1.2, @vitest/coverage-v8 4.1.0 → 4.1.2, typescript-eslint 8.57.1 → 8.57.2

### Fixed

- **DCC idle timeout leaves stale session**: after an idle timeout closed a session, the session was not removed from the sessions map — subsequent connect attempts were rejected with "you already have an active session". `close()` now calls `removeSession()` directly so cleanup runs regardless of which path triggers it
- **Crash on DCC CTCP**: `ctcpRequest()` used instead of the non-existent `ctcp()` method in irc-framework — previously threw an uncaught `TypeError` and crashed the bot
- **Join error handlers now fire**: irc-framework translates numeric error codes to named events (e.g. `bad_channel_key` instead of `475`) — previous handlers on numeric strings were silently dead; `477` now handled via the `unknown command` event since irc-framework has no entry for it
- `chanmod` README: corrected inaccurate caveat — commands reply with an error when the bot lacks ops; `!bans` has no ops check
- Dead code removed (`/deadcode` audit): `Services.identityConfig` private field (stored but never read), `IRCBridge.eventBus` private field (same pattern), unused `_tick` helper in `flood.test.ts`, `isPassiveDcc` `ip` param renamed to `_ip`

### Added

- **Phase 0 — Scaffolding**: project structure, `package.json`, `tsconfig.json`, ESLint config, Vitest setup
- **Phase 1 — Database and dispatcher**:
  - SQLite database wrapper (`src/database.ts`) with namespaced key-value store and mod_log table
  - Event dispatcher (`src/dispatcher.ts`) with `bind(type, flags, mask, handler)` system
  - All 13 bind types: `pub`, `pubm`, `msg`, `msgm`, `join`, `part`, `kick`, `nick`, `mode`, `raw`, `time`, `ctcp`, `notice`
  - Non-stackable (`pub`, `msg`) and stackable bind type support
  - Timer binds via `setInterval` with automatic cleanup
  - Wildcard pattern matching utility (`src/utils/wildcard.ts`) supporting `*` and `?`
- **Phase 2 — Permissions and commands**:
  - Permissions system (`src/core/permissions.ts`) with `n/m/o/v` flags, hostmask matching, and per-channel overrides
  - Owner flag (`n`) implies all other flags
  - Flag syntax supports OR with `|` (e.g. `+n|+m`)
  - Security warnings for insecure `nick!*@*` hostmask patterns on privileged users
  - Command handler (`src/command-handler.ts`) — transport-agnostic command router with `.help` built-in
  - Permission commands: `.adduser`, `.deluser`, `.flags`, `.users`
  - Dispatcher commands: `.binds`
  - Shared type definitions (`src/types.ts`) for HandlerContext, PluginAPI, UserRecord, config shapes
- **Phase 3 — Bot core and IRC**:
  - Bot orchestrator (`src/bot.ts`) — wires all modules together, manages lifecycle
  - IRC bridge (`src/irc-bridge.ts`) — translates irc-framework events to dispatcher events with input sanitization
  - IRC protocol injection prevention: `\r\n` stripping on all incoming fields
  - IRC formatting character stripping before command parsing
  - Internal event bus (`src/event-bus.ts`) — typed EventEmitter for bot-level events
  - Interactive REPL (`src/repl.ts`) with implicit owner privileges
  - Entry point (`src/index.ts`) with CLI args (`--repl`, `--config`), signal handlers, graceful shutdown
  - IRC admin commands: `.say`, `.join`, `.part`, `.status`
  - Auto-reconnect support via irc-framework
  - SASL authentication support
  - Owner bootstrapping from config on first start
- **Phase 4 — Plugin loader and MVP plugins**:
  - Plugin loader (`src/plugin-loader.ts`) — discover, load, unload, hot-reload via ESM cache-busting
  - Scoped PluginAPI with frozen objects, namespace-isolated database, and auto-tagged binds
  - Plugin config merging (plugin `config.json` defaults + `plugins.json` overrides)
  - Plugin validation: safe name check, required exports, duplicate detection
  - Plugin management commands: `.plugins`, `.load`, `.unload`, `.reload`
  - `8ball` plugin — Magic 8-Ball with 20 classic responses
  - `greeter` plugin — configurable join greetings with `{channel}` and `{nick}` template variables
  - `seen` plugin — last-seen tracking via `!seen <nick>` with relative time formatting
- **Phase 5 — Core modules and auto-op**:
  - Channel state tracking (`src/core/channel-state.ts`) — users, modes, hostmasks per channel, updated in real time
  - IRC commands module (`src/core/irc-commands.ts`) — `op`, `deop`, `voice`, `devoice`, `kick`, `ban`, `unban`, `mode`, `topic`, `quiet` with mod action logging and mode batching
  - Services module (`src/core/services.ts`) — NickServ IDENTIFY fallback, ACC/STATUS verification with timeout, Atheme/Anope/DALnet adapter support
  - `auto-op` plugin — auto-op/voice on join based on permission flags with optional NickServ verification
  - PluginAPI extended with `op`, `deop`, `voice`, `devoice`, `kick`, `ban`, `mode`, `getUserHostmask`, `permissions`, `services`, `botConfig`
- `topic` plugin — IRC-formatted channel topics with 22 built-in themes, `!topic`, `!topic preview`, `!topics` commands
- `api.topic(channel, text)` added to PluginAPI
- **Logger service** (`src/logger.ts`) — structured logging with chalk colors, configurable log levels (`debug`/`info`/`warn`/`error`), child loggers with `[source]` prefixes, and startup banner
- **CTCP replies** — built-in VERSION, PING, and TIME handlers registered through the dispatcher bind system in irc-bridge
- `api.ctcpResponse(target, type, message)` added to PluginAPI and IRCClient interface
- `.flags` with no arguments now shows the flag legend (`n`=owner, `m`=master, `o`=op, `v`=voice)
- `topic` plugin enabled in `config/plugins.example.json`
- Config examples: `config/bot.example.json`, `config/plugins.example.json`
- Security guide: `docs/SECURITY.md`
- Design document: `DESIGN.md`
- Plugin API reference: `docs/PLUGIN_API.md`
- Phase planning docs in `docs/mvp/`
- Plugin authoring guide: `plugins/README.md`
- `chanmod` plugin — replaces `auto-op` with full channel protection: auto-op/voice on join, mode enforcement (re-ops flagged users when externally deopped/devoiced), and manual moderation commands (`!op`, `!deop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`)
- `ctcp` plugin — standalone VERSION, PING, and TIME CTCP reply handlers
- `flood` plugin — message/join/nick-change flood detection with configurable escalation (warn → kick → tempban), per-channel exemptions, and command triggers (`.flood status/reset/exempt/unexempt`)
- Message queue (`src/core/message-queue.ts`) — token-bucket rate limiter for all outbound bot messages; prevents flood-kick disconnects; configurable via `queue.rate` and `queue.burst` in `bot.json`
- `!topic preview [text]` subcommand — DMs all available themes rendered with sample text
- New topic themes: crimson, aurora, sunset, bloodrune, and others (total 27 themes)
- Test coverage threshold enforced at 80% via Vitest (`vitest.config.ts`)
- Prettier code formatting with `@trivago/prettier-plugin-sort-imports`
- Husky pre-commit hook running lint-staged (format check) and typecheck
- `pnpm format` / `pnpm format:check` scripts
- Plugin hot-reload: multi-file plugin support — loader now recursively discovers all local `.ts` modules and creates uniquely-named temp copies for cache-busting, replacing the prior approach that only worked for single-file plugins; orphaned temp files are cleaned up on `loadAll()`
- `chanmod` v2 — refactored into focused module files and extended with protection features:
  - **Rejoin on kick** (`rejoin_on_kick`) — bot rejoins after being kicked, with configurable delay and rate-limiting (`max_rejoin_attempts` per `rejoin_attempt_window_ms`)
  - **Revenge** (`revenge_on_kick`) — optionally deops, kicks, or kickbans the kicker after rejoining; skips if kicker has left, bot has no ops, or kicker has an exempt flag (`revenge_exempt_flags`)
  - **Bitch mode** (`bitch`) — strips `+o`/`+h` from anyone who receives them without the appropriate permission flag; nodesynch nicks exempt
  - **Punish deop** (`punish_deop`) — kicks or kickbans whoever deops a flagged user without authority; rate-limited to 2 per setter per 30 seconds
  - **Enforcebans** (`enforcebans`) — kicks in-channel users whose hostmask matches a newly-set ban mask
- ACC/STATUS fallback for NickServ verification (supports Atheme and Anope)
- Deployment plan (`docs/plans/deployment.md`) — Docker + docker-compose, GitHub Actions CI/CD, systemd unit guide
- REPL mirrors incoming private messages and notices (e.g. from ChanServ/NickServ) to the console using IRC-conventional `<nick>` / `-nick-` formatting
- **DCC CHAT + Botnet** (`src/core/dcc.ts`) — Passive DCC CHAT for remote administration:
  - Passive DCC only (bot opens port, user connects) — no NAT issues for VPS deployments
  - Hostmask + flag authentication; optional NickServ ACC verification before accepting session
  - Multi-user party line ("botnet"): plain text broadcasts to all connected admins; `.command` routes through CommandHandler with real flag enforcement
  - Banner on connect: bot version, handle, botnet roster
  - DCC-only commands: `.botnet` / `.who` (roster + uptime), `.quit` / `.exit` (disconnect)
  - Joining/leaving announced to all connected sessions; REPL activity broadcast to botnet
  - Configurable: port range, max sessions, idle timeout, required flags, NickServ verify
  - Config: `dcc` block in `bot.json` (disabled by default); see `docs/DCC.md`
- **Halfop support** in `chanmod` plugin (v2.1.0):
  - `botCanHalfop()` check — bot must have `+h` or `+o` to set halfop
  - `halfop_flags` config key (default `[]`, opt-in) for auto-halfop on join (between op and voice tiers)
  - Mode enforcement for `-h`: re-applies `+h` when a flagged user is dehalfopped externally
  - `!halfop` / `!dehalfop` manual commands (require `+o` flag)
- `halfop(channel, nick)` / `dehalfop(channel, nick)` added to `IRCCommands` and `PluginAPI`
- User documentation for DCC CHAT: `docs/DCC.md`
- **Docker deployment**: `Dockerfile` + `docker-compose.yml` with bind mounts for config/plugins/data; `build` and `start:prod` scripts in `package.json`; data directory auto-created on startup
- **GitHub Actions CI**: typecheck, lint, and test on every push and PR
- **Greeter custom greets** (`greeter` v2.2.0): registered users can set a personal greeting with `!greet set <message>` (fires instead of the default), `!greet` to view, `!greet del` to remove; `min_flag` config controls minimum privilege level (`n`/`m`/`o`/`v`); uses `meetsMinFlag()` helper with proper flag hierarchy
- **Greeter delivery modes** (`greeter` v2.1.0): `delivery: "say"` (default) or `"channel_notice"` (NOTICE to channel); `join_notice` — independent private NOTICE sent directly to the joining user, with `{channel}`/`{nick}` substitution and `\r\n` stripping
- **Help system** (`help` plugin, v1.0.0): `!help` command sends permission-filtered command list via NOTICE; supports `!help <command>` for detail view and grouped category listing; configurable `reply_type` (`notice`/`privmsg`/`channel_notice`) and per-user cooldown; `HelpRegistry` core module (`src/core/help-registry.ts`) auto-cleared on plugin unload; `registerHelp()` / `getHelpEntries()` added to PluginAPI
- **Channel settings system**: `ChannelSettings` registry with per-channel key/value store (flag, string, int types); `.chanset <channel> <key> [value]` and `.chaninfo <channel>` commands for runtime channel configuration; `m` flag required
- **DCC console banner overhauled**: ASCII logo placeholder, greeting, flags display, and help text shown on connect
- **IRCv3 identity caps** (`e0a0440`):
  - `extended-join`, `account-notify`, `chghost` caps negotiated on connect; `ChannelState` tracks network-wide nick→account map in real time
  - Dispatcher ACC enforcement — privileged handlers automatically gated on NickServ identity via `VerificationProvider`; plugin authors no longer call `verifyUser()` manually
  - SASL EXTERNAL / CertFP support: `services.sasl_mechanism: "PLAIN" | "EXTERNAL"`, `irc.tls_cert`, `irc.tls_key` config fields
  - `api.stripFormatting(text)` added to PluginAPI; shared utility at `src/utils/strip-formatting.ts`; greeter migrated from local copy
- **Declaration files** (`types/`): `events.d.ts`, `plugin-api.d.ts`, `config.d.ts`, `index.d.ts` generated for plugin authors with rich JSDoc, `@example` tags, and per-bind-type field semantics table; `ChannelUser.accountName?: string | null` exposes IRCv3 account status to plugins

### Changed

- All modules now use the logger service instead of bare `console.log` — bot, dispatcher, database, permissions, irc-bridge, plugin-loader, repl, channel-state, irc-commands, and services
- Removed `api.log('Loaded')` calls from all plugins — the plugin loader already logs load events
- Seen plugin updated to v1.1.0 with TTL cleanup — records older than `max_age_days` (default 365) are automatically purged on query
- Extracted `sanitize()` (newline stripping) into shared `src/utils/sanitize.ts`, replacing inline implementations in irc-bridge, irc-commands, and plugin-loader
- Vitest config excludes `.claude/worktrees/` to prevent duplicate test runs
- `chanmod` refactored into focused module files (`state.ts`, `helpers.ts`, `bans.ts`, `auto-op.ts`, `mode-enforce.ts`, `commands.ts`, `protection.ts`) using a shared-state dependency-injection pattern; each module exports a `setup*()` function returning a teardown callback
- Plugin tests: `chanmod` and `topic` switched to `vi.useFakeTimers` + `advanceTimersByTimeAsync`; `8ball` and `seen` switched from `beforeEach` to `beforeAll` for shared setup — total ~2 s saved per run
- `chanmod` `enforce_channel_modes` migrated from plugin config to per-channel `channelSettings`
- `chanmod` test suite loads plugin once per suite instead of per test (~5× speedup)
- `!help` output reformatted: compact grouped index with bold triggers; `!help <category>` drill-down for category listings
- Switch to `bundler` module resolution in `tsconfig.json`; all `.js` extensions removed from relative imports across `src/`, `plugins/`, and `tests/`
- Node.js minimum requirement raised from v20 to v24 (current LTS)
- docker-compose: named network, explicit container name, DCC port mappings added
- `auto-op` plugin replaced by `chanmod` — subsumes auto-op/voice behavior and adds manual moderation commands and mode enforcement
- CTCP handlers moved from irc-bridge core into the standalone `ctcp` plugin
- Plugin API reference renamed from `docs/plugin-api.md` to `docs/PLUGIN_API.md`
- Project renamed from `n0xb0t` to `hexbot` throughout all source, docs, configs, and tooling
- `topic` plugin: `sunsetpipeline` theme renamed to `sunset`
- `topic` plugin: `deepblue` theme removes extra padding around `$text`; `arrowhead` theme fixes spacing around text and closing decorator

### Fixed

- **Security audit** (all findings from `docs/audits/all-2026-03-21.md`):
  - CommandHandler enforces permission flags for IRC sources, preventing privilege escalation
  - `botConfig` deep-frozen with NickServ password omitted from plugin API
  - Plugin `.load` command validates name against `SAFE_NAME_RE` to prevent path traversal
  - Plugin `raw()` strips `\r\n` to prevent accidental IRC protocol injection
  - REPL commands logged to console for audit trail
  - `ensureOwner` adds config hostmask if missing from existing DB record
  - IRC replies split at ~400 bytes, capped at 4 lines with `...` truncation (`src/utils/split-message.ts`)
  - RFC 2812 `ircLower()` case mapping used in wildcard matching, channel-state lookups, and dispatcher mask comparisons
  - Timer binds enforce 10-second minimum interval to prevent resource exhaustion
- **Security audit** (all findings from `docs/audits/all-2026-03-22.md`):
  - IRC protocol injection in `IRCCommands` — `channel`, `nick`, `mask`, `key` now sanitized before interpolation into `raw()` calls
  - Kick event context corrected — kicked user's ident/hostname looked up from channel state rather than using the kicker's identity
  - `bot.json` world-readability check on startup — bot exits with error if config file is world-readable
  - `botConfig.irc.channels` deep-frozen in plugin API (`Object.freeze([...channels])`)
  - CTCP rate limiter wired up — `ctcpAllowed()` now called in `onCtcp()` before dispatching; `ctcpResponse()` routed through message queue
  - `.say` target validated against `^[#&]?[^\s\r\n]+$` before use
  - `topic` plugin `String.replace()` uses callback form to prevent `$&`/`$'` pattern substitution
  - Greeter plugin strips IRC formatting codes from nick before interpolation
  - Message queue depth capped at 500; default `rate`/`burst` corrected to `2`/`4`
- **IRC CASEMAPPING ISUPPORT support**:
  - CASEMAPPING token read from server on `registered` event; active mapping stored on `Bot` and propagated to all modules via `setCasemapping()`
  - Supports `rfc1459`, `strict-rfc1459`, and `ascii`; defaults to `rfc1459` for unknown values
  - `ircLower(text, casemapping)` and `caseCompare(a, b, casemapping)` updated in `src/utils/wildcard.ts`
  - `wildcardMatch` accepts a fourth `casemapping` parameter
  - All nick/channel key lookups in `ChannelState`, `Permissions`, `EventDispatcher`, `Services`, and `DCCManager` use the active network casemapping
  - `api.ircLower(text)` added to `PluginAPI` — live closure over the current casemapping
  - `Casemapping` type exported from `src/types.ts`
  - All `.toLowerCase()` calls for nick/channel comparison replaced with `api.ircLower()` in `seen`, `greeter`, `flood`, and `chanmod` plugins
- **DCC CHAT feature renamed from "botnet" to "console"**: `.botnet` → `.console`, join/leave announcements, banner text, docs, and plan files updated
- `api.raw()` removed from `PluginAPI` — no callers; reduces attack surface (`IRCCommands` internal `raw()` usage unaffected)
- Mode strings sanitized before `raw()` in `irc-commands` to prevent protocol injection; channel keys IRC-lowered in `chanmod` flag lookups; filesystem paths removed from plugin-facing `botConfig`
- `isModeEntry` relaxed to accept entries without a `mode` field — fixes silent event drops in `onMode` when a server omits the mode key
- SOCKS5 proxy now requires `proxy.enabled = true` to activate — previously enabled whenever the config block existed, risking silent traffic redirection
- DCC CHAT rejection logging: raw args, active-DCC refusal (ip/port), hostmask mismatch, and insufficient flags all logged so the console shows exactly why a session was denied
- Passive DCC detection accepts mIRC-style requests (port=0 only) — mIRC sends a real IP with port=0 rather than both zeroed; previously these were silently rejected
- **Type safety**: `PluginBotConfig`/`PluginIrcConfig` typed readonly views replace `Record<string,unknown>` botConfig; `src/utils/irc-event.ts` adds `toEventObject()`, `isModeArray()`, `isObjectArray()` type guards; `cfg<T>()` helper in `chanmod/state.ts` collapses unsafe per-property casts
- `deepblue2` topic theme: missing background color on opening decorator
- `chanmod` commands now check that the bot holds ops before executing mode changes
- `!unban` in `chanmod` now accepts a nick in addition to an explicit ban mask — resolves the user's hostmask from channel state, builds all standard mask candidates, and falls back to removing all candidate masks if no stored ban record is found
- REPL prompt displayed before readline prompt, preventing interleaved output
- ESLint and TypeScript errors: unused variables, stale reload temp files, IRC formatting control-char regex in greeter
- Several `topic` theme string formatting bugs
