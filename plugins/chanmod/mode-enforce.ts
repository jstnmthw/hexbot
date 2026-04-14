// chanmod — mode enforcement wiring
//
// This file is the thin orchestrator: it binds the 'mode' handler, runs the
// sub-handlers in order, and owns the three tiny threat-probes that don't
// warrant their own file. The real logic lives in:
//
//   - mode-enforce-channel.ts    channel-wide mode enforcement + syncChannelModes
//   - mode-enforce-user.ts       per-user enforcement (bitch mode, re-op, punish deop)
//   - mode-enforce-recovery.ts   bot self-deop / bot opped / mass re-op / hostile response
//
// --- Handler contract ---
//
// The orchestrator runs the following sub-handlers per mode event, in order:
//
//   1. reapply         — re-apply a channel mode removed by an unauthorized setter
//   2. remove-unauth   — strip a channel mode that should not be set
//   3. key             — enforce +k / -k (channel key)
//   4. limit           — enforce +l / -l (channel user limit)
//   5. self-deop       — bot was deopped → ChanServ OP request + cycle fallback
//   6. opped           — bot regained ops → post-RECOVER cleanup + mass re-op + hostile response
//   7. bitch           — strip unauthorized +o / +h
//   8. bot-banned      — threat report + immediate unban when +b matches bot's hostmask
//   9. enforcebans     — kick channel members matching a new ban mask
//  10. user            — per-user -o/-h/-v re-enforcement + punish-deop
//
// Handlers that return `boolean` follow the convention that `true` means "halt
// subsequent handlers" — used by self-deop, opped, bitch, and enforcebans to
// prevent the later bot-banned / user handlers from reinterpreting the same
// event. Non-halting handlers (reapply, remove-unauth, key, limit, threat
// probes) return void; the orchestrator simply falls through to the next one.
//
// Shared guards (isNodesynch, canEnforce, enforceModes) are collected into a
// `ModeContext` object so handler signatures stay manageable — previously they
// threaded up to 9 positional args each.
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

/**
 * Shared context object passed to every mode sub-handler. Collects the event
 * fields and the pre-computed guards so handlers don't each recompute
 * nodesynch/ops/isSetter-bot checks.
 */
export interface ModeContext {
  channel: string;
  setter: string;
  modeStr: string;
  target: string;
  /** True if `setter` is in the configured nodesynch_nicks list. */
  isNodesynch: boolean;
  /** True if enforce_modes is on, bot has ops, setter isn't nodesynch or bot itself. */
  canEnforce: boolean;
  /** Raw enforce_modes setting (needed by user-mode handler to gate -h/-v). */
  enforceModes: boolean;
}

/**
 * A mode sub-handler. Returns `true` to halt subsequent halting handlers in
 * the order, `false`/`void` to continue.
 */
export type ModeHandler = (ctx: ModeContext) => boolean | void;

// ---------------------------------------------------------------------------
// Local threat probes — too small to warrant their own file
// ---------------------------------------------------------------------------

/** Threat detection: mode lockdown (+i, +k, +s) by non-nodesynch. */
function handleThreatModeLockdown(
  api: PluginAPI,
  mctx: ModeContext,
  onThreat?: ThreatCallback,
): void {
  const { channel, setter, modeStr, target, isNodesynch } = mctx;
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
  mctx: ModeContext,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): void {
  const { channel, setter, modeStr, target, isNodesynch } = mctx;
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
function handleEnforceBans(api: PluginAPI, state: SharedState, mctx: ModeContext): boolean {
  const { channel, modeStr, target } = mctx;
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

    const mctx: ModeContext = {
      channel,
      setter,
      modeStr,
      target,
      isNodesynch,
      canEnforce,
      enforceModes,
    };

    handleThreatModeLockdown(api, mctx, onThreat);
    handleReapplyRemovedModes(api, config, state, mctx, parsed);
    handleRemoveUnauthorizedModes(api, config, state, mctx, parsed);
    handleChannelKeyEnforcement(api, config, state, mctx);
    handleChannelLimitEnforcement(api, config, state, mctx);

    if (handleBotSelfDeop(api, config, state, mctx, chain, onThreat)) return;
    if (handleBotOpped(api, config, state, mctx, chain)) return;
    if (handleBitchMode(api, config, state, mctx, onThreat)) return;

    handleBotBannedThreat(api, mctx, chain, onThreat);

    if (handleEnforceBans(api, state, mctx)) return;

    handleUserModeEnforcement(api, config, state, mctx, onThreat);
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
    state.enforcementTimers.clear();
    state.cycles.clearAll();
    state.intentionalModeChanges.clear();
    state.enforcementCooldown.clear();
  };
}
