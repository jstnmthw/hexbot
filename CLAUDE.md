# CLAUDE.md — Instructions for Claude Code

This file tells Claude Code how to work on the n0xb0t project.

## Project context

n0xb0t is a modular IRC bot framework for Node.js. Read `DESIGN.md` thoroughly before writing any code — it contains all architectural decisions, agreed-upon patterns, and scope boundaries. Read `docs/SECURITY.md` before writing any code that handles user input, permissions, IRC output, or database operations.

## Key constraints

- **TypeScript with ESM modules** — use `import`/`export`, compile with `tsc` or `tsx` for development
- **irc-framework** is the IRC transport layer — do not reimplement IRC protocol handling
- **better-sqlite3** for database — synchronous reads are intentional and fine for this workload
- **Eggdrop-style bind system** — the event dispatcher uses `bind(type, flags, mask, handler)` exactly as described in the design doc
- **Plugin isolation** — plugins never depend on other plugins, only on core modules via the scoped API
- **Hot-reload** — plugins must be loadable/unloadable/reloadable without restarting the bot process

## Code style

- TypeScript throughout — strict mode enabled in `tsconfig.json`
- ESM output (`type: "module"` in package.json)
- Async/await for all async operations
- Use proper TypeScript types and interfaces for key APIs (plugin API, bind system, context objects, config shapes)
- Descriptive error messages — if a plugin fails to load, say exactly why
- Console logging with `[source]` prefix: `[bot]`, `[dispatcher]`, `[plugin-loader]`, `[plugin-name]`

## File structure

Follow the structure in DESIGN.md section 2.1 exactly, but use `.ts` extensions instead of `.js`. Core modules go in `src/core/`, plugins go in `plugins/<name>/`.

## Build order

Implement in this order (each step should be testable before moving to the next):

1. `src/types.ts` — shared interfaces (HandlerContext, PluginAPI, UserRecord, config shapes)
2. `src/utils/wildcard.ts` — wildcard pattern matching (shared utility)
3. `src/database.ts` — SQLite wrapper (kv + mod_log)
4. `src/dispatcher.ts` — event bind system
5. `src/core/permissions.ts` — flag system with hostmask matching
6. `src/command-handler.ts` — command router (framework only — `.help`)
7. `src/core/commands/permission-commands.ts` — `.adduser`, `.deluser`, `.flags`, `.users`
8. `src/core/commands/dispatcher-commands.ts` — `.binds`
9. `src/event-bus.ts` — typed EventEmitter for internal events
10. `src/irc-bridge.ts` — translates irc-framework events to dispatcher events
11. `src/bot.ts` — thin orchestrator wiring modules together
12. `src/core/commands/irc-commands-admin.ts` — `.say`, `.join`, `.part`, `.status`
13. `src/repl.ts` — attached REPL
14. `src/index.ts` — entry point
15. `src/plugin-loader.ts` — discover, load, unload, reload
16. `src/core/commands/plugin-commands.ts` — `.plugins`, `.load`, `.unload`, `.reload`
17. `src/core/channel-state.ts` — user/mode tracking
18. `src/core/irc-commands.ts` — convenience wrappers (op, kick, ban, etc.)
19. `src/core/services.ts` — NickServ/SASL integration
20. Config files (`config/bot.example.json`, `config/plugins.example.json`)
21. MVP plugins: `chanop`, `greeter`, `seen`, `8ball`

## Security

All IRC input is untrusted. Follow `docs/SECURITY.md` for the full guide. Key rules:

- Strip `\r` and `\n` from any user input before passing to `raw()` or interpolating into IRC strings
- Use `irc-framework`'s typed methods (`say`, `notice`, `mode`) instead of `raw()` wherever possible
- Always use parameterized database queries — never concatenate user input into SQL
- Check permissions before every privileged action — the dispatcher handles this for bind handlers
- Await NickServ ACC verification before granting ops when `require_acc_for` is configured
- Wrap plugin handlers in try/catch — one plugin's error must not crash the bot or block other handlers
- Never log passwords, SASL credentials, or NickServ passwords
- Warn on insecure hostmask patterns (`nick!*@*`) for privileged users

## Testing

- **Vitest** is the test framework — use `describe`/`it`/`expect` from `vitest`
- `pnpm test` runs the full suite (`vitest run`), `pnpm test:watch` for watch mode
- Each module has a corresponding test file — see phase docs for test specifications
- Use `:memory:` SQLite databases in tests
- Mock the IRC client (see `tests/helpers/mock-irc.ts`) — no real network in automated tests
- For manual testing, use a local ngIRCd or InspIRCd instance, or connect to a test channel on Libera Chat
- Structure code for testability: pure functions, dependency injection for the IRC client
