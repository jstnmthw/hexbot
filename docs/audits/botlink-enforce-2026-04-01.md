# Security Audit: Bot Linking + Refactored Mode Enforcement

**Date:** 2026-04-01
**Scope:** Bot-link protocol (hub/leaf TCP linking), protection frames, command relay, party line, ban sharing, session relay, refactored channel mode enforcement
**Files audited:**

- `src/core/botlink.ts`, `src/core/botlink-protect.ts`, `src/core/botlink-sharing.ts`, `src/core/botlink-sync.ts`
- `src/bot.ts` (botlink wiring: handleIncomingBotlinkFrame, handleRelayFrame, handleProtectFrame)
- `src/core/commands/botlink-commands.ts`
- `src/core/irc-commands.ts` (sendMode path)
- `plugins/chanmod/mode-enforce.ts` (refactored enforcement)

## Summary

The bot-link feature correctly sanitizes all frame string fields (`sanitizeFrame()` strips `\r\n\0`) and authenticates leaves via SHA-256 password hash. All findings have been remediated: PROTECT*\* frames now gate on the permissions DB, the hub enforces authenticated identity on `fromBot` fields, CMD relay verifies active party line sessions, ban masks are validated, party line messages are stripped of IRC formatting, and PROTECT*\* frames are rate-limited.

**Findings:** 1 critical, 5 warning, 4 info — **all resolved**

## Findings

### [CRITICAL-1] PROTECT_DEOP/KICK/UNBAN/INVITE lack permission checks

**File:** `src/core/botlink-protect.ts:61-79`
**Category:** Permissions

**Description:** Only `PROTECT_OP` checks the permissions DB before acting. The other four frame types execute unconditionally when the bot has ops:

