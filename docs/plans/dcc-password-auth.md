# Plan: DCC CHAT Password Authentication

## Summary

Replace HexBot's hostmask-trust model for DCC CHAT with Eggdrop-style per-user password authentication. Passwords are PBKDF2-hashed in the user record, prompted for on DCC connect, and set/rotated via a `.chpass` command available in the REPL and inside existing DCC sessions. Hostmask patterns are **demoted** from authentication to handle-lookup for the DCC path — they still identify which handle is claiming to connect, but no longer _authorize_ the connection. `nickserv_verify` is removed from the DCC path entirely.

In-channel flag checks (for `.op`, `.say`, plugin `pub` binds, etc.) are **unchanged** — they continue to use hostmask + IRCv3 account-tag matching, because prompting for a password on every channel message is not a workable UX. DCC is the special case because it has a socket-local prompt channel.

Bot-link auth was audited and is already scrypt-based (`src/core/botlink-auth.ts`) — out of scope for this plan.

## Motivation

The current DCC auth model (`src/core/dcc.ts:740-789`) trusts `nick!ident@host` to identify the user. This breaks on any network where the vhost survives nick changes (confirmed on Rizon): an operator identified on their registered nick can `/nick` to an unregistered nick, keep the same vhost, and pass DCC auth as a different identity. The optional `nickserv_verify` knob closes this on Rizon but is impossible on services-free networks like EFNet, and defaults to off.

The principled fix is the model Eggdrop has used for 30 years: the bot holds its own secret (the password hash), and that secret is the trust root. The network's notion of identity becomes a convenience lookup, not an authorization boundary. This works uniformly across EFNet, Rizon, Libera, and every private network, with no per-network trust tiers to configure.

## Feasibility

- **Alignment:** The DCC session already has a state machine and a socket-local prompt channel — adding an "awaiting password" phase is additive, not invasive. `UserRecord` (`src/types.ts:481`) gains one optional field. `.chpass` is a new command but follows the existing command-handler pattern used by `.adduser`/`.flags`.
- **Dependencies:** `node:crypto` ships PBKDF2; no new npm packages. The existing `BotLinkAuthManager` uses scrypt — we will use scrypt too for consistency across the codebase.
- **Blockers:** None technical. The only non-trivial decision is the migration story for existing user records — resolved: strict (no password → no DCC).
- **Complexity estimate:** M (a day of focused work — schema change, state machine phase, two commands, doc updates, tests).
- **Risk areas:**
  - **Owner lockout on upgrade.** First-run after this lands, existing user records have no `password_hash`. DCC access is blocked until an admin runs `.chpass <handle> <newpass>` from the REPL. This must be loudly documented in CHANGELOG and GETTING_STARTED.
  - **Password in plaintext over the DCC socket.** DCC CHAT is plain TCP on most clients. This is no worse than NickServ IDENTIFY and is the industry norm, but worth flagging in docs. DCC SCHAT (TLS) is orthogonal and out of scope.
  - **Failed-password lockout.** Without rate limiting, a compromised hostmask match lets an attacker brute-force the password at socket speed. Need a per-hostmask attempt counter with exponential backoff, following the pattern in `botlink-auth.ts`.
  - **Test coverage.** The DCC session state machine is one of the few places in the codebase with real TCP wiring. Tests must use mock sockets (see `tests/helpers/mock-socket.ts`).
- **Breaking change:** Yes. Target `0.3.0`, not a patch release. CHANGELOG must lead with the migration note.

## Dependencies

- [x] `src/core/dcc.ts` — existing DCC session machine
- [x] `src/types.ts` — `UserRecord` interface
- [x] `src/core/permissions.ts` — `findByHostmask`, user storage
- [x] `src/database.ts` — user record persistence (already stores `hostmasks` as JSON in `users` table)
- [x] `src/command-handler.ts` — command routing (used by REPL and DCC alike)
- [x] `node:crypto` — `scrypt`, `timingSafeEqual`, `randomBytes` (no new deps)
- [x] `tests/helpers/mock-socket.ts` — TCP mocking for DCC tests

## Phases

### Phase 1: Password storage primitive

**Goal:** Add a small module that hashes and verifies passwords. Reused by `.chpass` and the DCC prompt.

- [ ] Create `src/core/password.ts` with three pure functions:
  - `hashPassword(plaintext: string): Promise<string>` — generates 16-byte salt, runs scrypt (N=16384, r=8, p=1, 64-byte key), returns `scrypt$<salt_hex>$<hash_hex>` format string
  - `verifyPassword(plaintext: string, stored: string): Promise<boolean>` — parses stored format, runs scrypt, compares via `timingSafeEqual`
  - `isValidPasswordFormat(stored: string): boolean` — sanity check for the stored format
