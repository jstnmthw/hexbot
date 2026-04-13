# Audit Trail (`mod_log`)

HexBot writes a row to the `mod_log` SQLite table for every privileged action — moderation, configuration, authentication, plugin lifecycle, and bot-link relay. This document is the contract: what gets logged, how it's structured, how operators query it, and the rules plugin authors must follow when they touch privileged code paths.

The audit subsystem is the single answer to "who did what, when, and how did it go." If you're adding a new privileged code path, your work isn't done until a `mod_log` row lands.

## Schema

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

Indexes: `mod_log_ts (timestamp DESC)`, `mod_log_target`, `mod_log_channel_ts (channel, timestamp DESC)`, `mod_log_source`.

### Field semantics

| Column     | Required              | Meaning                                                                                                                                                                   |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`   | yes                   | Short verb identifying the event. Vocabulary below.                                                                                                                       |
| `source`   | yes                   | Transport or subsystem the event came from. Strict enum.                                                                                                                  |
| `by_user`  | no                    | Actor who triggered the event — handle, nick, or `'bot'` for unattributed background work.                                                                                |
| `plugin`   | iff `source='plugin'` | Plugin name. The writer enforces this invariant: setting `plugin` outside a plugin source throws, and a plugin source without `plugin` throws.                            |
| `channel`  | no                    | Channel the action affected. `NULL` for non-channel events (auth failures, plugin lifecycle).                                                                             |
| `target`   | no                    | Subject of the action — kicked nick, banned mask, set key, modified handle, ...                                                                                           |
| `outcome`  | yes                   | `'success'` (default) or `'failure'`. Rejected commands, denied permissions, and validation errors land as `'failure'`.                                                   |
| `reason`   | no                    | Free-form short string. For `kick` it's the reason text; for `chanset-set` it's the new value; for `plugin-load` failure it's the error message.                          |
| `metadata` | no                    | JSON blob for structured payload. Used when a single action carries more context than a flat reason — e.g. `flood-lockdown` carries `{ mode, flooderCount, durationMs }`. |

### Source vocabulary

| Source    | When it fires                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `repl`    | Commands typed at the attached REPL.                                                                                                       |
| `irc`     | Commands triggered through an IRC channel command, plus IRC bridge events.                                                                 |
| `dcc`     | DCC console commands and the DCC password prompt.                                                                                          |
| `botlink` | Hub/leaf control plane (auth, manual ban, auto-ban).                                                                                       |
| `plugin`  | Plugin-driven action via `api.audit.log` or autologged through `api.irc.*`. The factory forces this — plugins cannot spoof another source. |
| `config`  | Reserved for config-driven mutations not yet wired (kept for future use).                                                                  |
| `system`  | Background reconciliation, default actor, anything not attributable to a specific transport.                                               |

The legacy value `unknown` may appear on rows migrated from the pre-Phase-1 schema. New writes are rejected if `source` is not in the enum above.

## Action vocabulary

The action names below are the canonical labels. Add new actions sparingly — if a new privileged code path is a moral cousin of an existing action, prefer reusing the name with distinguishing metadata over inventing a parallel verb.

### IRC moderation (auto-logged via `IRCCommands` / `api.irc.*`)

| Action                | Target    | Notes                                                                 |
| --------------------- | --------- | --------------------------------------------------------------------- |
| `kick`                | nick      | `reason` carries the kick text.                                       |
| `ban` / `unban`       | mask      | `metadata.durationMs` on `.ban`.                                      |
| `op` / `deop`         | nick      |                                                                       |
| `voice` / `devoice`   | nick      |                                                                       |
| `halfop` / `dehalfop` | nick      |                                                                       |
| `quiet`               | mask      |                                                                       |
| `invite`              | nick      |                                                                       |
| `topic`               | (channel) | `reason` carries the new topic text.                                  |
| `mode`                | (channel) | `reason` is the mode string; `metadata.params` is the parameter list. |

### Channel settings

| Action          | Notes                                |
| --------------- | ------------------------------------ |
| `chanset-set`   | `target` = key, `reason` = new value |
| `chanset-unset` | `target` = key                       |

### Plugin lifecycle

| Action          | Notes                                                  |
| --------------- | ------------------------------------------------------ |
| `plugin-load`   | `target` = name; `outcome=failure` + `reason` on error |
| `plugin-unload` | as above                                               |
| `plugin-reload` | as above                                               |

### IRC admin commands

| Action          | Notes                                                      |
| --------------- | ---------------------------------------------------------- |
| `say`           | `target` = recipient, `metadata.message`                   |
| `msg`           | as above                                                   |
| `join` / `part` | `channel` set; `part` carries the part message in `reason` |
| `invite`        | `channel` + `target`                                       |

### DCC console

| Action        | Notes                                         |
| ------------- | --------------------------------------------- |
| `console-set` | `target` = handle, `metadata.{before, after}` |

### Bot-link

| Action                                     | Notes                                                            |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `botlink-disconnect` / `botlink-reconnect` | `target` = botname                                               |
| `botlink-ban` / `botlink-unban`            | manual operator action; `target` = ip/cidr                       |
| `botlink-autoban`                          | automated escalation; `metadata.{banDurationMs, escalationTier}` |
| `relay`                                    | `target` = botname; `metadata.handle`                            |
| `bot-remote`                               | `target` = botname; `reason` = full command line                 |
| `bsay` / `bannounce`                       | `metadata.message`                                               |

### Permissions

| Action                | Notes                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `adduser` / `deluser` | `target` = handle                                                                                                                           |
| `flags`               | `target` = handle, `reason` = flag mutation                                                                                                 |
| `chpass`              | `target` = handle. Success path is automatic; rejection paths land as `outcome=failure` with a brief reason — never the attempted password. |

### Authentication

| Action                    | Notes                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| `auth-fail`               | DCC password rejection; `target` = handle, `metadata.peer = ip:port` |
| `auth-lockout`            | Distinct row when the failure tracker locks; `metadata.lockedUntil`  |
| `nickserv-verify-timeout` | Identity check timed out; `target` = nick                            |

### Plugin-instrumented (via `api.audit.log`)

| Action                                   | Plugin | Notes                                                                                       |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `flood-lockdown` / `flood-lockdown-lift` | flood  | `metadata.{mode, flooderCount, durationMs}`                                                 |
| `rss-feed-add` / `rss-feed-remove`       | rss    | `target` = feed id                                                                          |
| `topic-lock` / `topic-unlock`            | topic  | `metadata.lockedBy` records the operator nick (the row's `by` is forced to the plugin name) |

## Rules for plugin authors

If your plugin touches privileged state, you must audit it. The contract is:

1. **`api.irc.*` calls auto-audit.** Every call to `api.op`, `api.kick`, `api.ban`, `api.topic`, `api.invite`, etc. lands a `mod_log` row with `source='plugin'`, `plugin=<your plugin>`, and `by=<your plugin>`. You don't need to do anything extra for these.
2. **For everything else, call `api.audit.log(action, options)`.** Use this for mutations that don't map to an `api.irc.*` wrapper: feed/config mutations, lockdown state changes, threat-level escalations, authentication decisions made by your plugin. The factory injects `source`, `plugin`, and `by` — anything you pass in `options` for those fields is ignored. The arguments you control are `channel`, `target`, `outcome`, `reason`, and `metadata`.
3. **Never log secrets.** The audit writer never sees a password, but a sloppy `metadata` payload could. If your plugin handles credentials, double-check that nothing flows into `metadata` or `reason`.
4. **Pick action names that match the table above when applicable.** If a new action is genuinely novel, use kebab-case (`my-plugin-event`) and document it in your plugin README.

A plugin **must not** call `db.logModAction` directly — direct database access is forbidden by the scoped API and `api.audit.log` is the only supported path. The factory forces `source='plugin'` and the `plugin` column to your plugin id, so a misbehaving plugin can never spoof another plugin or impersonate a non-plugin source.

Every privileged plugin path is exercised by `tests/plugins/audit-coverage.test.ts`. New plugins with privileged code should add a case there.

## Operator UI

### `.modlog` (DCC + REPL only)

Stateful pager. IRC channels are refused with `audit queries are DCC-only — /dcc chat me` to keep audit data out of public scrollback and avoid flood-kicks.

```
.modlog                          # default: newest 10 rows
.modlog action kick channel #foo # filter
.modlog next | n                 # next page
.modlog prev | p                 # previous page
.modlog top                      # first page (re-snapshots the total)
.modlog end                      # last page
.modlog show <id>                # full row detail with parsed metadata
.modlog clear                    # forget pager state
```

#### Filter grammar

All optional, all composable, order-independent:

| Field                 | Example         | Notes                                                                     |
| --------------------- | --------------- | ------------------------------------------------------------------------- |
| `action <name>`       | `action kick`   | exact match                                                               |
| `target <nick\|mask>` | `target alice`  | exact match                                                               |
| `channel <#chan>`     | `channel #foo`  | case-insensitive                                                          |
| `by <handle>`         | `by admin`      | actor handle                                                              |
| `source <enum>`       | `source dcc`    | one of the source vocabulary above                                        |
| `plugin <name>`       | `plugin flood`  | rows where plugin column = name                                           |
| `since <duration>`    | `since 1h`      | `s`/`m`/`h`/`d` suffix                                                    |
| `grep <substring>`    | `grep too many` | LIKE match against `reason` and `metadata`; consumes the rest of the line |

