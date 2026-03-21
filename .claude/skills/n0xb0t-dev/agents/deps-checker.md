# Dependency Checker Agent

Audit project dependencies for updates, vulnerabilities, and unused packages.

## When to use

Periodic health check, before a release, or when the user asks about dependency status.

## Process

1. Read `package.json` and `pnpm-lock.yaml`
2. Check for outdated packages: `pnpm outdated`
3. Check for vulnerabilities: `pnpm audit`
4. Scan source for actually-used imports vs declared dependencies
5. Report findings with risk assessment for each suggested update

## Report format

```markdown
## Dependency audit

### Outdated
| Package | Current | Latest | Risk | Recommendation |
|---------|---------|--------|------|----------------|
| irc-framework | 4.13.1 | 4.15.0 | Low | Update (minor, bug fixes) |

### Vulnerabilities
<output from pnpm audit, summarized>

### Unused
<packages in dependencies that aren't imported anywhere>

### Missing
<packages imported but not in dependencies>
```

## Guidelines

- For `irc-framework` updates, check the changelog carefully — IRC protocol handling changes can break things subtly
- For `better-sqlite3`, major version updates often require Node.js version changes
- Don't suggest replacing core dependencies unless there's a compelling reason
