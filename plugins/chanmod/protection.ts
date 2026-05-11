// chanmod — adversarial protection: rejoin on kick, revenge, nick recovery
// Stopnethack lives in ./stopnethack.ts.
import type { PluginAPI } from '../../src/types';
import {
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  hasAnyFlag,
  markIntentional,
} from './helpers';
import type { ThreatCallback } from './mode-enforce';
import type { ProtectionChain } from './protection-backend';
import { type ChanmodConfig, PENDING_STATE_TTL_MS, type SharedState } from './state';
import { setupStopnethack } from './stopnethack';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RejoinRecord {
  count: number;
  windowStart: number;
}

/** Structural guard for rejoin-attempt records persisted in `api.db`. */
function isRejoinRecord(value: unknown): value is RejoinRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.count === 'number' && typeof v.windowStart === 'number';
}

/**
 * Extract the kicker's nick from a kick ctx.args payload.
 *
 * The IRC bridge serialises the kicker into the `args` field in one of two
 * shapes depending on whether a kick reason was provided:
 *   - `"the reason here (by Nick)"` — reason plus trailing attribution
 *   - `"by Nick"`                   — no reason, just attribution
 * Returns an empty string when neither shape matches (kicker unknown — we
 * skip revenge/threat-scoring on empty).
 */
function parseKicker(args: string): string {
  const m = args.match(/\(by ([^)]+)\)$/) ?? args.match(/^by (.+)$/);
  return m?.[1]?.trim() ?? '';
}

/**
 * Register the adversarial-protection binds:
 *   - kick handler: rejoin-on-kick with rate limit, backend-assisted UNBAN
 *     + INVITE, scheduled revenge after `revenge_delay_ms`
 *   - nick handler / quit handler: nick recovery (optionally via NickServ
 *     GHOST) when the configured nick is released
 *   - stopnethack: delegated to {@link setupStopnethack}
 *
 * Rate-limit state is persisted in `api.db` under `rejoin_attempts:<chan>`
 * so a restart loop cannot bypass `max_rejoin_attempts`.
 */
