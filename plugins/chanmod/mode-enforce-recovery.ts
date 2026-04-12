// chanmod — recovery actions for bot deop/opped transitions
//
// Handles two events that bookend a takeover attempt:
// - bot self-deop: schedule ChanServ OP request + cycle-on-deop fallback
// - bot opped: post-RECOVER cleanup, mass re-op, hostile response, topic restore
//
// Also owns `performMassReop` and `performHostileResponse`, the batch
// recovery helpers called from handleBotOpped during elevated threat.
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
import {
  COOLDOWN_WINDOW_MS,
  type ChanmodConfig,
  MAX_ENFORCEMENTS,
  type SharedState,
} from './state';
import { THREAT_ACTIVE, THREAT_ALERT, getThreatLevel, getThreatState } from './takeover-detect';
import { restoreTopicIfNeeded } from './topic-recovery';

/**
 * Bot self-deop: ChanServ OP recovery + cycle.
 * Returns true if this event was handled (halts further processing).
 */
export function handleBotSelfDeop(
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
  if (modeStr !== '-o' || !api.isBotNick(target)) return false;

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
export function handleBotOpped(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  modeStr: string,
  target: string,
  chain?: ProtectionChain,
  _onThreat?: ThreatCallback,
): boolean {
  if (modeStr !== '+o' || !api.isBotNick(target)) return false;

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
    if (api.isBotNick(user.nick)) continue;

    const hostmask = api.buildHostmask(user);
    const rec = api.permissions.findByHostmask(hostmask);
    const globalFlags = rec?.global ?? '';
    const channelFlags = rec?.channels[api.ircLower(channel)] ?? '';
    const allFlags = globalFlags + channelFlags;

    const hasOps = user.modes.includes('o');
    const hasHalfop = user.modes.includes('h');
    const hasVoice = user.modes.includes('v');

    const deop = allFlags.includes('d');
    const shouldOp = !deop && hasAnyFlag(allFlags, config.op_flags);
    const shouldHalfop =
      !shouldOp &&
      !deop &&
      config.halfop_flags.length > 0 &&
      hasAnyFlag(allFlags, config.halfop_flags);
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
    if (api.isBotNick(actor)) continue;

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
          api.banStore.storeBan(
            channel,
            mask,
            getBotNick(api),
            config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000,
          );
        }
        markIntentional(state, api, channel, actor);
        api.kick(channel, actor, 'Takeover response');
        const suffix = punishMode === 'akick' ? ' (AKICK unavailable)' : '';
        api.log(`Hostile response: kickbanned ${actor} from ${channel}${suffix}`);
      }
    }
  }
}
