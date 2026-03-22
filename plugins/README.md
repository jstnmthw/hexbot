# n0xb0t plugins

This directory contains all bot plugins. Each subdirectory is a self-contained plugin with its own `index.ts`, optional `config.json`, and optional `README.md`.

## Included plugins

| Plugin              | Commands                                                                    | Description                                                              |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [8ball](8ball/)     | `!8ball <question>`                                                         | Magic 8-ball responses                                                   |
| [chanmod](chanmod/) | `!op`, `!deop`, `!voice`, `!devoice`, `!kick`, `!ban`, `!unban`, `!kickban` | Channel protection: auto-op/voice, mode enforcement, moderation commands |
| [greeter](greeter/) | _(automatic)_                                                               | Greets users on channel join                                             |
| [seen](seen/)       | `!seen <nick>`                                                              | Tracks when a user was last active                                       |
| [topic](topic/)     | `!topic`, `!topics`                                                         | Set channel topics with IRC color themes                                 |

## Creating a new plugin

Create a directory here with at least an `index.ts`:

```
plugins/
  my-plugin/
    index.ts       # required — plugin entry point
    config.json    # optional — default config values
    README.md      # optional — usage docs
```

### Required exports

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'my-plugin'; // alphanumeric, hyphens, underscores
export const version = '1.0.0';
export const description = 'What it does';

export function init(api: PluginAPI): void {
  // Register binds, read config, set up state
}

export function teardown(): void {
  // Optional — clean up timers, connections, etc.
  // Binds are automatically removed on unload.
}
```

- `name` must match the directory name and be safe (`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`)
- `init()` and `teardown()` can be async (return `Promise<void>`)

### Enabling your plugin

Add an entry to `config/plugins.json`:

```json
{
  "my-plugin": {
    "enabled": true
  }
}
```

Or load at runtime from the REPL: `.load my-plugin`

### Responding to IRC commands

Use `api.bind()` to register event handlers. The most common bind type is `pub` (channel message with exact command match):

```typescript
api.bind('pub', '-', '!hello', (ctx: HandlerContext) => {
  ctx.reply(`Hello, ${ctx.nick}!`);
});
```

The arguments are:

- **type** — what IRC event to listen for
- **flags** — required user permissions (`'-'` = anyone, `'o'` = ops, `'n'` = owner)
- **mask** — what to match against (depends on the bind type)

### Common bind types

| Type   | Use case                | Mask matches                                 |
| ------ | ----------------------- | -------------------------------------------- |
| `pub`  | `!command` in a channel | Exact command (e.g. `!hello`)                |
| `pubm` | Any channel text        | Wildcard on full message (e.g. `*http*`)     |
| `msg`  | Private message command | Exact command                                |
| `join` | User joins a channel    | `#channel nick!user@host` or `*` for all     |
| `time` | Run on an interval      | Seconds as a string (e.g. `"300"` for 5 min) |

`pub` and `msg` are **non-stackable** — one handler per command across all plugins. All other types are **stackable** — every matching handler fires.

### The handler context

Every handler gets a `ctx` object:

```typescript
api.bind('pub', '-', '!greet', (ctx: HandlerContext) => {
  ctx.nick; // "alice"
  ctx.ident; // "alice"
  ctx.hostname; // "user.example.com"
  ctx.channel; // "#lobby" (null for PMs)
  ctx.text; // "!greet everyone"
  ctx.command; // "!greet"
  ctx.args; // "everyone"

  ctx.reply('Hi!'); // sends to #lobby (or PM if private)
  ctx.replyPrivate('Secret'); // sends a NOTICE to alice
});
```

### Permission flags

| Flag | Role   | Access                               |
| ---- | ------ | ------------------------------------ |
| `n`  | Owner  | Full access; implies all other flags |
| `m`  | Master | User management                      |
| `o`  | Op     | Channel commands                     |
| `v`  | Voice  | Reserved for plugin use              |
| `-`  | Anyone | No restriction                       |

