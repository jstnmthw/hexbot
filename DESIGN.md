# HexBot — Design Document

> A modular IRC bot framework for Node.js, inspired by Eggdrop's 30-year-old bind system but built for the modern stack. The name is a nod to HexChat — same hex, but we're the bot.

This document describes HexBot's stable architectural decisions. For current feature status, see [README.md](README.md). For implementation history, see [CHANGELOG.md](CHANGELOG.md). For planned features, see [docs/plans/](docs/plans/).

---

## 1. Project overview

HexBot is a single-process, plugin-based IRC bot written in TypeScript. It connects to any IRC network, loads plugins at runtime with hot-reload, and manages channel operations through an event bind system and flag-based permissions.

The goal is an open-source alternative to Eggdrop that eliminates the pain of C compilation, Tcl scripting, flat-file databases, and telnet-era admin interfaces — while preserving the design patterns that made Eggdrop successful for three decades.

### Design principles

- **Eggdrop's bind system is the core abstraction.** Plugins register handlers for IRC events (pub, msg, join, kick, mode, etc.) using `bind(type, flags, mask, handler)`. The dispatcher routes events to matching handlers. This is proven and well-understood.
- **Convention over configuration.** Sane defaults that work on any network out of the box. Tune later if needed.
- **Plugins are self-contained.** Each plugin ships its own default config, registers its own binds, manages its own database namespace. No plugin depends on another plugin.
- **Core modules are the foundation.** A small set of core modules (permissions, services, irc-commands, channel-state) provide shared functionality that plugins build on. Core modules can depend on each other.
- **Modern developer experience.** TypeScript, ESM modules, async/await, `pnpm install && ppnpm start`, hot-reload without restart, attached REPL for development.

### Tech stack

| Component   | Choice                      | Rationale                                                                                 |
| ----------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| Language    | TypeScript (strict mode)    | Type safety, better IDE support, self-documenting interfaces.                             |
| Runtime     | Node.js (ESM)               | Async event-driven, matches IRC's nature.                                                 |
| IRC library | `irc-framework`             | Actively maintained, powers Kiwi IRC. Handles protocol, ISUPPORT, IRCv3 caps, SASL.       |
| Database    | SQLite via `better-sqlite3` | Zero config, single file, synchronous reads fine for this workload.                       |
| AI provider | Google Gemini (free tier)   | Free, no credit card, 1M token context, 1000 RPD. Adapter pattern for swapping providers. |

---

## 2. Architecture

### 2.1 High-level structure

