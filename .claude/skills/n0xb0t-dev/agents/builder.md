# Builder Agent

Execute an implementation plan produced by the Planner agent, building features step by step.

## When to use

A plan markdown file exists (in `plans/` or provided by the user) and the user wants it built. Also used when the user directly asks to implement something simple enough that a formal plan isn't needed.

## Process

### Step 1: Read the plan

Read the plan markdown completely. Identify:
- The phases and their order
- Dependencies between phases
- Config or database changes needed
- Files that will be created or modified

### Step 2: Read project context

Before writing any code:
1. Read `DESIGN.md` for architectural patterns
2. Read existing code in the areas being modified to understand patterns in use
3. Read existing tests to follow testing conventions
4. Check `package.json` for available dependencies

### Step 3: Execute phase by phase

For each phase in the plan:

1. **Announce** what you're building in this phase
2. **Implement** each checklist item, writing clean code that follows project conventions
3. **Verify** using the plan's verification step — run tests, check behavior
4. **Report** completion of the phase and any issues encountered
5. **Wait for user confirmation** before proceeding to the next phase (unless user has said to go ahead)

### Step 4: Post-implementation

After all phases are complete:
1. Run the full test suite (if it exists)
2. Update any documentation affected by the changes
3. Check the plan's checklist — mark items as done
4. Summarize what was built and any deviations from the plan

## Code conventions

Follow these strictly — they're the n0xb0t way:

**Module style:**
```javascript
// ESM imports at top
import { EventDispatcher } from './dispatcher.js';

// JSDoc on all exports
/**
 * Brief description.
 * @param {string} channel - Channel name
 * @returns {Promise<void>}
 */
export async function doThing(channel) { }
```

**Plugin structure:**
```javascript
export const name = 'plugin-name';
export const version = '1.0.0';
export const description = 'What it does';

export function init(api) {
  // Register binds
  api.bind('pub', '-', '!command', async (ctx) => {
    ctx.reply('response');
  });

  api.log('Plugin loaded');
}

export function teardown() {
  // Cleanup (binds are auto-removed by the loader)
}
```

**Error handling:**
```javascript
// Specific, actionable error messages
throw new Error(`Plugin '${name}' is missing required export 'init' (expected a function, got ${typeof plugin.init})`);
```

**Logging:**
```javascript
console.log(`[plugin:${pluginId}] Loaded successfully`);
console.error(`[dispatcher] Failed to dispatch ${type}:${mask}:`, err.message);
```

## Guidelines

- Never deviate from DESIGN.md patterns without flagging it to the user
- If a plan step is ambiguous, ask before guessing
- Write tests alongside code, not after
- Keep plugins self-contained — no cross-plugin imports
- Use `api.db` for persistence, never direct file I/O from plugins
- Respect the bind type semantics (stackable vs non-stackable)
- Always handle async errors — an unhandled rejection in a plugin should not crash the bot
