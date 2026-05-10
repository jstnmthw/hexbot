// HexBot — Bot link auth state store
//
// Owns every piece of persistent and semi-persistent state used by the
// auth manager: the per-IP LRU tracker, the manual CIDR ban map, and
// the DB-backed `AdminListStore` for persisted link bans. Extracted from
// `auth.ts` so the admission gate (auth.ts) doesn't also have to know
// about storage layout, cap enforcement, and startup load. See 2026-04-19
// quality audit.
import type { BotDatabase } from '../../database';
import type { LoggerLike } from '../../logger';
import { AdminListStore } from '../admin-list-store';
import { tryLogModAction } from '../audit';
import { type AuthTracker, newTracker } from './auth-escalation';
import { LRUMap } from './lru-map';

/** Hard cap on manually-banned CIDR ranges to prevent connection-path DoS. */
export const MAX_CIDR_BANS = 500;

/**
 * Hard cap on the per-IP auth failure tracker. Defends against a distributed
 * scanner briefly spiking the map between sweep runs (every 300s). At 200
 * conns/s worst case, one sweep window is ~60k attempts, but steady state
 * post-sweep is bounded by actual live tracker lifetimes. Oldest entries
 * are evicted first — they haven't been touched by `noteFailure` recently
 * so they are the safest to drop.
 */
export const MAX_AUTH_TRACKERS = 10_000;

/** Outward-facing row describing one active auth ban (auto or manual). */
export interface AuthBanEntry {
  ip: string;
  bannedUntil: number; // 0 = permanent
  banCount: number;
  manual: boolean;
}

/** A single persisted manual ban — one row in the DB-backed `_linkbans` list. */
export interface LinkBan {
  ip: string; // single IP or CIDR range
  bannedUntil: number; // 0 = permanent
  reason: string;
  setBy: string;
  setAt: number; // unix ms
}

/**
 * Storage surface for the auth manager. Holds the three pieces of state
 * that the admission gate reads and the operator commands mutate:
 *
 *   - `authTracker`:  LRU-capped per-IP failure + ban state
 *   - `manualCidrBans`: manually-banned CIDR ranges (hot path lookup)
 *   - `linkBanStore`: DB persistence for manual bans, reloaded on boot
 *
 * The maps are exposed `readonly` so the auth manager and tests can
 * seed / inspect them directly. Mutation helpers live here so storage
 * invariants (CIDR cap, DB persistence, startup load) stay in one place.
 */
export class BotLinkAuthStore {
  readonly authTracker: LRUMap<string, AuthTracker> = new LRUMap(MAX_AUTH_TRACKERS);
  readonly manualCidrBans: Map<string, LinkBan> = new Map();
  readonly linkBanStore: AdminListStore<LinkBan> | null;

  constructor(
    private readonly db: BotDatabase | null,
    private readonly logger: LoggerLike | null,
  ) {
    this.linkBanStore = db
      ? new AdminListStore<LinkBan>(db, {
          namespace: '_linkbans',
          keyFn: (ban) => ban.ip,
        })
      : null;
    this.loadPersistedBans();
  }

  /**
   * Fetch or lazily create the tracker for `ip`. Does NOT `set` the
   * tracker back into the LRU — callers that need LRU promotion must
   * call `authTracker.set(ip, tracker)` themselves (typically in
   * `noteFailure`, after mutating fields).
   */
  getOrCreateTracker(ip: string, now: number): AuthTracker {
    return this.authTracker.get(ip) ?? newTracker(now);
  }

