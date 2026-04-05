# HexBot Security Guide

This document defines security practices for developing HexBot. Every contributor and every Claude Code session should treat this as mandatory reading before writing code that handles user input, permissions, IRC output, or database operations.

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

### 3.4 DCC CHAT connection race

DCC CHAT uses a passive handshake: the bot opens a TCP listener and tells the user which port to connect to via CTCP. The first TCP connection to that port is accepted as the session, regardless of source IP. An attacker who can observe the CTCP exchange and reach the bot's IP could race to connect before the legitimate user, obtaining a session with that user's permissions.

This is an inherent limitation of the DCC protocol — the token mechanism correlates the CTCP offer but does not authenticate the TCP connection.

**Mitigations in place:**

- The listening port is open for only 30 seconds before timing out
- The listener accepts exactly one connection, then closes
- Permission flags and (optionally) NickServ verification are checked before the port is offered
- Session limits cap the total number of concurrent DCC sessions

**Rule:** Administrators should understand this risk before enabling `dcc.enabled` in config. DCC CHAT is best used on networks where the bot's IP is not widely known, or where the CTCP exchange happens via private message rather than a public channel.

### 3.5 REPL context

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
- **Call `eval()` or `new Function()` on user-supplied input** — this is a critical vulnerability class. CVE-2019-19010 (Limnoria, CVSS 9.8) demonstrated that an IRC bot plugin using `eval()` for user-submitted math expressions allows full code execution in the bot's process. Any plugin that needs to evaluate expressions must use a sandboxed library with no access to Node.js builtins.

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

// GOOD: use the shared utility from PluginAPI
api.say(channel, `User ${api.stripFormatting(nick)} has been granted ops`);
```

`api.stripFormatting(text)` removes all IRC control characters (bold `\x02`, color `\x03`, italic `\x1D`, underline `\x1F`, strikethrough `\x1E`, monospace `\x11`, reset `\x0F`, reverse `\x16`) including color code parameters. Apply it to any user-controlled string appearing in:

- Permission grant/revoke announcements
- Op/kick/ban action messages
- Any console or log output that contains user-supplied data

### 5.3 Logging

- Log mod actions (op, deop, kick, ban) to `mod_log` with who triggered them
- Log permission changes (adduser, deluser, flag changes) with the source (REPL or IRC + nick)
- Never log passwords, SASL credentials, or NickServ passwords — even at debug level
- Sanitize nick/channel in log output to prevent log injection (strip control characters)

---

## 6. Configuration security

- High-value secrets are **never** stored inline in `config/bot.json`. Each secret field is named via a `<field>_env` suffix that points to an environment variable; the loader resolves it from `process.env` at startup. Fields covered: `services.password_env` (NickServ/SASL password), `botlink.password_env` (bot-link shared secret), `chanmod.nick_recovery_password_env` (NickServ GHOST password), `proxy.password_env` (SOCKS5 auth). See [docs/plans/config-secrets-env.md](plans/config-secrets-env.md) for the full spec.
- **Channel `+k` keys are an exception**: they're low-sensitivity join tokens shared with every channel member and visible to any channel op via `/mode`. They may live inline on a channel entry (`{"name": "#chan", "key": "..."}`). For operators who want them out of the config anyway, `key_env` is available as an alternative.
- `.env` files hold the actual secret values and MUST be in `.gitignore` (they are, via `.env` and `.env.*` patterns).
- `config/bot.json` still MUST be in `.gitignore` — while it no longer contains secrets directly, it does contain operational details (hostmasks, connection details) that should not be public.
- Example configs (`config/bot.example.json`, `config/bot.env.example`) must never contain real credentials. By construction, `*.example.json` can only reference env var _names_, not secrets.
- The bot refuses to start if `config/bot.json` is world-readable. Apply the same `chmod 600` to `.env*` files.
- Startup validation enforces that every enabled feature has its required env var set — the bot fails loudly with the exact var name when a secret is missing (see `validateResolvedSecrets` in `src/config.ts`).

### 6.1 Env var handling

- **Plugins must never read `process.env` directly.** Declare a `<field>_env` field in the plugin's `config.json` (or in the `plugins.json` override) and read `api.config.<field>` from init. The loader resolves the env var before the plugin sees its config. Plugins reading `process.env` can exfiltrate unrelated ambient secrets (AWS keys, cloud provider creds) that don't belong to the bot.
- Never log resolved secret values, even at debug level. Log the env var name instead if a breadcrumb is useful ("NICKSERV_PASSWORD missing" — not the value).
- Never reference env vars that don't belong to HexBot just because they're in the ambient environment. Every `_env` field should be documented in `config/bot.env.example`.
- Rotate secrets after migrating from inline JSON to `_env` (the old values were in a plaintext file on disk).

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

## 8. IRCv3 message tags — trust model

IRCv3 message tags carry metadata alongside messages. Their trust level depends on who set them:

| Tag type             | Prefix | Trust level                                | Examples                   |
| -------------------- | ------ | ------------------------------------------ | -------------------------- |
| **Server tags**      | none   | Server-verified — may be trusted           | `time`, `account`, `msgid` |
| **Client-only tags** | `+`    | Completely untrusted — treat as user input | `+draft/react`, `+typing`  |

**Rule:** Client-only tags (prefixed `+`) are relayed verbatim by the server without modification. An attacker can set any client-only tag to any value. Never use client-only tag values for security decisions.

**Rule:** The `account` server tag (when present) identifies the sender's services account. It may be treated as server-verified, but only when the server has enabled the `account-tag` capability. HexBot's dispatcher uses the live account map from `account-notify` / `extended-join` rather than reading this tag directly.

```typescript
// BAD: reading a client-only tag as authoritative
const userRole = ctx.tags?.['+role']; // attacker can set this to anything

