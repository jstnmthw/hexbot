// chanmod — mode enforcement: re-op, channel modes, cycle-on-deop, bitch mode, punish deop, enforcebans
import type { HandlerContext, PluginAPI } from '../../src/types';
import { wildcardMatch } from '../../src/utils/wildcard';
import { storeBan } from './bans';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  hasAnyFlag,
  isBotNick,
  markIntentional,
  parseModesSet,
  wasIntentional,
} from './helpers';
import {
  COOLDOWN_WINDOW_MS,
  type ChanmodConfig,
  MAX_ENFORCEMENTS,
  type SharedState,
} from './state';

const PUNISH_MAX = 2;
const PUNISH_COOLDOWN_MS = 30_000;

/**
 * Bind the mode enforcement handler for a channel.
 *
 * Enforces configured channel modes when they are removed:
 * - Simple modes (e.g. +i, +m, +s) listed in the `channel_modes` setting
 * - Channel key (+k) stored in `channel_key`
 * - Bitch mode: re-ops/re-voices users whose modes are removed without permission
 * - Punish deop: kicks+bans users who deop the bot (if `punish_deop` is enabled)
 * - Cycle on deop: the bot parts and rejoins to regain ops (if `cycle_on_deop` is enabled)
 *
 * All enforcement is gated on `enforce_modes` being set for the channel and
 * the bot having ops. nodesynch nicks are excluded.
 */
