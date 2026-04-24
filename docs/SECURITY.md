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

- The IRC bridge strips `\r`, `\n`, and `\0` from all inbound fields via `sanitize()` (`src/utils/sanitize.ts`) before they reach handlers — this is the primary injection defence
- IRC formatting codes (bold, color, underline, etc.) are stripped from the command word via `stripFormatting()` (`src/utils/strip-formatting.ts`) before dispatch, so `\x03` colour codes can't disguise a command
- Validate argument counts before accessing array indices
- Reject arguments that contain newlines (`\r`, `\n`) — these can inject additional IRC commands (the bridge strips them, but defence in depth applies if a plugin constructs strings from multiple user inputs)
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

**Rule:** Never pass raw user input to `client.raw()`. Always sanitize or use the library's typed methods (`say`, `notice`, `action`, `mode`). If `raw()` is ever needed, strip `\r`, `\n`, and `\0` from all interpolated values first.

**Implementation:** The IRC bridge calls `sanitize()` on every field of every inbound event (nick, ident, hostname, target, message). The plugin API's outbound methods (`api.say`, `api.notice`, `api.action`, `api.ctcpResponse`) also call `sanitize()` on the message before passing it to irc-framework, providing defence in depth.

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
| `$a:accountname`        | **Strongest** | Matches by services account — requires identification   |
| `*!*@user/account`      | Strong        | Network-verified cloak (Libera, etc.)                   |
| `*!*@specific.host.com` | Good          | Static host, hard to spoof                              |
| `*!ident@*.isp.com`     | Moderate      | Ident can be faked on some servers                      |
| `nick!*@*`              | **Dangerous** | Anyone can use any nick. Never use for privileged users |

**Account-based identity (`$a:` patterns):** The permissions system supports `$a:<accountpattern>` patterns that match a user's services account name instead of their hostmask. These are stronger than any hostmask pattern because they require the user to have identified with NickServ. The pattern supports wildcards (e.g., `$a:alice*`). Account data is sourced from IRCv3 `account-tag`, `account-notify`, and `extended-join` capabilities. When no account data is available for a user, `$a:` patterns are silently skipped and only hostmask patterns match.

**Case folding for `$a:` patterns:** Account-pattern matching uses the network's active `CASEMAPPING` (typically `rfc1459`). Account names are not nicks — services treat them as case-insensitive but not under the same folding rules RFC 1459 defines for nicks/channels (`[]\~` → `{}|^`). In practice every services implementation we target collapses account case the same way NickServ does for the nick space, so reusing the IRC folder is safe. If a future services vendor returns account strings whose canonical case differs from the nick casemapping, that assumption needs to be revisited.

**Rule:** Warn when an admin adds a `nick!*@*` hostmask for a user with `+o` or higher flags. Log a `[security]` warning. Account patterns (`$a:`) skip this warning — they are inherently secure.

### 3.2 NickServ race condition

When a user joins a channel:

1. Bot sees the JOIN event
2. User may or may not have identified with NickServ yet
3. Bot queries NickServ (ACC for Atheme, STATUS for Anope)
4. Response arrives asynchronously

**If the bot ops on join without waiting for verification, an attacker can get ops by using an admin's nick before NickServ identifies them.**

**Enforcement:** The dispatcher (`src/dispatcher.ts`) has a built-in `VerificationProvider` gate. When `config.identity.require_acc_for` includes a flag level (e.g., `["+o", "+n"]`), the dispatcher automatically checks identity **before** calling any handler whose required flags match that threshold. Plugin authors do not need to call `verifyUser()` themselves — the dispatcher handles it.

**Fast path:** When the server supports IRCv3 `account-notify` / `extended-join`, the bot maintains a live nick-to-account map. The dispatcher checks this map first — if the account is already known, no NickServ round-trip is needed. The slow path (NickServ ACC/STATUS query with 5-second timeout) is used only when account data is not yet available.

