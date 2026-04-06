// chanmod — adversarial protection: rejoin on kick, revenge, nick recovery, stopnethack
import type { HandlerContext, PluginAPI } from '../../src/types';
import { storeBan } from './bans';
import {
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  hasAnyFlag,
  isBotNick,
  markIntentional,
} from './helpers';
import type { ThreatCallback } from './mode-enforce';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if a quit message looks like a netsplit (e.g. "hub.net leaf.net"). */
function isSplitQuit(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return false;
  const isDomain = (s: string): boolean => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*)\.[a-zA-Z]{2,}$/.test(s);
  return isDomain(parts[0]) && isDomain(parts[1]);
}

/** Snapshot ops in all configured channels into state.splitOpsSnapshot. */
function snapshotOps(api: PluginAPI, state: SharedState): void {
  state.splitOpsSnapshot.clear();
  for (const channel of api.botConfig.irc.channels) {
    const ch = api.getChannel(channel);
    if (!ch) continue;
    const ops = new Set<string>();
    for (const [nick, user] of ch.users) {
      if (user.modes.includes('o')) ops.add(nick); // nick key is already lowercased
    }
    if (ops.size > 0) {
      state.splitOpsSnapshot.set(api.ircLower(channel), ops);
    }
  }
}

interface RejoinRecord {
  count: number;
  windowStart: number;
}

/** Extract the kicker's nick from kick ctx.args ("reason (by Nick)" or "by Nick"). */
function parseKicker(args: string): string {
  const m = args.match(/\(by ([^)]+)\)$/) ?? args.match(/^by (.+)$/);
  return m?.[1]?.trim() ?? '';
}

