// chanmod — shared state types and config interface
import type { PluginAPI } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared mutable state (created fresh on each init, passed to all modules)
// ---------------------------------------------------------------------------

/** A single threat event recorded during a potential takeover. */
export interface ThreatEvent {
  type: string;
  actor: string;
  target?: string;
  timestamp: number;
}

/** Per-channel threat scoring state. */
export interface ThreatState {
  score: number;
  events: ThreatEvent[];
  windowStart: number;
}

/**
 * Cycle timer owner — centralises scheduling, tracking, and teardown of all
 * "part/rejoin/defer" timers that mode-enforce, protection, and join-recovery
 * use. Callers never touch the backing Set directly — every path goes through
 * this API so teardown is guaranteed complete on plugin unload.
 *
 * Two scheduling flavours:
 *   - schedule(ms, fn)           — one-shot, auto-removes on fire
 *   - scheduleWithLock(k, ms, fn) — keyed schedule guarded by a deduplication
 *                                   lock; caller is responsible for unlock()
 *                                   when the expected follow-up event arrives.
 *                                   Locks are TTL-pruned if the follow-up is
 *                                   lost to a services outage or similar.
 */
export interface CycleState {
  /** Schedule a one-shot callback. Auto-removes the timer on fire. */
  schedule(delayMs: number, fn: () => void): void;
  /**
   * Schedule a callback guarded by a dedup lock keyed by `key`. Returns true
   * if the lock was taken and the timer scheduled, false if already locked.
   * Caller owns calling `unlock(key)` when the follow-up completes; the
   * lock is TTL-pruned by `pruneExpired()` after `PENDING_STATE_TTL_MS`.
   */
  scheduleWithLock(key: string, delayMs: number, fn: () => void): boolean;
  /** True if `key` is currently locked. */
  isLocked(key: string): boolean;
  /** Release a dedup lock taken by `scheduleWithLock`. */
  unlock(key: string): void;
  /**
   * Register an externally-created timer so it is cancelled on teardown.
   * Used where the caller must retain the timer reference for its own
   * cancellation logic (join-recovery's sustained-presence reset timer).
   */
  track(timer: ReturnType<typeof setTimeout>): void;
  /** Clear all tracked timers and dedup locks. Called from teardown. */
  clearAll(): void;
  /** TTL-prune stale dedup locks — keeps state tidy when follow-up events drop. */
  pruneExpired(now: number, ttlMs: number): void;
  /** Number of currently tracked timers (for tests and diagnostics). */
  readonly size: number;
}

export interface SharedState {
  intentionalModeChanges: Map<string, number>;
  enforcementCooldown: Map<string, { count: number; expiresAt: number }>;
  /** Cycle timer owner — see `CycleState` docs. */
  cycles: CycleState;
  enforcementTimers: Set<ReturnType<typeof setTimeout>>;
  startupTimer: ReturnType<typeof setTimeout> | null;
  // Stopnethack
  splitActive: boolean;
  splitExpiry: number;
  splitOpsSnapshot: Map<string, Set<string>>; // ircLower(channel) → set of ircLower nicks with ops
  splitQuitCount: number;
  splitQuitWindowStart: number;
  // Takeover threat detection
  threatScores: Map<string, ThreatState>;
  // Kick+ban recovery
  /** Channels where RECOVER was used and post-recovery +i +m cleanup is needed. Value is expiresAt. */
  pendingRecoverCleanup: Map<string, number>;
  /** Last-known channel modes before the bot was kicked (for +i/+k detection). */
  lastKnownModes: Map<string, { modes: string; key?: string }>;
  /** Channels where we already sent requestUnban (prevent double-sends). Value is expiresAt. */
  unbanRequested: Map<string, number>;
  // Topic recovery
  /** Known-good topic per channel — updated at threat level 0, frozen during elevated threat. */
  knownGoodTopics: Map<string, { topic: string; setAt: number }>;
  /** Channels already warned about takeover_detection w/o chanserv_access (dedupe per session). */
  takeoverWarnedChannels: Set<string>;

  /** Schedule a callback on `enforcementTimers` — wraps setTimeout + add, auto-removes on fire. */
  scheduleEnforcement(delayMs: number, fn: () => void): void;
}

function createCycleState(): CycleState {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Value is expiresAt (ms). Entries are TTL-pruned if the expected follow-up
  // event never arrives (services outage, split, etc.).
  const locks = new Map<string, number>();

  const cycle: CycleState = {
    schedule(delayMs: number, fn: () => void): void {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delayMs);
      timers.add(timer);
    },
    scheduleWithLock(key: string, delayMs: number, fn: () => void): boolean {
      if (locks.has(key)) return false;
      locks.set(key, Date.now() + PENDING_STATE_TTL_MS);
      cycle.schedule(delayMs, fn);
      return true;
    },
    isLocked(key: string): boolean {
      return locks.has(key);
    },
    unlock(key: string): void {
      locks.delete(key);
    },
    track(timer: ReturnType<typeof setTimeout>): void {
      timers.add(timer);
    },
    clearAll(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      locks.clear();
    },
    pruneExpired(now: number, ttlMs: number): void {
      // ttlMs is accepted for API symmetry; lock expiry is set at insert time.
      void ttlMs;
      for (const [key, expiresAt] of locks) {
        if (now >= expiresAt) locks.delete(key);
      }
    },
    get size(): number {
      return timers.size;
    },
  };
  return cycle;
}

