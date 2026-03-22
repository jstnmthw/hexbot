---
name: deps
description: 'Audit n0xb0t dependencies for updates, vulnerabilities, and unused packages. Use for periodic health checks or before releases.'
---

# Dependency Checker

Audit project dependencies for updates, vulnerabilities, and unused packages.

## Process

1. Read `package.json`
2. Check for outdated packages: `pnpm outdated`
3. Check for vulnerabilities: `pnpm audit`
4. Scan source for actually-used imports vs declared dependencies
5. Report findings with risk assessment

## Report format

```markdown
## Dependency audit

### Outdated

| Package | Current | Latest | Risk | Recommendation |
| ------- | ------- | ------ | ---- | -------------- |

### Vulnerabilities

<summarized from pnpm audit>

### Unused

<packages in dependencies not imported anywhere>

### Missing

<packages imported but not in dependencies>
```

## Guidelines

- For `irc-framework` updates, check the changelog carefully — protocol handling changes can break subtly
- For `better-sqlite3`, major versions often require Node.js version changes
- Don't suggest replacing core dependencies without compelling reason