- `PROTECT_DEOP`: deops any nick
- `PROTECT_KICK`: kicks any nick with attacker-controlled reason
- `PROTECT_UNBAN`: removes any ban mask
- `PROTECT_INVITE`: invites any nick (doesn't even require ops)

A compromised leaf can deop legitimate ops, kick users, clear bans, and invite attackers.

**Remediation:** Add guards:

- `PROTECT_DEOP`/`PROTECT_KICK`: reject if target nick IS in the permissions DB with op flags (prevent friendly fire)
- `PROTECT_UNBAN`: verify the requesting bot is a known linked bot (already guaranteed by protocol, but add explicit check)
- `PROTECT_INVITE`: require bot to have ops (currently missing)

---

### [WARNING-1] Hub does not enforce `fromBot` identity on frames

**File:** `src/core/botlink.ts:644-656`
**Category:** Input validation

**Description:** The hub uses `frame.fromBot` as-is for party line tracking, relay routing, and DCC announcements. A malicious leaf "evil-leaf" can send `PARTY_CHAT` with `fromBot: "trusted-leaf"`, spoofing messages from a different bot.

**Remediation:** In `onSteadyState`, overwrite `frame.fromBot` with the authenticated `botname` for all frame types that use it:

```typescript
if ('fromBot' in frame) frame.fromBot = botname;
```

---

### [WARNING-2] Relay session handle forgery enables privilege escalation

**File:** `src/bot.ts:591-606`
**Category:** Permissions

**Description:** `RELAY_INPUT` executes commands using the `handle` from the original `RELAY_REQUEST` frame. A compromised leaf can send `RELAY_REQUEST` with `handle: "owner"` and then execute commands with owner-level privileges.

**Remediation:** Use `source: 'botlink'` (not `'dcc'`) for relay command execution so the command handler can distinguish relay sessions. Alternatively, verify the handle has an active DCC session on the requesting leaf via party line state.

---

### [WARNING-3] CMD frame `fromHandle` trusted without session verification

**File:** `src/core/botlink.ts:355-407`
**Category:** Permissions

**Description:** The hub validates that `fromHandle` has the required flags in its permissions DB (correct), but doesn't verify the leaf actually authenticated this user. A compromised leaf can send CMD frames with any handle that has sufficient flags.

**Mitigating factor:** The flag check itself is sound — only handles with the required flags succeed. Risk is limited to compromised leaves knowing valid privileged handles.

**Remediation:** Track active DCC sessions per leaf (via `PARTY_JOIN`/`PARTY_PART`). Only accept CMD frames where `fromHandle` has an active session on `fromBot`.

---

### [WARNING-4] `sendMode` via `client.mode()` skips `sanitize()`

**File:** `src/core/irc-commands.ts:161-163`
**Category:** Input validation

**Description:** The `client.mode()` path does not call `sanitize()` on parameters, while the `client.raw()` fallback does. All `PROTECT_*` actions and mode enforcement flow through this path.

**Remediation:** Apply `sanitize()` before `client.mode()`:

```typescript
this.client.mode(sanitize(channel), sanitize(mode), sanitize(param));
```

---

### [WARNING-5] Ban mask injection — no format validation

**File:** `src/core/botlink-sharing.ts:140-146`
**Category:** Input validation

**Description:** `CHAN_BAN_ADD` stores arbitrary mask strings with no format validation. While ban enforcement from shared frames is not yet wired up (the return value is discarded in `bot.ts`), when it is connected, a malicious leaf could inject `*!*@*` to ban everyone.

**Remediation:** Validate ban masks contain `!` and `@`. Reject overly broad patterns like `*!*@*`.

---

### [INFO-1] Party line messages allow IRC formatting injection

**File:** `src/bot.ts:666-668`
**Category:** Output safety

**Description:** `PARTY_CHAT` messages are delivered to DCC sessions without stripping IRC formatting codes (`\x02`, `\x03`, etc.). A malicious leaf can send bold/colored text to confuse or mislead DCC users.

**Remediation:** Strip IRC formatting from party line messages, or prefix remote messages distinctly.

---

### [INFO-2] SHA-256 authentication is replay-vulnerable without TLS

**File:** `src/core/botlink.ts:42-44, 1002-1008`
**Category:** Credentials

**Description:** The SHA-256 hash of the shared password is static. An eavesdropper on the network can capture and replay it. Already documented in the plan as a known limitation.

**Remediation:** Document that TLS is required for untrusted networks. Future: implement HMAC challenge-response.

---

### [INFO-3] Mode war cooldown can be exhausted to suppress enforcement

**File:** `plugins/chanmod/mode-enforce.ts:355-365`
**Category:** IRC-specific

**Description:** An attacker with ops can trigger `MAX_ENFORCEMENTS` deops to exhaust the cooldown, then deop the target for real while the bot has suppressed enforcement. The `punishDeop` feature mitigates this when `protect_ops` is enabled.

**Remediation:** Consider escalating after cooldown (this is the intended integration point with the future takeover detection system).

---

### [INFO-4] PROTECT\_\* frames have no rate limiting

**File:** `src/core/botlink.ts:622-632`
**Category:** DoS

**Description:** PROTECT\_\* bypasses rate limiting by design (for speed during takeover response). A compromised leaf could flood these to trigger excess flood on IRC.

**Remediation:** Add a generous rate limit (e.g., 20/sec) — fast enough for real takeover response but capping pathological abuse.

## Passed checks

- **Frame sanitization**: `sanitizeFrame()` correctly strips `\r\n\0` from all string fields in incoming frames
- **Password never logged**: Confirmed — password field masked in all debug output
- **Handshake sequencing**: Frames before HELLO are rejected; duplicate botnames rejected; max_leaves enforced
- **nodesynch exemption**: Correctly uses `api.ircLower()` for case-insensitive comparison
- **Mode enforcement delays**: All enforcement uses `enforce_delay_ms` timer, preventing instant mode wars
- **Bot self-exemption**: `isBotNick()` checks prevent the bot from enforcing against its own mode changes
- **Sync frame validation**: `ChannelStateSyncer` and `PermissionSyncer` use `String()` coercion and `Array.isArray()` guards
- **DB isolation**: Bot-link sync uses `permissions.syncUser()` / `permissions.removeUser()` — the proper API, not direct DB access

## Remediation Status

All findings resolved:

| #          | Severity | Status         | Fix                                                                                                                                       |
| ---------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL-1 | CRITICAL | **FIXED**      | PROTECT_DEOP/KICK gate on permissions DB (refuse recognized users); PROTECT_INVITE requires ops                                           |
| WARNING-1  | WARNING  | **FIXED**      | Hub overwrites `frame.fromBot` with authenticated `botname` in `onSteadyState`                                                            |
| WARNING-2  | WARNING  | **FIXED**      | Relay command execution uses `source: 'botlink'` instead of `source: 'dcc'`                                                               |
| WARNING-3  | WARNING  | **FIXED**      | CMD relay verifies `fromHandle` has active party line session on the sending leaf via `remotePartyUsers`                                  |
| WARNING-4  | WARNING  | **FIXED**      | `sendMode()` applies `sanitize()` to all params on the `client.mode()` path                                                               |
| WARNING-5  | WARNING  | **FIXED**      | Ban masks validated: must contain `!` and `@`, rejects `*!*@*`. Applied to CHAN_BAN_ADD, CHAN_BAN_SYNC, CHAN_EXEMPT_ADD, CHAN_EXEMPT_SYNC |
| INFO-1     | INFO     | **FIXED**      | Party line messages stripped of IRC formatting codes via `stripFormatting()` on handle, botname, and message fields                       |
| INFO-2     | INFO     | **DOCUMENTED** | Already documented in `docs/BOTLINK.md` security notes: TLS recommended, HMAC planned                                                     |
| INFO-3     | INFO     | **BY DESIGN**  | Mode war cooldown is the integration point for future takeover detection system (escalation, not surrender)                               |
| INFO-4     | INFO     | **FIXED**      | PROTECT\_\* frames rate-limited at 20/sec per leaf via `protectRate` counter on `LeafConnection`                                          |
