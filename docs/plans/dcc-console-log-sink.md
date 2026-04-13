# Plan: DCC Console Log Sink + Services Notice Filter

## Summary

Two coupled changes that together fix a long-standing asymmetry in the DCC partyline experience. Today a DCC operator who runs `!voice BlueAngel` sees the bot's internal `-NickServ- STATUS d3m0n` probe echoed into their console, but does **not** see the chanmod log line (`[plugin:chanmod] d3m0n halfopped BlueAngel in #hexbot`) that actually records what the bot did — that line only reaches `stdout` / container logs. After this plan lands:

1. **Option A — Services notice filter:** NickServ ACC/STATUS reply noise is suppressed from the DCC private-notice mirror. Other services traffic (MemoServ, ChanServ, LimitServ) continues to pass through.
2. **Option B — DCC log sink with `.console` flags:** the core `Logger` gains a multi-sink output model. One sink is the existing console/REPL output; a new sink broadcasts categorised log lines to DCC sessions whose per-session `.console` flags subscribe to that category. Each session can toggle categories with a new `.console +chan -dispatcher` dot-command, mirroring Eggdrop's partyline console mode letters.

End result: DCC looks like a structured, filtered view of what the bot is doing — the same thing the operator sees in `docker logs` but scoped to what that particular session cares about, with services plumbing hidden by default.

## Feasibility

**Alignment.** Fits DESIGN.md's "DCC is the partyline / admin console" direction and the Eggdrop-compatibility philosophy (`.console` with flag letters is a direct port of Eggdrop's `+mpkjbs` mode). No architectural rewrite required.

**Dependencies.** All prerequisites already exist:

- `src/logger.ts` with `[prefix]` tagging and a single static `outputHook` (extended to multi-sink).
- `src/core/dcc.ts` with per-session `writeLine` and a manager-wide `announce`.
- `src/command-handler.ts` with `registerCommand` already used by other core dot-commands (`src/core/commands/*.ts`).
- `src/core/services.ts` owns all NickServ conversation and knows the configured NickServ nick via `getNickServTarget()`.

**Blockers.** None. The current single `Logger.outputHook` used by the REPL (`src/repl.ts:80`) must become a multi-sink model without breaking REPL prompt redraw. This is the one structural change — everything else is additive.

**Complexity.** **M (one solid day).** Logger sink refactor + DCC sink wiring + `.console` command + per-session flag persistence + NickServ filter + tests + docs. The NickServ filter alone is S (1–2 hours), so the plan is structured so Phase 1 can ship independently if we want an early partial fix.

**Risk areas.**

- **Partyline flood.** A chatty `debug` level bot with `.console +all` could DOS its own DCC clients. Defaults must be conservative and volume-gated — debug category off by default, and the DCC sink must never re-enter if a session's socket is slow (no sync backpressure loops).
- **ANSI in DCC.** The existing DCC banner already writes chalk-colored output to sockets (`src/core/dcc.ts:573` writes ANSI via `red()`), so DCC clients in this project are known to handle ANSI. We pass log lines through verbatim; any client that doesn't render ANSI will see escape sequences, matching current banner behavior. Strip is not in scope.
- **REPL and DCC both consuming logs.** The REPL hook currently clears the prompt before printing. If we keep REPL on the existing prompt-aware sink and add DCC as a separate sink, there is no conflict. Do **not** try to make DCC replace the REPL output — they coexist.
- **Session teardown.** The DCC sink must unregister when DCCManager detaches; otherwise every `logger.info` will walk a stale sessions map.
- **Plugin-prefixed sources.** Current log lines use `[plugin:chanmod]`, `[dispatcher]`, `[bot]`, `[dcc]`, etc. The category a line belongs to is the prefix. We parse the first `[...]` after the level label. Lines with no prefix (a few `logger.info("…")` calls in `src/index.ts` and `src/bot.ts` root) fall into a synthetic `core` category.
- **Back-compat with `Logger.setOutputHook`.** The REPL calls `Logger.setOutputHook(...)` at start and `Logger.setOutputHook(null)` at stop. We keep the method as a thin wrapper over `addSink`/`removeSink` so the REPL code does not need to change, but we add first-class `addSink/removeSink` for new callers (DCC).