// GOOD: read user flags from the permissions system
const record = api.permissions.findByHostmask(`${ctx.nick}!${ctx.ident}@${ctx.hostname}`);
```

## 9. Bot linking security

The bot link protocol (`src/core/botlink.ts`) introduces a trusted TCP channel between bots. Security considerations:

### Trust model

**Hub-authoritative.** The hub is the single source of truth for permissions and executes all relayed commands. A compromised hub means total compromise of the botnet. Leaves trust frames from the hub unconditionally (permission syncs, command results, party line messages).

**Leaf trust is limited.** The hub validates leaf identity via password hash and enforces rate limits. Hub-only frame types (`CMD`, `RELAY_*`, `PROTECT_ACK`) are never fanned out to other leaves — the hub processes them internally.

### Authentication

- Passwords are **never sent in plaintext**. Leaves send `sha256:<hex>` hashes in the `HELLO` frame.
- The hub compares against the pre-computed expected hash. Failed auth produces `AUTH_FAILED` and the connection is closed.
- All bots in a botnet share the same password. Use a strong, unique password per botnet.

### Frame validation

- All string values in incoming frames are sanitized (stripped of `\r`, `\n`, `\0`) via `sanitizeFrame()` before processing.
- Frame size is capped at 64KB. Oversized frames are protocol errors and cause immediate disconnect.
- Rate limiting: CMD frames at 10/sec, PARTY_CHAT at 5/sec per leaf. Exceeding limits returns an error or silently drops.

### Relay sessions

When a DCC user runs `.relay <botname>`, their input is proxied to the remote bot. The remote bot trusts the originating bot's authentication — it does not re-verify the user's identity. This means:

- A relay session inherits the permissions of the user's handle on the **hub's** permission database.
- If the user is removed from the hub's permissions while relaying, the relay continues until explicitly ended.

### Protection frames

`PROTECT_TAKEOVER` and `PROTECT_REGAIN` frames request cross-network channel protection from peers. The receiving bot verifies the requested nick exists in its local permissions database before acting. Protection frames cannot be used to op arbitrary nicks — only known users.

### Network considerations

- Bot link connections are **unencrypted TCP**. For WAN deployments, use a VPN or SSH tunnel.
- The `listen.host` config should be set to a private IP or `127.0.0.1` when bots are co-located. Do not expose the link port to the public internet without transport encryption.

## 10. Security checklist for code review

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