export function setupProtection(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): () => void {
  /**
   * Delay between dispatching ChanServ UNBAN/INVITE and the actual JOIN
   * retry. 500ms covers typical services round-trip on ircd-hybrid +
   * Atheme; shorter delays race the JOIN against the still-applied ban
   * mode and produce a second `banned_from_channel` that resets backoff.
   * If a deployment sees consistent rejoin failures, raise this rather
   * than the configured `rejoin_delay_ms` — the latter is the user-facing
   * knob for the no-services case.
   */
  const SERVICES_PROCESSING_MS = 500;

  // ---------------------------------------------------------------------------
  // Rejoin on kick + revenge + backend-assisted recovery
  // ---------------------------------------------------------------------------

  api.bind('kick', '-', '*', (ctx) => {
    const { nick: kicked, args, channel } = ctx;

    // Only act when the bot itself is kicked
    if (!api.isBotNick(kicked)) return;

    const kickerNick = parseKicker(args);

    // Report to threat detection
    if (onThreat && kickerNick) {
      onThreat(channel, 'bot_kicked', 4, kickerNick, kicked);
    }

    // Snapshot last-known channel modes before we lose channel state.
    // `setAt` lets `pruneExpiredState` drop stale snapshots from kicks
    // that never recovered (otherwise the entry sits until reload).
    const ch = api.getChannel(channel);
    if (ch) {
      state.lastKnownModes.set(api.ircLower(channel), {
        modes: ch.modes,
        key: ch.key,
        setAt: Date.now(),
      });
    }

    // --- Backend-assisted recovery (runs regardless of rejoin_on_kick) ---
    const chanKey = api.ircLower(channel);
    const unbanOnKick = api.channelSettings.getFlag(channel, 'chanserv_unban_on_kick');
    if (chain && unbanOnKick && chain.canUnban(channel)) {
      // Immediately request UNBAN — speed matters during a takeover
      chain.requestUnban(channel);
      state.unbanRequested.set(chanKey, Date.now() + PENDING_STATE_TTL_MS);
      api.log(`Backend recovery: sent UNBAN for ${channel} after kick`);

      // If channel had +i or +k, also request invite
      const lastModes = state.lastKnownModes.get(chanKey);
      if (lastModes && (lastModes.modes.includes('i') || lastModes.key)) {
        if (chain.canInvite(channel)) {
          chain.requestInvite(channel);
          api.log(`Backend recovery: sent INVITE for ${channel} (+i or +k detected)`);
        }
      }
    }

    if (!config.rejoin_on_kick) return;

    // Rate-limiting: track rejoin attempts per channel in the DB
    const dbKey = `rejoin_attempts:${chanKey}`;
    const now = Date.now();
    let record: RejoinRecord = { count: 0, windowStart: now };
    try {
      const stored = api.db.get(dbKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (isRejoinRecord(parsed)) record = parsed;
      }
    } catch {
      /* corrupt entry — start fresh */
    }

    // Reset window if expired
    if (now - record.windowStart > config.rejoin_attempt_window_ms) {
      record = { count: 0, windowStart: now };
    }

    if (record.count >= config.max_rejoin_attempts) {
      api.warn(
        `Rejoin suppressed for ${channel} — reached ${config.max_rejoin_attempts} attempts in window`,
      );
      return;
    }

    record.count++;
    api.db.set(dbKey, JSON.stringify(record));

    // Use shorter delay when backend handled UNBAN (services need processing time).
    // Skip a stale record — if the prior unban request is past its TTL, services
    // either never processed it (and won't now) or processed it long enough ago
    // that we shouldn't shortcut the normal rejoin delay on its account.
    const unbanExpiresAt = state.unbanRequested.get(chanKey);
    const useBackendDelay = unbanExpiresAt !== undefined && Date.now() < unbanExpiresAt;
    if (unbanExpiresAt !== undefined && !useBackendDelay) {
      // Drop the stale entry now rather than waiting for the next sweep.
      state.unbanRequested.delete(chanKey);
    }
    const rejoinDelay = useBackendDelay ? SERVICES_PROCESSING_MS : config.rejoin_delay_ms;

    // Schedule rejoin
    state.cycles.schedule(rejoinDelay, () => {
      api.join(channel, api.getChannelKey(channel));
      api.log(`Rejoining ${channel} after being kicked`);

      // Schedule a backup retry in case the first rejoin fails (still banned).
      // If the bot is back in the channel by then, the join is harmless (server ignores it).
      if (useBackendDelay && record.count < config.max_rejoin_attempts) {
        state.cycles.schedule(config.chanserv_unban_retry_ms, () => {
          // Only retry if we're not in the channel yet
          if (!api.getChannel(channel)) {
            api.log(`Retry rejoin for ${channel} (first attempt may have failed due to ban)`);
            if (chain && chain.canUnban(channel)) {
              chain.requestUnban(channel);
            }
            state.cycles.schedule(SERVICES_PROCESSING_MS, () => {
              api.join(channel, api.getChannelKey(channel));
            });
          }
        });
      }

      // Clear the unban-requested flag after rejoin
      state.unbanRequested.delete(chanKey);

      // Request ops via backend after rejoin
      if (chain && chain.canOp(channel)) {
        chain.requestOp(channel);
        api.log(`Backend recovery: requested OP for ${channel} after rejoin`);
      }

      // Schedule revenge after rejoin (if configured per-channel)
      const revenge = api.channelSettings.getFlag(channel, 'revenge');
      if (!revenge || !kickerNick) return;

      state.cycles.schedule(config.revenge_delay_ms, () => {
        // Verify kicker is still in the channel
        const rch = api.getChannel(channel);
        if (!rch) return;
        const kickerLower = api.ircLower(kickerNick);
        if (!rch.users.has(kickerLower)) return;

        // Check bot has ops
        if (!botHasOps(api, channel)) {
          api.log(`Revenge skipped for ${kickerNick} in ${channel} — no ops`);
          return;
        }

        // Check exempt flags
        if (config.revenge_exempt_flags) {
          const flags = getUserFlags(api, channel, kickerNick);
          if (hasAnyFlag(flags, config.revenge_exempt_flags)) {
            api.log(`Revenge skipped for ${kickerNick} in ${channel} — exempt flag`);
            return;
          }
        }

        markIntentional(state, api, channel, kickerNick);

        if (config.revenge_action === 'deop') {
          api.deop(channel, kickerNick);
          api.log(`Revenge: deopped ${kickerNick} in ${channel} for kicking bot`);
        } else if (config.revenge_action === 'kick') {
          api.kick(channel, kickerNick, config.revenge_kick_reason);
          api.log(`Revenge: kicked ${kickerNick} from ${channel} for kicking bot`);
        } else {
          // revenge_action is 'kickban' — last remaining option after 'deop' and 'kick'.
          // Ban-type 1 = `*!*@host` — strongest practical ban from a single nick;
          // type 2/3 are too narrow for revenge against an actor that just demonstrated
          // willingness to kick the bot.
          const hostmask = api.getUserHostmask(channel, kickerNick);
          const mask = hostmask ? buildBanMask(hostmask, 1) : null;
          /* v8 ignore next 4 -- defensive: getUserHostmask returns empty only if the kicker already left the channel between kick and revenge */
          if (!mask) {
            api.warn(`Revenge: could not build ban mask for ${kickerNick} in ${channel}`);
            return;
          }
          api.ban(channel, mask);
          api.banStore.storeBan(
            channel,
            mask,
            getBotNick(api),
            config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000,
          );
          api.kick(channel, kickerNick, config.revenge_kick_reason);
          api.log(`Revenge: kickbanned ${kickerNick} from ${channel} for kicking bot`);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Drop rejoin-attempt KV on successful bot rejoin
  //
  // Without this, every successful rejoin-after-kick leaves a per-channel
  // record in `kv` that's never cleaned up. The map grows monotonically
  // across reboots — after months of operation against a chronically
  // hostile channel, it's a pile of dead state. The window-expiry check
  // in the kick handler does still work (records past
  // `rejoin_attempt_window_ms` reset to count=0) but the row itself sticks.
  // ---------------------------------------------------------------------------

  api.bind('join', '-', '*', (ctx) => {
    if (!api.isBotNick(ctx.nick)) return;
    api.db.del(`rejoin_attempts:${api.ircLower(ctx.channel)}`);
  });

  // ---------------------------------------------------------------------------
  // Nick recovery — reclaim desired nick when the holder releases it
  // ---------------------------------------------------------------------------

  if (config.nick_recovery) {
    const desiredNick = api.botConfig.irc.nick;
    /**
     * Throttle nick-recovery attempts. A flapping holder (rapid
     * QUIT/JOIN cycles or repeated nick changes) would otherwise drive
     * a NICK or GHOST per event — the latter is rate-limited by services
     * and 30s leaves headroom under typical NickServ floodprot.
     */
    const BACKOFF_MS = 30_000;
    let lastAttemptMs = 0;

    const attemptRecovery = (reason: string): void => {
      const now = Date.now();
      if (now - lastAttemptMs < BACKOFF_MS) return;
      lastAttemptMs = now;
      api.log(`Nick recovery: ${reason} — attempting to reclaim ${desiredNick}`);

      if (config.nick_recovery_ghost && config.nick_recovery_password) {
        // GHOST via NickServ — password is never logged
        api.say('NickServ', `GHOST ${desiredNick} ${config.nick_recovery_password}`);
        state.cycles.schedule(2000, () => {
          api.changeNick(desiredNick);
        });
      } else {
        api.changeNick(desiredNick);
      }
    };

    api.bind('nick', '-', '*', (ctx) => {
      if (api.ircLower(ctx.nick) === api.ircLower(desiredNick)) {
        attemptRecovery(`${ctx.nick} changed nick`);
      }
    });

    api.bind('quit', '-', '*', (ctx) => {
      if (api.ircLower(ctx.nick) === api.ircLower(desiredNick)) {
        attemptRecovery(`${ctx.nick} quit`);
      }
    });
  }

  // Stopnethack (netsplit-aware op protection) lives in ./stopnethack.ts.
  // Capture its teardown so any future per-stopnethack resource gets
  // released alongside the protection-chain cycles.
  const stopnethackTeardown = setupStopnethack(api, config, state);

  return () => {
    stopnethackTeardown();
    state.cycles.clearAll();
  };
}
