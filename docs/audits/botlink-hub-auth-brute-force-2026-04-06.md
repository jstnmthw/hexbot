# Security Audit: BotLink Hub — Auth Brute-Force Protection

**Date:** 2026-04-06
**Scope:** `src/core/botlink-hub.ts` connection handling and authentication, `src/core/botlink-protocol.ts` auth helpers
**Trigger:** Observed repeated auth failure probes from external scanners against production hub

## Summary

The botlink hub has **zero protection against brute-force authentication attempts**. Any host that can reach the hub's TCP port can make unlimited rapid connection attempts with no throttling, banning, or even IP-level logging. The password is hashed with scrypt (good), but online brute-force against the hub endpoint itself is completely unchecked.

The user's logs show exactly this pattern — ~5 attempts/second from a scanner trying common botnet leaf names.

**Findings:** 1 critical, 2 warning, 1 info

## Findings

### [CRITICAL] No brute-force protection on auth endpoint

**File:** `src/core/botlink-hub.ts:409-441` (`handleConnection`) and `src/core/botlink-hub.ts:443-452` (`handleHello`)
**Category:** DoS / Credential brute-force

**Description:** Every TCP connection is accepted unconditionally. On auth failure, the hub logs a warning and closes the socket — but keeps no record of the source IP, attempt count, or timing. An attacker can:

