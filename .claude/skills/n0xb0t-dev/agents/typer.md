# Typer Agent

Add JSDoc type annotations to existing code and generate TypeScript declaration files for the plugin API.

## When to use

The user wants better IDE autocompletion, type safety, or documentation for the n0xb0t API. Especially important for the plugin API surface — plugin authors should get full IntelliSense when using `api.bind()`, `api.db.get()`, etc.

## Process

### Step 1: Identify targets

Determine what needs typing:
- **Plugin API** (`api` object passed to `init()`) — highest priority
- **Event context** (`ctx` objects passed to handlers) — high priority
- **Core module interfaces** — medium priority
- **Internal implementation details** — low priority

### Step 2: Read existing code

Read the source files to understand the actual shapes of objects, function signatures, and return types. Don't guess — trace through the code.

### Step 3: Add JSDoc annotations

For `.js` files, add JSDoc comments with full type information:

```javascript
/**
 * Register an event handler.
 * @param {'pub'|'pubm'|'msg'|'msgm'|'join'|'part'|'kick'|'nick'|'mode'|'raw'|'time'|'ctcp'|'notice'} type - Bind type
 * @param {string} flags - Required user flags ('-' for none, '+o' for ops, '+n' for owner)
 * @param {string} mask - Command or pattern to match (supports * and ? wildcards)
 * @param {(ctx: EventContext) => Promise<void|number>} handler - Event handler
 * @returns {BindEntry}
 */
bind(type, flags, mask, handler) { }
```

### Step 4: Generate .d.ts files (if requested)

Create TypeScript declaration files in `types/`:

```
types/
├── index.d.ts          # Main exports
├── plugin-api.d.ts     # The api object plugins receive
├── events.d.ts         # Event context types per bind type
└── config.d.ts         # Config file shapes
```

Key types to define:

```typescript
// types/plugin-api.d.ts
export interface PluginAPI {
  readonly pluginId: string;
  bind(type: BindType, flags: string, mask: string, handler: EventHandler): BindEntry;
  unbind(type: BindType, mask: string, handler: EventHandler): boolean;
  say(target: string, message: string): void;
  action(target: string, message: string): void;
  notice(target: string, message: string): void;
  raw(line: string): void;
  getChannel(name: string): ChannelInfo | undefined;
  getUsers(channel: string): UserInfo[];
  getServerSupports(): ServerSupports;
  readonly db: PluginDB | null;
  readonly config: Record<string, unknown>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

## Guidelines

- Type the public API surface thoroughly, internals can be lighter
- Use union types for bind types, not just `string`
- Document each field in context objects — plugin authors need this
- Use `@example` tags for complex functions
- Keep .d.ts files in sync with actual implementation
- Don't add types that restrict flexibility the design intentionally allows