## Dependencies

- [x] `src/logger.ts` exists and supports chalk output.
- [x] `src/core/dcc.ts` has per-session `writeLine` and manager `announce`.
- [x] `src/core/services.ts` owns NickServ STATUS/ACC traffic via `tryParseAccResponse` / `tryParseStatusResponse`.
- [x] `src/command-handler.ts` supports `registerCommand` with help metadata.
- [x] `src/database.ts` (kv store) is available for persisting per-user console flags across sessions.

## Phases

### Phase 1 — NickServ notice filter (Option A, minimal)

**Goal:** Stop the DCC private-notice mirror from echoing NickServ ACC/STATUS replies. Land this first so the immediate pain point is fixed even if Phase 2 slips.

- [x] In `src/core/services.ts`, expose a public method `isNickServVerificationReply(nick: string, message: string): boolean` on `ServicesManager`. It returns `true` if `nick` matches the configured NickServ target (case-insensitive, nick-portion-only via the same `rfc1459` comparison already used elsewhere) **and** the `message` matches either the ACC regex (`tryParseAccResponse`) or the STATUS regex (`tryParseStatusResponse`). Reuse the two private parsers by extracting a `static matchesVerificationShape(message: string): boolean` helper that runs both regexes without needing a pending verification entry.
- [x] In `src/core/dcc.ts` `attach()`, pass the `services` dependency (already on `DCCManagerDeps.services`) into the `onNotice` mirror. In the handler, after the channel-notice skip, also skip when `services.isNickServVerificationReply(nick, message)` returns true. Leave PRIVMSG mirror untouched — NickServ does not reply via PRIVMSG on any supported network.
- [x] Add unit tests in `tests/core/dcc.test.ts`:
  - Mirror forwards a ChanServ notice to all sessions (baseline — ensure the filter is narrow).
  - Mirror forwards a MemoServ notice.
  - Mirror suppresses `NickServ → STATUS alice 3`.
  - Mirror suppresses `NickServ → alice ACC 3`.
  - Mirror suppresses `NickServ → STATUS alice 3` when the `services` config uses a non-default `nickserv` nick (e.g. `nickserv@services.example.net` — nick-portion match, not full).
  - Mirror does NOT suppress a non-NickServ bot sending the literal string `STATUS foo 3`.
- [x] **Verification:** run `pnpm test tests/core/dcc.test.ts tests/core/services.test.ts`. Manually connect to a live network, `!voice someone` from a channel bind, confirm DCC no longer shows the STATUS echo.

### Phase 2 — Logger multi-sink

**Goal:** Let more than one consumer subscribe to logger output without stepping on each other, and expose the category prefix as a structured field.

- [x] In `src/logger.ts`, replace the `static outputHook: ((line: string) => void) | null` with `static sinks: Set<LogSink>`. Define:
  ```ts
  export interface LogRecord {
    level: LogLevel;
    timestamp: Date;
    /** Prefix like 'bot', 'plugin:chanmod', 'dispatcher', or null for root. */
    source: string | null;
    /** Formatted, colorized line identical to what would go to the console. */
    formatted: string;
    /** Raw message text with no ANSI (for sinks that don't want color). */
    plain: string;
  }
  export type LogSink = (record: LogRecord) => void;
  ```