**Rule:** When `config.identity.require_acc_for` includes a flag level, the bot MUST wait for the verification response (with timeout) before granting that privilege. The dispatcher enforces this automatically. Never bypass the dispatcher for privileged actions.

**Bot-side identify-before-join:** SASL (PLAIN or EXTERNAL) is the supported mechanism for the bot to be identified before it joins its configured channels. On SASL networks the server authenticates the bot before IRC registration completes, so the subsequent JOINs are issued by an already-identified, cloaked session. On non-SASL networks the bot sends `PRIVMSG NickServ :IDENTIFY <pw>` from the `registered` handler immediately before the first JOIN (see `src/core/connection-lifecycle.ts`), but the IDENTIFY and JOIN lines still race on the server — this is best-effort, not deterministic. Operators of `+r` (registered-only) channels or networks that rely on ChanServ auto-op must use SASL; the legacy IDENTIFY path is a convenience, not a guarantee.

### 3.3 Flag checking

- The dispatcher MUST check flags before calling any handler that has a flag requirement
- The `checkFlags` path must be: resolve hostmask → find user → check flags → (optionally) verify via NickServ
- Flag checking must not short-circuit on the first matching hostmask if that hostmask belongs to a different user
- The `-` flag or an empty string `''` (no requirement) are the only cases where flag checking is skipped entirely
- Owner flag (`n`) implies all other flags — this is intentional but means owner accounts are high-value targets. Limit `n` to trusted, verified hostmasks only.

### 3.4 DCC CHAT authentication — trust model split

DCC CHAT and in-channel commands use **different authentication models** on purpose:

| Path                | Authenticator                         | Why                                                                                          |
| ------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| In-channel commands | Hostmask + IRCv3 account-tag          | Prompting on every channel message is impossible; the network already gates message delivery |
| DCC CHAT session    | **Per-user password (scrypt-hashed)** | The socket-local prompt phase gives us a clean place to ask for proof-of-identity            |

**Why the split matters:** On networks where a single vhost persists across nick changes (notably Rizon), the hostmask `*!~ident@vhost.cloak` identifies the _cloak_, not the user. An operator identified on their registered nick can `/nick` to an unregistered nick, keep the same cloak, and match any hostmask pattern that accepts the cloak. For in-channel commands this is inherent to the network — we mitigate with `require_acc_for` and account-tag matching. For DCC CHAT we have a better option: the bot holds its own secret (the password hash), independent of the network's notion of identity.

**Password handling:**

- Stored via scrypt (`src/core/password.ts`) with a 16-byte random salt and N=16384/r=8/p=1 parameters. Format prefix `scrypt$` so future rotation to argon2 is unambiguous.
- Set via `.chpass` from the REPL or from inside an existing DCC session. The IRC PRIVMSG path is hard-rejected — passwords never travel over channel messages.
- Minimum length 8 characters. No additional policy — operators are responsible for their own hygiene on a small admin user base.
- Never logged. `mod_log` records `(action=chpass, target=<handle>, by=<source>)` with no plaintext or hash material.

**Plaintext over DCC:** The password is sent in the clear over the DCC TCP connection. This is the same failure mode as NickServ IDENTIFY on most networks — a passive observer of the socket already sees every subsequent command, so the password adds no incremental exposure. TLS DCC (DCC SCHAT) is out of scope. Operators who need end-to-end encryption should run a bot-to-user TLS tunnel at the transport layer.

**CTCP offer race:** A passive DCC handshake opens a TCP listener and advertises the port via CTCP. The first TCP connection is accepted, regardless of source IP. An attacker who observes the CTCP exchange and reaches the bot's IP could race to connect before the legitimate user — but they would then hit the password prompt and fail. This is a material improvement over the pre-0.3.0 model where a racer would inherit the legitimate user's session on connect.

**Mitigations in place:**

