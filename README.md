# HexBot

![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/jstnmthw/50c25c1f05168b07d48f34f8c8351ca5/raw/hexbot-coverage.json)

HexBot is a modular Internet Relay Chat bot for Node.js, written in TypeScript. Designed for reliability and extensibility, HexBot runs on any IRC network and can be deployed in seconds using Docker.

## Highlights

- **Event bind system** — register handlers for IRC events with `bind(type, flags, mask, handler)`.
- **Flag-based permissions** — owner/master/op/voice flags with hostmask and IRCv3 account-tag matching
- **Live config + plugin lifecycle as config** — `.set core <key> <value>` applies most changes on the spot. Plugin enable/disable flows through `.set core plugins.<id>.enabled true/false`. SQLite KV preserves operator changes across restarts; `.restart` covers the small subset of keys that can't apply live
- **DCC CHAT console** — remote admin console (party line) with per-user authentication (scrypt passwords) and per-session log-stream flags
- **Bot linking** — hub-and-leaf multi-bot networking with permission sync, command relay, and ban sharing
- **Audit log** — every privileged action lands in `mod_log` with structured filters via `.modlog` / `.audit-tail`
- **Flood protection** — token-bucket outgoing queue and per-user input rate limiting
- **IRCv3 ready** — ISUPPORT-driven mode/prefix handling, `extended-join`/`account-notify`/`away-notify`/`account-tag` consumption, and Strict Transport Security enforcement
- **Docker-ready** — multi-stage build, healthcheck, bind-mount config and plugins

## Quick start

Requires Node.js 24+ and pnpm.

```bash
git clone https://github.com/jstnmthw/hexbot.git && cd hexbot
pnpm install
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
cp config/bot.env.example config/bot.env && chmod 600 config/bot.env
# Edit config/bot.json for your IRC server, nick, channels, and plugins.
# Edit config/bot.env to set bootstrap values (HEX_DB_PATH, HEX_PLUGIN_DIR,
# HEX_OWNER_HANDLE, HEX_OWNER_HOSTMASK) and any secrets.
pnpm dev          # start with interactive REPL
```

`pnpm start` runs without the REPL. Use `--config <path>` to specify an alternate config file.

For a more detailed walkthrough, see the **[Getting Started guide](docs/GETTING_STARTED.md)**.

### Bootstrap + secrets in `config/bot.env`

Two classes of values live in `config/bot.env`:

1. **Bootstrap (required at every boot, read before the SQLite KV is opened):** `HEX_DB_PATH`, `HEX_PLUGIN_DIR`, `HEX_OWNER_HANDLE`, `HEX_OWNER_HOSTMASK`. The owner identity is consumed only on first boot to seed the user record; the DB is the store of record after that.
2. **Secrets (resolved via `<field>_env` in `bot.json`):** `HEX_NICKSERV_PASSWORD`, `HEX_BOTLINK_PASSWORD`, `HEX_CHANMOD_RECOVERY_PASSWORD`, `HEX_PROXY_PASSWORD`, `HEX_GEMINI_API_KEY`, etc.

The loader fails loudly if a required value is missing. `pnpm start` / `pnpm dev` auto-load `config/bot.env`. The `HEX_` prefix namespaces these so they won't collide with other services on the host. Plugin configs may declare their own `<field>_env` fields; the loader resolves them before the plugin sees its config.

### Running multiple bots

Each bot instance has its own config, plugin overrides, env file, and database. The recommended layout groups configs by network:

```
config/
├── libera/
│   ├── chanbot.json           # bot config
│   ├── chanbot-plugins.json   # plugin overrides for this bot
│   ├── chanbot.env            # per-bot secrets (gitignored)
│   └── rpgbot.json
└── rizon/
    ├── enforcer.json
    └── enforcer.env

data/libera-chanbot.db          # per-bot database
data/libera-rpgbot.db
data/rizon-enforcer.db
```

Launch each instance with its own env file and config:

```bash
tsx --env-file=config/libera/chanbot.env src/index.ts --config=config/libera/chanbot.json
tsx --env-file=config/rizon/enforcer.env src/index.ts --config=config/rizon/enforcer.json
```

The `config/<network>/<bot-name>.json` layout is a convention — `--config=` accepts any path. Link bots together via the `botlink` block in each bot's config. See [docs/BOTLINK.md](docs/BOTLINK.md). A full worked example lives under [config/examples/multi-bot/](config/examples/multi-bot/README.md), and a docker-compose snippet for running multiple bots is in [docs/multi-instance/docker-compose.yml](docs/multi-instance/docker-compose.yml).

## Plugins

Plugins live in `plugins/<name>/` and are auto-discovered on startup. Any plugin directory containing an `index.ts` is loaded automatically — no config entry required. To disable a plugin, add it to `config/plugins.json` with `"enabled": false`. Use `plugins.json` to override config, restrict channels, or disable specific plugins.

