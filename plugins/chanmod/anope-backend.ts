// chanmod — Anope ChanServ ProtectionBackend implementation
import type { PluginAPI } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { getBotNick } from './helpers';
import { type BackendAccess, type ProtectionBackend, accessAtLeast } from './protection-backend';

/** Default delay between steps in the synthetic RECOVER sequence. */
const RECOVER_STEP_DELAY_MS = 200;

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
 */
export class AnopeBackend implements ProtectionBackend {
  readonly name = 'anope';
  readonly priority = 2; // ChanServ backends are priority 2 (botnet is 1)

  private accessLevels = new Map<string, BackendAccess>();
  private autoDetectedChannels = new Set<string>();
  private api: PluginAPI;
  private chanservNick: string;
  private recoverStepDelayMs: number;
  private probeState: ProbeState | null;
  /** Track active recover timers for cleanup. */
  private recoverTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    api: PluginAPI,
    chanservNick: string,
    recoverStepDelayMs?: number,
    probeState?: ProbeState,
  ) {
    this.api = api;
    this.chanservNick = chanservNick;
    this.recoverStepDelayMs = recoverStepDelayMs ?? RECOVER_STEP_DELAY_MS;
    this.probeState = probeState ?? null;
  }

  // ---------------------------------------------------------------------------
  // Access management
  // ---------------------------------------------------------------------------

  getAccess(channel: string): BackendAccess {
    return this.accessLevels.get(this.api.ircLower(channel)) ?? 'none';
  }

  setAccess(channel: string, level: BackendAccess): void {
    const key = this.api.ircLower(channel);
    const prev = this.accessLevels.get(key);
    this.accessLevels.set(key, level);
    // Clear auto-detected flag only when the value actually changes
    if (this.autoDetectedChannels.has(key) && level !== prev) {
      this.autoDetectedChannels.delete(key);
    }
  }

  isAutoDetected(channel: string): boolean {
    return this.autoDetectedChannels.has(this.api.ircLower(channel));
  }

  // ---------------------------------------------------------------------------
  // Capability queries
  // ---------------------------------------------------------------------------

  canOp(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canDeop(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'superop');
  }

  canUnban(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canInvite(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canRecover(channel: string): boolean {
    // Synthetic RECOVER requires MODE CLEAR which needs founder/QOP
    return accessAtLeast(this.getAccess(channel), 'founder');
  }

  canClearBans(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'founder');
  }

  canRemoveKey(channel: string): boolean {
    // Anope: GETKEY requires AOP (level 5) — retrieves the key so the bot can join
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canAkick(channel: string): boolean {
    // Anope AKICK requires SOP (level 10)
    return accessAtLeast(this.getAccess(channel), 'superop');
  }

  // ---------------------------------------------------------------------------
  // Action requests
  // ---------------------------------------------------------------------------

  requestOp(channel: string, nick?: string): void {
    const target = nick ?? getBotNick(this.api);
    this.sendChanServ(`OP ${channel} ${target}`);
  }

  requestDeop(channel: string, nick: string): void {
    this.sendChanServ(`DEOP ${channel} ${nick}`);
  }

  requestUnban(channel: string): void {
    this.sendChanServ(`UNBAN ${channel}`);
  }

  requestInvite(channel: string): void {
    this.sendChanServ(`INVITE ${channel}`);
  }

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
      this.sendChanServ(`UNBAN ${channel}`);
      this.sendChanServ(`INVITE ${channel}`);

      // Step 5-6: After another delay, request op
      const t2 = setTimeout(() => {
        this.sendChanServ(`OP ${channel}`);
      }, this.recoverStepDelayMs);
      this.recoverTimers.push(t2);
    }, this.recoverStepDelayMs);
    this.recoverTimers.push(t1);
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
      this.probeState.pendingGetKey.set(chanKey, (key) => {
        if (key) {
          this.api.log(`Anope: GETKEY returned key for ${channel} — joining`);
          this.api.join(channel, key);
        } else {
          this.api.debug(`Anope: GETKEY for ${channel} returned no key`);
        }
      });
    }
  }

  requestAkick(channel: string, mask: string, reason?: string): void {
    const cmd = reason ? `AKICK ${channel} ADD ${mask} ${reason}` : `AKICK ${channel} ADD ${mask}`;
    this.sendChanServ(cmd);
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
    if (level >= 10000) return 'founder';
    if (level >= 10) return 'superop';
    if (level >= 5) return 'op';
    return 'none';
  }

  /** Cancel pending recover timers (called from teardown). */
  clearTimers(): void {
    for (const t of this.recoverTimers) clearTimeout(t);
    this.recoverTimers.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private sendChanServ(command: string): void {
    this.api.say(this.chanservNick, command);
  }
}
