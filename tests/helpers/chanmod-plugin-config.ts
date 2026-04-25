// Test fixture — canonical chanmod plugin-load overrides.
//
// chanmod requires security-critical config fields (currently
// `services_host_pattern`) that `readConfig()` refuses to load without.
// Tests build their own config inline, so without a fixture every new
// required field has to be threaded through ~50 load sites by hand.
// Centralising that here means production can enforce the field strictly
// (clean-cut, per audit 2026-04-24 CRITICAL ChanServ pin) while tests get
// a safe default in one place.
//
// Usage:
//   await bot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
//   await bot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides({ auto_op: false }));
//
// The returned object is the `overrides` arg to `pluginLoader.load()`.
// Pass your per-test config tweaks as the single argument; they merge
// over the safe defaults.
import type { ChanmodConfig } from '../../plugins/chanmod/state';

/**
 * Pattern that matches every test-used services hostname (`services.*`
 * covers `services.example.net`, `services.libera.chat`, etc.). Matches
 * what hexbot's example configs recommend — not a test-only hack.
 */
export const TEST_SERVICES_HOST_PATTERN = 'services.*';

/**
 * Build the `overrides` object for `pluginLoader.load(PLUGIN_PATH, ...)`
 * with every security-required chanmod field pre-filled. Pass per-test
 * tweaks as `configOverrides`; they take precedence over the defaults.
 */
export function makeChanmodPluginOverrides(
  configOverrides: Partial<ChanmodConfig> & Record<string, unknown> = {},
): Record<string, { enabled: boolean; config: Record<string, unknown> }> {
  return {
    chanmod: {
      enabled: true,
      config: {
        services_host_pattern: TEST_SERVICES_HOST_PATTERN,
        ...configOverrides,
      },
    },
  };
}

/**
 * Build a full `ChanmodConfig` for tests that construct the resolved
 * config object directly (i.e., without going through `readConfig()`).
 * Pass per-test overrides as `overrides`; they take precedence.
 *
 * Defaults mirror `readConfig()`'s defaults — add new defaults here when
 * adding new required fields.
 */
export function makeChanmodConfig(overrides: Partial<ChanmodConfig> = {}): ChanmodConfig {
  const defaults: ChanmodConfig = {
    auto_op: true,
    op_flags: ['o'],
    halfop_flags: [],
    voice_flags: ['v'],
    notify_on_fail: false,
    enforce_modes: true,
    enforce_delay_ms: 2000,
    nodesynch_nicks: [],
    enforce_channel_modes: '',
    enforce_channel_key: '',
    enforce_channel_limit: 0,
    cycle_on_deop: false,
    cycle_delay_ms: 1000,
    default_kick_reason: 'no reason given',
    default_ban_duration: 0,
    default_ban_type: 2,
    rejoin_on_kick: true,
    rejoin_delay_ms: 3000,
    max_rejoin_attempts: 3,
    rejoin_attempt_window_ms: 30_000,
    revenge_on_kick: false,
    revenge_action: 'deop',
    revenge_delay_ms: 500,
    revenge_kick_reason: 'revenge',
    revenge_exempt_flags: 'n',
    bitch: false,
    punish_deop: false,
    punish_action: 'kick',
    punish_kick_reason: 'unauthorized deop',
    enforcebans: false,
    nick_recovery: false,
    nick_recovery_ghost: false,
    nick_recovery_password: '',
    stopnethack_mode: 0,
    split_timeout_ms: 0,
    chanserv_nick: 'ChanServ',
    chanserv_op_delay_ms: 500,
    chanserv_services_type: 'atheme',
    services_host_pattern: TEST_SERVICES_HOST_PATTERN,
    chanserv_unban_retry_ms: 2000,
    chanserv_unban_max_retries: 3,
    chanserv_recover_cooldown_ms: 60_000,
    anope_recover_step_delay_ms: 200,
    takeover_window_ms: 30_000,
    takeover_level_1_threshold: 3,
    takeover_level_2_threshold: 6,
    takeover_level_3_threshold: 10,
    takeover_response_delay_ms: 0,
    invite: false,
  };
  return { ...defaults, ...overrides };
}
