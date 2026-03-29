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

A plugin may also include a `config.json` with default config values. These are merged with (and overridden by) the plugin's entry in `config/plugins.json`.

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

#### `botConfig: Record<string, unknown>`

Read-only bot configuration. Deep-frozen copy of `config/bot.json` with the NickServ password omitted from `services`. Contains `irc`, `owner`, `identity`, `services`, `database`, `pluginDir`, and `logging` keys.

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

#### `raw(line)`

Send a raw IRC protocol line. Newlines (`\r`, `\n`) are automatically stripped for safety. Prefer the typed methods above when possible.

---

### IRC channel operations

These are delegated to the IRCCommands core module, which handles mode batching and mod action logging.

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

---

### Channel state

#### `getChannel(name): ChannelState | undefined`

Get the state for a channel the bot is in.

```typescript
interface ChannelState {
  name: string;
  topic: string;
  modes: string;
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
}
```

#### `getUserHostmask(channel, nick): string | undefined`

Get the full `nick!ident@host` hostmask for a user in a channel. Returns `undefined` if the user is not found.

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

Returns ISUPPORT values from the IRC server. Currently returns an empty object (planned for future enhancement).

---

### Logging

#### `log(...args)`

Log a message prefixed with `[plugin:<name>]`. Uses `console.log`.

#### `error(...args)`

Log an error prefixed with `[plugin:<name>]`. Uses `console.error`.

---

## Full example

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'welcome-back';
export const version = '1.0.0';
export const description = 'Welcomes returning users';

export function init(api: PluginAPI): void {
  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const key = `joined:${ctx.nick.toLowerCase()}`;
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