```
hexbot/
├── config/
│   ├── bot.json              # Core: server, nick, channels, owner, identity, services
│   └── plugins.json          # Plugin routing: which plugins enabled, per-channel overrides
├── src/
│   ├── index.ts              # Entry point, process signals
│   ├── bot.ts                # Thin orchestrator, wires modules together
│   ├── irc-bridge.ts         # Translates irc-framework events to dispatcher events
│   ├── dispatcher.ts         # Bind/unbind event system
│   ├── plugin-loader.ts      # Discovers, loads, hot-reloads plugins
│   ├── database.ts           # SQLite key-value store + mod_log, namespaced per plugin
│   ├── repl.ts               # Attached REPL (--repl flag)
│   ├── command-handler.ts    # Command router (used by REPL, IRC, DCC CHAT)
│   ├── types.ts              # Shared interfaces (HandlerContext, PluginAPI, etc.)
│   ├── event-bus.ts          # Typed EventEmitter for internal bot events
│   ├── logger.ts             # Structured logging with levels and child loggers
│   ├── utils/
│   │   ├── wildcard.ts       # Wildcard pattern matching (shared by dispatcher + permissions)
│   │   ├── sanitize.ts       # Strip \r\n for IRC injection prevention
│   │   ├── split-message.ts  # Word-boundary message splitting for IRC line limits
│   │   ├── strip-formatting.ts  # Remove IRC control codes
│   │   └── irc-event.ts      # Type guards for irc-framework event payloads
│   └── core/                 # Core modules (always loaded)
│       ├── permissions.ts    # Flag-based permissions: n/m/o/v flags, hostmask matching
│       ├── services.ts       # NickServ/ChanServ integration, SASL
│       ├── irc-commands.ts   # Helpers: join, part, kick, ban, mode
│       ├── channel-state.ts  # Track users, modes, hostmasks per channel
│       ├── channel-settings.ts  # Per-channel typed setting registry (DB-backed)
│       ├── botlink.ts        # Bot link protocol: hub/leaf, handshake, heartbeat
│       ├── botlink-sync.ts   # State sync: permissions + channel state → link frames
│       ├── botlink-sharing.ts # Ban/exempt list sharing across linked bots
│       ├── dcc.ts            # DCC CHAT + console (shared admin sessions)
│       ├── help-registry.ts  # Stores/retrieves command help entries
│       ├── message-queue.ts  # Token-bucket flood protection for outgoing messages
│       └── commands/         # Command groups (each module registers its own)
│           ├── permission-commands.ts
│           ├── dispatcher-commands.ts
│           ├── irc-commands-admin.ts
│           ├── plugin-commands.ts
│           ├── channel-commands.ts   # .chanset, .chaninfo
│           └── botlink-commands.ts   # .botlink, .bots, .bottree, .relay, .whom
├── plugins/                  # Optional plugins (user-installable)
│   ├── 8ball/                # Magic 8-ball command
│   ├── chanmod/              # Channel moderation: auto-op/voice, mode enforcement, bans
│   ├── ctcp/                 # CTCP VERSION/PING/TIME responder
│   ├── flood/                # Flood detection and auto-action escalation
│   ├── greeter/              # Configurable join greeting
│   ├── help/                 # Help system (!help command)
│   ├── seen/                 # Last-seen tracking (!seen command)
│   └── topic/                # Topic rotation and themed messages
├── types/                    # Exported TypeScript declarations
│   ├── index.d.ts
│   ├── config.d.ts
│   ├── events.d.ts
│   └── plugin-api.d.ts
├── tsconfig.json
└── package.json
```

### 2.2 Two-tier module system

Inspired by Eggdrop's C modules vs Tcl scripts:

**Core modules** (`src/core/`) ship with the bot and are always loaded. They provide the foundational services that plugins build on. Core modules can depend on each other (e.g., permissions depends on services for NickServ ACC verification). They are NOT hot-reloadable — they're part of the bot's runtime.

**Plugins** (`plugins/`) are optional, user-installable, and hot-reloadable. Each plugin is a directory with an `index.ts` that exports `{ name, version, description, init(api), teardown() }`. Plugins depend on core modules (via the plugin API) but never on other plugins. A plugin can be loaded, unloaded, and reloaded without restarting the bot.

### 2.3 Event dispatcher (the bind system)

The heart of HexBot. Modeled directly on Eggdrop's `bind` command.

```typescript
dispatcher.bind(type, flags, mask, handler, pluginId);
dispatcher.unbind(type, mask, handler);
dispatcher.unbindAll(pluginId); // Remove all binds for a plugin (used on unload)
```

**Bind types:**

| Type     | Trigger            | Mask matches against            | Stackable       |
| -------- | ------------------ | ------------------------------- | --------------- |
| `pub`    | Channel message    | Exact command (e.g. `!uno`)     | No (overwrites) |
| `pubm`   | Channel message    | Wildcard on full text           | Yes             |
| `msg`    | Private message    | Exact command                   | No              |
| `msgm`   | Private message    | Wildcard on full text           | Yes             |
| `join`   | User joins channel | `#channel nick!user@host`       | Yes             |
| `part`   | User parts channel | `#channel nick!user@host`       | Yes             |
| `kick`   | User kicked        | `#channel nick!user@host`       | Yes             |
| `nick`   | Nick change        | Wildcard                        | Yes             |
| `mode`   | Mode change        | `#channel +/-mode`              | Yes             |
| `raw`    | Raw server line    | Command/numeric string          | Yes             |
| `time`   | Timer (interval)   | Seconds as string (e.g. `"60"`) | Yes             |
| `ctcp`   | CTCP request       | CTCP type (e.g. `VERSION`)      | Yes             |
| `notice` | Notice message     | Wildcard on text                | Yes             |
| `topic`  | Topic change       | Channel name wildcard           | Yes             |
| `quit`   | User quit          | `nick!user@host`                | Yes             |
| `invite` | Bot invited        | `#channel nick!user@host`       | Yes             |

