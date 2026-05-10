# Stability Audit Meta-Review: `stability-all-2026-05-10.md`

**Date:** 2026-05-10
**Scope:** Critical re-read of `docs/audits/stability-all-2026-05-10.md` produced earlier today by 12 parallel subagents.
**Method:** Spot verification of 7 CRITICAL claims against the actual source; recount of all findings; cross-reference check of recommendation numbering; coverage-gap identification.
**Estimated quality of audited document:** **Medium-High accuracy, with severity inflation as the dominant defect.**

## Summary

The original audit is **factually accurate where I could verify it** — every CRITICAL claim I spot-checked against the actual source matches the cited file:line content. The skill rules (parallel agent dispatch, checkboxes per phase, `docs/audits/<target>-<date>.md` location) were followed.

The dominant defect is **severity inflation**: of 14 findings labelled CRITICAL, only 2 cleanly meet the skill's CRITICAL bar ("realistic production event takes the bot offline or wedges a core subsystem"). One more is borderline. The remaining 11 are real issues but their realistic blast radius is "noisy", "operational lockout", "diagnosis confusion", or "leak on shutdown" — WARNING-class symptoms that should not compete for attention with the genuinely-load-bearing fixes.

Secondary defects: finding counts are wrong (14 CRITICAL / **79** WARNING / **54** INFO actual, not the claimed 14/73/47); recommendation numbering drifts by ±1 after CRITICAL #7; five files in scope (`audit.ts`, `memo.ts`, `relay-orchestrator.ts`, `seed-from-json.ts`, `deep-freeze.ts`) were not directly audited as standalone units; several findings rely on a 10k-row / 5000-user / 200-channel scale that doesn't match this deployment.

**Findings:** 1 CRITICAL, 5 WARNING, 6 INFO.

---

## Phases

- [ ] **Meta-Phase A — Verify CRITICAL claims against source**
- [ ] **Meta-Phase B — Recount findings; verify totals**
- [ ] **Meta-Phase C — Calibrate severities (strict)**
- [ ] **Meta-Phase D — Identify coverage gaps**
- [ ] **Meta-Phase E — Identify scale-dependent overreach**
- [ ] **Meta-Phase F — Cross-reference numbering integrity**

---

## CRITICAL findings

### [CRITICAL] 10 of 14 CRITICALs are severity-inflated; the genuinely-CRITICAL count is 2 (with 1 borderline)

