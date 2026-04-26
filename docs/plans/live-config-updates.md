# Plan: Live config updates

## Summary

Generalize the existing per-channel settings registry into a three-scope system — `core`, `<plugin-id>`, `<channel>` — backed by the same SQLite KV that the `chanset` namespace already uses, and introduce an Eggdrop-style operator command surface (`.set`, `.unset`, `.info`, `.help set`, `.rehash`, `.restart`) for live config changes. JSON config files (`config/bot.json`, `config/plugins.json`) become first-run **seeds**: on startup, registered keys with no KV value pull from JSON, then KV is canonical for the rest of the bot's life. Every registered key declares a **reload class** (`live`, `reload`, `restart`) via Zod schema metadata, so the same `.set` invocation either applies on the spot, reattaches a subsystem, or warns "stored; takes effect after `.restart`". Plugin enabled/disabled state is itself a config key (`core.plugins.<id>.enabled`); the existing `.load`, `.unload`, and `.reload` commands are deleted along with the plugin-loader's cache-busting code path.

The motivating problem is the 2026-04-25 memleak audit's CRITICAL: `.reload` accumulates one full ESM module graph per invocation, never reclaimed (Node's ESM loader has no eviction API). This refactor kills the leak at its source by **deleting `.reload` and the cache-busting import path outright** — not mitigating with file-mtime gates and reload counters. Plugin operators enable/disable via `.set core plugins.<id>.enabled true/false`; plugin authors pick up code edits with `.restart` for a clean process restart (no module-graph residue) or `tsx watch` at the process level during active development. Both paths already exist; neither leaks.

## Background & audit context

### The audit finding (2026-04-25)

```
CRITICAL — Cache-busted plugin imports accumulate forever in the ESM module registry
File: src/plugin-loader.ts:721-729
Growth: one full module graph per .reload/repeat-.load cycle, for the lifetime of the process

importWithCacheBust appends ?t=<timestamp> to force re-evaluation. Node's ESM loader
keys its registry by full URL — there is no API to evict an entry — so each reload
mints a new permanent registry entry holding the entire compiled module graph (every
transitive import, every closure, every top-level Map/Set). disposeApi() neutralizes
the api, unbindAll/removeByOwner drop core-side references, but Node still owns one
keep-alive root per cache-bust URL.
```

The audit's recommended remediations were three layers of mitigation (mtime-gated cache-bust, `importedOnce` prune on unload, reload-counter telemetry) plus a hint at per-plugin Worker threads. This plan goes further: it deletes `.reload` and the entire cache-busting code path, removing the leak vector at its source. Recommendation (4) is moot once the leak vector is gone. The "operational reason" for hammering `.reload` (config tweaks) is also gone — `.set` and `.rehash` cover live config; `.restart` covers plugin-code edits with a clean process.

### The existing infrastructure we build on

