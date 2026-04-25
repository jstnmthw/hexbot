import type { PluginAPI } from '../../src/types';
import { ChanServBackendBase } from './chanserv-backend-base';
import type { ProbeState } from './chanserv-notice';
import { type BackendAccess, accessAtLeast } from './protection-backend';

/**
 * Default delay between steps in the synthetic RECOVER sequence.
 * Anope ChanServ commits MODE/CLEAR side effects asynchronously; without
 * a small gap between `MODE CLEAR ops`, `UNBAN/INVITE`, and `OP`, the
 * subsequent commands can race ahead of the prior commit and silently
 * no-op. 200ms is well under the visible-to-operators threshold but
 * larger than typical services scheduler latency. Tunable via
 * `anope_recover_step_delay_ms` config.
 */
const RECOVER_STEP_DELAY_MS = 200;

/** Timeout for GETKEY probe responses (matches other probe timeouts in chanserv-notice.ts). */
const GETKEY_TIMEOUT_MS = 10_000;

/**
 * Cap on concurrent pending GETKEY probes. During a services outage
 * that affects many channels simultaneously the callback closures
 * here hold references to `api`/`channel`/`probeState`; leaving them
 * uncapped creates memory pressure.
 */
const MAX_PENDING_GETKEY = 64;

// Anope numeric access levels (default schema). These are Anope conventions,
// not configurable. See header comment block for the full level map.
const ANOPE_LEVEL_FOUNDER = 10_000;
const ANOPE_LEVEL_SUPEROP = 10;
const ANOPE_LEVEL_OP = 5;

/**
 * Anope ChanServ backend.
 *
 * Maps the ProtectionBackend interface to Anope-specific ChanServ commands.
 * Key difference from Atheme: Anope has NO native RECOVER command.
 * Recovery is synthesized from: MODE CLEAR ops → UNBAN → INVITE → OP.
 *
 * Access tier → Anope level mapping:
 * - op:       AOP (level 5)  — OP self/others, UNBAN, INVITE, GETKEY, AKICK
 * - superop:  SOP (level 10) — + DEOP others, access management
 * - founder:  Founder (10000) — + MODE CLEAR, everything
 *
 * Most scaffolding lives in {@link ChanServBackendBase}; this class
 * overrides the pieces where Anope diverges from Atheme defaults:
 * AKICK requires superop, RECOVER is synthesized, CLEAR uses `MODE CLEAR
 * bans`, key removal goes through GETKEY+join, AKICK ENFORCE runs after
 * the ADD, and access probing uses ACCESS LIST + INFO.
 */
export class AnopeBackend extends ChanServBackendBase {
  readonly name = 'anope';

  private recoverStepDelayMs: number;
  private probeState: ProbeState | null;
  /** Track active recover timers for cleanup. Entries self-remove on fire. */
  private recoverTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(
    api: PluginAPI,
    chanservNick: string,
    recoverStepDelayMs?: number,
    probeState?: ProbeState,
  ) {
    super(api, chanservNick);
    this.recoverStepDelayMs = recoverStepDelayMs ?? RECOVER_STEP_DELAY_MS;
    this.probeState = probeState ?? null;
  }

  // ---------------------------------------------------------------------------
  // Capability query overrides (Anope AKICK requires SOP)
  // ---------------------------------------------------------------------------

  canAkick(channel: string): boolean {
    // Anope AKICK requires SOP (level 10)
    return accessAtLeast(this.getAccess(channel), 'superop');
  }

  // ---------------------------------------------------------------------------
  // Action request overrides
  // ---------------------------------------------------------------------------

  /**
   * Synthetic RECOVER — Anope has no native RECOVER command.
   *
   * Sequence:
   * 1. MODE #channel CLEAR ops  (requires founder/QOP)
   * 2. Wait ~200ms
   * 3. UNBAN #channel
   * 4. INVITE #channel
   * 5. Wait ~200ms
   * 6. OP #channel
   */
  requestRecover(channel: string): void {
    this.api.log(`Anope: starting synthetic RECOVER for ${channel}`);

    // Step 1: Clear all ops
    this.sendChanServ(`MODE ${channel} CLEAR ops`);

    // Step 2-4: After delay, unban + invite
    const t1 = setTimeout(() => {
      this.recoverTimers.delete(t1);
      this.sendChanServ(`UNBAN ${channel}`);
      this.sendChanServ(`INVITE ${channel}`);

      // Step 5-6: After another delay, request op
      const t2 = setTimeout(() => {
        this.recoverTimers.delete(t2);
        this.sendChanServ(`OP ${channel}`);
      }, this.recoverStepDelayMs);
      this.recoverTimers.add(t2);
    }, this.recoverStepDelayMs);
    this.recoverTimers.add(t1);
  }