export const INTENTIONAL_TTL_MS = 5000;
export const COOLDOWN_WINDOW_MS = 10_000;
export const MAX_ENFORCEMENTS = 3;
/** How long a `pendingRecoverCleanup`/`unbanRequested`/cycle dedup lock
 *  can live waiting for its expected follow-up event before it's pruned. */
export const PENDING_STATE_TTL_MS = 5 * 60_000;

export function createState(): SharedState {
  const state: SharedState = {
    intentionalModeChanges: new Map(),
    enforcementCooldown: new Map(),
    cycles: createCycleState(),
    enforcementTimers: new Set(),
    startupTimer: null,
    splitActive: false,
    splitExpiry: 0,
    splitOpsSnapshot: new Map(),
    splitQuitCount: 0,
    splitQuitWindowStart: 0,
    threatScores: new Map(),
    pendingRecoverCleanup: new Map(),
    lastKnownModes: new Map(),
    unbanRequested: new Map(),
    knownGoodTopics: new Map(),
    takeoverWarnedChannels: new Set(),
    scheduleEnforcement(delayMs: number, fn: () => void): void {
      const timer = setTimeout(() => {
        state.enforcementTimers.delete(timer);
        fn();
      }, delayMs);
      state.enforcementTimers.add(timer);
    },
  };
  return state;
}

/** Prune expired entries from intentionalModeChanges and enforcementCooldown,
 *  plus TTL-based cleanup of pendingRecoverCleanup/unbanRequested/cycle locks
 *  so a dropped follow-up event (services outage, etc.) doesn't leak entries. */
export function pruneExpiredState(state: SharedState): void {
  const now = Date.now();
  for (const [key, expiresAt] of state.intentionalModeChanges) {
    if (now >= expiresAt) state.intentionalModeChanges.delete(key);
  }
  for (const [key, entry] of state.enforcementCooldown) {
    if (now >= entry.expiresAt) state.enforcementCooldown.delete(key);
  }
  for (const [key, expiresAt] of state.pendingRecoverCleanup) {
    if (now >= expiresAt) state.pendingRecoverCleanup.delete(key);
  }
  for (const [key, expiresAt] of state.unbanRequested) {
    if (now >= expiresAt) state.unbanRequested.delete(key);
  }
  state.cycles.pruneExpired(now, PENDING_STATE_TTL_MS);
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
  chanserv_nick: string;
  chanserv_op_delay_ms: number;
  chanserv_services_type: 'atheme' | 'anope';
  chanserv_unban_retry_ms: number;
  chanserv_unban_max_retries: number;
  chanserv_recover_cooldown_ms: number;
  anope_recover_step_delay_ms: number;
  // Takeover detection
  takeover_window_ms: number;
  takeover_level_1_threshold: number;
  takeover_level_2_threshold: number;
  takeover_level_3_threshold: number;
  takeover_response_delay_ms: number;
  invite: boolean;
}

/** Read a typed value from the plugin config, falling back to a default. Single cast site. */
function cfg<T>(c: Record<string, unknown>, key: string, fallback: T): T {
  const val = c[key];
  return val !== undefined ? (val as T) : fallback;
}

/** Read a numeric config value, validating it is a finite non-negative number. */
function cfgNum(
  c: Record<string, unknown>,
  key: string,
  fallback: number,
  log: (msg: string) => void,
): number {
  const val = c[key];
  if (val === undefined) return fallback;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n) || n < 0) {
    log(`Invalid ${key}: ${JSON.stringify(val)} — using default ${fallback}`);
    return fallback;
  }
  return n;
}

/** Read a string config value constrained to a set of allowed values. */
function cfgEnum<T extends string>(
  c: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  log: (msg: string) => void,
): T {
  const val = c[key];
  if (val === undefined) return fallback;
  if (typeof val === 'string' && (allowed as readonly string[]).includes(val)) return val as T;
  log(`Invalid ${key}: ${JSON.stringify(val)} — using default "${fallback}"`);
  return fallback;
}

