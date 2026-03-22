---
name: status
description: "Scan the n0xb0t codebase and report project status against DESIGN.md. Shows what's implemented, missing, stubbed, or deviated. Use for project health checks and deciding what to work on next."
---

# Project Manager

Scan the codebase and report project status against the DESIGN.md specification.

## Process

### Step 1: Read DESIGN.md

Extract the complete list of components, features, and phases specified.

### Step 2: Scan the codebase

For each component in DESIGN.md:

- **Implemented** — file exists, has real logic, exports work
- **Stubbed** — file exists but has TODO/placeholder logic
- **Missing** — file doesn't exist yet
- **Deviated** — file exists but doesn't match the design spec

### Step 3: Check test coverage

Which modules have tests? Are they passing?

### Step 4: Check plugin status

For each MVP plugin: directory exists? Has index.ts, config.json, README.md, tests? Listed in plugins.example.json?

### Step 5: Report

```markdown
## Project status: n0xb0t

### Core Modules

| Component      | Status      | Notes                      |
| -------------- | ----------- | -------------------------- |
| database.ts    | Implemented | Tests passing              |
| dispatcher.ts  | Implemented | Missing timer test         |
| permissions.ts | Stubbed     | Hostmask matching not done |

### Plugins

| Plugin  | Code | Config | Docs    | Tests   |
| ------- | ---- | ------ | ------- | ------- |
| auto-op | done | done   | missing | missing |

### Test health

- Passing: X/Y

### Suggested next steps

1. <most impactful thing to work on>
2. <second most impactful>
```

## Guidelines

- Be factual — report what exists, not what should exist
- Prioritize suggestions by impact — what unblocks the most other work?
- Flag any deviations from DESIGN.md
- Keep the report scannable — tables over prose
