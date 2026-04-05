# Plugin API Reference

This documents the full API surface available to HexBot plugins. Every plugin's `init()` function receives a frozen `PluginAPI` object scoped to that plugin.

---

## Plugin structure

A plugin is a directory under `plugins/` containing an `index.ts` that exports the following:

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'my-plugin'; // required — alphanumeric, hyphens, underscores
export const version = '1.0.0'; // required
export const description = 'What it does'; // required

export function init(api: PluginAPI): void | Promise<void> {
  // Register binds, set up state
}

export function teardown(): void | Promise<void> {
  // Optional — clean up timers, connections, etc.
  // Binds are automatically removed by the loader.
}
```

A plugin may also include a `config.json` with default config values. These are merged with (and overridden by) the plugin's entry in `config/plugins.json`. Plugins are auto-discovered from the `plugins/` directory — they do not need an entry in `plugins.json` to be loaded. To disable a plugin, set `"enabled": false` in `plugins.json`.

### Channel scoping

By default, plugins operate in all channels. To restrict a plugin to specific channels, add a `channels` array to its `plugins.json` entry:

```json
{
  "greeter": {
    "channels": ["#lobby", "#welcome"],
    "config": { "message": "Welcome to {channel}, {nick}!" }
  }
}
```

When `channels` is set, the plugin's bind handlers only fire for events in those channels. Non-channel events (private messages, timers, nick changes, quits) always fire regardless of scope. Channel names are compared case-insensitively using the network's CASEMAPPING. An empty array (`"channels": []`) effectively disables the plugin for all channel events.

---

## PluginAPI

All properties on the API object are frozen. Plugins cannot modify the API or its nested objects.

### Properties

#### `pluginId: string`

The plugin's registered name. Matches the `name` export.

#### `config: Record<string, unknown>`

The merged config for this plugin. Values come from the plugin's own `config.json` defaults, overridden by the `config` key in `config/plugins.json`.

```typescript
// plugins.json
{
  "my-plugin": {
    "enabled": true,
    "config": {
      "greeting": "Hello!"
    }
  }
}