export function readConfig(api: PluginAPI): ChanmodConfig {
  const c = api.config;
  const log = (msg: string) => api.log(msg);

  const config: ChanmodConfig = {
    auto_op: cfg(c, 'auto_op', true),
    op_flags: cfg<string[]>(c, 'op_flags', ['n', 'm', 'o']),
    halfop_flags: cfg<string[]>(c, 'halfop_flags', []),
    voice_flags: cfg<string[]>(c, 'voice_flags', ['v']),
    notify_on_fail: cfg(c, 'notify_on_fail', false),
    enforce_modes: cfg(c, 'enforce_modes', false),
    enforce_delay_ms: cfgNum(c, 'enforce_delay_ms', 500, log),
    nodesynch_nicks: cfg<string[]>(c, 'nodesynch_nicks', ['ChanServ']),
    enforce_channel_modes: cfg(c, 'enforce_channel_modes', ''),
    enforce_channel_key: cfg(c, 'enforce_channel_key', ''),
    enforce_channel_limit: cfgNum(c, 'enforce_channel_limit', 0, log),
    cycle_on_deop: cfg(c, 'cycle_on_deop', false),
    cycle_delay_ms: cfgNum(c, 'cycle_delay_ms', 5000, log),
    default_kick_reason: cfg(c, 'default_kick_reason', 'Requested'),
    default_ban_duration: cfgNum(c, 'default_ban_duration', 120, log),
    default_ban_type: cfgNum(c, 'default_ban_type', 3, log),
    rejoin_on_kick: cfg(c, 'rejoin_on_kick', true),
    rejoin_delay_ms: cfgNum(c, 'rejoin_delay_ms', 5000, log),
    max_rejoin_attempts: cfgNum(c, 'max_rejoin_attempts', 3, log),
    rejoin_attempt_window_ms: cfgNum(c, 'rejoin_attempt_window_ms', 300_000, log),
    revenge_on_kick: cfg(c, 'revenge_on_kick', false),
    revenge_action: cfgEnum(c, 'revenge_action', ['deop', 'kick', 'kickban'], 'deop', log),
    revenge_delay_ms: cfgNum(c, 'revenge_delay_ms', 3000, log),
    revenge_kick_reason: cfg(c, 'revenge_kick_reason', "Don't kick me."),
    revenge_exempt_flags: cfg(c, 'revenge_exempt_flags', 'nm'),
    bitch: cfg(c, 'bitch', false),
    punish_deop: cfg(c, 'punish_deop', false),
    punish_action: cfgEnum(c, 'punish_action', ['kick', 'kickban'], 'kick', log),
    punish_kick_reason: cfg(c, 'punish_kick_reason', "Don't deop my friends."),
    enforcebans: cfg(c, 'enforcebans', false),
    nick_recovery: cfg(c, 'nick_recovery', true),
    nick_recovery_ghost: cfg(c, 'nick_recovery_ghost', false),
    // Password read from bot.json (not plugins.json) per SECURITY.md §6
    nick_recovery_password: api.botConfig.chanmod?.nick_recovery_password ?? '',
    stopnethack_mode: cfgNum(c, 'stopnethack_mode', 0, log),
    split_timeout_ms: cfgNum(c, 'split_timeout_ms', 300_000, log),
    chanserv_nick: cfg(c, 'chanserv_nick', 'ChanServ'),
    chanserv_op_delay_ms: cfgNum(c, 'chanserv_op_delay_ms', 1000, log),
    chanserv_services_type: cfgEnum(
      c,
      'chanserv_services_type',
      ['atheme', 'anope'],
      api.botConfig.services.type === 'anope' ? 'anope' : 'atheme',
      log,
    ),
    chanserv_unban_retry_ms: cfgNum(c, 'chanserv_unban_retry_ms', 2000, log),
    chanserv_unban_max_retries: cfgNum(c, 'chanserv_unban_max_retries', 3, log),
    chanserv_recover_cooldown_ms: cfgNum(c, 'chanserv_recover_cooldown_ms', 60_000, log),
    anope_recover_step_delay_ms: cfgNum(c, 'anope_recover_step_delay_ms', 200, log),
    takeover_window_ms: cfgNum(c, 'takeover_window_ms', 30_000, log),
    takeover_level_1_threshold: cfgNum(c, 'takeover_level_1_threshold', 3, log),
    takeover_level_2_threshold: cfgNum(c, 'takeover_level_2_threshold', 6, log),
    takeover_level_3_threshold: cfgNum(c, 'takeover_level_3_threshold', 10, log),
    takeover_response_delay_ms: cfgNum(c, 'takeover_response_delay_ms', 0, log),
    invite: cfg(c, 'invite', false),
  };

  // Validate threshold ordering
  if (config.takeover_level_1_threshold >= config.takeover_level_2_threshold) {
    log(
      `takeover_level_1_threshold (${config.takeover_level_1_threshold}) >= level_2 (${config.takeover_level_2_threshold}) — resetting thresholds to defaults`,
    );
    config.takeover_level_1_threshold = 3;
    config.takeover_level_2_threshold = 6;
    config.takeover_level_3_threshold = 10;
  } else if (config.takeover_level_2_threshold >= config.takeover_level_3_threshold) {
    log(
      `takeover_level_2_threshold (${config.takeover_level_2_threshold}) >= level_3 (${config.takeover_level_3_threshold}) — resetting thresholds to defaults`,
    );
    config.takeover_level_1_threshold = 3;
    config.takeover_level_2_threshold = 6;
    config.takeover_level_3_threshold = 10;
  }

  return config;
}
