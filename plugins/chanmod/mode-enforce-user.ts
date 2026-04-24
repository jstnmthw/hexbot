// chanmod — per-user mode enforcement (bitch mode, re-op/halfop/voice, punish deop)
//
// Applies to -o / -h / -v events on individual users:
// - bitch mode: strip unauthorized +o/+h grants
// - user mode enforcement: re-op/re-halfop/re-voice users per their flag set
// - punish deop: kick+ban operators who strip ops from a recognized op
import type { PluginAPI } from '../../src/types';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  hasAnyFlag,
  markIntentional,
  wasIntentional,
} from './helpers';
import type { ModeContext, ThreatCallback } from './mode-enforce';
import {
  COOLDOWN_WINDOW_MS,
  type ChanmodConfig,
  MAX_ENFORCEMENTS,
  type SharedState,
} from './state';

/**
 * Punishment is harsher (kick/kickban) than mode re-enforcement, so the
 * cap is tighter and the window longer than the generic {@link
 * COOLDOWN_WINDOW_MS}: at most 2 punishments per setter per channel per
 * 30s. Prevents a deop loop between two bots from cascading into a flood
 * of kicks. The setter (not the target) is the cooldown key — punishment
 * is about the actor, not the victim.
 */
const PUNISH_MAX = 2;
const PUNISH_COOLDOWN_MS = 30_000;

/**
 * Bitch mode: strip unauthorized +o / +h.
 * Returns true if this event was handled (halts further processing).
 */
export function handleBitchMode(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  mctx: ModeContext,
  onThreat?: ThreatCallback,
): boolean {
  const { channel, setter, modeStr, target, isNodesynch } = mctx;
  const bitch = api.channelSettings.getFlag(channel, 'bitch');
  if (!bitch || (modeStr !== '+o' && modeStr !== '+h') || !target) return false;

  if (api.isBotNick(setter) || api.isBotNick(target)) return true;
  if (!isNodesynch && botHasOps(api, channel)) {
    const targetFlags = getUserFlags(api, channel, target);
    const isAuthorized =
      modeStr === '+o'
        ? hasAnyFlag(targetFlags, config.op_flags) && !targetFlags?.includes('d')
        : config.halfop_flags.length > 0 &&
          hasAnyFlag(targetFlags, config.halfop_flags) &&
          !targetFlags?.includes('d');

    if (!isAuthorized) {
      api.log(
        `Bitch: stripping ${modeStr} from ${api.stripFormatting(target)} in ${channel} (not flagged)`,
      );
      markIntentional(state, api, channel, target);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        if (modeStr === '+o') api.deop(channel, target);
        else api.dehalfop(channel, target);
      });
      // Report unauthorized op to threat detection
      if (onThreat && modeStr === '+o') {
        onThreat(channel, 'unauthorized_op', 2, setter, target);
      }
    }
  }
  return true;
}

/** User op/halfop/voice enforcement (+ optional punish deop). */
export function handleUserModeEnforcement(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  mctx: ModeContext,
  onThreat?: ThreatCallback,
): void {
  const { channel, setter, modeStr, target, enforceModes, isNodesynch } = mctx;
  if (modeStr !== '-o' && modeStr !== '-h' && modeStr !== '-v') return;
  if (api.isBotNick(setter)) return;
  if (wasIntentional(state, api, channel, target)) return;

  // -h/-v: only enforce if enforce_modes is on; punish_deop only applies to -o
  const protectOps = api.channelSettings.getFlag(channel, 'protect_ops');
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
      // Report to threat detection — direct enforcement failed, escalate
      if (onThreat) {
        onThreat(channel, 'enforcement_suppressed', 2, setter, target);
      }
      return;
    }
    cooldown.count++;
  } else {
    state.enforcementCooldown.set(cooldownKey, { count: 1, expiresAt: now + COOLDOWN_WINDOW_MS });
  }

  if (modeStr === '-o') {
    if (!botHasOps(api, channel)) return;
    const shouldBeOpped = hasAnyFlag(flags, config.op_flags) && !flags.includes('d');
    if (shouldBeOpped && enforceModes) {
      api.log(`Re-enforcing +o on ${target} in ${channel} (deopped by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.op(channel, target);
      });
    }
    // Report friendly op deopped to threat detection
    if (onThreat && shouldBeOpped && !isNodesynch) {
      onThreat(channel, 'friendly_deopped', 2, setter, target);
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
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.halfop(channel, target);
      });
    }
  } else {
    // modeStr is '-v' here — the guard above only passes -o/-h/-v, and -o/-h are handled above
    if (!botHasOps(api, channel)) return;
    const shouldBeVoiced = hasAnyFlag(flags, config.voice_flags);
    if (shouldBeVoiced) {
      api.log(`Re-enforcing +v on ${target} in ${channel} (devoiced by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.voice(channel, target);
      });
    }
  }
}

/** Punish an unauthorized operator who stripped ops from a recognized op. */
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
    const hostmask = api.getUserHostmask(channel, setter);
    if (hostmask) {
      const mask = buildBanMask(hostmask, 1);
      if (mask) {
        api.ban(channel, mask);
        api.banStore.storeBan(
          channel,
          mask,
          getBotNick(api),
          config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000,
        );
      }
    }
  }
  api.kick(channel, setter, config.punish_kick_reason);
  api.log(`Punished ${setter} in ${channel} for unauthorized deop (${config.punish_action})`);
}
