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
```

Edit `config/bot.json` with your IRC server details and owner hostmask:

```json
{
  "irc": {
    "host": "irc.rizon.net",
    "port": 6697,
    "tls": true,
    "nick": "HexBot",
    "username": "hexbot",
    "realname": "My HexBot",
    "channels": ["#hexbot"]
  },
  "owner": {
    "handle": "admin",
    "hostmask": "*!yourident@your.host.here"
  }
}
```

**Finding your hostmask:** Connect to the IRC network with your client and run `/whois yournick`. Use the `user@host` portion to build a hostmask pattern. Common formats:

- `*!*@your.static.host` — static hostname (most secure)
- `*!yourident@*.your.isp.com` — dynamic host with known ident
- `nick!*@*` — nick-only (least secure, not recommended)

Edit `config/plugins.json` to enable or disable plugins. All included plugins are enabled by default in the example config.

## Run

```bash
# Development — interactive REPL with auto-reload
pnpm dev

# Production — daemon mode, no REPL
pnpm start
```

On startup the bot connects to your configured server, joins channels, and bootstraps your owner account from the `owner` hostmask in `bot.json`.

## First steps

Once the bot is connected and you've joined a channel with it, try these commands from IRC (prefix with `.` for the REPL, `!` for channel commands):

### From the REPL

The REPL gives you owner-level access to the bot directly from the terminal:

```
.status              # connection info and uptime
.users               # list registered users
.plugins             # list loaded plugins
.help                # show all available commands
```

### From IRC

Channel commands use the `!` prefix. These come from plugins:

```
!8ball Am I lucky?   # ask the magic 8-ball
!seen alice          # when was alice last active?
!roll 2d6            # roll dice (if the dice plugin is loaded)
```

Admin commands use the `.` prefix and require permission flags:

```
.adduser bob *!bob@example.com o    # add a user with +o flag
.flags bob                          # check bob's flags
.reload greeter                     # hot-reload the greeter plugin
```

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

| Flag | Role   | Access                               |
| ---- | ------ | ------------------------------------ |
| `n`  | Owner  | Full access; implies all other flags |
| `m`  | Master | User management                      |
| `o`  | Op     | Channel commands, bot admin          |
| `v`  | Voice  | Reserved for plugin use              |

Flags can also be scoped to a specific channel:

```
.flags alice +o #mychannel
```

## Writing your first plugin

Create a directory in `plugins/` with an `index.ts`:

```bash
mkdir plugins/hello
```

```typescript
// plugins/hello/index.ts
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'hello';
export const version = '1.0.0';
export const description = 'Friendly greeter command';

export function init(api: PluginAPI): void {
  api.bind('pub', '-', '!hello', (ctx: HandlerContext) => {
    ctx.reply(`Hello, ${ctx.nick}!`);
  });
}

export function teardown(): void {}
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
# Edit both files
docker compose up -d
docker compose logs -f
```

Config and plugins live on the host via bind mounts. Edit a plugin and `.reload` it from IRC — no rebuild needed.

## NickServ / SASL

If your network supports it, configure SASL authentication in `bot.json`:

```json
{
  "services": {
    "type": "atheme",
    "nickserv": "NickServ",
    "password": "botpassword",
    "sasl": true,
    "sasl_mechanism": "PLAIN"
  }
}
```

Set `type` to match your network's services package (`atheme` for Libera Chat, `anope` for Rizon, etc.).

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
