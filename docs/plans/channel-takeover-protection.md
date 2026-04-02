# Plan: ChanServ-Based Channel Takeover Protection

## Summary

Extend chanmod's protection capabilities to defend against coordinated channel takeover attempts by hostile users who gain ops. The current protections (chanserv*op, rejoin_on_kick, bitch mode, protect_ops) handle isolated incidents but fail against a determined attacker who simultaneously deops the bot, bans it, mass-deops friendly ops, and locks down the channel. This plan adds a ProtectionBackend abstraction with ChanServ implementations for both Atheme and Anope, takeover threat detection with automatic escalation, and recovery procedures that leverage the bot's ChanServ access level — the key being that the bot \_must* have ChanServ flags (not just IRC ops) to use ChanServ services.

## Services Landscape

Research into active IRC services packages identified six distinct channel service implementations across major networks. This plan implements Atheme and Anope (which together cover the vast majority of modern networks). The ProtectionBackend abstraction makes future backends straightforward.

### Atheme (Libera Chat, OFTC, many others)

Flag-based access via `ChanServ FLAGS`. Each flag character controls a specific capability.

**XOP template → flag mappings (defaults):**

| Template | Flags              | Key capabilities                                 |
| -------- | ------------------ | ------------------------------------------------ |
| VOP      | `+AV`              | Auto-voice, view access list                     |
| HOP      | `+AHehitrv`        | Halfop, invite, topic, kick/ban, unban self      |
| AOP      | `+AOehiortv`       | Auto-op, op self/others, unban, invite, kick/ban |
| SOP      | `+AOaefhiorstv`    | All AOP + protect, set, flag management          |
| Founder  | `+AFORaefhioqrstv` | All + RECOVER (`+R`), CLEAR (`+R`), owner        |

**Critical insight:** RECOVER and CLEAR require the `+R` flag, which is **founder-only** in default Atheme templates. SOP does not have `+R`. This means only founder-level access can execute RECOVER.

**Key commands and required flags:**

| Command     | Syntax                                       | Required flag               | Notes                                                                                                                                  |
| ----------- | -------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OP          | `OP #chan [nick]`                            | `+o`                        | Omit nick to op self                                                                                                                   |
| DEOP        | `DEOP #chan [nick]`                          | `+o`                        | Cannot deop services bots (7.2+)                                                                                                       |
| UNBAN       | `UNBAN #chan [nick\|mask]`                   | `+r` (others) / `+e` (self) | Removes all matching bans                                                                                                              |
| INVITE      | `INVITE #chan`                               | `+i`                        | Self-invite only                                                                                                                       |
| GETKEY      | `GETKEY #chan`                               | `+i`                        | Returns current +k value                                                                                                               |
| AKICK       | `AKICK #chan ADD mask [!P\|!T dur] [reason]` | `+r`                        | `!P` permanent, `!T 5d` timed                                                                                                          |
| RECOVER     | `RECOVER #chan`                              | `+R`                        | **Founder only.** Deops all, clears +l/+k, unbans requester, sets +i +m, invites requester. If already in channel: just ops requester. |
| CLEAR BANS  | `CLEAR #chan BANS [types]`                   | `+R`                        | Types: `e` (excepts), `I` (invex), `*` (all lists)                                                                                     |
| CLEAR USERS | `CLEAR #chan USERS [reason]`                 | `+R`                        | Kicks all users except requester                                                                                                       |
| FLAGS       | `FLAGS #chan [target [changes]]`             | `+A` (view) / `+f` (modify) | For access verification probe                                                                                                          |

**RECOVER side effects (complete sequence):**

1. Deops everyone (+ clears +q/+a on supporting IRCds, 7.2+)
2. Clears channel limit (+l) and key (+k)
3. Removes all bans matching the requester
4. Adds ban exception (+e) for the requester
5. Sets +i (invite-only) and +m (moderated)
6. Invites the requester

### Anope (UnrealIRCd, InspIRCd, many others)

Supports three parallel access systems: XOP (named tiers), numerical levels, and flags (2.x+).

**XOP tier → privileges:**

| Tier    | Level | Key privileges                                       |
| ------- | ----- | ---------------------------------------------------- |
| VOP     | 3     | Auto-voice, fantasy commands                         |
| HOP     | 4     | Halfop, ban, kick, unban                             |
| AOP     | 5     | Auto-op, op self, invite, getkey, topic              |
| SOP     | 10    | Op others, akick, access management, protect         |
| QOP     | 9999  | Mode locks, channel settings, assign bots (2.x only) |
| Founder | 10000 | Everything including CLEAR, DROP                     |

**Critical difference from Atheme: Anope has NO RECOVER command.** To achieve equivalent recovery, the bot must synthesize a multi-step sequence:

1. `MODE #chan CLEAR ops` (or 1.x: `CLEAR #chan OPS`) — requires founder/QOP
2. `UNBAN #chan` — requires HOP+
3. `INVITE #chan` — requires AOP+
4. `OP #chan` — requires AOP+

**Key commands and required levels:**