1. Open connections at network speed (~hundreds/sec)
2. Send `HELLO` frames with different passwords
3. Each attempt costs the hub: socket accept → readline setup → JSON parse → scrypt hash comparison → log write → close
4. The scrypt comparison on each attempt is CPU-expensive by design (that's its purpose for offline hashes, but here it becomes a resource cost the attacker forces the hub to pay)

There is no:

- Per-IP connection rate limiting
- Temporary ban after N failures
- Escalating backoff
- Connection tracking of any kind

**The current code path:**

```
TCP connect → handleConnection() → wait for HELLO frame
  → handleHello() → password !== expectedHash
    → log warn (botname only, no IP) → send AUTH_FAILED → close
    → attacker immediately reconnects, repeat forever
```

**Remediation:** Implement a per-IP auth failure tracker with automatic temporary bans. Recommended approach:

```typescript
interface AuthTracker {
  failures: number;
  firstFailure: number;
  bannedUntil: number;
}

// In BotLinkHub class:
private authTracker: Map<string, AuthTracker> = new Map();
```

In `handleConnection()`, before setting up the handshake:

1. Read `socket.remoteAddress`
2. If the IP is currently banned (`bannedUntil > Date.now()`), immediately destroy the socket — no handshake, no scrypt, no log spam
3. On auth failure in `handleHello()`, increment the failure counter for that IP
4. After `max_auth_failures` (default: 5) within `auth_window_ms` (default: 60000), ban the IP for `auth_ban_duration_ms` (default: 300000 / 5 min), escalating on repeat offenses
5. Periodically sweep stale entries from the map (e.g., on each new connection, prune entries older than the ban window)

Config additions to `BotlinkConfig`:

```typescript
max_auth_failures?: number;      // default 5
auth_window_ms?: number;         // default 60_000
auth_ban_duration_ms?: number;   // default 300_000
```

**Decisions:** Exact IP tracking (no prefix grouping). Ban duration doubles on each re-ban, capped at 24h to prevent integer overflow — tracker entry never resets, so a persistent scanner stays at the 24h ceiling indefinitely. Whitelisted CIDRs bypass the tracker entirely.

**Recommended phased solution:**

- [ ] Add `AuthTracker` interface and `authTracker: Map<string, AuthTracker>` to `BotLinkHub`
- [ ] Read `socket.remoteAddress` in `handleConnection()`; skip tracker for IPs matching `auth_ip_whitelist` CIDRs
- [ ] If IP is currently banned (`bannedUntil > Date.now()`), immediately destroy socket — no handshake, no scrypt
- [ ] On auth failure in `handleHello()`, increment per-IP failure counter; ban after `max_auth_failures` within `auth_window_ms`
- [ ] Escalating ban duration: double on each re-ban, cap at 24h, no reset (5m → 10m → 20m → … → 24h ceiling)
- [ ] Add config knobs to `BotlinkConfig`: `max_auth_failures`, `auth_window_ms`, `auth_ban_duration_ms`, `auth_ip_whitelist`
- [ ] Emit `auth:ban` and `auth:unban` events on the EventBus (IP, failure count, ban duration)
- [ ] Periodic stale-entry sweep (prune expired non-escalated entries on each new connection)
- [ ] Add tests: failure counting, ban enforcement, ban expiry, escalation doubling, whitelist bypass, EventBus emission, config overrides

---

### [WARNING] Auth failure logs omit source IP

**File:** `src/core/botlink-hub.ts:449`
**Category:** Logging / Incident response

**Description:** The auth failure log line is:

```typescript
this.logger?.warn(`Auth failed for "${botname}"`);
```

The `botname` is attacker-controlled (it's from the HELLO frame). The actual source IP (`socket.remoteAddress`) is never logged. This means:

- Admins can't correlate failures to a source without packet captures or external firewall logs
- The botname in the log is whatever the scanner chose to send — it could be misleading (e.g., matching a real leaf name)
- External fail2ban rules can't parse the IP from the log line

**Remediation:** Include the source IP in auth failure (and success) log lines:

```typescript
const ip = protocol.remoteAddress; // expose from BotLinkProtocol
this.logger?.warn(`Auth failed for "${botname}" from ${ip}`);
```

Also log on successful auth:

```typescript
this.logger?.info(`Leaf "${botname}" connected from ${ip}`);
```

**Recommended phased solution:**

- [ ] Add `get remoteAddress()` getter to `BotLinkProtocol` exposing `this.socket.remoteAddress`
- [ ] Include source IP in auth failure log: `Auth failed for "${botname}" from ${ip}`
- [ ] Include source IP in auth success log: `Leaf "${botname}" connected from ${ip}`
- [ ] Add tests verifying IP presence in log output

---

### [WARNING] Handshake timeout still costs resources during flood

**File:** `src/core/botlink-hub.ts:414-421`
**Category:** DoS

**Description:** Each connection gets a 30-second handshake timer. During a flood of connections that never send HELLO (slowloris-style), each connection holds a socket, a readline interface, and a timer for up to 30 seconds. With hundreds of concurrent connections, this consumes file descriptors and memory.

The brute-force protection from the CRITICAL finding would partially mitigate this (banned IPs get immediately dropped), but connections from unbanned IPs that never complete the handshake still linger.

**Remediation:**

- The per-IP ban from the critical fix is the primary mitigation
- Optionally add a `max_pending_handshakes` limit (default: 20) — reject new connections beyond this until pending ones time out or complete
- Consider reducing `HANDSHAKE_TIMEOUT_MS` from 30s to 10s for the auth phase specifically (legitimate leaves should HELLO within milliseconds)

**Decisions:** Per-IP pending handshake cap (not global). Handshake timeout configurable via config.

**Recommended phased solution:**

- [ ] (Covered by CRITICAL fix) Banned IPs dropped before handshake setup
- [ ] Add per-IP `max_pending_handshakes` counter (default: 3) to `BotLinkHub`; reject new connections from the same IP when limit reached
- [ ] Make handshake timeout configurable via `handshake_timeout_ms` in `BotlinkConfig`; reduce default to 10s
- [ ] Add tests: per-IP pending handshake limit enforcement, timeout behavior, config override

---

### [INFO] No connection event logging for monitoring

**File:** `src/core/botlink-hub.ts:409`
**Category:** Observability

**Description:** New TCP connections are not logged at all until authentication succeeds or fails. A connection that arrives and hangs (no HELLO, no close) is invisible until the 30s timeout fires. Adding a debug-level log on connection accept (with IP) would help correlate network events.

**Remediation:**

```typescript
private handleConnection(socket: Socket): void {
  const ip = socket.remoteAddress ?? 'unknown';
  this.logger?.debug(`New connection from ${ip}`);
  // ... existing logic
}
```

**Recommended phased solution:**

- [ ] Add `debug`-level log on connection accept: `New connection from ${ip}`
- [ ] Add `debug`-level log on handshake timeout: `Handshake timeout for ${ip}`

## Passed checks

- **Password never sent in plaintext** — scrypt hash is used over the wire
- **HANDSHAKE_TIMEOUT_MS** exists (30s) — prevents connections from hanging forever
- **max_leaves** cap prevents unbounded authenticated leaf connections
- **Frame size limit** (64KB) prevents oversized frame attacks
- **Frame sanitization** strips injection characters from all string values
- **Rate limiting** on CMD/PARTY_CHAT/PROTECT frames after authentication

## Recommendations

1. **Implement per-IP auth failure tracking with temp bans** — this is the critical fix. The implementation is straightforward (~50 lines) and would have prevented the probe activity the user observed.

2. **Expose source IP in BotLinkProtocol** — add a `get remoteAddress()` getter that returns `this.socket.remoteAddress`. Use it in all connection-related log lines.

3. **Add config knobs** for auth rate limiting — `max_auth_failures`, `auth_window_ms`, `auth_ban_duration_ms` in `BotlinkConfig`. Sensible defaults mean most users never touch these.

4. **Consider `max_pending_handshakes`** — secondary defense against connection floods.

5. **Document in SECURITY.md §9** — add a subsection on auth brute-force protection and the recommended deployment practice of firewall rules in addition to the application-level protection.
