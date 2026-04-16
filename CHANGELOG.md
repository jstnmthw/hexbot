# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.1] - 2026-04-16

### Fixed

- **Shell command injection in plugin build script** (`scripts/build-plugins.ts`): switched from `execSync` with string interpolation to `execFileSync` with an argument array so paths with spaces or shell metacharacters cannot alter the command
- **Polynomial ReDoS in RSS HTML tag stripper** (`plugins/rss/feed-formatter.ts`): replaced the `/<[^>]*>/g` regex (O(n²) on pathological input) with a single-pass O(n) character scanner that buffers after `<` and flushes unclosed tags

## [0.4.0] - 2026-04-16

### Changed

- **Plugins bundled via tsup** (`scripts/build-plugins.ts`, per-plugin `tsup.config.ts`): plugins with a `tsup.config.ts` are now compiled into self-contained `dist/index.js` bundles at build time instead of being loaded as raw TypeScript via `tsx`. The RSS plugin bundles its CJS dependencies (`rss-parser`, `xml2js`, `sax`) with a `createRequire` shim for Node built-in interop. The plugin loader resolves `plugins/<name>/dist/index.js` for bundled plugins.
- **`.binds` output grouped by plugin** with section headers for easier scanning
- **Topic plugin `protect_topic` setting renamed to `topic_lock`** for consistency with Eggdrop terminology
- **DCC CHAT rejection notices collapsed** into a single generic "request denied" message — no longer leaks the specific denial reason (hostmask mismatch, missing flags, etc.) to the connecting user

### Fixed

