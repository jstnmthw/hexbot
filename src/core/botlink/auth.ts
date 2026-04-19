// HexBot — Bot link admission gate
//
// The public face of bot-link authentication: admission checks,
// password verification, failure/success tracking, and the operator
// ban/unban interface. Escalation math lives in `./auth-escalation`;
// LRU / CIDR / DB storage lives in `./auth-store`. This file stays
// focused on "should this IP be allowed through, and what do we do
// after the handshake result is known?". See 2026-04-19 quality audit.
import { timingSafeEqual } from 'node:crypto';

import type { BotDatabase } from '../../database';
import type { BotEventBus } from '../../event-bus';
import type { LoggerLike } from '../../logger';
import type { BotlinkConfig } from '../../types';
import { tryLogModAction } from '../audit';
import { applyBanCountDecay, escalateBan, rollFailureWindowIfExpired } from './auth-escalation';
import type { AuthTracker } from './auth-escalation';
import { type AuthBanEntry, BotLinkAuthStore, type LinkBan } from './auth-store';
import type { LRUMap } from './lru-map';
import { hashPassword } from './protocol';

// Re-export the storage-shape types so external consumers keep importing
// them from `./auth` (the module's public surface hasn't changed).
export type { AuthBanEntry, LinkBan } from './auth-store';

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

