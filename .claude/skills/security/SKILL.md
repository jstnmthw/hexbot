---
name: security
description: 'Audit hexbot code for IRC-specific and general bot security vulnerabilities. Produces a structured findings report. Use before deploying to a real network or after major features land.'
argument-hint: "<target: file, module, plugin, or 'all'>"
---

# Security Auditor

Audit hexbot code for IRC-specific and general bot security vulnerabilities.

## Baseline

Always read `docs/SECURITY.md` first — it defines the project's security model.

## Audit process

### Step 1: Scope

- **File/module**: audit that file and anything it directly calls
- **Plugin**: audit the plugin's `index.ts`, config, and API usage
- **`all`**: audit every `.ts` file in `src/` and `plugins/`

### Step 2: Read every file in scope thoroughly

### Step 3: Check each category

**Input validation**: IRC input treated as untrusted, newlines stripped, args validated
**Protocol injection**: No user input in `raw()` calls or unparameterized SQL
**Permissions**: Flag checks before privileged actions, NickServ ACC awaited, fail closed
**Plugin isolation**: Scoped API only, namespaced DB, frozen API objects, errors caught
**Credentials**: No passwords in logs, bot.json gitignored, placeholders in examples
**DoS**: No unbounded loops from user input, rate-limited output, depth limits
**IRC-specific**: NickServ race in auto-op, case-insensitive comparisons, message length, MODES batching

### Step 4: Write report to `docs/audits/<target>-<date>.md`

```markdown
# Security Audit: <target>

**Date:** YYYY-MM-DD
**Scope:** <what was audited>

## Summary

<overall assessment>
**Findings:** X critical, Y warning, Z info

## Findings

### [CRITICAL] <title>

**File:** `path:line`
**Category:** <category>
**Description:** <vulnerability and exploitation>
**Remediation:** <specific fix>

### [WARNING] ...

### [INFO] ...

## Passed checks

## Recommendations
```

## Severity levels

- **CRITICAL** — Exploitable now. Fix before deploying.
- **WARNING** — Violates practices. Could become critical. Fix before feature complete.
- **INFO** — Defense-in-depth. Address when convenient.

## Guidelines

- Be specific — quote exact code, show exact fix
- Don't flag theoretical issues that can't happen given the architecture
- Do flag missing checks even if nothing currently triggers them
- The auto-op plugin is highest-risk — extra scrutiny
- A clean audit is valid and useful

Target: $ARGUMENTS
