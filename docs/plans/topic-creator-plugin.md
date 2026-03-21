# Plan: Topic Creator Plugin

## Summary

A plugin that lets channel operators set styled IRC topics using pre-built color themes. A user with the `o` flag types `!topic silverscreen Welcome to #Lobby!` and the bot sets the channel topic wrapped in that theme's color-coded border design. Ships with 22 built-in themes from `docs/TOPIC_CREATOR.md`.

## Feasibility

- **Alignment**: Perfect fit. This is a standard plugin — binds `pub` commands, uses the scoped API. No design changes needed.
- **Dependencies**: All required core modules are built. `IRCCommands.topic()` exists in `src/core/irc-commands.ts:98` but is **not exposed in the PluginAPI** — will be added as part of this work.
- **Blockers**: None.
- **Complexity**: **S** (hours) — straightforward plugin with no external dependencies.
- **Risk areas**:
  - **Bot must have channel op** (or channel must be `-t`) to set topics. Should detect failure gracefully.
  - **Topic length limits** vary by network (typically 390 chars). The color codes consume significant space. Must warn or truncate.
  - **IRC control characters** (`\x03` for color, `\x02` for bold, `\x0F` for reset) must be correctly embedded in templates — they can't be stored as literal readable text.
  - **User text injection** — user-supplied topic text must be sanitized (strip `\r\n`) before interpolation. The `IRCCommands.topic()` method already does this, but since we're building the full string before sending, we must sanitize at our level too.

## Dependencies

- [x] Plugin loader (`src/plugin-loader.ts`)
- [x] Dispatcher bind system (`src/dispatcher.ts`)
- [x] IRC commands core module (`src/core/irc-commands.ts`) — `topic()` exists
- [x] Channel state (`src/core/channel-state.ts`) — can read current topic
- [ ] Expose `topic()` on `PluginAPI` interface

## Phases

### Phase 1: Expose `topic()` on the PluginAPI

**Goal:** Add `topic(channel, text)` to the plugin interface so plugins can set topics using a typed method instead of `api.raw()`.

- [ ] Add `topic(channel: string, text: string): void` to the `PluginAPI` interface in `src/types.ts`
- [ ] Wire it up in `src/plugin-loader.ts` where the scoped API object is constructed — delegate to `ircCommands.topic(channel, text)`
- [ ] Verify: load any existing plugin, confirm `api.topic` is a function on the API object

### Phase 2: Plugin with built-in themes

**Goal:** Working `!topic` command with all 22 built-in themes.

#### Template format

The templates in `docs/TOPIC_CREATOR.md` use a shorthand where color codes appear as bare numbers (e.g., `4,0`). In actual IRC, each color code must be preceded by `\x03` (ASCII 3). The plugin stores templates as TypeScript string constants with `\x03` escapes embedded.

Example — the **Ember** theme in the doc:
```
4,0%0,4%4,4 5,4%4,5%5,5 1,5%5,1%0,1 $text 5,1%1,5%5,5 4,5%5,4%4,4 0,4%4,0%
```

Becomes this TypeScript string:
```typescript
'\x034,0%\x030,4%\x034,4 \x035,4%\x034,5%\x035,5 \x031,5%\x035,1%\x030,1 $text \x035,1%\x031,5%\x035,5 \x034,5%\x035,4%\x034,4 \x030,4%\x034,0%'
```

The `$text` placeholder is replaced with the user's sanitized input at runtime.

#### Tasks

- [ ] Create `plugins/topic/themes.ts` — map of theme name → IRC-formatted template string (all 22 built-in themes with `\x03` escapes)
- [ ] Create `plugins/topic/config.json` — default config:
  ```json
  {
    "default_theme": "silverscreen"
  }
  ```
- [ ] Create `plugins/topic/index.ts` — plugin skeleton (name, version, description, init, teardown)
- [ ] Implement `!topic <theme> <text>` command:
  - Bind: `api.bind('pub', 'o', '!topic', handler)` — requires `o` flag
  - Parse args: first word is theme name, rest is topic text
  - If no args → reply with usage: `Usage: !topic <theme> <text> | !topic preview <theme> <text>`
  - Look up theme by name (case-insensitive)
  - If theme not found → reply with error and suggest `!topics`
  - Sanitize user text (strip `\r`, `\n`)
  - Replace `$text` in template with sanitized text
  - Send via `api.topic(channel, formatted)`
  - Reply with confirmation
- [ ] Implement `!topic preview <theme> <text>` subcommand:
  - When first arg is `preview`, treat second arg as theme name and rest as text
  - Sends the formatted text as a regular channel message (`api.say()`) instead of setting the topic
  - Lets users preview a theme before committing
- [ ] Implement `!topics` command:
  - Bind: `api.bind('pub', '-', '!topics', handler)` — anyone can list
  - List all available theme names
  - Reply with comma-separated list (keep under IRC line limit)
- [ ] Create `plugins/topic/README.md`

#### Verification
- Load plugin via `.load topic`
- Run `!topics` — should list all 22 theme names
- Run `!topic preview ember Test Topic` — should display formatted text in channel
- Run `!topic ember Test Topic` — should set channel topic with color border
- Run `!topic` with no args — should show usage
- Run `!topic faketheme Hello` — should show error
- Confirm a user without `o` flag gets denied on `!topic` but can use `!topics`

## Config changes

`plugins/topic/config.json`:
```json
{
  "default_theme": "silverscreen"
}
```

`config/plugins.json` override example:
```json
{
  "topic": {
    "enabled": true,
    "channels": ["#lobby", "#main"],
    "config": {
      "default_theme": "ember"
    }
  }
}
```

## Database changes

None.

## Test plan

- **Unit: template substitution** — verify `$text` replacement produces correct output, sanitization strips `\r\n`
- **Unit: theme lookup** — case-insensitive, missing theme returns error
- **Unit: argument parsing** — `!topic ember Hello World` → theme=`ember`, text=`Hello World`; no args → shows usage; `!topic preview ember Hello` → preview mode
- **Integration: bind permissions** — `!topic` requires `o`, `!topics` allows `-`
- **Edge case: topic length** — template + text exceeding typical 390-char limit warns the user
- **API: topic()** — verify `api.topic` is callable and delegates to `IRCCommands.topic()`
