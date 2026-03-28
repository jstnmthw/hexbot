// chanmod — shared state types and config interface
import type { PluginAPI } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared mutable state (created fresh on each init, passed to all modules)
// ---------------------------------------------------------------------------

export interface SharedState {
  intentionalModeChanges: Map<string, number>;
  enforcementCooldown: Map<string, { count: number; expiresAt: number }>;
  cycleTimers: ReturnType<typeof setTimeout>[];
  cycleScheduled: Set<string>;
  enforcementTimers: ReturnType<typeof setTimeout>[];
  startupTimer: ReturnType<typeof setTimeout> | null;
  // Stopnethack
  splitActive: boolean;
  splitExpiry: number;
  splitOpsSnapshot: Map<string, Set<string>>; // ircLower(channel) → set of ircLower nicks with ops
  splitQuitCount: number;
  splitQuitWindowStart: number;
}

export const INTENTIONAL_TTL_MS = 5000;
export const COOLDOWN_WINDOW_MS = 10_000;
export const MAX_ENFORCEMENTS = 3;

export function createState(): SharedState {
  return {
    intentionalModeChanges: new Map(),
    enforcementCooldown: new Map(),
    cycleTimers: [],
    cycleScheduled: new Set(),
    enforcementTimers: [],
    startupTimer: null,
    splitActive: false,
    splitExpiry: 0,
    splitOpsSnapshot: new Map(),
    splitQuitCount: 0,
    splitQuitWindowStart: 0,
  };
}

// ---------------------------------------------------------------------------
// Plugin config (read once in init, passed to all modules)
// ---------------------------------------------------------------------------

export interface ChanmodConfig {
  // Auto-op
  auto_op: boolean;
  op_flags: string[];
  halfop_flags: string[];
  voice_flags: string[];
  notify_on_fail: boolean;
  // Mode enforcement
  enforce_modes: boolean;
  enforce_delay_ms: number;
  nodesynch_nicks: string[];
  enforce_channel_modes: string;
  enforce_channel_key: string;
  enforce_channel_limit: number;
  // Cycle
  cycle_on_deop: boolean;
  cycle_delay_ms: number;
  // Bans / kick
  default_kick_reason: string;
  default_ban_duration: number;
  default_ban_type: number;
  // Protection
  rejoin_on_kick: boolean;
  rejoin_delay_ms: number;
  max_rejoin_attempts: number;
  rejoin_attempt_window_ms: number;
  revenge_on_kick: boolean;
  revenge_action: 'deop' | 'kick' | 'kickban';
  revenge_delay_ms: number;
  revenge_kick_reason: string;
  revenge_exempt_flags: string;
  bitch: boolean;
  punish_deop: boolean;
  punish_action: 'kick' | 'kickban';
  punish_kick_reason: string;
  enforcebans: boolean;
  nick_recovery: boolean;
  nick_recovery_ghost: boolean;
  nick_recovery_password: string;
  stopnethack_mode: number;
  split_timeout_ms: number;
  chanserv_op: boolean;
  chanserv_nick: string;
  chanserv_op_delay_ms: number;
}

/** Read a typed value from the plugin config, falling back to a default. Single cast site. */
function cfg<T>(c: Record<string, unknown>, key: string, fallback: T): T {
  const val = c[key];
  return val !== undefined ? (val as T) : fallback;
}

export function readConfig(api: PluginAPI): ChanmodConfig {
  const c = api.config;
  return {
    auto_op: cfg(c, 'auto_op', true),
    op_flags: cfg<string[]>(c, 'op_flags', ['n', 'm', 'o']),
    halfop_flags: cfg<string[]>(c, 'halfop_flags', []),
    voice_flags: cfg<string[]>(c, 'voice_flags', ['v']),
    notify_on_fail: cfg(c, 'notify_on_fail', false),
    enforce_modes: cfg(c, 'enforce_modes', false),
    enforce_delay_ms: cfg(c, 'enforce_delay_ms', 500),
    nodesynch_nicks: cfg<string[]>(c, 'nodesynch_nicks', ['ChanServ']),
    enforce_channel_modes: cfg(c, 'enforce_channel_modes', ''),
    enforce_channel_key: cfg(c, 'enforce_channel_key', ''),
    enforce_channel_limit: cfg(c, 'enforce_channel_limit', 0),
    cycle_on_deop: cfg(c, 'cycle_on_deop', false),
    cycle_delay_ms: cfg(c, 'cycle_delay_ms', 5000),
    default_kick_reason: cfg(c, 'default_kick_reason', 'Requested'),
    default_ban_duration: cfg(c, 'default_ban_duration', 120),
    default_ban_type: cfg(c, 'default_ban_type', 3),
    rejoin_on_kick: cfg(c, 'rejoin_on_kick', true),
    rejoin_delay_ms: cfg(c, 'rejoin_delay_ms', 5000),
    max_rejoin_attempts: cfg(c, 'max_rejoin_attempts', 3),
    rejoin_attempt_window_ms: cfg(c, 'rejoin_attempt_window_ms', 300_000),
    revenge_on_kick: cfg(c, 'revenge_on_kick', false),
    revenge_action: cfg<'deop' | 'kick' | 'kickban'>(c, 'revenge_action', 'deop'),
    revenge_delay_ms: cfg(c, 'revenge_delay_ms', 3000),
    revenge_kick_reason: cfg(c, 'revenge_kick_reason', "Don't kick me."),
    revenge_exempt_flags: cfg(c, 'revenge_exempt_flags', 'nm'),
    bitch: cfg(c, 'bitch', false),
    punish_deop: cfg(c, 'punish_deop', false),
    punish_action: cfg<'kick' | 'kickban'>(c, 'punish_action', 'kick'),
    punish_kick_reason: cfg(c, 'punish_kick_reason', "Don't deop my friends."),
    enforcebans: cfg(c, 'enforcebans', false),
    nick_recovery: cfg(c, 'nick_recovery', true),
    nick_recovery_ghost: cfg(c, 'nick_recovery_ghost', false),
    nick_recovery_password: cfg(c, 'nick_recovery_password', ''),
    stopnethack_mode: cfg(c, 'stopnethack_mode', 0),
    split_timeout_ms: cfg(c, 'split_timeout_ms', 300_000),
    chanserv_op: cfg(c, 'chanserv_op', false),
    chanserv_nick: cfg(c, 'chanserv_nick', 'ChanServ'),
    chanserv_op_delay_ms: cfg(c, 'chanserv_op_delay_ms', 1000),
  };
}
