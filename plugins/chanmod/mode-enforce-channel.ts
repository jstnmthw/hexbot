// chanmod — channel-wide mode enforcement (parameterless modes + key + limit)
//
// Handles re-applying removed modes, removing unauthorized modes, enforcing
// channel key (+k), and enforcing channel limit (+l). Also exports
// `syncChannelModes` which reconciles current channel state against the
// configured desired state.
import type { PluginAPI } from '../../src/types';
import { botHasOps, getParamModes, hasParamModes, parseChannelModes } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

/** Keys in channelSettings that should trigger a mode sync when changed. */
export const MODE_SETTING_KEYS = new Set([
  'channel_modes',
  'channel_key',
  'channel_limit',
  'enforce_modes',
]);

/** Re-apply removed modes that are in the add set. */
export function handleReapplyRemovedModes(
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
export function handleRemoveUnauthorizedModes(
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
export function handleChannelKeyEnforcement(
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
export function handleChannelLimitEnforcement(
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
