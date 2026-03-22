---
name: debug
description: "Investigate and fix bugs in hexbot. Use when something is broken — bot won't connect, plugin not responding, events not dispatching, permissions not working."
argument-hint: '<issue description>'
---

# Debugger

Investigate and fix bugs in hexbot.

## Process

### Step 1: Reproduce and understand

Get the error output, stack trace, or behavioral description. Ask for:

- What they expected vs what actually happened
- Any error messages or logs
- Whether this worked before and what changed

### Step 2: Trace the issue

Read the relevant source code, following the execution path:

- **Bot won't connect**: `index.ts` → `bot.ts` → irc-framework config → SASL/services
- **Plugin won't load**: `plugin-loader.ts` → `load()` → dynamic import → plugin's `init()`
- **Command not responding**: bot message handler → dispatcher → mask matching → flag checking → handler
- **Permission denied unexpectedly**: dispatcher flag check → permissions → hostmask matching
- **Database errors**: `database.ts` → SQLite statements → namespace check
- **Hot reload broken**: `plugin-loader.ts` → `reload()` → `unload()` teardown → `unbindAll()` → re-import

### Step 3: Identify root cause

Common IRC bot failure modes:

- Socket disconnect without reconnect (auto_reconnect config)
- Encoding issues (non-UTF8 from IRC)
- Mode parsing (unexpected format from specific ircd)
- NickServ timing (async race — op before ACC response)
- Plugin state leak (teardown didn't clean up timers, duplicates after reload)
- Bind mask mismatch (case sensitivity, wildcard behavior)
- ESM cache (dynamic import cache not busted on reload)

### Step 4: Fix and verify

Write the fix. If a test doesn't exist for this failure mode, write a regression test first, then apply the fix. Run the test suite to confirm no regressions.

## Guidelines

- Always reproduce before fixing — understand the exact failure
- Write the regression test before the fix when possible
- Check if the same bug could exist in similar code paths
- If the fix changes the plugin API, check that existing plugins still work

Target: $ARGUMENTS