**Non-stackable** types (pub, msg) overwrite previous binds on the same mask — only one handler per command. **Stackable** types allow multiple handlers on the same mask — all matching handlers fire.

**Mask matching:** Supports `*` and `?` wildcards. For `pub`/`msg`, matching is exact (case-insensitive). For `pubm`/`msgm`, the mask is matched against the full text with wildcards.

**Handler context:** Every handler receives a `ctx` object:

```typescript
interface HandlerContext {
  nick: string;
  ident: string;
  hostname: string;
  channel: string | null; // null for PMs
  text: string;
  command: string;
  args: string;
  reply(msg: string): void;
  replyPrivate(msg: string): void;
}
```

**Flag checking:** Before dispatching to a handler, the dispatcher checks if the triggering user has the required flags. Flags of `-` mean no requirement (anyone can trigger).

**Input flood limiting:** The dispatcher enforces per-user rate limits on `pub`/`pubm` (channel commands) and `msg`/`msgm` (private message commands). Before each IRC PRIVMSG is dispatched, the bridge calls `dispatcher.floodCheck('pub'|'msg', key, ctx)` — if the user has exceeded the configured threshold, both dispatch calls for that message are skipped. On the first blocked message per window, the user receives a single NOTICE warning. Users with the `n` (owner) flag bypass flood limits entirely.

Configure in `config/bot.json` under the `"flood"` key:

```json
"flood": {
  "pub": { "count": 5, "window": 10 },
  "msg": { "count": 5, "window": 10 }
}
```

If the `flood` key is absent, flood limiting is disabled.

### 2.4 Plugin API

Each plugin's `init()` receives a scoped API object. The plugin can only manage its own binds and its own database namespace.

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'my-plugin';
export const version = '1.0.0';
export const description = 'Does stuff';

export function init(api: PluginAPI): void {
  // Bind system (auto-tagged with plugin ID)
  api.bind(type, flags, mask, handler);
  api.unbind(type, mask, handler);

  // IRC actions
  api.say(target, message);
  api.action(target, message);
  api.notice(target, message);
  api.raw(line);

  // Channel state
  api.getChannel(name);
  api.getUsers(channel);

  // Database (namespaced to this plugin)
  api.db.get(key);
  api.db.set(key, value);
  api.db.del(key);
  api.db.list(prefix);

  // Config (from plugins.json overrides, falling back to plugin's own config.json)
  api.config;

  // Server capabilities (from ISUPPORT)
  api.getServerSupports();

  // Logging
  api.log(...args);
  api.error(...args);
}

export function teardown(): void {
  // Called on unload/reload. Clean up timers, connections, etc.
  // Binds are automatically removed by the loader — no need to unbind manually.
}
```

### 2.5 Plugin loader

Responsibilities:

- Discover plugins in the plugin directory (each subdirectory with `index.ts`, or standalone `.ts` files)
- Load: dynamic `import()` with cache-busting query string for ESM (imports compiled `.js` output)
- Unload: call `teardown()`, then `dispatcher.unbindAll(pluginId)`
- Reload: unload then load from disk
- Provide scoped API to each plugin's `init()`

Hot-reload works because ESM's `import()` can be cache-busted with `?t=Date.now()`. The loader clears the old plugin's binds, calls teardown, then imports the fresh code and re-initializes.

### 2.6 Permissions (core module)

Flag-based permissions with per-channel overrides.

**Flags:**

- `n` — owner (full access, implies all other flags)
- `m` — master
- `o` — op
- `v` — voice
- `-` — no flags required (anyone)

**User records:** Each user has a handle, one or more hostmask patterns (with wildcards), global flags, and per-channel flag overrides.

```typescript
interface UserRecord {
  handle: string;
  hostmasks: string[];
  global: string;
  channels: Record<string, string>;
}