- **Mode-grant commands targeting the bot itself silently ignored** — previously the bot could attempt to op/deop/voice itself in response to a user command, causing confusing no-ops or mode bounces
- **Docker build failure when plugins have local `node_modules`** (`.dockerignore`): `COPY plugins/` was copying host-side `node_modules/` and `dist/` directories into the image; pnpm then refused to overwrite them in the non-TTY Docker build environment (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Added `plugins/*/node_modules` and `plugins/*/dist` to `.dockerignore`.
- **ESLint errors on plugin `dist/` bundles** (`eslint.config.js`): the `dist/` ignore pattern only matched the top-level directory; added `**/dist/` to also exclude plugin build output.

### Removed

- **`dcc.nickserv_verify` config field** — deprecated in 0.3.0, now removed. DCC authentication uses per-user passwords exclusively. Remove the field from your `config/bot.json` to avoid a schema validation error on startup.

## [0.3.0] - 2026-04-15

### Added

- **`mod_log` observability remediation** (`src/database.ts`, `src/core/audit.ts`, `src/core/commands/modlog-commands.ts`, `src/plugin-api-factory.ts`, plus per-plugin instrumentation): closed every audit gap surfaced in the 2026-04-14 review.
  - **Schema rewrite**: `mod_log` now carries `source`, `plugin`, `outcome`, and a JSON `metadata` blob; new indexes (`mod_log_ts`, `mod_log_target`, `mod_log_channel_ts`, `mod_log_source`); one-shot startup migration from the pre-Phase-1 layout copies historical rows into the new shape with `source='unknown'`. `logModAction` is now an options object — every call site updated in lockstep.
  - **Plugin audit API**: `api.audit.log(action, options)` writes a `source='plugin'` row with the plugin id forced into the `plugin` and `by` columns — plugins cannot spoof identity. Every `api.irc.*` call (op/deop/kick/ban/voice/halfop/topic/invite) auto-audits with the same plugin actor, so most plugins don't need to call `api.audit.log` directly.
  - **Core command coverage**: `.chanset`, `.plugin load/unload/reload`, `.stick`/`.unstick`, `.say`/`.msg`/`.join`/`.part`/`.invite`, `.console`, `.botlink disconnect/reconnect`, `.relay`, `.bot`, `.bsay`, `.bannounce` all write `mod_log` rows; remote command dispatch on the origin bot leaves an audit trail before handoff.
  - **Auth + auto-action observability**: DCC password failures (`auth-fail`), DCC lockouts (`auth-lockout` — distinct row so brute-force attempts query as one event), NickServ verify timeouts, botlink auto-bans (`botlink-autoban`, distinct from manual `botlink-ban`), and every `.chpass` rejection path now land as `outcome='failure'` rows. The attempted password is never serialized.
  - **`.modlog` operator UI** (`src/core/commands/modlog-commands.ts`): stateful per-session pager gated on `+m`, refused on IRC channels with a "DCC-only" redirect. Filter grammar: `action`, `target`, `channel`, `by`, `source`, `plugin`, `since`, `grep`. Subcommands: `next`/`prev`/`top`/`end`/`show <id>`/`clear`. Cursor-based pagination via `(beforeId)` keeps deep paging O(log n). Total snapshot survives mid-browse writes with a `(+N new)` hint. `m`-flag callers are restricted to channels they have per-channel `o` on; `n`-flag callers are unrestricted. Per-session pagers expire after 30 minutes idle.
  - **`.audit-tail` REPL stream**: subscribes to the new `audit:log` event bus and streams rows live until `.audit-tail off`. Reuses the `.modlog` filter grammar.
  - **Retention knob**: new optional `logging.mod_log_retention_days` config field — when >0, rows older than the cutoff are pruned in a single `DELETE` on startup. Pairs with the existing `logging.mod_actions` flag, which now actually gates writes (it was dead config before).
  - **Helpers**: `tryAudit(db, ctx, options)` and `tryLogModAction(db, options, logger)` in `src/core/audit.ts` — single source of truth for the "log to mod_log, never throw" idiom. Six near-duplicate try/catch wrappers across `channel-commands`, `plugin-commands`, `irc-commands-admin`, `ban-commands`, `dcc-console-commands`, `botlink-commands` plus three class-internal `recordModAction` methods (`permissions`, `botlink-auth`, `irc-commands`) all delegate to it. The only direct `db.logModAction(` call now lives inside `audit.ts` itself — any new occurrence is a smell worth flagging in review.
  - **Docs**: full audit contract at [docs/AUDIT.md](docs/AUDIT.md) (schema, action vocabulary, plugin author rules, operator UI reference, retention story); `docs/PLUGIN_API.md` updated with the `api.audit.log` signature and the auto-audit note; linked from `docs/SECURITY.md`.
- **`.uptime` command** (`src/core/commands/irc-commands-admin.ts`): one-line operator command (flag `+o`) that reports the bot's current uptime with numeric components highlighted in bold red via mIRC formatting. Complements the existing `.status` output, which still shows uptime as part of a stacked multi-line report.
- **DCC console log sink with per-session `.console` flags** (`src/core/dcc-console-flags.ts`, `src/core/commands/dcc-console-commands.ts`, `src/logger.ts`): DCC sessions are now a filtered live view of the bot's log. Each session holds a set of single-letter flags (`m`/`o`/`j`/`k`/`p`/`b`/`s`/`d`/`w`) that decide which categories of log line reach it. Defaults to `+mojw` (messages, operator actions, joins/parts, warnings) — debug and command-dispatch chatter are off by default. `.console [+flags|-flags]` mutates the calling session; `.console <handle> +flags` sets stored defaults for another handle (owner-only). Preferences persist per handle in the `dcc` kv namespace under `console_flags:<handle>` and are cleaned up when the user is removed. `.console` is DCC-only; `.who` is now the session-list command (formerly a `.console` alias). See [docs/DCC.md#console-flags](docs/DCC.md#console-flags).
- **Multi-sink logger** (`src/logger.ts`): `Logger.addSink` / `Logger.removeSink` deliver structured `LogRecord`s (level, timestamp, source prefix, colorized `formatted`, ANSI-free `plain`) to any number of subscribers. A default console sink preserves current stdout/stderr behavior; the REPL's legacy `setOutputHook` is kept as a compatibility wrapper that replaces the console sink. `logger.child(prefix, { category })` embeds an explicit `#<letter>` marker into `LogRecord.source` so DCC consumers can route a line to a specific flag regardless of the default source-to-category table.
- **Failed-login banner for DCC and REPL** (`src/core/dcc/login-summary.ts`, `src/core/dcc/banner.ts`, `src/repl.ts`): every DCC auth success now writes a `login/success` mod_log row, then queries the `auth-fail`/`auth-lockout` rows in the window since the prior login (or bot start) and renders a warning block above the session banner's stats table. The REPL prints a one-line aggregate above the first prompt. No new schema — `mod_log` is the source of truth, so the banner reflects every failure path the audit pipeline already records.
- **Process title for `htop`/`ps`** (`src/index.ts`): `process.title` is set from the bot nick and config path so multi-instance deployments can be identified at a glance in `htop`/`ps` output instead of all showing as `node`/`tsx`.

### Fixed

- **2026-04-14 security audit** (`docs/audits/all-2026-04-14.md`, `docs/audits/rss-2026-04-14.md`): closed every Phase 1 critical, Phase 2 warning, and Phase 3 info finding from the full-codebase sweep.
  - **RSS SSRF defense in depth** (`plugins/rss/url-validator.ts`, `plugins/rss/feed-fetcher.ts`): https-only scheme enforcement, DNS-resolved hostname checks against RFC1918 / loopback / link-local / ULA / CGNAT / TEST-NET / multicast ranges via `ipaddr.js`, custom `http.get` wrapper with a 5 MiB byte cap, Content-Type validation, redirect re-validation, DOCTYPE rejection (billion-laughs defense), and a pinned-socket lookup so the resolved IP can't drift between validation and connect.
  - **`.bot` / `.chpass` transport hardening**: `.bot` keeps a denylist for sensitive relayed commands (`.chpass` refused outright) and redacts arg values in `mod_log` metadata; `.chpass` only accepts `repl` or `dcc` transports — botlink and any future source are rejected by default.
  - **Auto-op IRCv3 fast path** (`plugins/chanmod/auto-op.ts`): `ctx.account` from extended-join threads into `grantMode`; `account=*` is treated as "not identified" and refuses the grant without a NickServ round-trip.
  - **BotLink password compare**: `verifyPassword` uses `crypto.timingSafeEqual` after a length guard.
  - **Findings closed**: ACTION runs flood check, `findByHostmask` scores matches by specificity instead of first-match-wins, `Permissions.checkFlags` thread `ctx.account` through the command handler. DCC enforces a 4 KiB line-length guard, subscribes to `user:passwordChanged` / `user:removed` to evict live sessions, and validates `port_range` (int 1024-65535, min<=max) and `ip` (IPv4 dotted-quad). BotLink `PROTECT_UNBAN` refuses wildcard-only masks, `PROTECT_INVITE` requires recognition, `relay-handler` re-verifies the handle on every `RELAY_INPUT`. Plugin loader path-traversal guard (`SAFE_NAME_RE` + absPath prefix check); `.flags` requires `+n` to grant `m+`; `.deluser` refuses last-owner deletion; `.adduser` validates handle/hostmask/flags shape and length. `nick_recovery_password` stripped from non-chanmod `PluginBotConfig` view. `parseDuration` clamps to 1 year (avoids `setTimeout` wraparound). `splitMessage` early-truncates oversized input before `Array.from`. Phase 3 hardenings: `sanitizeFrame` capped at 16 levels of recursion, `BotLinkProtocol` decodes through a `KNOWN_FRAME_TYPES` allowlist (with outbound symmetry), `database.logModAction` caps metadata at 8 KiB and scrubs display-bound fields on write, REPL writes a `tryAudit` row on every command, and `index.ts` tracks recoverable socket errors in a 60s rolling window with fatal-exit escalation past 100.
- **2026-04-14 stability audit** (`docs/audits/stability-all-2026-04-14.md`, `tests/stability-audit-2026-04-14.test.ts`): hardens 10 subsystems against the failure modes IRC bots accumulate over months of uptime.
  - **Database**: classify `SqliteError` codes — `BUSY`→degrade, `FULL`→disable writes + fall back to audit sink, `CORRUPT`/`IOERR`→fatal exit 2; added `busy_timeout` pragma; exposed `transaction()` so `permissions.saveToDb` upserts per-record inside a transaction instead of rewriting the whole namespace on every mutation. Mod_log retention is background-pruned in 10k-row batches so a first-run retention flip doesn't block `open()`.
  - **Plugin lifecycle**: `reload` is fail-loud — a failed load after unload emits `plugin:reload_failed` and leaves the plugin unloaded. `teardown()` throwing is a hard stop: the plugin stays in the loaded map so ghost listeners can't double-register on the next reload. Event-bus wrappers around `onModesReady`/`onPermissionsChanged` catch callback throws so one bad plugin can't abort siblings.
  - **Services**: `verifyUser()` deduplicates concurrent callers for the same nick (instead of cancelling and restarting on every duplicate), caps pending verifies at 128, and surfaces `services_timeout_count` / `pending_verify_count` / `cap_rejection_count` in `.status`. DCC + botlink auth trackers cap `banCount` at 8 and decay it by one half-step per hour since last failure, so a legitimate user who typos once a week no longer accumulates an escalating lockout.
  - **BotLink**: leaf handshake deadline (15s) + full jitter on reconnect delay (0.5–1.0× base) to stop thundering-herd reconnects on hub restart. Hub broadcast contains per-leaf write failures rather than cascading; `onSyncRequest` wrapped so a throw always sends `SYNC_END`; `PendingRequestMap` capped at 4096 entries.
  - **Connection lifecycle**: JOIN permanent-failure numerics 473/474/475/477 mark channels as unretriable until reconnect so the presence check stops hammering K-lined channels. 5s socket-destroy deadline after `client.quit()` on registration timeout. Message queue attempts `flushWithDeadline(100ms)` before `clear()` on disconnect.
  - **DCC**: broadcast/announce contain per-session write errors and evict stale sessions mid-loop. Console-flag store dropped on `user:removed`. `server.close()` in listen-error branch. Session-limit check moved after duplicate-eviction so zombie sessions don't permanently lock users out at `max_sessions`.
  - **Plugins**: chanmod `auto-op` wraps `grantMode()` against NickServ lag; `mode-enforce-recovery` unlocks before scheduling the rejoin; Anope `GETKEY` pending map capped at 64. RSS poll-in-progress lock prevents overlap, circuit breaker backs off chronically failing feeds, DNS lookup races a 5s deadline. Flood enforcement rate-caps at 10 actions per 5s per channel to avoid self-K-lines; teardown lifts expired bans. Greeter debounces massjoin floods. Takeover ring buffer bumped from 200 to 1000.
  - **Observability**: `.status` reports `services-timeouts`, `pending-verifies`, `verify-cap-rejected`, `plugins`, and `failed-plugins` via a new `getStabilityMetrics()` hook; `Bot.start()` logs a prominent STARTUP BANNER when plugins fail to load. Dispatcher auto-disables timer binds after 10 consecutive failures.
- **2026-04-14 memleak audit** (`docs/audits/memleak-all-2026-04-14.md`): closes every scheduled finding from the follow-up sweep.
  - **Critical**: flood plugin reuses the leak-safe `SlidingWindowCounter` from `src/utils` (hard key cap + emergency sweep); `handleMsgFlood` keys by hostmask instead of nick to defang nick-rotation amplification; the offence tracker has a 2000-entry LRU cap; chanmod's Atheme `onRecoverCallback` is nulled on teardown with a `clearSharedState` helper so a retained closure can't pin per-channel history.
  - **Warnings**: DCC `dataGuard` is a named reference detached in `clearAllTimers`; `openSession` pre-start error handler is `once()`; `attach()` is idempotent; `DCCAuthTracker` has a 10k-entry cap with oldest-failure eviction. RSS plugin threads a module-level `AbortController` through fetch and the drip-fed announce loop so teardown cancels in-flight work. Flood plugin drops lockdown state on bot part/kick, stops recording flooders while a lock is active, and deletes expired ban records past 24h regardless of ops state. Chanmod inline-prunes `markIntentional` past 10k entries, swaps probe timers to `Set<Timeout>`, and drops recovery state on bot part/kick. Core: `services.cancelPendingVerifies()` fires from `onReconnecting`, memo subscribes to `user:removed` to prune `deliveryCooldown`, botlink leaf calls `stopHeartbeat` inline on timeout, `bot.shutdown()` wraps each substep in try/catch, modlog pager/tail state is drained on DCC close, `connection-lifecycle` clears `presenceTimer` in `onClose`, DCC idle timers are `.unref()`'d.
  - **Architectural**: `createPluginApi` now returns `{ api, dispose }` where `dispose` neutralises every method on the returned api (top-level plus `SUB_API_KEYS` namespaces) so a retained closure post-unload can no longer fan out to the dispatcher, db, or IRC client. `BotEventBus` gains `trackListener(owner, event, fn)` / `removeByOwner(owner)`; plugin-loader drains both via a new shared `cleanupPluginResources` helper so `load()` init-catch and `unload()` can never drift apart. `PluginAPI` gains `offModesReady` / `offPermissionsChanged`. Flood plugin's `EnforcementExecutor` tracks in-flight fire-and-forget actions in a `Set<Promise>` drained by `drainPending()` awaited in teardown.
- **2026-04-14 quality audit** (`docs/audits/quality-all-2026-04-14.md`): god-file splits and cross-cutting dedup with no behaviour change.
  - **God-file splits**: `src/core/dcc/` (auth-tracker, banner, console-flags, protocol with `dcc/index.ts` as the barrel), `src/core/botlink/` (auth, hub, leaf, pending, protect, protocol, relay-handler, relay-router, sharing, sync), `src/core/close-reason-classifier.ts` extracted from `connection-lifecycle.ts`, `plugins/rss/` split into feed-store/feed-fetcher/feed-formatter, `plugins/flood/` split into `RateLimitTracker`/`EnforcementExecutor`/`LockdownController`.
  - **Dedup**: `permissions.ts` exports `VALID_FLAGS`/`OWNER_FLAG`/`MASTER_FLAG` and a `hasOwnerOrMaster()` helper that memo and command flag checks now route through; `botlink/pending.ts` `PendingRequestMap<T>` replaces four parallel hand-rolled Maps; chanmod ChanServ notice parsers share a `resolveProbeForBot()` helper.
  - **M1/M2/M3 closeout**: phased the `Bot` constructor/start; extracted shared helpers across `irc-bridge`, `command-handler`, `channel-state`, `permissions`, `irc-commands`; replaced DCC relay booleans with a state enum; introduced `ListenerGroup`, `command-helpers`, `ModeContext` utilities; split chanmod ban commands and cycle-timer state; flattened botlink handshake; unified relay-not-found; moved protocol/types/rate-counter/cmd-exec/frame-types into their own modules.
- **2026-04-14 testability audit** (`docs/audits/testability-all-2026-04-14.md`): extracted a `LoggerLike` interface so 25 consumers depend on the shape rather than the concrete class; added narrow role interfaces (`BanOperator`, `BindRegistrar` reuse, `AthemeNoticeBackend`/`AnopeNoticeBackend`); exposed botlink hub sub-objects (`auth`, `routes`) as public readonly so LRU / sweep tests can seed state without reaching through `unknown` casts; added `BotDatabase.rawHandleForTests()` and `DCCManager.pending` injection. ~25 of 42 unsafe cast sites removed.
- **Type safety pass across `src/` and `plugins/`** (`src/`, `plugins/`): replaced `any`, `as X`, and `as unknown as T` with type guards and runtime narrowing. Highlights: `ban-store`/`permissions`/`protection` JSON.parse results validated via `isBanRecord`/`isUserRecord`/`isRejoinRecord`; chanmod `cfg<T>()` split into `cfgBool`/`cfgString`/`cfgStringArray` validators that log and fall back when config JSON has the wrong shape; `protection-backend` `BackendAccess` union has a single source of truth (`BACKEND_ACCESS_VALUES` + `toBackendAccess` guard); botlink hub / DCC `eventBusListeners` retyped with `keyof BotEvents` + `never[]` contravariance; `connection-lifecycle` `InternalClient` cast funneled through a single documented `getInternalTlsSocket` helper; RSS Parser generic narrowed to kill `rss-parser`'s default `any` leak.
- **Stalled-reconnect zombie loop fixed** (`src/core/connection-lifecycle.ts`): a 30s registration timeout now fires on the first socket-connected signal. If the IRC `registered` event doesn't arrive in time, the timeout aborts the connection via `client.quit` so the reconnect driver classifies it as transient and applies exponential backoff. Previously, when the server accepted TCP but never sent the IRC greeting (transient IP block, rate limit), the bot waited ~2.5 minutes per attempt for the kernel-level socket timeout — every retry hung the same way, creating an unrecoverable loop. The timeout listens on `connecting` (the earliest reliable hook in irc-framework's lifecycle) so the start-of-window matches the actual TCP attempt.
- **Zombie DCC sessions detected and stray socket errors survived** (`src/core/dcc.ts`, `src/index.ts`, `src/process-handlers.ts`): DCC sessions whose underlying socket entered a half-open state (no FIN, no RST) used to occupy a slot forever and block new connections from the same handle. The DCC manager now detects these via a periodic liveness probe and evicts them. Stray socket errors that previously bubbled out of `setImmediate` callbacks past their `try/catch` are now caught by a process-level `uncaughtException`/`unhandledRejection` handler that logs the error and keeps the bot alive instead of exiting.
- **Service notices reach relayed DCC consoles** (`src/core/dcc.ts`, `src/bot.ts`, `src/core/memo.ts`): the DCC notice/privmsg mirror used to call `announce()` only on _local_ DCC sessions, so a user relayed hub→leaf never saw asynchronous service replies (MemoServ, ChanServ, etc.) arriving on the leaf — they looked like they were being sent to the user as plain IRC notices instead of their DCC/REPL console. `DCCManager` now exposes an `onMirror(line)` callback; `bot.ts` wires it to fan out mirrored lines through every active virtual botlink relay session (`_relayVirtualSessions`), so the remote origin's DCC console receives the same `-MemoServ- …`/`<LimitServ> …` lines a local session would. `MemoManager.relayToOnlineAdmins` also takes a new `hasRelayConsole(handle)` predicate — admins currently relayed into the bot are now skipped alongside local DCC sessions, avoiding the duplicate `[MemoServ] …` IRC notice on top of the DCC mirror.

