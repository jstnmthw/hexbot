---
name: dev
description: 'hexbot project conventions and context. Auto-loads when working in this repo to provide coding standards, IRC bot patterns, and architectural context from DESIGN.md.'
user-invocable: false
---

# hexbot Project Conventions

These conventions apply to ALL work on this project. Read `DESIGN.md` at the repo root for full architectural decisions.

## Context loading

Before doing any work, read:

1. `DESIGN.md` — architectural decisions and patterns
2. The relevant source files for the area being worked on
3. `config/bot.example.json` and `config/plugins.example.json` for current config schema
4. Existing tests in `tests/` for patterns to follow
5. `docs/SECURITY.md` before writing any code that handles user input, permissions, IRC output, or database operations

## Code conventions

- **ESM only** — `import`/`export`, never `require`
- **TypeScript strict mode** — use proper types and interfaces
- **Async/await** for all async operations
- **Console logging** with `[source]` prefix: `[bot]`, `[dispatcher]`, `[plugin:name]`
- **Error messages** must be specific and actionable
- **Bind types** follow Eggdrop conventions exactly (see DESIGN.md section 2.3)
- **Plugin API** is the only interface between plugins and core (see DESIGN.md section 2.4)
- **Config resolution**: plugins.json overrides > plugin config.json defaults
- **Database namespacing**: plugins use `api.db`, core modules use `_` prefixed namespaces
- **Test runner**: Vitest (`describe`/`it`/`expect` from `vitest`)

## Output conventions

- Plans go in `docs/plans/<feature-name>.md`
- Tests go in `tests/<module-name>.test.ts` or `tests/plugins/<plugin-name>.test.ts`
- Generated docs go alongside the code they document
- Type declarations go in `types/` at project root
- Security audit reports go in `docs/audits/`

## IRC reference

See [irc-patterns.md](references/irc-patterns.md) for IRC protocol gotchas, common patterns, and things that trip up bot developers.