// Example:
// {
//   handle: "admin",
//   hostmasks: ["*!myident@my.host.com", "*!*@my.vps.ip"],
//   global: "nmov",
//   channels: {
//     "#main": "o",
//     "#games": "v"
//   }
// }
```

**Identity verification:** Hostmask-based by default (like Eggdrop). The bot trusts a user because their connection matches a known hostmask pattern. Common formats:

- `*!*@hostname.com` — static host
- `*!ident@*.isp.com` — dynamic host with known ident
- `nick!*@*` — nick-only (least secure, not recommended)

**Optional NickServ ACC enhancement:** When enabled in config, the bot queries NickServ ACC before granting privileged operations (+o, +n flagged commands). Configurable per-network since not all networks have services.

### 2.7 Services integration (core module)

Handles the bot's own authentication and NickServ/ChanServ interaction.

**Bot auth:** SASL preferred (via `irc-framework`'s built-in support), falling back to `PRIVMSG NickServ :IDENTIFY` on connect.

**Services adapter:** Different services packages use different commands:

| Services        | NickServ target             | Identify command  | ACC check        |
| --------------- | --------------------------- | ----------------- | ---------------- |
| Atheme (Libera) | `NickServ`                  | `IDENTIFY <pass>` | `ACC <nick>`     |
| Anope           | `NickServ`                  | `IDENTIFY <pass>` | `STATUS <nick>`  |
| DALnet          | `nickserv@services.dal.net` | `IDENTIFY <pass>` | Different format |
| None            | N/A                         | N/A               | N/A              |

Config:

```json
{
  "services": {
    "type": "atheme",
    "nickserv": "NickServ",
    "password": "botpass",
    "sasl": true,
    "verify_privileged": true
  }
}
```

### 2.8 Channel state (core module)

Tracks who is in each channel, their modes (@/+), hostmasks, and join times. Also tracks channel-level modes (mode string, key, and limit) via RPL_CHANNELMODEIS and MODE events. Updated via JOIN, PART, QUIT, KICK, NICK, MODE, WHO/NAMES, and `channel info` responses. Exposed to plugins via `api.getChannel()`, `api.getUsers()`, `api.requestChannelModes()`, and `api.onModesReady()`.

### 2.9 IRC commands (core module)

Convenience wrappers around raw IRC commands with flood protection and mode stacking awareness (respects the server's ISUPPORT `MODES` value):

- `join(channel, key?)`
- `part(channel, message?)`
- `kick(channel, nick, reason?)`
- `ban(channel, mask)`
- `unban(channel, mask)`
- `mode(channel, modes, ...params)`
- `op(channel, nick)` / `deop(channel, nick)`
- `halfop(channel, nick)` / `dehalfop(channel, nick)`
- `voice(channel, nick)` / `devoice(channel, nick)`
- `topic(channel, text)`

### 2.10 Database

SQLite key-value store with namespace isolation per plugin.

```sql
CREATE TABLE kv (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT,
  updated   INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (namespace, key)
);
```

Each plugin accesses its own namespace via `api.db`. Core modules use reserved namespaces prefixed with `_` (e.g., `_permissions`, `_services`).

### 2.11 Config system

**Two-level config:**

`config/bot.json` — core bot settings:

```json
{
  "irc": {
    "host": "irc.libera.chat",
    "port": 6697,
    "tls": true,
    "nick": "hexbot",
    "username": "hexbot",
    "realname": "HexBot IRC Bot",
    "channels": ["#mychannel"]
  },
  "owner": {
    "handle": "admin",
    "hostmask": "*!myident@my.host.com"
  },
  "identity": {
    "method": "hostmask",
    "require_acc_for": ["+o", "+n"]
  },
  "services": {
    "type": "atheme",
    "nickserv": "NickServ",
    "password": "botpass",
    "sasl": true
  },
  "database": "./data/hexbot.db",
  "pluginDir": "./plugins",
  "logging": {
    "level": "info",
    "mod_actions": true
  }
}
```

`config/plugins.json` — plugin routing and overrides:

```json
{
  "auto-op": {
    "enabled": true,
    "channels": ["#mychannel", "#otherchannel"]
  },
  "greeter": {
    "enabled": true,
    "channels": ["#mychannel"],
    "config": {
      "message": "Welcome to {channel}, {nick}!"
    }
  },
  "seen": {
    "enabled": true
  },
  "8ball": {
    "enabled": true,
    "channels": ["#games"]
  }
}
```

Each plugin also ships its own `config.json` with defaults. The resolution order is: `plugins.json` overrides > plugin's own `config.json` defaults.

### 2.12 CLI / REPL

**Option A:** Attached REPL via `--repl` flag. Uses Node's `readline` module. The bot process and REPL share the same process. Commands typed in the terminal go through the same `command-handler.ts` that IRC commands use. The REPL has implicit owner privileges and is intended for development/local administration only.

```bash
# Production: daemon mode, manage via DCC CHAT or IRC commands
pnpm start

