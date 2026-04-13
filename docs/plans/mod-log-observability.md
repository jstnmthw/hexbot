# Plan: mod_log observability remediation

Close the audit-logging and observability gaps surfaced in the 2026-04-14 review. Today `mod_log` is wired for ~6 core commands and nothing else: plugin-driven moderation, IRC admin commands, plugin lifecycle, `.chanset`, botlink relay/remote execution, and all authentication failures leave no trail. The schema itself has no indexes, no retention, no source/plugin/outcome columns, and no read surface outside tests.

This plan lands the remediation in six phases, ordered so each phase is independently testable and leaves the tree green.

## Design invariants

- **Clean schema rewrite.** `mod_log` is redefined in its final shape — new columns, renamed fields, fresh signatures. Existing rows are copied into the new table in a one-shot startup migration with NULLs where the old schema had no equivalent data; the old table is dropped afterward. No positional-compat shims, no "optional options object" dual signatures — call sites are updated in lockstep.
- **DB failure never blocks the mutation.** Every `logModAction` call is wrapped in try/warn, matching the `Permissions.recordModAction` pattern at `src/core/permissions.ts:480-492`.
- **Attribution is threaded, not guessed.** `HandlerContext` already carries `nick` and `source`; a small helper freezes actor identity at the handler boundary so no call site constructs a `by` string by hand.
- **Plugins cannot write mod_log directly.** They get a scoped `api.audit.log(...)` that forces `by = pluginName` and `source = 'plugin'`. Direct DB access stays forbidden.
- **Every new audit site gets a test.** The review had to read code to verify coverage; tests should make the gap obvious on regression.

## Phases

### Phase 1 — Schema rewrite + retention

- [ ] Redefine `mod_log` in `src/database.ts` in its final shape. Final columns:
  ```sql
  CREATE TABLE mod_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    action    TEXT    NOT NULL,
    source    TEXT    NOT NULL,  -- repl|irc|dcc|botlink|plugin|config|system
    by_user   TEXT,
    plugin    TEXT,               -- set iff source='plugin'
    channel   TEXT,
    target    TEXT,
    outcome   TEXT    NOT NULL DEFAULT 'success', -- success|failure
    reason    TEXT,
    metadata  TEXT                -- JSON blob for structured reason data
  );
  ```
- [ ] One-shot startup migration from the old `mod_log` table: `CREATE TABLE mod_log_new (...)`, `INSERT INTO mod_log_new SELECT id, timestamp, action, 'unknown', by_user, NULL, channel, target, 'success', reason, NULL FROM mod_log`, `DROP TABLE mod_log`, `ALTER TABLE mod_log_new RENAME TO mod_log`. Wrap in a transaction so a failure leaves the old table intact. Log the migrated row count.
- [ ] Add indexes after the rename: `CREATE INDEX mod_log_ts ON mod_log(timestamp DESC)`, `mod_log_target ON mod_log(target)`, `mod_log_channel_ts ON mod_log(channel, timestamp DESC)`, `mod_log_source ON mod_log(source)`.
- [ ] Rewrite `ModLogEntry`, `ModLogFilter`, and `logModAction()` cleanly with the final shape — one signature, no dual path, no positional shim. Every call site (`src/core/permissions.ts:488`, `src/core/irc-commands.ts:284`, `src/core/commands/ban-commands.ts:134,167`, `src/core/botlink-auth.ts:429`) is updated in the same commit.
- [ ] `logModAction(options: { action, source, by?, plugin?, channel?, target?, outcome?, reason?, metadata? })` — options object, not positional. `source` and `action` are required; everything else is optional. The factory validates `plugin` is set iff `source === 'plugin'`.
- [ ] Honor `logging.mod_actions` in `src/database.ts` — the flag is declared in `src/config.ts:82` and `src/types.ts:613` but never consulted. Wire it up (skip the insert when false) or delete the field; do not leave it as dead config.
- [ ] Add configurable retention (`logging.mod_log_retention_days`, default 0 = unlimited). On startup, if >0, prune rows older than the cutoff in a single `DELETE` and log the count.
- [ ] Rewrite `tests/database.test.ts` against the new schema: round-trip every column, verify the startup migration copies old rows into the new shape with the right defaults, verify indexes exist via `sqlite_master`, verify retention prune honors the cutoff, verify `mod_actions=false` suppresses writes, verify the `plugin`-set-iff-`source='plugin'` invariant is enforced.