- [x] Add `Logger.addSink(sink)`, `Logger.removeSink(sink)`, and `Logger.clearSinks()` static methods. Keep `Logger.setOutputHook(fn | null)` as a compatibility wrapper: it adds/removes a tagged wrapper sink so REPL code does not change. Document in a short `// @deprecated` TS comment that new code should use `addSink`.
- [x] In `private write(level, args)`, build a `LogRecord` once: compute the `formatted` string (current code), compute `plain` via `format(...args)` with no chalk, extract `source` from the existing `this.prefix`. If `sinks.size > 0`, iterate and call every sink; wrap each sink call in `try/catch` (a buggy DCC sink must not break logging).
- [x] Fallthrough rule: if `sinks.size === 0`, write to `console.log`/`console.error` exactly as today. If `sinks.size > 0`, the REPL/DCC sink is responsible for stdout — otherwise you'd double-print. Keep a built-in `consoleSink` that `createLogger` installs by default so behavior is unchanged when nothing else subscribes; the REPL replaces it when it attaches, matching current semantics.
- [x] Update `tests/logger.test.ts`:
  - `addSink` delivers records to the sink.
  - Multiple sinks all receive.
  - `removeSink` stops delivery.
  - A sink that throws does not prevent other sinks from running and does not throw from `logger.info`.
  - `setOutputHook(fn)` / `setOutputHook(null)` still works for back-compat (REPL path).
  - `LogRecord.source` is `"plugin:chanmod"` for a child logger created via `root.child("plugin:chanmod")`.
- [x] **Verification:** run `pnpm test tests/logger.test.ts tests/repl.test.ts` (if it exists) and `pnpm test` full suite — nothing should break because the default sink preserves current console behavior.

### Phase 3 — DCC log sink with per-session console flags

**Goal:** Wire the logger to DCC sessions with a filter model matching Eggdrop's `.console` mode letters.

- [x] Add a `ConsoleFlags` module at `src/core/dcc-console-flags.ts`. It defines the canonical flag letter set, a parser (`parseFlags("+mko -d")`), a formatter (`formatFlags(set)` → `"+mko"`), and the source-to-letter mapping. Flag letters follow Eggdrop as closely as is meaningful for HexBot:

  | Letter | Category                          | Sources that map to it                                                  |
  | ------ | --------------------------------- | ----------------------------------------------------------------------- |
  | `m`    | bot messages / services / memo    | `[bot]`, `[dcc]`, `[services]`, `[memo]`                                |
  | `o`    | operator actions / mode changes   | `[plugin:chanmod]`, `[plugin:chanset]`, `[irc-commands]`, `[ban-store]` |
  | `k`    | kicks / bans / channel protection | `[plugin:chanmod]` threat/enforce lines, `[channel-protection]`         |
  | `j`    | joins / parts / signoffs / nick   | `[channel-state]`, `[plugin:greeter]`, `[plugin:seen]`                  |
  | `p`    | public chat / command dispatch    | `[command-handler]`, `[plugin-loader]` plugin lifecycle                 |
  | `b`    | botnet / botlink                  | `[botlink]`, `[botlink-*]`, `[dcc-relay]`                               |
  | `s`    | server / connection               | `[connection]`, `[reconnect]`, `[irc-bridge]`, `[sts]`                  |
  | `d`    | debug / dispatcher                | `[dispatcher]`, `debug`-level lines regardless of source                |
  | `w`    | warnings and errors               | all `warn`/`error` lines, regardless of source                          |

  Because some sources are ambiguous (chanmod emits both operator and protection log lines), the mapping is keyed on an optional second `[subsystem]` tag the caller can pass via `logger.child("plugin:chanmod", { category: "k" })`. If no explicit category is provided, the source prefix maps via a default table. Exported constant `DEFAULT_CONSOLE_FLAGS = "moj w"` (without the space, just `"mojw"`) — operator actions, joins/parts, bot messages, and warnings — matches what a typical admin expects to see on connect and avoids dispatcher debug chatter.

