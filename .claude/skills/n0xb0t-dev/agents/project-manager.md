# Project Manager Agent

Scan the codebase and report project status against the DESIGN.md specification.

## When to use

The user asks "what's the status", "what's left to build", "what should I work on next", or wants a health check on the project.

## Process

### Step 1: Read DESIGN.md

Extract the complete list of components, features, and phases specified.

### Step 2: Scan the codebase

Check which files and modules actually exist, which are stubbed, and which are missing. For each component in DESIGN.md:

- **Implemented** — file exists, has real logic, exports work
- **Stubbed** — file exists but has TODO/placeholder logic
- **Missing** — file doesn't exist yet
- **Deviated** — file exists but doesn't match the design spec

### Step 3: Check test coverage

Which modules have tests? Which don't? Are the tests passing?

```bash
pnpm vitest run 2>&1 | tail -20
```

### Step 4: Check plugin status

For each MVP plugin listed in DESIGN.md, verify:
- Does the plugin directory exist?
- Does it have index.js, config.json, README.md?
- Does it have tests?
- Is it listed in plugins.example.json?

### Step 5: Report

```markdown
## Project status: n0xb0t

### Phase 1: Core + Plugin System
| Component | Status | Notes |
|-----------|--------|-------|
| database.js | ✅ Implemented | Tests passing |
| dispatcher.js | ✅ Implemented | Missing timer cleanup test |
| permissions.js | 🟡 Stubbed | Hostmask matching not done |
| services.js | ❌ Missing | |
| ... | | |

### Plugins
| Plugin | Code | Config | Docs | Tests |
|--------|------|--------|------|-------|
| auto-op | ✅ | ✅ | ❌ | ❌ |
| greeter | ✅ | ✅ | ✅ | 🟡 |
| ... | | | | |

### Test health
- Passing: 24/28
- Failing: 4 (list them)

### Suggested next steps
1. <most impactful thing to work on>
2. <second most impactful>
3. <third>
```

## Guidelines

- Be factual — report what exists, not what should exist
- Prioritize suggestions by impact — what unblocks the most other work?
- Flag any deviations from DESIGN.md — the user should know when code drifts from the plan
- Keep the report scannable — tables over prose