### Included plugins

| Plugin      | Commands                                                                                                     | Description                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **8ball**   | `!8ball <question>`                                                                                          | Magic 8-ball responses                                                                                                   |
| **chanmod** | `!op`, `!deop`, `!halfop`, `!dehalfop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`, `!bans` | Channel protection: auto-op/halfop/voice on join, mode enforcement, bitch/punish/enforcebans, rejoin/revenge, timed bans |
| **ctcp**    | _(automatic)_                                                                                                | Replies to CTCP VERSION, PING, and TIME requests                                                                         |
| **flood**   | _(automatic)_                                                                                                | Inbound flood protection: rate limiting, join/part spam, nick-change spam; escalating enforcement                        |
| **greeter** | _(automatic)_                                                                                                | Greets users on channel join                                                                                             |
| **help**    | `!help [command]`                                                                                            | Lists available commands or shows help for a specific command                                                            |
| **rss**     | `!rss list`, `!rss add`, `!rss remove`, `!rss check`                                                         | Polls RSS/Atom feeds and announces new items to configured channels                                                      |
| **seen**    | `!seen <nick>`                                                                                               | Tracks when a user was last active                                                                                       |
| **topic**   | `!topic <theme> <text>`, `!topic preview <theme> <text>`, `!topics`                                          | Set channel topics with IRC color-coded theme borders                                                                    |

### Writing plugins

See [plugins/README.md](plugins/README.md) for the full plugin authoring guide, bind types, config patterns, and a complete example.

## Admin commands

The bot's dot-commands (`.` prefix) provide administration via the REPL, IRC, or DCC CHAT:

| Command                                | Flags    | Description                                 |
| -------------------------------------- | -------- | ------------------------------------------- |
| `.help [cmd]`                          | `-`      | List commands or show help for one          |
| `.status`                              | `+o`     | Connection info, uptime, bind/user counts   |
| `.uptime`                              | `+o`     | One-line uptime with bold-red digits        |
| `.say <target> <msg>`                  | `+o`     | Send a message to a channel or user         |
| `.msg <target> <msg>`                  | `+o`     | Send a PRIVMSG to any target                |
| `.join <channel>`                      | `+o`     | Join a channel                              |
| `.part <channel>`                      | `+o`     | Part a channel                              |
| `.invite <#channel> <nick>`            | `+o`     | Invite a user to a channel                  |
| `.flags [handle] [+flags [#chan]]`     | `+n\|+m` | View/set user flags (no args = flag legend) |
| `.adduser <handle> <hostmask> <flags>` | `+n`     | Add a bot user                              |
| `.deluser <handle>`                    | `+n`     | Remove a bot user                           |
| `.users`                               | `+o`     | List all bot users                          |
| `.chpass [handle] <newpass>`           | REPL/DCC | Set or rotate a DCC password (see DCC.md)   |
| `.chanset <#chan> [key] [value]`       | `+m`     | View or set per-channel plugin settings     |
| `.chaninfo <#chan>`                    | `+o`     | Show all per-channel settings for a channel |
| `.binds [plugin]`                      | `+o`     | List active event binds                     |
| `.modlog [filters]`                    | `+m`     | Page the audit log (DCC-only; see AUDIT.md) |
| `.plugins`                             | `-`      | List loaded plugins                         |
| `.load <name>`                         | `+n`     | Load a plugin                               |
| `.unload <name>`                       | `+n`     | Unload a plugin                             |
| `.reload <name>`                       | `+n`     | Reload a plugin                             |

### Bot link commands

Available when bot linking is enabled in `bot.json`. See [docs/BOTLINK.md](docs/BOTLINK.md) for setup.

| Command                                    | Flags | Description                                   |
| ------------------------------------------ | ----- | --------------------------------------------- |
| `.botlink <status\|disconnect\|reconnect>` | `+m`  | Bot link status and management                |
| `.bots`                                    | `+m`  | List all linked bots                          |
| `.bottree`                                 | `+m`  | Show botnet topology tree                     |
| `.relay <botname>`                         | `+m`  | Relay DCC session to a remote bot             |
| `.bot <botname> <command>`                 | `+m`  | Execute a command on a remote bot             |
| `.bsay <botname\|*> <target> <msg>`        | `+m`  | Send a message via another linked bot         |
| `.bannounce <message>`                     | `+m`  | Broadcast to all console sessions across bots |
| `.whom`                                    | `-`   | Show all console users across linked bots     |

### DCC-only commands

Available inside a DCC CHAT session. See [docs/DCC.md](docs/DCC.md) for setup.

| Command                      | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `.who`                       | Show who is on the console                      |
| `.console [+flags\|-flags]`  | Show or set per-session log-stream flags        |
| `.modlog [filters]`          | Page the audit log with cursor-based pagination |
| `.audit-tail [filters\|off]` | Stream audit-log rows live as they are written  |
| `.quit`                      | Disconnect from the DCC session                 |