| Command    | Syntax                          | Required level            | Notes                             |
| ---------- | ------------------------------- | ------------------------- | --------------------------------- |
| OP         | `OP #chan [nick]`               | AOP (self) / SOP (others) |                                   |
| DEOP       | `DEOP #chan [nick]`             | AOP (self) / SOP (others) |                                   |
| UNBAN      | `UNBAN #chan [nick]`            | HOP (level 4)             | Removes all matching bans         |
| INVITE     | `INVITE #chan [nick]`           | AOP (level 5)             |                                   |
| GETKEY     | `GETKEY #chan`                  | AOP (level 5)             |                                   |
| AKICK      | `AKICK #chan ADD mask [reason]` | SOP (level 10)            | Also: STICK/UNSTICK/ENFORCE/CLEAR |
| MODE CLEAR | `MODE #chan CLEAR [what]`       | QOP/Founder (9999)        | 2.x only. 1.x: `CLEAR #chan OPS`  |
| ACCESS     | `ACCESS #chan LIST`             | Any with access           | For access verification probe     |

**AKICK extras (Anope-specific):**

- `AKICK #chan ENFORCE` — immediately applies AKICK list to current members
- `AKICK #chan STICK mask` — makes ban "sticky" (re-applied if removed)

### Future backends (not in this plan)

| Service             | Network               | Nick       | Access model                             | Recovery approach                                                                                  | Users (2026) |
| ------------------- | --------------------- | ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ |
| **X** (GNUworld)    | Undernet              | `X`        | Numeric 0-500                            | NOTAKE + TAKEREVENGE + MASSDEOPPRO + CLEARMODE. X is permanently in-channel and cannot be deopped. | ~19,400      |
| **Q** (newserv)     | QuakeNet              | `Q`        | Flags (+n/+m/+o/+v)                      | `RECOVER` = DEOPALL + UNBANALL + CLEARCHAN (requires +m)                                           | ~5,700       |
| **ChanServ**        | DALnet                | `ChanServ` | Role hierarchy (Founder>Manager>SOP>AOP) | MKICK (nuclear: empties channel, sets +i +l1, bans `*!*@*`), MDEOP, OPGUARD                        | ~6,500       |
| **ChanServ** (srvx) | GameSurge             | `ChanServ` | Numeric 1-500                            | UP/UPALL (self-op), standard OP/BAN                                                                | ~1,800       |
| **Botnet**          | Non-services networks | N/A        | HexBot flags                             | Coordinated multi-bot response (see bot-linking.md)                                                | N/A          |

**Key architectural differences that future backends must account for:**

- Undernet X: sits permanently in-channel, has its own anti-takeover (NOTAKE/MASSDEOPPRO), login-based auth (`LOGIN user pass`), no NickServ
- QuakeNet Q: flag-based like Atheme but different flags, auth-based (`AUTH user pass`), no NickServ
- DALnet: password-based channel identification (`IDENTIFY #chan pass`), unique MKICK nuclear option
- GameSurge: no nick registration, AuthServ-based, `UP/DOWN` self-op model
- **Botnet (HexBot bot-linking)**: No external services dependency. Peer bots in the same channel can re-op the local bot directly via IRC MODE. Recovery is fast (no services round-trip) but limited — peer bots can only act if they have ops themselves. If all linked bots are deopped simultaneously, botnet recovery fails and must escalate to ChanServ. See "Escalation Chain" design decision below.

### Botnet as a ProtectionBackend

The bot-linking feature (see `docs/plans/bot-linking.md`) provides the transport layer for a `BotnetBackend` that implements the same `ProtectionBackend` interface as Atheme/Anope. This is how Eggdrop has historically defended channels on networks without services (EFNet, IRCnet) — and it remains valuable even on networks WITH services because peer re-op is faster than a ChanServ round-trip.

**How a BotnetBackend maps to the interface:**

| Method                       | Botnet implementation                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `requestOp(channel, nick)`   | Ask a linked bot that has ops in the channel to `MODE #chan +o nick`                         |
| `requestDeop(channel, nick)` | Ask an opped peer to `MODE #chan -o nick`                                                    |
| `requestUnban(channel)`      | Ask an opped peer to find and remove bans matching the local bot                             |
| `requestInvite(channel)`     | Ask a peer to `INVITE #chan localbot`                                                        |
| `requestRecover(channel)`    | Coordinated: peer deops hostiles, unbans local bot, re-ops local bot (multi-step like Anope) |
| `canOp/canDeop/etc.`         | True if any linked bot has ops in the channel                                                |
| `verifyAccess(channel)`      | Check linked bots' op status in the channel via synced channel state                         |

**Key differences from ChanServ backends:**

- **No persistent authority** — peer bots only work if at least one has ops. A coordinated mass-deop defeats all peers simultaneously.
- **No AKICK equivalent** — botnet can kick+ban but the ban isn't enforced by services. The attacker can rejoin unless a ChanServ AKICK is also applied.
- **Faster response** — no services message queue or processing delay. Peer op is a single MODE command.
- **No RECOVER** — there is no nuclear "reset the channel" option. Recovery is always incremental (deop hostiles one by one, re-op friendlies).
- **Distributed resilience** — even if the local bot is kicked+banned, a peer bot can unban and invite it back without any services dependency.

## Feasibility