### Phase 2 — Actor threading through IRCCommands

- [ ] Replace the hardcoded `by='bot'` strings at `src/core/irc-commands.ts:127,132,137,142,147,168` with an `actor: { by, source, plugin? }` parameter on every mutating method. Add a class-level `setDefaultActor()` so tests and core commands can batch-set it.
- [ ] Extend logging to `voice/devoice/halfop/dehalfop/topic/quiet/mode` (`src/core/irc-commands.ts:150-178`). Every privileged mode mutation lands in `mod_log`, not just `+o`/`+b`/`kick`/`invite`.
- [ ] Add `src/core/audit.ts` with an `auditActor(ctx: HandlerContext): { by, source }` helper. Every core command handler uses this instead of passing `ctx.nick` by hand. This is the enforcement point — once it exists, reviewers can grep for raw `logModAction(` calls that bypass it.
- [ ] Update `tests/core/irc-commands.test.ts` to assert: (a) every mutating method writes `mod_log`, (b) actor threading overrides the default, (c) voice/halfop/topic now produce rows.

### Phase 3 — Plugin audit API + per-plugin coverage

- [ ] Add `api.audit.log(action, { channel?, target?, reason?, outcome?, metadata? })` to `src/plugin-api-factory.ts`. The factory injects `by = pluginName` and `source = 'plugin'` so plugins cannot spoof identity.
- [ ] Thread the same actor through `api.irc.*` wrappers — when a plugin calls `api.op()`, the underlying `IRCCommands.op()` receives `{ by: pluginName, source: 'plugin' }` instead of the `'bot'` default.
- [ ] Emit `audit:log` on the internal event bus alongside every mod_log write, so a future `audit-stream` plugin can ship records off-box without polling the DB. No consumers in this phase — just the event.
- [ ] Update every privileged plugin site to call `api.audit.log` (or rely on the `api.irc.*` autolog). Minimum coverage:
  - `plugins/chanmod/auto-op.ts` — op/halfop/voice on join, with `reason = 'auto-op:<flag>'`
  - `plugins/chanmod/protection.ts` — revenge deop/kick/ban, backend ChanServ requests
  - `plugins/chanmod/mode-enforce-user.ts` — bitch-mode deop, revenge on deop
  - `plugins/chanmod/mode-enforce-channel.ts` — mode reversals
  - `plugins/chanmod/sticky.ts` — sticky ban re-application
  - `plugins/chanmod/stopnethack.ts` — nethack deop
  - `plugins/chanmod/takeover-detect.ts` — threat-level escalations (include score in `metadata`)
  - `plugins/chanmod/invite.ts`, `join-recovery.ts`, `topic-recovery.ts`
  - `plugins/chanmod/commands.ts` — every operator-triggered op/deop/kick/ban
  - `plugins/flood/index.ts` — kick/ban/lockdown with offence count in `metadata`
  - `plugins/topic/index.ts` — topic changes + lock state
  - `plugins/rss/index.ts` — feed add/remove
- [ ] Add a `tests/plugins/audit-coverage.test.ts` that loads each plugin in isolation, triggers a privileged code path, and asserts a mod_log row appears. This is the regression guard.

### Phase 4 — Core-command coverage

