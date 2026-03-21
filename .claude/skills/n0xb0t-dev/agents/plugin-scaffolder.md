# Plugin Scaffolder Agent

Generate complete plugin skeletons for the n0xb0t framework.

## When to use

The user wants to create a new plugin. This agent generates the full directory structure with working boilerplate, then hands off to the Builder if implementation is needed.

## Process

### Step 1: Understand the plugin

Ask (or infer from context):
1. What does the plugin do?
2. What IRC events does it need to react to? (channel messages, joins, timers, etc.)
3. Does it need persistent storage?
4. Does it need configurable settings?
5. What commands will users type?

### Step 2: Generate the scaffold

Create the plugin directory with all files:

```
plugins/<plugin-name>/
├── index.js        # Main plugin file with init/teardown
├── config.json     # Default configuration
├── README.md       # Usage documentation
```

Also create:
```
tests/plugins/<plugin-name>.test.js   # Test file
```

### Templates

**index.js:**
```javascript
/**
 * <Plugin Name> — <brief description>
 *
 * Commands:
 *   !command — what it does
 *
 * Binds:
 *   <type> <flags> <mask> — description
 */

export const name = '<plugin-name>';
export const description = '<description>';
export const version = '1.0.0';

let bot;

export function init(api) {
  bot = api;

  api.bind('<type>', '<flags>', '<mask>', async (ctx) => {
    // TODO: implement
    ctx.reply('Not yet implemented');
  });

  api.log(`${name} loaded`);
}

export function teardown() {
  // Clean up any timers, connections, or state
  // Note: binds are automatically removed by the plugin loader
  bot?.log(`${name} unloaded`);
  bot = null;
}
```

**config.json:**
```json
{
  "_comment": "<plugin-name> default configuration",
  "_docs": "Override these values in config/plugins.json under '<plugin-name>.config'"
}
```

**README.md:**
```markdown
# <Plugin Name>

<description>

## Commands

| Command | Flags | Description |
|---------|-------|-------------|
| `!command` | `-` | What it does |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `key` | `value` | What it controls |

## Examples

```
<user> !command arg
<n0xb0t> response
```
```

**test file:**
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
// import { createMockBot } from '../helpers/mock-bot.ts';

describe('<plugin-name> plugin', () => {
  // let bot: any, messages: string[];

  // beforeEach(async () => {
  //   ({ bot, messages } = await createMockBot());
  //   await bot.pluginLoader.load('./plugins/<plugin-name>/index.ts');
  // });

  it('should have a name export', async () => {
    const plugin = await import('../../plugins/<plugin-name>/index.ts');
    expect(plugin.name).toBe('<plugin-name>');
  });

  it('should have an init function', async () => {
    const plugin = await import('../../plugins/<plugin-name>/index.ts');
    expect(typeof plugin.init).toBe('function');
  });

  // TODO: add functional tests once mock-bot helper exists
});
```

### Step 3: Wire into config

Add an entry to `config/plugins.example.json` (or tell the user to add one):

```json
{
  "<plugin-name>": {
    "enabled": true,
    "channels": ["#relevant-channel"]
  }
}
```

### Step 4: Report

Show the user what was generated and suggest next steps (implement the TODO in init, write more tests, etc.).

## Bind type selection guide

Help the user choose the right bind types:

| Plugin wants to... | Bind type | Example mask |
|---------------------|-----------|-------------|
| Respond to a specific command | `pub` | `!mycommand` |
| React to any message containing a pattern | `pubm` | `* *badword*` |
| React to a private message command | `msg` | `!help` |
| Do something when users join | `join` | `*` or `#specific *` |
| Do something on a timer | `time` | `"60"` (seconds) |
| React to mode changes (op/deop) | `mode` | `* +o` |
| Handle raw server messages | `raw` | `"001"` (RPL_WELCOME) |
| Respond to CTCP | `ctcp` | `VERSION` |
