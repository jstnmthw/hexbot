# Plugin API Reference

This documents the full API surface available to HexBot plugins. Every plugin's `init()` function receives a frozen `PluginAPI` object scoped to that plugin.

---

## Plugin structure

A plugin is a directory under `plugins/` containing:

- `index.ts` — source code with required exports
- `tsup.config.ts` — build config (bundles to `dist/index.js`)
- `config.json` — optional default config values
- `package.json` — optional, only if the plugin has its own npm dependencies

The plugin's `index.ts` exports:

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
  // Also called if init() throws partway through, so partial
  // state is safely drained before the error propagates.
}
```

### Building plugins

All plugins bundle via tsup to a single `dist/index.js`. Run `pnpm build:plugins` to build all plugins. The loader imports `dist/index.js` at runtime — source `.ts` files are never imported directly.

Plugins with their own `package.json` (e.g., rss with `rss-parser`) have their npm dependencies installed automatically by the build script and inlined into the bundle.

Config values (`config.json`) are merged with (and overridden by) the plugin's entry in `config/plugins.json`. Plugins are auto-discovered from the `plugins/` directory by checking for `dist/index.js` — they do not need an entry in `plugins.json` to be loaded. To disable a plugin, set `"enabled": false` in `plugins.json`.

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

#### `settings: PluginSettings`

The plugin's typed live-config registry. Operators mutate values via `.set <plugin> <key> <value>`; the plugin reads them via typed accessors. Replaces the old `api.config` field — every plugin declares its keys with `register([...])` and reads back via `getString` / `getInt` / `getFlag`.

```typescript
// In init():
api.settings.register([
  { key: 'greeting', type: 'string', default: 'Hi', description: 'Greeting prefix' },
  { key: 'cooldown_ms', type: 'int', default: 30_000, description: 'Per-user cooldown' },
]);
const greeting = api.settings.getString('greeting');
```

The plugin loader seeds each registered key from `plugins.json` (or the plugin's own `config.json` defaults) on first boot. After that, KV is canonical — operator `.set` writes survive process restarts; routine restarts never clobber them. JSON edits are pulled in on demand via `.rehash`.

| Method            | Returns                             | Notes                                                         |
| ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| `register(defs)`  | `void`                              | Declare typed defs. Idempotent re-registration is fine.       |
| `get(key)`        | `boolean \| string \| number`       | Untyped union; prefer the typed getters below.                |
| `getString(key)`  | `string`                            | Returns `''` when unset and the def is missing or non-string. |
| `getInt(key)`     | `number`                            | Returns `0` when unset.                                       |
| `getFlag(key)`    | `boolean`                           | Returns `false` when unset.                                   |
| `set(key, value)` | `void`                              | Plugin self-write. Same store operators reach via `.set`.     |
| `unset(key)`      | `void`                              | Reverts reads to the registered default.                      |
| `isSet(key)`      | `boolean`                           | True when an explicit value is stored.                        |
| `onChange(cb)`    | `void`                              | Auto-cleaned on plugin unload.                                |
| `bootConfig`      | `Readonly<Record<string, unknown>>` | Frozen merged JSON bag — escape hatch for nested config.      |

**`bootConfig`** is the frozen merged `plugins.json` / `config.json` bag the loader handed this plugin at load time. Use it for deeply-nested config that doesn't flatten cleanly to typed settings (e.g. `ai-chat.channel_characters`, `rss.feeds`). For new keys, prefer `register()` + `get*()` so operators can `.set` them live.

**Secrets via `_env` fields.** Any config field named `<name>_env: "VAR_NAME"` is resolved from `process.env` before the plugin sees its config (or its `bootConfig` snapshot). The resolved value appears at `<name>` and the `_env` key is removed. This works in both the plugin's own `config.json` and in `plugins.json` overrides.

```json
// plugins/my-plugin/config.json
{
  "api_key_env": "MY_PLUGIN_API_KEY",
  "endpoint": "https://api.example.com"
}
```

```typescript
// In init():
api.settings.register([
  { key: 'api_key', type: 'string', default: '', description: 'Provider API key' },
  { key: 'endpoint', type: 'string', default: '', description: 'Provider endpoint' },
]);
const apiKey = api.settings.getString('api_key');
if (!apiKey) {
  throw new Error('MY_PLUGIN_API_KEY env var is required');
}
```

Plugins must never read `process.env` directly — declare a `_env` field so the secret flows through the normal config path. See `docs/SECURITY.md`.

#### `botConfig: PluginBotConfig`

Read-only, deep-frozen view of `config/bot.json`. Contains: `irc` (host, port, tls, nick, username, realname, channels), `identity` (method, require_acc_for), `services` (type, nickserv, sasl), and `logging` (level, mod_actions). The NickServ password is omitted from `services`. The `channels` array contains only channel name strings (keys are never exposed). TLS client-certificate paths (`tls_cert`, `tls_key`) are omitted. The `owner` block is omitted entirely — use the permissions API if you need to check for owner privileges. The `database` and `pluginDir` filesystem paths are omitted. The `chanmod` key is present only for the chanmod plugin. Every sub-object is individually frozen per SECURITY.md §4.1.

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

| Parameter | Type                                             | Description                                                                   |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `type`    | `BindType`                                       | Event type (see table below)                                                  |
| `flags`   | `string`                                         | Required user flags. `'-'` = anyone. `'o'` = ops. `'n\|m'` = owner OR master. |
| `mask`    | `string`                                         | Pattern to match against. Meaning depends on the bind type.                   |
| `handler` | `(ctx: HandlerContext) => void \| Promise<void>` | The callback.                                                                 |

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

| Type         | Trigger          | Mask matches against                               | Stackable |
| ------------ | ---------------- | -------------------------------------------------- | --------- |
| `pub`        | Channel message  | Exact command (case-insensitive)                   | No        |
| `pubm`       | Channel message  | Wildcard on full text                              | Yes       |
| `msg`        | Private message  | Exact command (case-insensitive)                   | No        |
| `msgm`       | Private message  | Wildcard on full text                              | Yes       |
| `join`       | User joins       | `#channel nick!user@host` or `*`                   | Yes       |
| `part`       | User parts       | `#channel nick!user@host` or `*`                   | Yes       |
| `kick`       | User kicked      | `#channel nick!user@host` or `*`                   | Yes       |
| `nick`       | Nick change      | Wildcard on old nick                               | Yes       |
| `mode`       | Mode change      | `#channel +/-mode` or `*`                          | Yes       |
| `raw`        | Raw server line  | Command/numeric (wildcard)                         | Yes       |
| `time`       | Timer (interval) | Seconds as string (e.g. `"60"`)                    | Yes       |
| `ctcp`       | CTCP request     | Exact CTCP type (case-insensitive, e.g. `VERSION`) | Yes       |
| `notice`     | Notice received  | Wildcard on text                                   | Yes       |
| `topic`      | Topic change     | Channel name wildcard                              | Yes       |
| `quit`       | User quit        | `nick!user@host` wildcard                          | Yes       |
| `invite`     | Bot invited      | `#channel nick!user@host` or `*`                   | Yes       |
| `join_error` | Bot join failed  | Error name wildcard or `*`                         | Yes       |