- [ ] `.chanset` / `.chanset unset` — `src/core/commands/channel-commands.ts:112,118,153,162` and `src/core/channel-settings.ts:123`. Log `chanset-set` / `chanset-unset` with the key in `target` and the value in `reason`. This is the admin layer flagged in memory — it must be fully auditable.
- [ ] `.plugin load/unload/reload` — `src/core/commands/plugin-commands.ts` and `src/plugin-loader.ts:318,367,384`. Log with `outcome` reflecting success/failure of the load.
- [ ] `.stick` / `.unstick` — `src/core/commands/ban-commands.ts:193,222`. Symmetry with `.ban`/`.unban`.
- [ ] `.say` / `.msg` / `.join` / `.part` / `.invite` / `.raw` — `src/core/commands/irc-commands-admin.ts:54,73,94,118,144`. The `.raw` site is the most important: arbitrary protocol injection must be queryable.
- [ ] `.console` flag mutations — `src/core/commands/dcc-console-commands.ts:78,108`. Changing whose DCC session sees which streams is privacy-relevant, especially when set on another handle.
- [ ] `.botlink disconnect/reconnect`, `.relay`, `.bot` (remote dispatch), `.bsay`, `.bannounce` — `src/core/commands/botlink-commands.ts:125,135,373,474,530,585`. The `.bot` remote-command site is the important one: remote execution across the hub must land in the origin bot's audit trail.
- [ ] Expand the core command tests in `tests/core/commands/*.test.ts` to assert mod_log rows for each newly covered command.

### Phase 5 — Authentication + auto-action observability

- [ ] DCC password verification failures — `src/core/dcc.ts` (around the `~1033` handler). Log `auth-fail` with `source='dcc'`, `target = handle`, `outcome='failure'`, and `metadata` carrying the remote peer info. Do not log the attempted password.
- [ ] NickServ verification timeouts — `src/core/services.ts:125`. Log `nickserv-verify-timeout` with `target = nick`.
- [ ] Botlink auto-bans — `src/core/botlink-auth.ts:281`. Symmetric with manual bans at 401/414: the automated path is more interesting than the manual one and must be recorded.
- [ ] DCC auth lockouts — when failure count crosses the threshold, emit a distinct `auth-lockout` row so a brute-force attempt can be queried as one event instead of reconstructed from raw failures.
- [ ] Password change failures (`.chpass` validation errors) — the success path is already logged at `src/core/permissions.ts:205`; the rejection path is silent.
- [ ] Tests: drive each failure path through a mock and assert the row lands with `outcome='failure'`.

### Phase 6 — Read surface + documentation

#### `.modlog` pager UX

A stateful, per-session pager gated on the `n` flag. DCC and REPL only — on IRC channels the command hard-refuses with "audit queries are DCC-only, /dcc chat me" to avoid flood-kicks, line truncation, and leaking audit data into public scrollback.

- [ ] Add `.modlog [filter...]` core command under `src/core/commands/modlog-commands.ts`, gated on `n`. Reject with the redirect notice if `ctx.source === 'irc'`.
- [ ] Filter grammar — all optional, all composable, order-independent:
  - `action <name>` — exact action match (`kick`, `chanset-set`, ...)
  - `target <nick|mask>` — exact match
  - `channel <#chan>` — exact match (case-insensitive)
  - `by <handle>` — filter by actor
  - `source <repl|irc|dcc|botlink|plugin|config|system>`
  - `plugin <name>` — rows where `plugin = name`
  - `since <duration>` — e.g. `1h`, `7d`, `30m`; translates to `timestamp >= now - N`
  - `grep <substring>` — LIKE match against `reason` and `metadata`
- [ ] Subcommands for pagination — operate on the session's current query:
  - `.modlog` (no args) — reset cursor, run default query (no filter, newest first, 10 rows)
  - `.modlog <filters>` — reset cursor with new filter set, show page 1
  - `.modlog next` / `.modlog n` — next page
  - `.modlog prev` / `.modlog p` — previous page
  - `.modlog end` — last page
  - `.modlog top` — first page
  - `.modlog show <id>` — full detail of one row (including full `reason` and parsed `metadata` JSON)
  - `.modlog clear` — forget the session's pager state
