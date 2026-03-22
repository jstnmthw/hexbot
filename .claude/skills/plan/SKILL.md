---
name: plan
description: 'Analyze feature feasibility against the n0xb0t codebase and produce a structured implementation plan. Use when the user wants to plan a new feature, plugin, or capability before building it.'
argument-hint: '<feature description>'
---

# Planner

Analyze feature feasibility against the current n0xb0t codebase and produce a structured implementation plan. This agent does NOT write code — it produces a markdown plan that `/build` executes.

## Process

### Step 1: Understand the request

Clarify what the user wants. Ask questions if the scope is ambiguous. Identify which parts of the system are affected (core modules, plugins, config, database schema, etc.).

### Step 2: Read the codebase

Before assessing feasibility, read:

1. `DESIGN.md` — verify the feature aligns with architectural decisions
2. The relevant source files that would need to change
3. Any existing plugins that are similar to what's being requested
4. Current config schemas to understand what's already configurable
5. Existing tests to understand test coverage

### Step 3: Feasibility assessment

Produce a brief assessment covering:

- **Alignment**: Does this fit the DESIGN.md architecture, or does it require design changes?
- **Dependencies**: What existing modules/plugins does this depend on? Are they built yet?
- **Blockers**: Anything that must be resolved first (missing core module, config schema change, etc.)
- **Complexity estimate**: S (hours) / M (day) / L (days) / XL (significant effort)
- **Risk areas**: What could go wrong? Edge cases? IRC protocol gotchas?

### Step 4: Produce the plan

Write a markdown file to `docs/plans/<feature-name>.md` with this structure:

```markdown
# Plan: <Feature Name>

## Summary

One paragraph describing what this feature does and why.

## Feasibility

<assessment from step 3>

## Dependencies

- [ ] <thing that must exist first>

## Phases

### Phase 1: <name>

**Goal:** <what this phase accomplishes>

- [ ] <concrete task with file path>
- [ ] <concrete task with file path>
- [ ] <verification step — how to confirm this phase works>

### Phase 2: <name>

...

## Config changes

<any new config fields needed, with example JSON>

## Database changes

<any new tables or schema changes>

## Test plan

<what tests should be written and what they verify>

## Open questions

<anything that needs user input before building>
```

### Step 5: Present to user

Show the plan and ask for confirmation before the Builder executes it. Highlight any open questions that need answers first.

## Guidelines

- Plans should be executable by `/build` without ambiguity
- Each checklist item should be small enough to complete in one focused step
- Always include verification steps — how do you know each phase works?
- Reference specific files and functions, not vague descriptions
- If the feature requires a design change, flag it prominently
- Consider backward compatibility: will this break existing plugins or configs?
- Think about the IRC protocol implications — different networks, flood protection, async timing

Target: $ARGUMENTS