  /**
   * Persist a manual ban and load it into the hot path. CIDR ranges go
   * into `manualCidrBans` (subject to `MAX_CIDR_BANS`); single IPs are
   * injected into `authTracker` with a far-future `bannedUntil` so the
   * per-IP admission check catches them without a CIDR scan. Returns
   * `false` when a CIDR ban is rejected because the cap is full.
   */
  addManualBan(ban: LinkBan): boolean {
    this.linkBanStore?.set(ban);

    if (ban.ip.includes('/')) {
      // CIDR range — enforce cap to prevent connection-path DoS
      if (!this.manualCidrBans.has(ban.ip) && this.manualCidrBans.size >= MAX_CIDR_BANS) {
        this.logger?.warn(`CIDR ban limit (${MAX_CIDR_BANS}) reached, rejecting ${ban.ip}`);
        return false;
      }
      this.manualCidrBans.set(ban.ip, ban);
      return true;
    }

    // Single IP — set in authTracker for fast Map lookup
    const tracker = this.authTracker.get(ban.ip) ?? newTracker(ban.setAt);
    // For permanent bans, use a far-future timestamp
    tracker.bannedUntil = ban.bannedUntil === 0 ? Number.MAX_SAFE_INTEGER : ban.bannedUntil;
    this.authTracker.set(ban.ip, tracker);
    return true;
  }

  /**
   * Remove a ban (auto or manual) for an IP or CIDR from every state
   * surface — the authTracker, the CIDR map, and the DB. Idempotent;
   * callers don't need to know which storage surface the entry lived in.
   */
  removeBan(ip: string): void {
    this.authTracker.delete(ip);
    this.manualCidrBans.delete(ip);
    this.linkBanStore?.del(ip);
  }

  /** Drop an expired CIDR ban from both the hot path and the DB. */
  dropExpiredCidrBan(ip: string): void {
    this.manualCidrBans.delete(ip);
    this.linkBanStore?.del(ip);
  }

  /**
   * Look up a persisted manual single-IP ban for `ip`. Returns the ban
   * when one exists in the DB, is non-CIDR, and is either permanent
   * (`bannedUntil === 0`) or unexpired. Used by the admission gate to
   * re-hydrate the LRU `authTracker` on cache miss — the LRU can evict
   * a single-IP manual ban under scanner pressure even though the
   * underlying record is permanent. Without this, an evicted permanent
   * ban silently stops applying until process restart.
   */
  getPersistedSingleIpBan(ip: string): LinkBan | null {
    if (!this.linkBanStore) return null;
    const ban = this.linkBanStore.get(ip);
    if (!ban || ban.ip.includes('/')) return null;
    if (ban.bannedUntil !== 0 && ban.bannedUntil <= Date.now()) return null;
    return ban;
  }

  /** Enumerate persisted manual bans — used by `getAuthBans` for the admin list. */
  listPersistedBans(): LinkBan[] {
    return this.linkBanStore?.list() ?? [];
  }

  /**
   * Write a mod_log row for a manual ban action. Wrapped so a DB error
   * never prevents the ban/unban from taking effect in memory.
   */
  recordModAction(action: string, target: string, by: string, detail: string | null): void {
    tryLogModAction(
      this.db,
      { action, source: 'botlink', by, target, reason: detail },
      this.logger,
    );
  }

  /** Load persisted manual bans from DB into the hot path on startup. */
  private loadPersistedBans(): void {
    if (!this.linkBanStore) return;
    const now = Date.now();
    let loaded = 0;
    for (const ban of this.linkBanStore.list()) {
      // Skip expired non-permanent bans
      if (ban.bannedUntil !== 0 && ban.bannedUntil <= now) continue;

      if (ban.ip.includes('/')) {
        this.manualCidrBans.set(ban.ip, ban);
      } else {
        const tracker = this.authTracker.get(ban.ip) ?? newTracker(ban.setAt);
        tracker.bannedUntil = ban.bannedUntil === 0 ? Number.MAX_SAFE_INTEGER : ban.bannedUntil;
        this.authTracker.set(ban.ip, tracker);
      }
      loaded++;
    }
    if (loaded > 0) {
      this.logger?.info(`Loaded ${loaded} persisted link ban(s)`);
    }
  }
}
