// Core ban store — first-class channel ban persistence in the _bans namespace.
// Wraps AdminListStore<BanRecord> with IRC-aware key formatting and expiry logic.
import type { BotDatabase } from '../database';
import type { BanRecord, PluginDB } from '../types';
import { AdminListStore } from '../utils/admin-list-store';

export type { BanRecord } from '../types';

// ---------------------------------------------------------------------------
// BanStore
// ---------------------------------------------------------------------------

const NAMESPACE = '_bans';

/** Runtime shape check — the JSON we load from the legacy plugin namespace is
 *  untrusted, so every field is validated before the record is persisted
 *  into the core namespace. */
function isBanRecord(value: unknown): value is BanRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mask === 'string' &&
    typeof v.channel === 'string' &&
    typeof v.by === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.expires === 'number' &&
    (v.sticky === undefined || typeof v.sticky === 'boolean')
  );
}
/** Grace window after an expired ban passes its deadline before we drop the
 *  record even if the bot can't actually lift it on IRC (no ops, or the bot
 *  no longer sits in the channel). Prevents the record from persisting
 *  forever in abandoned channels. */
const ORPHAN_BAN_GRACE_MS = 24 * 60 * 60_000;

export class BanStore {
  private readonly store: AdminListStore<BanRecord>;
  private readonly ircLower: (s: string) => string;

  constructor(db: BotDatabase, ircLower: (s: string) => string) {
    this.ircLower = ircLower;
    this.store = new AdminListStore<BanRecord>(db, {
      namespace: NAMESPACE,
      keyFn: (record) => this.makeKey(record.channel, record.mask),
    });
  }

  /** Store a ban with a duration in milliseconds (0 = permanent). */
  storeBan(channel: string, mask: string, by: string, durationMs: number): void {
    const now = Date.now();
    const expires = durationMs === 0 ? 0 : now + durationMs;
    const existing = this.getBan(channel, mask);
    const record: BanRecord = {
      mask,
      channel: this.ircLower(channel),
      by,
      ts: now,
      expires,
      sticky: existing?.sticky,
    };
    this.store.set(record);
  }

  /** Remove a ban record. */
  removeBan(channel: string, mask: string): void {
    this.store.del(this.makeKey(channel, mask));
  }

  /** Get a single ban record, or null if not found. */
  getBan(channel: string, mask: string): BanRecord | null {
    return this.store.get(this.makeKey(channel, mask));
  }

  /** Get all bans for a specific channel. */
  getChannelBans(channel: string): BanRecord[] {
    return this.store.list(`ban:${this.ircLower(channel)}:`);
  }

  /** Get all bans across all channels. */
  getAllBans(): BanRecord[] {
    return this.store.list('ban:');
  }

  /** Toggle sticky flag on an existing ban. Returns false if the ban doesn't exist. */
  setSticky(channel: string, mask: string, sticky: boolean): boolean {
    const record = this.getBan(channel, mask);
    if (!record) return false;
    record.sticky = sticky;
    this.store.set(record);
    return true;
  }

  /**
   * Lift expired bans in channels where the bot has ops.
   *
   * Two-pass sweep:
   *  1. Channels where the bot has ops: send -b and drop the record.
   *  2. Orphaned records (no ops, or the channel is no longer tracked)
   *     that have been expired for more than {@link ORPHAN_BAN_GRACE_MS}:
   *     drop the record anyway so abandoned channels don't accumulate
   *     records forever.
   *
   * @param hasOps - check if bot has ops in a channel
   * @param mode - send a MODE command to IRC
   * @param isTracked - optional predicate: is this channel still in channel state?
   * @returns count of bans actually lifted on IRC (not counting orphan drops)
   */
  liftExpiredBans(
    hasOps: (channel: string) => boolean,
    mode: (channel: string, modes: string, param: string) => void,
    isTracked?: (channel: string) => boolean,
  ): number {
    const now = Date.now();
    let lifted = 0;
    for (const record of this.getAllBans()) {
      if (record.expires <= 0 || record.expires > now) continue;
      if (hasOps(record.channel)) {
        mode(record.channel, '-b', record.mask);
        this.removeBan(record.channel, record.mask);
        lifted++;
        continue;
      }
      // Orphan cleanup: bot can't send -b, so the on-IRC ban is stuck, but
      // the record itself has no reason to live past its expiry forever.
      const orphaned =
        now - record.expires > ORPHAN_BAN_GRACE_MS ||
        (isTracked !== undefined && !isTracked(record.channel));
      if (orphaned) {
        this.removeBan(record.channel, record.mask);
      }
    }
    return lifted;
  }

  /**
   * Migrate ban records from a plugin's namespace to the core _bans namespace.
   * Safe to run multiple times (idempotent — skips if _bans already has the key).
   * @returns count of records migrated
   */
  migrateFromPluginNamespace(pluginDb: PluginDB): number {
    const oldRecords = pluginDb.list('ban:');
    let migrated = 0;
    for (const { key, value } of oldRecords) {
      // Only migrate if the key doesn't already exist in _bans
      if (!this.store.has(key)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          // Skip unparseable rows — they'll still get deleted below so the
          // stale namespace is fully cleaned up.
          pluginDb.del(key);
          continue;
        }
        if (isBanRecord(parsed)) {
          this.store.set(parsed);
          migrated++;
        }
      }
      // Delete from old namespace regardless (idempotent cleanup)
      pluginDb.del(key);
    }
    return migrated;
  }

  private makeKey(channel: string, mask: string): string {
    return `ban:${this.ircLower(channel)}:${mask}`;
  }
}