### Changed

- **NickServ ACC/STATUS replies are no longer mirrored to DCC consoles** (`src/core/services.ts`, `src/core/dcc.ts`): the DCC private-notice mirror used to forward the bot's own internal NickServ permission-verification chatter (e.g. `-NickServ- STATUS alice 3`) into every operator console, making it look like every `!voice` command was being narrated twice. The new `Services.isNickServVerificationReply(nick, msg)` helper suppresses these notices from the mirror. Other services traffic (ChanServ, MemoServ, LimitServ) continues to pass through unchanged.
- **`.who` replaces `.console` as the DCC session-list command.** `.console` is now the console-flags command described above. Existing muscle memory still works via `.who` — only the `.console` alias for the session list was retired.
- **Reconnect loop rewritten** (`src/core/reconnect-driver.ts`, `src/core/connection-lifecycle.ts`, `src/bot.ts`): HexBot now owns the IRC reconnect loop end-to-end. irc-framework's built-in `auto_reconnect` is disabled because it silently gave up when a reconnect reached TCP-connected but failed to complete IRC registration, leaving the process as a zombie (2026-04-13 incident). Disconnects are classified into three tiers: **transient** (ping timeout, TCP hiccup, unknown) retries with 1s→30s backoff; **rate-limited** (K/G-line, DNSBL, Throttled) retries indefinitely with 5min→30min backoff and flips `.status` to `degraded` after 3 consecutive failures; **fatal** (SASL 904/908, TLS cert errors) exits with code 2 so a supervisor can page someone instead of the bot silently locking an account. K-lines and DNSBL blocks no longer cause the bot to exit — they expire on their own, so the bot now recovers automatically. New `Connection:` line in `.status` shows current state, last error, consecutive failure count, and time until next retry.