// In init():
const greeting = (api.config.greeting as string) ?? 'Hi';
```

**Secrets via `_env` fields.** Any config field named `<name>_env: "VAR_NAME"` is resolved from `process.env` before the plugin sees its config. The resolved value appears at `<name>`, and the `_env` key is removed. This works in both the plugin's own `config.json` and in `plugins.json` overrides.

```json
// plugins/my-plugin/config.json
{
  "api_key_env": "MY_PLUGIN_API_KEY",
  "endpoint": "https://api.example.com"
}
```

```typescript
// In init():
const apiKey = api.config.api_key as string | undefined;
if (!apiKey) {
  throw new Error('MY_PLUGIN_API_KEY env var is required');
}
```

Plugins must never read `process.env` directly — declare a `_env` field so the secret flows through the normal config path. See `docs/SECURITY.md`.

#### `botConfig: PluginBotConfig`

Read-only, deep-frozen view of `config/bot.json`. The NickServ password is omitted from `services`. Contains: `irc` (host, port, tls, nick, username, realname, channels), `owner` (handle, hostmask), `identity` (method, require_acc_for), `services` (type, nickserv, sasl), and `logging` (level, mod_actions). The `chanmod` key is present only for the chanmod plugin.

#### `permissions: PluginPermissions`

Read-only access to the permissions system.

#### `services: PluginServices`

Read-only access to NickServ identity verification.

#### `db: PluginDB`

Namespaced database access. All keys are scoped to this plugin automatically.

---

### Bind system

#### `bind(type, flags, mask, handler)`

Register an event handler.

| Parameter | Type                                             | Description                                                                      |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `type`    | `BindType`                                       | Event type (see table below)                                                     |
| `flags`   | `string`                                         | Required user flags. `'-'` = anyone. `'+o'` = ops. `'+n\|+m'` = owner OR master. |
| `mask`    | `string`                                         | Pattern to match against. Meaning depends on the bind type.                      |
| `handler` | `(ctx: HandlerContext) => void \| Promise<void>` | The callback.                                                                    |

Binds are automatically tagged with the plugin ID. On unload, all binds are removed.

```typescript
api.bind('pub', '-', '!hello', async (ctx) => {
  ctx.reply(`Hello, ${ctx.nick}!`);
});
```

#### `unbind(type, mask, handler)`

Remove a specific handler. Rarely needed since unload cleans up automatically.

---

### Bind types

| Type     | Trigger          | Mask matches against             | Stackable |
| -------- | ---------------- | -------------------------------- | --------- |
| `pub`    | Channel message  | Exact command (case-insensitive) | No        |
| `pubm`   | Channel message  | Wildcard on full text            | Yes       |
| `msg`    | Private message  | Exact command (case-insensitive) | No        |
| `msgm`   | Private message  | Wildcard on full text            | Yes       |
| `join`   | User joins       | `#channel nick!user@host` or `*` | Yes       |
| `part`   | User parts       | `#channel nick!user@host` or `*` | Yes       |
| `kick`   | User kicked      | `#channel nick!user@host` or `*` | Yes       |
| `nick`   | Nick change      | Wildcard on old nick             | Yes       |
| `mode`   | Mode change      | `#channel +/-mode` or `*`        | Yes       |
| `raw`    | Raw server line  | Command/numeric (wildcard)       | Yes       |
| `time`   | Timer (interval) | Seconds as string (e.g. `"60"`)  | Yes       |
| `ctcp`   | CTCP request     | CTCP type (e.g. `VERSION`)       | Yes       |
| `notice` | Notice received  | Wildcard on text                 | Yes       |
| `topic`  | Topic change     | Channel name wildcard            | Yes       |
| `quit`   | User quit        | `nick!user@host` wildcard        | Yes       |
| `invite` | Bot invited      | `#channel nick!user@host` or `*` | Yes       |

Non-stackable types (`pub`, `msg`) replace any previous bind on the same mask. Stackable types fire all matching handlers.

Timer binds enforce a minimum interval of 10 seconds.

---

### HandlerContext

Every handler receives a `ctx` object:

| Field               | Type             | Description                                 |
| ------------------- | ---------------- | ------------------------------------------- |
| `nick`              | `string`         | Source nick                                 |
| `ident`             | `string`         | Source ident (username)                     |
| `hostname`          | `string`         | Source hostname                             |
| `channel`           | `string \| null` | Channel name, or `null` for PMs             |
| `text`              | `string`         | Full message text                           |
| `command`           | `string`         | Parsed command (first word for `pub`/`msg`) |
| `args`              | `string`         | Everything after the command                |
| `reply(msg)`        | `function`       | Reply to the channel or PM source           |
| `replyPrivate(msg)` | `function`       | Reply via NOTICE to the user                |

---

### IRC actions

#### `say(target, message)`

Send a PRIVMSG to a channel or nick.

#### `action(target, message)`

Send a CTCP ACTION (`/me` style).

#### `notice(target, message)`

Send a NOTICE to a channel or nick.

#### `ctcpResponse(target, type, message)`

Send a CTCP reply. Used to respond to CTCP requests like VERSION or TIME.

---

### IRC channel operations

These are delegated to the IRCCommands core module, which handles mode batching and mod action logging.

#### `join(channel, key?)`

Join a channel, optionally with a key.

#### `part(channel, message?)`

Leave a channel with an optional part message.

#### `op(channel, nick)`

Set +o on a user. Logged to mod_log.

#### `deop(channel, nick)`

Set -o on a user. Logged to mod_log.

#### `halfop(channel, nick)`

Set +h on a user. Requires the bot to hold +h or +o in the channel. Not all networks support half-op — check ISUPPORT PREFIX before using.

#### `dehalfop(channel, nick)`

Set -h on a user.