- [ ] **Recalibrate the original audit's CRITICAL list down to 2-3 entries; demote the rest to WARNING**
- **File:** `docs/audits/stability-all-2026-05-10.md` lines 44-173 (the entire CRITICAL section)
- **Pattern:** Severity calibration / signal-to-noise
- **Anti-pattern:** Boy-who-cried-wolf — when 14 items are CRITICAL, none are.
- **Scenario:** The downstream `/build` skill (or a human reading the audit) faces 14 items each marked "fix before deploying." Most can in fact be deferred. Without calibration, the actual two showstoppers (#1 IRCCommands queue bypass, #2 DB process.exit hot-path) are diluted by 12 lower-priority items, and a maintainer triages by reading order rather than severity — which the agent did not optimise for.
- **Impact:** The audit's own "Top three to fix first" section already implicitly acknowledges this by listing only #1, #2/#3, and #6 — a 3-of-14 self-prioritization. Meanwhile the recommendations section places quick-wins (R1-R12) at the top of the list and the actual CRITICAL fixes (R13-R18) below them. The mismatch is exactly the symptom of severity inflation.
- **Remediation:** Apply the recalibration table below. Update the original document's section headings (`## CRITICAL findings` → split into a tight `CRITICAL` list of 2-3 plus a long `WARNING` list of the demoted items). Update the Summary's "14 CRITICAL" claim. Re-run the find-counts.

#### Severity recalibration table

| #   | Original title                                      | Verdict                                       | Reason                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | IRCCommands mutating verbs bypass message queue     | **STAY CRITICAL**                             | A chanmod takeover-recovery on a 30-flagged-user channel realistically fires 6-7 MODE lines + deop/halfop/voice + hostile-response in one tick. Solanum/Charybdis Excess Flood = K-line ≈ 10 lines/2s. The bot disappears from every channel during the moment it most needs to be present. Mechanically simple fix.                                     |
| 2   | DB `process.exit(2)` from synchronous reads         | **STAY CRITICAL**                             | Hot-path `process.exit` mid-handler skips QUIT, WAL flush, mod_log close. Realistic trigger (transient I/O on NFS, btrfs snapshot) means a normal disk-health event takes the bot down without graceful exit.                                                                                                                                            |
| 3   | Bot.connect() STS gate `process.exit(2)`            | **DEMOTE → WARNING**                          | Trigger requires an _operator config error_ (plaintext `tls=false` + persistent STS policy). Once-per-deployment event. The supervisor restarts cleanly; FD/WAL leak on already-exiting process is recoverable. Real but rare.                                                                                                                           |
| 4   | Re-entrant SIGTERM stacks `shutdownWithTimeout`     | **DEMOTE → WARNING**                          | The agent's own analysis admits "`Bot.shutdown()` self-guards via `_isShuttingDown`, so the inner work is idempotent." The race against `process.exit(0)` is theoretical and the worst case is a slightly-uncleaner exit on operator double-Ctrl-C. Not bot-offline territory.                                                                           |
| 5   | `unhandledRejection` → `fatalExit` chain re-rejects | **DEMOTE → WARNING**                          | Triggers a fresh `unhandledRejection` only if a plugin's teardown throws AND `fatalExit` was already in flight. Worst-case impact named by the agent itself: "diagnosis confusion at 3am." Diagnostic clarity is real but it's not "takes the bot offline."                                                                                              |
| 6   | Botlink sync-frame flood blocks event loop          | **DEMOTE → WARNING** (CRITICAL only at scale) | Synchronous fanout is real but the doomsday scenario assumes 10k permission rows + 200 channels + 20+ leaves. This deployment is solo-dev (per project memory). At 100 rows / 1-2 channels / single hub, the freeze is sub-millisecond and heartbeats don't miss. Worth fixing for botnet correctness, but not pre-deployment-blocking at current scale. |
| 7   | Botlink sync ignores `socket.write` backpressure    | **DEMOTE → WARNING** (CRITICAL only at scale) | Same scale dependency as #6. State divergence requires a leaf with a stalled receive buffer, which requires sustained sync traffic, which requires scale.                                                                                                                                                                                                |
| 8   | DCC port-pool double-release race                   | **DEMOTE → WARNING**                          | Window is microseconds: after `server.once('connection')` runs `server.close()` synchronously, a follow-up `'error'` would have to fire on a closed listener AND a parallel offer would have to allocate the same port number in that microsecond gap. Theoretically possible on Linux; not demonstrated.                                                |
| 9   | `ensureChannel` unbounded growth                    | **STAY CRITICAL (borderline)**                | Verified at `channel-state.ts:567` — `onTopic` does call `ensureChannel`. Trigger requires hostile or buggy server emitting TOPIC for non-joined channels. Realistic on misbehaving netsplits or attacker-controlled servers. Memory grows monotonically. The scenario is plausible enough to keep at CRITICAL.                                          |
| 10  | ai-chat circuit-open spam                           | **DEMOTE → WARNING**                          | Verified at `pipeline.ts:325-336` — the else-branch does fire on circuit-open. But blast radius is "channel sees `'AI is temporarily unavailable'` per triggered turn" — noisy, not bot-offline. Operator can mute via plugin disable; unrelated subsystems unaffected.                                                                                  |
| 11  | Bot.start hangs on rate-limited first connect       | **DEMOTE → WARNING**                          | The bot is _correctly recovering_, not wedged. The supervisor failure (CRITICAL #12) is the actual offender. The fix is healthcheck redesign, not in-process retry behaviour. Per the agent's own model the driver does the right thing.                                                                                                                 |
| 12  | Healthcheck restart loop on K-line                  | **DEMOTE → WARNING**                          | Pure operational/supervisor concern. The bot's in-process logic is correct; the symptom only appears with a healthcheck cadence shorter than the rate-limited tier. Operator can fix via supervisor config (longer healthcheck interval, anchor to PID liveness). Not "core subsystem wedged."                                                           |
| 13  | STS revocation `duration=0` blocked over plaintext  | **DEMOTE → WARNING**                          | Operational lockout (operator can't revoke without manual DB edit), not stability failure. STS revocation is rare; manual DB edit is a documented escape hatch in `_sts` namespace.                                                                                                                                                                      |
| 14  | STS upgrade cleartext leak via `flushWithDeadline`  | **DEMOTE → WARNING (security cross-list)**    | Security concern (cleartext leak of queued secret-bearing message during STS upgrade). 100ms drain window plus requirement that queue contains secret-bearing content makes this narrow. This is more a `/security` finding than a `/stability` one.                                                                                                     |

**Net result:** 2 CRITICAL (clean) + 1 borderline CRITICAL = 3, with 11 demoted to WARNING.

---

## WARNING findings

### [WARNING] Finding counts in the Summary are wrong

- [ ] **Correct the totals in the Summary line**
- **File:** `docs/audits/stability-all-2026-05-10.md:21`
- **Claimed:** "14 CRITICAL, 73 WARNING, 47 INFO"
- **Actual** (verified by `grep -c`): 14 CRITICAL, **79 WARNING, 54 INFO** — off by 6 and 7.
- **Per-phase breakdown** (counted from doc):
  - Phase 1: 10W / 4I
  - Phase 2: 6W / 1I
  - Phase 3: 8W / 4I
  - Phase 4: 4W / 3I
  - Phase 5: 8W / 4I
  - Phase 6: 2W / 9I
  - Phase 7: 6W / 3I
  - Phase 8: 10W / 5I
  - Phase 9: 7W / 5I
  - Phase 10: 5W / 6I
  - Phase 11: 9W / 4I
  - Phase 12: 4W / 6I
  - **Totals:** 79W, 54I — confirms grep count.
- **Remediation:** Replace `14 CRITICAL, 73 WARNING, 47 INFO` with `14 CRITICAL, 79 WARNING, 54 INFO`. After the severity recalibration above, this becomes `2-3 CRITICAL, ~89-90 WARNING, 54 INFO`.

### [WARNING] Recommendation numbering drifts by ±1 after CRITICAL #7

- [ ] **Fix the CRITICAL #N references in the Recommendations section**
- **File:** `docs/audits/stability-all-2026-05-10.md:438,446,447,449,456,457`
- **Specifics** (CRITICAL findings counted in document order):
  | Line | Recommendation says | Should say | Drift |
  |---|---|---|---|
  | 446 | R17 references CRITICAL #8 (ensureChannel) | CRITICAL #9 | -1 |
  | 449 | R20 references CRITICAL #9 (DCC port-pool) | CRITICAL #8 | +1 |
  | 447 | R18 references CRITICAL #10 (Bot.start) | CRITICAL #11 | -1 |
  | 438 | R12 references CRITICAL #11 (Healthcheck) | CRITICAL #12 | -1 |
  | 456 | R27 references "CRITICAL #9 [variant]" (ai-chat) | CRITICAL #10 | -1 |
  | 457 | R28 references CRITICAL #11 (Heartbeat) | CRITICAL #12 | -1 |
- **Pattern:** Cross-reference integrity / consumer-trust. Downstream `/build` agents reading "CRITICAL #11" and looking it up in the doc find a different finding than was meant. R17 and R20 are _swapped_ — fixing R17 → #9 and R20 → #8.
- **Remediation:** Either renumber the references, or move to symbolic IDs like `[C-IRCCMDS]`, `[C-DBEXIT]`, `[C-ENSURECHAN]` so a re-ordering doesn't break consumers.

### [WARNING] Coverage gaps: 5 in-scope files were not directly audited

- [ ] **Address coverage gaps in a follow-up audit pass**
- **Files NOT directly audited as standalone units** (per scope = "every `.ts` file under `src/` and `plugins/`"):
  - `src/core/audit.ts` — referenced from Phase 8's prompt list but no specific findings ever cited it.
  - `src/core/memo.ts` — internal admin memo system; not in any phase's scope list.
  - `src/core/relay-orchestrator.ts` — referenced in Phase 5 findings (`relay-orchestrator.ts:157-163`) but only via the botlink sync path; orchestrator's own teardown / state lifecycle uncovered.
  - `src/core/seed-from-json.ts` — bootstrap path; not in scope.
  - `src/utils/deep-freeze.ts` — newly added (`?? src/utils/deep-freeze.ts` in git status); definitely uncovered.
  - `src/database-errors.ts` — listed in Phase 3 scope, but the Phase 3 findings only reference `database.ts` and `mod-log.ts`; the error-class module itself is uncovered.
- **Pattern:** Coverage incompleteness despite "all" scope claim.
- **Impact:** A subsequent stability event in any of these modules would be uncovered. `audit.ts` in particular sits on a hot path (every `.ban`/`.kick`/`.op` writes a mod_log row through it) — gaps here are stability-relevant.
- **Remediation:** Run a focused follow-up pass over these 6 files (one Agent call, ~5 minutes); promote findings into the original audit if any.

### [WARNING] Several findings depend on scale that doesn't match this deployment

- [ ] **Annotate scale-dependent findings with deployment-context note**
- **Pattern:** Overreach / scenario plausibility
- **Examples in the original audit:**
  - **CRITICAL #6, #7** (Botlink sync flood + backpressure): scenarios assume "10k permission rows and 200 channels" + "20+ leaves." Per project memory the user is a solo-dev with a single bot deployment.
  - **W3.1** (`getAllBans` unbounded scans): scenario assumes "50k-500k records" — needs a year of high-volume anti-flood activity on a busy network.
  - **W3.4** (`permissions.listUsers` walks namespace): assumes 10k users — typical bot has 1-20 users.
  - **W9.5** (per-PART O(channels) iteration): assumes "5000 PARTs × 100 channels = 500k iterations" — Libera #help peak; not typical.
- **Impact:** A reader who treats every finding as urgent will spend effort on scale-dependent fixes that don't yet matter. The findings are still valid (the bot might one day scale up or be packaged for others) but they should not gate the next deploy.
- **Remediation:** Add a "Realistic at scale: yes / borderline / no" annotation to each warning. Or filter the audit by the operator's stated deployment size.

### [WARNING] Several findings are pure speculation about "future code" — flag-and-ignore

- [ ] **Distinguish "live bug" from "fragile if changed" in finding bodies**
- **Pattern:** Defensive-coding flags vs actual stability issues
- **Examples:**
  - **W2.5** (`setCommandRelay` re-wire): "Currently latent; orchestrator passes the same bus." — explicitly acknowledged not-a-current-bug.
  - **W5.3** (`disconnect()` zeroes `linkKey`): "Today's `relay-orchestrator.stop()` only calls `disconnect()` and doesn't subsequently reconnect, so this isn't currently exercised."
  - **W7.1** (`process.on` ordering): "Future refactor adding `await` at module top-level opens window where early throw bypasses handlers" — speculative refactor.
  - **I3.2** (`ensureOpen` returns handle): API hygiene only.
  - **I7.1** (`recoverableTimestamps` array): "only a concern if main is ever wrapped."
- **Impact:** Mixed in with real bugs, these clutter the action list. They're worth keeping somewhere (maybe a "fragility / land-mines" appendix), but they should not appear at the same level as live bugs.
- **Remediation:** Add a `[fragility]` tag or move to a separate "fragile to refactor" appendix.

---

## INFO findings (verified-true claims, for confidence-building)

These were the CRITICAL claims I directly verified against the source. All hold up — calling them out so future readers can trust the substrate even where severity is overstated:

- [ ] **I-V1 — `onTopic` calls `ensureChannel` unconditionally** — `channel-state.ts:567`. Confirmed. CRITICAL #9 finding stands as a real path.
- [ ] **I-V2 — RPL_CHANNELMODEIS `+l` parsing has no `Number.isFinite` guard** — `channel-state.ts:591`. Confirmed `parseInt(String(m.param), 10)` assigned directly. W9.1 stands.
- [ ] **I-V3 — ai-chat pipeline else-branch fires `'AI is temporarily unavailable.'`** — `pipeline.ts:335`. Confirmed. CRITICAL #10 finding's path exists. (Severity demoted, finding stands.)
- [ ] **I-V4 — Dispatcher iterates `this.binds` without snapshot, with `await` between handlers** — `dispatcher.ts:362-396`. Confirmed. W2.1 stands.
- [ ] **I-V5 — DCC `server.on('error', ...)` runs `portAllocator.release(port)` after a successful `server.once('connection')` already released** — `dcc/index.ts:1703-1724`. Confirmed both handlers exist on the same `server`. The race window is small but the structural defect is real.
- [ ] **I-V6 — STS plaintext + `port === undefined` is unconditionally refused, blocking `duration=0` revoke** — `connection-lifecycle.ts:507`. Confirmed. CRITICAL #13 finding stands.

Process-handler audit:

- [ ] **I-V7 — `process.on('uncaughtException')` and `process.on('unhandledRejection')` ARE registered** at `index.ts:203,215`. The original audit's W7.1 ("order-fragile") critique stands but the handlers exist.

Counts (independently verified):

- [ ] **I-V8 — Original audit has 14 CRITICAL, 79 WARNING, 54 INFO** by `grep -c`. Confirms the count discrepancy in the doc's Summary.

---

## Stable patterns of the original audit (templates to keep)

The original audit did several things well; these are worth replicating in future audits:

- **Phase-organised structure with checkboxes** — every phase, finding, and recommendation is a `- [ ]` line. `/build` can tick them off without document surgery.
- **Concrete realistic scenarios** — every finding names a real-world trigger (K-line, NickServ lag, DB lock) rather than abstract "improve error handling." This is the highest-leverage habit; preserve it.
- **Stable-patterns section** — the audit explicitly calls out 30+ correctly-implemented patterns. This counter-balances the negative bias and gives `/refactor` templates to match.
- **Quick-wins / Medium / Architectural recommendation tiers** — operator can pick effort level. Good ergonomic.
- **"Top three to fix first"** — implicit recognition that not all CRITICAL findings are equal. The right move is to make this _explicit_ by recalibrating CRITICAL itself.
- **Survival-time estimates** ("good", "poor" against named chaos events) — actionable, not hand-wavy.
- **Each finding has file:line citation** — reviewable without re-reading agent transcripts.

---

## Recommendations

### Quick wins (< 5 min each)

- [ ] **MR1** — Fix the count line in the Summary (`14 CRITICAL, 73 WARNING, 47 INFO` → `14 CRITICAL, 79 WARNING, 54 INFO`). One-line edit.
- [ ] **MR2** — Fix the 6 numbering drift cross-references in the Recommendations section (R12, R17, R18, R20, R27, R28). Or replace with symbolic IDs.
- [ ] **MR3** — Add a one-line "Verified by parent" annotation to CRITICAL #1, #2, #9, #10, #13 (the ones I spot-checked) and to W2.1, W9.1.
- [ ] **MR4** — Annotate scale-dependent findings (CRITICAL #6, #7, W3.1, W3.4, W9.5) with `[at-scale]` tag.

### Medium effort (recalibrate the original audit)

- [ ] **MR5** — Apply the severity recalibration table above: split the CRITICAL section into a tight 2-3-item list and merge the demoted 11 into WARNING. Update Summary accordingly.
- [ ] **MR6** — Run a focused Agent call on the 5 uncovered files (`audit.ts`, `memo.ts`, `relay-orchestrator.ts`, `seed-from-json.ts`, `deep-freeze.ts`, `database-errors.ts`). Merge any new findings into the existing audit.
- [ ] **MR7** — Tag fragility-vs-live-bug findings (W2.5, W5.3, W7.1, I3.2, I7.1) and consider moving them to an appendix.

### Architectural (process changes for next audit)

- [ ] **MR8** — Define a stricter CRITICAL bar in the `/stability` skill itself: "the realistic, in-this-deployment scenario takes the bot offline or wedges a core subsystem within one event." Without this, every parallel agent independently inflates severity to draw the parent's attention to its concern area. This audit had 12 agents each contributing 1-3 CRITICALs.
- [ ] **MR9** — Have parent verify each CRITICAL claim against source before accepting from agents. The parent did this for 5 of 14; should be the default for all.
- [ ] **MR10** — Standardize finding IDs (e.g. `[C-IRCCMDS-QUEUE-BYPASS]`) instead of ordinal numbers, so cross-references survive reordering.

---

## Open questions for the operator

These came up during the meta-review and the parent didn't have enough context to resolve unilaterally:

- [ ] **Q1** — **Deployment scale.** Is hexbot deployed as a single-bot single-network install (per project memory), or is botnet-scale a real near-term concern? This determines whether CRITICAL #6/#7 stay CRITICAL or sit at WARNING.
- [ ] **Q2** — **Healthcheck design intent.** Is the current "healthcheck file removed on `bot:disconnected`" deliberate (meaning: "if I'm not connected, I'm not healthy")? If yes, CRITICAL #11/#12 are working-as-intended and should be INFO. If no, they need a redesign.
- [ ] **Q3** — **`process.exit(2)` from DB:** is this a deliberate fail-fast posture inherited from a prior incident? If so, the recalibration of CRITICAL #2 should preserve the _intent_ (loud failure on corruption) while fixing the _mechanism_ (route through `bot.shutdown()`).
- [ ] **Q4** — **STS revocation gap (CRITICAL #13).** Is operator-side STS revocation a use case you actually expect to encounter? If networks rarely revoke (most don't), this is INFO; if it's a known practice on a target network, it's WARNING.
- [ ] **Q5** — **Should the original audit be revised in place** with the recalibration applied, or kept as a historical artifact with this meta-doc as the corrigendum?

---

## Top three meta-findings to act on first

1. **Recalibrate severities** (MR5). The current 14 CRITICAL is a signal-to-noise problem; downstream consumers (humans or `/build`) will misallocate effort. Mechanically: edit the section heading, move 11 entries to WARNING. ~15 min.
2. **Fix counts and numbering** (MR1, MR2). The Summary's count is provably wrong; the recommendation section's CRITICAL #N references mostly point to the wrong findings. Trust-eroding for any future reader. ~5 min.
3. **Cover the 5 missing files** (MR6). `audit.ts` in particular is on the hot path of every privileged command; "all" scope without auditing it is a gap.