- **`src/core/channel-settings.ts`** — already implements the right pattern: typed `register()`, `onChange()` listeners, plugin-scoped `unregister()`/`offChange()` on unload, KV-backed persistence, IRC-aware key folding for channel scope. We generalize this into a multi-scope `SettingsRegistry`.
- **`src/plugin-loader.ts:513-530`** — `cleanupPluginResources` already drains `channelSettings.unregister(pluginName)` and `channelSettings.offChange(pluginName)` on unload (verified leak-free in the audit's cross-cutting verification). The new core/plugin scopes get the same plumbing.
- **`src/config.ts`** — two-stage pipeline (`parseBotConfigOnDisk` → `resolveSecrets`) with strict-object Zod validation at `src/config/schemas.ts`. The `_env` suffix convention (`password_env`) is the existing precedent for "JSON value is one-shot, durable state is the source of truth": the password is seeded into the user record on first boot, after which the DB-stored hash wins. We extend that semantic to _every_ live-applicable key.
- **`src/database.ts`** — KV is already namespaced by string. New namespaces `core` and `plugin:<id>` slot in alongside `chanset`, `_bans`, `_sts`, `_permissions`, `_linkbans`. No schema migration; the table is just `(namespace TEXT, key TEXT, value TEXT, updated INTEGER, PRIMARY KEY (namespace, key))`.

bot.json today has no live-update mechanism at all. Any change requires a process restart, which bounces the bot off IRC (re-IDENTIFY, rejoin channels, re-establish DCC sessions). The first-pass field inventory (see "Reload-class matrix" below) suggests roughly 80% of bot.json keys can be live-applied; only ~20% are inherently tied to the connection or boot phase.

## Feasibility

- **Alignment**: Fits cleanly with the existing two-tier module + plugin-API design. Core modules already expose `attach()`/`detach()` / `setLevel()` / `setFloodConfig()` shapes that map onto the reload-class behaviors. The plugin API gains a new `api.coreSettings` / `api.settings` surface but does not break any existing call site. DESIGN.md §2.4's "Channel settings" subsection generalizes naturally to three scopes.
- **Dependencies**: Pure refactor + extension on existing audited code. No new npm packages. Zod is already wired (used by `BotConfigOnDiskSchema`). SQLite KV is already plumbed and battle-tested. No IRC-protocol changes.
- **Blockers**: None. The bootstrap-layer split removes `database`, `owner.hostmask`, `owner.handle`, `pluginDir` from bot.json's schema and reads them from `HEX_DB_PATH` / `HEX_OWNER_HOSTMASK` / `HEX_OWNER_HANDLE` / `HEX_PLUGIN_DIR` instead. Local bot.json + bot.env edited in lockstep with the schema change.
- **Complexity estimate**: **XL** (significant effort). 10 phases, ~50 individual core/plugin keys to register, command surface across REPL/IRC/DCC/botlink-relay, reload-class wiring per subsystem, JSON-seed-on-empty path on boot, `.rehash` diff-and-apply, the audit-CRITICAL mitigations, plus the docs work. Realistically a multi-week initiative for a solo developer, broken into mergeable phase PRs.
- **Risk areas**:
  - **First-boot semantic shift.** Operators who edit bot.json _after_ first boot and expect the change to take effect are about to discover that JSON edits no longer auto-apply on restart — they need `.rehash` (or `.set`). Mitigated by clear startup-banner mention on first KV-backed boot ("KV is now the source of truth; use .rehash to apply bot.json edits") and a one-page operator doc.
  - **Reload-class miscategorization.** Marking a key `live` when it actually requires reattachment (e.g. `dcc.port_range` only takes effect on next `attach()`) silently strands the change. Mitigation: each migration phase ends with a manual smoke test that mutates the key via `.set` and verifies the new value is observed by the running subsystem.
  - **Listener accumulation across `.set`.** Every `.set` fires `onChange` listeners. If any subsystem registers without unregistering on swap (e.g. plugin reload that re-registers but doesn't drain), we recreate the audit's W-PS2 class of bug for core scope. Mitigation: the registry's `unregister(scope, owner)` is called before `register` in any rebind path; the audit's existing per-plugin drain extends to per-core-subsystem drain.
  - **Rehash drift.** `.rehash` re-reads JSON and applies _additions/updates_. Deletions are intentionally NOT propagated (matches `password_env` semantics — JSON is a seed, not authoritative). Operators expecting "remove from JSON, run .rehash, key reverts" will be surprised; the docs must call this out.
  - **Loss of in-process hot-reload for plugin-author iteration.** Removing `.reload` means an edit-test loop now goes through `.restart` (or `tsx watch`) — full process restart on every code change. Sub-second on this codebase, so the ergonomic hit is small, but it's a real change in dev workflow. DESIGN.md §1's "hot-reload without restart" claim updates to "process-watch reload during dev; clean restart in production".
  - **Audit-row volume.** Every `.set` writes a `mod_log` row. On a busy ops day this is desirable (full traceability), but we should reuse the existing `chanset-set` / `chanset-unset` action shapes and add `coreset-set` / `coreset-unset` / `pluginset-set` / `pluginset-unset` / `rehash` / `restart` so log filters can scope cleanly. No retention changes needed (existing `mod_log_retention_days` covers it).
  - **bot-link sync surface.** `.set` and `.rehash` mutate state that, for some keys (channel-scoped), already replicates via existing botlink sync. For core/plugin scope we deliberately do NOT replicate — each bot in a botnet has its own config; cross-bot config push is a deliberate non-goal. Documented in the per-phase tests so a future "shared config" feature doesn't accidentally land here.
  - **Test surface explosion.** A naive plan creates one test per (key × scope × reload-class) combination — ~150 tests. Mitigation: parameterize via the existing `dialect-matrix` pattern; one harness per reload class, walks the registered key list and asserts the contract.

## Dependencies

- [x] `src/core/channel-settings.ts` — existing primitive to generalize
- [x] `src/database.ts` — KV namespaces already arbitrary strings, no schema work
- [x] `src/plugin-loader.ts:513-530` — `cleanupPluginResources` extended with new scope drains
- [x] `src/config.ts` + `src/config/schemas.ts` — Zod schemas to extend with `@reload:*` metadata via `.describe()`
- [x] `src/logger.ts` — `setLevel()` already exists (line 148/248)
- [x] `src/core/services.ts` — `attach()`/`detach()` shape already exists (line 201/218)
- [x] `src/core/dcc/index.ts` — `attach()`/`detach(reason?)` already exists (line 1151/1232)
- [x] `src/irc-bridge.ts` — `attach()`/`detach()` already exists (line 135/174)
- [x] `src/core/memo.ts` — `attach()`/`detach()` already exists (line 176/194)
- [x] `src/core/message-queue.ts` — has `rate`/`burst` constructor options; needs `setRate(rate, burst)` mutator
- [x] `src/dispatcher.ts` — `setFloodConfig()` already exists for flood reattach
- [x] `src/event-bus.ts` — `trackListener('bot', ...)` / `removeByOwner` (still needs the audit's bare `.on()` migration; orthogonal but synergistic)
- [x] `src/core/audit.ts` + existing `mod_log` writer — accepts new action strings without schema work
- [x] `src/core/commands/channel-commands.ts` — `.chanset` reference implementation for `.set <channel>` UX
- [ ] New: `src/core/settings-registry.ts` — generalized three-scope registry (replaces / wraps `ChannelSettings`)
- [ ] New: `src/core/commands/settings-commands.ts` — `.set` / `.unset` / `.info` / `.help set` / `.rehash` / `.restart`
- [ ] New: `src/core/seed-from-json.ts` — boot-time "if KV empty for this key, populate from JSON" walker
- [ ] New: `src/bootstrap.ts` — env-only loader for `HEX_DB_PATH` / `HEX_OWNER_HOSTMASK` / `HEX_OWNER_HANDLE` / `HEX_PLUGIN_DIR`

## Design

### 1. Source-of-truth model

On startup, for each key declared in bot.json / plugins.json:

- If KV has no value at `(namespace, key)` → seed it from JSON.
- Otherwise skip — KV is canonical.

After first boot, `.set` is the canonical mutator. JSON edits are picked up only by `.rehash` (re-read files, diff vs KV, apply additions/updates).

This mirrors `password_env` exactly: provide a value, used once to populate durable state, then durable state wins. The semantic shift operators must internalize is small and matches an established codebase pattern.

**JSON deletions are retained.** If an operator removes a key from bot.json and runs `.rehash`, the existing KV value persists. Operators revert to the registered default with `.unset <scope> <key>`. Same precedent as `password_env`: the file is a seed, not authoritative.

**Bootstrap is env-only.** Truly bootstrap values (needed before KV is open) come from environment variables. No `bootstrap.json` file. The four bot.json bootstrap keys (`database`, `owner.hostmask`, `owner.handle`, `pluginDir`) are **removed outright** in this refactor — clean cut, no transitional fallback.

- `HEX_DB_PATH` — SQLite database path (replaces `database` key in bot.json — removed)
- `HEX_OWNER_HOSTMASK` — initial owner hostmask, used only on first boot to seed the owner record (replaces `owner.hostmask` — removed)
- `HEX_OWNER_HANDLE` — initial owner handle, same first-boot-only semantics (replaces `owner.handle` — removed)
- `HEX_PLUGIN_DIR` — plugin directory path (replaces `pluginDir` — removed; rarely changes, kept as bootstrap)
- `HEX_*_PASSWORD` (and other `*_env`-resolved secrets) — already env-only, no change

Everything else, including `irc.host`, lives in KV after first run. Pure 12-factor for the bootstrap layer; clean for Docker, systemd, and bare-metal alike.

### 2. Three scopes

| Scope         | KV namespace  | Owner            | Existing analog              |
| ------------- | ------------- | ---------------- | ---------------------------- |
| `core`        | `core`        | `bot`            | `chanset` for the bot itself |
| `<plugin-id>` | `plugin:<id>` | `<plugin-id>`    | `chanset` for plugin globals |
| `<channel>`   | `chanset`     | declaring plugin | unchanged from today         |

Each scope shares the same `register()` / `set()` / `unset()` / `get()` / `getDef()` / `getSnapshot()` / `onChange()` / `offChange()` / `unregister()` API. The `<channel>` scope is the existing `ChannelSettings` class refactored as one of three concrete instances; the public plugin-API surface (`api.channelSettings.*`) keeps working identically.

### 3. Reload classes

Each registered key declares one of three reload classes via Zod schema metadata using `.describe('@reload:live'|'@reload:reload'|'@reload:restart')`:

```ts
flood_pub_count: z.number().describe('@reload:live'),
ollama_host:     z.string().describe('@reload:reload'),
irc_host:        z.string().describe('@reload:restart'),
```

Behavior at write time:

- **`@reload:live`** — KV updated, `onChange` fires, change applied immediately by the registered listener.
- **`@reload:reload`** — KV updated, then the relevant subsystem reattaches (e.g. `dccManager.detach()` + `dccManager.attach()` for `core.dcc.*`, `messageQueue.setRate(...)` for `core.queue.*`, `services.detach()` + `services.attach()` for some `core.services.*`). User sees `applied; <subsystem> restarted`.
- **`@reload:restart`** — KV updated, but the listener warns the operator: `stored; takes effect after .restart`. Lets ops stage a change without applying immediately ("cut over to new IRC server at 2am").

Schema-tier classification is introspectable: `.help set core <key>` renders type, default, description, and reload-class together. The plugin/subsystem still owns the `onChange` callback that does the actual application — the registry's job is to fire the callback with the right contract.

### 4. Reload-class matrix (authoritative key list)

This matrix is the contract Phase 5 / Phase 6 implement. Each entry maps a current bot.json or plugins.json key to a `(scope, key, reload class, application strategy)` row.

#### Core scope — `bot.json`

| Key                                                                   | Class     | How it applies                                                                                       |
| --------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `irc.host` / `port` / `tls`                                           | `restart` | Set on the active IRC connection — only safe to change on the next connect.                          |
| `irc.username` / `realname`                                           | `restart` | Sent in USER at registration; cannot be changed mid-session.                                         |
| `irc.nick`                                                            | `reload`  | `client.changeNick(newNick)` (handles 433 fallback).                                                 |
| `irc.channels`                                                        | `live`    | Diff old/new; `.join` adds, `.part` removes. Honors `key`/`key_env`.                                 |
| `irc.alt_nick` / `ghost_on_recover`                                   | `restart` | Read at registration / collision recovery only.                                                      |
| `irc.tls_verify` / `tls_cert` / `tls_key`                             | `restart` | Socket-level; cannot change without reconnect.                                                       |
| `owner.handle` / `hostmask`                                           | bootstrap | Removed from bot.json. Set via `HEX_OWNER_HANDLE` / `HEX_OWNER_HOSTMASK`; seeded once on first boot. |
| `owner.password_env`                                                  | unchanged | env-only secret (existing precedent).                                                                |
| `identity.method`                                                     | `restart` | Affects dispatcher verification provider wiring.                                                     |
| `identity.require_acc_for`                                            | `live`    | `dispatcher.setVerification(...)` rebuilt from current value.                                        |
| `services.type` / `nickserv`                                          | `reload`  | `services.detach()` + `services.attach()`.                                                           |
| `services.password`                                                   | env-only  | `*_env` resolution, unchanged.                                                                       |
| `services.sasl` / `sasl_mechanism`                                    | `restart` | SASL negotiated at registration; cannot mid-session.                                                 |
| `services.identify_before_join*`                                      | `live`    | Read on next reconnect; pure flag.                                                                   |
| `services.services_host_pattern`                                      | `live`    | Used in NickServ NOTICE matcher; rebuild matcher on change.                                          |
| `database` (db_path)                                                  | bootstrap | Removed from bot.json. Set via `HEX_DB_PATH`.                                                        |
| `pluginDir`                                                           | bootstrap | Removed from bot.json. Set via `HEX_PLUGIN_DIR`.                                                     |
| `pluginsConfig`                                                       | `restart` | Read only on `loadAll()`.                                                                            |
| `logging.level`                                                       | `live`    | `logger.setLevel(...)` already exists.                                                               |
| `logging.mod_actions`                                                 | `live`    | `db.setModLogEnabled(...)` (small new mutator).                                                      |
| `logging.mod_log_retention_days`                                      | `live`    | Read by retention sweep; rebuild interval.                                                           |
| `queue.rate` / `burst`                                                | `live`    | New `messageQueue.setRate(rate, burst)` mutator.                                                     |
| `flood.pub.*` / `flood.msg.*`                                         | `live`    | `dispatcher.setFloodConfig(...)` already exists.                                                     |
| `proxy.*`                                                             | `restart` | Socket-level; cannot mid-session.                                                                    |
| `dcc.enabled`                                                         | `reload`  | Toggle: `attachDcc()` / `dccManager.detach()`.                                                       |
| `dcc.ip` / `port_range`                                               | `reload`  | `dccManager.detach()` + `dccManager.attach()`.                                                       |
| `dcc.require_flags` / `max_sessions` / `idle_timeout_ms`              | `live`    | DCC manager reads on each session; rebuild config.                                                   |
| `botlink.enabled` / `role`                                            | `restart` | Hub vs. leaf decided at start; safer to restart than swap.                                           |
| `botlink.host` / `port` / `password`                                  | `reload`  | Tear down hub/leaf, reconnect.                                                                       |
| `botlink.*` (timeouts, caps, salts)                                   | `live`    | Most are read on each frame/heartbeat — `relayOrchestrator.setConfig()`.                             |
| `botlink.link_salt`                                                   | `restart` | Used in HMAC; changing mid-session breaks every linked bot.                                          |
| `quit_message`                                                        | `live`    | Read on shutdown; pure value swap.                                                                   |
| `channel_rejoin_interval_ms`                                          | `live`    | `lifecycleHandle.setPresenceInterval(ms)` (small new mutator).                                       |
| `channel_retry_schedule_ms`                                           | `live`    | Read on each retry; pure value swap.                                                                 |
| `command_prefix`                                                      | `live`    | `commandHandler.setPrefix(...)` (small new mutator).                                                 |
| `chanmod.nick_recovery_password_env`                                  | env-only  | Unchanged.                                                                                           |
| `memo.memoserv_relay` / `memoserv_nick` / `delivery_cooldown_seconds` | `live`    | `memo.setConfig({...})` (small new mutator).                                                         |
| `plugins.<id>.enabled`                                                | `live`    | New: triggers `pluginLoader.load(id)` / `unload(id)`. See §6.                                        |

Total: ~50 keys. Of these, **~10 are restart, ~10 are reload, ~30 are live** — matching the original 80/20 estimate.

#### Plugin scope — `plugins.json` overrides

Plugin keys are owned by the declaring plugin. Each plugin's `init()` registers them with the new infra (Phase 6). Reload-class is plugin-author's choice; most plugin config is `live` (the plugin's `onChange` listener swaps internal state). Examples drawn from existing plugins:

- `chanmod.auto_op` / `op_flags` / `voice_flags` — `live` (chanmod reads per-event).
- `flood.msg_threshold` / `msg_window_secs` / `actions` — `live` (flood plugin reads per-event).
- `greeter.message` / `delivery` — `live`.
- `ai-chat.provider` / `model` / `temperature` — `live`, but `provider` swap requires resetting any inflight request. Plugin-author concern; documented as "your `onChange` may call `provider.detach()` + `attach()`".
- `rss.feeds` — `live`, plugin re-builds its scheduler.

Plugin scope's full key list is enumerated as part of Phase 6 for each plugin migrated.

### 5. Command surface

Borrowed from Eggdrop where the names carry decades of operator muscle memory; extended where typed registration helps. Scopes are `core`, `<plugin-id>`, or `<channel>`.

```
.set <scope> <key> <value>      # write one key to KV (live-apply via onChange)
.unset <scope> <key>            # delete from KV → reads registered default
.info <scope>                   # show current values + which are overridden vs default
.help set <scope> <key>         # type, default, description, reload-class

.rehash [scope]                 # re-read JSON files, diff vs KV, apply changed keys
                                # No arg: re-reads everything (Eggdrop default).
                                # With scope (.rehash core, .rehash ai-chat):
                                # surgical re-apply during dev/iteration.

.restart                        # full process restart for the 20% that can't live-apply.
                                # Also the answer for plugin authors picking up code edits.
                                # Exits cleanly so supervisor/Docker restarts container.
```

**Removed in this refactor:** `.load`, `.unload`, `.reload`. Plugin enable/disable now goes through `.set core plugins.<id>.enabled true/false` (the canonical path; no aliases). Plugin code changes are picked up by `.restart` (clean process, no leak) or by running `tsx watch` at the process level during active development. Deleting `.reload` removes the audit's CRITICAL leak vector at its source — Node's ESM loader has no module-graph eviction API, so any cache-busted re-import is unrecoverable; the only way out is not to do it.

UX details:

- Permission: `.set` / `.unset` / `.rehash` / `.restart` require `n` (owner). `.info` and `.help set` are read-only — open to anyone with a command session.
- Discovery: `.set` with no args lists scopes (`core`, every loaded plugin id, every joined channel). `.set core` lists every registered key for core scope. Same for plugin/channel.
- Display markers: an asterisk after the key name indicates the value is overridden vs. registered default, matching `.chanset`'s existing convention.
- Reload-class hints: write replies include the class — `.set core logging.level debug` → `core.logging.level = debug (applied live)`; `.set core irc.host new.host.net` → `core.irc.host = new.host.net (stored; takes effect after .restart)`.
- Channel-scope alias: `.chanset #chan +key` keeps working as a synonym for `.set #chan key true`; existing operators see no behavior change. Internally, both routes through the new registry.
- Audit shape: `mod_log` rows use `coreset-set` / `coreset-unset` / `pluginset-set` / `pluginset-unset` / `rehash` / `restart` actions. `chanset-set` / `chanset-unset` keep their existing shape. The pre-refactor `plugin-load` / `plugin-unload` / `plugin-reload` actions are retired (commands deleted) but historical rows remain queryable via `.modlog` filter.

`.set` and `.rehash` produce the same end state for a given key (KV updated, `onChange` fired). They differ in workflow: `.set` is one-off and operator-friendly from IRC/DCC; `.rehash` is bulk and file-driven. Operators choose by preference. `.rehash` only adds/updates KV from JSON; deletions are not propagated (operators use `.unset` to revert a key to its registered default).

### 6. Plugin lifecycle as config

Plugin enabled/disabled state is itself a config key under `core` scope:

```
.set core plugins.ai-chat.enabled true     # load and start the plugin
.set core plugins.ai-chat.enabled false    # stop and unload the plugin
```

This is the **only** way to enable or disable a plugin. The old `.load <plugin>` / `.unload <plugin>` / `.reload <plugin>` commands are deleted in this refactor — no aliases, no muscle-memory shorthand, no code-only reload path. One paradigm: config drives state.

Plugin lifecycle gets the same persistence guarantees as every other config key: state survives process restart automatically. On startup, after `core` scope KV is loaded, the plugin loader reads `core.plugins.<id>.enabled` for each plugin and loads the enabled set. The seed-from-JSON path (Phase 5) populates the key on first boot from `plugins.json`'s `enabled` flag.

Plugin authors picking up code edits use `.restart` for a clean process restart (no module-graph residue), or run `tsx watch` at the process level during active development.

The `enabled` key for each plugin defaults to `false` (plugins are off until explicitly enabled). plugins.json seeds it to `true` for plugins the operator has configured. `.unset core plugins.<id>.enabled` reverts to the default — i.e. disables the plugin.

### 7. Behavior at write time (state machine)

```
.set <scope> <key> <value>:
  1. Validate: scope known? key registered in scope? value coerces to declared type? in allowedValues if set?
  2. Audit: write coreset-set / pluginset-set / chanset-set row to mod_log (auditActor(ctx) attribution).
  3. KV write: db.set(<namespace>, <key>, String(value)). Wrapped in runClassified — DatabaseFullError surfaces cleanly.
  4. Notify: registry.notifyChange(scope, key, value) walks per-scope onChange listeners (try/catch each, log on error).
  5. Reload-class action:
       - live    → no-op (the listener already applied during step 4).
       - reload  → invoke the subsystem's swap closure (registered alongside the key).
       - restart → reply.warn("stored; takes effect after .restart").
  6. Reply: succinct "scope.key = value (applied|reload|restart)" line.

.unset <scope> <key>:
  1. KV delete: db.del(<namespace>, <key>).
  2. Audit: coreset-unset / pluginset-unset / chanset-unset row.
  3. Notify with the registered default value (so listeners apply the revert).
  4. Reload-class action: same as .set.
  5. Reply: "scope.key reverted to default (<default>)".

.rehash [scope]:
  1. Read bot.json + plugins.json from disk (re-validate via Zod).
  2. For each registered key in scope (or all scopes):
       - If JSON has a value AND (KV is unset OR KV value != JSON value):
           treat as a .set <scope> <key> <json-value> (full audit + onChange + reload-class action).
       - Else: skip.
  3. Reply: count of keys updated, count unchanged, count whose reload class is restart (operator must run .restart for those to take effect).
```

## Phases

### Phase 1: Bootstrap layer + KV scope generalization (foundation)

**Goal:** Decouple the boot sequence from bot.json; introduce `core` and `plugin:<id>` KV namespaces side-by-side with `chanset`. Bot.json bootstrap keys are removed outright — no transitional fallback.

- [x] Add `src/bootstrap.ts`: reads `HEX_DB_PATH`, `HEX_OWNER_HOSTMASK`, `HEX_OWNER_HANDLE`, `HEX_PLUGIN_DIR` from `process.env`; throws clear errors naming the missing var when any is unset.
- [x] Modify `src/bot.ts` constructor (line 197-233) to consult bootstrap before `loadConfig()` so DB path / plugin dir come from env (single source).
- [x] Modify `src/core/owner-bootstrap.ts` to seed from env on first boot when KV has no owner record. Remove the bot.json owner-record seeding path entirely.
- [x] Remove `database`, `owner.hostmask`, `owner.handle`, `pluginDir` fields from `BotConfigOnDisk` (`src/types/config.ts`) and `BotConfigOnDiskSchema` (`src/config/schemas.ts`). Strict-object validation now rejects any bot.json that still carries them with a clear Zod error pointing at the env var to set.
- [x] Add `core` namespace to `src/database.ts`'s reserved-namespace allowlist comment (no schema work — namespaces are arbitrary strings).
- [x] Update `config/bot.example.json` and the live `config/bot.json` to drop the removed fields.
- [x] Update `config/bot.env.example` and the live `config/bot.env` with `HEX_DB_PATH=./data/hexbot.db`, `HEX_PLUGIN_DIR=./plugins`, `HEX_OWNER_HANDLE=admin`, `HEX_OWNER_HOSTMASK=*!yourident@your.host.here`.
- [x] Update `Dockerfile` and `docker-compose*.yml` to set the new env vars.
- [x] **Verification:** Boot with env vars set → starts cleanly. Boot with any env var missing → fails with explicit `set HEX_DB_PATH` (or relevant) message naming the exact var. Boot with bot.json containing a removed field → Zod strict-object rejects with a clear "field removed; set env var X" hint.

### Phase 2: SettingsRegistry — three-scope generalization

**Goal:** Refactor `ChannelSettings` into a multi-scope registry; preserve `api.channelSettings` for plugin compatibility.

- [x] Create `src/core/settings-registry.ts` — a class taking a `scope: 'core' | 'plugin' | 'channel'` and a KV namespace. Contains `register()`, `unregister(owner)`, `set()`, `unset()`, `get()`, `getDef()`, `getSnapshot()`, `onChange(owner, cb)`, `offChange(owner)`. Logic mirrors `src/core/channel-settings.ts:33-261` but parameterized on scope so the channel-key-folding only runs for channel scope.
- [x] Refactor `src/core/channel-settings.ts` to be a thin wrapper that constructs a `SettingsRegistry` with `scope: 'channel'`, namespace `chanset`, and the `ircLower` channel folder. Public API unchanged (plugins keep working).
- [x] Add `coreSettings: SettingsRegistry` and `pluginSettings: Map<pluginId, SettingsRegistry>` to `Bot` class (`src/bot.ts`).
- [x] Wire core-scope listener drain on shutdown: `coreSettings.unregister('bot')` in `Bot.shutdown()`.
- [x] Wire plugin-scope listener drain on unload: extend `cleanupPluginResources` (`src/plugin-loader.ts:513-530`) to call `pluginSettings.get(pluginName)?.offChange(pluginName)` and unregister the entire plugin namespace.
- [x] Extend `PluginAPI` (`src/types/plugin-api.ts`) with `coreSettings: PluginCoreSettingsView` (read-only — plugins observe core but don't mutate it) and `settings: PluginSettings` (read/write own plugin scope).
- [x] Update `src/plugin-api-factory.ts` to populate the new fields with scope-aware wrappers (write disabled for `coreSettings`).
- [x] **Verification:** Add `tests/core/settings-registry.test.ts` covering all three scopes — register/set/get/unset round-trip, onChange fires per scope, unregister(owner) drains only that owner, channel-key-folding still works on channel scope, no folding on core/plugin scope.

### Phase 3: Reload-class metadata + Zod schema extensions

**Goal:** Every registered key declares its reload class via `.describe('@reload:*')`; the registry enforces & surfaces it.

- [x] Extend `ChannelSettingDef` / new `SettingDef` interface with `reloadClass: 'live' | 'reload' | 'restart'`.
- [x] Add `parseReloadClassFromZod(schema): ReloadClass` helper in `src/core/settings-registry.ts` that reads `.description` for the `@reload:*` token (defaults to `live` if absent — safest default).
- [x] Extend `SettingDef` with optional `onReload?: () => void | Promise<void>` and `onRestartRequired?: () => string` for the reload/restart classes. The registry's `notifyChange` invokes them according to class.
- [x] Update `src/config/schemas.ts` — annotate every key in `BotConfigOnDiskSchema` with `.describe('@reload:<class>')`. Match the matrix in §4 above.
- [x] **Verification:** `tests/config-schema.test.ts` — every key has a parseable `@reload:*` token; unannotated keys default to `live` and emit a debug log entry.

### Phase 4: `.set` / `.unset` / `.info` / `.help set` core commands

**Goal:** The operator command surface is live; `.set core` / `.set <plugin>` / `.set <channel>` all work end-to-end.

- [x] Create `src/core/commands/settings-commands.ts`. One `.set` registration, one `.unset`, one `.info`, one `.help` extension (`.help set <scope> <key>`).
- [x] Permission gate: `flags: 'n'` on `.set` / `.unset`; `flags: '-'` on `.info`; `.help set` reuses existing help permission.
- [x] Audit: every mutation writes the appropriate `mod_log` row via `tryAudit`, mirroring `channel-commands.ts:135-200`.
- [x] Reuse `.chanset`'s flag-grid + value-line snapshot rendering (`src/core/commands/channel-commands.ts:25-55`) — extract into a shared helper.
- [x] Channel-scope alias: `.chanset` keeps its current syntax; internally calls into the same registry. Migrate `src/core/commands/channel-commands.ts` to delegate.
- [x] Wire registration site in `src/bot.ts:497-553`'s `registerCoreCommands()` between `registerChannelCommands` and `registerModlogCommands`.
- [x] **Verification:** `tests/core/commands/settings-commands.test.ts` — `.set core logging.level debug`, `.unset core logging.level`, `.info core`, `.help set core logging.level`. Verify mod_log row emitted, `onChange` fires, default-revert path works. Verify scope discovery (`.set` with no args).

### Phase 5: `.rehash [scope]`

**Goal:** Re-read JSON, diff vs KV, apply additions/updates. Deletions intentionally NOT propagated.

- [x] Add `src/core/seed-from-json.ts` with `seedFromJson(registry, jsonPath, scope)`: walks the validated JSON tree, calls `registry.set(key, value)` for each key whose KV value is unset OR differs from JSON. Returns counts (added/updated/unchanged/restart-required).
- [x] Wire the same helper into the boot path so first-boot KV-empty seeding uses the same code as `.rehash`.
- [x] Add `.rehash [scope]` command in `settings-commands.ts`.
- [x] Reply formatting: count per reload class so operators see "12 keys applied live, 2 reloaded, 1 stored awaiting .restart".
- [x] **Verification:** `tests/core/seed-from-json.test.ts` — seed empty KV from JSON (every key seeded); `.rehash` after JSON edit picks up changed keys; `.rehash` with JSON unchanged is a no-op; `.rehash` with key removed from JSON does NOT delete the KV value.

### Phase 6: Migrate one core subsystem end-to-end (logging.level)

**Goal:** Prove the registry/command/reload-class wiring with the simplest possible key. `logging.level` has zero IRC-connection involvement and an existing `logger.setLevel()`.

- [x] In `Bot` constructor, after creating `coreSettings`, call `coreSettings.register('bot', [{ key: 'logging.level', type: 'string', default: 'info', allowedValues: ['debug','info','warn','error'], description: 'Log level', reloadClass: 'live' }])`.
- [x] Register an `onChange` listener: `coreSettings.onChange('bot', (_scope, key, value) => { if (key === 'logging.level') this.logger.setLevel(value); })`.
- [x] Update boot path: `seedFromJson(coreSettings, bot.json, 'core')` runs after KV opens. The seeded value is then `get()`-able via `coreSettings.getString('logging.level')`.
- [x] Replace `createLogger(this.config.logging.level)` (`bot.ts:202`) with `createLogger(coreSettings.getString('logging.level'))` — initial logger reads file value; boot seed and `.set` apply KV-canonical level after `db.open()`.
- [x] **Verification:** Manual smoke — start bot at info, `.set core logging.level debug` → debug logs appear in next handler dispatch. Restart → debug persists.

### Phase 7: Migrate remaining core subsystems

**Goal:** Walk the §4 matrix, register every core key, wire its onChange / onReload / onRestartRequired. Group by reload class so each PR is reviewable.

- [x] **Live keys (no reattach):** `services.identify_before_join*`, `services.services_host_pattern`, `flood.pub.*` / `flood.msg.*`, `queue.rate|burst` (added `MessageQueue.setRate` mutator), `dcc.require_flags|max_sessions|idle_timeout_ms`, `quit_message`, `channel_rejoin_interval_ms`, `memo.*` (added `MemoManager.setConfig`), `logging.mod_actions` (added `BotDatabase.setModLogEnabled`), `logging.mod_log_retention_days` (added `BotDatabase.setModLogRetentionDays`). Skipped (array-typed; out-of-scope until typed-array support): `identity.require_acc_for`, `irc.channels`, `channel_retry_schedule_ms`, `botlink.auth_ip_whitelist`, `dcc.port_range`. `command_prefix` registered as `restart` (live mutation would require sweeping every cached `usage:` string — deferred).
- [x] **Reload keys:** `irc.nick` (`client.changeNick`). `services.type|nickserv`, `dcc.enabled|ip`, `botlink.host|port|password` deferred to follow-up — they need full subsystem detach/reattach plumbing that lands more cleanly alongside Phase 9/10.
- [x] **Restart keys:** `irc.host|port|tls|username|realname`, `services.type|nickserv|sasl|sasl_mechanism`, `identity.method`, `pluginsConfig`, `command_prefix`. Registered with `reloadClass: 'restart'`; the operator-facing `(stored; takes effect after .restart)` hint comes from the registry's reload-class outcome.
- [x] Live-key unit test: `tests/core/bot-core-settings.test.ts` exercises logging/queue/flood/mod_actions/memo via `.set`.
- [x] Reload-key integration test: `tests/core/bot-core-settings.test.ts` asserts `irc.nick` fires `onReload` and the reply renders the subsystem-reloaded hint.
- [x] Restart-key test: `tests/core/bot-core-settings.test.ts` asserts `.set core irc.host` stores the value, surfaces the restart hint, and triggers no live reattach.
- [x] **Verification:** Full bot smoke run — toggle each key, observe expected behavior, run `.restart` and confirm restart-class keys take effect on the new process.

### Phase 8: Migrate plugin scope (cuts api.config)

**Goal:** Each plugin's `init()` registers its keys with `api.settings`. `api.config` is removed — clean cut, no deprecation period. Every shipped plugin migrates in lockstep with the type change.

- [x] Update plugin API in `src/plugin-api-factory.ts` to wire `api.settings.register(...)`, `api.settings.set(key, value)` (read/write for own scope), `api.settings.get(key)`, `api.settings.onChange(...)`.
- [x] Remove `config: Record<string, unknown>` from `PluginAPI` (`src/types/plugin-api.ts`). Replaced by `api.settings.bootConfig` (frozen merged JSON bag) for plugins with deeply-nested config that doesn't flatten to typed settings; `api.settings.register()` + getters is the recommended path for new keys.
- [x] Migrate every shipped plugin:
  - [x] `seen`: registers `max_age_days` / `max_entries` via `api.settings` and reads via `api.settings.getInt(...)` per dispatch so `.set seen max_age_days <n>` takes effect live.
  - [x] `ai-chat`: parseConfig now feeds off `api.settings.bootConfig` (escape-hatch for the complex nested tree); operator-mutable scalars are a follow-up.
  - [x] `chanmod`: ~50 typed setting defs registered via `CHANMOD_SETTING_DEFS`; `readConfig` reads from `api.settings`.
  - [x] `flood`: 17 typed defs registered; `actions` ladder stored as comma-separated string and parsed via `cfgActions()`.
  - [x] `rss`: scalar tunables (`dedup_window_days`, `request_timeout_ms`, `max_per_poll`, ...) registered; the structured `feeds` list still reads from `api.settings.bootConfig`.
  - [x] `greeter`: `min_flag` / `delivery` / `join_notice` / `message` registered; per-channel `greet_msg` default reflects the plugin-scope `message` value.
  - [x] `help`: `cooldown_ms` / `reply_type` / `compact_index` / `header` / `footer` registered.
  - [x] `8ball`, `topic`, `ctcp`: no `api.config` use, no migration needed.
- [x] Plugin-scope `.info <plugin>` lists only that plugin's registered keys (Phase 4 already implements this generically).
- [x] Update `docs/PLUGIN_API.md` to drop `api.config` and document `api.settings` + `api.settings.bootConfig`. Updated `plugins/README.md` example to show typed-settings registration.
- [x] **Verification:** Compile passes; full test suite (3966 tests) green with every plugin migrated and `api.config` removed from the type and factory.

### Phase 9: Plugin lifecycle as config + delete `.load` / `.unload`

**Goal:** `core.plugins.<id>.enabled` is the only path to enable/disable a plugin. The old commands are deleted, not aliased.

- [x] Register `core.plugins.<id>.enabled` for each known plugin during `loadAll()` (registration only — load is gated on the value).
- [x] Add `onChange` handler for `core.plugins.<id>.enabled`: true → `pluginLoader.load(<pluginPath>)`; false → `pluginLoader.unload(<id>)`.
- [x] Delete the `.load` and `.unload` command registrations from `src/core/commands/plugin-commands.ts`. Keep `.plugins` (read-only listing).
- [x] Update `loadAll()` boot path (`src/plugin-loader.ts:198-254`) to read `core.plugins.<id>.enabled` exclusively — the seed-from-JSON path (Phase 5) populates it on first boot from `plugins.json`'s `enabled` field. No fallback branch needed since seeding runs before `loadAll()`.
- [x] **Verification:** `.set core plugins.greeter.enabled false` → greeter unloads cleanly; bot restart → greeter stays unloaded; `.set core plugins.greeter.enabled true` → greeter loads on the running process. `.load` and `.unload` typed at the prompt return "unknown command". (Tests for `.load`/`.unload`/`.reload` deleted; bot.test.ts asserts the commands are gone.)

### Phase 10: `.restart` command + delete `.reload` and cache-busting

**Goal:** Ship `.restart` for restart-class keys. Delete `.reload` and the cache-busting code path, killing the audit's CRITICAL at the source rather than mitigating it.

- [x] Add `.restart` command in `settings-commands.ts`: writes `restart` audit row, then calls `bot.shutdown()` and `process.exit(0)`. Supervisor (Docker / systemd / pm2) handles the actual restart.
- [x] Delete `.reload` command registration from `src/core/commands/plugin-commands.ts`.
- [x] Delete `reload(pluginName)` method from `src/plugin-loader.ts`. After Phase 9 + the `.reload` deletion above it has no remaining callers.
- [x] Delete `importWithCacheBust` from `src/plugin-loader.ts`. Replace its single call site in `load()` with a plain `await import(pathToFileURL(absPath).href)`. ESM keys this by URL with no query string; first/second `load()` of the same plugin path resolve to one cached module — exactly what we want for unload→re-enable cycles.
- [x] Delete the `importedOnce` Set field — no longer referenced.
- [x] Delete `plugin:reloaded` and `plugin:reload_failed` event types from `src/event-bus.ts`; remove the matching `eventBus.emit` sites in plugin-loader.
- [x] Add `pluginLoader.unloadAll()` and call it from `Bot.shutdown()` between `relay-orchestrator.stop` and `memo.detach`. Doubles as a fix for the audit's W-PS finding ("plugins miss their teardown chance on process exit").
- [x] Update `docs/audits/memleak-all-2026-04-25.md` — mark the CRITICAL as resolved by deletion of the leak vector, not by mitigation.
- [x] **Verification:** `tsc --noEmit` shows zero unresolved references to deleted symbols. `tests/plugin-loader.test.ts` updated: `.reload` and `importWithCacheBust` tests deleted; `unloadAll()` tests added; existing `load`/`unload` tests pass unchanged. Full suite green (3952 tests).

### Phase 11: Docs

**Goal:** DESIGN.md, getting-started, and the in-tree config cheat-sheet match the new mechanics.

- [x] Update `docs/GETTING_STARTED.md` with a "Live config" section: `.set` for one-off, `.rehash` for file-driven bulk, `.restart` for the 20% that can't live-apply (and for picking up plugin code edits), `.set core plugins.<id>.enabled` for enable/disable. Note that `.load` / `.unload` / `.reload` are gone.
- [x] Update `DESIGN.md` overview to mention KV-canonical-after-first-boot and the live-config command surface; replace the old "Hot-reload workflow" section with a process-restart-based plugin iteration workflow that explains why we deleted the cache-busting path.
- [x] Update `CHANGELOG.md` with the unreleased-version entry summarising scope generalization, command surface, reload classes, and the audit-CRITICAL kill.
- [x] Add a one-page `docs/CONFIG.md` cheat-sheet listing the bootstrap env vars, the operator command surface, the three reload classes, plugin lifecycle, and the audit action strings. Hand-written rather than generated — keeps a single source of truth between docs and the registry without a build step. Future work can generate it from the registry snapshot.
- [x] Update `README.md`'s feature list to replace the "Hot-reloadable plugins" line with the live-config + plugin-lifecycle-as-config description; updated the Quick start + bootstrap/secrets sections.
- [x] **Verification:** Full test suite green (3952 tests). Manual smoke deferred — `pnpm dev` from a fresh checkout following only the docs requires interactive setup and is best done by the operator.

## Config changes

- New env vars (Phase 1): `HEX_DB_PATH`, `HEX_OWNER_HOSTMASK`, `HEX_OWNER_HANDLE`, `HEX_PLUGIN_DIR`. Documented in `config/bot.env.example`. Prefix matches existing `HEX_NICKSERV_PASSWORD` / `HEX_OWNER_PASSWORD` style.
- bot.json keys `database`, `owner.hostmask`, `owner.handle`, `pluginDir` are removed outright in this refactor (Phase 1). Strict-object Zod validation rejects bot.json files that still carry them with a clear "set env var X" hint.
- Every other bot.json key gains a `.describe('@reload:*')` annotation in `src/config/schemas.ts`. No on-disk shape change; the existing strict-object validation continues to reject typos.
- Phase 8 removes `api.config`; every shipped plugin's `init()` calls `api.settings.register([...])` and reads via `api.settings.get(key)`. TypeScript catches every stale call site at compile time.

Example registration shape (matches existing `ChannelSettingDef`):

```ts
api.settings.register([
  {
    key: 'temperature',
    type: 'string',
    default: '0.9',
    description: 'AI sampling temperature',
    reloadClass: 'live',
  },
  {
    key: 'provider',
    type: 'string',
    default: 'gemini',
    allowedValues: ['gemini', 'ollama'],
    description: 'AI backend provider',
    reloadClass: 'reload',
    onReload: async () => {
      await this.provider.detach();
      this.provider = build();
    },
  },
]);
```

## Database changes

No schema migration. Three new logical KV namespaces are added; the table schema itself accepts arbitrary namespace strings:

- `core` — bot-wide live config (`logging.level`, `flood.pub.count`, `irc.nick`, etc.).
- `plugin:<id>` — per-plugin live config.
- `chanset` — unchanged from today (per-channel settings).

The reserved-prefix comment in `src/plugin-loader.ts:118-126` already prevents plugin names from colliding with core namespaces (leading-alphanumeric anchor on `SAFE_NAME_RE`); no change needed there.

`mod_log` gains six new action strings — `coreset-set`, `coreset-unset`, `pluginset-set`, `pluginset-unset`, `rehash`, `restart`. Existing `chanset-set` / `chanset-unset` shapes are preserved. The pre-refactor `plugin-load` / `plugin-unload` / `plugin-reload` action strings are retired (commands deleted) but historical rows remain queryable. No schema migration; the action column is a TEXT field already.

## Test plan

Per phase (verifications are inline in each Phase above). Cross-cutting:

- **`tests/core/settings-registry.test.ts`** — new. Three-scope round-trip, onChange propagation, unregister(owner) drain, no cross-scope leakage, channel-key folding only on channel scope.
- **`tests/core/seed-from-json.test.ts`** — new. First-boot empty-KV seeding, `.rehash` diff-and-apply, `.rehash` with no changes is no-op, deletions in JSON do not propagate.
- **`tests/core/commands/settings-commands.test.ts`** — new. `.set` / `.unset` / `.info` / `.help set` / `.rehash` / `.restart` end-to-end with mock command handler. Permission gates. Audit row emission.
- **`tests/plugin-loader.test.ts`** — extend. Plugin lifecycle as config: `.set core plugins.<id>.enabled false` triggers `unload()`. `pluginLoader.unloadAll()` runs every plugin's teardown on shutdown. Tests of `.reload`, `importWithCacheBust`, and `importedOnce` are deleted (the code paths are gone).
- **`tests/bot.test.ts`** — extend. Boot path consults bootstrap env vars; KV-canonical-after-first-boot semantics; `.restart` path exits with code 0.
- **Per-subsystem tests** (Phase 7) — `.set core flood.pub.count 10` updates flood limiter; `.set core logging.level debug` updates logger; `.set core dcc.enabled false` detaches DCC; `.set core irc.host new.host` warns restart-required.
- **Per-plugin tests** (Phase 8) — each migrated plugin's existing test suite runs unchanged; plus one new test per plugin asserting `.set <plugin> <key> <value>` is observed by the plugin's runtime.
- **Manual smoke** — Phase 10's heap-snapshot exercise is the receipt for the audit-CRITICAL kill: 50 cycles of `.set core plugins.greeter.enabled` toggling produce a flat heap because import is cache-friendly and there is no longer a path that mints new ESM registry entries.

## Decisions

Resolved before Phase 1 starts. Recorded here so future readers can see the trade-off considered for each. Pacing/compat questions are absent — this is one continuous refactor with no version-release ceremony, no transitional fallback, no deprecation periods (the whole repo migrates in lockstep).

1. **Bootstrap env-var naming → `HEX_*`.** `HEX_DB_PATH` / `HEX_OWNER_HOSTMASK` / `HEX_OWNER_HANDLE` / `HEX_PLUGIN_DIR`. Matches the existing `HEX_NICKSERV_PASSWORD` / `HEX_OWNER_PASSWORD` convention; one prefix for everything env-sourced. (Alternative considered: `HEXBOT_*` to distinguish bootstrap from secrets — rejected for naming churn.)
2. **Restart-class keys → warn and stage.** `.set core irc.host new.host` writes the value and replies "stored; takes effect after .restart". Eggdrop-aligned; lets ops stage changes ("cut over to new server at 2am"). The reload-class hint in every reply is the operator's reminder. (Alternative considered: refuse without an explicit `--staged` flag — rejected as ergonomically heavy.)
3. **Plugin self-write → read/write.** `api.settings.set(key, value)` works for the plugin's own scope (matches current `api.channelSettings.set()`). A plugin can persist its own runtime state through the same surface operators use. (Alternative considered: read-only-from-plugin to prevent a buggy plugin hammering KV — rejected as more restrictive than current behavior.)
4. **Botlink replication → none.** `core` and `plugin:<id>` scopes do NOT replicate across linked bots. Each bot in a botnet owns its own config. The channel scope's existing replication semantics are unchanged. Adding cross-bot config push is a deliberate non-goal here. (Alternative considered: opt-in `replicate: true` registration flag — deferred; can be added later without a breaking change.)
5. **`.rehash` deletions → not propagated.** Matches `password_env` semantics: JSON is a seed, not authoritative. Operators use `.unset` to revert a key to its registered default. (Alternative considered: `.rehash --strict` mode that does propagate deletions — deferred until an actual need surfaces.)
6. **`.load` / `.unload` / `.reload` and cache-busting → deleted outright.** Plugin enable/disable is `.set core plugins.<id>.enabled true/false` — single canonical path, no aliases. Plugin authors picking up code edits use `.restart` (clean process, no leak) or `tsx watch` at the process level. The plugin-loader's `importWithCacheBust`, `importedOnce`, and `reload(name)` are deleted alongside; `plugin:reloaded` / `plugin:reload_failed` events go with them. This kills the audit's CRITICAL leak vector at its source rather than papering over it. (Alternative considered: keep `.reload` with the audit's recommended mitigations — file-mtime gate, `importedOnce` prune, reload counter, CRITICAL banner — rejected; carrying a known leak with three layers of defense violates the clean-cut posture.)
