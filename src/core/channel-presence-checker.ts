// HexBot — Periodic channel presence check
//
// Watches the configured channel list and rejoins any channels the bot has
// silently fallen out of. Lives in its own file (rather than inline in
// connection-lifecycle.ts) so the presence-check policy — warn once per
// outage, bounded backoff on permanent-failure channels, don't hammer the
// server — is reviewable independently of the connection FSM. See the
// 2026-04-19 quality audit.
import type { LoggerLike } from '../logger';
import type { ChannelEntry } from '../types';
import { ircLower } from '../utils/wildcard';

/** Minimal IRC client surface the checker needs — just `join()`. */
export interface PresenceCheckerClient {
  join(channel: string, key?: string): void;
}

/** Minimal ChannelState surface the checker needs — "are we in X?" plus
 *  enumeration so the drift sweep covers ad-hoc-joined channels too. */
export interface PresenceCheckerChannelState {
  getChannel(name: string): unknown;
  /** All currently-tracked channels — used to discover ad-hoc joins. */
  getAllChannels(): Array<{ name: string }>;
}

/**
 * One entry per channel that failed to JOIN with a permanent-error numeric
 * (+b/+i/+k/+r). Tracks how far through the retry schedule the bot has
 * progressed so a repeated failure doesn't reset the tier back to zero.
 */
export interface PermanentFailureEntry {
  /**
   * Index into the retry schedule for the *next* attempt. Advances each
   * time the presence check issues a retry JOIN. When it reaches
   * `schedule.length`, no further retries are scheduled until the
   * closure is recreated on reconnect.
   */
  tier: number;
  /** Epoch ms. The presence check waits until `Date.now() >= nextRetryAt` before re-attempting. */
  nextRetryAt: number;
}

export interface ChannelPresenceCheckerDeps {
  client: PresenceCheckerClient;
  channelState: PresenceCheckerChannelState | null;
  configuredChannels: ChannelEntry[];
  logger: LoggerLike;
  /**
   * Interval between checks in milliseconds. `0` or negative disables the
   * checker — the factory returns `null` in that case.
   */
  intervalMs: number;
  /**
   * Backoff schedule for retrying permanent-failure channels. Each number is
   * the delay in ms between failures. An empty array disables retries
   * entirely (channels stay failed until reconnect or manual `.join`).
   */
  retrySchedule: readonly number[];
}

/**
 * Start the periodic presence check. Returns the interval handle, or `null`
 * when disabled.
 *
 * Channels in `permanentFailureChannels` are handled by the bounded retry
 * logic: the presence check consults each entry's `nextRetryAt` and only
 * issues a fresh JOIN once the backoff tier has elapsed. This avoids
 * hammering a server with JOINs that can never succeed (flood ban, +i,
 * +k, +r) while still giving time-limited bans a chance to recover
 * without operator intervention.
 *
 * The returned handle must be cleared by the caller on disconnect.
 */
export function startChannelPresenceCheck(
  deps: ChannelPresenceCheckerDeps,
  permanentFailureChannels: Map<string, PermanentFailureEntry>,
): ReturnType<typeof setInterval> | null {
  if (deps.intervalMs <= 0 || !deps.channelState) return null;

  const { client, configuredChannels, channelState, logger, retrySchedule } = deps;
  const warnedChannels = new Set<string>();

  const handle = setInterval(() => {
    // Build the sweep set: every configured channel plus every tracked
    // channel that isn't in the configured list. The latter covers
    // ad-hoc `.join #help` cases — without them, a runtime-joined
    // channel that the bot silently fell out of would sit broken
    // forever because the configured list never sees it.
    const configuredKeys = new Set(configuredChannels.map((c) => ircLower(c.name, 'rfc1459')));
    const adHoc: ChannelEntry[] = [];
    for (const tracked of channelState.getAllChannels()) {
      if (!configuredKeys.has(ircLower(tracked.name, 'rfc1459'))) {
        adHoc.push({ name: tracked.name });
      }
    }
    const sweepList: ChannelEntry[] = [...configuredChannels, ...adHoc];
    for (const ch of sweepList) {
      const inChannel = channelState.getChannel(ch.name) !== undefined;
      if (inChannel) {
        warnedChannels.delete(ch.name);
        // Successfully rejoined — drop any lingering permanent-failure
        // entry so the next failure starts a fresh retry schedule.
        permanentFailureChannels.delete(ircLower(ch.name, 'rfc1459'));
        continue;
      }

      const key = ircLower(ch.name, 'rfc1459');
      const failure = permanentFailureChannels.get(key);

      if (failure) {
        // Permanent-failure channel: only retry if the current tier's
        // backoff has elapsed and we still have tiers remaining.
        if (failure.tier >= retrySchedule.length) continue;
        if (Date.now() < failure.nextRetryAt) continue;
        const delay = retrySchedule[failure.tier];
        failure.tier += 1;
        failure.nextRetryAt = Date.now() + (retrySchedule[failure.tier] ?? 0);
        const remaining = retrySchedule.length - failure.tier;
        logger.info(
          `Retrying join for ${ch.name} after ${Math.round(delay / 1000)}s ` +
            `(${remaining} ${remaining === 1 ? 'retry' : 'retries'} left)`,
        );
        client.join(ch.name, ch.key);
        continue;
      }

      if (!warnedChannels.has(ch.name)) {
        logger.warn(`Not in configured channel ${ch.name} — attempting rejoin`);
        warnedChannels.add(ch.name);
      } else {
        logger.debug(`Retrying join for ${ch.name}`);
      }
      client.join(ch.name, ch.key);
    }
  }, deps.intervalMs);
  // Defensive unref: if any reconnect path ever forgets to clear this
  // interval, the captured `configuredChannels` / `retrySchedule` /
  // `permanentFailureChannels` scope won't pin the process indefinitely.
  // The checker doesn't need to keep the event loop alive on its own.
  handle.unref();
  return handle;
}