### BREAKING

- **`chanmod` `channel_modes` legacy format removed** (`plugins/chanmod/helpers.ts`): the parser used to accept an unprefixed string like `"nt"` and treat it as `"+nt"` (additive only). That fallback is gone — values must now start with `+` or `-`. An unprefixed `channel_modes` or `enforce_channel_modes` is rejected at parse time and no enforcement runs for that channel. Update any lingering configs to the Eggdrop-style format, e.g. `"nt"` → `"+nt"`, `"nts"` → `"+nts"`.
- **DCC CHAT now requires per-user passwords** (following the Eggdrop model). The old hostmask-only trust path has been removed. Existing user records have no `password_hash` on file and **will be blocked from DCC until an admin sets one**. Migration:
  1. For each admin in your user database, run `.chpass <handle> <newpass>` from the REPL **before** they next try to connect via DCC. Passwords must be at least 8 characters; they are hashed with scrypt before storage.
  2. In existing DCC sessions, users can rotate their own password with `.chpass <newpass>`. Owners can rotate any user with `.chpass <handle> <newpass>`. `.chpass` is **rejected** over IRC PRIVMSG — passwords never travel over channel messages.
  3. The `dcc.nickserv_verify` config setting is now a **no-op** with a deprecation warning at startup; the new password path supersedes the NickServ gate on every network, not just services-enabled ones. The field will be removed in 0.4.0.

  Rationale: on networks where a single vhost persists across nick changes (notably Rizon), an operator identified on their registered nick can `/nick` to an unregistered nick, keep the same cloak, and bypass DCC auth. The password prompt closes this uniformly — see [docs/DCC.md](docs/DCC.md#authentication-model) and [docs/SECURITY.md](docs/SECURITY.md#34-dcc-chat-authentication--trust-model-split). In-channel flag checks (for `.op`, `.say`, plugin `pub` binds) are unchanged — they keep hostmask + IRCv3 account-tag matching, because prompting on every channel message is not a workable UX.

### Added

- **DCC CHAT password authentication** (`src/core/password.ts`, `src/core/commands/password-commands.ts`, prompt phase in `src/core/dcc.ts`): scrypt-hashed per-user passwords; `.chpass` command (REPL + DCC transports only, IRC path hard-rejected); password prompt with a 30-second idle timer; per-hostmask failure tracker with exponential backoff (`DCCAuthTracker`); migration notice for users with no `password_hash` on file; `user:passwordChanged` event bus event. `UserRecord` gains an optional `password_hash` field that is stripped from the plugin-facing `PublicUserRecord` view so plugins never see secret material.
- **Owner password bootstrap** (`src/core/owner-bootstrap.ts`): `owner.password_env` in `config/bot.json` seeds the owner's DCC password hash on first boot from an env var (e.g. `HEX_OWNER_PASSWORD`). Lifecycle matches `MYSQL_ROOT_PASSWORD` — consumed only when the DB has no hash on file, so `.chpass` rotations persist across restarts. Startup emits a loud warning if DCC is enabled and the owner still has no password set. Closes the chicken-and-egg problem for headless/Docker deployments where `--repl` isn't available.
- **RSS plugin** (`plugins/rss/`): polls RSS/Atom feeds and announces new items to configured channels. Single 60s `time` bind drives all feeds with per-feed interval tracking; SHA-1-based deduplication via the KV store survives restarts; first-run silent seeding prevents backlog floods. Admin commands `!rss list/add/remove/check` (flags `m`) reply via private notice while feed announcements go to channels. Runtime-added feeds persist in KV alongside config-file feeds. Daily cleanup of dedup entries past `dedup_window_days`. New `rss-parser` dependency.
- **`ai-chat` plugin** (`plugins/ai-chat/`): AI-powered chat via Gemini (free tier). Features provider adapter pattern, layered rate limiting, per-user token budgets, sliding-window context, multiple personality presets, per-channel/language overrides, on-demand game sessions (ships with 20 Questions + Trivia), and ChanServ fantasy-command injection defense.
- `--env-file-if-exists=.env` flag added to `pnpm start` / `pnpm dev` for loading API keys from a `.env` file (Node 20.6+ built-in, no dotenv dep).
- `d` (deop) permission flag — elective flag that suppresses auto-op/halfop on join without revoking privileges; user can still `.op` themselves or be opped manually; mode enforcement and bitch mode respect `+d`; auto-voice still works with explicit `+v`
- Per-plugin channel scoping via `channels` array in `plugins.json` — restricts a plugin to specific channels
- Greeter help now documents `{nick}` and `{channel}` substitution variables and sub-command help for `!greet set` and `!greet del`
- Secrets live in `.env`, referenced from `bot.json` via `<field>_env` suffix keys. Startup validates every required secret for enabled features and fails loudly with the exact env var name when one is missing. Plugin configs support the same `_env` pattern — the loader resolves values before plugin `init()` runs, so plugins never touch `process.env`.
- Per-IP auth brute-force protection on BotLink hub: failure tracking with escalating bans (5min → 24h cap), CIDR whitelist, per-IP pending handshake limit, configurable handshake timeout (10s default), `auth:ban`/`auth:unban` EventBus events, source IP in all auth log lines
- ChanServ-assisted join error recovery: when the bot can't join a channel (banned, invite-only, bad key), chanmod asks ChanServ for help and retries with exponential backoff (30s → 5min cap). New `join_error` dispatcher event type for 471/473/474/475/477 numerics.
- `getChannelKey()` added to PluginAPI — plugins can look up configured channel keys for keyed (+k) channels
- **ISUPPORT parser (`src/core/isupport.ts`)**: typed `ServerCapabilities` snapshot parsed on every `registered` event. Covers `PREFIX`, `CHANMODES` (A/B/C/D buckets), `MODES`, `CHANTYPES`, `TARGMAX`, and `CASEMAPPING`. Exposes `expectsParam(char, dir)` and `isValidChannel(name)` helpers. `ChannelState`, `IRCCommands`, and `IRCBridge` now hold capability snapshots, so prefix-mode tracking, mode-batch param allocation, and channel validation all follow whatever the connected IRCd actually advertises — no more hardcoded assumptions.
- **IRCv3 away-notify tracking**: `UserInfo.away`/`awayMessage` fields, `onAway` handler with multi-channel fan-out, new `channel:awayChanged` event.
- **IRCv3 account-tag consumption**: `ctx.account` is populated on every `privmsg`/`notice` when the cap is active; the account is also fed into `ChannelState.networkAccounts` so the dispatcher's verification fast-path stops issuing NickServ ACC queries on tagged messages.
- **Account-pattern permissions (`$a:accountname`)**: `UserRecord.hostmasks` entries prefixed with `$a:` match the services account via the new `ChannelState` account lookup. Patterns are case-insensitive under the connected CASEMAPPING and support wildcards. `Permissions.checkFlags` prefers `ctx.account` over the cached lookup when both are available.
- **IRCv3 Strict Transport Security (`src/core/sts.ts`)**: parses `sts=` cap values (plaintext and TLS form), persists policies in the `_sts` SQLite namespace, and enforces them at connect time. Plaintext sessions with a stored policy either auto-upgrade to the recorded TLS port or abort startup; plaintext ingestion with a port directive triggers an immediate reconnect to TLS.
- **Configurable command prefix**: new `command_prefix` field in `config/bot.json` (default `"."`). `CommandHandler` threads the prefix through parsing, unknown-command errors, and help output. Plugin-owned command binds continue to choose their own prefixes — this setting is scoped to `CommandHandler`.
- **Per-target message queue**: `MessageQueue` split into per-target FIFO sub-queues with round-robin drain so a flooding target can't starve output to quieter ones. `enqueue(target, fn)` is the new API. ISUPPORT `TARGMAX` surfaced via `setTargmax`/`getTargmax` for plugin introspection.
- **Cross-dialect ISUPPORT test matrix** (`tests/core/dialect-matrix.test.ts`): real `005` fixtures for Solanum/Libera, InspIRCd, UnrealIRCd, and ngIRCd (IRCnet-style) exercising the parser and `ChannelState` NAMES handling end-to-end.

### Changed

- **Breaking:** `config/bot.json` no longer accepts inline secrets. `services.password`, `botlink.password`, `chanmod.nick_recovery_password`, `proxy.password`, and per-channel `+k` keys must now be referenced via `<field>_env` fields. See the migration guide.
- **Breaking:** `MessageQueue.enqueue(fn)` → `MessageQueue.enqueue(target, fn)`. Every call site in core threads the IRC target through; plugin code that uses the `api.say` / `api.notice` / `api.action` / `api.ctcpResponse` helpers is unaffected because the wrappers are updated.
- `Permissions.findByHostmask(fullHostmask)` → `findByHostmask(fullHostmask, account?)`. The spoofable `findByNick` method has been removed; `core/botlink-protect.ts`'s `PROTECT_OP`/`DEOP`/`KICK` guards now resolve the target's full hostmask + account via `ChannelState` and call `findByHostmask` instead.
- `ChannelSettings` now takes an injected `ircLower` case-folder and stores records under the folded channel key so `#Foo` and `#foo` resolve to the same value. Reads fall back to the raw-cased legacy key for pre-normalisation databases; `unset()` deletes both variants.
- `IRCCommands.mode()` walks each direction segment and consults `ServerCapabilities.expectsParam()` so mixed flag + param calls like `+mo alice` and `+ko secretkey alice` work in a single call. Mixed-direction mode strings (`+o-v a b`) are now split into one MODE line per direction.
- `ChannelState` handles the `away`/`back` events, `setAccountForNick` updates, and the new `clearNetworkAccounts()` reconnect hook. `parseUserlistModes()` accepts the array shape irc-framework actually emits (the old `typeof === 'string'` guard silently dropped every NAMES prefix).

### Fixed

- **Memory leak audit** (full codebase, see `docs/audits/memleak-all-2026-04-12.md`):
  - `SlidingWindowCounter` stale keys never evicted — added `sweep()` method; dispatcher and flood plugin invoke it periodically to prune hostmask keys whose timestamps have expired
  - `MemoManager.detach()` did not unbind dispatcher binds or unregister the `.memo` command — each attach/detach cycle accumulated duplicate handlers
  - Plugin loader did not clean up on partial `init()` failure — if `init()` threw, teardowns, help entries, channel settings, and event bus listeners from the failed load leaked; now the loader drains all partial state before re-throwing
  - `ChannelState.channels` Map never pruned on self-PART/KICK — stale channel entries accumulated when the bot left channels; added `setBotNick()` and self-detection in PART/KICK handlers
  - `ChannelState.networkAccounts` never pruned on PART — nicks that left all shared channels without QUITting persisted until reconnect; now evicted when the nick leaves all tracked channels
  - BotLink hub `setCommandRelay()` registered 5 anonymous eventBus listeners with no removal path — stored refs and remove them in `close()`
  - BotLink hub `close()` did not clear `remotePartyUsers`, `activeRelays`, `protectRequests`, `cmdRoutes`, or `pendingCmds` — pending promises now resolved with error before clearing
  - BotLink hub `protectRequests`/`cmdRoutes` had no TTL — unanswered entries persisted forever; added timestamps and 30s sweep in the heartbeat tick
  - BotLink leaf `pendingCmds`/`pendingWhom`/`pendingProtect` not flushed on disconnect — stale closures held for up to 10s; now resolved and cleared immediately on disconnect/reconnect
  - BotLink relay virtual sessions had no orphan cleanup — sessions persisted if `RELAY_END` never arrived; now cleaned on `botlink:disconnected`
  - Connection lifecycle startup retry `setTimeout` not stored — callback could fire after shutdown; timer ID now stored and cancellable via `cancelStartupRetry()`
  - Connection lifecycle listeners registered as anonymous closures with no removal path — refactored to tracked named listeners with `removeListeners()` on the handle
  - DCC `readline` interface not explicitly closed — stored as class member and closed in `close()`/`onClose()`
  - DCC server error handler missing `clearTimeout` for pending offer timer — timer held closure references for 30s after error
  - Flood plugin `offenceTracker` Map never pruned — expired entries now swept every 60s via the existing `time` bind
  - Flood plugin `lockFlooders`/`lockFloderTimestamps` not cleaned for channels without active lockdowns — swept alongside offence tracker
  - Chanmod `intentionalModeChanges`/`enforcementCooldown` Maps never pruned during runtime — added `pruneExpiredState()` called every 60s
  - Chanmod `enforcementTimers`/`cycleTimers` arrays grew monotonically — changed to Sets with self-removing callbacks
  - BotLink protocol `readline` interface not explicitly closed — stored and closed in `close()`
  - BotLink `MaskList` never pruned empty channel keys — channel key now deleted when its entry list becomes empty
  - BotLink auth tracker only swept stale entries on incoming connections — added periodic 5-minute sweep timer
- Hub-originated `.relay` sessions received no output — the hub never registered itself in `activeRelays` and `routeRelayFrame` tried to `send()` return traffic to the hub's own botname (which isn't in the `leaves` map), silently dropping all `RELAY_OUTPUT`/`RELAY_ACCEPT`/`RELAY_END` frames
- `+d` flag ignored by mode enforcement, bitch mode, mass reop, and stopnethack — a `+od` user was re-opped by enforcement after being deopped, allowed through bitch mode, re-opped during takeover recovery, and treated as legitimate during netsplit ops checks; all four paths now respect `+d`
- Plugins listed in `plugins.json` without `"enabled": true` were incorrectly skipped; now only `"enabled": false` disables a plugin
- **§A.3 P0**: `ChannelState.parseUserlistModes` dropped every user's prefix modes on NAMES because `irc-framework` ships `modes` as a `string[]`, not a string. Every plugin checking "is this user an op?" got a wrong answer for the pre-existing userlist until a subsequent MODE event landed.
- **§1 P0**: `splitMessage` counted JavaScript UTF-16 code units instead of UTF-8 bytes and could slice mid-surrogate. Emoji / Japanese / Cyrillic messages silently truncated on the wire. Replaced with a byte-aware, code-point-iterating splitter; ellipsis truncation now trims the tail so `" ..."` never overflows the budget. New `reservedBytes` parameter covers CTCP `\x01…\x01` wrapper overhead.
- **§2 P0**: `IRCCommands.mode()` treated `-` as a mode char on mixed-direction input (`+o-v a b`) and silently dropped params on mismatch (`+oo a` → dropped second `o`). Both bugs fixed with per-direction segmentation + explicit count check.
- **§5 P0**: Bot refused to start when `services.sasl_mechanism === 'PLAIN'` and `irc.tls !== true`, closing the cleartext NickServ password leak. `EXTERNAL` (CertFP) remains an out.
- **§7 P0**: `Permissions.findByNick` matched the stored pattern against just the nick portion, so any `nick!*@*` record could be spoofed by an attacker who adopted that nick from a different host. Deleted and replaced with full `findByHostmask(host, account?)` lookups throughout `botlink-protect`.
- **§11 P1**: CTCP response rate limiter was keyed on bare nick, letting a nick-rotation attack bypass the 3-per-10s budget. Rekeyed to `ident@host` (the persistent portion of the identity).
- **§3 P2**: `ChannelState` stored `NaN` in `ChannelInfo.limit` when a server advertised a non-numeric `+l` param. Clamped to `0`.
- **§9 P1**: Connection lifecycle now classifies the server's `ERROR :Closing Link (...)` reason. K/G/Z-line and DNSBL responses exit non-zero immediately (no more 10-retry hammering); throttle-class responses apply a 4× longer backoff multiplier. `CASEMAPPING` warns on unknown advertised values (e.g. `rfc7613`) instead of silently falling back to `rfc1459`.
- **§12 P1**: `ChannelSettings` channel-keyed DB writes now go through the injected `ircLower`, closing a latent bug where `#Foo` and `#foo` stored as separate records.