# Development: interactive REPL with watch mode
pnpm run dev -- --repl
```

REPL activity (commands typed) is broadcast to all connected DCC console sessions so remote admins can see local admin work.

**Option B (implemented):** DCC CHAT socket transport (`src/core/dcc.ts`) — see section 2.15 and `docs/DCC.md`. This is the recommended interface for production remote administration.

**Design for extensibility:** The `command-handler.ts` module parses command strings and returns results. It doesn't care where input comes from. The REPL feeds it stdin lines. IRC feeds it message text. DCC CHAT feeds it socket data. Same parser, multiple transports.

### 2.13 Internal event bus

Separate from the IRC dispatcher, the bot maintains a simple `EventEmitter` for internal events:

- `plugin:loaded`, `plugin:unloaded`, `plugin:reloaded`
- `mod:op`, `mod:deop`, `mod:kick`, `mod:ban`
- `bot:connected`, `bot:disconnected`, `bot:error`
- `user:identified`, `user:added`, `user:removed`
- `channel:modesReady` — fired after RPL_CHANNELMODEIS populates channel-state modes/key/limit

This is how the future web panel (phase 3) will tap into bot state without modifying the core. It's also useful for plugins that want to react to bot-level events rather than IRC events.

### 2.14 Logging

Minimal by default. Only mod actions are persisted to the database:

```sql
CREATE TABLE mod_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER DEFAULT (unixepoch()),
  action    TEXT NOT NULL,     -- 'op', 'deop', 'kick', 'ban', 'unban'
  channel   TEXT,
  target    TEXT,              -- nick or hostmask acted upon
  by        TEXT,              -- who/what triggered it (plugin name or admin handle)
  reason    TEXT
);
```

Console logging uses structured output (timestamp, level, source module/plugin). Log level is configurable in `config/bot.json`.

### 2.15 DCC CHAT / Botnet (core module)

Passive DCC CHAT for remote administration (`src/core/dcc.ts`). This is "Option B" from the CLI/REPL design extensibility note in section 2.12.

**How it works:**

1. User types `/dcc chat hexbot` in their IRC client — sends a CTCP DCC request to the bot.
2. The bot receives it as a `ctcp` dispatcher event (`command: 'DCC'`).
3. `DCCManager` validates the request (passive DCC only, hostmask auth, flag check).
4. Bot opens a TCP port from the configured range (`port_range` in `bot.json`), sends a passive DCC token back via CTCP reply.
5. User's client connects to the bot's port. Bot shows a banner and command prompt.
6. Lines starting with `.` are routed through `CommandHandler` with the user's real flags enforced.
7. Plain text lines are broadcast to all connected DCC sessions (the console).

**Key decisions:**

- **Passive DCC only** — bot opens port, user connects. Bot requires a public IPv4. Active DCC (user opens port) is rejected.
- **Core module, not plugin** — needs direct access to `CommandHandler` and `Permissions`, which are not in `PluginAPI`.
- **Wired in `bot.ts`** — created after IRC connect, torn down on shutdown. Enabled via `dcc.enabled` in `bot.json`.
- **No implicit owner** — DCC sessions get real flag enforcement (unlike the REPL which has implicit owner access).

**Config (`bot.json`):**

```json
"dcc": {
  "enabled": true,
  "ip": "203.0.113.42",
  "port_range": [50000, 50010],
  "require_flags": "m",
  "max_sessions": 5,
  "idle_timeout_ms": 300000,
  "nickserv_verify": false
}
```

See `docs/DCC.md` for full setup, client instructions, and security notes.

### 2.16 Bot linking (core module)

Hub-and-leaf multi-bot networking (`src/core/botlink.ts`, `botlink-sync.ts`, `botlink-sharing.ts`). Inspired by Eggdrop's botnet but using a JSON-over-TCP protocol instead of Eggdrop's binary format.

**Topology:**

```
              Hub bot
            /    |    \
        Leaf1  Leaf2  Leaf3
