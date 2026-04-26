# Config cheat-sheet

HexBot has three config surfaces:

1. **Bootstrap env vars** — read before the SQLite KV is open; required at every boot.
2. **`config/bot.json`** — initial seed for everything else; canonical until first boot, then KV wins.
3. **SQLite KV** — operator-set values via `.set` / `.unset` / `.rehash`; durable across restarts.

After first boot, `bot.json` edits do **not** auto-apply on restart. Run `.rehash` to pull JSON edits into KV (additions and updates only — JSON deletions are not propagated; use `.unset <scope> <key>` to revert). This mirrors the existing `password_env` precedent: the file is a seed, not authoritative.

## Bootstrap env vars (`config/bot.env`)

| Var                     | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `HEX_DB_PATH`           | SQLite database file path (e.g. `./data/hexbot.db`) |
| `HEX_PLUGIN_DIR`        | Plugin directory path (e.g. `./plugins`)            |
| `HEX_OWNER_HANDLE`      | Owner handle, seeded once on first boot             |
| `HEX_OWNER_HOSTMASK`    | Owner hostmask, seeded once on first boot           |
| `HEX_OWNER_PASSWORD`    | Seed password for owner DCC (consumed once)         |
| `HEX_NICKSERV_PASSWORD` | Required when SASL/IDENTIFY is enabled              |
| `HEX_BOTLINK_PASSWORD`  | Required when bot-link is enabled                   |
| `HEX_PROXY_PASSWORD`    | Required when SOCKS5 proxy `username` is set        |

## Operator commands

```
.set <scope> <key> <value>      # write one key to KV (live-apply via onChange)
.unset <scope> <key>            # delete from KV → reads registered default
.info <scope>                   # show current values + which are overridden vs default
.help set <scope> <key>         # type, default, description, reload-class

.rehash [scope]                 # re-read JSON files, diff vs KV, apply changed keys
.restart                        # shut down cleanly so the supervisor restarts the process
```

Scopes:

- **`core`** — bot-wide live config (`logging.level`, `flood.pub.count`, `irc.nick`, `plugins.<id>.enabled`, …).
- **`<plugin-id>`** — per-plugin config (`.set ai-chat temperature 0.5`).
- **`<channel>`** — per-channel settings (`.set #hexbot greet_msg "Welcome!"`); the legacy `.chanset` syntax remains as an alias.

## Reload classes

Every `core` setting declares one of three reload classes via `.describe('@reload:*')` on its Zod schema. `.set` echoes the class as a hint:

| Class     | Behavior                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `live`    | Applied immediately. Reply: `(applied live)`.                                                                |
| `reload`  | Subsystem reattaches (e.g. `client.changeNick`). Reply: `(applied; subsystem reloaded)`.                     |
| `restart` | KV updated but value takes effect on the next process start. Reply: `(stored; takes effect after .restart)`. |

The full key matrix lives in [`docs/plans/live-config-updates.md` §4](plans/live-config-updates.md#4-reload-class-matrix-authoritative-key-list).

## Plugin lifecycle

Plugin enable/disable is itself a config key:

```
.set core plugins.ai-chat.enabled true     # load and start the plugin
.set core plugins.ai-chat.enabled false    # stop and unload the plugin
```

This is the **only** way to enable or disable a plugin at runtime. The pre-2026-04-25 `.load` / `.unload` / `.reload` commands were deleted alongside the cache-busting import path that powered them (it was the source of the audit's CRITICAL — see `docs/audits/memleak-all-2026-04-25.md`).

To pick up plugin code edits, use `.restart` for a clean process restart (no module-graph residue) or run `tsx watch` at the process level during active development.

## Audit attribution

Every `.set` / `.unset` / `.rehash` / `.restart` writes a `mod_log` row with `auditActor(ctx)` attribution — the same shape as every other privileged action. Action strings:

- `coreset-set` / `coreset-unset` — core scope writes
- `pluginset-set` / `pluginset-unset` — plugin scope writes
- `chanset-set` / `chanset-unset` — channel scope writes
- `rehash` — every `.rehash` invocation
- `restart` — every `.restart` invocation

Filter via `.modlog --action coreset-set` etc.