## [0.2.3] - 2026-04-04

### Added

- Startup retry with exponential backoff for initial connection failure
- ChanServ auto-detect and merged chanserv_op into chanserv_access

### Changed

- Refactored botlink, mode-enforce, and bot.ts for readability
- Enhanced connection error handling to log detailed disconnect reasons

### Fixed

- IRC connection failure in Docker over WireGuard by disabling Node's Happy Eyeballs algorithm

## [0.2.2] - 2026-04-03

### Changed

- Simplified Dockerfile to single-stage build using tsx at runtime instead of compiling to JS
- Moved tsx from devDependencies to dependencies
- Removed `start:prod` script — `pnpm start` is the single entry point

## [0.2.1] - 2026-04-03

### Added

- Getting Started guide (`docs/GETTING_STARTED.md`)

### Changed

- README overhauled: highlights section, full admin/bot-link/DCC command tables, documentation index
- Comprehensive doc sync: DESIGN.md, PLUGIN_API.md, DCC.md, plugins/README.md updated to match current codebase
- Healthcheck heartbeat uses `utimesSync` instead of writing unused file content

### Fixed

- Docker build failure: `husky` prepare script ran during `--prod` install and failed because husky is a devDependency

## [0.2.0] - 2026-04-02

### Added

- **Bot linking protocol**: hub-and-leaf multi-bot networking inspired by Eggdrop botnet. Hub accepts leaf connections over TCP with JSON-framed protocol, SHA-256 password authentication, heartbeat/timeout, and rate limiting. See `docs/BOTLINK.md` for the full user guide.
  - **State sync**: hub pushes permissions, channel state, and shared ban/exempt lists to leaves on connect; permission mutations broadcast in real-time via `ADDUSER`/`DELUSER`/`SETFLAGS` frames
  - **Command relay**: leaf bots forward flagged commands to hub for execution; hub verifies permissions and returns results
  - **Party line chat**: DCC console messages bridged across all linked bots via `PARTY_CHAT`/`PARTY_JOIN`/`PARTY_PART` frames
  - **Session relay**: `.relay <botname>` (DCC-only) proxies a console session to a remote bot
  - **Protection frames**: `PROTECT_TAKEOVER`/`PROTECT_REGAIN` let bots request cross-network channel protection from peers
  - **Ban sharing**: per-channel `shared` setting syncs ban/exempt lists across linked bots with optional enforcement
  - **Admin commands**: `.botlink status|disconnect|reconnect`, `.bots`, `.bottree`, `.relay`, `.whom`