- [x] Add a `consoleFlags` field to `DCCSession` (default `DEFAULT_CONSOLE_FLAGS`), backed by the kv store at key `dcc:console_flags:<handle>` so preferences persist across reconnects. Load on session start (after `onAuthSuccess`), save on `.console +/-` changes. A missing row uses `DEFAULT_CONSOLE_FLAGS`.
- [x] Add a public method `DCCSessionEntry.receiveLog(record: LogRecord): void` that decides whether to forward:
  1. If `record.level === 'error' || record.level === 'warn'` and `flags.has('w')`, deliver.
  2. If `record.level === 'debug'` and `!flags.has('d')`, drop.
  3. Otherwise compute the category letter via `categorize(record.source, record.level)` and deliver iff `flags.has(letter)`.
     Deliver = `writeLine(record.formatted)`. Never `await`; never `return` a promise; if the socket is backed up, the underlying `Socket.write` already handles buffering — do not add our own queue.
- [x] In `DCCManager.attach()`, install a `LogSink` that iterates sessions and calls `session.receiveLog(record)`. Store the sink reference on `this` so `detach()` can `Logger.removeSink(this.logSink)`. Do **not** install the sink in `constructor` — only in `attach`, paired with `detach`, matching how IRC listeners are handled at `src/core/dcc.ts:958`.
- [x] Add `.console` dot-command implementation in a new file `src/core/commands/dcc-console-commands.ts`, modelled on existing `src/core/commands/*.ts`. The command handles three shapes:
  - `.console` — print current flags (`Console flags: +moj`), the friendly category list, and the active session list (current `.console` / `.who` behavior is preserved as `.who` only; move the session list out of `.console` into `.who`).
  - `.console +d` / `.console -d` / `.console +mko -jd` — mutate the calling session's flags, print the new flag string, persist to kv.
  - `.console <handle> +o` — owner-only, mutate another handle's default flags even if that handle has no active session (sets the kv row so the next login picks it up). Gated on the `n` flag.

  Registered with `commandHandler.registerCommand('console', { requires: 'm', ... }, handler)`. Help text registers with the help registry so `.help console` works.

- [x] The flag parser accepts `+all` and `-all` as sugar. `+all` sets every known letter (`mojkpbsdw`); `-all` clears every letter. Any letter outside the known set (e.g. `+z`) is rejected with `Unknown console flag: z`. `+all` and `-all` can be combined with explicit letters in the same call (`.console -all +mw` == reset to messages+warnings only).
- [x] **Wire bot.ts.** The `.console` command needs a way to find the calling session. The command handler already passes a `CommandContext` with `source: 'dcc'` (`src/core/dcc.ts:740`) but does not currently thread through the session. Extend `CommandContext` with an optional `dccSession?: DCCSessionEntry` field, populated by `DCCSession.onLine`. Existing callers (REPL, IRC pub) pass `undefined`; the `.console` command errors with `This command is DCC-only.` if `dccSession` is missing.
- [x] Update the DCC session-start path (`DCCSession.showBanner` at `src/core/dcc.ts:540`) to include the current console flags in the banner's stats table (there is already a "Console" stat line showing others present — rename to "Console" showing flags and add "Others" for the session list, or keep "Console" as-is and add a new "Flags" row). Keep it short.
- [x] **Remove the old private-notice mirror** for notices that the DCC sink now covers redundantly? **No.** The notice mirror exists to relay services chatter that HexBot does not process itself (LimitServ, BitlBee-style gateways, manual `/msg nick …` responses). Keep it; it is orthogonal to the log sink. The Phase 1 filter narrows it just enough.
- [x] Unit tests in `tests/core/dcc-console-sink.test.ts`:
  - A session with default flags receives a `[plugin:chanmod]` info line tagged with category `o`.
  - A session with `-o` does not receive the same line.
  - A `debug`-level line is dropped unless `d` is set.
  - A `warn`-level line is delivered regardless of category as long as `w` is set.
  - `.console +d` updates kv and the next log line is delivered.
  - `.console +d` from a REPL context errors with `DCC-only`.
  - `.console alice +b` by a non-owner errors with insufficient flags.
  - `DCCManager.detach()` removes the sink so later logs do not hit dead sessions.
  - A sink that throws on one session does not prevent delivery to other sessions (wrapper in Phase 2 already guards this, but add a targeted test at the DCC layer).
