---
name: n0xb0t-dev
description: "Development orchestrator for the n0xb0t IRC bot framework. Use this skill for ANY work on the n0xb0t project including: planning new features or plugins, reviewing feasibility of changes, executing implementation plans, writing or running tests, adding TypeScript types, debugging issues, refactoring code, reviewing PRs, generating documentation, reasoning through architectural decisions, and managing the project backlog. Trigger whenever the user mentions n0xb0t, IRC bot, plugins, bind system, or references any component from the n0xb0t design document. Also trigger when the user asks to 'plan', 'build', 'test', 'review', 'type', 'refactor', 'debug', or 'document' anything in the project — even if they don't say 'n0xb0t' explicitly, if the working directory is the n0xb0t repo."
---

# n0xb0t Development Orchestrator

A skill for developing the n0xb0t IRC bot framework. It provides specialized agents and slash commands that accelerate every phase of development — from planning a feature to shipping it tested and typed.

## How this skill works

This skill provides **agents** (specialized roles Claude can adopt) and **commands** (shortcuts the user can invoke). The agents are defined in the `agents/` directory. The project's architectural decisions live in `DESIGN.md` at the repo root — always read it before making architectural suggestions.

When the user asks to do something on the n0xb0t project, figure out which agent(s) are needed and adopt that role. If the task spans multiple agents (e.g., "plan and build a flood detection plugin"), execute them in sequence — plan first, confirm with the user, then build.

## Quick reference: slash commands

All commands are namespaced with `n0x:` to avoid conflicts with built-in Claude Code commands (`/plan`, `/debug`, `/review`, `/status`, `/plugin` are all taken).

| Command | Agent | What it does |
|---------|-------|-------------|
| `/n0x:plan <feature>` | Planner | Analyze feasibility, produce phased checklist markdown |
| `/n0x:build <plan.md>` | Builder | Execute an implementation plan step by step |
| `/n0x:test <target>` | Tester | Write and run tests for a module or plugin |
| `/n0x:review <files>` | Reviewer | Code review with n0xb0t conventions in mind |
| `/n0x:type <files>` | Typer | Add JSDoc types or generate .d.ts files |
| `/n0x:debug <issue>` | Debugger | Investigate and fix a bug |
| `/n0x:refactor <target>` | Refactorer | Improve code without changing behavior |
| `/n0x:doc <target>` | Documenter | Generate or update docs (README, API docs, plugin guides) |
| `/n0x:reason <question>` | Reasoner | Think through an architectural or design question |
| `/n0x:scaffold <name>` | Plugin Scaffolder | Generate a new plugin skeleton with config, README, tests |
| `/n0x:status` | Project Manager | Scan codebase, report what's implemented vs DESIGN.md |
| `/n0x:deps` | Dependency Checker | Audit dependencies, check for updates and vulnerabilities |
| `/n0x:migrate <description>` | Migrator | Plan and execute a database schema or config migration |
| `/n0x:security <target>` | Security Auditor | Audit code for IRC/bot security issues, produce findings report |

## Agent dispatch

When the user's request doesn't use a slash command, infer the right agent from context:

- Talking about a feature that doesn't exist yet → **Planner**
- Asking to implement something with a plan already made → **Builder**
- Asking "why is X broken" or "this doesn't work" → **Debugger**
- Asking "is this a good idea" or "how should we handle X" → **Reasoner**
- Asking to add a new plugin → **Plugin Scaffolder** then **Builder**
- Asking to improve code quality → **Reviewer** or **Refactorer**
- Asking about project progress → **Project Manager**
- Asking about security, vulnerabilities, or hardening → **Security Auditor**

## Agents

Read the full agent instructions from the `agents/` directory before adopting a role. Here's a summary:

### Planner (`agents/planner.md`)
Analyzes feature feasibility against the current codebase. Produces a structured markdown plan with phased checklist. Always reads DESIGN.md and scans the current code before producing a plan. Output is a `plans/<feature-name>.md` file the Builder can execute.

### Builder (`agents/builder.md`)
Executes implementation plans step by step. Reads the plan markdown, then implements each phase in order. After each phase, runs any existing tests and reports status. Commits to the patterns established in DESIGN.md — Eggdrop-style binds, scoped plugin API, ESM modules, etc.

