// HexBot — Bot link authentication and IP ban management
//
// Owns everything to do with authenticating incoming leaf connections:
// IP allow/denylists, per-IP auth failure tracking with exponential backoff,
// pending-handshake counting, manual CIDR bans, and the persisted link-ban
// store. Extracted from BotLinkHub so the escalation math and ban-state
// management can be unit-tested without standing up a full hub.
import type { BotDatabase } from '../database';
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotlinkConfig } from '../types';
import { AdminListStore } from '../utils/admin-list-store';
import { hashPassword } from './botlink-protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthTracker {
  failures: number;
  firstFailure: number;
  bannedUntil: number;
  /** Number of times this IP has been banned — drives escalation doubling. */
  banCount: number;
}

export interface AuthBanEntry {
  ip: string;
  bannedUntil: number; // 0 = permanent
  banCount: number;
  manual: boolean;
}

export interface LinkBan {
  ip: string; // single IP or CIDR range
  bannedUntil: number; // 0 = permanent
  reason: string;
  setBy: string;
  setAt: number; // unix ms
}

/** Outcome of the "can this IP even start a handshake" gate. */
export type AdmissionResult =
  | { allowed: true; whitelisted: boolean }
  | { allowed: false; reason: 'banned' | 'cidr-banned' | 'pending-limit' | 'unknown-ip' };

// ---------------------------------------------------------------------------
// IP parsing helpers
// ---------------------------------------------------------------------------

/** Parse an IPv4 address into a 32-bit number. Returns NaN for invalid input. */
function ipv4ToNum(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  let num = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (octet < 0 || octet > 255 || !Number.isInteger(octet)) return NaN;
    num = (num << 8) | octet;
  }
  return num >>> 0; // unsigned
}