- **Persistent channel rejoin**: the bot now periodically checks (every 30s by default) that it is in all configured channels and attempts to rejoin any it is missing from — handles kick+ban, channel full, invite-only, bad key, and any other join failure that previously left the bot permanently locked out until reconnect. Configurable via `channel_rejoin_interval_ms` in `bot.json` (set to `0` to disable)
- **Enforce unauthorized `+k`/`+l` removal**: when `enforce_modes` is on and no `channel_key`/`channel_limit` is configured, the bot now removes unauthorized `+k` and `+l` mode changes — both reactively (real-time) and proactively (on join via RPL_CHANNELMODEIS)
- **Channel mode tracking in channel-state**: `ChannelInfo` now tracks the channel mode string, key, and limit; updated from `MODE` events and the `channel info` (RPL_CHANNELMODEIS) reply; new `channel:modesReady` event on the internal event bus
- **`requestChannelModes(channel)`** on PluginAPI: sends `MODE #channel` to query the server; response populates channel-state and fires `channel:modesReady`
- **`onModesReady(callback)`** on PluginAPI: register a callback for when channel modes are received from the server; auto-cleaned on plugin unload
- **Proactive mode sync on join**: bot sends `MODE #channel` on join; `syncChannelModes()` chains to `channel:modesReady` instead of a timer, guaranteeing channel-state is populated before enforcement runs
- **ChanServ-based channel takeover protection** in `chanmod`: detects unauthorized mass deop/mode changes and responds with configurable escalation (deop, kickban, akick); supports ChanServ backend for persistent akick; rate-limited hostile response tracking per actor
- **Dockerfile multi-stage build**: separate build and production stages for smaller images; Docker healthcheck added for orchestration tools
- **Plugin config and channel settings validation**: unknown or invalid config keys and channel setting values are now rejected on load with descriptive errors