#### Output format

```
ID     WHEN     ACTION         WHO            TARGET             CHAN         OUTCOME
247    3m ago   kick           alice          spammer            #foo         success
246    8m ago   chanset-set    alice          greet.enabled      #foo         success
245    1h ago   botlink-…      system         10.0.0.4           —            failure
...
-- 1-10 of 247 — .modlog next | prev | top | show <id> --
```

Columns truncate with `…`; `show <id>` prints full untruncated values plus parsed `metadata` JSON. The footer hints `(+N new)` if rows have landed since the snapshot was taken; `.modlog top` re-snapshots.

#### Pagination cursor

Pages walk with a `(beforeId)` cursor against the descending `id` order, not `LIMIT/OFFSET`. Deep pagination stays O(log n) on the `mod_log_ts` index, and new rows landing mid-browse never cause page jumps.

#### Permission matrix

| Caller     | Access                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- |
| Global `n` | unrestricted                                                                                 |
| Global `m` | restricted to channels where the user has per-channel `o` (or `n`); other rows are invisible |
| Below `m`  | command rejected                                                                             |

`.modlog show <id>` reapplies the same scope so a master cannot fetch arbitrary IDs outside their channels.

#### Session state

Each session carries its own pager keyed by DCC handle (or `'repl'`). State holds the current filter, page cursor, and the total snapshot. Idle pagers expire after **30 minutes** — pruning happens lazily on every command, no background timer.

