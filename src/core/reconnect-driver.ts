// HexBot — Reconnect driver
//
// Owns the reconnect loop. Classifies disconnect reasons into three tiers
// (transient / rate-limited / fatal) and schedules the next `client.connect()`
// call with a tier-specific backoff. This module is the single source of
// truth for "should we reconnect, when, and how."
//
// Why this exists:
//   irc-framework's built-in auto-reconnect gives up whenever a reconnect
//   attempt opens a TCP socket but never completes IRC registration. That
//   left HexBot as a zombie process after the 2026-04-13 incident (registration
//   timeout mid-reconnect, both act-branches in the old onClose skipped).
//   We disable irc-framework's reconnect (`auto_reconnect: false`) and drive
//   every retry — initial failure, ping timeout, K-line, SASL auth — through
//   this file instead.
//
// Phase 1 research (scratch test, tests/scratch/reconnect-lifecycle.test.ts,
// since deleted) confirmed:
//   - client.connect() is idempotent and safe to call repeatedly.
//   - Repeated connect() calls do not leak listeners on the client or
//     its connection; transport is replaced fresh each call.
//   - connection.registered is reset to false on every connect().
//   - With auto_reconnect:false, 'reconnecting' is never emitted —
//     every socket close fires 'close' on the client.
//
// The driver never talks to the client directly. It calls a `connect`
// callback and listens for caller-driven `onConnected()` / `onDisconnect()`
// notifications. Keeping the boundaries clean makes the module trivially
// unit-testable without any IRC mock.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { ReconnectPolicy } from './connection-lifecycle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconnectDriverConfig {
  /** First retry after a transient failure, in ms. */
  transient_initial_ms: number;
  /** Cap on transient retry delay, in ms. */
  transient_max_ms: number;
  /** First retry after a rate-limited failure, in ms. */
  rate_limited_initial_ms: number;
  /** Cap on rate-limited retry delay, in ms. */
  rate_limited_max_ms: number;
  /** Random jitter added to every scheduled retry, in ms. */
  jitter_ms: number;
}

export interface ReconnectDriverDeps {
  /** Called to re-open the IRC connection. Usually `() => client.connect()`. */
  connect: () => void;
  logger: Logger;
  eventBus: BotEventBus;
  config: ReconnectDriverConfig;
  /**
   * Terminates the process on fatal tier classifications. Injected so tests
   * can swap in a spy; defaults to `process.exit` when left unset.
   */
  exit?: (code: number) => void;
}

export type ReconnectStatus = 'connected' | 'reconnecting' | 'degraded' | 'stopped';

export interface ReconnectState {
  status: ReconnectStatus;
  lastError: string | null;
  lastErrorTier: ReconnectPolicy['tier'] | null;
  /** Consecutive failures since the last successful registration. */
  consecutiveFailures: number;
  /** Wall-clock ms timestamp (Date.now() + delay) of the scheduled retry. */
  nextAttemptAt: number | null;
  /** Cumulative connect() attempts scheduled since the last success. */
  attemptCount: number;
}

export interface ReconnectDriver {
  /** Record a classified disconnect and schedule the next attempt (or exit). */
  onDisconnect(policy: ReconnectPolicy): void;
  /** Record a successful registration — resets backoff and failure counters. */
  onConnected(): void;
  /** Cancel any pending retry timer. Used on shutdown. */
  cancel(): void;
  /** Snapshot of the driver's state for the `.status` command. */
  getState(): ReconnectState;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Threshold of consecutive rate-limited failures before we flip to degraded. */
const DEGRADED_THRESHOLD = 3;
/** Cap on the doubling exponent so rate-limited delay tops out predictably. */
const RATE_LIMITED_DOUBLING_CAP = 3;

export function createReconnectDriver(deps: ReconnectDriverDeps): ReconnectDriver {
  const { logger, eventBus, config } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let status: ReconnectStatus = 'connected';
  let lastError: string | null = null;
  let lastErrorTier: ReconnectPolicy['tier'] | null = null;
  let consecutiveFailures = 0;
  let attemptCount = 0;
  let nextAttemptAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function computeDelay(tier: 'transient' | 'rate-limited'): number {
    const jitter = Math.floor(Math.random() * Math.max(0, config.jitter_ms));
    if (tier === 'transient') {
      // consecutiveFailures starts at 1 when we compute (incremented in
      // onDisconnect before this is called), so 2^(n-1) keeps the first
      // retry at `initial`.
      const exponent = Math.max(0, consecutiveFailures - 1);
      const base = config.transient_initial_ms * 2 ** exponent;
      return Math.min(base, config.transient_max_ms) + jitter;
    }
    // rate-limited
    const exponent = Math.min(Math.max(0, consecutiveFailures - 1), RATE_LIMITED_DOUBLING_CAP);
    const base = config.rate_limited_initial_ms * 2 ** exponent;
    return Math.min(base, config.rate_limited_max_ms) + jitter;
  }

  function scheduleRetry(tier: 'transient' | 'rate-limited', label: string | undefined): void {
    const delay = computeDelay(tier);
    nextAttemptAt = Date.now() + delay;
    attemptCount++;

    const labelSuffix = label ? ` (${label})` : '';
    const seconds = Math.round(delay / 1000);
    logger.info(
      `Reconnect scheduled in ${seconds}s — tier=${tier}${labelSuffix}, ` +
        `attempt ${attemptCount}, consecutive failures ${consecutiveFailures}`,
    );

    retryTimer = setTimeout(() => {
      retryTimer = null;
      nextAttemptAt = null;
      try {
        deps.connect();
      } catch (err) {
        // A synchronous throw from connect() is unusual — irc-framework
        // resolves host/port lazily — but we must not crash the timer loop.
        // Treat it as a transient disconnect so we keep retrying.
        logger.error(
          `Reconnect attempt threw synchronously: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, delay);
  }

  return {
    onDisconnect(policy: ReconnectPolicy): void {
      clearRetryTimer();
      consecutiveFailures++;
      lastErrorTier = policy.tier;
      lastError = 'label' in policy && policy.label ? policy.label : null;

      if (policy.tier === 'fatal') {
        logger.error(`FATAL: ${policy.label} — exiting with code ${policy.exitCode}`);
        eventBus.emit('bot:disconnected', `fatal: ${policy.label}`);
        status = 'stopped';
        nextAttemptAt = null;
        exit(policy.exitCode);
        return;
      }

      // rate-limited flips to `degraded` after DEGRADED_THRESHOLD failures.
      // transient stays in `reconnecting` regardless of count — a flaky
      // network shouldn't look as bad as a K-line in the status output.
      if (policy.tier === 'rate-limited' && consecutiveFailures >= DEGRADED_THRESHOLD) {
        status = 'degraded';
      } else {
        status = 'reconnecting';
      }

      scheduleRetry(policy.tier, lastError ?? undefined);
    },

    onConnected(): void {
      clearRetryTimer();
      status = 'connected';
      lastError = null;
      lastErrorTier = null;
      consecutiveFailures = 0;
      attemptCount = 0;
      nextAttemptAt = null;
    },

    cancel(): void {
      clearRetryTimer();
      status = 'stopped';
      nextAttemptAt = null;
    },

    getState(): ReconnectState {
      return {
        status,
        lastError,
        lastErrorTier,
        consecutiveFailures,
        nextAttemptAt,
        attemptCount,
      };
    },
  };
}
