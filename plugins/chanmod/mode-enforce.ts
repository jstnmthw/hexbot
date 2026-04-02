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
  const timer = setTimeout(() => {
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
    /* v8 ignore next -- guard for race: channel parted between setTimeout and execution; untestable without real async IRC */
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
  }, config.enforce_delay_ms);
  state.enforcementTimers.push(timer);
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
    const channel = ctx.channel!;

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

    // --- Threat detection: mode lockdown (+i, +k, +s) by non-nodesynch ---
    if (onThreat && !isNodesynch && !isBotNick(api, setter)) {
      if (modeStr === '+i' || modeStr === '+s') {
        onThreat(channel, 'mode_locked', 1, setter);
      } else if (modeStr === '+k' && target) {
        onThreat(channel, 'mode_locked', 1, setter);
      }
    }

    // --- Re-apply removed modes that are in the add set ---
    if (parsed.add.size > 0 && modeStr.startsWith('-') && modeStr.length === 2 && canEnforce) {
      const modeChar = modeStr[1];
      if (parsed.add.has(modeChar)) {
        api.log(`Re-enforcing +${modeChar} on ${channel} (removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+' + modeChar);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    }

    // --- Remove modes that are in the remove set ---
    // Only triggers for parameterless +X modes (user modes like +o/+v have a param, so they're skipped).
    // Modes not in the remove set are left alone (unmentioned = ignored).
    if (modeStr.startsWith('+') && modeStr.length === 2 && !target && canEnforce) {
      const modeChar = modeStr[1];
      if (parsed.remove.has(modeChar)) {
        api.log(
          `Removing unauthorized +${modeChar} on ${channel} (in remove set, set by ${setter})`,
        );
        const timer = setTimeout(() => {
          api.mode(channel, '-' + modeChar);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    }

    // --- Channel key enforcement (+k / -k) ---
    const channelKey = api.channelSettings.getString(channel, 'channel_key');
    if (channelKey && canEnforce) {
      if (modeStr === '-k') {
        // Key was removed — restore it
        api.log(`Re-enforcing +k on ${channel} (key removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+k', channelKey);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      } else if (modeStr === '+k' && target !== channelKey) {
        // Key was changed to something else — overwrite with the configured key
        api.log(`Re-enforcing channel key on ${channel} (changed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+k', channelKey);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    } else if (!channelKey && canEnforce && modeStr === '+k' && target) {
      // No key configured — remove the unauthorized key
      api.log(
        `Removing unauthorized +k on ${channel} (no channel_key configured, set by ${setter})`,
      );
      const timer = setTimeout(() => {
        api.mode(channel, '-k', target);
      }, config.enforce_delay_ms);
      state.enforcementTimers.push(timer);
    }

    // --- Channel limit enforcement (+l / -l) ---
    const channelLimit = api.channelSettings.getInt(channel, 'channel_limit');
    if (channelLimit > 0 && canEnforce) {
      const limitStr = String(channelLimit);
      if (modeStr === '-l') {
        // Limit was removed — restore it
        api.log(`Re-enforcing +l ${channelLimit} on ${channel} (limit removed by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+l', limitStr);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      } else if (modeStr === '+l' && target !== limitStr) {
        // Limit was changed — overwrite with the configured limit
        api.log(`Re-enforcing channel limit on ${channel} (changed to ${target} by ${setter})`);
        const timer = setTimeout(() => {
          api.mode(channel, '+l', limitStr);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    } else if (channelLimit === 0 && canEnforce && modeStr === '+l') {
      // No limit configured — remove the unauthorized limit
      api.log(
        `Removing unauthorized +l on ${channel} (no channel_limit configured, set by ${setter})`,
      );
      const timer = setTimeout(() => {
        api.mode(channel, '-l');
      }, config.enforce_delay_ms);
      state.enforcementTimers.push(timer);
    }

    // --- Bot self-deop → ChanServ OP recovery + cycle ---
    if (modeStr === '-o' && isBotNick(api, target)) {
      // Report to threat detection if not from a nodesynch nick
      if (onThreat && !isNodesynch) {
        onThreat(channel, 'bot_deopped', 3, setter, target);
      }

      // Ask ChanServ to re-op the bot — prefer ProtectionChain if available and capable
      const chanservOp = api.channelSettings.getFlag(channel, 'chanserv_op');
      if (chanservOp) {
        // Zero delay during elevated threat — speed matters during a takeover
        const botDeopThreat = getThreatLevel(api, config, state, channel);
        const csDelay = botDeopThreat >= THREAT_ALERT ? 0 : config.chanserv_op_delay_ms;

        if (chain && chain.canOp(channel)) {
          api.log(
            `Requesting ops via ProtectionChain in ${channel}${csDelay === 0 ? ' (zero delay — elevated threat)' : ''}`,
          );
          const csTimer = setTimeout(() => {
            chain.requestOp(channel);
          }, csDelay);
          state.cycleTimers.push(csTimer);
        } else {
          // Fallback: direct ChanServ message (backward compat when chanserv_access='none')
          const ch = api.getChannel(channel);
          const csNickLower = api.ircLower(config.chanserv_nick);
          const present = ch?.users.has(csNickLower);
          api.log(
            `Requesting ops from ${config.chanserv_nick} in ${channel}${present ? '' : ` (${config.chanserv_nick} not present in channel, sending anyway)`}`,
          );
          const csTimer = setTimeout(() => {
            api.say(config.chanserv_nick, `OP ${channel}`);
          }, csDelay);
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
            const isInviteOnly = ch?.modes.includes('i');
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

    // --- Post-RECOVER cleanup + mass re-op on bot opped ---
    if (modeStr === '+o' && isBotNick(api, target)) {
      const chanKey = api.ircLower(channel);

      // Atheme RECOVER cleanup: remove +i +m
      if (state.pendingRecoverCleanup.has(chanKey)) {
        state.pendingRecoverCleanup.delete(chanKey);
        api.log(`Post-RECOVER cleanup: removing +i +m on ${channel}`);
        const cleanupTimer = setTimeout(() => {
          api.mode(channel, '-im');
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(cleanupTimer);
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
          const reapplyTimer = setTimeout(() => {
            performMassReop(api, config, channel);
          }, recoveryDelay);
          state.enforcementTimers.push(reapplyTimer);
        }

        // Hostile op response at Active+ threat level
        if (threatLevel >= THREAT_ACTIVE) {
          const hostileTimer = setTimeout(() => {
            performHostileResponse(api, config, state, channel, chain);
          }, recoveryDelay);
          state.enforcementTimers.push(hostileTimer);
        }

        // Topic recovery — restore pre-attack topic if it was vandalized
        const topicTimer = setTimeout(() => {
          restoreTopicIfNeeded(api, config, state, channel);
        }, recoveryDelay);
        state.enforcementTimers.push(topicTimer);
      }

      return; // Don't apply bitch mode or other checks to bot being opped
    }

    // --- Bitch mode: strip unauthorized +o / +h ---
    const bitch = api.channelSettings.getFlag(channel, 'bitch');
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
          // Report unauthorized op to threat detection
          if (onThreat && modeStr === '+o') {
            onThreat(channel, 'unauthorized_op', 2, setter, target);
          }
        }
      }
      return;
    }

    // --- Threat detection: bot banned (+b matching bot's hostmask) ---
    if (onThreat && modeStr === '+b' && target && !isNodesynch && !isBotNick(api, setter)) {
      const botNick = getBotNick(api);
      const botHostmask = api.getUserHostmask(channel, botNick);
      if (botHostmask && wildcardMatch(target, botHostmask, true)) {
        onThreat(channel, 'bot_banned', 5, setter, target);
      }
    }

    // --- Enforcebans: kick channel members matching a new ban mask ---
    const enforcebans = api.channelSettings.getFlag(channel, 'enforcebans');
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
        const timer = setTimeout(() => {
          api.op(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
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
    } else if (punishMode === 'kickban') {
      const hostmask = api.getUserHostmask(channel, actor);
      if (hostmask) {
        const mask = buildBanMask(hostmask, config.default_ban_type);
        if (mask) {
          api.ban(channel, mask);
          storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
        }
      }
      markIntentional(state, api, channel, actor);
      api.kick(channel, actor, 'Takeover response');
      api.log(`Hostile response: kickbanned ${actor} from ${channel}`);
    } else if (punishMode === 'akick') {
      // AKICK via backend (persistent — survives rejoin)
      if (chain?.canAkick(channel)) {
        const hostmask = api.getUserHostmask(channel, actor);
        if (hostmask) {
          const mask = buildBanMask(hostmask, config.default_ban_type);
          if (mask) {
            chain.requestAkick(channel, mask, 'Takeover response');
            api.log(`Hostile response: AKICK ${mask} in ${channel} via backend`);
          }
        }
      } else {
        // Fallback to kickban when AKICK is not available
        const hostmask = api.getUserHostmask(channel, actor);
        if (hostmask) {
          const mask = buildBanMask(hostmask, config.default_ban_type);
          if (mask) {
            api.ban(channel, mask);
            storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
          }
        }
        markIntentional(state, api, channel, actor);
        api.kick(channel, actor, 'Takeover response');
        api.log(`Hostile response: kickbanned ${actor} from ${channel} (AKICK unavailable)`);
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