#### `voice(channel, nick)`

Set +v on a user.

#### `devoice(channel, nick)`

Set -v on a user.

#### `kick(channel, nick, reason?)`

Kick a user from a channel. Logged to mod_log.

#### `ban(channel, mask)`

Set +b on a mask. Logged to mod_log.

#### `mode(channel, modes, ...params)`

Send an arbitrary MODE command. Respects the server's MODES limit by batching automatically.

```typescript
api.mode('#channel', '+oo', 'nick1', 'nick2');
```

#### `requestChannelModes(channel)`

Request the current channel modes from the server (`MODE #channel` with no args). The server replies with RPL_CHANNELMODEIS (324), which populates channel-state (`ch.modes`, `ch.key`, `ch.limit`) and fires `channel:modesReady`. This is automatically sent on bot join.

#### `topic(channel, text)`

Set the channel topic.

#### `invite(channel, nick)`

Invite a user to a channel.

#### `changeNick(nick)`

Change the bot's own IRC nick. Used primarily for nick recovery when the desired nick becomes available.

---

### Channel state

#### `getChannel(name): ChannelState | undefined`

Get the state for a channel the bot is in.

```typescript
interface ChannelState {
  name: string;
  topic: string;
  modes: string; // channel mode chars, e.g. "ntsk"
  key: string; // current channel key ('' if none)
  limit: number; // current channel user limit (0 if none)
  users: Map<string, ChannelUser>;
}
```

#### `getUsers(channel): ChannelUser[]`

Get all users in a channel as an array.

```typescript
interface ChannelUser {
  nick: string;
  ident: string;
  hostname: string;
  modes: string; // e.g. "ov" for op+voice
  joinedAt: number; // unix timestamp (ms)
  accountName?: string | null; // NickServ account from IRCv3 account-notify/extended-join
  // string = identified as this account
  // null = known not identified
  // undefined = no IRCv3 data available
}
```

#### `getUserHostmask(channel, nick): string | undefined`

Get the full `nick!ident@host` hostmask for a user in a channel. Returns `undefined` if the user is not found.

#### `onModesReady(callback)`

Register a callback that fires when channel modes are received from the server (RPL_CHANNELMODEIS). Callbacks are automatically cleaned up on plugin unload.

```typescript
api.onModesReady((channel: string) => {
  const ch = api.getChannel(channel);
  if (ch) {
    api.log(`${channel} modes=${ch.modes} key=${ch.key} limit=${ch.limit}`);
  }
});
```

---

### Permissions (read-only)

#### `permissions.findByHostmask(hostmask): UserRecord | null`

Look up a user record by matching a full `nick!ident@host` string against stored hostmask patterns.

```typescript
interface UserRecord {
  handle: string;
  hostmasks: string[];
  global: string; // global flags, e.g. "nmov"
  channels: Record<string, string>; // per-channel overrides
}
```

#### `permissions.checkFlags(requiredFlags, ctx): boolean`

Check if the user in a HandlerContext has the required flags. Supports OR with `|` (e.g. `'+n|+m'`). Owner flag (`n`) implies all other flags.

---

### Services (identity verification)

#### `services.verifyUser(nick): Promise<{ verified: boolean; account: string | null }>`

Query NickServ to verify a user's identity. Returns `{ verified: false, account: null }` on timeout or if services are unavailable.

#### `services.isAvailable(): boolean`

Returns `true` if services are configured and not set to `'none'`.

---

### Database

All database operations are scoped to the plugin's namespace. Keys from one plugin cannot collide with or access keys from another.

#### `db.get(key): string | undefined`

Retrieve a value by key.

#### `db.set(key, value)`

Store a string value. Overwrites any existing value for that key.

#### `db.del(key)`

Delete a key.

#### `db.list(prefix?): Array<{ key: string; value: string }>`

List all key-value pairs, optionally filtered by key prefix.

