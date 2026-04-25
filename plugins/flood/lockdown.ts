// flood — channel lockdown state and trigger
//
// Tracks distinct flooders per channel. Once enough distinct hostmasks trip
// join/part flood within the window, the channel is locked down (+R / +i)
// for a configurable duration, then automatically unlocked. Separating this
// state from the detection wiring makes it possible to drain locks in
// teardown without touching the counters.
import type { PluginAPI } from '../../src/types';

export interface LockdownConfig {
  /**
   * Distinct-flooder threshold within `lockWindowMs` that triggers
   * channel-wide lockdown. 0 disables lockdown entirely.
   */
  lockCount: number;
  /** Rolling window over which distinct flooders accumulate toward `lockCount`. */
  lockWindowMs: number;
  /** How long the lockdown mode stays active before auto-unlock. */
  lockDurationMs: number;
}

/**
 * Channel-wide lockdown coordinator. Counts distinct flooders per channel
 * inside a rolling window; once the count crosses `lockCount`, applies the
 * configured channel mode (`+R` or `+i`) and schedules an auto-unlock.
 *
 * State is keyed by IRC-lowercase channel name so a server CASEMAPPING
 * change can't fragment counters across folds.
 */
export class LockdownController {
  /** IRC-lower channel → set of distinct IRC-lower flooder hostmasks in window. */
  private flooders = new Map<string, Set<string>>();
  /** IRC-lower channel → epoch-ms timestamps, one per distinct flooder add. */
  private timestamps = new Map<string, number[]>();
  /** IRC-lower channel → pending auto-unlock timer (canceled in teardown). */
  private activeLocks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly api: PluginAPI,
    private readonly cfg: LockdownConfig,
    private readonly botHasOps: (channel: string) => boolean,
  ) {}

  /**
   * Record a distinct flooder (by hostmask) in `channel`. Triggers lockdown
   * when the distinct-flooder count within the window meets `lockCount`.
   */
  record(channel: string, hostmask: string): void {
    if (this.cfg.lockCount <= 0) return; // lockdown disabled

    const lowerChannel = this.api.ircLower(channel);
    const lowerMask = this.api.ircLower(hostmask);

    // While a lockdown is active for this channel, stop recording new
    // flooders. Without this the per-channel `flooders` Set grows to
    // botnet-size during long lockdowns since `sweep()` deliberately
    // skips locked channels.
    if (this.activeLocks.has(lowerChannel)) return;

    if (!this.flooders.has(lowerChannel)) {
      this.flooders.set(lowerChannel, new Set());
      this.timestamps.set(lowerChannel, []);
    }
    const flooders = this.flooders.get(lowerChannel)!;
    const timestamps = this.timestamps.get(lowerChannel)!;

    // Already counted this hostmask in the current window — don't
    // double-tick the lockdown threshold for the same flooder.
    if (flooders.has(lowerMask)) return;

    const now = Date.now();
    flooders.add(lowerMask);
    timestamps.push(now);

    // Prune timestamps AND flooder entries together — the original loop
    // only trimmed `timestamps`, letting the `flooders` Set grow without
    // bound and suppress future triggers (the `has()` short-circuit at
    // the top fails open to the repeated flooder once their entry
    // survives its cooldown window).
    const cutoff = now - this.cfg.lockWindowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    // If every remaining timestamp is newer than `cutoff` but `flooders`
    // contains masks whose only timestamp was pruned, rebuild the set
    // cheaply from the surviving timestamps. Since we don't store
    // per-mask timestamps we can't selectively drop — so when the
    // timestamp list is empty we clear the set and let the next flooder
    // re-register fresh.
    if (timestamps.length === 0) {
      flooders.clear();
    }

    if (timestamps.length >= this.cfg.lockCount && !this.activeLocks.has(lowerChannel)) {
      this.trigger(channel);
    }
  }

  /** Prune stale flooder state for channels without an active lock. */
  sweep(): void {
    for (const [ch] of this.flooders) {
      if (!this.activeLocks.has(ch)) {
        this.flooders.delete(ch);
        this.timestamps.delete(ch);
      }
    }
  }

  /** Clear every map + cancel scheduled unlocks. Called from teardown. */
  clear(): void {
    this.flooders.clear();
    this.timestamps.clear();
    for (const timer of this.activeLocks.values()) clearTimeout(timer);
    this.activeLocks.clear();
  }

  /**
   * Drop lockdown state for a channel the bot just left or was kicked
   * from. Without this the scheduled unlock timer still fires against
   * a channel the bot isn't in, and the entry lingers until the timer
   * does.
   */
  dropChannel(channel: string): void {
    const lowerChannel = this.api.ircLower(channel);
    const timer = this.activeLocks.get(lowerChannel);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.activeLocks.delete(lowerChannel);
    }
    this.flooders.delete(lowerChannel);
    this.timestamps.delete(lowerChannel);
  }

  /**
   * Apply the configured lockdown mode and schedule the auto-unlock. Caller
   * must already have confirmed the threshold was reached and that no lock
   * is currently active for this channel.
   */
  private trigger(channel: string): void {
    if (!this.botHasOps(channel)) return;

    const lowerChannel = this.api.ircLower(channel);
    const mode = this.api.channelSettings.getString(channel, 'flood_lock_mode');
    const flooderCount = this.timestamps.get(lowerChannel)?.length ?? 0;

    this.api.mode(channel, `+${mode}`);
    this.api.log(`Channel lockdown: set +${mode} on ${channel} (flood detected)`);
    this.api.audit.log('flood-lockdown', {
      channel,
      reason: `+${mode}`,
      metadata: { mode, flooderCount, durationMs: this.cfg.lockDurationMs },
    });

    const timer = setTimeout(() => {
      this.lift(channel, mode);
    }, this.cfg.lockDurationMs);
    this.activeLocks.set(lowerChannel, timer);
  }

  /**
   * Auto-unlock callback. Clears all per-channel state and removes the mode
   * if the bot still has ops. If we lost ops during the lockdown the mode
   * stays on the server until a human op lifts it — there's no safe way to
   * remove it from here, and dropping the local state still prevents the
   * timer entry from leaking.
   */

  private lift(channel: string, mode: string): void {
    const lowerChannel = this.api.ircLower(channel);
    this.activeLocks.delete(lowerChannel);
    this.flooders.delete(lowerChannel);
    this.timestamps.delete(lowerChannel);

    if (this.botHasOps(channel)) {
      this.api.mode(channel, `-${mode}`);
      this.api.log(`Channel lockdown lifted: -${mode} on ${channel}`);
      this.api.audit.log('flood-lockdown-lift', {
        channel,
        reason: `-${mode}`,
        metadata: { mode },
      });
    }
  }
}
