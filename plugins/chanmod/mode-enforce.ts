// chanmod — mode enforcement wiring
//
// This file is the thin orchestrator: it binds the 'mode' handler, runs the
// sub-handlers in order, and owns the three tiny threat-probes that don't
// warrant their own file. The real logic lives in:
//
//   - mode-enforce-channel.ts    channel-wide mode enforcement + syncChannelModes
//   - mode-enforce-user.ts       per-user enforcement (bitch mode, re-op, punish deop)
//   - mode-enforce-recovery.ts   bot self-deop / bot opped / mass re-op / hostile response
import type { PluginAPI } from '../../src/types';
import { wildcardMatch } from '../../src/utils/wildcard';
import {
  botHasOps,
  getBotNick,
  getParamModes,
  markIntentional,
  parseChannelModes,
} from './helpers';
import {
  MODE_SETTING_KEYS,
  handleChannelKeyEnforcement,
  handleChannelLimitEnforcement,
  handleReapplyRemovedModes,
  handleRemoveUnauthorizedModes,
  syncChannelModes,
} from './mode-enforce-channel';
import { handleBotOpped, handleBotSelfDeop } from './mode-enforce-recovery';
import { handleBitchMode, handleUserModeEnforcement } from './mode-enforce-user';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

// Re-export so existing callers can keep importing from './mode-enforce'.
export { syncChannelModes } from './mode-enforce-channel';

/** Callback for reporting threat events to the takeover detection engine. */
export type ThreatCallback = (
  channel: string,
  eventType: string,
  points: number,
  actor: string,
  target?: string,
) => void;

// ---------------------------------------------------------------------------
// Local threat probes — too small to warrant their own file
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
  if (onThreat && !isNodesynch && !api.isBotNick(setter)) {
    if (modeStr === '+i' || modeStr === '+s') {
      onThreat(channel, 'mode_locked', 1, setter);
    } else if (modeStr === '+k' && target) {
      onThreat(channel, 'mode_locked', 1, setter);
    }
  }
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
  if (modeStr !== '+b' || !target || isNodesynch || api.isBotNick(setter)) return;

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
    if (api.isBotNick(user.nick)) continue;
    const hostmask = api.buildHostmask(user);
    if (wildcardMatch(target, hostmask, true)) {
      api.log(`Enforcebans: kicking ${user.nick} from ${channel} (matches ${target})`);
      markIntentional(state, api, channel, user.nick);
      api.kick(channel, user.nick, 'You are banned');
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main setup — binds the 'mode' handler and wires the sub-handlers in order
// ---------------------------------------------------------------------------

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
  api.bind('mode', '-', '*', (ctx) => {
    const { nick: setter, command: modeStr, args: target, channel } = ctx;

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
      enforceModes && !isNodesynch && !api.isBotNick(setter) && botHasOps(api, channel);

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
    state.enforcementTimers.clear();
    state.cycleTimers.clear();
    state.cycleScheduled.clear();
    state.intentionalModeChanges.clear();
    state.enforcementCooldown.clear();
  };
}