  requestClearBans(channel: string): void {
    this.sendChanServ(`MODE ${channel} CLEAR bans`);
  }

  requestRemoveKey(channel: string): void {
    // Anope GETKEY retrieves the current channel key (available at AOP/level 5+).
    // On receiving the key, the callback joins with it. This avoids the nuclear
    // MODE CLEAR (founder-only) or the destructive SET MLOCK -k (replaces MLOCK).
    this.sendChanServ(`GETKEY ${channel}`);
    if (this.probeState) {
      const chanKey = this.api.ircLower(channel);
      // Hard cap concurrent pending callbacks — during a services
      // outage across many channels the closures captured here
      // hold references to api/channel/probeState and can accumulate
      // unbounded.
      if (
        !this.probeState.pendingGetKey.has(chanKey) &&
        this.probeState.pendingGetKey.size >= MAX_PENDING_GETKEY
      ) {
        this.api.warn(
          `Anope: pendingGetKey cap (${MAX_PENDING_GETKEY}) reached — dropping request for ${channel}`,
        );
        return;
      }
      this.probeState.pendingGetKey.set(chanKey, (key) => {
        if (key) {
          this.api.log(`Anope: GETKEY returned key for ${channel} — joining`);
          this.api.join(channel, key);
        } else {
          this.api.debug(`Anope: GETKEY for ${channel} returned no key`);
        }
      });

      // Timeout: clean up if ChanServ doesn't respond (matches other probe timeouts)
      const timer = setTimeout(() => {
        if (this.probeState?.pendingGetKey.has(chanKey)) {
          this.probeState.pendingGetKey.delete(chanKey);
          this.api.debug(`Anope: GETKEY probe for ${channel} timed out`);
        }
        this.probeState?.probeTimers.delete(timer);
      }, GETKEY_TIMEOUT_MS);
      this.probeState.probeTimers.add(timer);
    }
  }

  requestAkick(channel: string, mask: string, reason?: string): void {
    super.requestAkick(channel, mask, reason);
    // Anope-specific: immediately enforce the AKICK list
    this.sendChanServ(`AKICK ${channel} ENFORCE`);
  }

  // ---------------------------------------------------------------------------
  // Verify access
  // ---------------------------------------------------------------------------

  /**
   * Send ACCESS LIST + INFO probes to verify the bot's actual access level.
   *
   * ACCESS LIST detects explicit access entries (AOP/SOP/numeric levels).
   * INFO detects implicit founder status (Rizon/Anope don't list founders
   * in ACCESS or XOP lists — founder is the channel registrant).
   */
  verifyAccess(channel: string): void {
    this.sendChanServ(`ACCESS ${channel} LIST`);
    this.sendChanServ(`INFO ${channel}`);
    this.api.log(`Anope: verifying access for ${channel} via ACCESS LIST + INFO probes`);
  }

  /**
   * Parse an Anope ACCESS LIST response and update the access level.
   *
   * Expected format per entry (Anope NOTICE):
   *   "  <num> <nick/mask> <level> [...]"
   *
   * We look for the bot's nick in the list and map the numeric level to a tier.
   * Called externally by the notice handler wired in the plugin init.
   */
  handleAccessResponse(channel: string, level: number): void {
    const actual = this.levelToTier(level);
    const configured = this.getAccess(channel);

    if (configured === 'none') {
      // Auto-detect: if we have real access, set the level automatically
      if (actual !== 'none') {
        const key = this.api.ircLower(channel);
        this.accessLevels.set(key, actual);
        this.autoDetectedChannels.add(key);
        this.api.log(
          `Anope: auto-detected access for ${channel} — level ${level} (tier: '${actual}')`,
        );
      }
      return;
    }

    if (!accessAtLeast(actual, configured)) {
      this.api.warn(
        `Anope: configured access '${configured}' for ${channel} exceeds actual level ${level} (effective: '${actual}') — downgrading`,
      );
      this.setAccess(channel, actual);
    } else {
      this.api.log(`Anope: access verified for ${channel} — level ${level} (tier: '${actual}')`);
    }
  }

  /**
   * Map an Anope numeric access level to an access tier.
   *
   * 10000+ → founder
   * 10-9999 → superop (SOP is 10, QOP is 9999)
   * 5-9    → op (AOP is 5)
   * <5     → none (VOP=3, HOP=4 don't grant OP capabilities)
   */
  levelToTier(level: number): BackendAccess {
    if (level >= ANOPE_LEVEL_FOUNDER) return 'founder';
    if (level >= ANOPE_LEVEL_SUPEROP) return 'superop';
    if (level >= ANOPE_LEVEL_OP) return 'op';
    return 'none';
  }

  /** Cancel pending recover timers (called from teardown). */
  clearTimers(): void {
    for (const t of this.recoverTimers) clearTimeout(t);
    this.recoverTimers.clear();
  }
}