Combine with `|` for OR: `'n|m'` means owner OR master. When a user lacks the required flags, the bind silently doesn't fire.

### Configuration

Create a `config.json` in your plugin directory with defaults:

```json
{
  "cooldown_seconds": 30,
  "max_results": 5
}
```

Users override in `config/plugins.json`:

```json
{
  "my-plugin": {
    "enabled": true,
    "config": {
      "cooldown_seconds": 10
    }
  }
}
```

Access merged config in `init()`:

```typescript
const cooldown = (api.config.cooldown_seconds as number) ?? 30;
```

### Persistent storage

Every plugin gets a namespaced key-value store. Keys never collide across plugins.

```typescript
api.db.set('score:alice', '42');
const score = api.db.get('score:alice'); // "42" or undefined
api.db.del('score:alice');
const all = api.db.list('score:'); // [{ key, value }, ...]
```

Values are strings — store structured data as JSON.

### Sending messages

```typescript
api.say('#lobby', 'Hello channel'); // PRIVMSG
api.notice('#lobby', 'Notice to channel'); // NOTICE
api.action('#lobby', 'waves'); // /me waves
```

### Channel operations

Require the bot to have operator status:

```typescript
api.op('#lobby', 'alice');
api.kick('#lobby', 'troll', 'Bye');
api.ban('#lobby', '*!*@troll.example.com');
api.topic('#lobby', 'New topic text');
api.mode('#lobby', '+m');
```

### Logging

Messages are prefixed with `[plugin:my-plugin]` and respect the bot's log level. Don't log on load — the plugin loader handles that.

```typescript
api.log('Processing request'); // info
api.warn('Rate limit approaching');
api.error('Failed to fetch data');
api.debug('Raw response:', data); // only at debug level
```

### Hot reloading

Plugins can be reloaded at runtime (`.reload my-plugin`). Design for this:

- Use `api.db` for state that should survive reloads, not module-level variables
- Clean up non-bind resources (connections, file handles) in `teardown()`
- Binds are removed automatically

### Complete example: a dice roller

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'dice';
export const version = '1.0.0';
export const description = 'Roll dice with !roll NdS syntax';

export function init(api: PluginAPI): void {
  const maxDice = (api.config.max_dice as number) ?? 20;
  const maxSides = (api.config.max_sides as number) ?? 100;

  api.bind('pub', '-', '!roll', (ctx: HandlerContext) => {
    const input = ctx.args.trim() || '1d6';
    const match = input.match(/^(\d+)d(\d+)$/i);

    if (!match) {
      ctx.reply('Usage: !roll NdS (e.g. !roll 2d6)');
      return;
    }

    const count = Math.min(parseInt(match[1], 10), maxDice);
    const sides = Math.min(parseInt(match[2], 10), maxSides);

    if (count < 1 || sides < 1) {
      ctx.reply('Need at least 1d1.');
      return;
    }

    const rolls: number[] = [];
    for (let i = 0; i < count; i++) {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }

    const total = rolls.reduce((a, b) => a + b, 0);
    const detail = count <= 10 ? ` (${rolls.join(', ')})` : '';
    ctx.reply(`${ctx.nick} rolled ${count}d${sides}: ${total}${detail}`);
  });
}

export function teardown(): void {}
```

### Checklist

Before shipping a plugin:

- [ ] `name` export matches directory name
- [ ] `version` and `description` are set
- [ ] Commands handle missing/bad arguments with a usage reply
- [ ] Privileged commands have appropriate flags (`o`, `m`, or `n`)
- [ ] Config has sensible defaults in `config.json`
- [ ] No `console.log` — use `api.log()` / `api.error()` instead
- [ ] `teardown()` cleans up any non-bind resources
- [ ] Plugin added to `config/plugins.json` with `"enabled": true`

## Full API reference

See [docs/PLUGIN_API.md](../docs/PLUGIN_API.md) for the complete PluginAPI surface including channel state, permissions, services, and all 13 bind types.
