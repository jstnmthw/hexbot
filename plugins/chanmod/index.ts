// chanmod — Automated channel moderation and operator tools.
//
// Plugin entry point: wires together the protection backends (Atheme/Anope),
// per-channel settings registration, takeover-detection threat callback,
// and every `setup*` helper that owns one feature area. Order in `init()`
// matters — protection chain is built before backends are added; the
// onBotIdentified handler is registered before setup helpers so a SASL
// reconnect during init doesn't miss the re-probe; teardown order is
// reverse-of-init so retained closures don't pin disposed state.
import type { PluginAPI } from '../../src/types';
import { AnopeBackend } from './anope-backend';
import { AthemeBackend } from './atheme-backend';
import { setupAutoOp } from './auto-op';
import { migrateBansToCore, setupBans } from './bans';
import { createProbeState, markProbePending, setupChanServNotice } from './chanserv-notice';
import { setupCommands } from './commands';
import { setupInvite } from './invite';
import { setupJoinRecovery } from './join-recovery';
import type { ThreatCallback } from './mode-enforce';
import { setupModeEnforce } from './mode-enforce';
import { setupProtection } from './protection';
import { ProtectionChain, toBackendAccess } from './protection-backend';
import {
  CHANMOD_SETTING_DEFS,
  PENDING_STATE_TTL_MS,
  clearSharedState,
  createState,
  pruneExpiredState,
  readConfig,
} from './state';
import { setupStickyBans } from './sticky';
import { assessThreat } from './takeover-detect';
import { setupTopicRecovery } from './topic-recovery';

export const name = 'chanmod';
export const version = '3.0.0';
export const description = 'Automated channel moderation and operator tools';

/**
 * Module-level teardown registry. Module-scoped (not per-call) because
 * the plugin loader calls `init()` once per load and `teardown()` once
 * per unload — there is no scenario in which two chanmod instances exist
 * concurrently in the same process.
 */
let teardowns: Array<() => void> = [];

/**
 * Plugin entry point invoked by the plugin loader on `.load chanmod` or
 * `.reload chanmod`. Wires up:
 *   - shared state and protection backends (Atheme/Anope per `chanserv_services_type`)
 *   - the ChanServ-notice router (with hostname-pattern guard)
 *   - per-channel settings (`channelSettings.register`)
 *   - threat callback feeding `assessThreat()` into ProtectionChain
 *   - all `setup*` feature helpers (auto-op, mode-enforce, protection,
 *     sticky bans, join-recovery, commands, invite, topic-recovery)
 *
 * @throws if `services_host_pattern` is missing — the ChanServ-impostor
 *   guard cannot run without a pinned host pattern.
 */
