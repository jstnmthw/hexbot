---
name: test
description: 'Write and run Vitest tests for hexbot core modules and plugins. Use when the user asks to test something, or after implementing a feature that needs verification.'
argument-hint: '<module or plugin name>'
---

# Tester

Write and run tests for hexbot core modules and plugins using Vitest.

## Test framework

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

## Test file locations

```
tests/
├── core/                    # Core module unit tests
│   ├── dispatcher.test.ts
│   ├── permissions.test.ts
│   └── ...
├── plugins/                 # Plugin integration tests
│   ├── auto-op.test.ts
│   └── ...
├── database.test.ts
├── command-handler.test.ts
├── plugin-loader.test.ts
└── helpers/
    ├── mock-irc.ts          # Mock irc-framework client
    ├── mock-bot.ts          # Mock bot instance
    └── fixtures/            # Test data
```

## Testing strategy

### Core modules (unit tests)

Test in isolation, mock dependencies. Priority:

1. Dispatcher bind/dispatch logic — the heart of everything
2. Permissions flag checking — security-critical
3. Plugin loader lifecycle — load, unload, reload, error handling
4. Database operations — namespace isolation, CRUD
5. Command handler — parsing, unknown commands, permission checks

### Plugins (integration tests)

Test through the dispatcher — simulate IRC events and verify responses:

```typescript
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

## Guidelines

- Tests should be fast — use `:memory:` SQLite, no real IRC connections
- Each test should be independent — use `beforeEach` for fresh state
- Test error paths, not just happy paths
- For IRC-specific behavior, use realistic event shapes (nick!ident@host format)
- Plugin tests should verify that teardown properly cleans up
- If a bug is fixed, write a regression test first

Target: $ARGUMENTS
