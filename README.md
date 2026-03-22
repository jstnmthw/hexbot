# Hexbot

Modular IRC bot written in TypeScript with multi-network bind, hot-reloadable plugin, and hostmask-based permission systems.

## Quick start

Requires Node.js 20+ and pnpm.

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
| `.join <channel>`                      | `+n`     | Join a channel                              |
| `.part <channel>`                      | `+n`     | Part a channel                              |
| `.flags [handle] [+flags [#chan]]`     | `+n\|+m` | View/set user flags (no args = flag legend) |
| `.adduser <handle> <hostmask> <flags>` | `+n`     | Add a bot user                              |
| `.deluser <handle>`                    | `+n`     | Remove a bot user                           |
| `.users`                               | `+o`     | List all bot users                          |
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

| Plugin      | Commands                                                                    | Description                                                                          |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **8ball**   | `!8ball <question>`                                                         | Magic 8-ball responses                                                               |
| **chanmod** | `!op`, `!deop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban` | Channel protection: auto-op/voice on join, mode enforcement, and moderation commands |
| **greeter** | _(automatic)_                                                               | Greets users on channel join                                                         |
| **seen**    | `!seen <nick>`                                                              | Tracks when a user was last active                                                   |
| **topic**   | `!topic <theme> <text>`, `!topics`                                          | Set channel topics with IRC color themes                                             |

### Writing plugins

See [plugins/README.md](plugins/README.md) for the full plugin authoring guide, bind types, config patterns, and a complete example.

## Architecture

See [DESIGN.md](DESIGN.md) for full architecture details.

## Development

```bash
pnpm test          # run tests (vitest)
pnpm test:watch    # watch mode
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit
```

## License

[GPL-2.0](LICENSE)