```

One hub, N leaves. Star topology — leaves never talk directly to each other. The hub fans out non-hub-only frames to all other leaves. There is no multi-hop routing.

**Protocol:**

- JSON frames, one per line, delimited by `\r\n`.
- 64KB max frame size. Frames exceeding this are protocol errors.
- Handshake: leaf sends `HELLO` (botname + SHA-256 password hash), hub replies `WELCOME` or `ERROR`.
- Heartbeat: hub pings leaves periodically. Missed pongs trigger timeout disconnect.
- Rate limiting: CMD frames capped at 10/sec, PARTY_CHAT at 5/sec per leaf.

**State sync (Phase 4):**

After handshake, hub sends `SYNC_START`, then pushes `ADDUSER` (permissions), `CHAN` (channel state), and `CHAN_BAN_SYNC`/`CHAN_EXEMPT_SYNC` (ban lists) frames, then `SYNC_END`. Permission mutations are broadcast in real-time via `ADDUSER`/`DELUSER`/`SETFLAGS` frames.

**Command relay (Phase 5):**

Commands marked `relayToHub: true` are intercepted on the leaf, sent as `CMD` frames to the hub, executed there with the hub's permissions database, and results returned via `CMD_RESULT`. This ensures consistent permission enforcement across the botnet.

**Key decisions:**

- **Hub-authoritative trust model** — the hub is the single source of truth for permissions, and executes all relayed commands. A compromised hub means total compromise. See `docs/SECURITY.md`.
- **Core module, not plugin** — needs direct access to `CommandHandler`, `Permissions`, `ChannelState`, and `DCCManager`.
- **Wired in `bot.ts`** — hub/leaf created based on `botlink.role` in config. Enabled via `botlink.enabled` in `bot.json`.

See `docs/BOTLINK.md` for setup instructions and command reference.

---

## 3. Network compatibility

HexBot is network-agnostic. The base IRC protocol (RFC 1459 / RFC 2812) is consistent across all server software. `irc-framework` handles:

- ISUPPORT (005) parsing — auto-detects server capabilities (modes per line, ban list size, channel types, etc.)
- IRCv3 capability negotiation — SASL, `account-notify`, `extended-join`, `away-notify`, `multi-prefix`
- Graceful fallback when capabilities aren't supported

What differs between networks and how we handle it:

| Difference                                | Our approach                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Channel modes vary (half-op, admin, etc.) | Read from ISUPPORT PREFIX, don't hardcode                         |
| Services commands differ                  | Services adapter in core module, configurable per `services.type` |
| Modes-per-line limits                     | Read from ISUPPORT MODES, queue mode changes accordingly          |
| Ban mask formats                          | Use standard `*!*@host` by default, extended bans opt-in          |
| NickServ target differs                   | Configurable `services.nickserv` field                            |

---

## 4. Current state

All core infrastructure is implemented and production-ready. See [CHANGELOG.md](CHANGELOG.md) for a full implementation history.

**Shipped plugins:** `8ball`, `chanmod`, `ctcp`, `flood`, `greeter`, `help`, `seen`, `topic`

**Shipped core features:** bot linking (hub/leaf), DCC CHAT console, channel takeover protection, persistent channel rejoin

**Planned features** (design documents in `docs/plans/`):

- [`ai-chat-plugin.md`](docs/plans/ai-chat-plugin.md) — AI chat integration (Gemini/Claude/OpenAI adapter)
- [`deployment.md`](docs/plans/deployment.md) — Docker, systemd, GitHub Actions
- [`xdcc-plugin.md`](docs/plans/xdcc-plugin.md) — XDCC file serving
- [`idlerpg-plugin.md`](docs/plans/idlerpg-plugin.md) — IdleRPG game plugin

---

## 6. AI module design notes

Deferred to Phase 4, but architectural decisions made now:

**Provider adapter interface:**

```typescript
abstract class AIProvider {
  abstract complete(systemPrompt: string, messages: Message[]): Promise<string>;
  abstract countTokens(text: string): Promise<number>;
  abstract getModelName(): string;
  abstract getCostPerToken(): { input: number; output: number };
}
```

**Starting provider:** Google Gemini free tier.

- Model: Gemini 2.5 Flash-Lite (highest free RPD: ~1000/day)
- No credit card required
- Rate limits: 15 RPM, 1000 RPD, 250K TPM on free tier
- Cost if upgraded: $0.10 per million input tokens

**Key gotchas to design for:**

- Cost control: per-user token budgets persisted in DB, global daily spend cap
- Latency: 1-5s response time vs IRC's instant feel. Buffer full response before sending.
- Abuse: prompt injection, trying to make bot say offensive things. Solid system prompt + output filtering.
- Context management: sliding window of last N messages per channel, not full history. Keeps token usage bounded.
- Privacy: free tier data may be used for model improvement. Document this clearly.

---

## 7. Development notes

### Getting started

```bash
git clone <repo>
cd hexbot
pnpm install
cp config/bot.example.json config/bot.json
# Edit config/bot.json with your server/nick/owner
pnpm start          # daemon mode (compiles + runs)
pnpm run dev        # with --repl and --watch (uses tsx)
```

### Creating a plugin

```bash
mkdir plugins/my-plugin
```

Minimum viable plugin:

```typescript
// plugins/my-plugin/index.ts
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'my-plugin';
export const version = '1.0.0';