export function setupProtection(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): () => void {
  /** Delay for services to process UNBAN/INVITE before we rejoin. */
  const SERVICES_PROCESSING_MS = 500;

  // ---------------------------------------------------------------------------
  // Rejoin on kick + revenge + backend-assisted recovery
  // ---------------------------------------------------------------------------

  api.bind('kick', '-', '*', (ctx: HandlerContext) => {
    const { nick: kicked, args } = ctx;
    const channel = ctx.channel!;

    // Only act when the bot itself is kicked
    if (!isBotNick(api, kicked)) return;

    const kickerNick = parseKicker(args);

    // Report to threat detection
    if (onThreat && kickerNick) {
      onThreat(channel, 'bot_kicked', 4, kickerNick, kicked);
    }

    // Snapshot last-known channel modes before we lose channel state
    const ch = api.getChannel(channel);
    if (ch) {
      state.lastKnownModes.set(api.ircLower(channel), {
        modes: ch.modes,
        key: ch.key,
      });
    }

    // --- Backend-assisted recovery (runs regardless of rejoin_on_kick) ---
    const chanKey = api.ircLower(channel);
    const unbanOnKick = api.channelSettings.getFlag(channel, 'chanserv_unban_on_kick');
    if (chain && unbanOnKick && chain.canUnban(channel)) {
      // Immediately request UNBAN — speed matters during a takeover
      chain.requestUnban(channel);
      state.unbanRequested.add(chanKey);
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
      if (stored) record = JSON.parse(stored) as RejoinRecord;
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

    // Use shorter delay when backend handled UNBAN (services need processing time)
    const useBackendDelay = state.unbanRequested.has(chanKey);
    const rejoinDelay = useBackendDelay ? SERVICES_PROCESSING_MS : config.rejoin_delay_ms;

    // Schedule rejoin
    state.scheduleCycle(rejoinDelay, () => {
      api.join(channel, api.getChannelKey(channel));
      api.log(`Rejoining ${channel} after being kicked`);

      // Schedule a backup retry in case the first rejoin fails (still banned).
      // If the bot is back in the channel by then, the join is harmless (server ignores it).
      if (useBackendDelay && record.count < config.max_rejoin_attempts) {
        state.scheduleCycle(config.chanserv_unban_retry_ms, () => {
          // Only retry if we're not in the channel yet
          if (!api.getChannel(channel)) {
            api.log(`Retry rejoin for ${channel} (first attempt may have failed due to ban)`);
            if (chain!.canUnban(channel)) {
              chain!.requestUnban(channel);
            }
            state.scheduleCycle(SERVICES_PROCESSING_MS, () => {
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

      state.scheduleCycle(config.revenge_delay_ms, () => {
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
          // revenge_action is 'kickban' — last remaining option after 'deop' and 'kick'
          const hostmask = api.getUserHostmask(channel, kickerNick);
          const mask = hostmask ? buildBanMask(hostmask, 1) : null;
          /* v8 ignore next 4 -- defensive: getUserHostmask returns empty only if the kicker already left the channel between kick and revenge */
          if (!mask) {
            api.warn(`Revenge: could not build ban mask for ${kickerNick} in ${channel}`);
            return;
          }
          api.ban(channel, mask);
          storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
          api.kick(channel, kickerNick, config.revenge_kick_reason);
          api.log(`Revenge: kickbanned ${kickerNick} from ${channel} for kicking bot`);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Nick recovery — reclaim desired nick when the holder releases it
  // ---------------------------------------------------------------------------

  if (config.nick_recovery) {
    const desiredNick = api.botConfig.irc.nick;
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
        state.scheduleCycle(2000, () => {
          api.changeNick(desiredNick);
        });
      } else {
        api.changeNick(desiredNick);
      }
    };

    api.bind('nick', '-', '*', (ctx: HandlerContext) => {
      if (api.ircLower(ctx.nick) === api.ircLower(desiredNick)) {
        attemptRecovery(`${ctx.nick} changed nick`);
      }
    });

    api.bind('quit', '-', '*', (ctx: HandlerContext) => {
      if (api.ircLower(ctx.nick) === api.ircLower(desiredNick)) {
        attemptRecovery(`${ctx.nick} quit`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Stopnethack — deop suspicious server-granted ops after netsplit rejoins
  // ---------------------------------------------------------------------------

  if (config.stopnethack_mode > 0) {
    const SPLIT_WINDOW_MS = 5000;
    const SPLIT_THRESHOLD = 3;

    // Detect netsplit via burst of split-quit messages
    api.bind('quit', '-', '*', (ctx: HandlerContext) => {
      if (!isSplitQuit(ctx.text)) return;

      const now = Date.now();
      if (now - state.splitQuitWindowStart > SPLIT_WINDOW_MS) {
        state.splitQuitCount = 0;
        state.splitQuitWindowStart = now;
      }
      state.splitQuitCount++;

      if (state.splitQuitCount >= SPLIT_THRESHOLD && !state.splitActive) {
        state.splitActive = true;
        state.splitExpiry = now + config.split_timeout_ms;
        api.log(
          `Stopnethack: netsplit detected (${state.splitQuitCount} split-quits) — monitoring +o for ${config.split_timeout_ms / 1000}s`,
        );
        snapshotOps(api, state);
      }
    });

    // Check suspicious +o grants during/after a split
    api.bind('mode', '-', '*', (ctx: HandlerContext) => {
      const channel = ctx.channel!;
      if (ctx.command !== '+o') return;

      // Only act within the split window
      if (!state.splitActive || Date.now() >= state.splitExpiry) {
        if (state.splitActive && Date.now() >= state.splitExpiry) {
          state.splitActive = false; // expire the window
        }
        return;
      }

      const target = ctx.args;
      if (!target || isBotNick(api, target)) return;

      let isLegitimate: boolean;
      if (config.stopnethack_mode === 1) {
        // isoptest: user must be in permissions db with an op-level flag
        const flags = getUserFlags(api, channel, target);
        isLegitimate = hasAnyFlag(flags, config.op_flags);
      } else {
        // stopnethack_mode === 2 (wasoptest) — only valid values are 1 and 2
        // wasoptest: user must have had ops before the split
        const snapshot = state.splitOpsSnapshot.get(api.ircLower(channel));
        isLegitimate = snapshot?.has(api.ircLower(target)) ?? false;
      }

      if (!isLegitimate && botHasOps(api, channel)) {
        api.log(
          `Stopnethack: deoping ${target} in ${channel} (mode ${config.stopnethack_mode}, not legitimate)`,
        );
        markIntentional(state, api, channel, target);
        state.scheduleEnforcement(config.enforce_delay_ms, () => {
          api.deop(channel, target);
        });
      }
    });
  }

  return () => {
    for (const timer of state.cycleTimers) clearTimeout(timer);
    state.cycleTimers.length = 0;
  };
}