Non-stackable types (`pub`, `msg`) replace any previous bind on the same mask. Stackable types fire all matching handlers.

Timer binds enforce a minimum interval of 10 seconds.

---

### HandlerContext

Every handler receives a `ctx` object:

| Field               | Type                          | Description                                 |
| ------------------- | ----------------------------- | ------------------------------------------- |
| `nick`              | `string`                      | Source nick                                 |
| `ident`             | `string`                      | Source ident (username)                     |
| `hostname`          | `string`                      | Source hostname                             |
| `account`           | `string \| null \| undefined` | IRCv3 `account-tag` value (see below)       |
| `channel`           | `string \| null`              | Channel name, or `null` for PMs             |
| `text`              | `string`                      | Full message text                           |
| `command`           | `string`                      | Parsed command (first word for `pub`/`msg`) |
| `args`              | `string`                      | Everything after the command                |
| `reply(msg)`        | `function`                    | Reply to the channel or PM source           |
| `replyPrivate(msg)` | `function`                    | Reply via NOTICE to the user                |

The `account` field carries the services account name from the IRCv3 `account-tag` on the inbound message:

- **`string`** -- the server confirmed this account sent the message (authoritative).
- **`null`** -- the server confirmed the sender is not identified (authoritative).
- **`undefined`** -- no `account-tag` data available (cap not negotiated, non-PRIVMSG event, or server omitted the tag). Treat as "unknown, fall back to other signals".

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

