// chanmod — Channel operator tools: auto-op/halfop/voice, mode enforcement, timed bans, kick/ban commands, and channel protection.
import type { PluginAPI } from '../../src/types';
import { setupAutoOp } from './auto-op';
import { setupBans } from './bans';
import { setupCommands } from './commands';
import { setupModeEnforce } from './mode-enforce';
import { setupProtection } from './protection';
import { createState, readConfig } from './state';

export const name = 'chanmod';
export const version = '2.1.0';
export const description =
  'Channel operator tools: auto-op/halfop/voice, mode enforcement, timed bans, kick/ban, cycle';

let teardowns: Array<() => void> = [];

export function init(api: PluginAPI): void {
  const config = readConfig(api);
  const state = createState();

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
      description: 'Mode string to enforce when enforce_modes is on (e.g. "imnpst")',
    },
    {
      key: 'channel_key',
      type: 'string',
      default: config.enforce_channel_key,
      description: 'Channel key (+k) to enforce when enforce_modes is on (empty = disabled)',
    },
    {
      key: 'channel_limit',
      type: 'int',
      default: config.enforce_channel_limit,
      description: 'Channel user limit (+l) to enforce when enforce_modes is on (0 = disabled)',
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
      key: 'chanserv_op',
      type: 'flag',
      default: config.chanserv_op,
      description: 'Request ops from ChanServ when the bot is deopped and ChanServ is present',
    },
  ]);

  teardowns = [
    setupBans(api, config, state),
    setupAutoOp(api, config, state),
    setupModeEnforce(api, config, state),
    setupProtection(api, config, state),
    setupCommands(api, config, state),
  ];
}

export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