### Fixed

- **`chanserv_op` broken on networks where ChanServ doesn't join channels** (e.g. Rizon): the OP request was gated on ChanServ being present in the channel user list; now always sends the request when `chanserv_op` is enabled, with a diagnostic log note when ChanServ isn't visible
- **DCC TOCTOU race**: rapid duplicate DCC CHAT requests could bypass the session-exists check because the pending map was not consulted; now rejects when a connection is already pending for the same nick
- **`!seen` cross-channel information disclosure**: queries from a different channel than where the user was last seen now omit the channel name and message text, showing only the nick and relative time
- **Zombie process on exhausted reconnects**: bot now exits cleanly when maximum reconnect attempts are reached instead of hanging indefinitely
- **Bot-link security hardening**: fixed 1 critical and 5 warning findings from bot-link security audit (permission bypass, frame validation, rate limiting)
- **Codebase security audit**: fixed 8 additional warnings identified in full-codebase security sweep

### Changed

- **`channel_modes` now uses Eggdrop-style additive/subtractive format**: `"+nt-s"` means "ensure `+n` and `+t` are set, ensure `+s` is removed, leave everything else alone." Modes not mentioned are no longer treated as unauthorized. Old format (`"nt"`) auto-detected and treated as `"+nt"` (additive only, no removals)
- `enforce_modes` now gates both sides: when off, neither `+` additions nor `-` removals run
- `CHANMODES` ISUPPORT token now exposed via `getServerSupports()`; parameter modes dynamically determined from CHANMODES categories A/B/C (hardcoded `k`/`l` fallback retained)
- `syncChannelModes()` now removes unauthorized simple modes, keys, and limits (previously only added missing ones)
- `channel_key` and `channel_limit` setting descriptions updated to clarify that empty/zero means "remove unauthorized" when `enforce_modes` is on
- `nick_recovery_password` moved from `chanmod` plugin config to `bot.json` services block
- `v8 ignore` pragmas removed across codebase — previously hidden branches now covered by real tests
- DI interfaces extracted to eliminate unsafe type casts in tests; 33 unsafe test casts replaced
- `chanmod` hostile response: `kickban` and `akick` paths consolidated to reduce duplication
- Dependency bump: typescript-eslint 8.57.2 → 8.58.0