export function init(api: PluginAPI): void {
  // Reset in case a previous teardown threw — otherwise the next unload
  // would re-run stale closures against disposed state.
  teardowns = [];

  // Register typed setting defs first so the loader's post-init seed
  // pulls plugins.json values into KV. `readConfig` then reads from the
  // KV-backed registry and returns the snapshot the rest of init() consumes.
  api.settings.register(CHANMOD_SETTING_DEFS);

  const config = readConfig(api);
  const state = createState();

  // Migrate any bans from old plugin namespace to core _bans namespace
  migrateBansToCore(api);

  // --- Protection backend setup ---
  const chain = new ProtectionChain(api);
  const probeState = createProbeState();

  // Create the ChanServ backend based on services type
  let concreteBackend: AthemeBackend | AnopeBackend;
  const servicesType = config.chanserv_services_type;
  if (servicesType === 'anope') {
    const backend = new AnopeBackend(
      api,
      config.chanserv_nick,
      config.anope_recover_step_delay_ms,
      probeState,
    );
    chain.addBackend(backend);
    concreteBackend = backend;
    // Teardown: clear Anope recover timers
    teardowns.push(() => backend.clearTimers());
  } else {
    // Default to Atheme (most common, also used as fallback)
    const backend = new AthemeBackend(api, config.chanserv_nick);
    // Wire post-RECOVER callback: mark channel for +i +m cleanup
    backend.onRecoverCallback = (channel: string) => {
      state.pendingRecoverCleanup.set(api.ircLower(channel), Date.now() + PENDING_STATE_TTL_MS);
    };
    // Null the callback on teardown so a retained backend reference can't
    // pin `state` via this closure (the closure captures `state` by ref).
    teardowns.push(() => {
      backend.onRecoverCallback = undefined;
    });
    chain.addBackend(backend);
    concreteBackend = backend;
  }

  // Wire ChanServ notice handler — routes FLAGS/ACCESS responses to the backend
  teardowns.push(setupChanServNotice({ api, config, backend: concreteBackend, probeState }));

  // Register per-channel settings (defaults come from the plugin-scope config)
  api.channelSettings.register([
    {
      key: 'bitch',
      type: 'flag',
      default: config.bitch,
      description: 'Deop any user who receives +o without the required op flag',
    },
    {
      key: 'enforce_modes',
      type: 'flag',
      default: config.enforce_modes,
      description: 'Re-apply channel mode string if removed',
    },
    {
      key: 'channel_modes',
      type: 'string',
      default: config.enforce_channel_modes,
      description:
        'Mode string to enforce (e.g. "+nt-s"); must start with + or -, modes not mentioned are left alone',
    },
    {
      key: 'channel_key',
      type: 'string',
      default: config.enforce_channel_key,
      description:
        'Channel key (+k) to enforce (empty = remove unauthorized keys when enforce_modes is on)',
    },
    {
      key: 'channel_limit',
      type: 'int',
      default: config.enforce_channel_limit,
      description:
        'Channel user limit (+l) to enforce (0 = remove unauthorized limits when enforce_modes is on)',
    },
    {
      key: 'auto_op',
      type: 'flag',
      default: config.auto_op,
      description: 'Auto-op flagged users on join',
    },
    {
      key: 'protect_ops',
      type: 'flag',
      default: config.punish_deop,
      description: 'Punish users who deop a flagged op',
    },
    {
      key: 'enforcebans',
      type: 'flag',
      default: config.enforcebans,
      description: 'Kick users who match a new ban mask',
    },
    {
      key: 'revenge',
      type: 'flag',
      default: config.revenge_on_kick,
      description: 'Kick/deop/kickban whoever kicks the bot (see revenge_action in config)',
    },
    {
      key: 'chanserv_access',
      type: 'string',
      default: 'none',
      description: "Bot's ChanServ access tier: 'none' | 'op' | 'superop' | 'founder'",
      allowedValues: ['none', 'op', 'superop', 'founder'],
    },
    {
      key: 'chanserv_unban_on_kick',
      type: 'flag',
      default: true,
      description:
        'Request UNBAN from services when bot is kicked (requires chanserv_access >= op)',
    },
    {
      key: 'mass_reop_on_recovery',
      type: 'flag',
      default: true,
      description: 'Mass re-op flagged users after regaining ops during elevated threat',
    },
    {
      key: 'takeover_punish',
      type: 'string',
      default: 'deop',
      description:
        "Response to hostile actors during takeover: 'none' | 'deop' | 'kickban' | 'akick'",
      allowedValues: ['none', 'deop', 'kickban', 'akick'],
    },
    {
      key: 'takeover_detection',
      type: 'flag',
      default: true,
      description: 'Enable threat scoring and automatic escalation for channel takeover attempts',
    },
    {
      key: 'protect_topic',
      type: 'flag',
      default: false,
      description: 'Restore the pre-attack topic after takeover recovery',
    },
    {
      key: 'invite',
      type: 'flag',
      default: config.invite,
      description: 'Accept invites from ops/masters and join the invited channel',
    },
  ]);

  // --- Sync chanserv_access setting to backend access levels ---
  api.channelSettings.onChange((channel: string, key: string) => {
    if (key === 'chanserv_access') {
      const access = toBackendAccess(api.channelSettings.getString(channel, 'chanserv_access'));
      for (const b of chain.getBackends()) {
        b.setAccess(channel, access);
      }
    }
  });

  // Seed backend access levels from persisted chanserv_access settings for all
  // configured channels. Without this, join-error recovery can't ask ChanServ
  // for help on channels the bot hasn't joined yet (the join handler in auto-op
  // normally syncs this, but the bot can't join if it's banned/+i/+k).
  for (const ch of api.botConfig.irc.channels) {
    const access = toBackendAccess(api.channelSettings.getString(ch, 'chanserv_access'));
    if (access !== 'none') {
      for (const b of chain.getBackends()) {
        b.setAccess(ch, access);
      }
    }
  }

  // On plugin reload the bot is already in channels, so the bot-join event
  // never fires. Re-probe ChanServ for each configured channel the bot is
  // currently present in so protection restores without a manual restart.
  // Only fires when the chain already has a known non-none access level —
  // if access is 'none', the onBotIdentified handler below covers that case
  // (re-probe fires once the bot identifies with NickServ).
  for (const ch of api.botConfig.irc.channels) {
    if (!api.getChannel(ch)) continue; // not currently in this channel
    if (chain.getAccess(ch) === 'none') continue; // handled by onBotIdentified re-probe
    markProbePending(api, probeState, ch, config.chanserv_services_type);
    if (config.chanserv_services_type === 'anope') {
      markProbePending(api, probeState, ch, 'anope-info');
    }
    chain.verifyAccess(ch);
    api.log(`ChanServ re-probe on reload for ${ch}`);
  }

  // After a dirty reconnect (SASL miss → ChanServ probes fail → access stays
  // 'none'), re-probe once the bot identifies. Clear stale probe state first
  // so a lingering deferredAnopeNoAccess entry from the timed-out probe
  // doesn't clobber the new result.
  const onBotIdentifiedHandler = (): void => {
    for (const ch of api.botConfig.irc.channels) {
      if (chain.getAccess(ch) !== 'none') continue;
      if (!api.getChannel(ch)) continue; // not in channel
      // Clear stale probe state so the old timed-out probe can't overwrite
      // the fresh result.
      const key = api.ircLower(ch);
      probeState.deferredAnopeNoAccess.delete(key);
      probeState.pendingAnopeProbes.delete(key);
      probeState.pendingAthemeProbes.delete(key);
      probeState.pendingInfoProbes.delete(key);
      // Start fresh probes.
      markProbePending(api, probeState, ch, config.chanserv_services_type);
      if (config.chanserv_services_type === 'anope') {
        markProbePending(api, probeState, ch, 'anope-info');
      }
      chain.verifyAccess(ch);
      api.log(`Re-probing ChanServ for ${ch} after bot identified`);
    }
  };
  api.onBotIdentified(onBotIdentifiedHandler);
  teardowns.push(() => api.offBotIdentified(onBotIdentifiedHandler));

  // --- Threat detection callback ---
  // When takeover_detection is enabled for a channel, route threat events through
  // assessThreat() which scores them and triggers ProtectionChain escalation.
  const onThreat: ThreatCallback = (channel, eventType, points, actor, target) => {
    const enabled = api.channelSettings.getFlag(channel, 'takeover_detection');
    if (!enabled) return;
    assessThreat(api, config, state, chain, channel, eventType, points, actor, target);
  };

  teardowns.push(
    setupBans(api, config, state),
    setupAutoOp(api, config, state, chain, probeState),
    setupModeEnforce(api, config, state, chain, onThreat),
    setupProtection(api, config, state, chain, onThreat),
    setupJoinRecovery({ api, chain, state, config, probeState }),
    setupCommands(api, config, state),
    setupInvite(api, config, state),
    setupTopicRecovery(api, config, state),
  );

  // Sticky ban binds are auto-cleaned; the no-op teardown returned here just
  // keeps the registration pattern consistent with the other setup* helpers.
  teardowns.push(setupStickyBans(api, state));

  // Periodic cleanup of expired intentionalModeChanges and enforcementCooldown entries
  api.bind('time', '-', '60', () => {
    pruneExpiredState(state);
  });

  // Belt-and-braces: null every Map/Set on shared state at teardown so a
  // retained closure cannot pin the per-channel history graph. Registered
  // last so earlier teardowns still see live state.
  teardowns.push(() => clearSharedState(state));
}

/**
 * Plugin teardown invoked by the plugin loader. Runs every teardown
 * registered during `init()` in registration order — so the
 * `clearSharedState` teardown registered last sees still-live state if
 * any earlier teardown reads from it. Bind handlers and command
 * registrations are reaped by the loader itself; teardown only owns
 * timers, persistent listeners on the api, and shared-state wipes.
 */
export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
