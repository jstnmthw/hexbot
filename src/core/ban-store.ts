// Core ban store — first-class channel ban persistence in the _bans namespace.
// Wraps AdminListStore<BanRecord> with IRC-aware key formatting and expiry logic.
import type { BotDatabase } from '../database';
import type { BanRecord, PluginDB } from '../types';
import { sanitize } from '../utils/sanitize';
import { stripFormatting } from '../utils/strip-formatting';
import { AdminListStore } from './admin-list-store';

export type { BanRecord } from '../types';

const NAMESPACE = '_bans';

/**
 * Persistence-boundary input check for a ban mask. Mirrors the posture
 * mod_log enforces on every text column at write time. Callers (chanmod's
 * `!ban`, plugin `api.banStore`, bot-link relay paths) often validate at
 * their own surface, but the store itself must not trust the inputs.
 *
 * Accepts: a non-empty `nick!ident@host` shape, whitespace-free, with
 * `!` and `@` present. Rejects raw IRC formatting so a banner-injected
 * mask can't smuggle color/control bytes into stored audit metadata.
 */
const BAN_MASK_RE = /^[^\s!@]+![^\s!@]+@[^\s!@]+$/;

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
    // Persistence-boundary validation: callers should already have sanitized
    // these values, but the store can't assume that — bot-link relay paths
    // and plugin-callable surfaces both reach here. Strip formatting/CRLF
    // and require a well-shaped mask before any DB write.
    const cleanMask = sanitize(stripFormatting(mask));
    const cleanBy = sanitize(stripFormatting(by));
    if (cleanMask.length === 0 || !BAN_MASK_RE.test(cleanMask)) {
      throw new Error(`BanStore.storeBan: invalid mask "${mask}" — expected nick!ident@host`);
    }
    if (cleanBy.length === 0) {
      throw new Error('BanStore.storeBan: `by` cannot be empty');
    }
    // Duration normalization: NaN / Infinity / negative durations would
    // otherwise produce an `expires` that's already in the past (lifting
    // the ban on the next sweep) or a NaN sentinel that compares falsy.
    if (!Number.isFinite(durationMs)) {
      throw new Error(`BanStore.storeBan: durationMs must be finite (got ${durationMs})`);
    }
    const safeDuration = Math.max(0, Math.floor(durationMs));
    const now = Date.now();
    const expires = safeDuration === 0 ? 0 : now + safeDuration;
    const existing = this.getBan(channel, cleanMask);
    const record: BanRecord = {
      mask: cleanMask,
      channel: this.ircLower(channel),
      by: cleanBy,
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
    // Trailing `:` keeps the prefix scan tight to this channel — without it,
    // `ban:#foo` would also match `ban:#foobar:...` rows.
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
   * Reconcile stored ban records against a snapshot of the server's
   * `MODE #chan +b` list (RPL_BANLIST / 367). Any stored record whose mask
   * does not appear in the snapshot has been lifted externally (manual
   * `-b` by an operator, a services akick removal, an IRCd reset); dropping
   * those records prevents a future `liftExpiredBans` sweep from re-applying
   * a `-b` whose target was already unbanned. Conversely, masks on the
   * server but not in the store aren't our concern here — those were set by
   * someone else and {@link storeBan} never saw them.
   *
   * @param channel - The channel whose ban list was fetched
   * @param serverMasks - Every mask currently listed on the server
   * @returns count of stale records dropped
   */
  reconcileChannelBans(channel: string, serverMasks: Iterable<string>): number {
    const serverSet = new Set<string>();
    for (const mask of serverMasks) serverSet.add(mask);
    let dropped = 0;
    for (const record of this.getChannelBans(channel)) {
      if (!serverSet.has(record.mask)) {
        this.removeBan(record.channel, record.mask);
        dropped++;
      }
    }
    return dropped;
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