export function setupModeEnforce(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
): () => void {
  api.bind('mode', '-', '*', (ctx: HandlerContext) => {
    const { nick: setter, command: modeStr, args: target } = ctx;
    const channel = ctx.channel!;

    // Read per-channel settings (fall back to config default via channelSettings)
    const channelModes = api.channelSettings.get(channel, 'channel_modes') as string;
    const enforceChannelModeSet = parseModesSet(channelModes);

    // Shared guards reused by all channel-mode enforcement blocks below.
    const enforceModes = api.channelSettings.get(channel, 'enforce_modes') as boolean;
    const isNodesynch = config.nodesynch_nicks.some(
      (n) => api.ircLower(n) === api.ircLower(setter),
    );
    const canEnforce =
      enforceModes && !isNodesynch && !isBotNick(api, setter) && botHasOps(api, channel);

    // --- Simple channel mode enforcement (e.g. +imnpst) ---
    if (enforceChannelModeSet.size > 0 && modeStr.startsWith('-') && modeStr.length === 2) {
      const modeChar = modeStr[1];
      if (enforceChannelModeSet.has(modeChar) && canEnforce) {
        api.log(`Re-enforcing +${modeChar} on ${channel} (removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+' + modeChar);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    }

    // --- Channel key enforcement (+k / -k) ---
    const channelKey = api.channelSettings.get(channel, 'channel_key') as string;
    if (channelKey && canEnforce) {
      if (modeStr === '-k') {
        // Key was removed — restore it
        api.log(`Re-enforcing +k on ${channel} (key removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+k', channelKey);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
        /* v8 ignore start -- +k set to different key: FALSE branch (same key) unreachable in tests */
      } else if (modeStr === '+k' && target !== channelKey) {
        // Key was changed to something else — overwrite with the configured key
        api.log(`Re-enforcing channel key on ${channel} (changed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+k', channelKey);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
      /* v8 ignore stop */
    }

    // --- Channel limit enforcement (+l / -l) ---
    const channelLimit = api.channelSettings.get(channel, 'channel_limit') as number;
    if (channelLimit > 0 && canEnforce) {
      const limitStr = String(channelLimit);
      if (modeStr === '-l') {
        // Limit was removed — restore it
        api.log(`Re-enforcing +l ${channelLimit} on ${channel} (limit removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+l', limitStr);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
        /* v8 ignore start -- +l set to different limit: FALSE branch (same limit) unreachable in tests */
      } else if (modeStr === '+l' && target !== limitStr) {
        // Limit was changed — overwrite with the configured limit
        api.log(`Re-enforcing channel limit on ${channel} (changed to ${target} by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+l', limitStr);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
      /* v8 ignore stop */
    }

    // --- Bot self-deop → ChanServ OP recovery + cycle ---
    if (modeStr === '-o' && isBotNick(api, target)) {
      // Ask ChanServ to re-op the bot if it is present in the channel
      const chanservOp = api.channelSettings.get(channel, 'chanserv_op') as boolean;
      if (chanservOp) {
        const ch = api.getChannel(channel);
        const csNickLower = api.ircLower(config.chanserv_nick);
        if (ch?.users.has(csNickLower)) {
          api.log(`Requesting ops from ${config.chanserv_nick} in ${channel}`);
          const csTimer = setTimeout(() => {
            api.say(config.chanserv_nick, `OP ${channel}`);
          }, config.chanserv_op_delay_ms);
          state.cycleTimers.push(csTimer);
        }
      }

      if (config.cycle_on_deop && !state.cycleScheduled.has(api.ircLower(channel))) {
        const cooldownKey = `${api.ircLower(channel)}:cycle`;
        const now = Date.now();
        const cooldown = state.enforcementCooldown.get(cooldownKey);
        if (cooldown && now < cooldown.expiresAt) {
          cooldown.count++;
          if (cooldown.count >= MAX_ENFORCEMENTS) {
            const ch = api.getChannel(channel);
            /* v8 ignore start -- ?? FALSE branch: ch is always null in tests (channel state not populated via getChannel) */
            const isInviteOnly = ch?.modes.includes('i') ?? false;
            /* v8 ignore stop */
            /* v8 ignore next -- FALSE branch: isInviteOnly is always false in tests (ch is always null) */
            if (!isInviteOnly) {
              api.log(`Cycling ${channel} to regain ops`);
              state.cycleScheduled.add(api.ircLower(channel));
              const timer = setTimeout(() => {
                api.part(channel, 'Cycling to regain ops');
                const rejoinTimer = setTimeout(() => {
                  api.join(channel);
                  state.cycleScheduled.delete(api.ircLower(channel));
                  state.enforcementCooldown.delete(cooldownKey);
                }, 2000);
                state.cycleTimers.push(rejoinTimer);
              }, config.cycle_delay_ms);
              state.cycleTimers.push(timer);
            }
          }
        } else {
          state.enforcementCooldown.set(cooldownKey, {
            count: 1,
            expiresAt: now + COOLDOWN_WINDOW_MS,
          });
        }
      }
      return; // Don't apply user-flag enforcement for bot self-deop
    }

    // --- Bitch mode: strip unauthorized +o / +h ---
    const bitch = api.channelSettings.get(channel, 'bitch') as boolean;
    if (bitch && (modeStr === '+o' || modeStr === '+h') && target) {
      if (isBotNick(api, setter) || isBotNick(api, target)) return;
      if (!isNodesynch && botHasOps(api, channel)) {
        const targetFlags = getUserFlags(api, channel, target);
        const isAuthorized =
          modeStr === '+o'
            ? hasAnyFlag(targetFlags, config.op_flags)
            : config.halfop_flags.length > 0 && hasAnyFlag(targetFlags, config.halfop_flags);

        if (!isAuthorized) {
          api.log(`Bitch: stripping ${modeStr} from ${target} in ${channel} (not flagged)`);
          markIntentional(state, api, channel, target);
          const timer = setTimeout(() => {
            if (modeStr === '+o') api.deop(channel, target);
            else api.dehalfop(channel, target);
          }, config.enforce_delay_ms);
          state.enforcementTimers.push(timer);
        }
      }
      return;
    }

    // --- Enforcebans: kick channel members matching a new ban mask ---
    const enforcebans = api.channelSettings.get(channel, 'enforcebans') as boolean;
    if (enforcebans && modeStr === '+b' && target && botHasOps(api, channel)) {
      const ch = api.getChannel(channel)!;
      for (const user of ch.users.values()) {
        if (isBotNick(api, user.nick)) continue;
        const hostmask = `${user.nick}!${user.ident}@${user.hostname}`;
        if (wildcardMatch(target, hostmask, true)) {
          api.log(`Enforcebans: kicking ${user.nick} from ${channel} (matches ${target})`);
          markIntentional(state, api, channel, user.nick);
          api.kick(channel, user.nick, 'You are banned');
        }
      }
      return;
    }

    // --- User op/halfop/voice enforcement (+ optional punish deop) ---
    if (modeStr !== '-o' && modeStr !== '-h' && modeStr !== '-v') return;
    if (isBotNick(api, setter)) return;
    if (wasIntentional(state, api, channel, target)) return;

    // -h/-v: only enforce if enforce_modes is on; punish_deop only applies to -o
    const protectOps = api.channelSettings.get(channel, 'protect_ops') as boolean;
    if ((modeStr === '-h' || modeStr === '-v') && !enforceModes) return;
    // -o: process if either feature is enabled
    if (modeStr === '-o' && !enforceModes && !protectOps) return;

    const flags = getUserFlags(api, channel, target);
    if (!flags) return; // Unknown user — neither feature applies

    const cooldownKey = `${api.ircLower(channel)}:${api.ircLower(target)}`;
    const now = Date.now();
    const cooldown = state.enforcementCooldown.get(cooldownKey);
    if (cooldown && now < cooldown.expiresAt) {
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        api.warn(`Suppressing mode enforcement for ${target} in ${channel} — possible mode war`);
        return;
      }
      cooldown.count++;
    } else {
      state.enforcementCooldown.set(cooldownKey, { count: 1, expiresAt: now + COOLDOWN_WINDOW_MS });
    }

    if (modeStr === '-o') {
      if (!botHasOps(api, channel)) return;
      const shouldBeOpped = hasAnyFlag(flags, config.op_flags);
      if (shouldBeOpped && enforceModes) {
        api.log(`Re-enforcing +o on ${target} in ${channel} (deopped by ${setter})`);
        const timer = setTimeout(() => {
          api.op(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
      // Punish whoever stripped ops from a recognized op
      if (protectOps && shouldBeOpped) {
        const isSetterNodesynch = config.nodesynch_nicks.some(
          (n) => api.ircLower(n) === api.ircLower(setter),
        );
        if (!isSetterNodesynch) {
          const setterFlags = getUserFlags(api, channel, setter);
          const setterHasAuthority = hasAnyFlag(setterFlags, config.op_flags);
          if (!setterHasAuthority) {
            punishDeop(api, config, state, channel, setter);
          }
        }
      }
    } else if (modeStr === '-h') {
      if (!botCanHalfop(api, channel)) return;
      const shouldBeHalfopped =
        config.halfop_flags.length > 0 && hasAnyFlag(flags, config.halfop_flags);
      if (shouldBeHalfopped) {
        api.log(`Re-enforcing +h on ${target} in ${channel} (dehalfopped by ${setter})`);
        const timer = setTimeout(() => {
          api.halfop(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    } else {
      // modeStr is '-v' here — the guard above only passes -o/-h/-v, and -o/-h are handled above
      if (!botHasOps(api, channel)) return;
      const shouldBeVoiced = hasAnyFlag(flags, config.voice_flags);
      if (shouldBeVoiced) {
        api.log(`Re-enforcing +v on ${target} in ${channel} (devoiced by ${setter})`);
        const timer = setTimeout(() => {
          api.voice(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    }
  });

  return () => {
    for (const timer of state.enforcementTimers) clearTimeout(timer);
    for (const timer of state.cycleTimers) clearTimeout(timer);
    state.enforcementTimers.length = 0;
    state.cycleTimers.length = 0;
    state.cycleScheduled.clear();
    state.intentionalModeChanges.clear();
    state.enforcementCooldown.clear();
  };
}

function punishDeop(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
): void {
  const punishKey = `punish:${api.ircLower(channel)}:${api.ircLower(setter)}`;
  const now = Date.now();
  const entry = state.enforcementCooldown.get(punishKey);
  if (entry && now < entry.expiresAt) {
    if (entry.count >= PUNISH_MAX) {
      api.warn(`Suppressing deop punishment for ${setter} in ${channel} — rate limit`);
      return;
    }
    entry.count++;
  } else {
    state.enforcementCooldown.set(punishKey, { count: 1, expiresAt: now + PUNISH_COOLDOWN_MS });
  }

  markIntentional(state, api, channel, setter);

  if (config.punish_action === 'kickban') {
    const hostmask = api.getUserHostmask(channel, setter)!;
    const mask = buildBanMask(hostmask, 1)!;
    api.ban(channel, mask);
    storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
  }
  api.kick(channel, setter, config.punish_kick_reason);
  api.log(`Punished ${setter} in ${channel} for unauthorized deop (${config.punish_action})`);
}
