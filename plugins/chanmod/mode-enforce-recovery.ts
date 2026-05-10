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
import type { ModeContext, ThreatCallback } from './mode-enforce';
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
  mctx: ModeContext,
  chain?: ProtectionChain,
  onThreat?: ThreatCallback,
): boolean {
  const { channel, setter, modeStr, target, isNodesynch } = mctx;
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
    state.cycles.schedule(csDelay, () => {
      chain.requestOp(channel);
    });
  }

  const cycleLockKey = api.ircLower(channel);
  if (config.cycle_on_deop && !state.cycles.isLocked(cycleLockKey)) {
    const cooldownKey = `${cycleLockKey}:cycle`;
    const now = Date.now();
    const cooldown = state.enforcementCooldown.get(cooldownKey);
    if (cooldown && now < cooldown.expiresAt) {
      cooldown.count++;
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        const ch = api.getChannel(channel);
        // Don't cycle through +i — the bot would PART successfully but be
        // unable to JOIN back, leaving the channel hostile-controlled. The
        // join-recovery path (via ChanServ INVITE) is the right escape
        // hatch for invite-only channels; bypass cycle here and let
        // ChanServ-OP recovery + reactive enforcement do the work.
        const isInviteOnly = ch?.modes.includes('i');
        if (!isInviteOnly) {
          api.log(`Cycling ${channel} to regain ops`);
          // Release the cycle lock as soon as the PART is scheduled,
          // not after the nested rejoin callback. Holding the lock
          // across the rejoin window leaves the bot permanently
          // deopped if anything in the inner callback throws or the
          // rejoin fails — and it's not needed for dedup: the
          // scheduleWithLock call above already suppressed duplicate
          // cycles during its setup window.
          state.cycles.scheduleWithLock(cycleLockKey, config.cycle_delay_ms, () => {
            api.part(channel, 'Cycling to regain ops');
            state.cycles.unlock(cycleLockKey);
            // 2s — give the server a chance to process PART and remove the
            // bot from channel state before the JOIN, otherwise some ircds
            // reject the JOIN as "already in channel". Empirically reliable
            // on hybrid/charybdis/InspIRCd; longer if needed via cycle_delay_ms.
            state.cycles.schedule(2000, () => {
              api.join(channel);
              state.enforcementCooldown.delete(cooldownKey);
              // Post-cycle verification ladder. On services-free networks an
              // attacker who set +i / +k between PART and JOIN can leave the
              // bot AWOL — we wouldn't notice until the next presence-check
              // sweep. Two retry windows give services a chance to grant
              // INVITE; after that we log loudly and let the connection-level
              // presence check pick it up. (W11.2)
              const verify = (attempt: number, delayMs: number): void => {
                state.cycles.schedule(delayMs, () => {
                  const ch = api.getChannel(channel);
                  if (ch) return; // Successfully rejoined — done.
                  if (attempt < 2) {
                    api.warn(
                      `Cycle-rejoin verification failed for ${channel} (attempt ${attempt + 1}); retrying`,
                    );
                    api.join(channel);
                    verify(attempt + 1, delayMs * 2);
                  } else {
                    api.error(
                      `Cycle-rejoin failed for ${channel} after retries — likely +i/+k set during cycle window. ` +
                        `Falling back to presence-check sweep / ChanServ INVITE recovery.`,
                    );
                  }
                });
              };
              verify(0, 5000);
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
  mctx: ModeContext,
  chain?: ProtectionChain,
): boolean {
  const { channel, modeStr, target } = mctx;
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
        performMassReop(api, config, channel, state);
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
function performMassReop(
  api: PluginAPI,
  config: ChanmodConfig,
  channel: string,
  state?: SharedState,
): void {
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

  // Cap each batch at MASS_REOP_BATCH_SIZE per tick. A 30-flagged-user
  // channel under hostile recovery would otherwise produce 6-7 MODE lines
  // (one per direction batch) on the same tick, plus deop/halfop/voice
  // and `performHostileResponse` — easily 30+ MODE bytes in <100ms which
  // trips Solanum/Charybdis Excess Flood. Spill remainder to a delayed
  // second pass through `state.cycles` so teardown cancels it cleanly.
  // Pairs with the IRCCommands queue (C-IRCCMDS); both are needed since
  // even queued lines, taken together with hostile-response and bitch
  // deops, can saturate the per-target depth cap.
  emitReopBatch(api, channel, '+', 'o', toOp.slice(0, MASS_REOP_BATCH_SIZE), 'opping');
  emitReopBatch(api, channel, '-', 'o', toDeop.slice(0, MASS_REOP_BATCH_SIZE), 'deopping');
  emitReopBatch(api, channel, '+', 'h', toHalfop.slice(0, MASS_REOP_BATCH_SIZE), 'halfopping');
  emitReopBatch(api, channel, '+', 'v', toVoice.slice(0, MASS_REOP_BATCH_SIZE), 'voicing');

  const spillOp = toOp.slice(MASS_REOP_BATCH_SIZE);
  const spillDeop = toDeop.slice(MASS_REOP_BATCH_SIZE);
  const spillHalfop = toHalfop.slice(MASS_REOP_BATCH_SIZE);
  const spillVoice = toVoice.slice(MASS_REOP_BATCH_SIZE);
  const totalSpill = spillOp.length + spillDeop.length + spillHalfop.length + spillVoice.length;
  if (totalSpill > 0 && state) {
    api.log(
      `Mass re-op: ${totalSpill} actions deferred to second pass in ${channel} to avoid send-rate trip`,
    );
    state.cycles.schedule(MASS_REOP_SPILL_DELAY_MS, () => {
      emitReopBatch(api, channel, '+', 'o', spillOp, 'opping (spill)');
      emitReopBatch(api, channel, '-', 'o', spillDeop, 'deopping (spill)');
      emitReopBatch(api, channel, '+', 'h', spillHalfop, 'halfopping (spill)');
      emitReopBatch(api, channel, '+', 'v', spillVoice, 'voicing (spill)');
    });
  }
}

/** Cap on actions per direction-mode emitted in one tick. Mirrors HOSTILE_BATCH_SIZE. */
const MASS_REOP_BATCH_SIZE = 5;
/** Delay before emitting the spilled remainder. Aligned with HOSTILE_SPILL_DELAY_MS. */
const MASS_REOP_SPILL_DELAY_MS = 3000;

function emitReopBatch(
  api: PluginAPI,
  channel: string,
  direction: '+' | '-',
  modeChar: 'o' | 'h' | 'v',
  nicks: string[],
  verb: string,
): void {
  if (nicks.length === 0) return;
  api.mode(channel, direction + modeChar.repeat(nicks.length), ...nicks);
  api.log(`Mass re-op: ${verb} ${nicks.length} users in ${channel}: ${nicks.join(', ')}`);
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
  const threat = getThreatState(api, state, channel);
  if (!threat) return;

  // Collect unique hostile actors from the threat event log.
  const hostileActors: string[] = [];
  const seen = new Set<string>();
  for (const event of threat.events) {
    if (!event.actor) continue;
    const key = api.ircLower(event.actor);
    if (seen.has(key)) continue;
    seen.add(key);
    hostileActors.push(event.actor);
  }

  // Cap per-tick batch at HOSTILE_BATCH_SIZE. Spill the remainder to a
  // delayed second pass — a large chaotic burst (split-rejoin flood)
  // would otherwise produce a same-tick kick+ban flood that trips the
  // bot's own send-rate limiter and gets us flood-killed by the
  // server.
  const firstBatch = hostileActors.slice(0, HOSTILE_BATCH_SIZE);
  const spill = hostileActors.slice(HOSTILE_BATCH_SIZE);

  performHostileResponseFromList(api, config, state, channel, firstBatch, chain);

  if (spill.length > 0) {
    api.log(
      `Hostile response: ${spill.length} actor(s) deferred to second pass in ${channel} to avoid send-rate trip`,
    );
    // Use the state.cycles timer owner so teardown cancels the spill
    // pass — prevents a late-firing punishment after plugin unload.
    state.cycles.schedule(HOSTILE_SPILL_DELAY_MS, () => {
      performHostileResponseFromList(api, config, state, channel, spill, chain);
    });
  }
}

/**
 * Cap the number of hostile actors the response handles per same-tick
 * batch. A large chaotic burst (e.g. a split-rejoin flood where the
 * takeover scorer records 50 actors) would otherwise produce a
 * kick+ban flood that trips the bot's own send-rate limiter and gets
 * the bot flood-killed by the server. 5 actors per tick + a
 * 3-second spill pass keeps the queue under the limiter's threshold.
 */
const HOSTILE_BATCH_SIZE = 5;
const HOSTILE_SPILL_DELAY_MS = 3000;

/**
 * Hand-rolled actor for takeover-recovery `api.op/deop/ban/kick` paths.
 * No `ctx` is available here — the response fires in a deferred
 * timer, driven by threat-score state rather than a user command.
 * Keeps `mod_log.by` meaningful instead of NULL.
 */
const HOSTILE_RESPONSE_ACTOR = Object.freeze({
  by: 'hostile-response',
  source: 'plugin' as const,
  plugin: 'chanmod',
});

/**
 * Inner loop used by both the initial and spill passes of
 * {@link performHostileResponse}. Applies the configured punishment
 * to each actor in `actors`. Does NOT re-check the threat state —
 * that check happens in the outer wrapper, and we want the spill
 * pass to still complete its own slice even if the threat score has
 * decayed by the time it fires.
 */
function performHostileResponseFromList(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  actors: string[],
  chain?: ProtectionChain,
): void {
  const punishMode = api.channelSettings.getString(channel, 'takeover_punish');
  if (punishMode === 'none') return;

  const ch = api.getChannel(channel);
  if (!ch) return;

  for (const actor of actors) {
    if (api.isBotNick(actor)) continue;
    if (config.nodesynch_nicks.some((n) => api.ircLower(n) === api.ircLower(actor))) continue;
    const flags = getUserFlags(api, channel, actor);
    if (flags && hasAnyFlag(flags, config.revenge_exempt_flags)) {
      api.log(
        `Hostile response: skipping ${api.stripFormatting(actor)} in ${channel} — exempt flag`,
      );
      continue;
    }
    const actorLower = api.ircLower(actor);
    if (!ch.users.has(actorLower)) continue;

    const safeActor = api.stripFormatting(actor);
    if (punishMode === 'deop') {
      if (botHasOps(api, channel)) {
        markIntentional(state, api, channel, actor);
        api.deop(channel, actor, HOSTILE_RESPONSE_ACTOR);
        api.log(`Hostile response: deopped ${safeActor} in ${channel}`);
      } else if (chain?.canDeop(channel)) {
        chain.requestDeop(channel, actor);
        api.log(`Hostile response: requested DEOP for ${safeActor} in ${channel} via backend`);
      }
    } else if (punishMode === 'kickban' || punishMode === 'akick') {
      const hostmask = api.getUserHostmask(channel, actor);
      const mask = hostmask ? buildBanMask(hostmask, config.default_ban_type) : null;
      if (punishMode === 'akick' && chain?.canAkick(channel)) {
        if (mask) {
          chain.requestAkick(channel, mask, 'Takeover response');
          api.log(`Hostile response: AKICK ${mask} in ${channel} via backend`);
        }
      } else {
        if (mask) {
          api.ban(channel, mask, HOSTILE_RESPONSE_ACTOR);
          api.banStore.storeBan(
            channel,
            mask,
            getBotNick(api),
            config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000,
          );
        }
        markIntentional(state, api, channel, actor);
        api.kick(channel, actor, 'Takeover response', HOSTILE_RESPONSE_ACTOR);
        const suffix = punishMode === 'akick' ? ' (AKICK unavailable)' : '';
        api.log(`Hostile response: kickbanned ${safeActor} from ${channel}${suffix}`);
      }
    }
  }
}
