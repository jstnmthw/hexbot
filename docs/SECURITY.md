# n0xb0t Security Guide

This document defines security practices for developing n0xb0t. Every contributor and every Claude Code session should treat this as mandatory reading before writing code that handles user input, permissions, IRC output, or database operations.

---

## 1. Threat model

An IRC bot is a privileged network participant. It holds channel operator status, manages user permissions, and executes commands on behalf of users. Threats include:

- **Impersonation** — attacker uses an admin's nick before NickServ identification completes
- **Command injection** — crafted IRC messages that manipulate command parsing or raw IRC output
- **Privilege escalation** — bypassing the flag system to execute admin commands
- **Data leakage** — plugin accessing another plugin's database namespace, or config secrets exposed in logs
- **Denial of service** — triggering flood disconnects, resource exhaustion via unbounded loops, or crash-inducing input
- **Hostmask spoofing** — relying on nick-only matching (`nick!*@*`) which anyone can impersonate

---

## 2. Input validation

### 2.1 All IRC input is untrusted

Every field in an IRC message — nick, ident, hostname, channel, message text — is attacker-controlled. Never trust it.

```typescript
// BAD: directly interpolating IRC input into raw IRC output
bot.raw(`PRIVMSG ${ctx.channel} :Hello ${ctx.text}`);

// GOOD: use the library's safe methods
api.say(ctx.channel, `Hello ${ctx.text}`);
```

### 2.2 Command argument parsing

- Strip control characters (IRC formatting codes: bold, color, underline) before parsing commands
- Validate argument counts before accessing array indices
- Reject arguments that contain newlines (`\r`, `\n`) — these can inject additional IRC commands
- Limit argument length — don't pass unbounded strings to database queries or IRC output

```typescript
// BAD: no validation
const target = ctx.args[0];
api.say(target, message);

// GOOD: validate target looks like a channel or nick
const target = ctx.args[0];
if (!target || target.includes('\r') || target.includes('\n')) return;
if (!target.match(/^[#&]?\w[\w\-\[\]\\`^{}]{0,49}$/)) {
  ctx.reply('Invalid target.');
  return;
}
```

### 2.3 Newline injection (IRC protocol injection)

IRC commands are delimited by `\r\n`. If user input containing newlines is passed to `raw()` or interpolated into IRC protocol strings, the attacker can inject arbitrary IRC commands.

**Rule:** Never pass raw user input to `client.raw()`. Always sanitize or use the library's typed methods (`say`, `notice`, `action`, `mode`). If `raw()` is ever needed, strip `\r` and `\n` from all interpolated values first.

### 2.4 Database input

`better-sqlite3` uses prepared statements which prevent SQL injection. However:

- Always use the parameterized API (`db.prepare('... WHERE key = ?').get(key)`), never string concatenation
- Validate namespace isolation — the `Database` class must enforce that plugins can only access their own namespace
- Be aware of storage exhaustion — a malicious plugin or user could fill the DB. Consider per-namespace size limits in a future phase.

---

## 3. Identity and permissions

### 3.1 Hostmask security

Hostmask matching is the primary identity mechanism. Security depends on pattern quality:

| Pattern                 | Security      | Notes                                                   |
| ----------------------- | ------------- | ------------------------------------------------------- |
| `*!*@specific.host.com` | Good          | Static host, hard to spoof                              |
| `*!ident@*.isp.com`     | Moderate      | Ident can be faked on some servers                      |
| `*!*@user/account`      | Strong        | Network-verified cloak (Libera, etc.)                   |
| `nick!*@*`              | **Dangerous** | Anyone can use any nick. Never use for privileged users |

**Rule:** Warn when an admin adds a `nick!*@*` hostmask for a user with `+o` or higher flags. Log a `[security]` warning.

### 3.2 NickServ race condition

When a user joins a channel:

1. Bot sees the JOIN event
2. User may or may not have identified with NickServ yet
3. Bot queries `NickServ ACC nick`
4. Response arrives asynchronously

**If the bot ops on join without waiting for ACC verification, an attacker can get ops by using an admin's nick before NickServ identifies them.**

**Rule:** When `config.identity.require_acc_for` includes a flag level, the bot MUST wait for the ACC response (with timeout) before granting that privilege. Never skip verification for convenience.

### 3.3 Flag checking

- The dispatcher MUST check flags before calling any handler that has a flag requirement
- The `checkFlags` path must be: resolve hostmask → find user → check flags → (optionally) verify via NickServ
- Flag checking must not short-circuit on the first matching hostmask if that hostmask belongs to a different user
- The `-` flag (no requirement) is the only case where flag checking is skipped entirely
- Owner flag (`n`) implies all other flags — this is intentional but means owner accounts are high-value targets. Limit `n` to trusted, verified hostmasks only.

### 3.4 REPL context

Commands from the REPL run with implicit owner privileges — the person at the terminal has physical access. However:

- Log all REPL commands the same way IRC commands are logged
- Never expose the REPL over a network socket without authentication (future web panel must have its own auth)

---

## 4. Plugin isolation

### 4.1 Scoped API boundary

Plugins receive a `PluginAPI` object. They must NOT:

- Import directly from `src/` modules (bypasses the scoped API)
- Access `globalThis`, `process.env`, or the filesystem without going through an approved API
- Modify the `api` object or its prototypes
- Access other plugins' state or database namespaces

**Enforcement:** The plugin loader validates exports and the scoped API object is frozen (`Object.freeze` on nested objects where practical). Database namespace isolation is enforced at the `Database` class level, not by convention.

### 4.2 Plugin error containment

- A thrown error in a plugin handler MUST NOT crash the bot or prevent other handlers from firing
- The dispatcher wraps every handler call in try/catch and logs the error with `[plugin:name]` prefix
- A plugin that throws repeatedly should be logged but not auto-unloaded (that's an admin decision)

### 4.3 Plugin resource cleanup

- `teardown()` must be called on unload — if it throws, log the error but continue the unload
- `dispatcher.unbindAll(pluginId)` must remove ALL binds including timers
- Timer intervals that aren't cleaned up will leak and accumulate on reload

---

## 5. Output safety

### 5.1 IRC message limits

- IRC messages are limited to ~512 bytes including protocol overhead
- The bot's own prefix (`nick!ident@host`) is prepended by the server, consuming ~60-100 bytes
- **Rule:** Split long replies at word boundaries. Never send unbounded output.
- Add rate limiting between multi-line replies to avoid flood disconnects

### 5.2 No user-controlled formatting in sensitive output

Don't let user input appear in contexts where IRC formatting codes could mislead:

```typescript
// BAD: user controls the nick display in a trust-relevant context
api.say(channel, `User ${nick} has been granted ops`);
// An attacker could set nick to include IRC color codes to hide/fake the message