```typescript
// Store structured data as JSON
api.db.set('user:alice', JSON.stringify({ score: 42 }));

// Retrieve and parse
const raw = api.db.get('user:alice');
if (raw) {
  const data = JSON.parse(raw);
}

// List all user keys
const users = api.db.list('user:');
```

---

### Server capabilities

#### `getServerSupports(): Record<string, string>`

Returns ISUPPORT values from the IRC server (e.g., `MODES`, `PREFIX`, `CHANMODES`, `CASEMAPPING`). Available after the bot connects and receives the server's 005 replies.

---

### Channel settings

Per-channel typed key/value store backed by the database. Plugins register settings with types and defaults; admins configure them at runtime with `.chanset`.

#### `channelSettings.register(key, opts)`

Register a per-channel setting. Call this in `init()`. Settings are automatically unregistered on unload.

```typescript
api.channelSettings.register('greet_msg', {
  type: 'string',
  default: 'Welcome, {nick}!',
  description: 'Message sent on join',
});

api.channelSettings.register('auto_op', {
  type: 'flag',
  default: false,
  description: 'Auto-op flagged users on join',
});

api.channelSettings.register('max_lines', {
  type: 'int',
  default: 5,
  description: 'Maximum response lines',
});
```

#### `channelSettings.get(channel, key): string | number | boolean | undefined`

Get the value of a setting for a channel. Returns the configured value or the registered default.

#### `channelSettings.getFlag(channel, key): boolean`

Get a boolean (flag) setting. Returns `false` if not set.

#### `channelSettings.getString(channel, key): string`

Get a string setting. Returns `''` if not set.

#### `channelSettings.getInt(channel, key): number`

Get an integer setting. Returns `0` if not set.

#### `channelSettings.set(channel, key, value)`

Set a per-channel setting value programmatically.

#### `channelSettings.isSet(channel, key): boolean`

Check whether a setting has been explicitly configured for a channel.

#### `channelSettings.onChange(key, callback)`

Register a callback that fires when a setting value changes. Automatically cleaned up on unload.

---

### Help registry

#### `registerHelp(entries)`

Register help entries for the `!help` command. Entries are automatically removed on unload.

```typescript
api.registerHelp([
  {
    trigger: '!mycmd',
    category: 'fun',
    description: 'Does something fun',
    usage: '!mycmd [args]',
    flags: '-',
  },
]);
```

#### `getHelpEntries(): HelpEntry[]`

Retrieve the help entries registered by this plugin.

---

### Utilities

#### `ircLower(text): string`

IRC-aware case folding using the network's CASEMAPPING setting (rfc1459, strict-rfc1459, or ascii). Use this instead of `toLowerCase()` for nick/channel comparison.

#### `stripFormatting(text): string`

Remove IRC formatting control codes (bold, color, underline, etc.) from a string.

---

### Logging

Messages are prefixed with `[plugin:<name>]` and respect the bot's configured log level.

#### `log(...args)`

Log an info-level message.

#### `warn(...args)`

Log a warning.

#### `error(...args)`

Log an error.

#### `debug(...args)`

Log a debug message. Only visible when the bot's log level is set to `debug`.

---

## Full example

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'welcome-back';
export const version = '1.0.0';
export const description = 'Welcomes returning users';

export function init(api: PluginAPI): void {
  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    const key = `joined:${api.ircLower(ctx.nick)}`;
    const lastVisit = api.db.get(key);

    if (lastVisit) {
      ctx.reply(`Welcome back, ${ctx.nick}!`);
    }

    api.db.set(key, String(Date.now()));
  });

  // Clean up old records every hour
  api.bind('time', '-', '3600', () => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    const entries = api.db.list('joined:');
    for (const entry of entries) {
      if (parseInt(entry.value, 10) < cutoff) {
        api.db.del(entry.key);
      }
    }
    api.log('Cleaned up stale join records');
  });
}

export function teardown(): void {
  // Binds are auto-removed. Clean up any non-bind resources here.
}
```