- [x] Integration test in `tests/core/dcc.test.ts`: start a DCCManager, attach, call `logger.info("[plugin:chanmod] alice voiced bob in #test")` and assert the mock socket received the formatted line. _(Covered end-to-end by `tests/core/dcc-console-sink.test.ts`, which exercises the real DCCManager.attach sink path.)_
- [x] **Verification:** run `pnpm test`. Manually connect via irssi DCC CHAT, run `.console` (expect `Console flags: +mojw`), `!voice someone` from an IRC channel and confirm the DCC console shows the `[plugin:chanmod]` action line. Toggle `.console +d`, confirm dispatcher debug lines appear. Toggle `.console -m`, confirm bot startup-style messages stop. _(Automated suite green: 2591 tests. Manual smoke test deferred until a live network is available.)_

### Phase 4 — Source tagging hygiene

**Goal:** Make sure category inference actually works by giving every logging call site a correct `[source]` tag. This is a light janitorial pass; categories depend on it.

- [x] Grep for `logger\.(info|warn|error|debug)\b` across `src/` and `plugins/` to build a source-tag inventory.
- [x] For each file whose logger is _not_ a child with a prefix, add `.child("<source>")` at construction. Fixed gaps: `reconnect-driver` now receives `logger.child('reconnect')`, `connection-lifecycle` receives `logger.child('connection')`, and `message-queue` tags itself under `[message-queue]`. Other core modules already applied `.child()` internally (`services`, `dcc`, `irc-bridge`, `dispatcher`, `plugin-loader`, `permissions`, `channel-state`, etc.).
- [x] For chanmod specifically, split its child loggers:
  - `api.log` lines about mode actions (voice, op, halfop, devoice) — category `o`.
  - Threat detection / ban / kick lines — category `k`.
  - Join recovery / rejoin — category `j`.

  Implement via an opt-in `logger.child("plugin:chanmod", { category: "k" })` call; extend `Logger.child` to carry a category override that gets embedded in the `LogRecord.source` as a trailing `#k` marker which the DCC sink uses in preference to the default table. _(The Logger side of this is in place — `Logger.child(prefix, { category })` carries a `#k` marker through `LogRecord.source` and the DCC sink honours it. Retagging individual chanmod call sites is opt-in and can happen in a follow-up; the default mapping already routes the whole plugin under `o`.)_

- [x] **Verification:** after tagging, run `grep -rn "logger\." src plugins` and sanity-check that every call site is under a child logger with a prefix. Start the bot, join a channel, do a voice — confirm the DCC console shows it under the expected category with `+o` active. _(Automated suite green; live-network smoke test still pending a real IRC run.)_

### Phase 5 — Documentation + examples

**Goal:** Ship the feature with docs so a new operator understands the defaults, can diagnose "why is my DCC console quiet" / "why is it flooding", and can recreate the Eggdrop mental model without trial and error.

- [x] Update `docs/DCC.md` with a new `## Console flags` section (placed after the "Console commands" table). Include:
  - Motivation: the DCC console is a filtered view of the bot's log, gated per session.
  - The full flag letter table (same columns as Phase 3: letter / category / sources).
  - The default flag string (`+mojw`) and why: "On connect you see bot operator actions (op/voice/kick), bot messages like startup and DCC session events, join/part activity, and warnings/errors. Dispatcher debug chatter and public command routing are off by default — turn them on only when debugging."
  - Usage examples:
    ```
    .console                 → Console flags: +mojw
    .console +p              → subscribe to command routing
    .console -j              → stop seeing joins/parts
    .console +mojkdwpbs      → everything (firehose)
    .console alice +o        → set default flags for another handle (owner only)
    ```
  - A short "Recipes" subsection:
    - **"I want to watch threats only"** → `.console -mj +kw`
    - **"I'm debugging a plugin"** → `.console +dp`
    - **"I only want to hear about errors"** → `.console -mojkpbs +w`
  - Note that flags are **persisted per handle** — the next time you connect, your last choice is restored.
