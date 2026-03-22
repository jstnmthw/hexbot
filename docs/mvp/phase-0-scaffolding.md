# Plan: Phase 0 — Project Scaffolding

## Summary

Set up the hexbot project directory structure, install dependencies, configure tooling, and put all design documents in place. At the end of this phase, `pnpm install` succeeds and the project is ready for development. No functional code yet — just the skeleton.

## Phase goal

A clean, properly structured project that any developer can clone, run `pnpm install`, and be ready to start building.

---

## Checklist

### 0.1: Initialize the project

- [x] Create the project root directory `hexbot/`
- [x] Run `pnpm init` or create `package.json` manually with:
  - `"name": "hexbot"`
  - `"version": "0.1.0"`
  - `"type": "module"` (ESM)
  - `"description": "Modular IRC bot framework with Eggdrop-style bind system"`
  - `"main": "src/index.ts"`
  - `"scripts"`:
    - `"start": "tsx src/index.ts"`
    - `"dev": "tsx src/index.ts --repl"`
    - `"test": "vitest run"`
    - `"test:watch": "vitest"`
  - `"engines": { "node": ">=20.0.0" }`
  - `"license": "GPL-2.0"`
- [x] Install production dependencies: `pnpm add irc-framework better-sqlite3`
- [x] Install dev dependencies: `pnpm add -D typescript tsx vitest @types/better-sqlite3 @types/node`
- [x] Verify `pnpm install` completes without errors

### 0.2: Create directory structure

- [x] Create all directories:

```
hexbot/
├── src/
│   └── core/
├── config/
├── plugins/
│   ├── auto-op/
│   ├── greeter/
│   ├── seen/
│   └── 8ball/
├── tests/
│   ├── core/
│   ├── plugins/
│   └── helpers/
├── data/               # SQLite DB will live here (gitignored)
├── docs/
│   ├── plans/
└── types/
```

### 0.3: Config examples

- [x] Create `config/bot.example.json`:

```json
{
  "irc": {
    "host": "irc.libera.chat",
    "port": 6697,
    "tls": true,
    "nick": "hexbot",
    "username": "hexbot",
    "realname": "hexbot IRC Framework",
    "channels": ["#hexbot-test"]
  },
  "owner": {
    "handle": "admin",
    "hostmask": "*!yourident@your.host.here"
  },
  "identity": {
    "method": "hostmask",
    "require_acc_for": ["+o", "+n"]
  },
  "services": {
    "type": "atheme",
    "nickserv": "NickServ",
    "password": "",
    "sasl": true
  },
  "database": "./data/hexbot.db",
  "pluginDir": "./plugins",
  "logging": {
    "level": "info",
    "mod_actions": true
  }
}
```

- [x] Create `config/plugins.example.json`:

```json
{
  "auto-op": {
    "enabled": true,
    "channels": ["#hexbot-test"]
  },
  "greeter": {
    "enabled": true,
    "channels": ["#hexbot-test"],
    "config": {
      "message": "Welcome to {channel}, {nick}!"
    }
  },
  "seen": {
    "enabled": true
  },
  "8ball": {
    "enabled": true
  }
}
```

### 0.4: Gitignore and project files

- [x] Create `.gitignore`:

```
node_modules/
data/
config/bot.json
config/plugins.json
*.db
*.db-journal
*.db-wal
.DS_Store
```

- [x] Copy `DESIGN.md` into the project root
- [x] Copy `CLAUDE.md` into the project root
- [ ] Create `README.md` with:
  - Project name and one-line description
  - "Under construction" note
  - Quick start placeholder (will be filled in as phases complete)
  - Link to DESIGN.md for architecture details
  - License (GPL-2.0)

### 0.5: Core type definitions

- [x] Create `src/types.ts` with the shared interfaces referenced by DESIGN.md:
  - `HandlerContext` — the context object passed to every bind handler
  - `PluginAPI` — the scoped API object plugins receive in `init()`
  - `PluginExports` — what a plugin module must export (`name`, `version`, `description`, `init`, `teardown?`)
  - `UserRecord` — shape for permission user records
  - `BotConfig` — shape for `config/bot.json`
  - `PluginConfig` — shape for `config/plugins.json` entries
  - These are type-only definitions (interfaces/types) — no runtime code

### 0.6: Stub entry point

- [x] Create `src/index.ts` with a minimal placeholder:

```typescript
// hexbot — Modular IRC bot framework
// This is a placeholder. Real implementation starts in Phase 1.

console.log('[hexbot] Phase 0 scaffolding complete. Nothing to run yet.');
console.log('[hexbot] Run "pnpm test" to verify the project is set up correctly.');
process.exit(0);
```

### 0.7: Verify everything

- [x] `pnpm install` succeeds
- [x] `pnpm start` runs the stub and exits cleanly
- [x] `pnpm test` runs (will report 0 tests, but no errors)
- [x] Directory structure matches what's listed above
- [x] Config examples are valid JSON (no syntax errors)
- [x] `.gitignore` correctly ignores `data/`, `config/bot.json`, `config/plugins.json`, `node_modules/`
- [x] `git init && git add . && git status` shows only the files you expect

---

## Verification

**This phase is complete when:**

1. `pnpm install` exits with code 0
2. `pnpm start` prints the stub message and exits with code 0
3. `pnpm test` exits with code 0 (no tests found is fine)
4. The directory structure exists as specified
5. Both example config files parse as valid JSON
6. The project is ready for `git init` with a clean `.gitignore`

## Next phase

Phase 1: Database + Dispatcher — the two foundational modules that everything else depends on.
