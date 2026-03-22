---
name: review
description: 'Code review against n0xb0t conventions, security practices, and IRC bot best practices. Use when the user asks for a code review or second opinion on code.'
argument-hint: '<files or feature>'
---

# Reviewer

Review code changes against n0xb0t conventions, security practices, and IRC bot best practices.

## Review checklist

### Architecture alignment

- Does the code follow patterns established in DESIGN.md?
- Are bind types used correctly (stackable vs non-stackable)?
- Does the plugin respect the scoped API boundary (no direct imports from core)?
- Is config resolution correct (plugins.json > plugin defaults)?
- Is the database namespace properly scoped?

### IRC bot-specific concerns

- **Flood protection**: Does the code send multiple messages in a loop without rate limiting?
- **Hostmask handling**: Are hostmasks parsed correctly? Are wildcards handled?
- **NickServ race conditions**: If the code ops a user on join, does it verify identity first?
- **Channel mode awareness**: Does the code assume modes that might not exist on all networks?
- **Encoding**: Does the code handle non-UTF8 text gracefully?
- **Message length**: Long replies need splitting (~400 byte safe limit).
- **Case sensitivity**: IRC nicks/channels are case-insensitive — using `.toLowerCase()`?

### Security (see `docs/SECURITY.md`)

- Newline injection (`\r`/`\n`) in IRC output
- Parameterized SQL (no string concatenation)
- Permissions checked before privileged actions
- NickServ ACC verification awaited when configured
- Plugin API objects frozen — no shared state mutation
- No `eval()` or `Function()` on user input
- Errors in handlers caught — one plugin can't crash the bot

### Plugin compliance

- Exports `name`, `version`, `init(api)`
- Uses only the `api` object, no direct imports from `src/`
- `teardown()` cleans up resources (timers, connections)
- Error in one handler doesn't break others

## Output format

```markdown
## Review: <file or feature name>

### Summary

<1-2 sentence overall assessment>

### Issues

- **Critical** — <security or correctness problem>
- **Warning** — <not ideal but works>
- **Suggestion** — <improvement>

### Looks good

<things that are well done>
```

## Guidelines

- Be specific — quote the problematic code and show the fix
- Prioritize: security > correctness > conventions > style
- Don't nitpick formatting if the code is functionally sound
- If the code is good, say so briefly

Target: $ARGUMENTS
