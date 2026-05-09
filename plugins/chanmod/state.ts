// chanmod — shared state types and config interface
import type { PluginAPI, PluginSettingDef } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared mutable state (created fresh on each init, passed to all modules)
// ---------------------------------------------------------------------------

/** A single threat event recorded during a potential takeover. */
export interface ThreatEvent {
  /** Event type name (e.g. `bot_banned`, `friendly_deopped`) — see takeover-detect.ts. */
  type: string;
  /** Nick that caused the event (the hostile actor). */
  actor: string;
  /** Nick that the event acted on, if any (e.g. victim of a deop). */
  target?: string;
  /** `Date.now()` when the event was recorded. */
  timestamp: number;
}

/** Per-channel threat scoring state. */
export interface ThreatState {
  /** Running score accumulated within the current window. */
  score: number;
  /** Ring buffer of recorded events (capped in assessThreat). */
  events: ThreatEvent[];
  /** `Date.now()` when the window started — used to decay the score. */
  windowStart: number;
}

/**
 * Cycle timer owner — centralises scheduling, tracking, and teardown of all
 * "part/rejoin/defer" timers that mode-enforce, protection, and join-recovery
 * use. Callers never touch the backing Set directly — every path goes through
 * this API so teardown is guaranteed complete on plugin unload.
 *
 * Two scheduling flavors:
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
   * Register an externally-created timer so it is canceled on teardown.
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

/**
 * How long a bot-initiated mode change marker stays "fresh" before it's
 * considered stale. 5s is comfortably longer than the round-trip from
 * `api.deop()` to the resulting MODE event under normal latency, but short
 * enough that a user manually re-deopping someone seconds later doesn't
 * accidentally consume a stale marker and bypass mode-enforce.
 */
export const INTENTIONAL_TTL_MS = 5000;
/**
 * Rolling window for the per-(channel,target) enforcement cooldown counter.
 * Combined with {@link MAX_ENFORCEMENTS}: more than 3 re-enforcements within
 * 10s on the same target is treated as a mode-war signal — the bot stops
 * fighting and (where wired) reports `enforcement_suppressed` to the takeover
 * detector for escalation through ProtectionChain.
 */
export const COOLDOWN_WINDOW_MS = 10_000;
/** Mode-war saturation threshold — see {@link COOLDOWN_WINDOW_MS}. */
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

/**
 * Belt-and-braces teardown helper: null every Map/Set on the shared state so
 * that even if something retains a reference to `state` past plugin unload
 * (e.g. a closure captured by a backend callback that outlived its owner),
 * the per-channel history graph cannot pin the process.
 */