- The listening port is open for only 30 seconds before timing out.
- The listener accepts exactly one connection, then closes.
- Permission flags are checked before the port is offered.
- The session enters an `awaiting_password` phase on connect — no commands run, no party-line broadcast, until the prompt succeeds.
- Repeated bad-password attempts from the same hostmask trigger a per-identity lockout with exponential backoff (`DCCAuthTracker`).
- Session limits cap total concurrent DCC sessions.
- Users with no `password_hash` on file are rejected at connect with a migration notice pointing at `.chpass`.

**Rule:** Administrators should treat the DCC password as the root of trust for remote administration and rotate it periodically. Hostmask patterns on a handle are still required for the DCC path to _find_ the user, but they no longer _authorize_ the connection.

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

**Enforcement:** The plugin loader validates exports. The scoped `PluginAPI` object returned by `createPluginApi()` is frozen at the top level via `Object.freeze(api)`, and every sub-object (`db`, `permissions`, `services`, `banStore`, `botConfig`, `config`, `channelSettings`) is individually `Object.freeze()`-d. Database namespace isolation is enforced at the `BotDatabase` class level — every plugin DB call is scoped to `pluginId` as the namespace, not by convention. The plugin-facing `botConfig` is a separate `PluginBotConfig` view with the NickServ password omitted and filesystem paths (`database`, `pluginDir`) excluded.

### 4.2 Plugin error containment