## Permission flags

| Flag | Role   | Access                                                   |
| ---- | ------ | -------------------------------------------------------- |
| `n`  | Owner  | Full access; implies all other flags                     |
| `m`  | Master | User management                                          |
| `o`  | Op     | Channel commands, bot admin                              |
| `v`  | Voice  | Reserved for plugin use                                  |
| `d`  | Deop   | Suppress auto-op/halfop on join; auto-voice if also `+v` |

Flags can be set globally or per-channel. The owner defined in `bot.json` is bootstrapped automatically on startup.

## Features

- **SOCKS5 proxy** — tunnel the IRC connection through a SOCKS5 proxy (Tor, SSH dynamic forward, etc.); configure via `proxy` in `bot.json`
- **DCC CHAT / party line** — users connect directly via DCC CHAT for an admin party-line session; configure via `dcc` in `bot.json` (see [docs/DCC.md](docs/DCC.md))
- **Bot linking** — hub-and-leaf multi-bot networking with permission sync, command relay, and shared ban lists (see [docs/BOTLINK.md](docs/BOTLINK.md))
- **IRC CASEMAPPING** — reads the server's `CASEMAPPING` ISUPPORT token and applies correct nick/channel folding (`rfc1459`, `strict-rfc1459`, or `ascii`) throughout all core modules and the plugin API (`api.ircLower()`)
- **IRCv3 identity caps** — negotiates `extended-join`, `account-notify`, and `chghost` for a live nick-to-account map; privileged commands can require NickServ verification before executing (configure via `identity.require_acc_for` in `bot.json`). SASL PLAIN and SASL EXTERNAL (CertFP) both supported.
- **Channel takeover protection** — detects unauthorized mass deop/mode changes and responds with configurable escalation including ChanServ akick
- **Persistent channel rejoin** — automatically rejoins channels after kick, netsplit, or other forced parts

## Deploy with Docker

```bash
git clone https://github.com/jstnmthw/hexbot.git && cd hexbot
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
# Edit both files for your server, nick, and owner hostmask
docker compose up -d
docker compose logs -f
```

Plugins and config live on the host filesystem via bind mounts. Edit a plugin file and run `.reload <name>` in IRC to pick up changes — no rebuild needed.

For non-Docker production use, `pnpm start` runs the bot directly via `tsx`.

### Healthcheck signals

The bot writes two files under `/tmp` so supervisors can distinguish "the
process is wedged" from "the process is fine but IRC is unreachable":

| File                     | Meaning                                     | What it tracks                                                                       |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/tmp/.hexbot-alive`     | **Liveness** — the event loop is responsive | Touched every 30s, always running. Removed only on graceful shutdown / fatal exit.   |
| `/tmp/.hexbot-connected` | **Readiness** — the bot is connected to IRC | Touched on `bot:connected`, removed on `bot:disconnected` (incl. reconnect backoff). |

The default `docker-compose.yml` healthcheck reads `-connected`, so `docker
ps` turns red while the bot is in reconnect backoff — useful for operator
visibility. Compose `restart: unless-stopped` triggers on container exit, not
on healthcheck status, so this signal is observability-only and never
restart-thrashes the bot mid-backoff.

For autoheal sidecars, Docker Swarm restart policies, or a Kubernetes
liveness probe, point at `-alive` instead so the bot is only marked unhealthy
when the event loop wedges. The in-process reconnect driver handles IRC
backoff on its own:

```yaml
healthcheck:
  test:
    - 'CMD'
    - 'sh'
    - '-c'
    - '[ -f /tmp/.hexbot-alive ] && [ $$(( $$(date +%s) - $$(stat -c %Y /tmp/.hexbot-alive) )) -lt 120 ]'
```

## Development

```bash
pnpm test           # run tests (vitest)
pnpm test:watch     # watch mode
pnpm test:coverage  # with coverage report
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit
pnpm format         # prettier
pnpm check          # typecheck + lint + test in one pass
```

## Documentation

| Document                                   | Description                                  |
| ------------------------------------------ | -------------------------------------------- |
| [Getting Started](docs/GETTING_STARTED.md) | Setup walkthrough, first steps, first plugin |
| [Design Document](DESIGN.md)               | Architecture and design decisions            |
| [Plugin API](docs/PLUGIN_API.md)           | Full plugin API reference                    |
| [Plugin Authoring](plugins/README.md)      | How to write plugins                         |
| [DCC CHAT](docs/DCC.md)                    | Remote admin setup and usage                 |
| [Bot Linking](docs/BOTLINK.md)             | Hub-and-leaf multi-bot networking            |
| [Security](docs/SECURITY.md)               | Security guidelines and threat model         |
| [Changelog](CHANGELOG.md)                  | Release history                              |

## License

[GPL-2.0](LICENSE)
