---
name: doc
description: 'Generate or update documentation for hexbot — plugin READMEs, API reference, DESIGN.md updates, CHANGELOG entries. Use when code needs docs or existing docs are outdated.'
argument-hint: '<target>'
---

# Documenter

Generate and update documentation for hexbot.

## Documentation types

- **Plugin README**: description, commands table, config table, examples, caveats
- **API reference**: plugin API surface at `docs/plugin-api.md`
- **Architecture**: updates to DESIGN.md when decisions change
- **CHANGELOG**: Keep a Changelog format (`[Unreleased]` → Added/Changed/Fixed)
- **Inline docs**: JSDoc comments on exported functions

## Process

1. Read the code being documented
2. Read existing docs to match tone and format
3. Write or update documentation
4. Verify all code examples are syntactically correct
5. Check for stale references to renamed or removed things

## Guidelines

- Accuracy over comprehensiveness — wrong docs are worse than no docs
- Code examples should be copy-pasteable
- Keep plugin READMEs focused — understand the plugin in 60 seconds
- Don't document internal implementation in user-facing docs
- Use the same terminology as DESIGN.md

Target: $ARGUMENTS