## [0.1.0] - 2026-03-29

### Added

- **`chanmod` channel key and limit enforcement**: `channel_key` (string) and `channel_limit` (int) per-channel settings enforce `+k` and `+l` when `enforce_modes` is on — re-applied if removed or changed to a different value; `enforce_channel_key` and `enforce_channel_limit` global config defaults added alongside the existing `enforce_channel_modes`
- `chanmod` README: new "Per-channel settings (.chanset)" section documents all `.chanset`-configurable keys with syntax examples; "Channel mode enforcement" subsection updated to cover all supported modes (`+imnpst`, `+k`, `+l`) in a unified table
- **INVITE handling**: `invite` BindType added to dispatcher and irc-bridge; core registers a bind that auto-rejoins any configured channel on invite (key-aware, no permission check); `chanmod` `invite` per-channel setting (default off) accepts invites from users holding `o`/`m`/`n` flags by matching the sender's hostmask directly against the permissions DB — no shared channel required
- **ChanServ OP recovery in `chanmod`**: new `chanserv_op` per-channel setting (default off); when enabled, sends `PRIVMSG ChanServ :OP <channel>` to recover ops when the bot is deopped; `chanserv_nick` (default `ChanServ`) and `chanserv_op_delay_ms` (default `1000`) global config fields added; also moves `revenge` into per-channel settings; `.chanset <channel>` with no key lists all registered settings
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
- Deployment tooling — Docker + docker-compose, GitHub Actions CI/CD, systemd unit guide
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