> **Auto-audit:** Every `api.op` / `api.deop` / `api.kick` / `api.ban` / `api.voice` / `api.devoice` / `api.halfop` / `api.dehalfop` / `api.invite` / `api.topic` / `api.mode` call writes a `mod_log` row tagged with `source='plugin'` and `plugin=<your plugin id>`. The `by` attribution defaults to `<your plugin id>` — pass `api.auditActor(ctx)` as the trailing `actor` argument to attribute the action to the triggering user (`ctx.nick`) instead. You don't need to call `api.audit.log` for these — the wrapper does it for free, and trying to override `source` or `plugin` is impossible because the factory rebuilds them in a frozen actor object. See [docs/AUDIT.md](AUDIT.md) for the full action vocabulary.
>
> ```typescript
> api.bind('pub', 'o', '!op', (ctx) => {
>   const [nick] = ctx.args.split(/\s+/);
>   // Attribute the mod_log row to ctx.nick, not to the plugin id
>   api.op(ctx.channel, nick, api.auditActor(ctx));
> });
>
> // Timer-driven action with no triggering user — omit the actor so `by`
> // falls back to the plugin id
> api.bind('time', '-', '300', () => {
>   api.mode('#lobby', '+m');
> });
> ```

#### `join(channel, key?)`

Join a channel, optionally with a key.

#### `part(channel, message?)`

Leave a channel with an optional part message.