/** Normalize IPv6-mapped IPv4 (::ffff:10.0.0.1 → 10.0.0.1). Returns the input unchanged for pure IPv6/IPv4. */
export function normalizeIP(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** Validate that a string is a valid IPv4 address or IPv4 CIDR range. */
export function isValidIP(input: string): boolean {
  const slash = input.indexOf('/');
  if (slash === -1) {
    return !Number.isNaN(ipv4ToNum(input));
  }
  const base = input.slice(0, slash);
  const prefix = Number(input.slice(slash + 1));
  return !Number.isNaN(ipv4ToNum(base)) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

/** Check whether an IP matches any CIDR in the whitelist. IPv4 only (IPv6 CIDRs are ignored). */
export function isWhitelisted(ip: string, cidrs: string[]): boolean {
  const normalizedIP = normalizeIP(ip);
  const ipNum = ipv4ToNum(normalizedIP);
  if (Number.isNaN(ipNum)) return false; // non-IPv4 — not whitelisted

  for (const cidr of cidrs) {
    const slash = cidr.indexOf('/');
    if (slash === -1) continue;
    const baseIP = cidr.slice(0, slash);
    const prefix = Number(cidr.slice(slash + 1));
    if (prefix < 0 || prefix > 32 || !Number.isInteger(prefix)) continue;
    const baseNum = ipv4ToNum(baseIP);
    if (Number.isNaN(baseNum)) continue;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if ((ipNum & mask) === (baseNum & mask)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// BotLinkAuthManager
// ---------------------------------------------------------------------------

/** Hard cap on manually-banned CIDR ranges to prevent connection-path DoS. */
const MAX_CIDR_BANS = 500;

/** Hard cap on the per-IP auth failure tracker. Defends against a distributed
 *  scanner briefly spiking the map between sweep runs (every 300s). At 200
 *  conns/s worst case, one sweep window is ~60k attempts, but steady state
 *  post-sweep is bounded by actual live tracker lifetimes. Oldest entries
 *  are evicted first — they haven't been touched by `noteFailure` recently
 *  so they are the safest to drop. */
const MAX_AUTH_TRACKERS = 10_000;

/**
 * Owns authentication state for the bot-link hub: password hash, per-IP
 * failure tracker with exponential ban backoff, pending-handshake counting,
 * manual CIDR bans, and the persisted link-ban store.
 *
 * The hub holds a single instance and asks it three questions on each
 * incoming connection:
 *
 *   1. `admit(ip)` — is this IP allowed to start a handshake?
 *   2. `verifyPassword(sent)` — does the HELLO password match?
 *   3. On success, `noteSuccess(ip)`; on failure, `noteFailure(ip)`.
 *
 * Everything else (manual bans, sweeps, listing) is admin-facing.
 */
export class BotLinkAuthManager {
  private readonly config: BotlinkConfig;
  private readonly logger: Logger | null;
  private readonly eventBus: BotEventBus | null;
  private readonly db: BotDatabase | null;
  private readonly expectedHash: string;
  private readonly authTracker: Map<string, AuthTracker> = new Map();
  private readonly pendingHandshakes: Map<string, number> = new Map();
  private readonly manualCidrBans: Map<string, LinkBan> = new Map();
  private readonly linkBanStore: AdminListStore<LinkBan> | null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: BotlinkConfig,
    logger: Logger | null,
    eventBus: BotEventBus | null,
    db: BotDatabase | null,
  ) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.db = db;
    this.expectedHash = hashPassword(config.password);
    this.linkBanStore = db
      ? new AdminListStore<LinkBan>(db, {
          namespace: '_linkbans',
          keyFn: (ban) => ban.ip,
        })
      : null;
    this.loadPersistedBans();

    this.sweepTimer = setInterval(() => this.sweepStaleTrackers(), 300_000);
    this.sweepTimer.unref(); // Don't keep the process alive
  }

  // -------------------------------------------------------------------------
  // Admission — called before any protocol setup
  // -------------------------------------------------------------------------

  /** True if this IP is in the CIDR whitelist from config. */
  isWhitelisted(ip: string): boolean {
    if (ip === 'unknown') return false;
    const whitelist = this.config.auth_ip_whitelist ?? [];
    return isWhitelisted(ip, whitelist);
  }

  /**
   * Decide whether a new connection from `ip` may start a handshake at all.
   * On allow, side-effect: increments the pending-handshake counter — the
   * caller must call `releasePending(ip)` once the handshake completes or fails.
   */
  admit(ip: string): AdmissionResult {
    this.sweepStaleTrackers();

    const whitelisted = this.isWhitelisted(ip);
    if (ip === 'unknown') {
      // No IP available — allow through without tracking.
      return { allowed: true, whitelisted: false };
    }

    if (!whitelisted) {
      // Ban check — immediately reject banned IPs before any protocol setup
      const tracker = this.authTracker.get(ip);
      if (tracker && tracker.bannedUntil > Date.now()) {
        return { allowed: false, reason: 'banned' };
      }
      // Check CIDR manual bans (small admin-managed list, linear scan is fine)
      const normalizedIP = normalizeIP(ip);
      for (const cidrBan of this.manualCidrBans.values()) {
        if (cidrBan.bannedUntil !== 0 && cidrBan.bannedUntil <= Date.now()) continue;
        if (isWhitelisted(normalizedIP, [cidrBan.ip])) {
          return { allowed: false, reason: 'cidr-banned' };
        }
      }

      // Per-IP pending handshake limit
      const maxPending = this.config.max_pending_handshakes ?? 3;
      const pending = this.pendingHandshakes.get(ip) ?? 0;
      if (pending >= maxPending) {
        return { allowed: false, reason: 'pending-limit' };
      }
      this.pendingHandshakes.set(ip, pending + 1);
    }

    return { allowed: true, whitelisted };
  }

  /** Release the pending-handshake slot taken by `admit()`. */
  releasePending(ip: string, whitelisted: boolean): void {
    if (whitelisted || ip === 'unknown') return;
    const cur = this.pendingHandshakes.get(ip) ?? 0;
    if (cur <= 1) this.pendingHandshakes.delete(ip);
    else this.pendingHandshakes.set(ip, cur - 1);
  }

  // -------------------------------------------------------------------------
  // Password verification
  // -------------------------------------------------------------------------

  /** Compare the HELLO password against the expected hash. */
  verifyPassword(sent: string): boolean {
    // TODO (security audit WARNING): switch to crypto.timingSafeEqual.
    return sent === this.expectedHash;
  }

  // -------------------------------------------------------------------------
  // Failure tracking and ban escalation
  // -------------------------------------------------------------------------

  /** Record an authentication failure for this IP. May escalate to a ban. */
  noteFailure(ip: string, whitelisted: boolean): void {
    if (whitelisted || ip === 'unknown') return;

    const maxFailures = this.config.max_auth_failures ?? 5;
    const windowMs = this.config.auth_window_ms ?? 60_000;
    const baseBanMs = this.config.auth_ban_duration_ms ?? 300_000;
    const MAX_BAN_MS = 86_400_000; // 24h cap to prevent overflow

    const now = Date.now();
    let tracker = this.authTracker.get(ip);
    if (!tracker) {
      // Evict oldest entries first when the hard cap is hit. JS Maps keep
      // insertion order, so `keys().next()` gives the oldest entry — and we
      // touch-update entries on every hit (delete + set) to promote them
      // to "most recently touched", making this true LRU.
      while (this.authTracker.size >= MAX_AUTH_TRACKERS) {
        const oldest = this.authTracker.keys().next().value;
        if (oldest === undefined) break;
        this.authTracker.delete(oldest);
      }
      tracker = { failures: 0, firstFailure: now, bannedUntil: 0, banCount: 0 };
      this.authTracker.set(ip, tracker);
    } else {
      // Promote to most-recently-touched in the insertion-order map.
      this.authTracker.delete(ip);
      this.authTracker.set(ip, tracker);
    }

    // Reset failure window if expired (but never reset banCount)
    if (now - tracker.firstFailure > windowMs) {
      tracker.failures = 0;
      tracker.firstFailure = now;
    }

    tracker.failures++;

    if (tracker.failures >= maxFailures) {
      const banDuration = Math.min(baseBanMs * 2 ** tracker.banCount, MAX_BAN_MS);
      tracker.bannedUntil = now + banDuration;
      tracker.banCount++;
      tracker.failures = 0;
      this.logger?.warn(`IP ${ip} banned for ${banDuration}ms after ${maxFailures} auth failures`);
      this.eventBus?.emit('auth:ban', ip, maxFailures, banDuration);
    }
  }

  /** Record a successful auth — clears the failure count but preserves banCount for escalation. */
  noteSuccess(ip: string, whitelisted: boolean): void {
    if (whitelisted || ip === 'unknown') return;
    const tracker = this.authTracker.get(ip);
    if (tracker) {
      tracker.failures = 0;
    }
  }

  /** Clean up the periodic sweep timer. Caller (BotLinkHub.close) should invoke this on shutdown. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Prune expired auth tracker entries that are stale.
   *  - Entries with banCount === 0: cleaned up once the failure window expires.
   *  - Entries with banCount > 0: cleaned up 24 hours after the ban expires
   *    to prevent unbounded growth from distributed scanners.
   */
  private sweepStaleTrackers(): void {
    const now = Date.now();
    const windowMs = this.config.auth_window_ms ?? 60_000;
    const ESCALATED_STALE_MS = 86_400_000; // 24 hours
    for (const [ip, tracker] of this.authTracker) {
      const banExpired = tracker.bannedUntil < now;
      const failureWindowExpired = now - tracker.firstFailure > windowMs;
      if (banExpired && failureWindowExpired) {
        if (tracker.banCount === 0) {
          this.authTracker.delete(ip);
        } else if (now - tracker.bannedUntil > ESCALATED_STALE_MS) {
          this.authTracker.delete(ip);
        }
      }
    }

    // Sweep expired CIDR manual bans
    for (const [ip, ban] of this.manualCidrBans) {
      if (ban.bannedUntil !== 0 && ban.bannedUntil <= now) {
        this.manualCidrBans.delete(ip);
        this.linkBanStore?.del(ip);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Manual ban management (admin interface)
  // -------------------------------------------------------------------------

  /** Get all active auth bans (auto from authTracker + manual from DB). */
  getAuthBans(): AuthBanEntry[] {
    const now = Date.now();
    const result: AuthBanEntry[] = [];

    // Auto bans from authTracker
    for (const [ip, tracker] of this.authTracker) {
      if (tracker.bannedUntil > now) {
        // Normalize MAX_SAFE_INTEGER sentinel (permanent manual ban) to 0 in output
        const bannedUntil =
          tracker.bannedUntil === Number.MAX_SAFE_INTEGER ? 0 : tracker.bannedUntil;
        result.push({ ip, bannedUntil, banCount: tracker.banCount, manual: false });
      }
    }

    // Manual bans from DB (may overlap with authTracker entries)
    if (this.linkBanStore) {
      for (const ban of this.linkBanStore.list()) {
        // Skip expired manual bans
        if (ban.bannedUntil !== 0 && ban.bannedUntil <= now) continue;
        // Check if already listed from authTracker
        const existing = result.find((r) => r.ip === ban.ip);
        if (existing) {
          existing.manual = true;
        } else {
          result.push({ ip: ban.ip, bannedUntil: ban.bannedUntil, banCount: 0, manual: true });
        }
      }
    }

    return result;
  }

  /** Manually ban an IP or CIDR range. Persists to DB and loads into hot path. */
  manualBan(ip: string, durationMs: number, reason: string, setBy: string): void {
    const now = Date.now();
    const bannedUntil = durationMs === 0 ? 0 : now + durationMs;
    const ban: LinkBan = { ip, bannedUntil, reason, setBy, setAt: now };

    // Persist to DB
    this.linkBanStore?.set(ban);

    // Load into hot path
    if (ip.includes('/')) {
      // CIDR range — enforce cap to prevent connection-path DoS
      if (!this.manualCidrBans.has(ip) && this.manualCidrBans.size >= MAX_CIDR_BANS) {
        this.logger?.warn(`CIDR ban limit (${MAX_CIDR_BANS}) reached, rejecting ${ip}`);
        return;
      }
      this.manualCidrBans.set(ip, ban);
    } else {
      // Single IP — set in authTracker for fast Map lookup
      const tracker = this.authTracker.get(ip) ?? {
        failures: 0,
        firstFailure: now,
        bannedUntil: 0,
        banCount: 0,
      };
      // For permanent bans, use a far-future timestamp
      tracker.bannedUntil = bannedUntil === 0 ? Number.MAX_SAFE_INTEGER : bannedUntil;
      this.authTracker.set(ip, tracker);
    }

    this.recordModAction('botlink-ban', ip, setBy, reason);
    this.eventBus?.emit('auth:ban', ip, 0, durationMs);
  }

  /** Remove a ban (auto or manual) for an IP or CIDR. */
  unban(ip: string, by: string): void {
    // Remove from authTracker (single IPs)
    this.authTracker.delete(ip);
    // Remove from CIDR map
    this.manualCidrBans.delete(ip);
    // Remove from DB
    this.linkBanStore?.del(ip);

    this.recordModAction('botlink-unban', ip, by, null);
    this.eventBus?.emit('auth:unban', ip);
  }

  /**
   * Write a mod_log row for a manual ban action. Wrapped so a DB error
   * never prevents the ban/unban from taking effect in memory.
   */
  private recordModAction(action: string, target: string, by: string, detail: string | null): void {
    try {
      this.db?.logModAction(action, null, target, by, detail);
    } catch (err) {
      this.logger?.warn(`Failed to record mod_log entry for ${action}:`, err);
    }
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
        const tracker = this.authTracker.get(ban.ip) ?? {
          failures: 0,
          firstFailure: ban.setAt,
          bannedUntil: 0,
          banCount: 0,
        };
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
