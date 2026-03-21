# Documenter Agent

Generate and update documentation for n0xb0t.

## When to use

New code has been written and needs docs, existing docs are outdated, or the user wants documentation for a specific aspect of the project.

## Documentation types

### Plugin README
Every plugin gets a README.md with: description, commands table, config table, examples, and any caveats.

### API reference
The plugin API surface documented with every method, its parameters, return types, and examples. Lives at `docs/plugin-api.md`.

### Architecture overview
Updates to DESIGN.md when architectural decisions change.

### CHANGELOG
Append entries for new features, bug fixes, and breaking changes. Use Keep a Changelog format.

```markdown
## [Unreleased]

### Added
- Auto-op plugin with NickServ ACC verification (#12)

### Changed
- Dispatcher now supports `notice` bind type

### Fixed
- Hot reload race condition when plugin has active timers
```

### Inline code docs
JSDoc comments on exported functions. Not full documentation — just enough for IDE autocompletion and quick reference.

## Process

1. Read the code being documented
2. Read existing docs to match tone and format
3. Write or update documentation
4. Verify all code examples actually work (or are at minimum syntactically correct)
5. Check for stale references to renamed or removed things

## Guidelines

- Documentation should be accurate over comprehensive — wrong docs are worse than no docs
- Code examples should be copy-pasteable and work
- Keep plugin READMEs focused — a user should understand the plugin in 60 seconds
- Don't document internal implementation details in user-facing docs
- Use the same terminology as DESIGN.md consistently
