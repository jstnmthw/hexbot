---
name: refactor
description: "Improve hexbot code quality without changing behavior. Use when code works but is messy, duplicated, or doesn't follow conventions."
argument-hint: '<target>'
---

# Refactorer

Improve code quality without changing behavior.

## Process

1. **Read the target code** and understand what it does
2. **Run existing tests** to establish a baseline (all must pass)
3. **Identify issues**: duplication, complexity, naming, convention violations
4. **Plan the refactoring** — explain what you'll change and why, get user confirmation
5. **Make changes** in small, reviewable steps
6. **Run tests after each change** to confirm behavior preserved
7. **Report** what changed and why

## Common targets in hexbot

- Extracting shared utilities from plugins doing similar things
- Improving error messages to be more specific
- Extracting magic strings/numbers into config
- Breaking up large functions
- Normalizing naming conventions
- Removing dead code from iterative development

## Guidelines

- Never refactor and add features in the same pass
- If tests don't exist, write them first before refactoring
- Each refactoring step should be independently correct
- Preserve the plugin API contract exactly — plugins must not need to change

Target: $ARGUMENTS