export function init(api: PluginAPI): void {
  api.bind('pub', '-', '!hello', async (ctx: HandlerContext) => {
    ctx.reply(`Hello, ${ctx.nick}!`);
  });
}
```

### Hot-reload workflow

1. Edit plugin code
2. In REPL or IRC: `.reload my-plugin`
3. Changes are live immediately — no bot restart needed

### Testing against a local IRC server

For development, run a local InspIRCd or ngIRCd instance. ngIRCd is the lightest option:

```bash
# macOS
brew install ngircd
ngircd -n  # foreground mode

# Then point config/bot.json at localhost:6667
```

---

## 8. Prior art and references

| Project              | What we take from it                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Eggdrop**          | Bind system, flag-based permissions, hostmask identity, two-tier module architecture, party line concept (→ REPL) |
| **Darkbot**          | Keyword-based auto-response concept (relevant for AI module)                                                      |
| **MrNodeBot**        | Proof that Node.js + Express + Socket.IO works for IRC bots with web panels                                       |
| **Limnoria/Supybot** | ACL system design, plugin config patterns                                                                         |
| **irc-framework**    | IRC protocol handling, IRCv3, SASL — we use this as our transport layer                                           |

---

_This document describes HexBot's stable architectural decisions. It is updated as the architecture evolves, not as individual features ship._
