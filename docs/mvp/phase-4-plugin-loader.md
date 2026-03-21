# Plan: Phase 4 — Plugin Loader + Example Plugins

## Summary
Build the plugin loader with full hot-reload support, then create the first example plugins (8ball, greeter, seen). This phase proves the plugin system works end-to-end: loading, unloading, reloading, scoped API, database isolation, and config resolution. At the end, you can chat with plugins in IRC and hot-reload them without restarting the bot.

## Dependencies
- [x] Phase 0 complete (scaffolding)
- [x] Phase 1 complete (database + dispatcher)
- [x] Phase 2 complete (permissions + command handler)
- [x] Phase 3 complete (bot core + IRC + REPL)

---

## Phase 4A: Plugin loader

**Goal:** Discover, load, unload, and hot-reload plugins. Each plugin gets a scoped API.

- [ ] Create `src/plugin-loader.ts` implementing the `PluginLoader` class:
  - Constructor takes `{ bot, pluginDir }`
  - `async loadAll()` — discover and load all enabled plugins from config
    - Read `config/plugins.json` to determine which plugins are enabled
    - For each enabled plugin: find `plugins/<n>/index.ts`
    - Load in order, report successes and failures
    - Return results array: `[{ name, status: 'ok'|'error', error? }]`
  - `async load(pluginPath)` — load a single plugin
    - Dynamic `import()` with cache-bust: `?t=${Date.now()}`
    - Validate: must export `name` (string) and `init` (function)
    - Validate: plugin `name` must match safe pattern (alphanumeric, hyphens, underscores only)
    - Reject if a plugin with the same name is already loaded
    - Create scoped plugin API (see below)
    - Call `plugin.init(api)` wrapped in try/catch — a failing init must not crash the bot
    - Track in `loaded` map: name → `{ name, version, description, filePath, teardown, module }`
  - `async unload(pluginName)` — unload a plugin
    - Call `teardown()` if it exists (wrap in try/catch)
    - Call `dispatcher.unbindAll(pluginName)` to remove all binds
    - Remove from `loaded` map
    - Emit `plugin:unloaded` on event bus
  - `async reload(pluginName)` — unload then load
    - Store the file path before unloading
    - Unload, then load from same path
    - Emit `plugin:reloaded` on event bus
  - `list()` — return array of loaded plugin info
  - `_createPluginApi(pluginId)` — create the scoped API object:
    ```typescript
    {
      pluginId,

      // Bind system (auto-tagged with pluginId)
      bind: (type, flags, mask, handler) => dispatcher.bind(type, flags, mask, handler, pluginId),
      unbind: (type, mask, handler) => dispatcher.unbind(type, mask, handler),

      // IRC actions (delegated to IRCCommands / raw client)
      say: (target, msg) => ircCommands.say(target, msg),
      action: (target, msg) => ircCommands.action(target, msg),
      notice: (target, msg) => ircCommands.notice(target, msg),
      raw: (line) => client.raw(line),

      // IRC channel operations (delegated to IRCCommands)
      op: (channel, nick) => ircCommands.op(channel, nick),
      deop: (channel, nick) => ircCommands.deop(channel, nick),
      voice: (channel, nick) => ircCommands.voice(channel, nick),
      devoice: (channel, nick) => ircCommands.devoice(channel, nick),
      kick: (channel, nick, reason?) => ircCommands.kick(channel, nick, reason),
      ban: (channel, mask) => ircCommands.ban(channel, mask),
      mode: (channel, modes, ...params) => ircCommands.mode(channel, modes, ...params),

      // Channel state (delegated to ChannelState)
      getChannel: (name) => channelState.getChannel(name),
      getUser: (channel, nick) => channelState.getUser(channel, nick),
      getUserHostmask: (channel, nick) => channelState.getUserHostmask(channel, nick),

      // Permissions (read-only lookups — plugins can check flags but not modify users)
      permissions: {
        findByHostmask: (hostmask) => permissions.findByHostmask(hostmask),
        checkFlags: (nick, channel, flags) => permissions.checkFlags(nick, channel, flags),
      },

      // Services (identity verification)
      services: {
        verifyUser: (nick) => services.verifyUser(nick),
        isAvailable: () => services.isAvailable(),
      },

      // Database (namespaced to this plugin)
      db: db ? {
        get: (key) => db.get(pluginId, key),
        set: (key, value) => db.set(pluginId, key, value),
        del: (key) => db.del(pluginId, key),
        list: (prefix) => db.list(pluginId, prefix),
      } : null,

      // Bot config (read-only, for things like identity.require_acc_for)
      botConfig: Object.freeze(botConfig),

      // Plugin config (merged: plugins.json overrides > plugin config.json defaults)
      config: mergeConfig(pluginId),

      // Logging
      log: (...args) => console.log(`[plugin:${pluginId}]`, ...args),
      error: (...args) => console.error(`[plugin:${pluginId}]`, ...args),
    }
    ```
    Note: `ircCommands`, `channelState`, `services` are null until Phase 5 wires them in.
    The plugin API uses late-binding (getters or null checks) so plugins loaded before
    Phase 5 modules exist will get null for those fields — matching the stub pattern.
  - Config merging: read `plugins/<n>/config.json` as defaults, overlay with `plugins.json[name].config`
  - **Security:** See `docs/SECURITY.md` section 4. Key rules:
    - `Object.freeze()` the scoped API and nested objects (db, permissions, services) to prevent plugins from mutating shared state
    - Database namespace is enforced at the `Database` class level — the plugin API just pre-fills the namespace parameter
    - `permissions` on the plugin API is read-only (check flags, find users) — plugins cannot add/remove users or change flags
    - `botConfig` is frozen — plugins can read identity settings but not modify them
    - Plugin `init()` and all handler calls must be wrapped in try/catch

