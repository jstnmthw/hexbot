// HexBot — long-uptime hygiene for the `kv` table.
//
// Two timers (both `unref`'d so they never block shutdown):
//   - daily prune: walks a known-namespace retention table and drops rows
//     older than the per-namespace TTL. Plugins with their own sweeps
//     (seen, ai-chat) keep theirs; this is the safety net for long-running
//     deployments where ad-hoc plugin state otherwise accumulates forever.
//   - ~monthly VACUUM: reclaims pages freed by the prune. Folded into the
//     daily handler with an elapsed-time check because a literal 30-day
//     setInterval overflows Node's 32-bit timer cap (TIMEOUT_MAX
//     = 2147483647 ms ≈ 24.8 days), which clamps the delay to 1ms and
//     fires the callback continuously.
import type { BotDatabase } from '../database';
import type { LoggerLike } from '../logger';

export interface KvRetentionEntry {
  ns: string;
  days: number;
}

export const KV_RETENTION_DAYS: ReadonlyArray<KvRetentionEntry> = [
  // ai-chat per-channel rate-limit / mood / token-budget rows: 30 days
  // is well past any active conversation window.
  { ns: 'plugin:ai-chat', days: 30 },
  // seen plugin: enforced cap is 10000 + size cap; this is the
  // belt-and-braces for ancient idle channels the cap never reaches.
  { ns: 'plugin:seen', days: 90 },
  // social-tracker / spotify-radio / topic / chanmod: each plugin
  // holds onto state by user / channel. 90d covers active operator
  // tenure without dropping a still-active record.
  { ns: 'plugin:social-tracker', days: 90 },
  { ns: 'plugin:spotify-radio', days: 90 },
  { ns: 'plugin:topic', days: 365 },
  { ns: 'plugin:chanmod', days: 90 },
  { ns: 'plugin:flood', days: 30 },
  { ns: 'plugin:greeter', days: 365 },
  { ns: 'plugin:rss', days: 7 },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const VACUUM_INTERVAL_MS = 30 * ONE_DAY_MS;

export interface KvMaintenanceHandle {
  /** Cancel the daily prune/VACUUM timer. Safe to call multiple times. */
  stop(): void;
}

/**
 * Schedule the daily prune + monthly VACUUM sweeps. Returns a stop handle
 * the caller (`Bot.shutdown`) clears during teardown.
 */
export function scheduleKvMaintenance(
  db: BotDatabase,
  logger: LoggerLike,
  retention: ReadonlyArray<KvRetentionEntry> = KV_RETENTION_DAYS,
): KvMaintenanceHandle {
  let lastVacuumAt = Date.now();

  const dailyMaintenance = (): void => {
    let totalPruned = 0;
    for (const { ns, days } of retention) {
      try {
        totalPruned += db.pruneOlderThan(ns, days);
      } catch (err) {
        logger.warn(`kv prune failed for ${ns}:`, err);
      }
    }
    if (totalPruned > 0) {
      logger.info(`kv daily prune: removed ${totalPruned} stale row(s)`);
    }
    if (Date.now() - lastVacuumAt >= VACUUM_INTERVAL_MS) {
      try {
        db.vacuum();
        lastVacuumAt = Date.now();
        logger.info('kv VACUUM complete');
      } catch (err) {
        logger.warn('kv VACUUM failed:', err);
      }
    }
  };

  const timer = setInterval(dailyMaintenance, ONE_DAY_MS);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