### Tester (`agents/tester.md`)
Writes and runs tests. For core modules, writes unit tests. For plugins, writes integration tests that simulate IRC events through the dispatcher. For the full bot, writes end-to-end tests against a mock IRC server. Uses Vitest.

### Reviewer (`agents/reviewer.md`)
Reviews code against n0xb0t conventions: ESM patterns, bind system usage, plugin API compliance, error handling, flood protection awareness, config schema consistency. Flags security issues specific to IRC bots (hostmask spoofing, NickServ race conditions, command injection via IRC messages).

### Typer (`agents/typer.md`)
Adds JSDoc type annotations to existing code or generates TypeScript declaration files (.d.ts). Focuses on the plugin API surface — making sure plugin authors get autocompletion and type checking.

### Debugger (`agents/debugger.md`)
Investigates bugs. Reads error output, traces through the dispatcher/plugin-loader/bot code, identifies root cause. Aware of common IRC bot failure modes: socket disconnects, encoding issues, mode parsing edge cases, race conditions in NickServ verification.

### Reasoner (`agents/reasoner.md`)
Thinks through architectural decisions. References DESIGN.md and Eggdrop's patterns. Produces a structured analysis with options, trade-offs, and a recommendation. Doesn't write code — just thinks.

### Plugin Scaffolder (`agents/plugin-scaffolder.md`)
Generates a complete plugin skeleton: `index.ts` with init/teardown, `config.json` with defaults, `README.md` with usage docs, and a test file. Wires up appropriate bind types based on what the plugin does.

### Documenter (`agents/documenter.md`)
Generates or updates documentation. For plugins: README with commands, config options, examples. For core modules: API reference. For the project: updates DESIGN.md, CHANGELOG, README.

### Refactorer (`agents/refactorer.md`)
Improves code without changing behavior. Identifies code smells, extracts shared utilities, improves naming, reduces complexity. Always runs tests before and after to prove behavior is preserved.

### Project Manager (`agents/project-manager.md`)
Scans the codebase and compares it to DESIGN.md. Reports what's implemented, what's missing, what's partially done. Useful for getting a snapshot of project health and deciding what to work on next.

### Dependency Checker (`agents/deps-checker.md`)
Audits `package.json` dependencies. Checks for outdated packages, known vulnerabilities, unused dependencies, and missing dependencies. Suggests updates with risk assessment.

### Migrator (`agents/migrator.md`)
Plans and executes migrations — database schema changes, config format changes, plugin API changes. Produces a migration script and rollback plan.

### Security Auditor (`agents/security-auditor.md`)
Audits code for IRC-specific and general bot security issues. Reads `docs/SECURITY.md` as its baseline, then scans the target code for violations. Produces a structured findings report in `docs/audits/` with severity ratings, affected files, and remediation steps. Covers: input validation, newline/protocol injection, permission bypasses, NickServ race conditions, plugin isolation, credential exposure, flood vectors, and insecure hostmask patterns.

## Project conventions

These apply across all agents:

- **ESM only** — `import`/`export`, never `require`
- **Async/await** for all async operations
- **JSDoc comments** on all exported functions and public interfaces
- **Console logging** with `[source]` prefix: `[bot]`, `[dispatcher]`, `[plugin:name]`
- **Error messages** must be specific and actionable
- **Bind types** follow Eggdrop conventions exactly (see DESIGN.md section 2.3)
- **Plugin API** is the only interface between plugins and core (see DESIGN.md section 2.4)
- **Config resolution**: plugins.json overrides > plugin config.json defaults
- **Database namespacing**: plugins use `api.db`, core modules use `_` prefixed namespaces
- **Test runner**: Vitest (`describe`/`it`/`expect` from `vitest`)

## Context loading

Before any agent does work, it should:

1. Read `DESIGN.md` if it hasn't been read in this session
2. Read the relevant source files for the area being worked on
3. Check `config/bot.example.json` and `config/plugins.example.json` for current config schema
4. Check existing tests in `tests/` for patterns to follow

## Output conventions

- Plans go in `plans/<feature-name>.md`
- Tests go in `tests/<module-name>.test.ts` or `tests/plugins/<plugin-name>.test.ts`
- Generated docs go alongside the code they document
- Type declarations go in `types/` at project root
