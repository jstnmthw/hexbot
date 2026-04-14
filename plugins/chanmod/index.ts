// chanmod — Automated channel moderation and operator tools.
import type { PluginAPI } from '../../src/types';
import { AnopeBackend } from './anope-backend';
import { AthemeBackend } from './atheme-backend';
import { setupAutoOp } from './auto-op';
import { migrateBansToCore, setupBans } from './bans';
import { createProbeState, setupChanServNotice } from './chanserv-notice';
import { setupCommands } from './commands';
import { setupInvite } from './invite';
import { setupJoinRecovery } from './join-recovery';
import type { ThreatCallback } from './mode-enforce';
import { setupModeEnforce } from './mode-enforce';
import { setupProtection } from './protection';
import { ProtectionChain } from './protection-backend';
import { PENDING_STATE_TTL_MS, createState, pruneExpiredState, readConfig } from './state';
import { setupStickyBans } from './sticky';
import { assessThreat } from './takeover-detect';
import { setupTopicRecovery } from './topic-recovery';

export const name = 'chanmod';
export const version = '3.0.0';
export const description = 'Automated channel moderation and operator tools';

let teardowns: Array<() => void> = [];

export function init(api: PluginAPI): void {
  // Reset in case a previous teardown threw — otherwise the next unload
  // would re-run stale closures against disposed state.
  teardowns = [];

  const config = readConfig(api);
  const state = createState();

  // Migrate any bans from old plugin namespace to core _bans namespace
  migrateBansToCore(api);

  // Deprecation notice for removed chanserv_op config key
  if (api.config.chanserv_op !== undefined) {
    api.warn(
      'chanserv_op config key is removed — ChanServ re-op is now automatic when chanserv_access >= op. You can delete this key from plugins.json.',
    );
  }

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
    chain.addBackend(backend);
    concreteBackend = backend;
  }

  // Wire ChanServ notice handler — routes FLAGS/ACCESS responses to the backend
  teardowns.push(setupChanServNotice({ api, config, backend: concreteBackend, probeState }));

  // Register per-channel settings (defaults come from api.config so global config still works)
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
      const access = api.channelSettings.getString(channel, 'chanserv_access') as
        | 'none'
        | 'op'
        | 'superop'
        | 'founder';
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
    const access = api.channelSettings.getString(ch, 'chanserv_access') as
      | 'none'
      | 'op'
      | 'superop'
      | 'founder';
    if (access !== 'none') {
      for (const b of chain.getBackends()) {
        b.setAccess(ch, access);
      }
    }
  }

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

  // Sticky ban enforcement doesn't return a teardown (binds are auto-cleaned)
  setupStickyBans(api, state);

  // Periodic cleanup of expired intentionalModeChanges and enforcementCooldown entries
  api.bind('time', '-', '60', () => {
    pruneExpiredState(state);
  });
}

export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
