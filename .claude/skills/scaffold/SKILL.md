---
name: scaffold
description: 'Generate a complete n0xb0t plugin skeleton with index.ts, config.json, README.md, and test file. Use when the user wants to create a new plugin.'
argument-hint: '<plugin-name>'
---

# Plugin Scaffolder

Generate complete plugin skeletons for the n0xb0t framework.

## Process

### Step 1: Understand the plugin

Ask (or infer from context):

1. What does the plugin do?
2. What IRC events does it react to? (channel messages, joins, timers, etc.)
3. Does it need persistent storage?
4. Does it need configurable settings?
5. What commands will users type?

### Step 2: Generate the scaffold

Create the plugin directory with all files:

```
plugins/<plugin-name>/
├── index.ts        # Main plugin file with init/teardown
├── config.json     # Default configuration
└── README.md       # Usage documentation
```

Also create: `tests/plugins/<plugin-name>.test.ts`

**index.ts template:**

```typescript
import type { HandlerContext, PluginAPI } from '../../src/types.ts';

export const name = '<plugin-name>';
export const description = '<description>';
export const version = '1.0.0';

let api: PluginAPI;

export function init(_api: PluginAPI) {
  api = _api;

  api.bind('<type>', '<flags>', '<mask>', async (ctx: HandlerContext) => {
    // TODO: implement
    ctx.reply('Not yet implemented');
  });

  api.log(`${name} loaded`);
}

export function teardown() {
  // Clean up timers, connections, or state
  // Binds are automatically removed by the plugin loader
  api = null!;
}
```

### Step 3: Wire into config

Add an entry to `config/plugins.example.json`.

### Step 4: Report

Show the user what was generated and suggest next steps.

## Bind type selection guide

| Plugin wants to...                      | Bind type | Example mask         |
| --------------------------------------- | --------- | -------------------- |
| Respond to a specific command           | `pub`     | `!mycommand`         |
| React to any message matching a pattern | `pubm`    | `* *badword*`        |
| React to a private message command      | `msg`     | `!help`              |
| Do something when users join            | `join`    | `*` or `#specific *` |
| Do something on a timer                 | `time`    | `"60"` (seconds)     |
| React to mode changes (op/deop)         | `mode`    | `* +o`               |
| Handle raw server messages              | `raw`     | `"001"`              |
| Respond to CTCP                         | `ctcp`    | `VERSION`            |

Target: $ARGUMENTS
