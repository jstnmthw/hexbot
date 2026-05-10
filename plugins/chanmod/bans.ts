// chanmod — timed ban auto-expire and periodic cleanup
// Ban storage has been migrated to core BanStore (api.banStore).
// This module handles migration from the old plugin namespace and periodic expiry.
import type { PluginAPI } from '../../src/types';
import { botHasOps } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

/**
 * Migrate any ban records from the old chanmod plugin DB namespace
 * (`ban:<channel>:<mask>` keys) to the core `_bans` namespace owned by
 * `api.banStore`. Safe to call on every load — idempotent: when no
 * legacy entries exist the call is a no-op, and `migrateFromPluginNamespace`
 * deletes the old keys after copying so a subsequent run finds nothing.
 */
export function migrateBansToCore(api: PluginAPI): number {
  const oldBans = api.db.list('ban:');
  if (oldBans.length === 0) return 0;
  api.log(`Found ${oldBans.length} ban record(s) in plugin namespace — migrating to core`);
  const count = api.banStore.migrateFromPluginNamespace(api.db);
  if (count > 0) {
    api.log(`Migrated ${count} ban record(s) to core _bans namespace`);
  }
  return count;
}

/**
 * Start the periodic ban-expiry sweep.
 *
 * Schedules a one-shot pass 5 seconds after load (to lift bans that expired
 * while the bot was offline — only effective once the bot has rejoined and
 * regained ops) plus a 60s cadence bind for steady-state expiry. Lifts are
 * skipped for channels where the bot lacks ops; the next tick re-checks.
 */
export function setupBans(api: PluginAPI, _config: ChanmodConfig, state: SharedState): () => void {
  const hasOps = (ch: string) => botHasOps(api, ch);
  const setMode = (ch: string, modes: string, param: string) => api.mode(ch, modes, param);
  const isTracked = (ch: string) => api.getChannel(ch) !== null;

  // Lift bans that expired during downtime. The 5s delay gives the bot time
  // to (a) finish JOINing every configured channel, and (b) receive the
  // ChanServ OP on join — without ops the `-b` lift is silently rejected by
  // the server and the periodic 60s tick has to clean up. 5s is comfortably
  // longer than typical join → +o latency on Atheme/Anope networks.
  state.startupTimer = setTimeout(() => {
    state.startupTimer = null;
    const lifted = api.banStore.liftExpiredBans(hasOps, setMode, isTracked);
    if (lifted > 0) {
      api.log(`Lifted ${lifted} expired ban${lifted === 1 ? '' : 's'} after downtime`);
    }
  }, 5000);

  api.bind('time', '-', '60', () => {
    api.banStore.liftExpiredBans(hasOps, setMode, isTracked);
  });

  return () => {
    if (state.startupTimer !== null) {
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
    }
  };
}