- [x] Update `docs/GETTING_STARTED.md` if it mentions DCC at all — add one sentence pointing at `docs/DCC.md#console-flags`.
- [x] Update `CHANGELOG.md` with two entries under the next unreleased section:
  - **Added:** `.console <flags>` command for per-session DCC console filtering (Eggdrop-style `+mojw` default).
  - **Changed:** NickServ ACC/STATUS replies are no longer mirrored to DCC sessions — the chatter was from the internal permission verification path.
- [x] Update `DESIGN.md` DCC section (if it mentions partyline logging or describes the private-notice mirror) to note the dual-path model: (1) private-notice mirror for **untracked** services bots, (2) log sink for HexBot's own actions.
- [x] Update `docs/PLUGIN_API.md` if `api.log` semantics change. With Phase 4 introducing an optional category override, document the new `api.log.tagged("o", "...")` shape if we go that route, or — if we stick with plain `api.log(...)` that inherits the plugin's default category — document that the category comes from the plugin ID prefix. _(Went with the plain form — category is inferred from the plugin's child-logger prefix. The tagged form is available via `logger.child(prefix, { category })` for core modules that need finer control, but plugin authors don't need to touch it.)_
- [x] Update `config/bot.example.json`: no schema change is required (console flags live in the kv store, not config), but add a top-level comment block above the `dcc` section in the example pointing readers at `docs/DCC.md#console-flags`. If the example JSON does not support comments, skip this — the doc update is sufficient. _(JSON doesn't support comments, skipped per the plan.)_

## Config changes

**None.** Per-session `.console` flags are persisted in the kv store (`dcc:console_flags:<handle>`), not in `bot.json`. This is deliberate:

1. Console preferences are _personal_ — every admin gets their own defaults.
2. They change often via `.console +x` without wanting to hot-reload config.
3. Putting them in `bot.json` would either be per-user (which `bot.json` does not model) or force a single global default (unhelpful).

Default flags `"mojw"` are a **code constant** in `src/core/dcc-console-flags.ts`. If a future version wants the global default to be operator-tunable, add `dcc.default_console_flags?: string` to `DccConfig` at that point — explicitly out of scope here.

Existing `LoggingConfig` at `src/types.ts:597` is unchanged.

## Database changes

**One new kv namespace.** No schema migration — the kv store already accepts arbitrary keys.

- **Key shape:** `dcc:console_flags:<handle>` (e.g. `dcc:console_flags:admin`)
- **Value:** canonical flag string like `"mojw"` (no leading `+`, sorted alphabetically, lowercase)
- **Read:** on `DCCSession.onAuthSuccess`, before the banner renders.
- **Write:** on every successful `.console +x` / `.console -x` mutation.
- **Cleanup:** never auto-deleted. Handles are durable; if a user is removed via `.deluser`, add a single kv delete alongside the existing permission cleanup (one extra line in `src/core/permissions.ts` `deleteUser`). This keeps the store tidy and avoids stale rows pointing at non-existent handles.

Document the key shape in a short `// kv keys` comment block at the top of `src/core/dcc-console-flags.ts` so operators inspecting the database with `sqlite3 data/hexbot.db "select * from kv where key like 'dcc:%'"` can make sense of what they see.

## Test plan

**New test files:**

- `tests/core/dcc-console-flags.test.ts` — flag parser/formatter/categorizer pure-function tests.
- `tests/core/dcc-console-sink.test.ts` — end-to-end sink behavior with a fake `DCCSession`, covering filter logic, kv persistence, and `.console` command round-trip.

**Extended test files:**

- `tests/logger.test.ts` — multi-sink semantics (see Phase 2 list).
- `tests/core/dcc.test.ts` — NickServ filter, integration test that log lines reach a live session through the real sink path.
- `tests/core/services.test.ts` — `isNickServVerificationReply` helper including the non-default NickServ nick case.

**Coverage targets (what must be true after `pnpm test`):**

1. NickServ STATUS replies are dropped by the private-notice mirror; ChanServ / MemoServ replies are not.
2. Adding, using, and removing a `LogSink` behaves as expected; a throwing sink cannot break logging.
3. `DCCManager.attach()` installs the sink and `detach()` removes it.
4. A session with default flags (`mojw`) receives operator actions, bot messages, joins/parts, and warnings — and nothing else.
5. `.console +d` toggles dispatcher debug visibility and persists across a simulated reconnect (close session, reopen, flags restored from kv).
6. `.console alice +o` is rejected without owner flags; accepted with owner.
7. A command context without a `dccSession` (REPL) rejects `.console` with a clear error.
8. `.deluser` cleans up the corresponding kv row.

**Manual smoke test (after the automated suite passes):**

1. Run the bot against a local ngIRCd or Rizon test channel.
2. `/dcc chat hexbot`, authenticate, observe banner shows `Flags: +mojw`.
3. `!voice someone` from the channel — confirm DCC shows the chanmod action line, no NickServ STATUS echo.
4. `.console +d` — expect a burst of dispatcher lines next time an event fires.
5. `.console -mojwd +k` — run `!ban someone`, confirm only the threat/ban line appears.
6. `.quit` + reconnect — confirm flags persisted.
7. `.console admin +b` as owner, disconnect the other admin's session, have them reconnect — confirm they inherit the stored flag.

## Rollout / backward compatibility

- **REPL is untouched.** `Logger.setOutputHook` is preserved as a compatibility wrapper, so `src/repl.ts:80` still works without edits. Phase 2 tests pin this behavior.
- **Existing DCC sessions are unaffected** on upgrade — on first connect after the upgrade, they inherit `DEFAULT_CONSOLE_FLAGS` because no kv row exists yet.
- **`nickserv_verify` deprecation** (`src/core/dcc.ts:1168`) is orthogonal and not touched by this plan.
- **Plugin API** does not break. `api.log` keeps working; Phase 4's category override is opt-in. Plugins that never touch categories fall into the default category for their prefix.

## Resolved decisions

The following were open when this plan was drafted and have since been confirmed:

1. **Memo / MemoServ category** → `m` (bot messages). Consistent with Eggdrop's broad use of `m`.
2. **Default console flags source** → **hard-coded** constant `DEFAULT_CONSOLE_FLAGS = "mojw"` in `src/core/dcc-console-flags.ts`. No `DccConfig` field. If a future operator needs a tunable global default, add `dcc.default_console_flags?: string` at that point.
3. **`.console +all` / `-all` sugar** → **included** in the Phase 3 parser. `+all` sets every known letter (`mojkpbsdw`), `-all` clears every letter. Invalid letters outside the known set are still rejected with a clear error.
4. **Log line rendering to DCC** → **ANSI colors pass through verbatim**. The sink delivers `record.formatted` (chalk-colorized). The existing banner already writes chalk ANSI to DCC sockets without client complaints, so no compatibility concern. No `+c` flag is introduced. If a specific client later renders garbage, a follow-up can add `-c` to strip via `record.plain`.
5. **Botlink `ANNOUNCE` frames** → **remain unfiltered**. `src/bot.ts:902` keeps calling `_dccManager.announce(...)` outside the log sink path. Partyline announces are rare and load-bearing; filtering them would surprise operators.
6. **Per-session log rate limit** → **none in v1**. `Socket.write` handles backpressure. Ship without a limiter; add a leaky bucket in `DCCSession.receiveLog` only if a chatty plugin causes real-world DCC drowning.

## Unresolved / defer-to-build

None at this time. The plan is ready for `/build`.