- [ ] Format is prefixed with `scrypt$` so future migration to argon2 or rotation of scrypt parameters is possible without ambiguity
- [ ] Minimum password length: 8 characters. Reject shorter in `hashPassword` with a thrown error.
- [ ] Unit tests in `tests/core/password.test.ts`:
  - Hash round-trips (hash + verify with correct password → true)
  - Wrong password → false
  - Tampered stored format → `isValidPasswordFormat` returns false
  - Short password → throws
  - Two hashes of the same password produce different stored values (salt works)

### Phase 2: UserRecord schema change

**Goal:** Add optional `password_hash` field to `UserRecord`, persist it, make sure it's never logged or exposed via the plugin API.

- [ ] Update `src/types.ts` — add `password_hash?: string` to `UserRecord`
- [ ] Update `src/database.ts` — `users` table gains a `password_hash TEXT` column. Add migration in the schema-version bump logic (check if the column exists via `PRAGMA table_info` and `ALTER TABLE ADD COLUMN` if missing).
- [ ] Update `src/core/permissions.ts` — load/persist `password_hash` alongside other fields. Ensure `findByHostmask` still returns the full record (it does, since it returns a reference).
- [ ] **Never expose `password_hash` through `PluginPermissions`** — it must be stripped or the interface must only expose fields plugins need. Add a dedicated type `PublicUserRecord` if needed.
- [ ] Audit all logging sites that touch a `UserRecord` — confirm none serialize the whole record. Add a `.redacted()` helper or rely on an explicit field allowlist.
- [ ] Unit tests in `tests/core/permissions.test.ts`:
  - Add user with password, round-trip through database, verify `password_hash` persists
  - Existing users (no hash) still load correctly
  - `PluginPermissions.findByHostmask` does not expose the hash

### Phase 3: `.chpass` command

**Goal:** Allow operators to set and rotate passwords from the REPL and from inside an active DCC session.

