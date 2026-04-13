// chanmod — timed ban auto-expire and periodic cleanup
// Ban storage has been migrated to core BanStore (api.banStore).
// This module handles migration from the old plugin namespace and periodic expiry.
import type { PluginAPI } from '../../src/types';
import { botHasOps } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

/**
 * Migrate any ban records from the old chanmod plugin DB namespace to the core _bans namespace.
 * Safe to call on every load — idempotent.
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

export function setupBans(api: PluginAPI, _config: ChanmodConfig, state: SharedState): () => void {
  const hasOps = (ch: string) => botHasOps(api, ch);
  const setMode = (ch: string, modes: string, param: string) => api.mode(ch, modes, param);
  const isTracked = (ch: string) => api.getChannel(ch) !== null;

  // Lift bans that expired during downtime (after a short delay to allow joining + getting ops)
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