- **Alignment**: Fits cleanly within the existing chanmod plugin architecture. All protection logic already lives in `plugins/chanmod/protection.ts` and `mode-enforce.ts`. New features extend these modules and add a services command layer. No DESIGN.md changes needed.
- **Dependencies**: Requires existing `services.ts` (NickServ), `channel-state.ts`, `irc-commands.ts`, and the chanmod plugin infrastructure. All are built and stable.
- **Blockers**: None. The existing `chanserv_op` setting proves the ChanServ integration point already works.
- **Complexity**: **L** (days) — multiple interacting subsystems (detection, backend abstraction, recovery state machine, Atheme/Anope command differences, tests).
- **Risk areas**:
  - **ChanServ response parsing**: Atheme and Anope use different response formats for FLAGS/ACCESS queries. Verification probe parsing must handle both, plus graceful degradation when responses are unexpected (custom services configurations, non-standard modules).
  - **Race conditions**: During a takeover, events arrive rapidly and out of order. The detection window and response queue must handle overlapping events without duplicating actions or creating mode wars.
  - **Flood protection**: ChanServ recovery commands bypass the message queue for speed. Volume is low (2-3 messages for Atheme, 4-5 for Anope's synthetic RECOVER) so server-side flood throttling is not a concern, but if multiple channels are attacked simultaneously the total burst could be higher. The implementation should coalesce concurrent recovery actions.
  - **Anope synthetic RECOVER**: Since Anope has no single RECOVER command, the multi-step sequence (CLEAR ops → UNBAN → INVITE → OP) has inherent timing gaps. Each step depends on ChanServ processing the previous one. Need brief delays between steps (~200ms) and failure handling at each stage.
  - **Atheme RECOVER side effects**: RECOVER sets +i +m which makes the channel unusable. The bot must automatically remove these after recovery completes. This is a mandatory post-recovery step.
  - **False positives**: A legitimate mass mode change (e.g., ChanServ syncing after netsplit) shouldn't trigger takeover response. nodesynch_nicks must be respected.
  - **Idempotency**: Recovery actions must be safe to repeat — requesting OP when already opped, unbanning when not banned, etc.
  - **Template customization**: Network admins can customize Atheme XOP templates and Anope privilege levels. Our access tier mapping assumes defaults. The auto-verify probe catches mismatches, but operators with custom templates should use the raw flag config option (future enhancement) or adjust their `.chanset` accordingly.
  - **Botnet escalation timing**: The escalation chain must not introduce perceptible delay when a backend can't act. If botnet has no opped peers, `canOp()` must return false instantly (from cached channel state) so ChanServ is tried without waiting. The `ProtectionChain` should never await a backend that can answer synchronously.
  - **Duplicate actions across backends**: If botnet `requestOp()` succeeds but the response hasn't arrived yet, and the chain falls through to ChanServ which also sends OP — the bot gets opped twice (harmless but noisy). Acceptable for now; the chain can be made smarter later by tracking pending requests.

## Dependencies

- [x] chanmod plugin with protection.ts, mode-enforce.ts, helpers.ts
- [x] Services core module (NickServ integration pattern to follow for ChanServ)
- [x] Channel state tracking (users, modes, ops)
- [x] Per-channel settings system (channelSettings)
- [x] Message queue for flood-safe output

## Design Decisions

These decisions were resolved before implementation:

1. **ChanServ access discovery**: Config-primary with auto-verify. The operator declares the access level via `.chanset chanserv_access`. On first join, the bot verifies the declared level by sending a probe command (Atheme: `FLAGS #channel`; Anope: `ACCESS #channel LIST`) and warns if the configured level exceeds actual access. This catches misconfiguration without adding parsing complexity to the hot path.

2. **Message queue strategy**: ChanServ recovery commands bypass the message queue entirely via direct `api.say()`. No core module changes needed. Volume is 2-3 messages for Atheme, 4-5 for Anope's synthetic RECOVER — far too low to trigger server-side flood throttling.

3. **Topic recovery**: Included in this plan. Each channel tracks a "known-good" topic snapshot. After takeover recovery, the bot restores the pre-attack topic if it was changed during the threat window. Gated on a `topic_protect` per-channel setting.

4. **Protection backend abstraction**: We define a `ProtectionBackend` interface (`requestOps`, `requestUnban`, `requestRecover`, etc.) and implement concrete backends. The takeover logic calls the backend interface only — it never knows whether it's talking to ChanServ, a peer bot, or both. Atheme and Anope are implemented in this plan. The interface is explicitly designed to accommodate a `BotnetBackend` (see bot-linking.md) where peer bots fulfill the same operations via direct IRC commands rather than services messages.

5. **Escalation chain (Eggdrop-inspired)**: Protection responses follow an ordered escalation chain rather than dispatching to a single backend. Each level is attempted in order; if a level cannot act (e.g., no peers have ops, or ChanServ access is 'none'), it is skipped and the next level is tried:

   | Priority | Source                  | Method                                         | Speed             | Authority                     | When it fails                    |
   | -------- | ----------------------- | ---------------------------------------------- | ----------------- | ----------------------------- | -------------------------------- |
   | 1        | **Direct IRC**          | Bot issues MODE commands itself                | Instant           | Requires bot to have ops      | Bot was deopped                  |
   | 2        | **Botnet peers**        | Linked bot with ops acts on behalf             | Fast (~100ms)     | Requires any peer to have ops | All peers deopped simultaneously |
   | 3        | **ChanServ (standard)** | `OP`, `UNBAN`, `INVITE`, `DEOP`                | Moderate (~500ms) | Requires declared access tier | Access level insufficient        |
   | 4        | **ChanServ (nuclear)**  | `RECOVER` (Atheme) / synthetic RECOVER (Anope) | Slow (~1-2s)      | Requires founder access       | Not founder, or services down    |

   The `MAX_ENFORCEMENTS` suppression in `mode-enforce.ts` is the trigger for escalation: when direct IRC enforcement is suppressed (3 attempts in 10s), this signals that something is fighting back and the system should escalate to the next available level rather than give up. The threat detection system (Phase 2) consumes this suppression event as a threat score input.

   **Multiple backends can be active simultaneously.** On a network with both linked bots and ChanServ, the escalation chain tries botnet first (faster, no services dependency) and ChanServ second (higher authority, persistent enforcement). The `ProtectionChain` wrapper iterates backends in priority order, calling `can*()` on each to find the first that can act.

   This mirrors Eggdrop's philosophy: **escalate, don't surrender.** The bot should always have a next move. The only true dead end is when all backends are exhausted and the channel is lost — and even then, the bot should log the failure and retry on a longer timer (ChanServ may have been temporarily unreachable).

6. **RECOVER across services**: Atheme has a native `RECOVER` command (founder only, `+R` flag). Anope does not — we synthesize it from `MODE CLEAR ops` + `UNBAN` + `INVITE` + `OP` (requires QOP/founder for MODE CLEAR). Both paths are encapsulated behind `requestRecover()` in their respective backends, so the takeover logic doesn't need to know which services package is running. The botnet backend has no RECOVER equivalent — recovery is always incremental.

7. **Access tier model**: Three tiers map to both Atheme flags and Anope levels:

   | Tier      | Atheme flags (default XOP)     | Anope level     | Available commands                               |
   | --------- | ------------------------------ | --------------- | ------------------------------------------------ |
   | `op`      | AOP: `+o +i +r +e +t`          | AOP (5)         | OP self/others, UNBAN, INVITE, GETKEY, AKICK     |
   | `superop` | SOP: `+o +i +r +e +t +a +f +s` | SOP (10)        | All `op` + DEOP others, FLAGS mgmt, SET, PROTECT |
   | `founder` | Founder: `+R +F` + all         | Founder (10000) | All + RECOVER, CLEAR, everything                 |

   Note: Atheme's RECOVER/CLEAR require `+R` which is founder-only by default. Some networks grant `+R` to SOP — the auto-verify probe will detect this and allow `superop` to use RECOVER on those networks.

## Phases

### Phase 1: ProtectionBackend Interface + Atheme/Anope Implementations

**Goal:** Create an abstract protection backend interface and implement it for both Atheme and Anope, gating commands on the bot's declared access level with auto-verification on join.

- [ ] Define `ProtectionBackend` interface in `plugins/chanmod/protection-backend.ts`:

  ```typescript
  type BackendAccess = 'none' | 'op' | 'superop' | 'founder';

  interface ProtectionBackend {
    /** Backend identifier — 'atheme' | 'anope' | 'botnet' | future backends */
    readonly name: string;
    /** Priority in the escalation chain (lower = tried first). Botnet: 1, ChanServ: 2. */
    readonly priority: number;
    canOp(channel: string): boolean;
    canDeop(channel: string): boolean;
    canUnban(channel: string): boolean;
    canInvite(channel: string): boolean;
    canRecover(channel: string): boolean;
    canClearBans(channel: string): boolean;
    /** Persistent ban enforcement (ChanServ AKICK). Botnet returns false. */
    canAkick(channel: string): boolean;
    requestOp(channel: string, nick?: string): void;
    requestDeop(channel: string, nick: string): void;
    requestUnban(channel: string): void;
    requestInvite(channel: string): void;
    /** Full channel recovery. Atheme: RECOVER. Anope: synthetic multi-step. Botnet: incremental. */
    requestRecover(channel: string): void;
    requestClearBans(channel: string): void;
    requestAkick(channel: string, mask: string, reason?: string): void;
    /** Verify actual access level (called on bot join). ChanServ: probe FLAGS/ACCESS. Botnet: check peer ops. */
    verifyAccess(channel: string): void;
    /** Get the effective (possibly downgraded) access level for a channel. */
    getAccess(channel: string): BackendAccess;
  }
  ```

- [ ] Define `ProtectionChain` in `plugins/chanmod/protection-backend.ts` — wraps multiple backends in priority order:

  ```typescript
  class ProtectionChain {
    private backends: ProtectionBackend[]; // sorted by priority ascending

    /** Register a backend. Backends are tried in priority order. */
    addBackend(backend: ProtectionBackend): void;

    /**
     * For each can*/request* method: iterate backends in priority order,
     * call can*() on each, and dispatch to the first that returns true.
     * Returns true if any backend handled the request.
     *
     * Example: requestOp(channel) tries botnet first (priority 1),
     * falls back to ChanServ (priority 2) if no peer has ops.
     */
    requestOp(channel: string, nick?: string): boolean;
    requestDeop(channel: string, nick: string): boolean;
    // ... same pattern for all request* methods

    /** Returns the highest access level across all backends for a channel. */
    getAccess(channel: string): BackendAccess;

    /** Returns true if any backend can perform the operation. */
    canOp(channel: string): boolean;
    // ... same pattern for all can* methods
  }
  ```

  The takeover detection and recovery code calls `ProtectionChain` methods exclusively — it never references a specific backend. This ensures the escalation chain is always respected and adding a new backend is zero-touch for the takeover logic.

- [ ] Add `ChanServAccess` type and per-channel setting in `plugins/chanmod/state.ts`
- [ ] Create `plugins/chanmod/atheme-backend.ts` implementing `ProtectionBackend`:
  - Commands sent as `PRIVMSG ChanServ :<command> #channel [args]`
  - `requestRecover()`: sends `RECOVER #channel` (requires `+R` / founder)
  - `verifyAccess()`: sends `FLAGS #channel <bot_nick>`, parses response to check for `+o`, `+r`, `+R`, `+F` flags. Downgrades if configured level exceeds actual.
  - All `can*()` methods gate on the access tier:
    - `canOp/canUnban/canInvite/canAkick`: access >= 'op'
    - `canDeop/canClearBans`: access >= 'superop' (Atheme `+o` can deop, but we gate on superop for "deop others" semantics in takeover context)
    - `canRecover`: access >= 'founder' (unless verify detects `+R` at lower level)
- [ ] Create `plugins/chanmod/anope-backend.ts` implementing `ProtectionBackend`:
  - Commands sent as `PRIVMSG ChanServ :<command> #channel [args]`
  - `requestRecover()`: **synthetic multi-step sequence**:
    1. `MODE #channel CLEAR ops` (Anope 2.x) or `CLEAR #channel OPS` (1.x)
    2. Wait ~200ms
    3. `UNBAN #channel`
    4. `INVITE #channel`
    5. Wait ~200ms
    6. `OP #channel`
       Requires founder/QOP for MODE CLEAR step.
  - `requestAkick()`: includes Anope-specific `AKICK #chan ENFORCE` after ADD to immediately apply
  - `verifyAccess()`: sends `ACCESS #channel LIST`, parses response to find bot's level. Maps level to tier (5=op, 10=superop, 9999+=founder).
- [ ] Register `chanserv_access` as a per-channel setting (default: 'none')
- [ ] Add `chanserv_services_type` config option (default: inherit from `bot.json` `services.type`). Values: 'atheme' | 'anope'
- [ ] Wire `verifyAccess()` into the bot-join handler (existing auto-op.ts `isBotNick` path)
- [ ] Migrate existing `chanserv_op` logic in mode-enforce.ts to use `ProtectionChain.requestOp()` instead of direct ChanServ message
- [ ] **Verification**: Unit test each backend independently, plus chain behavior:
  - Each command produces correct PRIVMSG format
  - Commands gated on access level — 'op' can't RECOVER, 'none' can't OP
  - Atheme verify parses `FLAGS` response correctly
  - Anope verify parses `ACCESS LIST` response correctly
  - Verify downgrades on mismatch with warning log
  - Anope synthetic RECOVER sends correct multi-step sequence with timing
  - `ProtectionChain` dispatches to highest-priority backend that returns `can*() === true`
  - Chain falls through correctly when first backend can't act (e.g., botnet has no opped peers → ChanServ used)
  - Chain returns false when no backend can act (all exhausted)

### Phase 2: Takeover Threat Detection

**Goal:** Detect coordinated takeover attempts by watching for correlated hostile events within a short time window, producing a threat score that triggers escalating responses.

A single deop might be a prank. A simultaneous deop + mass deop of friendlies + mode lockdown is a takeover. We need to distinguish these.

- [ ] Create `plugins/chanmod/takeover-detect.ts` — threat assessment engine:
  - Per-channel rolling threat score with a configurable decay window (default 30s)
  - Events that contribute points to the threat score:
    | Event | Points | Description |
    |-------|--------|-------------|
    | Bot deopped by non-nodesynch | 3 | Direct attack on bot capabilities |
    | Bot kicked | 4 | Removal from channel |
    | Bot banned (detected via +b matching bot's hostmask) | 5 | Persistent removal |
    | Friendly op deopped | 2 each | Stripping allies' power |
    | Channel mode locked (+i, +k changed, +s) | 1 each | Locking out rejoins |
    | Unauthorized +o (bitch trigger) | 2 | Attacker opping allies |
    | Enforcement suppressed (MAX_ENFORCEMENTS hit) | 2 | Direct IRC enforcement failed — something is fighting back |
  - Threat level thresholds (configurable). At each level, the `ProtectionChain` is invoked — it tries backends in escalation order (botnet → ChanServ standard → ChanServ nuclear):
    | Level | Score | Name | Description |
    |-------|-------|------|-------------|
    | 0 | 0-2 | Normal | No action beyond existing direct IRC protections |
    | 1 | 3-5 | Alert | Chain.requestOp, re-op friendlies via first available backend |
    | 2 | 6-9 | Active | Chain.requestUnban, deop hostiles, Chain.requestAkick (ChanServ only — botnet has no AKICK) |
    | 3 | 10+ | Critical | Chain.requestRecover (ChanServ founder only), clear all unauthorized state. If no backend can recover, log and retry on timer |
  - `assessThreat(channel, event, points)` — add points, check thresholds, return current level
  - `getThreatLevel(channel)` — current threat level
  - `resetThreat(channel)` — decay/reset after threat window expires
  - Only score events from non-nodesynch, non-bot sources
- [ ] Wire threat detection into existing mode/kick/ban handlers — each relevant event calls `assessThreat()`
  - **Critical:** Wire `MAX_ENFORCEMENTS` suppression in `mode-enforce.ts` as a threat input. When enforcement is suppressed (line 359–361), call `assessThreat(channel, 'enforcement_suppressed', 2)` instead of just logging a warning and returning. This is the escalation trigger — direct IRC enforcement has failed, so the threat system should escalate to higher-authority backends (botnet peers, then ChanServ).
- [ ] Add threat state to `SharedState`:
  ```typescript
  interface ThreatEvent {
    type: string;
    actor: string;
    target?: string;
    timestamp: number;
  }
  threatScores: Map<string, { score: number; events: ThreatEvent[]; windowStart: number }>;
  ```
- [ ] **Verification**: Unit test threat scoring with simulated event sequences — verify single events stay at level 0, coordinated attacks escalate properly, scores decay after the window.

### Phase 3: Kick+Ban Recovery (the missing piece)

**Goal:** When the bot is kicked AND banned, automatically recover using the ProtectionBackend. This is the scenario the current code cannot handle.

Current flow when bot is kicked:

1. `protection.ts` kick handler fires → schedules rejoin after `rejoin_delay_ms`
2. Bot tries to rejoin → gets "banned from channel" error → stays out

New flow:

1. Kick handler fires → detects this is a configured channel
2. If `backend.canUnban(channel)`: immediately `backend.requestUnban(channel)` (no delay)
3. If channel had +i or +k changed (from last-known state): `backend.requestInvite(channel)`
4. After brief delay for services processing (~500ms): attempt rejoin
5. After successful rejoin: `backend.requestOp(channel)` to regain ops
6. After regaining ops: execute recovery actions based on threat level
7. **(Atheme only)** If RECOVER was used at level 3: remove the +i +m that RECOVER set

- [ ] Extend the kick handler in `protection.ts` to use the backend:
  - Immediately `backend.requestUnban()` if `backend.canUnban()` (no delay — speed matters)
  - If we detect +i was set or +k was changed (from channel state before kick): `backend.requestInvite()`
  - Rejoin attempt follows backend commands (brief delay for services processing, ~500ms)
  - Track the channel's last-known mode state so we know if +i/+k were set during the attack
- [ ] Listen for "banned_from_channel" (irc error) on rejoin failure:
  - If `backend.canUnban()` and we haven't already tried: `backend.requestUnban()` + retry
  - Backoff if repeated failures (don't spam services)
- [ ] Add post-RECOVER cleanup for Atheme: remove +i +m after the bot is opped, since RECOVER makes the channel unusable
- [ ] Add `chanserv_unban_on_kick` per-channel setting (default: true when chanserv_access != 'none')
- [ ] **Verification**: Test the full kick → UNBAN → rejoin → OP → recovery flow for both Atheme and Anope backends. Test Atheme post-RECOVER +i +m cleanup. Test that the bot handles ChanServ being unresponsive (timeout → log warning, don't loop).

### Phase 4: Post-Recovery Mass Re-Op

**Goal:** After the bot regains ops (via backend or any means during elevated threat), automatically re-op all friendly ops who were stripped during the attack.

- [ ] Add recovery handler triggered when bot receives +o during elevated threat level:
  - Scan channel users against permissions DB
  - Re-op all users who should have ops (based on op_flags) but currently don't
  - Re-halfop/re-voice similarly
  - Deop any unauthorized ops (bitch mode logic, but applied en masse)
  - All mode changes batched using ISUPPORT MODES limit for efficiency
- [ ] Add `mass_reop_on_recovery` per-channel setting (default: true)
- [ ] Batch mode changes efficiently — collect all needed +o/-o/+v/-v changes and send using `api.mode(channel, '+ooo', nick1, nick2, nick3)` respecting the server's modes-per-line limit
- [ ] **Verification**: Test that after recovery, all flagged users are re-opped and unauthorized ops are removed. Test that mode batching respects ISUPPORT MODES limit.

### Phase 5: Hostile Op Response (Active Defense)

**Goal:** At elevated threat levels, actively counter the hostile user who initiated the takeover.

- [ ] At threat level >= 2 (Active), after bot has ops:
  - Identify the hostile actor(s) from the threat event log
  - Deop hostile ops (`backend.requestDeop()` if superop+, or direct IRC DEOP if bot has ops)
  - At threat level 3 with superop+: `backend.requestAkick()` the primary attacker
  - Anope bonus: `AKICK #chan ENFORCE` to immediately apply the AKICK list
- [ ] Add `takeover_punish` per-channel setting: 'none' | 'deop' | 'kickban' | 'akick' (default: 'deop')
  - 'none': only recover, don't counter-attack
  - 'deop': strip attacker's ops
  - 'kickban': kick+ban the attacker
  - 'akick': backend.requestAkick (persistent, survives rejoin) — requires superop+
- [ ] Respect `revenge_exempt_flags` — users with n/m flags are never counter-attacked (prevents friendly fire from misconfigured bots)
- [ ] Log all takeover events and responses to mod_log for audit
- [ ] **Verification**: Test escalation matrix — verify each threat level triggers the correct response and exempt flags are respected. Test Anope AKICK ENFORCE.

### Phase 6: Topic Recovery

**Goal:** Save the pre-attack channel topic and restore it after takeover recovery if it was vandalized.

**Note:** This extends the existing `protect_topic` setting in the topic plugin rather than adding a new setting. The topic plugin's lock/unlock behavior is preserved; takeover recovery is an additional behavior when protect_topic is enabled.

- [ ] Extend existing `protect_topic` in the topic plugin (no new setting needed)
- [ ] Track "known-good" topic per channel in `SharedState`:

  ```typescript
  knownGoodTopics: Map<string, { topic: string; setAt: number }>;
  ```

  - Update the known-good snapshot whenever the topic is changed by a nodesynch nick, a user with op_flags, or when threat level is 0 (normal)
  - Freeze the snapshot when threat level > 0 — topic changes during elevated threat are considered vandalism

- [ ] After recovery (bot re-opped, threat level returning to 0):
  - If `topic_protect` is enabled and the current topic differs from the known-good snapshot, restore it via `api.topic(channel, savedTopic)`
  - Log the restoration
- [ ] **Verification**: Test that topic changes during normal operation update the snapshot. Test that topic changes during elevated threat are ignored. Test that post-recovery restores the pre-attack topic.

### Phase 7: Speed Optimization

**Goal:** Minimize response latency for all protective actions. During a takeover, every millisecond counts.

- [ ] Remove or reduce delays for backend commands during elevated threat:
  - `chanserv_op_delay_ms` should be 0 during threat level >= 1 (currently default 1000ms)
  - `enforce_delay_ms` should be 0 during threat level >= 1 (currently default 500ms)
  - Add `takeover_response_delay_ms` setting (default: 0) for recovery actions
- [ ] Backend commands during takeover bypass the message queue entirely (per design decision #2):
  - Backend methods use direct `api.say()` calls, not the message queue
  - Recovery volume is 2-3 messages (Atheme) or 4-5 (Anope synthetic RECOVER) — no flood risk
  - Normal bot chat remains rate-limited through the queue as usual
- [ ] Pre-compute the recovery plan: when threat events start arriving, begin building the recovery action list immediately so it's ready to execute the moment the bot regains ops
- [ ] **Verification**: Measure response time in tests — from deop event to backend requestOp should be < 100ms. From bot re-opped to mass re-op should be < 500ms.

## Config Changes

New per-channel settings (via `.chanset`):

| Setting                  | Type   | Default  | Description                                                                   |
| ------------------------ | ------ | -------- | ----------------------------------------------------------------------------- |
| `chanserv_access`        | string | `'none'` | `'none'` \| `'op'` \| `'superop'` \| `'founder'` — bot's ChanServ access tier |
| `chanserv_unban_on_kick` | flag   | `true`   | Request UNBAN from services when bot is kicked (requires access >= op)        |
| `mass_reop_on_recovery`  | flag   | `true`   | Mass re-op flagged users after regaining ops during elevated threat           |
| `takeover_punish`        | string | `'deop'` | `'none'` \| `'deop'` \| `'kickban'` \| `'akick'` — response to hostile actors |
| `takeover_detection`     | flag   | `true`   | Enable threat scoring and automatic escalation                                |

Existing settings enhanced (no new setting needed):

| Setting         | Plugin | Change                                                                       |
| --------------- | ------ | ---------------------------------------------------------------------------- |
| `protect_topic` | topic  | Extended: also snapshots topic during normal ops and restores after recovery |

New plugin config options (in `plugins.json` or chanmod `config.json`):

```json
{
  "chanmod": {
    "config": {
      "chanserv_services_type": "atheme",
      "takeover_window_ms": 30000,
      "takeover_level_1_threshold": 3,
      "takeover_level_2_threshold": 6,
      "takeover_level_3_threshold": 10,
      "takeover_response_delay_ms": 0,
      "chanserv_unban_retry_ms": 2000,
      "chanserv_unban_max_retries": 3,
      "chanserv_recover_cooldown_ms": 60000,
      "anope_recover_step_delay_ms": 200
    }
  }
}
```

## Database Changes

None. Threat state is ephemeral (in-memory). Takeover events are logged to the existing `mod_log` table with appropriate action strings (`'takeover_detected'`, `'takeover_recovery'`, `'chanserv_recover'`, `'chanserv_akick'`).

## Test Plan

1. **Atheme backend** (`tests/plugins/chanmod-atheme-backend.test.ts`):
   - Each command produces correct `PRIVMSG ChanServ :COMMAND #channel` format
   - Commands gated on access level — 'op' can't RECOVER, 'none' can't OP
   - `verifyAccess()` parses `FLAGS` response, extracts flag chars, maps to tier
   - Verify downgrades with warning when configured tier exceeds actual flags
   - RECOVER sends single command; post-RECOVER cleanup removes +i +m

2. **Anope backend** (`tests/plugins/chanmod-anope-backend.test.ts`):
   - Each command produces correct PRIVMSG format
   - Commands gated on access level
   - `verifyAccess()` parses `ACCESS LIST` response, extracts numeric level, maps to tier
   - Synthetic RECOVER sends correct 4-step sequence with inter-step delays
   - `requestAkick()` followed by `AKICK ENFORCE`

3. **Threat detection** (`tests/plugins/chanmod-takeover.test.ts`):
   - Single deop → level 0 (no escalation)
   - Bot deop + 2 friendly deops → level 1
   - Bot deop + kick + 3 friendly deops + mode lock → level 3
   - Score decays after window expires
   - nodesynch sources don't contribute to score
   - Events from the bot itself don't contribute

4. **Kick+ban recovery** (`tests/plugins/chanmod-takeover.test.ts`):
   - Bot kicked + chanserv_access='op' → UNBAN sent before rejoin (both backends)
   - Bot kicked + chanserv_access='none' → normal rejoin (no UNBAN)
   - Repeated rejoin failures → backoff, don't spam
   - ChanServ unresponsive → timeout and log, don't loop
   - Channel +i during attack → INVITE sent
   - Atheme: post-RECOVER +i +m removed automatically

5. **Mass re-op** (`tests/plugins/chanmod-takeover.test.ts`):
   - Bot regains ops during elevated threat → all flagged users re-opped
   - Mode changes batched correctly per ISUPPORT MODES limit
   - Unauthorized ops deopped simultaneously

6. **Integration flow** (`tests/plugins/chanmod-takeover.test.ts`):
   - Full Atheme scenario: hostile gets ops → deops bot → kicks bot → bans bot → sets +i → bot recovers via ChanServ RECOVER → removes +i +m → re-ops friendlies → deops hostile
   - Full Anope scenario: same attack → bot sends MODE CLEAR + UNBAN + INVITE + OP sequence → re-ops friendlies → deops hostile
   - chanserv_access='none' — verify graceful degradation (rejoin attempt only, no services commands)
   - **Escalation chain**: mock botnet backend (priority 1) + ChanServ backend (priority 2) — verify chain tries botnet first, falls through to ChanServ when botnet `canOp()` returns false
   - **MAX_ENFORCEMENTS → escalation**: direct IRC enforcement hits MAX_ENFORCEMENTS → threat score increases → chain.requestOp() called (not just a warning log)
   - **Full escalation sequence**: bot deopped → direct re-op fails (MAX_ENFORCEMENTS) → botnet peer re-ops (if available) → if no peers, ChanServ requestOp → if still failing at critical threat, ChanServ RECOVER

7. **Topic recovery** (`tests/plugins/chanmod-takeover.test.ts`):
   - Topic changes at threat level 0 update the known-good snapshot
   - Topic changes at elevated threat are ignored (snapshot frozen)
   - Post-recovery restores pre-attack topic when `protect_topic` is enabled (topic plugin setting)
   - No restoration when `protect_topic` is disabled

## Resolved Questions

1. **Botnet backend message types**: Resolved — **use dedicated PROTECT\_\* frames.** The bot-linking protocol already has `PROTECT_OP`, `PROTECT_DEOP`, `PROTECT_UNBAN`, `PROTECT_INVITE`, `PROTECT_KICK` frame types implemented with 20/sec rate limiting, permission guards (DEOP/KICK refuse to act on recognized users), and ACK routing. The `BotnetBackend` will use these directly. No new frame types needed for Phase 1.

2. **Coordinated mass-deop detection**: Resolved — **broadcast a `PROTECT_LOST_OPS` alert frame.** When a bot is deopped in a channel, it broadcasts `{ type: 'PROTECT_LOST_OPS', channel: '#chan' }` to peers. The hub aggregates these — if all peers report lost ops for a channel, escalation skips straight to ChanServ without waiting for the channel-state sync timer. This will be implemented alongside the `BotnetBackend` (Phase 1 or as a follow-up to Phase 2's threat detection).

3. **Botnet recovery ordering**: Resolved — first responder wins. Any opped peer acts immediately; duplicate MODEs are harmless. Matches Eggdrop's approach. See bot-linking.md decision #12.

4. **Topic protection overlap**: Resolved — **extend the existing `protect_topic` setting** in the topic plugin. Rather than adding a separate `topic_protect` in chanmod, the topic plugin's existing protect_topic will be enhanced to also snapshot the topic during normal operation and restore it after takeover recovery. One flag covers both lock/unlock and attack recovery.

5. **Plugin credentials location**: Resolved — **move `nick_recovery_password` to `bot.json`** under a chanmod section before Phase 1. This sets the correct pattern per SECURITY.md §6 before adding ChanServ credential handling.