// GOOD: strip formatting from interpolated values in security-relevant messages
api.say(channel, `User ${stripFormatting(nick)} has been granted ops`);
```

### 5.3 Logging

- Log mod actions (op, deop, kick, ban) to `mod_log` with who triggered them
- Log permission changes (adduser, deluser, flag changes) with the source (REPL or IRC + nick)
- Never log passwords, SASL credentials, or NickServ passwords — even at debug level
- Sanitize nick/channel in log output to prevent log injection (strip control characters)

---

## 6. Configuration security

- `config/bot.json` contains the NickServ/SASL password — it MUST be in `.gitignore`
- Example configs (`*.example.json`) must never contain real credentials
- The bot should refuse to start if `config/bot.json` is world-readable (`chmod` check on startup, at least on Unix)
- Plugin configs should not contain secrets; if a plugin needs credentials, they should go in the main bot config under a plugin-specific section

---

## 7. Secure defaults

The bot should be safe out of the box, without requiring the admin to harden it:

| Setting                    | Default        | Why                                                         |
| -------------------------- | -------------- | ----------------------------------------------------------- |
| `identity.method`          | `"hostmask"`   | Works on all networks, no services dependency               |
| `identity.require_acc_for` | `["+o", "+n"]` | Privileged ops require NickServ verification when available |
| `services.sasl`            | `true`         | SASL is more secure than PRIVMSG IDENTIFY                   |
| `irc.tls`                  | `true`         | Encrypted connection by default                             |
| Admin commands flag        | `+n`           | Only owner can run admin commands                           |
| `.help` flag               | `-`            | Help is available to everyone (no info leak risk)           |
| Plugin API `permissions`   | Read-only      | Plugins can check flags but not grant them                  |

---

## 8. Security checklist for code review

Use this checklist when reviewing any PR or code change:

- [ ] All IRC input is validated before use (nicks, channels, message text)
- [ ] No newlines (`\r`, `\n`) in values passed to `raw()` or interpolated into IRC protocol strings
- [ ] Database operations use parameterized queries (no string concatenation in SQL)
- [ ] Permissions are checked before privileged actions
- [ ] NickServ verification is awaited (not skipped) for flagged operations when configured
- [ ] Plugin uses only the scoped API, no direct imports from `src/`
- [ ] Long output is split and rate-limited
- [ ] Errors in handlers are caught and don't crash the bot
- [ ] No secrets in logged output
- [ ] Config examples contain no real credentials
- [ ] Hostmask patterns for privileged users are specific (not `nick!*@*`)
