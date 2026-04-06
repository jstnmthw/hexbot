// chanmod — mode enforcement: re-op, channel modes, cycle-on-deop, bitch mode, punish deop, enforcebans
import type { HandlerContext, PluginAPI } from '../../src/types';
import { wildcardMatch } from '../../src/utils/wildcard';
import { storeBan } from './bans';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  getBotNick,
  getParamModes,
  getUserFlags,
  hasAnyFlag,
  hasParamModes,
  isBotNick,
  markIntentional,
  parseChannelModes,
  wasIntentional,
} from './helpers';
import type { ProtectionChain } from './protection-backend';
import {
  COOLDOWN_WINDOW_MS,
  type ChanmodConfig,
  MAX_ENFORCEMENTS,
  type SharedState,
} from './state';
import { THREAT_ACTIVE, THREAT_ALERT, getThreatLevel, getThreatState } from './takeover-detect';
import { restoreTopicIfNeeded } from './topic-recovery';

/** Callback for reporting threat events to the takeover detection engine. */
export type ThreatCallback = (
  channel: string,
  eventType: string,
  points: number,
  actor: string,
  target?: string,
) => void;

const PUNISH_MAX = 2;
const PUNISH_COOLDOWN_MS = 30_000;

/** Keys in channelSettings that should trigger a mode sync when changed. */
const MODE_SETTING_KEYS = new Set([
  'channel_modes',
  'channel_key',
  'channel_limit',
  'enforce_modes',
]);

// ---------------------------------------------------------------------------
// Extracted sub-handlers for the main mode bind handler in setupModeEnforce.
// Each function handles one logical block. Functions returning boolean signal
// the caller to stop processing (true = halt, matching the original `return;`).
// ---------------------------------------------------------------------------

/** Threat detection: mode lockdown (+i, +k, +s) by non-nodesynch. */
function handleThreatModeLockdown(
  api: PluginAPI,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  isNodesynch: boolean,
  onThreat?: ThreatCallback,
): void {
  if (onThreat && !isNodesynch && !isBotNick(api, setter)) {
    if (modeStr === '+i' || modeStr === '+s') {
      onThreat(channel, 'mode_locked', 1, setter);
    } else if (modeStr === '+k' && target) {
      onThreat(channel, 'mode_locked', 1, setter);
    }
  }
}

/** Re-apply removed modes that are in the add set. */
function handleReapplyRemovedModes(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  parsed: { add: Set<string>; remove: Set<string> },
  canEnforce: boolean,
): void {
  if (parsed.add.size > 0 && modeStr.startsWith('-') && modeStr.length === 2 && canEnforce) {
    const modeChar = modeStr[1];
    if (parsed.add.has(modeChar)) {
      api.log(`Re-enforcing +${modeChar} on ${channel} (removed by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '+' + modeChar);
      });
    }
  }
}

/**
 * Remove modes that are in the remove set.
 *
 * Only triggers for parameterless +X modes (user modes like +o/+v have a param,
 * so they're skipped). Modes not in the remove set are left alone.
 */
function handleRemoveUnauthorizedModes(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  parsed: { add: Set<string>; remove: Set<string> },
  canEnforce: boolean,
): void {
  if (modeStr.startsWith('+') && modeStr.length === 2 && !target && canEnforce) {
    const modeChar = modeStr[1];
    if (parsed.remove.has(modeChar)) {
      api.log(`Removing unauthorized +${modeChar} on ${channel} (in remove set, set by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '-' + modeChar);
      });
    }
  }
}

/** Channel key enforcement (+k / -k). */
function handleChannelKeyEnforcement(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  canEnforce: boolean,
): void {
  const channelKey = api.channelSettings.getString(channel, 'channel_key');
  if (channelKey && canEnforce) {
    if (modeStr === '-k') {
      // Key was removed — restore it
      api.log(`Re-enforcing +k on ${channel} (key removed by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '+k', channelKey);
      });
    } else if (modeStr === '+k' && target !== channelKey) {
      // Key was changed to something else — overwrite with the configured key
      api.log(`Re-enforcing channel key on ${channel} (changed by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '+k', channelKey);
      });
    }
  } else if (!channelKey && canEnforce && modeStr === '+k' && target) {
    // No key configured — remove the unauthorized key
    api.log(`Removing unauthorized +k on ${channel} (no channel_key configured, set by ${setter})`);
    state.scheduleEnforcement(config.enforce_delay_ms, () => {
      api.mode(channel, '-k', target);
    });
  }
}