- [ ] Page size is fixed at 10 rows. Max ~400 bytes per row after formatting keeps each line below the IRC-safe limit even when echoed through DCC (which has no protocol ceiling, but the sanitizer and queue assume it).
- [ ] Output format — compact fixed-width table with a header row, trailing footer. Timestamps rendered as relative ("3m ago", "2h ago", "4d ago") with the absolute ISO time available in `.modlog show`:
  ```
   ID    WHEN    ACTION     WHO           TARGET          CHAN      OUTCOME
   247   3m ago  kick       alice!a@h     spammer         #foo      ok
   246   8m ago  chanset    alice         greet.enabled   #foo      ok
   245   1h ago  botlink-…  system        10.0.0.4        —         autoban
   ...
   -- 1-10 of 247 — .modlog next | prev | end | show <id> --
  ```
  Columns truncate with `…` if they overflow their width. `show <id>` prints full, untruncated values.
- [ ] Per-session cursor state lives in a `Map<sessionKey, PagerState>` where `sessionKey` is the DCC session id or `'repl'` for the attached REPL. `PagerState` holds `{ filter, offset, totalAtFirstQuery, createdAt }`. A DCC `close` event or REPL detach clears the entry. Idle sessions expire after 30 minutes to prevent stale state accumulation.
- [ ] The total count is snapshotted on the first query and reused for pagination labels — avoids a `COUNT(*)` on every "next" and avoids disorienting page jumps when a new row lands mid-browse. The footer hints `(+N new)` if fresh rows have landed since the snapshot, and `.modlog top` re-snapshots.
- [ ] Query implementation uses the `mod_log_ts` and `mod_log_channel_ts` indexes from Phase 1. Cursor is a `(timestamp, id)` tuple, not `LIMIT/OFFSET`, so deep pagination stays O(log n) instead of O(offset).
- [ ] `.audit-tail` — attached REPL only, subscribes to the `audit:log` event from Phase 3 and streams rows live until `.audit-tail off`. Filters reuse the same grammar so an operator can `.audit-tail action kick channel #foo` to watch a single channel's kicks in real time.
- [ ] Permission matrix:
  - Global `n` flag — unrestricted `.modlog`, can query any channel, target, or actor.
  - Global `m` flag — `.modlog` restricted to rows where `channel` is one the user has `o` on, plus rows with `target = user`. Prevents a channel-scoped op from reading cross-channel audit data.
  - Below `m` — command rejected.
- [ ] Tests in `tests/core/commands/modlog-commands.test.ts`:
  - Filter grammar parses each field and rejects unknown tokens
  - Pagination cursor advances and retreats correctly, stable under concurrent writes
  - IRC source rejected, DCC/REPL accepted
  - `m`-flag user cannot see a row for a channel they aren't op'd in
  - Session state clears on DCC close
  - Idle expiry drops stale pagers
  - `show <id>` renders full `metadata` JSON
  - `since 1h` correctly windows by timestamp

#### Documentation

- [ ] Write `docs/AUDIT.md` covering: the action vocabulary, required fields, the "if your plugin calls these APIs you must audit" rule for plugin authors, the schema contract, the retention story, and the `.modlog` / `.audit-tail` UX reference. Link from `docs/SECURITY.md:217-221`.
- [ ] Update `docs/PLUGIN_API.md` with the `api.audit.log` signature, examples, and the note that `api.irc.*` calls auto-audit so plugins rarely need to call `api.audit.log` directly.
- [ ] Add a `CHANGELOG.md` entry under the next unreleased section noting the schema migration, the new plugin API, `.modlog` / `.audit-tail` commands, and the retention knob.
- [ ] Run `pnpm test` and `pnpm lint` — both must be green before marking the plan complete.

## Out of scope

- Exporting mod_log to external SIEMs / syslog / webhooks — the `audit:log` event lays the groundwork but a concrete sink plugin is a separate effort.
- Structured threat scoring as a first-class concept — for now, takeover-detect's scores live in the `metadata` JSON blob.
- Rewriting `mod_log` as append-only with hash-chaining — the review did not flag tampering as a threat for the current deployment model.
- Per-plugin namespaced audit tables — one shared `mod_log` with a `plugin` column is simpler and keeps cross-plugin queries trivial.
