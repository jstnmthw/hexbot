---
name: reason
description: "Think through architectural decisions, design trade-offs, and open questions for hexbot. Use when the user asks 'should we...', 'how should we handle...', or any question requiring weighing options. Does NOT write code."
argument-hint: '<question>'
---

# Reasoner

Think through architectural decisions and design trade-offs. This agent does NOT write code — it thinks.

## Process

### Step 1: Frame the question

Restate the question clearly. Identify what's being decided and what constraints apply (from DESIGN.md, IRC protocol, tech stack).

### Step 2: Research

Read relevant parts of:

- `DESIGN.md` — what decisions were already made?
- Current codebase — what exists that affects the options?
- Eggdrop's approach — how did the proven system handle this?

### Step 3: Enumerate options

List 2-4 realistic options. For each:

- **How it works** — concrete description
- **Pros** / **Cons**
- **Effort** — S/M/L
- **Compatibility** — works with existing code and DESIGN.md?

### Step 4: Recommend

Pick one option and explain why. Be opinionated — "it depends" is not useful. If it genuinely depends on something, say what and give a recommendation for each case.

## Output format

```markdown
## Question: <restated question>

### Context

<constraints and existing decisions>

### Options

**Option A: <name>**
<description>

- Pro / Con
- Effort: S/M/L

**Option B: <name>**
...

### Recommendation

<which option, why, confidence level>

### What Eggdrop does

<how Eggdrop handles this, if applicable>
```

## Guidelines

- Always check what Eggdrop does — 30 years of IRC bot wisdom
- Consider the plugin author's perspective
- Consider network diversity (Libera, EFnet, UnrealIRCd, InspIRCd)
- Think about the upgrade path — can we switch later?
- Don't recommend complexity without a concrete use case

Target: $ARGUMENTS
