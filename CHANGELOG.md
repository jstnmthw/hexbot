# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 0 — Scaffolding**: project structure, `package.json`, `tsconfig.json`, ESLint config, Vitest setup
- **Phase 1 — Database and dispatcher**:
  - SQLite database wrapper (`src/database.ts`) with namespaced key-value store and mod_log table
  - Event dispatcher (`src/dispatcher.ts`) with Eggdrop-style `bind(type, flags, mask, handler)` system
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
- Plugin hot-reload: transitive dependency cache-busting — rewrites local import URLs so re-imported sub-modules are also reloaded
- ACC/STATUS fallback for NickServ verification (supports Atheme and Anope)
- Deployment plan (`docs/plans/deployment.md`) — Docker + docker-compose, GitHub Actions CI/CD, systemd unit guide
- REPL mirrors incoming private messages and notices (e.g. from ChanServ/NickServ) to the console using IRC-conventional `<nick>` / `-nick-` formatting
- **DCC CHAT + Botnet** (`src/core/dcc.ts`) — Eggdrop-style passive DCC CHAT for remote administration:
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

### Changed

- All modules now use the logger service instead of bare `console.log` — bot, dispatcher, database, permissions, irc-bridge, plugin-loader, repl, channel-state, irc-commands, and services
- Removed `api.log('Loaded')` calls from all plugins — the plugin loader already logs load events
- Seen plugin updated to v1.1.0 with TTL cleanup — records older than `max_age_days` (default 365) are automatically purged on query
- Extracted `sanitize()` (newline stripping) into shared `src/utils/sanitize.ts`, replacing inline implementations in irc-bridge, irc-commands, and plugin-loader
- Vitest config excludes `.claude/worktrees/` to prevent duplicate test runs
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
- **Security audit** (all findings from `docs/audits/all-2026-03-22.md`)
- `deepblue2` topic theme: missing background color on opening decorator
- `chanmod` commands now check that the bot holds ops before executing mode changes
- `!unban` in `chanmod` now accepts a nick in addition to an explicit ban mask — resolves the user's hostmask from channel state, builds all standard mask candidates, and falls back to removing all candidate masks if no stored ban record is found
- REPL prompt displayed before readline prompt, preventing interleaved output
- ESLint and TypeScript errors: unused variables, stale reload temp files, IRC formatting control-char regex in greeter
- Several `topic` theme string formatting bugs
