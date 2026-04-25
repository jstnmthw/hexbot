// chanmod — takeover threat detection engine
//
// Per-channel rolling threat score that detects coordinated channel takeover
// attempts by watching for correlated hostile events within a short time window.
// Produces a threat level (0-3) that triggers escalating responses via the
// ProtectionChain.
import type { PluginAPI } from '../../src/types';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState, ThreatState } from './state';

// ---------------------------------------------------------------------------
// Threat level constants
// ---------------------------------------------------------------------------

export const THREAT_NORMAL = 0 as const;
export const THREAT_ALERT = 1 as const;
export const THREAT_ACTIVE = 2 as const;
export const THREAT_CRITICAL = 3 as const;

/**
 * Escalating threat levels produced by {@link scoreToLevel}. Comparable with
 * `>=` because the values are 0..3 — mode-enforce-recovery uses that for
 * "threat is at least Alert".
 */
export type ThreatLevel =
  | typeof THREAT_NORMAL
  | typeof THREAT_ALERT
  | typeof THREAT_ACTIVE
  | typeof THREAT_CRITICAL;

// ---------------------------------------------------------------------------
// Threat event point values
//
// The values are calibrated against the default thresholds in `state.ts`
// (`takeover_level_*_threshold` defaults: 3 / 6 / 10) — a single bot-kicked
// event lands at ALERT (level 1), a bot-banned + bot-deopped pair lands at
// ACTIVE (level 2), and a sustained burst pushes through CRITICAL (level 3).
// Severity ordering mirrors how unrecoverable each event makes the bot:
// banned > kicked > deopped > everything-else.
// ---------------------------------------------------------------------------

export const POINTS_BOT_DEOPPED = 3;
export const POINTS_BOT_KICKED = 4;
export const POINTS_BOT_BANNED = 5;
export const POINTS_FRIENDLY_DEOPPED = 2;
export const POINTS_MODE_LOCKED = 1;
export const POINTS_UNAUTHORIZED_OP = 2;
export const POINTS_ENFORCEMENT_SUPPRESSED = 2;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Get or create the threat state for a channel.
 * If the existing state's window has expired, it is reset.
 */
function getOrCreateThreat(
  state: SharedState,
  api: PluginAPI,
  config: ChanmodConfig,
  channel: string,
): ThreatState {
  const key = api.ircLower(channel);
  const now = Date.now();
  let threat = state.threatScores.get(key);

  if (!threat) {
    threat = { score: 0, events: [], windowStart: now };
    state.threatScores.set(key, threat);
    return threat;
  }

  // Decay: if the window has expired, reset
  if (now - threat.windowStart > config.takeover_window_ms) {
    threat.score = 0;
    threat.events = [];
    threat.windowStart = now;
  }

  return threat;
}

/**
 * Compute the threat level from a score using configured thresholds.
 */
export function scoreToLevel(config: ChanmodConfig, score: number): ThreatLevel {
  if (score >= config.takeover_level_3_threshold) return THREAT_CRITICAL;
  if (score >= config.takeover_level_2_threshold) return THREAT_ACTIVE;
  if (score >= config.takeover_level_1_threshold) return THREAT_ALERT;
  return THREAT_NORMAL;
}

/**
 * Add points to a channel's threat score and return the new threat level.
 *
 * Each call records a ThreatEvent and may trigger escalation via the
 * ProtectionChain based on the new threat level.
 */
export function assessThreat(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  chain: ProtectionChain,
  channel: string,
  eventType: string,
  points: number,
  actor: string,
  target?: string,
): ThreatLevel {
  const threat = getOrCreateThreat(state, api, config, channel);
  const prevLevel = scoreToLevel(config, threat.score);

  threat.score += points;
  threat.events.push({
    type: eventType,
    actor,
    target,
    timestamp: Date.now(),
  });
  // Cap the per-channel event ring so a sustained takeover attempt
  // can't grow `threat.events` indefinitely. 1000 entries is enough
  // for attack forensics over a multi-hour siege without making the
  // in-memory history of a single channel unreasonable.
  const RING_CAP = 1000;
  if (threat.events.length > RING_CAP) {
    threat.events.splice(0, threat.events.length - RING_CAP);
  }

  const newLevel = scoreToLevel(config, threat.score);

  // Log level transitions
  if (newLevel > prevLevel) {
    const levelNames = ['Normal', 'Alert', 'Active', 'Critical'];
    api.warn(
      `Takeover threat in ${channel}: level ${prevLevel} → ${newLevel} (${levelNames[newLevel]}) — score ${threat.score} [${eventType} by ${actor}]`,
    );
    onLevelEscalation(api, config, chain, channel, newLevel);
  }

  return newLevel;
}

/**
 * Get the current threat level for a channel.
 * Returns 0 (Normal) if no threat state exists or the window has expired.
 */
export function getThreatLevel(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
): ThreatLevel {
  const key = api.ircLower(channel);
  const threat = state.threatScores.get(key);
  if (!threat) return THREAT_NORMAL;

  // Check window expiry
  if (Date.now() - threat.windowStart > config.takeover_window_ms) {
    return THREAT_NORMAL;
  }

  return scoreToLevel(config, threat.score);
}

/**
 * Get the raw threat state for a channel (for testing/debug).
 */
export function getThreatState(
  api: PluginAPI,
  state: SharedState,
  channel: string,
): ThreatState | undefined {
  return state.threatScores.get(api.ircLower(channel));
}

// ---------------------------------------------------------------------------
// Escalation actions — called on level transitions
// ---------------------------------------------------------------------------

function onLevelEscalation(
  api: PluginAPI,
  _config: ChanmodConfig,
  chain: ProtectionChain,
  channel: string,
  level: ThreatLevel,
): void {
  if (level >= THREAT_ALERT) {
    // Level 1+: request ops via first available backend
    if (chain.canOp(channel)) {
      chain.requestOp(channel);
    }
  }

  if (level >= THREAT_ACTIVE) {
    // Level 2+: request unban (we may be banned)
    if (chain.canUnban(channel)) {
      chain.requestUnban(channel);
    }
  }

  if (level >= THREAT_CRITICAL) {
    // Level 3: nuclear — request full channel recovery
    if (chain.canRecover(channel)) {
      chain.requestRecover(channel);
    } else {
      api.warn(
        `Takeover critical in ${channel} but no backend can RECOVER — manual intervention required`,
      );
    }
  }
}
