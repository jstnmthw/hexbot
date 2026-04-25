# Getting Started

This guide walks you through setting up HexBot, connecting to an IRC network, and running your first commands.

## Prerequisites

- **Node.js 24+** — check with `node -v`
- **pnpm** — install via `corepack enable` (bundled with Node.js 24)

## Install

```bash
git clone https://github.com/jstnmthw/hexbot.git
cd hexbot
pnpm install
```

## Configure

Copy the example configs:

```bash
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
cp config/bot.env.example config/bot.env && chmod 600 config/bot.env
```

Edit `config/bot.env` with the bootstrap values and any secrets:

```
HEX_DB_PATH=./data/hexbot.db
HEX_PLUGIN_DIR=./plugins
HEX_OWNER_HANDLE=admin
HEX_OWNER_HOSTMASK=*!yourident@your.host.here
HEX_OWNER_PASSWORD=choose-a-strong-password
HEX_NICKSERV_PASSWORD=
```

Bootstrap values are required at every boot — they are read before the SQLite KV is opened. The owner identity is consumed only on first boot to seed the user record; the DB is the store of record after that. See the [NickServ / SASL](#nickserv--sasl) section for secrets.

Edit `config/bot.json` with your IRC server details:

```json
{
  "irc": {
    "host": "irc.rizon.net",
    "port": 6697,
    "tls": true,
    "nick": "Hexbot",
    "username": "hexbot",
    "realname": "HexBot IRC Bot",
    "channels": ["#hexbot"]
  },
  "owner": {
    "password_env": "HEX_OWNER_PASSWORD"
  }
}
```

The first time the bot starts it will read `HEX_OWNER_PASSWORD`, hash it with scrypt, and store it in the database. Subsequent restarts leave the stored hash alone, so if you later rotate via `.chpass` those changes persist across reboots. The env var behaves like MySQL's `MYSQL_ROOT_PASSWORD` — leave it set in your env file; it only seeds when the DB has no hash on file.

**Finding your hostmask:** Connect to the IRC network with your client and run `/whois yournick`. Use the `user@host` portion to build a hostmask pattern. Common formats:

- `*!*@your.static.host` — static hostname (most secure)
- `*!yourident@*.your.isp.com` — dynamic host with known ident
- `nick!*@*` — nick-only (least secure, not recommended)

Edit `config/plugins.json` to enable or disable plugins. All included plugins are enabled by default in the example config.

## Run

```bash
# Development — interactive REPL for live administration
pnpm dev

# Headless — no REPL, suitable for production / Docker
pnpm start
```

On startup the bot connects to your configured server, joins channels, and bootstraps your owner account from the `owner` hostmask in `bot.json`.

## First steps

Once the bot is connected and you've joined a channel with it, try these commands. Built-in admin commands use the `.` prefix (configurable via `command_prefix` in `bot.json`) and work from both the REPL and IRC. Plugin commands use `!` by convention.

### From the REPL

The REPL gives you owner-level access to the bot directly from the terminal:

```
.status              # connection info and uptime
.uptime              # just the uptime, as a one-liner
.users               # list registered users
.plugins             # list loaded plugins
.help                # show all available commands
```

### From IRC

Plugin commands use the `!` prefix:

```
!8ball Am I lucky?   # ask the magic 8-ball
!seen alice          # when was alice last active?
!help                # list available plugin commands
```

Admin commands use the `.` prefix and require permission flags:

```
.adduser bob *!bob@example.com o                 # add a user with +o flag
.flags bob                                       # check bob's flags
.set core plugins.greeter.enabled false          # disable the greeter plugin
.set core logging.level debug                    # crank logs to debug live
.restart                                         # clean process restart
```

## Live config

Most config keys can be changed at runtime. The full operator surface:

```
.set <scope> <key> <value>      # write one key (live-apply via onChange)
.unset <scope> <key>            # delete from KV → reads registered default
.info <scope>                   # snapshot of every key in the scope
.helpset <scope> <key>          # type, default, description, reload-class
.rehash [scope]                 # re-read JSON files, apply changed keys
.restart                        # clean process restart
```

Scopes are `core`, `<plugin-id>`, or a channel name (`#chan`). KV is canonical after first boot — `bot.json` / `plugins.json` are seeds; `.set` / `.unset` win thereafter. `.rehash` is the deliberate path for pulling JSON edits in.

Plugin enable/disable lives on `core.plugins.<id>.enabled`:

```
.set core plugins.ai-chat.enabled true     # load and start the plugin
.set core plugins.ai-chat.enabled false    # stop and unload the plugin
```

The pre-2026-04-25 `.load` / `.unload` / `.reload` commands have been deleted (they were the source of an ESM-cache leak). Plugin authors picking up code edits use `.restart` (clean process, no leak) or run `tsx watch` at the process level during active development.

See [`docs/CONFIG.md`](CONFIG.md) for the full key matrix and reload-class hints.

## Adding users

The owner account (from `bot.json`) is created automatically. To add more users, use `.adduser` from the REPL or IRC:

```
.adduser <handle> <hostmask> <flags>
```

Example:

```
.adduser alice *!alice@home.example.com o
.adduser bob *!*@trusted.host.net m
```

Flag reference:

| Flag | Role   | Access                                                   |
| ---- | ------ | -------------------------------------------------------- |
| `n`  | Owner  | Full access; implies all other flags                     |
| `m`  | Master | User management                                          |
| `o`  | Op     | Channel commands, bot admin                              |
| `v`  | Voice  | Reserved for plugin use                                  |
| `d`  | Deop   | Suppress auto-op/halfop on join; auto-voice if also `+v` |

Flags can also be scoped to a specific channel:

```
.flags alice +o #mychannel
```

## Setting a DCC password

DCC CHAT sessions require a **per-user password** in addition to a hostmask match and the right flags. The owner's password is seeded automatically from `HEX_OWNER_PASSWORD` on first boot (see [Configure](#configure) above). For every additional user, set one with `.chpass` from the REPL or from an already-authenticated DCC session:

```
.chpass alice <newpassword>
```

Passwords are hashed with scrypt before storage and must be at least 8 characters. Users can rotate their own password later from inside an active DCC session with `.chpass <newpassword>`. `.chpass` is rejected on the IRC PRIVMSG path — passwords never travel over channel messages.

See [docs/DCC.md](DCC.md) for the full DCC setup walkthrough. Once connected, use `.console` to view or change which log-line categories your session subscribes to — the defaults (`+mojw`) show operator actions, joins/parts, bot messages, and warnings. See [docs/DCC.md#console-flags](DCC.md#console-flags).

## Writing your first plugin

Create a directory in `plugins/` with an `index.ts`:

```bash
mkdir plugins/hello
```

```typescript
// plugins/hello/index.ts
import type { PluginAPI } from '../../src/types';

export const name = 'hello';
export const version = '1.0.0';
export const description = 'Friendly greeter command';

export function init(api: PluginAPI): void {
  api.bind('pub', '-', '!hello', (ctx) => {
    ctx.reply(`Hello, ${ctx.nick}!`);
  });
}

export function teardown(): void {
  // No cleanup needed — binds are auto-removed by the loader
}
```

Enable it in `config/plugins.json`:

```json
{
  "hello": {
    "enabled": true
  }
}
```

Then load it at runtime — no restart needed:

```
.load hello
```

See [plugins/README.md](../plugins/README.md) for the full plugin authoring guide.

## Running with Docker

```bash
cp config/bot.example.json config/bot.json
cp config/plugins.example.json config/plugins.json
cp config/bot.env.example config/bot.env && chmod 600 config/bot.env
# Edit all three files
docker compose up -d
docker compose logs -f
```

Config and plugins live on the host via bind mounts. Edit a plugin and `.reload` it from IRC — no rebuild needed.

## NickServ / SASL

If your network supports it, configure SASL authentication in `bot.json`. Passwords are never stored inline -- use `password_env` to name an environment variable:

```json
{
  "services": {
    "type": "atheme",
    "nickserv": "NickServ",
    "password_env": "HEX_NICKSERV_PASSWORD",
    "sasl": true,
    "sasl_mechanism": "PLAIN"
  }
}
```

Set the env var before starting the bot (or add it to `config/bot.env`):

```bash
export HEX_NICKSERV_PASSWORD=your-password-here
```

Set `type` to match your network's services package (`atheme` for Libera Chat, `anope` for Rizon, etc.). Set `sasl_mechanism` to `"EXTERNAL"` to authenticate via TLS client certificate instead of a password.

## Local development with a test IRC server

For development without connecting to a public network, run a local IRC server:

```bash
# Debian/Ubuntu
sudo apt install ngircd
ngircd -n

# macOS
brew install ngircd
ngircd -n
```

Then point `bot.json` at `localhost:6667` with `"tls": false`.

## Next steps

- [DESIGN.md](../DESIGN.md) — architecture and design decisions
- [docs/PLUGIN_API.md](PLUGIN_API.md) — full plugin API reference
- [docs/DCC.md](DCC.md) — remote admin via DCC CHAT
- [docs/SECURITY.md](SECURITY.md) — security guidelines
