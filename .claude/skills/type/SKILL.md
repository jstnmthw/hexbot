---
name: type
description: 'Add TypeScript type annotations and generate declaration files for the n0xb0t plugin API. Use when the user wants better IDE autocompletion or type safety.'
argument-hint: '<files>'
---

# Typer

Add TypeScript type annotations and generate declaration files for the plugin API.

## Priority targets

1. **Plugin API** (`api` object passed to `init()`) — highest priority
2. **Event context** (`ctx` objects passed to handlers) — high priority
3. **Core module interfaces** — medium priority
4. **Internal implementation** — low priority

## Process

1. Read the source files to understand actual shapes (don't guess — trace through code)
2. Add/update TypeScript types and interfaces in `src/types.ts`
3. Generate `.d.ts` files in `types/` if requested:

```
types/
├── index.d.ts          # Main exports
├── plugin-api.d.ts     # The api object plugins receive
├── events.d.ts         # Event context types per bind type
└── config.d.ts         # Config file shapes
```

## Guidelines

- Type the public API surface thoroughly, internals can be lighter
- Use union types for bind types, not just `string`
- Document each field in context objects — plugin authors need this
- Use `@example` tags for complex functions
- Keep `.d.ts` files in sync with actual implementation
- Don't add types that restrict flexibility the design intentionally allows

Target: $ARGUMENTS
