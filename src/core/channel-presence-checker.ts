// HexBot — Periodic channel presence check
//
// Watches the configured channel list and rejoins any channels the bot has
// silently fallen out of. Lives in its own file (rather than inline in
// connection-lifecycle.ts) so the presence-check policy — warn once per
// outage, skip permanent-failure channels, don't hammer the server — is
// reviewable independently of the connection FSM. See the 2026-04-19
// quality audit.
import type { LoggerLike } from '../logger';
import type { ChannelEntry } from '../types';
import { ircLower } from '../utils/wildcard';

/** Minimal IRC client surface the checker needs — just `join()`. */
export interface PresenceCheckerClient {
  join(channel: string, key?: string): void;
}

/** Minimal ChannelState surface the checker needs — just "are we in X?". */
export interface PresenceCheckerChannelState {
  getChannel(name: string): unknown;
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
}

/**
 * Start the periodic presence check. Returns the interval handle, or `null`
 * when disabled. Channels whose `lowerNick` appears in
 * `permanentFailureChannels` are skipped so the bot doesn't hammer a server
 * with JOINs that can never succeed (+b / +i / +k / +r); see stability
 * audit 2026-04-14. The returned handle must be cleared by the caller on
 * disconnect.
 */
export function startChannelPresenceCheck(
  deps: ChannelPresenceCheckerDeps,
  permanentFailureChannels: Set<string>,
): ReturnType<typeof setInterval> | null {
  if (deps.intervalMs <= 0 || !deps.channelState) return null;

  const { client, configuredChannels, channelState, logger } = deps;
  const warnedChannels = new Set<string>();

  return setInterval(() => {
    for (const ch of configuredChannels) {
      const inChannel = channelState.getChannel(ch.name) !== undefined;
      if (inChannel) {
        warnedChannels.delete(ch.name);
        continue;
      }
      // Stop retrying channels we already know are permanently failing
      // until the next reconnect reshuffles server state.
      if (permanentFailureChannels.has(ircLower(ch.name, 'rfc1459'))) {
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
}
