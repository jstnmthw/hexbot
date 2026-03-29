# HexBot - An IRC Bot

![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/jstnmthw/50c25c1f05168b07d48f34f8c8351ca5/raw/hexbot-coverage.json)

A modern, modular IRC bot for Node.js, written in TypeScript.

## Quick start

Requires Node.js 24+ and pnpm.

```bash
pnpm install
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
# Edit both files for your server, nick, owner hostmask, and plugins
pnpm dev          # start with interactive REPL
```

`pnpm start` runs without the REPL. Use `--config <path>` to specify an alternate config file.

## REPL commands

The REPL (`.` prefix) provides admin access without IRC:

| Command                                | Flags    | Description                                 |
| -------------------------------------- | -------- | ------------------------------------------- |
| `.help [cmd]`                          | `-`      | List commands or show help for one          |
| `.status`                              | `+o`     | Connection info, uptime, bind/user counts   |
| `.say <target> <msg>`                  | `+o`     | Send a message to a channel or user         |
| `.msg <target> <msg>`                  | `+o`     | Send a PRIVMSG to any target                |
| `.join <channel>`                      | `+n`     | Join a channel                              |
| `.part <channel>`                      | `+n`     | Part a channel                              |
| `.flags [handle] [+flags [#chan]]`     | `+n\|+m` | View/set user flags (no args = flag legend) |
| `.adduser <handle> <hostmask> <flags>` | `+n`     | Add a bot user                              |
| `.deluser <handle>`                    | `+n`     | Remove a bot user                           |
| `.users`                               | `+o`     | List all bot users                          |
| `.chanset <#chan> [key] [value]`       | `+m`     | View or set per-channel plugin settings     |
| `.chaninfo <#chan>`                    | `+o`     | Show all per-channel settings for a channel |
| `.binds [plugin]`                      | `+o`     | List active event binds                     |
| `.plugins`                             | `-`      | List loaded plugins                         |
| `.load <name>`                         | `+n`     | Load a plugin                               |
| `.unload <name>`                       | `+n`     | Unload a plugin                             |
| `.reload <name>`                       | `+n`     | Reload a plugin                             |

## Permission flags

| Flag | Role   | Access                               |
| ---- | ------ | ------------------------------------ |
| `n`  | Owner  | Full access; implies all other flags |
| `m`  | Master | User management                      |
| `o`  | Op     | Channel commands, bot admin          |
| `v`  | Voice  | Reserved for plugin use              |

Flags can be set globally or per-channel. The owner defined in `bot.json` is bootstrapped automatically on startup.

## Plugins

Plugins live in `plugins/<name>/` and are enabled via `config/plugins.json`. They register IRC commands through the dispatcher bind system and can be loaded, unloaded, and reloaded at runtime without restarting the bot.

### Included plugins

| Plugin      | Commands                                                                                                     | Description                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **8ball**   | `!8ball <question>`                                                                                          | Magic 8-ball responses                                                                                                   |
| **chanmod** | `!op`, `!deop`, `!halfop`, `!dehalfop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban`, `!bans` | Channel protection: auto-op/halfop/voice on join, mode enforcement, bitch/punish/enforcebans, rejoin/revenge, timed bans |
| **ctcp**    | _(automatic)_                                                                                                | Replies to CTCP VERSION, PING, and TIME requests                                                                         |
| **flood**   | _(automatic)_                                                                                                | Inbound flood protection: rate limiting, join/part spam, nick-change spam; escalating enforcement                        |
| **greeter** | _(automatic)_                                                                                                | Greets users on channel join                                                                                             |
| **seen**    | `!seen <nick>`                                                                                               | Tracks when a user was last active                                                                                       |
| **topic**   | `!topic <theme> <text>`, `!topic preview <theme> <text>`, `!topics`                                          | Set channel topics with IRC color-coded theme borders                                                                    |

### Writing plugins

See [plugins/README.md](plugins/README.md) for the full plugin authoring guide, bind types, config patterns, and a complete example.

## Features

- **SOCKS5 proxy** — tunnel the IRC connection through a SOCKS5 proxy (Tor, SSH dynamic forward, etc.); configure via `proxy` in `bot.json`
- **DCC CHAT / party line** — users connect directly via DCC CHAT for an admin party-line session; configure via `dcc` in `bot.json` (see [docs/DCC.md](docs/DCC.md))
- **IRC CASEMAPPING** — reads the server's `CASEMAPPING` ISUPPORT token and applies correct nick/channel folding (`rfc1459`, `strict-rfc1459`, or `ascii`) throughout all core modules and the plugin API (`api.ircLower()`)
- **IRCv3 identity caps** — negotiates `extended-join`, `account-notify`, and `chghost` for a live nick→account map; privileged commands can require NickServ verification before executing (configure via `identity.require_acc_for` in `bot.json`). SASL PLAIN and SASL EXTERNAL (CertFP) both supported.

## Deploy with Docker

```bash
git clone <repo-url> && cd hexbot
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
# Edit both files for your server, nick, and owner hostmask
docker compose up -d
docker compose logs -f
```

Plugins and config live on the host filesystem via bind mounts. Edit a plugin file and run `.reload <name>` in IRC to pick up changes — no rebuild needed.

For non-Docker production use, `pnpm build` compiles to JS and `pnpm start:prod` runs the compiled output.

## Architecture

See [DESIGN.md](DESIGN.md) for full architecture details.

## Development

```bash
pnpm test           # run tests (vitest)
pnpm test:watch     # watch mode
pnpm test:coverage  # with coverage report
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit
pnpm format         # prettier
```

## License

[GPL-2.0](LICENSE)