### `.audit-tail` (REPL only)

Live stream of `audit:log` events:

```
.audit-tail                        # tail everything
.audit-tail action kick channel #foo
.audit-tail off                    # detach
```

Filter grammar is identical to `.modlog`. Only one tail per REPL — running `.audit-tail` again replaces the active filter.

`.audit-tail` subscribes to the internal `audit:log` event bus, which fires synchronously after every successful `mod_log` insert. The same hook is the foundation for a future audit-stream plugin that ships records off-box.

## Configuration

```jsonc
"logging": {
  "level": "info",
  "mod_actions": true,         // false → mod_log inserts are skipped
  "mod_log_retention_days": 0  // 0 (default) → keep forever; >0 → prune on startup
}
```

- **`mod_actions: false`** turns the writer into a no-op. The schema still exists; nothing lands in it. Use for ephemeral / one-off bots where the audit overhead isn't wanted.
- **`mod_log_retention_days: N`** prunes rows older than `N` days in a single `DELETE` on startup, then logs the count. Pruning is one-shot per process — there is no background sweeper.

## Resilience

Every write goes through `tryLogModAction(db, options, logger)` (or `tryAudit(db, ctx, options, logger)` in command handlers), which wraps the insert in try/catch + `logger.warn`. **A failed audit write never blocks the mutation that already happened in memory.** Operators see a warn line; the in-memory state still mutates; the user sees the action complete normally.

This is intentional. The alternative — failing the action because the audit couldn't be persisted — would mean a transient SQLite hiccup could break moderation. We prefer "moderation works, audit had a gap" over "audit is perfect, moderation is broken."

## Programmatic access

```ts
import type { ModLogEntry, ModLogFilter } from './database';

db.getModLog({ action: 'kick', channel: '#foo', limit: 50 });
db.countModLog({ source: 'botlink' });
db.getModLogById(247);
```

`ModLogFilter` exposes everything the `.modlog` grammar does plus `beforeId` (cursor) and `channelsIn` (used by the permission matrix).

The internal `audit:log` event fires after every successful insert with the parsed entry as payload:

```ts
eventBus.on('audit:log', (entry) => {
  // entry: ModLogEntry — id, timestamp, action, source, by, plugin,
  // channel, target, outcome, reason, metadata (parsed JSON or null)
});
```

## Out of scope

- Exporting `mod_log` to external SIEMs / syslog / webhooks. The `audit:log` event lays the groundwork; a concrete sink plugin is a separate effort.
- Append-only / hash-chained ledger. The deployment model doesn't currently treat tampering as a threat — `mod_log` is a regular SQLite table.
- Per-plugin namespaced audit tables. One shared `mod_log` with a `plugin` column keeps cross-plugin queries trivial; the namespacing pressure isn't there yet.