- A thrown error in a plugin handler MUST NOT crash the bot or prevent other handlers from firing
- The dispatcher wraps every handler call in try/catch and logs the error with `(pluginId, type:mask)` context
- A plugin that throws repeatedly should be logged but not auto-unloaded (that's an admin decision)

### 4.3 Plugin resource cleanup

- `teardown()` must be called on unload — if it throws, log the error but continue the unload
- `dispatcher.unbindAll(pluginId)` must remove ALL binds including timers
- Help registry entries, channel setting definitions, channel setting change listeners, and `onModesReady` event listeners are all removed on unload
- Timer intervals that aren't cleaned up will leak and accumulate on reload

---

## 5. Output safety

### 5.1 IRC message limits

- IRC messages are limited to ~512 bytes including protocol overhead
- The bot's own prefix (`nick!ident@host`) is prepended by the server, consuming ~60-100 bytes
- **Rule:** Split long replies at word boundaries. Never send unbounded output. `splitMessage()` (`src/utils/split-message.ts`) handles this automatically — it measures UTF-8 byte length (not JavaScript string length), preserves surrogate pairs, and caps output at 4 lines with `" ..."` truncation.
- The message queue (`src/core/message-queue.ts`) rate-limits outbound messages to avoid flood disconnects — configurable via `config.queue` (default: 2 msg/sec, burst of 4). Messages are distributed across targets via per-target round-robin sub-queues.

### 5.2 No user-controlled formatting in sensitive output

Don't let user input appear in contexts where IRC formatting codes could mislead:

```typescript
// BAD: user controls the nick display in a trust-relevant context
api.say(channel, `User ${nick} has been granted ops`);
// An attacker could set nick to include IRC color codes to hide/fake the message

// GOOD: use the shared utility from PluginAPI
api.say(channel, `User ${api.stripFormatting(nick)} has been granted ops`);
```

`api.stripFormatting(text)` removes all IRC control characters (bold `\x02`, color `\x03`, hex color `\x04`, italic `\x1D`, underline `\x1F`, strikethrough `\x1E`, monospace `\x11`, reset `\x0F`, reverse `\x16`) including color/hex-color parameters (e.g., `\x03` followed by `12,4` or `\x04` followed by `FF0000,00FF00`). Apply it to any user-controlled string appearing in:

- Permission grant/revoke announcements
- Op/kick/ban action messages
- Any console or log output that contains user-supplied data

### 5.3 Logging

- Log mod actions (op, deop, kick, ban) to `mod_log` with who triggered them
- Log permission changes (adduser, deluser, flag changes) with the source (REPL or IRC + nick)
- Never log passwords, SASL credentials, or NickServ passwords — even at debug level
- Sanitize nick/channel in log output to prevent log injection (strip control characters)

The full audit contract — schema, action vocabulary, plugin author rules, the `.modlog` / `.audit-tail` operator UI, and the retention story — lives in [docs/AUDIT.md](AUDIT.md).

---

## 6. Configuration security

- High-value secrets are **never** stored inline in `config/bot.json`. Each secret field is named via a `<field>_env` suffix that points to an environment variable; the loader resolves it from `process.env` at startup. Fields covered: `services.password_env` (NickServ/SASL password), `botlink.password_env` (bot-link shared secret), `chanmod.nick_recovery_password_env` (NickServ GHOST password), `proxy.password_env` (SOCKS5 auth). See [docs/plans/config-secrets-env.md](plans/config-secrets-env.md) for the full spec.
- **SASL PLAIN over plaintext is refused.** The bot will not start if `services.sasl` is `true`, `sasl_mechanism` is `"PLAIN"` (the default), and `irc.tls` is `false`. SASL PLAIN over cleartext leaks the NickServ password on the wire. Either enable TLS or use `sasl_mechanism: "EXTERNAL"` with a client certificate.
- **SASL EXTERNAL (CertFP)** is the most secure authentication method: no password at all. Set `services.sasl_mechanism: "EXTERNAL"` and configure `irc.tls_cert` + `irc.tls_key` pointing to PEM files. The bot authenticates via the TLS client certificate fingerprint registered with NickServ.
- **SASL authentication failure is a fatal exit, not a retry loop.** When the server rejects the SASL credential (numeric 904) or advertises no acceptable mechanism (numeric 908), the reconnect driver exits the process with code 2 instead of retrying. Retrying a bad password against services — especially on networks with failure counters — risks the account being locked or flagged. The operator must fix the credential in `.env`, then the supervisor can restart the bot. TLS certificate errors (`unable to verify the first certificate`, hostname mismatch, expired cert) are treated the same way: permanent until config changes. See `src/core/reconnect-driver.ts` and DESIGN.md §5 for the full tiering.
- **Channel `+k` keys are an exception**: they're low-sensitivity join tokens shared with every channel member and visible to any channel op via `/mode`. They may live inline on a channel entry (`{"name": "#chan", "key": "..."}`). For operators who want them out of the config anyway, `key_env` is available as an alternative.
- `.env` files hold the actual secret values and MUST be in `.gitignore` (they are, via `.env` and `.env.*` patterns).
- `config/bot.json` still MUST be in `.gitignore` — while it no longer contains secrets directly, it does contain operational details (hostmasks, connection details) that should not be public.
- Example configs (`config/bot.example.json`, `config/bot.env.example`) must never contain real credentials. By construction, `*.example.json` can only reference env var _names_, not secrets.
- The bot refuses to start if `config/bot.json` is world-readable. Apply the same `chmod 600` to `.env*` files.
- Startup validation enforces that every enabled feature has its required env var set — the bot fails loudly with the exact var name when a secret is missing (see `validateResolvedSecrets` in `src/config.ts`).

### 6.1 Env var handling

- **Plugins must never read `process.env` directly.** Declare a `<field>_env` field in the plugin's `config.json` (or in the `plugins.json` override) and read `api.config.<field>` from init. The loader resolves the env var before the plugin sees its config. Plugins reading `process.env` can exfiltrate unrelated ambient secrets (AWS keys, cloud provider creds) that don't belong to the bot.
- Never log resolved secret values, even at debug level. Log the env var name instead if a breadcrumb is useful ("HEX_NICKSERV_PASSWORD missing" — not the value).
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
| `services.sasl_mechanism`  | `"PLAIN"`      | Falls back to EXTERNAL (CertFP) if configured               |
| SASL PLAIN + plaintext     | **Refused**    | Bot refuses to start if SASL PLAIN is used without TLS      |
| `irc.tls`                  | `true`         | Encrypted connection by default                             |
| IRCv3 STS                  | Enforced       | Persisted per-host; prevents TLS downgrade on reconnect     |
| Admin commands flag        | `+n`           | Only owner can run admin commands                           |
| `.help` flag               | `-`            | Help is available to everyone (no info leak risk)           |
| Plugin API `permissions`   | Read-only      | Plugins can check flags but not grant them                  |
| Plugin API object          | Frozen         | `Object.freeze()` on the API and all sub-objects            |

---

## 8. IRCv3 message tags — trust model

IRCv3 message tags carry metadata alongside messages. Their trust level depends on who set them:

| Tag type             | Prefix | Trust level                                | Examples                   |
| -------------------- | ------ | ------------------------------------------ | -------------------------- |
| **Server tags**      | none   | Server-verified — may be trusted           | `time`, `account`, `msgid` |
| **Client-only tags** | `+`    | Completely untrusted — treat as user input | `+draft/react`, `+typing`  |

**Rule:** Client-only tags (prefixed `+`) are relayed verbatim by the server without modification. An attacker can set any client-only tag to any value. Never use client-only tag values for security decisions.

**Rule:** The `account` server tag (when present) identifies the sender's services account. It may be treated as server-verified, but only when the server has enabled the `account-tag` capability. HexBot's IRC bridge reads the `account` tag from inbound events via `extractAccountTag()` and feeds it into the live account map (used by the dispatcher's ACC verification fast path) and into `ctx.account` for handler access.

```typescript
// BAD: reading a client-only tag as authoritative
const userRole = ctx.tags?.['+role']; // attacker can set this to anything

// GOOD: read user flags from the permissions system
const record = api.permissions.findByHostmask(`${ctx.nick}!${ctx.ident}@${ctx.hostname}`);
```

## 9. IRCv3 Strict Transport Security (STS)

HexBot implements IRCv3 STS (`src/core/sts.ts`) — the IRC equivalent of HTTP HSTS. Once the bot receives a valid STS directive from a server (via `CAP LS`), it persists the policy in the `_sts` database namespace and enforces it on all subsequent connections:

- **On TLS:** The server advertises `sts=duration=<N>`. The bot records the policy; it will refuse to downgrade to plaintext until the duration expires.
- **On plaintext:** The server advertises `sts=port=<P>,duration=<N>`. The bot immediately disconnects and reconnects on the TLS port. If the config later changes to `tls: false`, the bot upgrades automatically or refuses to start if no port is known.
- **Policy expiry:** `duration=0` clears the stored policy. Non-zero durations are honored even across bot restarts (SQLite persistence).

**Why this matters:** Without STS, a MitM who intercepts DNS or performs a captive-portal downgrade sees every SASL PLAIN credential, every message, and every op action in cleartext. The SASL PLAIN + plaintext refusal (section 6) is the first defence; STS closes the reconnect-after-restart gap.

## 10. Input flood protection

### 10.1 Command flood limiting

The dispatcher (`src/dispatcher.ts`) implements per-user sliding-window flood protection, configured via `config.flood`:

- `pub`: limits channel commands (pub + pubm share one counter)
- `msg`: limits private message commands (msg + msgm share one counter)
- Users with the `n` (owner) flag bypass flood protection entirely
- On the first blocked message per window, the bot sends a one-time NOTICE warning to the user
- Flood checking runs **once per IRC message** in the bridge, before the paired dispatch calls — if blocked, both dispatch calls are skipped

### 10.2 CTCP rate limiting

The IRC bridge rate-limits CTCP responses to 3 per sender per 10 seconds. The rate limit is keyed on `ident@host` (the persistent portion of the identity), not on the nick alone, so an attacker cannot bypass the limit by rotating nicks during a CTCP flood.

### 10.3 Output flood protection

The message queue (`src/core/message-queue.ts`) enforces a configurable token-bucket rate limit on outbound messages (default: 2 msg/sec steady-state, burst of 4). Messages are queued per-target in round-robin sub-queues, preventing a single noisy channel from starving others. Long replies are automatically split by `splitMessage()` and capped at 4 lines per reply.

## 11. Bot linking security

The bot link protocol (`src/core/botlink-protocol.ts`, `src/core/botlink-hub.ts`, `src/core/botlink-leaf.ts`) introduces a trusted TCP channel between bots. Security considerations:

### Trust model

**Hub-authoritative.** The hub is the single source of truth for permissions and executes all relayed commands. A compromised hub means total compromise of the botnet. Leaves trust frames from the hub unconditionally (permission syncs, command results, party line messages).

**Leaf trust is limited.** The hub validates leaf identity via password hash and enforces rate limits. Hub-only frame types (`CMD`, `CMD_RESULT`, `BSAY`, `RELAY_*`, `PROTECT_ACK`, `ADDUSER`, `SETFLAGS`, `DELUSER`, `PARTY_WHOM`) are never fanned out to other leaves — the hub processes them internally. Permission-mutation frames (`ADDUSER`, `SETFLAGS`, `DELUSER`) are hub-only by design: if a leaf could fan them out, a compromised leaf could inject owner-level permissions across the entire botnet.

### Authentication

Bot link uses an **HMAC challenge-response handshake**:

1. Hub accepts the TCP connection and immediately sends `HELLO_CHALLENGE { nonce }` — a freshly-generated 32-byte random nonce, hex-encoded.
2. Leaf derives a per-botnet key via `scrypt(password, link_salt)`, HMAC-SHA256s the nonce with that key, and replies with `HELLO { botname, hmac }`.
3. Hub re-derives the same key from its own config, recomputes the HMAC, and compares with `timingSafeEqual`. A mismatch produces `AUTH_FAILED` and the connection is closed.

The password is **never transmitted**, not even hashed. Each connection uses a fresh nonce, so a captured HELLO frame is useless on a new connection — replay is structurally impossible.

**Per-botnet salt.** `botlink.link_salt` in `bot.json` is a ≥ 32-hex-character (16-byte) value shared by every bot in a botnet. It is not secret on its own, but combined with the password it produces a per-deployment key that a canned wordlist cannot reuse across botnets. Generate with `openssl rand -hex 32`. Bots with mismatched salts cannot authenticate each other — the botnet must upgrade in lockstep.

### Auth brute-force protection

The hub tracks per-IP auth failures and temporarily bans IPs that exceed the threshold:

- After `max_auth_failures` (default 5) within `auth_window_ms` (default 60s), the IP is banned for `auth_ban_duration_ms` (default 5 minutes).
- Ban duration **doubles on each re-ban** (5m → 10m → 20m → …), capped at 24 hours. The tracker entry never resets — persistent scanners stay at the 24h ceiling.
- Banned IPs are rejected **before any protocol setup** — no readline allocation, no scrypt, no timer. Zero resource cost.
- Per-IP `max_pending_handshakes` (default 3) limits concurrent unauthenticated connections from the same source.
- Handshake timeout is configurable via `handshake_timeout_ms` (default 10s). Connections that don't send `HELLO` in time are closed.
- `auth_ip_whitelist` accepts CIDR strings (e.g., `["10.0.0.0/8"]`) whose IPs bypass all auth rate limiting.
- `auth:ban` events are emitted on the EventBus with the IP, failure count, and ban duration.
- Source IP is included in all auth-related log lines (failure, success, ban, timeout).

**Defense in depth:** Application-level protection complements but does not replace network-level controls. For production hubs exposed beyond localhost, use firewall rules or a VPN in addition to these settings.

### Frame validation

- All string values in incoming frames are sanitized (stripped of `\r`, `\n`, `\0`) via `sanitizeFrame()` before processing.
- Frame size is capped at 64KB. Oversized frames are protocol errors and cause immediate disconnect.
- Per-frame rate limiting (per leaf, 1-second window): `CMD` 10/s (ERROR reply on overflow); `PARTY_CHAT` 5/s; `PROTECT_*` 20/s; `BSAY` 10/s (one-shot `[security]` warning on first drop); `ANNOUNCE` 5/s; `RELAY_INPUT` / `RELAY_OUTPUT` 30/s; `PARTY_JOIN` / `PARTY_PART` 5/s. All non-CMD overflows are silent drops.
- **BSAY re-check.** Every BSAY frame carries `fromHandle`. Before fanout the hub re-runs `permissions.checkFlagsByHandle(fromHandle, 'm', channel)` — channel-scoped when the BSAY target is a channel, global when it is a PM nick. Missing `fromHandle` or a handle without `+m` drops the frame with a `[security]` audit line. A compromised leaf cannot assemble a raw BSAY under another user's authority.

### Relay sessions

When a DCC user runs `.relay <botname>`, their input is proxied to the remote bot. The remote bot trusts the originating bot's authentication — it does not re-verify the user's identity. This means:

- A relay session inherits the permissions of the user's handle on the **hub's** permission database.
- If the user is removed from the hub's permissions while relaying, the relay continues until explicitly ended.
- **Hub-side session gate.** The hub registers a relay only when the originating leaf has a live DCC party session for the handle (`hasRemoteSession`). A compromised leaf cannot otherwise `RELAY_REQUEST` into any handle known to the target bot and execute commands under that handle's identity. Rejection replies with `RELAY_END { reason: "No active DCC party session..." }` and logs a `[security]` warning.

### Protection frames

`PROTECT_TAKEOVER` and `PROTECT_REGAIN` frames request cross-network channel protection from peers. The receiving bot verifies the requested nick exists in its local permissions database before acting. Protection frames cannot be used to op arbitrary nicks — only known users.

### Network considerations

- **Bot link connections are unencrypted TCP.** Authentication is replay-resistant (HMAC over a fresh per-connection nonce — see above), but the payload after handshake is not. Command frames, party-line chat, and `BSAY` messages travel in the clear.
- **Mandatory tunnel for WAN.** For any deployment that crosses untrusted networks, bot-link traffic must travel inside a WireGuard / OpenVPN / SSH tunnel. Running bot-link directly over the public internet is an unsupported configuration regardless of password strength.
- **`listen.host` defaults to `127.0.0.1`.** The hub binds loopback by default. When the resolved bind address is neither loopback (`127.0.0.0/8`, `::1`) nor RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), hub startup logs a `[security]` warning naming the address and pointing at the tunnel requirement. Operators who intentionally bind `0.0.0.0` must have a tunnel in front.

## 12. Security checklist for code review

Use this checklist when reviewing any PR or code change:

- [ ] All IRC input is validated before use (nicks, channels, message text)
- [ ] No newlines (`\r`, `\n`, `\0`) in values passed to `raw()` or interpolated into IRC protocol strings — use `sanitize()` from `src/utils/sanitize.ts`
- [ ] Database operations use parameterized queries (no string concatenation in SQL)
- [ ] Permissions are checked before privileged actions
- [ ] NickServ verification is awaited (not skipped) for flagged operations when configured — the dispatcher enforces this automatically via the `VerificationProvider` gate
- [ ] Plugin uses only the scoped API, no direct imports from `src/`
- [ ] Plugin does not read `process.env` directly — declare `<field>_env` in config and read from `api.config`
- [ ] Long output is split and rate-limited
- [ ] Errors in handlers are caught and don't crash the bot
- [ ] No secrets in logged output — log env var names, not values
- [ ] Config examples contain no real credentials
- [ ] Hostmask patterns for privileged users are specific (not `nick!*@*`) — prefer `$a:accountname` patterns where services are available
- [ ] `stripFormatting()` applied to user-controlled strings in security-relevant output (permission grants, op/kick/ban messages, log entries)
