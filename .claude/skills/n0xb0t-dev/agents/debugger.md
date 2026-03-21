# Debugger Agent

Investigate and fix bugs in n0xb0t.

## When to use

Something is broken — the bot won't connect, a plugin isn't responding, events aren't dispatching, permissions aren't working, etc.

## Process

### Step 1: Reproduce and understand

Get the error output, stack trace, or behavioral description. Ask the user for:
- What they expected to happen
- What actually happened
- Any error messages or logs
- Whether this worked before and what changed

### Step 2: Trace the issue

Read the relevant source code, following the execution path:

**Common paths to trace:**

- **Bot won't connect**: `index.js` → `bot.js` → `_connect()` → irc-framework config → SASL/services
- **Plugin won't load**: `plugin-loader.js` → `load()` → dynamic import → plugin's `init()`
- **Command not responding**: `bot.js` message handler → dispatcher → mask matching → flag checking → handler
- **Permission denied unexpectedly**: `dispatcher._checkFlags()` → `permissions.checkFlags()` → hostmask matching
- **Database errors**: `database.js` → SQLite statements → namespace check
- **Hot reload broken**: `plugin-loader.js` → `reload()` → `unload()` teardown → `unbindAll()` → re-import

### Step 3: Identify root cause

Common IRC bot failure modes:

- **Socket disconnect without reconnect**: irc-framework's `auto_reconnect` not configured, or the error handler is swallowing the reconnect
- **Encoding issues**: Non-UTF8 text from IRC causing string operations to fail
- **Mode parsing**: Unexpected mode format from a specific ircd
- **NickServ timing**: Bot tries to op a user before NickServ ACC response arrives (async race)
- **Plugin state leak**: Plugin's `teardown()` didn't clean up a timer or state variable, so after reload there are duplicates
- **Bind mask mismatch**: The mask doesn't match what you think it matches — check case sensitivity, wildcard behavior
- **ESM cache**: Dynamic import cache not busted properly on reload

### Step 4: Fix and verify

Write the fix. If a test doesn't exist for this failure mode, write a regression test first, then apply the fix. Run the test suite to confirm the fix doesn't break anything else.

## Debugging toolkit

```bash
# Run bot with verbose logging
NODE_DEBUG=* node src/index.js --repl

# Run a single test
pnpm vitest run tests/core/dispatcher.test.ts

# Check if a module imports cleanly
node -e "import('./src/dispatcher.js').then(m => console.log(Object.keys(m)))"

# Test IRC connection manually
node -e "
import IRC from 'irc-framework';
const c = new IRC.Client();
c.connect({ host: 'irc.libera.chat', port: 6697, tls: true, nick: 'n0xtest' });
c.on('registered', () => console.log('Connected'));
c.on('error', (e) => console.error('Error:', e));
"
```

## Guidelines

- Always reproduce before fixing — understand the exact failure
- Write the regression test before the fix when possible
- Check if the same bug could exist in similar code paths
- If the fix changes the plugin API, check that existing plugins still work
- For IRC protocol issues, test on multiple networks if possible