export function clearSharedState(state: SharedState): void {
  state.intentionalModeChanges.clear();
  state.enforcementCooldown.clear();
  state.cycles.clearAll();
  for (const timer of state.enforcementTimers) clearTimeout(timer);
  state.enforcementTimers.clear();
  if (state.startupTimer) {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
  }
  state.splitOpsSnapshot.clear();
  state.threatScores.clear();
  state.pendingRecoverCleanup.clear();
  state.lastKnownModes.clear();
  state.unbanRequested.clear();
  state.knownGoodTopics.clear();
  state.takeoverWarnedChannels.clear();
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
  /**
   * Required services-host wildcard pattern (e.g. `services.*`,
   * `*.libera.chat`, `services.rizon.net`). The ChanServ-notice router
   * rejects any notice whose sender host does not match this pattern —
   * closes the trust-on-first-use impostor window during a services
   * outage. No sensible default: operators must pin an actual services host.
   */
  services_host_pattern: string;
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

/**
 * Read a string-array setting that's stored as a comma-separated string
 * via the typed-settings registry. Empty entries are dropped; whitespace
 * around tokens is trimmed.
 */
function readStringArray(api: PluginAPI, key: string, fallback: string[]): string[] {
  if (!api.settings.isSet(key)) return fallback;
  const raw = api.settings.getString(key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a string-typed setting with fallback, treating "" as unset. */
function readStringOr(api: PluginAPI, key: string, fallback: string): string {
  const v = api.settings.getString(key);
  return v ? v : fallback;
}

/** Read an enum-typed string setting; fall back when the stored value is invalid. */
function readEnum<T extends string>(
  api: PluginAPI,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = api.settings.getString(key);
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Typed setting definitions for the chanmod plugin scope. Operators
 * mutate these via `.set chanmod <key> <value>`; the loader seeds them
 * from plugins.json on first boot. Settings whose values are read once
 * at init() are effectively `restart`-class — operators must `.restart`
 * (or the plugin must reload) for changes to take effect.
 */
export const CHANMOD_SETTING_DEFS: PluginSettingDef[] = [
  // Auto-op
  {
    key: 'auto_op',
    type: 'flag',
    default: true,
    description: 'Auto-op flagged users on join',
    channelOverridable: true,
  },
  {
    key: 'op_flags',
    type: 'string',
    default: 'n,m,o',
    description: 'Comma-separated flags eligible for auto-op',
  },
  {
    key: 'halfop_flags',
    type: 'string',
    default: '',
    description: 'Comma-separated flags eligible for auto-halfop',
  },
  {
    key: 'voice_flags',
    type: 'string',
    default: 'v',
    description: 'Comma-separated flags eligible for auto-voice',
  },
  {
    key: 'notify_on_fail',
    type: 'flag',
    default: false,
    description: 'Notice the target on auto-op failure',
  },
  // Mode enforcement
  {
    key: 'enforce_modes',
    type: 'flag',
    default: false,
    description: 'Re-apply channel mode string when removed',
    channelOverridable: true,
  },
  {
    key: 'enforce_delay_ms',
    type: 'int',
    default: 500,
    description: 'Delay before re-applying enforced modes (ms)',
  },
  {
    key: 'nodesynch_nicks',
    type: 'string',
    default: 'ChanServ',
    description: 'Comma-separated nicks whose mode changes are exempt from enforcement',
  },
  {
    key: 'enforce_channel_modes',
    type: 'string',
    default: '',
    description: 'Mode string to enforce (e.g. "+nt-s"); per-channel override via channelSettings',
    channelOverridable: true,
  },
  {
    key: 'enforce_channel_key',
    type: 'string',
    default: '',
    description: 'Channel key (+k) to enforce; per-channel override via channelSettings',
    channelOverridable: true,
  },
  {
    key: 'enforce_channel_limit',
    type: 'int',
    default: 0,
    description: 'Channel user limit (+l) to enforce; per-channel override via channelSettings',
    channelOverridable: true,
  },
  // Cycle
  {
    key: 'cycle_on_deop',
    type: 'flag',
    default: false,
    description: 'Cycle the channel after losing ops to regain via NickServ/ChanServ',
  },
  {
    key: 'cycle_delay_ms',
    type: 'int',
    default: 5000,
    description: 'Delay before cycling after deop (ms)',
  },
  // Bans / kick
  {
    key: 'default_kick_reason',
    type: 'string',
    default: 'Requested',
    description: 'Default kick reason when none provided',
  },
  {
    key: 'default_ban_duration',
    type: 'int',
    default: 120,
    description: 'Default tempban duration (minutes)',
  },
  {
    key: 'default_ban_type',
    type: 'int',
    default: 3,
    description:
      'Default ban-mask construction type (1=*!*@host, 2=*!ident@host, 3=*!*@*.tld, etc.)',
  },
  // Protection
  {
    key: 'rejoin_on_kick',
    type: 'flag',
    default: true,
    description: 'Rejoin the channel after being kicked',
  },
  {
    key: 'rejoin_delay_ms',
    type: 'int',
    default: 5000,
    description: 'Delay before rejoining after kick (ms)',
  },
  {
    key: 'max_rejoin_attempts',
    type: 'int',
    default: 3,
    description: 'Maximum rejoin attempts within the rejoin window before giving up',
  },
  {
    key: 'rejoin_attempt_window_ms',
    type: 'int',
    default: 300_000,
    description: 'Rolling window for the rejoin-attempt counter (ms)',
  },
  {
    key: 'revenge_on_kick',
    type: 'flag',
    default: false,
    description: 'Punish whoever kicks the bot (action set by revenge_action)',
    channelOverridable: true,
  },
  {
    key: 'revenge_action',
    type: 'string',
    default: 'deop',
    description: 'Revenge action against the kicker',
    allowedValues: ['deop', 'kick', 'kickban'],
  },
  {
    key: 'revenge_delay_ms',
    type: 'int',
    default: 3000,
    description: 'Delay before applying revenge action (ms)',
  },
  {
    key: 'revenge_kick_reason',
    type: 'string',
    default: "Don't kick me.",
    description: 'Revenge-kick reason text',
  },
  {
    key: 'revenge_exempt_flags',
    type: 'string',
    default: 'nm',
    description: 'Flags exempt from revenge (e.g. owners and masters)',
  },
  {
    key: 'bitch',
    type: 'flag',
    default: false,
    description: 'Deop any user who receives +o without the required op flag',
    channelOverridable: true,
  },
  {
    key: 'punish_deop',
    type: 'flag',
    default: false,
    description: 'Punish users who deop a flagged op',
    channelOverridable: true,
  },
  {
    key: 'punish_action',
    type: 'string',
    default: 'kick',
    description: 'Punishment action for unauthorized deops',
    allowedValues: ['kick', 'kickban'],
  },
  {
    key: 'punish_kick_reason',
    type: 'string',
    default: "Don't deop my friends.",
    description: 'Punish-kick reason text',
  },
  {
    key: 'enforcebans',
    type: 'flag',
    default: false,
    description: 'Kick users who match a new ban mask',
    channelOverridable: true,
  },
  {
    key: 'nick_recovery',
    type: 'flag',
    default: true,
    description: 'Try to reclaim the configured nick on collision',
  },
  {
    key: 'nick_recovery_ghost',
    type: 'flag',
    default: false,
    description: 'Use NickServ GHOST during nick recovery (requires nick_recovery_password)',
  },
  {
    key: 'stopnethack_mode',
    type: 'int',
    default: 0,
    description: 'StopNetHack mitigation mode (0 = off, 1 = mark, 2 = mark+ban)',
  },
  {
    key: 'split_timeout_ms',
    type: 'int',
    default: 300_000,
    description: 'Maximum netsplit duration before snapshotted op state is dropped (ms)',
  },
  {
    key: 'chanserv_nick',
    type: 'string',
    default: 'ChanServ',
    description: 'ChanServ service nick',
  },
  {
    key: 'chanserv_op_delay_ms',
    type: 'int',
    default: 1000,
    description: 'Delay before requesting ChanServ ops on join (ms)',
  },
  {
    key: 'chanserv_services_type',
    type: 'string',
    default: '',
    description: 'ChanServ services flavor (atheme | anope); empty = derive from services.type',
    allowedValues: ['atheme', 'anope', ''],
  },
  {
    key: 'services_host_pattern',
    type: 'string',
    default: '',
    description: 'Wildcard pattern for ChanServ host (e.g. services.*, *.libera.chat) — REQUIRED',
  },
  {
    key: 'chanserv_unban_retry_ms',
    type: 'int',
    default: 2000,
    description: 'Delay between ChanServ UNBAN retries (ms)',
  },
  {
    key: 'chanserv_unban_max_retries',
    type: 'int',
    default: 3,
    description: 'Maximum ChanServ UNBAN retries before giving up',
  },
  {
    key: 'chanserv_recover_cooldown_ms',
    type: 'int',
    default: 60_000,
    description: 'Minimum interval between ChanServ RECOVER attempts on the same channel (ms)',
  },
  {
    key: 'anope_recover_step_delay_ms',
    type: 'int',
    default: 200,
    description: 'Delay between Anope multi-step RECOVER commands (ms)',
  },
  {
    key: 'takeover_window_ms',
    type: 'int',
    default: 30_000,
    description: 'Sliding window for takeover threat-score accumulation (ms)',
  },
  {
    key: 'takeover_level_1_threshold',
    type: 'int',
    default: 3,
    description: 'Threat score threshold to enter level 1',
  },
  {
    key: 'takeover_level_2_threshold',
    type: 'int',
    default: 6,
    description: 'Threat score threshold to enter level 2',
  },
  {
    key: 'takeover_level_3_threshold',
    type: 'int',
    default: 10,
    description: 'Threat score threshold to enter level 3',
  },
  {
    key: 'takeover_response_delay_ms',
    type: 'int',
    default: 0,
    description: 'Delay before responding to a takeover threat tier (ms)',
  },
  {
    key: 'invite',
    type: 'flag',
    default: false,
    description: 'Accept invites from ops/masters and join the invited channel',
  },
];

/**
 * Read and validate the chanmod plugin config via the plugin's
 * `api.settings` registry. Each field is read through a typed accessor
 * (`api.settings.getInt` / `getString` / etc); enum and string-array
 * keys go through `readEnum` / `readStringArray` for shape validation.
 * Throws when `services_host_pattern` is unset/blank — see the
 * throw-site comment.
 */
export function readConfig(api: PluginAPI): ChanmodConfig {
  const log = (msg: string): void => api.log(msg);

  const config: ChanmodConfig = {
    auto_op: api.settings.getFlag('auto_op'),
    op_flags: readStringArray(api, 'op_flags', ['n', 'm', 'o']),
    halfop_flags: readStringArray(api, 'halfop_flags', []),
    voice_flags: readStringArray(api, 'voice_flags', ['v']),
    notify_on_fail: api.settings.getFlag('notify_on_fail'),
    enforce_modes: api.settings.getFlag('enforce_modes'),
    enforce_delay_ms: api.settings.getInt('enforce_delay_ms') || 500,
    nodesynch_nicks: readStringArray(api, 'nodesynch_nicks', ['ChanServ']),
    enforce_channel_modes: api.settings.getString('enforce_channel_modes'),
    enforce_channel_key: api.settings.getString('enforce_channel_key'),
    enforce_channel_limit: api.settings.getInt('enforce_channel_limit'),
    cycle_on_deop: api.settings.getFlag('cycle_on_deop'),
    cycle_delay_ms: api.settings.getInt('cycle_delay_ms') || 5000,
    default_kick_reason: readStringOr(api, 'default_kick_reason', 'Requested'),
    default_ban_duration: api.settings.getInt('default_ban_duration') || 120,
    default_ban_type: api.settings.getInt('default_ban_type') || 3,
    rejoin_on_kick: api.settings.isSet('rejoin_on_kick')
      ? api.settings.getFlag('rejoin_on_kick')
      : true,
    rejoin_delay_ms: api.settings.getInt('rejoin_delay_ms') || 5000,
    max_rejoin_attempts: api.settings.getInt('max_rejoin_attempts') || 3,
    rejoin_attempt_window_ms: api.settings.getInt('rejoin_attempt_window_ms') || 300_000,
    revenge_on_kick: api.settings.getFlag('revenge_on_kick'),
    revenge_action: readEnum(api, 'revenge_action', ['deop', 'kick', 'kickban'] as const, 'deop'),
    revenge_delay_ms: api.settings.getInt('revenge_delay_ms') || 3000,
    revenge_kick_reason: readStringOr(api, 'revenge_kick_reason', "Don't kick me."),
    revenge_exempt_flags: readStringOr(api, 'revenge_exempt_flags', 'nm'),
    bitch: api.settings.getFlag('bitch'),
    punish_deop: api.settings.getFlag('punish_deop'),
    punish_action: readEnum(api, 'punish_action', ['kick', 'kickban'] as const, 'kick'),
    punish_kick_reason: readStringOr(api, 'punish_kick_reason', "Don't deop my friends."),
    enforcebans: api.settings.getFlag('enforcebans'),
    nick_recovery: api.settings.isSet('nick_recovery')
      ? api.settings.getFlag('nick_recovery')
      : true,
    nick_recovery_ghost: api.settings.getFlag('nick_recovery_ghost'),
    // Password read from bot.json (not plugins.json) per SECURITY.md §6
    nick_recovery_password: api.botConfig.chanmod?.nick_recovery_password ?? '',
    stopnethack_mode: api.settings.getInt('stopnethack_mode'),
    split_timeout_ms: api.settings.getInt('split_timeout_ms') || 300_000,
    chanserv_nick: readStringOr(api, 'chanserv_nick', 'ChanServ'),
    chanserv_op_delay_ms: api.settings.getInt('chanserv_op_delay_ms') || 1000,
    chanserv_services_type: (() => {
      const raw = api.settings.getString('chanserv_services_type');
      if (raw === 'atheme' || raw === 'anope') return raw;
      return api.botConfig.services.type === 'anope' ? 'anope' : 'atheme';
    })(),
    // services_host_pattern is REQUIRED — the loader throws below if it
    // is missing/empty so operators cannot silently run without the
    // ChanServ impostor guard.
    services_host_pattern: api.settings.getString('services_host_pattern'),
    chanserv_unban_retry_ms: api.settings.getInt('chanserv_unban_retry_ms') || 2000,
    chanserv_unban_max_retries: api.settings.getInt('chanserv_unban_max_retries') || 3,
    chanserv_recover_cooldown_ms: api.settings.getInt('chanserv_recover_cooldown_ms') || 60_000,
    anope_recover_step_delay_ms: api.settings.getInt('anope_recover_step_delay_ms') || 200,
    takeover_window_ms: api.settings.getInt('takeover_window_ms') || 30_000,
    takeover_level_1_threshold: api.settings.getInt('takeover_level_1_threshold') || 3,
    takeover_level_2_threshold: api.settings.getInt('takeover_level_2_threshold') || 6,
    takeover_level_3_threshold: api.settings.getInt('takeover_level_3_threshold') || 10,
    takeover_response_delay_ms: api.settings.getInt('takeover_response_delay_ms'),
    invite: api.settings.getFlag('invite'),
  };

  // services_host_pattern is load-bearing for the ChanServ-impostor
  // guard. No default is provided: operators must pin a real services-host
  // suffix (e.g. `services.*`, `*.libera.chat`, `services.rizon.net`). We
  // refuse to load without it — clean-cut over trust-on-first-use, since
  // a silent degraded posture trivially exposes the bot to a phantom
  // founder/op grant via a crafted INFO/FLAGS response from someone who
  // takes the ChanServ nick during a services outage.
  // See config/plugins.example.json for per-network suggestions.
  if (!config.services_host_pattern.trim()) {
    throw new Error(
      'chanmod: services_host_pattern is required. Set it in plugins.json chanmod.config (e.g. "services.*", "*.libera.chat", "services.rizon.net"). The ChanServ-impostor guard depends on this pattern — during a services outage, anyone who grabs the ChanServ nick can feed the bot a crafted INFO/FLAGS response that elevates them to founder. See config/plugins.example.json.',
    );
  }

  // Threat thresholds must be strictly ascending — the threat-level lookup in
  // `scoreToLevel()` uses `>=` against each tier in order, so a non-monotonic
  // config (e.g. level_1 >= level_2) would make it impossible to reach the
  // higher tier. Reset to defaults rather than try to repair partial input.
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