/** Outcome of the "can this IP even start a handshake" gate. */
export type AdmissionResult =
  | { allowed: true; whitelisted: boolean }
  | { allowed: false; reason: 'banned' | 'cidr-banned' | 'pending-limit' | 'unknown-ip' };

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
  private readonly logger: LoggerLike | null;
  private readonly eventBus: BotEventBus | null;
  private readonly db: BotDatabase | null;
  private readonly expectedHash: string;
  private readonly store: BotLinkAuthStore;
  private readonly pendingHandshakes: Map<string, number> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Per-IP auth-failure state with an explicit LRU contract: every `set`
   * promotes the key and evicts the oldest entry if the map is full.
   * Exposed so tests and `getAuthBans` can read / seed entries; production
   * code mutates via the helper methods below.
   */
  get authTracker(): LRUMap<string, AuthTracker> {
    return this.store.authTracker;
  }

  /**
   * Manually-banned CIDR ranges, keyed by normalized CIDR string.
   * Exposed so tests can seed entries directly for sweep / limit tests.
   */
  get manualCidrBans(): Map<string, LinkBan> {
    return this.store.manualCidrBans;
  }

  constructor(
    config: BotlinkConfig,
    logger: LoggerLike | null,
    eventBus: BotEventBus | null,
    db: BotDatabase | null,
  ) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.db = db;
    this.expectedHash = hashPassword(config.password);
    this.store = new BotLinkAuthStore(db, logger);

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
      const tracker = this.store.authTracker.get(ip);
      if (tracker && tracker.bannedUntil > Date.now()) {
        return { allowed: false, reason: 'banned' };
      }
      // Check CIDR manual bans (small admin-managed list, linear scan is fine)
      const normalizedIP = normalizeIP(ip);
      for (const cidrBan of this.store.manualCidrBans.values()) {
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

  /**
   * Compare the HELLO password against the expected hash. Length check
   * first — `timingSafeEqual` throws on mismatched buffer lengths, and the
   * caller is an attacker-controlled wire frame so unequal-length inputs
   * must be handled without leaking length information via an exception.
   */
  verifyPassword(sent: string): boolean {
    const sentBuf = Buffer.from(sent, 'utf8');
    const expectedBuf = Buffer.from(this.expectedHash, 'utf8');
    if (sentBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(sentBuf, expectedBuf);
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
    const tracker = this.store.getOrCreateTracker(ip, now);
    // LRUMap.set promotes existing keys to most-recently-used and evicts
    // the oldest when a new key would push the map past its cap.
    this.store.authTracker.set(ip, tracker);

    applyBanCountDecay(tracker, now);
    rollFailureWindowIfExpired(tracker, now, windowMs);

    tracker.failures++;
    tracker.lastFailure = now;

    if (tracker.failures >= maxFailures) {
      const banDuration = escalateBan(tracker, now, baseBanMs, MAX_BAN_MS);
      this.logger?.warn(`IP ${ip} banned for ${banDuration}ms after ${maxFailures} auth failures`);
      this.eventBus?.emit('auth:ban', ip, maxFailures, banDuration);
      // Distinct action from the manual `botlink-ban` so an operator can
      // grep auto-escalation events separately. Carries the failure count
      // and the escalation tier (banCount) so a brute-force review can
      // see how aggressive the attacker has been.
      tryLogModAction(
        this.db,
        {
          action: 'botlink-autoban',
          source: 'botlink',
          target: ip,
          outcome: 'failure',
          reason: `${maxFailures} auth failures`,
          metadata: { banDurationMs: banDuration, escalationTier: tracker.banCount },
        },
        this.logger,
      );
    }
  }

  /**
   * Record a successful auth — clears the failure count and decays
   * `banCount` by one step. Legitimate users who finally auth
   * correctly shouldn't carry the escalation weight of every previous
   * typo. The tracker entry stays so repeat offenders returning
   * hours later still land on an escalated tier. See stability audit
   * 2026-04-14.
   */
  noteSuccess(ip: string, whitelisted: boolean): void {
    if (whitelisted || ip === 'unknown') return;
    const tracker = this.store.authTracker.get(ip);
    if (tracker) {
      tracker.failures = 0;
      if (tracker.banCount > 0) tracker.banCount--;
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
    // Keep ban escalation state for 24h past expiry so a repeat offender
    // returning the next morning still lands on their escalated banCount
    // rather than starting fresh. Intentionally not in config — this is the
    // escalation memory horizon, a property of the ban algorithm, not per
    // deployment tuning.
    const ESCALATED_STALE_MS = 86_400_000;
    for (const [ip, tracker] of this.store.authTracker) {
      const banExpired = tracker.bannedUntil < now;
      const failureWindowExpired = now - tracker.firstFailure > windowMs;
      if (banExpired && failureWindowExpired) {
        if (tracker.banCount === 0) {
          this.store.authTracker.delete(ip);
        } else if (now - tracker.bannedUntil > ESCALATED_STALE_MS) {
          this.store.authTracker.delete(ip);
        }
      }
    }

    // Sweep expired CIDR manual bans
    for (const [ip, ban] of this.store.manualCidrBans) {
      if (ban.bannedUntil !== 0 && ban.bannedUntil <= now) {
        this.store.dropExpiredCidrBan(ip);
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
    for (const [ip, tracker] of this.store.authTracker) {
      if (tracker.bannedUntil > now) {
        // Normalize MAX_SAFE_INTEGER sentinel (permanent manual ban) to 0 in output
        const bannedUntil =
          tracker.bannedUntil === Number.MAX_SAFE_INTEGER ? 0 : tracker.bannedUntil;
        result.push({ ip, bannedUntil, banCount: tracker.banCount, manual: false });
      }
    }

    // Manual bans from DB (may overlap with authTracker entries)
    for (const ban of this.store.listPersistedBans()) {
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

    return result;
  }

  /** Manually ban an IP or CIDR range. Persists to DB and loads into hot path. */
  manualBan(ip: string, durationMs: number, reason: string, setBy: string): void {
    const now = Date.now();
    const bannedUntil = durationMs === 0 ? 0 : now + durationMs;
    const ban: LinkBan = { ip, bannedUntil, reason, setBy, setAt: now };

    const stored = this.store.addManualBan(ban);
    if (!stored) return; // CIDR cap hit — warning already logged by store

    this.store.recordModAction('botlink-ban', ip, setBy, reason);
    this.eventBus?.emit('auth:ban', ip, 0, durationMs);
  }

  /** Remove a ban (auto or manual) for an IP or CIDR. */
  unban(ip: string, by: string): void {
    this.store.removeBan(ip);
    this.store.recordModAction('botlink-unban', ip, by, null);
    this.eventBus?.emit('auth:unban', ip);
  }
}