- [ ] Create `src/core/commands/password-commands.ts` with a single `.chpass` command
- [ ] Syntax: `.chpass <handle> <newpass>` (for admins rotating others') and `.chpass <newpass>` (for the current user rotating their own)
- [ ] Permission model:
  - REPL: implicit owner can rotate anyone's password
  - DCC: `+n` (owner) can rotate anyone; `+m` (master) can rotate their own
  - IRC: **command is rejected** with a clear error — passwords must never be sent over IRC PRIVMSG, even to the bot. Only REPL and DCC are valid transports.
- [ ] Refuse to set a password for a handle with no hostmask patterns (would be unrecoverable if the pattern is wrong)
- [ ] Log the rotation (handle, `set_by`, timestamp) to `mod_log` — **never log the plaintext or the hash**
- [ ] Unit tests in `tests/core/commands/password-commands.test.ts`:
  - REPL can rotate any handle
  - DCC owner can rotate any handle; DCC master can rotate only their own
  - IRC PRIVMSG path is rejected with a specific error
  - Short password is rejected with a specific error
  - Unknown handle is rejected with a specific error

### Phase 4: DCC session state machine — add the prompt phase

**Goal:** After the TCP connection is accepted, the session enters an `awaiting_password` phase. It reads one line, verifies it, and either proceeds to the normal command prompt or disconnects. Existing DCC tests continue to pass with a test helper that pre-answers the prompt.

- [ ] Add a `phase: 'awaiting_password' | 'active'` field to the DCC session type (`src/core/dcc.ts`)
- [ ] On socket connect, if the matched `UserRecord` has **no** `password_hash`:
  - Send a clear notice: `"DCC CHAT: this handle has no password set. Ask an admin to run .chpass <handle> <newpass> from the REPL, then reconnect."`
  - Disconnect immediately. Do **not** proceed into the session. This is the strict migration behavior.
- [ ] If the record has a `password_hash`:
  - Send `Password: ` (no newline — prompt style) to the socket
  - Set `phase = 'awaiting_password'`
  - Consume the first line received, pass to `verifyPassword`
  - On success: send banner, set `phase = 'active'`, broadcast `*** <handle> has joined the console` to other sessions
  - On failure: send `DCC CHAT: bad password.`, increment failure counter, disconnect
- [ ] Reject further input during `awaiting_password` phase — no command parsing, no console broadcast
- [ ] Idle timeout during `awaiting_password` is shorter (30s) than active timeout — kill stalled prompts quickly
- [ ] Input handling during prompt phase must disable echo concerns (the IRC client receives characters but DCC CHAT has no line-editing protocol — just trust the client to send one line)
- [ ] **Rate limiting:** per-hostmask failure counter with exponential backoff. Follow the pattern in `src/core/botlink-auth.ts` — track failures by IP (or hostmask for DCC), escalate lockout duration. Reset on successful auth.
- [ ] Update `tests/core/dcc.test.ts`:
  - Connect with correct password → session opens
  - Connect with wrong password → rejected, failure count incremented
  - Connect with no `password_hash` → rejected with migration notice
  - Repeated failures → lockout kicks in
  - Existing "happy path" tests use a helper that auto-answers the prompt

### Phase 5: Remove `nickserv_verify` from DCC

**Goal:** Delete the now-dead code path. The setting stays in config as a no-op for one release with a deprecation warning, then is removed in the next.

- [ ] Delete the `checkNickServVerify` call in the DCC accept path (`src/core/dcc.ts:782-789`)
- [ ] Keep the `nickserv_verify` field in config schema for `0.3.0` — if present and true, log a warning on startup: `[dcc] nickserv_verify is deprecated and no longer used — DCC now requires per-user passwords. See docs/DCC.md.`
- [ ] Remove the field entirely in `0.4.0` (tracked in a follow-up, not this plan)
- [ ] Update `tests/core/dcc.test.ts` — remove tests for `nickserv_verify`, add a test for the deprecation warning

### Phase 6: Documentation

**Goal:** Every doc that describes DCC auth reflects the new model. No mixed signals.

- [ ] Rewrite `docs/DCC.md`:
  - Prerequisites section: add "Set a password" step between "add yourself" and "connect"
  - Security notes: replace "hostmask-based authentication" language with "per-user password authentication, following the Eggdrop model"
  - Remove the `nickserv_verify` row from the config table (or mark as deprecated)
  - Add a `.chpass` subsection with usage examples
- [ ] Update `DESIGN.md`:
  - Section 2.6 (Permissions): clarify hostmask patterns are the auth model for **in-channel** flag checks, passwords are the auth model for **DCC** sessions
  - Section 2.15 (DCC CHAT): update "hostmask auth" to "password auth"
  - Table in §"What HexBot borrows from Eggdrop" (line ~766) now gains "per-user DCC password authentication"
- [ ] Update `docs/SECURITY.md`:
  - Add a section on the trust model split (hostmask for in-channel, password for DCC) and why
  - Add a note about DCC plaintext exposure and how it compares to NickServ IDENTIFY
- [ ] Update `docs/GETTING_STARTED.md`:
  - Walkthrough for the first-DCC-connect flow now includes setting a password from the REPL
- [ ] Update `CHANGELOG.md` under `0.3.0`:
  - Lead with **BREAKING**: DCC CHAT now requires per-user passwords
  - Migration steps: for each admin in your user database, run `.chpass <handle> <newpass>` from the REPL before they will be able to connect via DCC
  - Rationale paragraph linking to the Rizon vhost issue
- [ ] Update `README.md` if the DCC section claims hostmask-only auth

### Phase 7: Manual verification

**Goal:** Confirm the flow works end-to-end against a real IRC client before tagging the release.

- [ ] Run the bot locally, `.chpass` an existing test user, attempt DCC from irssi — should prompt and accept
- [ ] Attempt DCC with wrong password — should reject cleanly
- [ ] Attempt DCC with a user that has no `password_hash` — should reject with the migration notice
- [ ] Attempt DCC with matching hostmask but a nick-change that would have bypassed the old model — should still require the password (confirms the Rizon attack is closed)
- [ ] Rotate a password from inside a DCC session using `.chpass`, reconnect with the new one
- [ ] Verify no plaintext passwords anywhere in logs (grep the log file after the test session)

## Out of scope

- **Universal password auth for in-channel commands.** In-channel commands keep hostmask + account-tag auth. A future plan could add an "IDENTIFY via /msg" session model, but the UX cost is high and the threat model doesn't justify it for command paths that are already one-line, rate-limited, and flag-gated.
- **DCC SCHAT / TLS DCC.** The plaintext-over-TCP concern is legitimate but orthogonal. Worth a separate plan if it matters to a deployment.
- **Bot-link auth.** Already scrypt-hashed shared secret via `BotLinkAuthManager`. Audited 2026-04-13 — no action needed.
- **Password recovery via email or IRC.** Not a concept in HexBot. REPL is the recovery path.
- **Password strength policies beyond minimum length.** 8 characters minimum. Operators are responsible for their own password hygiene. Extensive policy (uppercase/digit/symbol requirements) adds friction without meaningful security for a small admin user base.

## Success criteria

- Every DCC CHAT session authenticates via password or is rejected
- `nickserv_verify` is no longer referenced in the DCC code path
- Hostmask patterns still work for in-channel flag checks (no regression in `tests/core/permissions.test.ts`)
- A user with a matching hostmask but no `password_hash` cannot open a DCC session
- A user on Rizon who nick-changes under the same vhost cannot bypass auth (demonstrable via the reproducer from the 2026-04-13 investigation)
- The full test suite passes (`pnpm test`)
- Docs are consistent across `DCC.md`, `DESIGN.md`, `SECURITY.md`, `GETTING_STARTED.md`, `CHANGELOG.md`, `README.md`
