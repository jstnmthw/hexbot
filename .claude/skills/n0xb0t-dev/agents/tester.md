# Tester Agent

Write and run tests for n0xb0t core modules and plugins.

## When to use

The user asks to test something, or the Builder agent needs verification after implementing a phase. Also used proactively when code coverage gaps are identified.

## Test framework

Use Vitest. Import `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi` from `vitest`.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
```

## Test file locations

```
tests/
├── core/
│   ├── dispatcher.test.ts
│   ├── permissions.test.ts
│   ├── services.test.ts
│   ├── irc-commands.test.ts
│   └── channel-state.test.ts
├── plugins/
│   ├── auto-op.test.ts
│   ├── greeter.test.ts
│   ├── seen.test.ts
│   └── 8ball.test.ts
├── plugin-loader.test.ts
├── command-handler.test.ts
├── database.test.ts
└── helpers/
    ├── mock-irc.ts          # Mock irc-framework client
    ├── mock-bot.ts           # Mock bot instance with dispatcher + db
    └── fixtures/             # Test data
```

## Testing strategy by layer

### Core modules (unit tests)

Test in isolation. Mock dependencies.

**Dispatcher tests:**
- Bind and unbind work correctly
- Stackable vs non-stackable behavior
- Wildcard mask matching
- Flag checking (with mock permissions)
- Timer binds fire and clean up
- `unbindAll` removes only the specified plugin's binds
- Handler errors are caught and don't crash the dispatch loop

**Permissions tests:**
- Flag checking: global flags, per-channel overrides, owner implies all
- Hostmask matching with wildcards
- User add/remove/update
- Database persistence and loading

**Services tests:**
- NickServ ACC query and response parsing (mock the IRC client)
- SASL configuration
- Different services types (atheme, anope, dalnet)

### Plugins (integration tests)

Test through the dispatcher — simulate IRC events and verify the plugin's response.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockBot } from '../helpers/mock-bot.ts';

describe('greeter plugin', () => {
  let bot: any, messages: string[];

  beforeEach(async () => {
    ({ bot, messages } = await createMockBot());
    await bot.pluginLoader.load('./plugins/greeter/index.ts');
  });

  it('greets users on join', async () => {
    await bot.dispatcher.dispatch('join', {
      nick: 'TestUser',
      channel: '#test',
      ident: 'test',
      hostname: 'test.host',
      reply: (msg: string) => messages.push(msg),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Welcome.*TestUser/);
  });
});
```

### Mock helpers

**mock-irc.ts** — Simulates an irc-framework client:
- Captures outgoing messages (say, notice, action, raw)
- Can simulate incoming events
- Tracks join/part/mode calls

**mock-bot.ts** — Creates a minimal bot instance:
- Real dispatcher, real database (in-memory SQLite or temp file)
- Real plugin loader
- Mock IRC client (from mock-irc.ts)
- Returns `{ bot, messages, events }` for easy assertion

## Running tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm vitest run tests/core/dispatcher.test.ts

# Watch mode (re-runs on file change)
pnpm test:watch

# Run with verbose output
pnpm vitest run --reporter=verbose
```

## What to test (priority order)

1. **Dispatcher bind/dispatch logic** — this is the heart of everything
2. **Permissions flag checking** — security-critical
3. **Plugin loader lifecycle** — load, unload, reload, error handling
4. **Each plugin's core commands** — simulate events, check responses
5. **Database operations** — namespace isolation, CRUD
6. **Command handler** — parsing, unknown commands, permission checks
7. **Edge cases** — empty messages, unicode, very long text, malformed IRC events

## Guidelines

- Tests should be fast — use in-memory database, no real IRC connections
- Each test should be independent — use beforeEach to set up fresh state
- Test error paths, not just happy paths
- For IRC-specific behavior, test with realistic event shapes (nick!ident@host format, etc.)
- Plugin tests should verify that teardown properly cleans up
- If a bug is fixed, write a regression test first, then fix the bug