Every mutating method below takes an optional trailing `actor?: PluginModActor` argument. Build one with [`auditActor(ctx)`](#auditactorctx) to attribute the `mod_log` `by` column to the triggering user; omit it for plugin-autonomous actions (timers, event reactions) where the plugin itself is the actor.

#### `op(channel, nick, actor?)`

Set +o on a user. Logged to mod_log.

#### `deop(channel, nick, actor?)`

Set -o on a user. Logged to mod_log.

#### `halfop(channel, nick, actor?)`

Set +h on a user. Requires the bot to hold +h or +o in the channel. Not all networks support half-op — check ISUPPORT PREFIX before using.

#### `dehalfop(channel, nick, actor?)`

Set -h on a user.

#### `voice(channel, nick, actor?)`

Set +v on a user.

#### `devoice(channel, nick, actor?)`

Set -v on a user.

#### `kick(channel, nick, reason?, actor?)`

Kick a user from a channel. Logged to mod_log.

#### `ban(channel, mask, actor?)`

Set +b on a mask. Logged to mod_log.

#### `mode(channel, modes, ...params)`

Send an arbitrary MODE command. Respects the server's MODES limit by batching automatically.

```typescript
api.mode('#channel', '+oo', 'nick1', 'nick2');
```

#### `requestChannelModes(channel)`

Request the current channel modes from the server (`MODE #channel` with no args). The server replies with RPL_CHANNELMODEIS (324), which populates channel-state (`ch.modes`, `ch.key`, `ch.limit`) and fires `channel:modesReady`. This is automatically sent on bot join.

#### `topic(channel, text, actor?)`

Set the channel topic.

#### `invite(channel, nick, actor?)`

Invite a user to a channel.

#### `changeNick(nick)`

Change the bot's own IRC nick. Used primarily for nick recovery when the desired nick becomes available.

---

### Audit

Every plugin gets an `api.audit` writer scoped to its own plugin id. Use it for **non-IRC** privileged events — feed mutations, lockdown state changes, threat-level escalations, anything that doesn't fit the `api.irc.*` shape.

```typescript
api.audit.log(action: string, options?: {
  channel?: string | null;
  target?: string | null;
  outcome?: 'success' | 'failure'; // default 'success'
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): void;
```

The factory forces `source='plugin'`, `plugin=<your id>`, and `by=<your id>`. You **cannot** override these — even if you stuff them into `options`, they're stripped. This is the enforcement boundary that keeps a misbehaving plugin from spoofing another plugin's identity or pretending to be a non-plugin source.

Examples:

```typescript
// Flood plugin: lockdown triggered
api.audit.log('flood-lockdown', {
  channel: '#busy',
  reason: '+R',
  metadata: { mode: 'R', flooderCount: 5, durationMs: 300_000 },
});

// RSS plugin: feed added
api.audit.log('rss-feed-add', {
  channel: '#news',
  target: feedId,
  reason: feedUrl,
  metadata: { interval: 3600 },
});

// Permission-denied path
api.audit.log('rss-feed-add', {
  channel: ctx.channel,
  target: feedId,
  outcome: 'failure',
  reason: 'caller lacks +o',
});
```

`api.audit.log` is wrapped in try/catch — a failed audit write never propagates an exception into your handler. The mutation is what matters; audit is best-effort.

For privileged actions that map onto an `api.irc.*` call, you don't need to call `api.audit.log` at all — the IRC wrapper auto-logs the row. Reach for `api.audit.log` only when the event has no IRC analogue. The full action vocabulary, plus the rules for plugin authors, lives in [docs/AUDIT.md](AUDIT.md).

A plugin **must not** call `db.logModAction` directly. The scoped API doesn't expose the database directly, and the audit factory is the only supported path.

#### `auditActor(ctx): PluginModActor`

Build the `{ by, source, plugin }` triple you pass as the trailing `actor` argument to `api.op` / `api.ban` / `api.kick` / `api.mode` / etc. so the resulting `mod_log` row attributes the action to `ctx.nick` rather than to the plugin id.

```typescript
api.bind('pub', 'o', '!kick', (ctx) => {
  const [nick, ...rest] = ctx.args.split(/\s+/);
  api.kick(ctx.channel, nick, rest.join(' '), api.auditActor(ctx));
});
```

The factory hard-codes `source = 'plugin'` and `plugin = <your plugin id>` — passing a hand-rolled object with a different `source` or `plugin` has no effect. Only `by` (the nick attribution) is taken from the returned actor. This is the enforcement point that prevents a misbehaving plugin from spoofing another plugin's identity.

Use this for every plugin mutation that was triggered by a user command. Omit the actor for plugin-autonomous actions (timers, event reactions) where the plugin itself is the actor — `by` will default to the plugin id.

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
  away?: boolean; // IRCv3 away-notify state
  // true = user has set an AWAY message
  // false = user is explicitly back
  // undefined = no away-notify data received yet
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

Check if the user in a HandlerContext has the required flags. Supports OR with `|` (e.g. `'n|m'`). Owner flag (`n`) implies all other flags.

---

### Services (identity verification)

#### `services.verifyUser(nick): Promise<{ verified: boolean; account: string | null }>`

Query NickServ to verify a user's identity. Returns `{ verified: false, account: null }` on timeout or if services are unavailable.

If the bot is known-unidentified (e.g. SASL failed silently), this returns `{ verified: false, account: null }` immediately without issuing a STATUS/ACC query, since the IRC server would ignore the query anyway.

#### `services.isAvailable(): boolean`

Returns `true` if services are configured and not set to `'none'`.

#### `services.isBotIdentified(): boolean`

Returns `true` if the bot's own NickServ identity has been confirmed for the current session — either via IRCv3 `account-notify` (SASL success) or a NickServ "You are now identified" notice (password IDENTIFY). Returns `false` if identity is `'unknown'`, `'pending'`, or `'unidentified'`.

Useful for gating ChanServ-dependent operations until the bot can actually make them succeed.

```typescript
api.onBotIdentified(() => {
  if (!api.services.isBotIdentified()) return; // race guard
  api.log('Bot is now identified — safe to query ChanServ');
});
```

#### `onBotIdentified(callback) / offBotIdentified(callback)`

Register or remove a callback that fires when the bot's own NickServ identity is confirmed. Fires both on initial connect and after a SASL fallback recovery. Callbacks are automatically cleaned up on plugin unload.

```typescript
api.onBotIdentified(() => {
  for (const ch of api.botConfig.irc.channels) {
    // Re-check access if it was unknown during initial probe
    api.log(`Bot identified — re-probing ${ch}`);
  }
});
```

The symmetric `bot:deidentified` event fires on disconnect and on `account-notify` logout; there is no `onBotDeidentified` API surface yet since plugins tear down on disconnect anyway.

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

### Identity helpers

#### `buildHostmask(source): string`

Build a `nick!ident@hostname` string from any object with those three fields. Useful for constructing hostmasks from context or channel-user objects without manual string interpolation.

```typescript
const mask = api.buildHostmask(ctx); // "alice!~alice@example.com"
```

#### `isBotNick(nick): boolean`

Returns `true` if `nick` case-folds to the bot's own configured nick using the network's CASEMAPPING. Use instead of comparing against `api.botConfig.irc.nick` directly.

#### `getChannelKey(channel): string | undefined`

Returns the configured channel key (from `config/bot.json`) for a channel, or `undefined` if no key is configured. Uses IRC-aware case folding for the channel name comparison.

---

### Ban store

The core ban store is shared across all plugins and stored under a dedicated `_bans` namespace. It tracks bans set by the bot with optional expiry and sticky flags.

#### `banStore.storeBan(channel, mask, by, durationMs)`

Store a ban record. `durationMs` of `0` means permanent.

#### `banStore.removeBan(channel, mask)`

Remove a ban record.

#### `banStore.getBan(channel, mask): BanRecord | null`

Look up a specific ban.

#### `banStore.getChannelBans(channel): BanRecord[]`

Get all stored bans for a channel.

#### `banStore.getAllBans(): BanRecord[]`

Get all stored bans across all channels.

#### `banStore.setSticky(channel, mask, sticky): boolean`

Mark a ban as sticky (will be re-applied if removed). Returns `true` if the ban was found and updated.

#### `banStore.liftExpiredBans(hasOps, mode): number`

Check all bans for expiry and unset expired ones via the provided `mode` callback. Returns the number of bans lifted.

#### `banStore.migrateFromPluginNamespace(pluginDb): number`

Migrate ban records from a plugin's old namespace to the core `_bans` namespace. Returns the number of records migrated.

```typescript
interface BanRecord {
  mask: string;
  channel: string;
  by: string;
  ts: number;
  expires: number; // 0 = permanent, otherwise unix timestamp ms
  sticky?: boolean;
}
```

---

### Channel settings

Per-channel typed key/value store backed by the database. Plugins register settings with types and defaults; admins configure them at runtime with `.chanset`.

#### `channelSettings.register(defs)`

Register per-channel setting definitions. Takes an array of `ChannelSettingDef` objects. Call this once in `init()`. Settings are automatically unregistered on unload.

```typescript
api.channelSettings.register([
  {
    key: 'greet_msg',
    type: 'string',
    default: 'Welcome, {nick}!',
    description: 'Message sent on join',
  },
  {
    key: 'auto_op',
    type: 'flag',
    default: false,
    description: 'Auto-op flagged users on join',
  },
  {
    key: 'max_lines',
    type: 'int',
    default: 5,
    description: 'Maximum response lines',
  },
]);
```

#### `channelSettings.get(channel, key): string | number | boolean`

Get the value of a setting for a channel. Returns the configured value, the registered default, or `''` if the key is unknown.

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

#### `channelSettings.onChange(callback)`

Register a callback that fires when any per-channel setting value changes. The callback receives `(channel, key, value)`. Automatically cleaned up on unload.

```typescript
api.channelSettings.onChange((channel, key, value) => {
  api.log(`Setting ${key} changed in ${channel} to ${value}`);
});
```

---

### Help registry

#### `registerHelp(entries)`

Register help entries for the `!help` command. Entries are automatically removed on unload.

```typescript
api.registerHelp([
  {
    command: '!mycmd',
    description: 'Does something fun',
    usage: '!mycmd [args]',
    flags: '-',
    category: 'fun', // optional — defaults to pluginId
    detail: ['Extra detail line shown in !help mycmd'], // optional
  },
]);
```

#### `getHelpEntries(): HelpEntry[]`

Retrieve all help entries registered across all plugins. Each entry includes a `pluginId` field identifying which plugin registered it.

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

#### DCC console routing

Every line written via `api.log` / `api.warn` / `api.error` / `api.debug` is
offered to each connected DCC session. Whether it reaches a given session
depends on that session's `.console` flags. By default a plugin's lines land
in the `m` (bot messages) category, except for plugins whose prefix the core
already maps elsewhere (`plugin:chanmod` → `o`, `plugin:greeter`/`plugin:seen`
→ `j`, etc. — see [docs/DCC.md#console-flags](DCC.md#console-flags)). Debug
lines only reach sessions holding the `d` flag; warn/error lines always
reach sessions holding `w`. Plugin authors do not normally need to think
about this — pick a clear log level and the category follows.

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