/** Channel limit enforcement (+l / -l). */
function handleChannelLimitEnforcement(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  canEnforce: boolean,
): void {
  const channelLimit = api.channelSettings.getInt(channel, 'channel_limit');
  if (channelLimit > 0 && canEnforce) {
    const limitStr = String(channelLimit);
    if (modeStr === '-l') {
      // Limit was removed — restore it
      api.log(`Re-enforcing +l ${channelLimit} on ${channel} (limit removed by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '+l', limitStr);
      });
    } else if (modeStr === '+l' && target !== limitStr) {
      // Limit was changed — overwrite with the configured limit
      api.log(`Re-enforcing channel limit on ${channel} (changed to ${target} by ${setter})`);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.mode(channel, '+l', limitStr);
      });
    }
  } else if (channelLimit === 0 && canEnforce && modeStr === '+l') {
    // No limit configured — remove the unauthorized limit
    api.log(
      `Removing unauthorized +l on ${channel} (no channel_limit configured, set by ${setter})`,
    );
    state.scheduleEnforcement(config.enforce_delay_ms, () => {
      api.mode(channel, '-l');
    });
  }
}

/**
 * Bot self-deop: ChanServ OP recovery + cycle.
 * Returns true if this event was handled (halts further processing).
 */
function handleBotSelfDeop(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  isNodesynch: boolean,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): boolean {
  if (modeStr !== '-o' || !isBotNick(api, target)) return false;

  // Report to threat detection if not from a nodesynch nick
  if (onThreat && !isNodesynch) {
    onThreat(channel, 'bot_deopped', 3, setter, target);
  }

  // Ask ChanServ to re-op the bot via ProtectionChain (automatic when chanserv_access >= op)
  if (chain && chain.canOp(channel)) {
    // Zero delay during elevated threat — speed matters during a takeover
    const botDeopThreat = getThreatLevel(api, config, state, channel);
    const csDelay = botDeopThreat >= THREAT_ALERT ? 0 : config.chanserv_op_delay_ms;

    api.log(
      `Requesting ops via ProtectionChain in ${channel}${csDelay === 0 ? ' (zero delay — elevated threat)' : ''}`,
    );
    state.scheduleCycle(csDelay, () => {
      chain.requestOp(channel);
    });
  }

  if (config.cycle_on_deop && !state.cycleScheduled.has(api.ircLower(channel))) {
    const cooldownKey = `${api.ircLower(channel)}:cycle`;
    const now = Date.now();
    const cooldown = state.enforcementCooldown.get(cooldownKey);
    if (cooldown && now < cooldown.expiresAt) {
      cooldown.count++;
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        const ch = api.getChannel(channel);
        const isInviteOnly = ch?.modes.includes('i');
        if (!isInviteOnly) {
          api.log(`Cycling ${channel} to regain ops`);
          state.cycleScheduled.add(api.ircLower(channel));
          state.scheduleCycle(config.cycle_delay_ms, () => {
            api.part(channel, 'Cycling to regain ops');
            state.scheduleCycle(2000, () => {
              api.join(channel);
              state.cycleScheduled.delete(api.ircLower(channel));
              state.enforcementCooldown.delete(cooldownKey);
            });
          });
        }
      }
    } else {
      state.enforcementCooldown.set(cooldownKey, {
        count: 1,
        expiresAt: now + COOLDOWN_WINDOW_MS,
      });
    }
  }
  return true; // Don't apply user-flag enforcement for bot self-deop
}

/**
 * Post-RECOVER cleanup + mass re-op on bot opped.
 * Returns true if this event was handled (halts further processing).
 */
function handleBotOpped(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  modeStr: string,
  target: string,
  chain?: ProtectionChain,
  _onThreat?: ThreatCallback,
): boolean {
  if (modeStr !== '+o' || !isBotNick(api, target)) return false;

  const chanKey = api.ircLower(channel);

  // Atheme RECOVER cleanup: remove +i +m
  if (state.pendingRecoverCleanup.has(chanKey)) {
    state.pendingRecoverCleanup.delete(chanKey);
    api.log(`Post-RECOVER cleanup: removing +i +m on ${channel}`);
    state.scheduleEnforcement(config.enforce_delay_ms, () => {
      api.mode(channel, '-im');
    });
  }

  // Clear last-known modes after recovery
  state.lastKnownModes.delete(chanKey);

  // Mass re-op + hostile response + topic recovery during elevated threat level
  const threatLevel = getThreatLevel(api, config, state, channel);
  if (threatLevel >= THREAT_ALERT) {
    // Use takeover_response_delay_ms (default 0) for recovery actions — speed matters
    const recoveryDelay = config.takeover_response_delay_ms;

    const massReop = api.channelSettings.getFlag(channel, 'mass_reop_on_recovery');
    if (massReop) {
      state.scheduleEnforcement(recoveryDelay, () => {
        performMassReop(api, config, channel);
      });
    }

    // Hostile op response at Active+ threat level
    if (threatLevel >= THREAT_ACTIVE) {
      state.scheduleEnforcement(recoveryDelay, () => {
        performHostileResponse(api, config, state, channel, chain);
      });
    }

    // Topic recovery — restore pre-attack topic if it was vandalized
    state.scheduleEnforcement(recoveryDelay, () => {
      restoreTopicIfNeeded(api, config, state, channel);
    });
  }

  return true; // Don't apply bitch mode or other checks to bot being opped
}

/**
 * Bitch mode: strip unauthorized +o / +h.
 * Returns true if this event was handled (halts further processing).
 */
function handleBitchMode(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  isNodesynch: boolean,
  onThreat?: ThreatCallback,
): boolean {
  const bitch = api.channelSettings.getFlag(channel, 'bitch');
  if (!bitch || (modeStr !== '+o' && modeStr !== '+h') || !target) return false;

  if (isBotNick(api, setter) || isBotNick(api, target)) return true;
  if (!isNodesynch && botHasOps(api, channel)) {
    const targetFlags = getUserFlags(api, channel, target);
    const isAuthorized =
      modeStr === '+o'
        ? hasAnyFlag(targetFlags, config.op_flags)
        : config.halfop_flags.length > 0 && hasAnyFlag(targetFlags, config.halfop_flags);

    if (!isAuthorized) {
      api.log(`Bitch: stripping ${modeStr} from ${target} in ${channel} (not flagged)`);
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

/** Threat detection + immediate unban: bot banned (+b matching bot's hostmask). */
function handleBotBannedThreat(
  api: PluginAPI,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  isNodesynch: boolean,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): void {
  if (modeStr !== '+b' || !target || isNodesynch || isBotNick(api, setter)) return;

  const botNick = getBotNick(api);
  const botHostmask = api.getUserHostmask(channel, botNick);
  if (!botHostmask || !wildcardMatch(target, botHostmask, true)) return;

  if (onThreat) {
    onThreat(channel, 'bot_banned', 5, setter, target);
  }

  // Immediate unban — banning the bot is always hostile and the ban is a
  // time bomb if the bot parts/disconnects. Don't wait for threat scoring.
  if (chain && chain.canUnban(channel)) {
    api.log(`Bot banned in ${channel} by ${setter} — requesting immediate unban`);
    chain.requestUnban(channel);
  }
}

/**
 * Enforcebans: kick channel members matching a new ban mask.
 * Returns true if this event was handled (halts further processing).
 */
function handleEnforceBans(
  api: PluginAPI,
  state: SharedState,
  channel: string,
  modeStr: string,
  target: string,
): boolean {
  const enforcebans = api.channelSettings.getFlag(channel, 'enforcebans');
  if (!enforcebans || modeStr !== '+b' || !target || !botHasOps(api, channel)) return false;

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
  return true;
}

/** User op/halfop/voice enforcement (+ optional punish deop). */
function handleUserModeEnforcement(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
  modeStr: string,
  target: string,
  enforceModes: boolean,
  isNodesynch: boolean,
  onThreat?: ThreatCallback,
): void {
  if (modeStr !== '-o' && modeStr !== '-h' && modeStr !== '-v') return;
  if (isBotNick(api, setter)) return;
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
    const shouldBeOpped = hasAnyFlag(flags, config.op_flags);
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

/**
 * Synchronize a channel's modes to match the configured desired state.
 *
 * Compares the configured channel_modes, channel_key, and channel_limit against
 * the channel's current mode string (from channel-state) and issues corrective
 * MODE commands for any divergence. Safe to call repeatedly — redundant mode
 * sets are harmless (the server ignores them).
 *
 * Does NOT require enforce_modes — if modes are configured, they get applied.
 * The enforce_modes flag controls only the reactive enforcement in the mode handler.
 * Gated on bot having ops.
 */
export function syncChannelModes(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
): void {
  // Defer execution so that mode events (e.g. +o on the bot) settle before we check ops.
  state.scheduleEnforcement(config.enforce_delay_ms, () => {
    if (!botHasOps(api, channel)) return;

    const enforceModes = api.channelSettings.getFlag(channel, 'enforce_modes');
    const channelModes = api.channelSettings.getString(channel, 'channel_modes');
    const paramModes = getParamModes(api);
    if (hasParamModes(channelModes)) {
      api.warn(
        `channel_modes for ${channel} contains parameter modes (k/l) which are stripped — use channel_key and channel_limit instead`,
      );
    }
    const parsed = parseChannelModes(channelModes, paramModes);

    // Read current channel modes from channel-state
    const ch = api.getChannel(channel);
    if (!ch) return;
    const currentModes = ch.modes;

    // Add missing modes (only when enforcement is on)
    if (enforceModes && parsed.add.size > 0) {
      const missing = [...parsed.add].filter((m) => !currentModes.includes(m));
      if (missing.length > 0) {
        const modeString = '+' + missing.join('');
        api.mode(channel, modeString);
        api.log(`Enforcing ${modeString} on ${channel}`);
      }
    }

    // Remove modes explicitly listed in the remove set
    if (enforceModes && parsed.remove.size > 0 && currentModes) {
      const toRemove = [...currentModes].filter((m) => parsed.remove.has(m) && !paramModes.has(m));
      if (toRemove.length > 0) {
        const modeString = '-' + toRemove.join('');
        api.mode(channel, modeString);
        api.log(`Enforcing ${modeString} on ${channel}`);
      }
    }

    // Enforce channel key
    const channelKey = api.channelSettings.getString(channel, 'channel_key');
    if (channelKey) {
      // Set or overwrite the key if it doesn't match
      if (!ch?.key || ch.key !== channelKey) {
        api.mode(channel, '+k', channelKey);
        api.log(`Synced channel key on ${channel}`);
      }
    } else if (enforceModes && ch?.key) {
      // No key configured — remove the unauthorized key
      api.mode(channel, '-k', ch.key);
      api.log(`Removing unauthorized channel key on ${channel}`);
    }

    // Enforce channel limit
    const channelLimit = api.channelSettings.getInt(channel, 'channel_limit');
    if (channelLimit > 0) {
      if (!ch?.limit || ch.limit !== channelLimit) {
        api.mode(channel, '+l', String(channelLimit));
        api.log(`Synced channel limit (+l ${channelLimit}) on ${channel}`);
      }
    } else if (enforceModes && ch?.limit && ch.limit > 0) {
      // No limit configured — remove the unauthorized limit
      api.mode(channel, '-l');
      api.log(`Removing unauthorized channel limit on ${channel}`);
    }
  });
}

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
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): () => void {
  api.bind('mode', '-', '*', (ctx: HandlerContext) => {
    const { nick: setter, command: modeStr, args: target } = ctx;
    if (!ctx.channel) return;
    const channel = ctx.channel;

    // Read per-channel settings (fall back to config default via channelSettings)
    const channelModes = api.channelSettings.getString(channel, 'channel_modes');
    const paramModes = getParamModes(api);
    const parsed = parseChannelModes(channelModes, paramModes);

    // Shared guards reused by all channel-mode enforcement blocks below.
    const enforceModes = api.channelSettings.getFlag(channel, 'enforce_modes');
    const isNodesynch = config.nodesynch_nicks.some(
      (n) => api.ircLower(n) === api.ircLower(setter),
    );
    const canEnforce =
      enforceModes && !isNodesynch && !isBotNick(api, setter) && botHasOps(api, channel);

    handleThreatModeLockdown(api, channel, setter, modeStr, target, isNodesynch, onThreat);
    handleReapplyRemovedModes(api, config, state, channel, setter, modeStr, parsed, canEnforce);
    handleRemoveUnauthorizedModes(
      api,
      config,
      state,
      channel,
      setter,
      modeStr,
      target,
      parsed,
      canEnforce,
    );
    handleChannelKeyEnforcement(api, config, state, channel, setter, modeStr, target, canEnforce);
    handleChannelLimitEnforcement(api, config, state, channel, setter, modeStr, target, canEnforce);

    if (
      handleBotSelfDeop(
        api,
        config,
        state,
        channel,
        setter,
        modeStr,
        target,
        isNodesynch,
        chain,
        onThreat,
      )
    )
      return;
    if (handleBotOpped(api, config, state, channel, modeStr, target, chain, onThreat)) return;
    if (
      handleBitchMode(api, config, state, channel, setter, modeStr, target, isNodesynch, onThreat)
    )
      return;

    handleBotBannedThreat(api, channel, setter, modeStr, target, isNodesynch, chain, onThreat);

    if (handleEnforceBans(api, state, channel, modeStr, target)) return;

    handleUserModeEnforcement(
      api,
      config,
      state,
      channel,
      setter,
      modeStr,
      target,
      enforceModes,
      isNodesynch,
      onThreat,
    );
  });

  // --- Immediate sync on .chanset changes ---
  // When an operator changes channel_modes, channel_key, channel_limit, or enforce_modes,
  // immediately sync the channel's modes to match the new configuration.
  api.channelSettings.onChange((channel: string, key: string) => {
    if (MODE_SETTING_KEYS.has(key)) {
      syncChannelModes(api, config, state, channel);
    }
  });

  // --- Sync on bot join (chained to RPL_CHANNELMODEIS reply) ---
  // auto-op.ts sends MODE #channel on bot join; channel-state populates modes/key/limit
  // from the reply and emits channel:modesReady. We sync here so state is guaranteed current.
  api.onModesReady((channel: string) => {
    syncChannelModes(api, config, state, channel);
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

/**
 * After the bot regains ops during an elevated threat, scan all channel
 * users and batch re-op/halfop/voice flagged users, deop unauthorized ops.
 */
function performMassReop(api: PluginAPI, config: ChanmodConfig, channel: string): void {
  const ch = api.getChannel(channel);
  if (!ch) return;

  const bitch = api.channelSettings.getFlag(channel, 'bitch');

  const toOp: string[] = [];
  const toDeop: string[] = [];
  const toHalfop: string[] = [];
  const toVoice: string[] = [];

  for (const [, user] of ch.users) {
    if (isBotNick(api, user.nick)) continue;

    const hostmask = `${user.nick}!${user.ident}@${user.hostname}`;
    const rec = api.permissions.findByHostmask(hostmask);
    const globalFlags = rec?.global ?? '';
    const channelFlags = rec?.channels[api.ircLower(channel)] ?? '';
    const allFlags = globalFlags + channelFlags;

    const hasOps = user.modes.includes('o');
    const hasHalfop = user.modes.includes('h');
    const hasVoice = user.modes.includes('v');

    const shouldOp = hasAnyFlag(allFlags, config.op_flags);
    const shouldHalfop =
      !shouldOp && config.halfop_flags.length > 0 && hasAnyFlag(allFlags, config.halfop_flags);
    const shouldVoice = !shouldOp && !shouldHalfop && hasAnyFlag(allFlags, config.voice_flags);

    // Re-op flagged users who lost ops
    if (shouldOp && !hasOps) {
      toOp.push(user.nick);
    }
    // Deop unauthorized ops (bitch mode logic applied en masse)
    if (bitch && hasOps && !shouldOp) {
      toDeop.push(user.nick);
    }
    // Re-halfop
    if (shouldHalfop && !hasHalfop) {
      toHalfop.push(user.nick);
    }
    // Re-voice
    if (shouldVoice && !hasVoice) {
      toVoice.push(user.nick);
    }
  }

  // Send batched mode changes — api.mode() handles ISUPPORT MODES batching
  if (toOp.length > 0) {
    api.mode(channel, '+' + 'o'.repeat(toOp.length), ...toOp);
    api.log(`Mass re-op: opping ${toOp.length} users in ${channel}: ${toOp.join(', ')}`);
  }
  if (toDeop.length > 0) {
    api.mode(channel, '-' + 'o'.repeat(toDeop.length), ...toDeop);
    api.log(
      `Mass re-op: deopping ${toDeop.length} unauthorized ops in ${channel}: ${toDeop.join(', ')}`,
    );
  }
  if (toHalfop.length > 0) {
    api.mode(channel, '+' + 'h'.repeat(toHalfop.length), ...toHalfop);
    api.log(
      `Mass re-op: halfopping ${toHalfop.length} users in ${channel}: ${toHalfop.join(', ')}`,
    );
  }
  if (toVoice.length > 0) {
    api.mode(channel, '+' + 'v'.repeat(toVoice.length), ...toVoice);
    api.log(`Mass re-op: voicing ${toVoice.length} users in ${channel}: ${toVoice.join(', ')}`);
  }
}

/**
 * Counter-attack hostile actors identified in the threat event log.
 * Called when bot regains ops at threat level >= Active (2).
 *
 * Punishment level is configured via `takeover_punish`:
 * - 'none': no counter-attack
 * - 'deop': strip hostile ops
 * - 'kickban': kick+ban hostiles
 * - 'akick': ChanServ AKICK (persistent, requires superop+)
 */
function performHostileResponse(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  chain?: ProtectionChain,
): void {
  const punishMode = api.channelSettings.getString(channel, 'takeover_punish');
  if (punishMode === 'none') return;

  const threat = getThreatState(api, state, channel);
  if (!threat) return;

  // Collect unique hostile actors from the threat event log
  const hostileActors = new Set<string>();
  for (const event of threat.events) {
    if (event.actor) hostileActors.add(event.actor);
  }

  const ch = api.getChannel(channel);
  if (!ch) return;

  for (const actor of hostileActors) {
    // Skip the bot itself
    if (isBotNick(api, actor)) continue;

    // Skip nodesynch nicks
    if (config.nodesynch_nicks.some((n) => api.ircLower(n) === api.ircLower(actor))) continue;

    // Respect revenge_exempt_flags — n/m users are never counter-attacked
    const flags = getUserFlags(api, channel, actor);
    if (flags && hasAnyFlag(flags, config.revenge_exempt_flags)) {
      api.log(`Hostile response: skipping ${actor} in ${channel} — exempt flag`);
      continue;
    }

    // Check if the actor is still in the channel
    const actorLower = api.ircLower(actor);
    if (!ch.users.has(actorLower)) continue;

    if (punishMode === 'deop') {
      // Direct deop if bot has ops, or via chain
      if (botHasOps(api, channel)) {
        markIntentional(state, api, channel, actor);
        api.deop(channel, actor);
        api.log(`Hostile response: deopped ${actor} in ${channel}`);
      } else if (chain?.canDeop(channel)) {
        chain.requestDeop(channel, actor);
        api.log(`Hostile response: requested DEOP for ${actor} in ${channel} via backend`);
      }
    } else if (punishMode === 'kickban' || punishMode === 'akick') {
      const hostmask = api.getUserHostmask(channel, actor);
      const mask = hostmask ? buildBanMask(hostmask, config.default_ban_type) : null;

      if (punishMode === 'akick' && chain?.canAkick(channel)) {
        // AKICK via backend (persistent — survives rejoin)
        if (mask) {
          chain.requestAkick(channel, mask, 'Takeover response');
          api.log(`Hostile response: AKICK ${mask} in ${channel} via backend`);
        }
      } else {
        // kickban (or akick fallback when backend unavailable)
        if (mask) {
          api.ban(channel, mask);
          storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
        }
        markIntentional(state, api, channel, actor);
        api.kick(channel, actor, 'Takeover response');
        const suffix = punishMode === 'akick' ? ' (AKICK unavailable)' : '';
        api.log(`Hostile response: kickbanned ${actor} from ${channel}${suffix}`);
      }
    }
  }
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
    const hostmask = api.getUserHostmask(channel, setter);
    if (hostmask) {
      const mask = buildBanMask(hostmask, 1);
      if (mask) {
        api.ban(channel, mask);
        storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
      }
    }
  }
  api.kick(channel, setter, config.punish_kick_reason);
  api.log(`Punished ${setter} in ${channel} for unauthorized deop (${config.punish_action})`);
}