- [ ] Wire plugin loader into Bot class:
  - After IRC connection is established, call `pluginLoader.loadAll()`
  - Expose `pluginLoader` on bot instance
  - Update command handler stubs: `.plugins`, `.load`, `.unload`, `.reload` now call real plugin loader methods

- [ ] Create `tests/plugin-loader.test.ts`:
  - Create a temp directory with test plugins for each test
  - Test load: plugin's init() is called with scoped API
  - Test load: plugin's binds are registered in dispatcher
  - Test unload: teardown() is called
  - Test unload: plugin's binds are removed from dispatcher
  - Test reload: old binds gone, new binds registered
  - Test load failure: missing `name` export → error with clear message
  - Test load failure: missing `init` export → error with clear message
  - Test load failure: init() throws → error caught, reported, bot continues
  - Test double load: loading same plugin twice → error
  - Test scoped API: plugin's db operations are namespaced
  - Test scoped API: plugin A can't access plugin B's database
  - Test config merge: plugin defaults overridden by plugins.json
  - Test loadAll: loads only enabled plugins from config
- [ ] **Verify:** `pnpm vitest run tests/plugin-loader.test.ts` — all pass

## Phase 4B: 8ball plugin (simplest possible plugin)

**Goal:** Prove the plugin system works with the simplest possible plugin.

- [ ] Create `plugins/8ball/index.ts`:
  - Exports: `name`, `version`, `description`, `init`, `teardown`
  - One bind: `pub`, `-`, `!8ball` → random response from a list
  - No database, no config, no state
- [ ] Create `plugins/8ball/config.json`: `{}`
- [ ] Create `plugins/8ball/README.md`: usage docs
- [ ] Create `tests/plugins/8ball.test.ts`:
  - Test: dispatching a `pub` event with command `!8ball` triggers a reply
  - Test: reply is one of the known responses
  - Test: `!8ball` with no question returns usage hint
- [ ] **Manual verify:**
  - Start bot with REPL
  - `.plugins` shows 8ball loaded
  - In IRC: `!8ball Will this work?` → bot responds
  - In REPL: `.reload 8ball` → no errors
  - In IRC: `!8ball` still works after reload

## Phase 4C: Greeter plugin (uses config)

**Goal:** Prove config resolution works.

- [ ] Create `plugins/greeter/index.ts`:
  - Binds `join` on `*` mask
  - Reads greeting template from `api.config.message`
  - Replaces `{channel}` and `{nick}` in template
  - Skips greeting the bot itself
- [ ] Create `plugins/greeter/config.json`:
  ```json
  { "message": "Welcome to {channel}, {nick}!" }
  ```
- [ ] Create `plugins/greeter/README.md`
- [ ] Create `tests/plugins/greeter.test.ts`:
  - Test: join event triggers greeting with default message
  - Test: custom message from config is used
  - Test: bot doesn't greet itself
- [ ] **Manual verify:** join the channel from another IRC client → bot greets you

## Phase 4D: Seen plugin (uses database)

**Goal:** Prove database namespacing works for plugins.

- [ ] Create `plugins/seen/index.ts`:
  - Binds `pubm` on `*` to track every channel message (stackable, doesn't interfere with other binds)
  - Stores `{ nick, channel, text, time }` in DB keyed by lowercase nick
  - Binds `pub` on `!seen` to look up last-seen data
  - Formats relative time (seconds/minutes/hours/days ago)
- [ ] Create `plugins/seen/config.json`: `{}`
- [ ] Create `plugins/seen/README.md`
- [ ] Create `tests/plugins/seen.test.ts`:
  - Test: channel message updates seen record in DB
  - Test: `!seen nick` returns last-seen info
  - Test: `!seen unknown` returns "haven't seen" message
  - Test: data persists across plugin reload
  - Test: seen plugin's DB namespace is isolated from other plugins
- [ ] **Manual verify:**
  - Chat in channel → `.seen yournick` returns correct info
  - Reload plugin → data persists

## Phase 4E: Full integration

- [ ] Run `pnpm test` — all tests pass (Phase 1 + 2 + 3 + 4)
- [ ] Start bot, load all three plugins, verify all work simultaneously
- [ ] Verify hot-reload: modify a plugin's response, `.reload` it, verify new behavior
- [ ] Verify unload: `.unload 8ball`, confirm `!8ball` no longer responds, other plugins unaffected

---

## Verification

**This phase is complete when:**
1. `pnpm vitest run tests/plugin-loader.test.ts` — all pass
2. All three plugin test files pass
3. `pnpm test` — entire suite passes
4. Bot starts, loads all three plugins, all respond correctly in IRC
5. Hot-reload works: edit plugin code → `.reload` → new behavior live
6. Unload works: `.unload` removes plugin cleanly
7. Database namespacing confirmed: plugins can't see each other's data
8. Config merging confirmed: plugins.json overrides plugin defaults

## Next phase
Phase 5: Core Modules (services, irc-commands, channel-state) + Auto-op Plugin
