// flood — action executor + offence tracking + timed ban persistence
//
// Owns the "given a flood hit, what do we do" path: offence counter, tempban
// storage keyed off the plugin KV namespace, and the kick/ban primitives
// themselves. Offence state lives behind this module so it can be reset on
// reload via `clear()` — index.ts no longer touches the map directly.
import type { PluginAPI } from '../../src/types';

interface OffenceEntry {
  count: number;
  lastSeen: number;
}

interface BanRecord {
  mask: string;
  channel: string;
  ts: number;
  expires: number;
}

export interface EnforcementConfig {
  /**
   * Escalation ladder by offence count. Index 0 = first offence, last entry
   * applied for every subsequent offence. Supported values: `'warn'`,
   * `'kick'`, `'tempban'`.
   */
  actions: string[];
  /** Offence-counter rolling window. Entries older than this are pruned. */
  offenceWindowMs: number;
  /** Duration of a tempban in minutes; 0 means "permanent until operator lifts". */
  banDurationMinutes: number;
}

// Hard cap on distinct keys in the offence tracker. Acts as a belt-and-braces
// defence against nick-rotation botnets: even after C2's hostmask rekey, a
// spoof-ident attacker can still produce thousands of unique hostmasks per
// minute. When the tracker is about to grow past this, oldest-insertion-first
// entries get evicted. See audit finding C2 (2026-04-14).
const MAX_OFFENCE_ENTRIES = 2000;

/**
 * Per-channel enforcement action cap. A burst of 100+ kicks in ~1s
 * would otherwise hit the server rate limit and risk a collateral
 * K-line. Anything past this cap within the rolling window is
 * dropped with a warn log. See stability audit 2026-04-14.
 */
const MAX_ACTIONS_PER_CHANNEL_WINDOW = 10;
/** Rolling window over which {@link MAX_ACTIONS_PER_CHANNEL_WINDOW} applies. */
const CHANNEL_WINDOW_MS = 5_000;

/**
 * Given a flood hit, decide what action to take (warn/kick/tempban), run it,
 * and persist tempbans so they survive reloads. Also owns the per-channel
 * action-rate cap and the timed-ban lift sweep.
 */
export class EnforcementExecutor {
  private offenceTracker = new Map<string, OffenceEntry>();
  /**
   * Per-channel action-rate state: `{ windowStart, count }`. A single
   * burst of 100+ kicks would otherwise be dispatched in ~1s and
   * trigger server-side rate-limiting or a collateral K-line for the
   * bot. Cap at `MAX_ACTIONS_PER_CHANNEL_WINDOW` within
   * `CHANNEL_WINDOW_MS`; additional actions are dropped with a log
   * line. See stability audit 2026-04-14.
   */
  private readonly channelActionRate = new Map<string, { windowStart: number; count: number }>();
  /**
   * Fire-and-forget enforcement actions currently awaiting completion.
   * `teardown()` awaits all of them before the plugin unloads so a
   * pending ban/kick can't touch the torn-down api. See audit finding
   * W-FL5 (2026-04-14).
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly api: PluginAPI,
    private readonly cfg: EnforcementConfig,
    private readonly botHasOps: (channel: string) => boolean,
    private readonly logError: (err: unknown) => void,
  ) {}

  /** Reset offence state (called from plugin teardown). */
  clear(): void {
    this.offenceTracker.clear();
    this.channelActionRate.clear();
  }

  /**
   * Consume a per-channel action slot. Returns false if the cap has
   * been hit within the current rolling window; caller must drop the
   * action. See stability audit 2026-04-14.
   */
  private reserveChannelSlot(channel: string): boolean {
    const now = Date.now();
    const key = this.api.ircLower(channel);
    let state = this.channelActionRate.get(key);
    if (!state || now - state.windowStart > CHANNEL_WINDOW_MS) {
      state = { windowStart: now, count: 0 };
      this.channelActionRate.set(key, state);
    }
    if (state.count >= MAX_ACTIONS_PER_CHANNEL_WINDOW) {
      return false;
    }
    state.count++;
    return true;
  }

  /** Prune offence entries past their window. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.offenceTracker) {
      if (now - entry.lastSeen > this.cfg.offenceWindowMs) {
        this.offenceTracker.delete(key);
      }
    }
  }

  /**
   * Record an offence against `key` and return the escalation action that
   * matches the current count (capped at the last entry in `actions`).
   */
  recordOffence(key: string): string {
    const now = Date.now();
    const entry = this.offenceTracker.get(key);
    if (entry && now - entry.lastSeen < this.cfg.offenceWindowMs) {
      entry.count++;
      entry.lastSeen = now;
      return this.actionFor(entry.count - 1);
    }
    // About to insert a new key (or replace an aged-out one). If that would
    // take us past the hard cap, evict in insertion order until below it.
    if (!entry && this.offenceTracker.size >= MAX_OFFENCE_ENTRIES) {
      const excess = this.offenceTracker.size - MAX_OFFENCE_ENTRIES + 1;
      let evicted = 0;
      for (const oldestKey of this.offenceTracker.keys()) {
        if (evicted >= excess) break;
        this.offenceTracker.delete(oldestKey);
        evicted++;
      }
    }
    this.offenceTracker.set(key, { count: 1, lastSeen: now });
    return this.actionFor(0);
  }

  /** Apply the named action (warn/kick/tempban). Fire-and-forget errors are logged. */
  apply(action: string, channel: string, nick: string, reason: string): void {
    if (!this.botHasOps(channel)) return;
    // Per-channel rate cap. Drop excess actions (don't buffer) — the
    // offence tracker ensures repeat offenders are still escalated
    // on their next flood event, and dropping the tail is safer than
    // queueing 100 kicks that would get us K-lined. See stability
    // audit 2026-04-14.
    if (!this.reserveChannelSlot(channel)) {
      this.api.warn(
        `Flood enforcement rate cap hit on ${channel} — dropping "${action}" for ${nick}`,
      );
      return;
    }
    const p = this.applyInner(action, channel, nick, reason).catch(this.logError);
    this.inFlight.add(p);
    // The `finally` keeps the Set bounded: each promise removes itself on
    // settle so the Set only holds truly-in-flight work at any moment.
    p.finally(() => this.inFlight.delete(p));
  }

  /**
   * Await every in-flight enforcement action to settle. Called from the
   * plugin's async teardown so a still-pending kick or ban doesn't
   * call back into the disposed api. Uses `allSettled` so one failure
   * doesn't short-circuit the drain.
   */
  async drainPending(): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.allSettled(this.inFlight);
  }

  /**
   * Lift any timed bans whose expiry has passed. Called from the periodic
   * sweep bind. Without the grace-period branch, a ban persists forever
   * if the bot permanently loses ops on the channel — the record would
   * grow the `ban:` KV space unboundedly and slow every `db.list('ban:')`
   * scan. See audit finding W-FL6 (2026-04-14).
   */
  liftExpiredBans(): void {
    const now = Date.now();
    const GRACE_MS = 86_400_000; // 24h past expiry → delete regardless of ops
    for (const { key, value } of this.api.db.list('ban:')) {
      let record: BanRecord;
      try {
        const parsed: unknown = JSON.parse(value);
        /* v8 ignore next 4 */
        if (!isBanRecord(parsed)) {
          this.api.db.del(key);
          continue;
        }
        record = parsed;
        /* v8 ignore next 4 */
      } catch {
        this.api.db.del(key);
        continue;
      }
      if (record.expires > 0 && record.expires <= now) {
        if (this.botHasOps(record.channel)) {
          this.api.mode(record.channel, '-b', record.mask);
          this.api.db.del(key);
        } else if (now - record.expires > GRACE_MS) {
          // Bot is without ops past the grace window — drop the record
          // so the KV scan doesn't grow forever. The ban itself stays
          // on the server until a human op lifts it.
          this.api.warn(
            `Flood ban ${record.mask} on ${record.channel} past ${GRACE_MS / 3_600_000}h grace window; dropping record (bot lacks ops)`,
          );
          this.api.db.del(key);
        }
      }
    }
  }

  private actionFor(offenceCount: number): string {
    const { actions } = this.cfg;
    if (actions.length === 0) return 'warn';
    return actions[Math.min(offenceCount, actions.length - 1)];
  }

  private async applyInner(
    action: string,
    channel: string,
    nick: string,
    reason: string,
  ): Promise<void> {
    if (action === 'warn') {
      this.api.notice(nick, `[flood] ${reason}`);
      this.api.log(`Warned ${nick} in ${channel}: ${reason}`);
      this.auditLog('flood-warn', channel, nick, reason);
      return;
    }
    if (action === 'kick') {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      this.api.log(`Kicked ${nick} from ${channel}: ${reason}`);
      this.auditLog('flood-kick', channel, nick, reason);
      return;
    }
    // action is 'tempban' — last valid action after 'warn' and 'kick'
    const hostmask = this.api.getUserHostmask(channel, nick);
    if (!hostmask) {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      this.auditLog('flood-kick', channel, nick, reason);
      return;
    }
    const banMask = buildFloodBanMask(hostmask);
    if (!banMask) {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      this.auditLog('flood-kick', channel, nick, reason);
      return;
    }
    this.api.ban(channel, banMask);
    this.storeBan(channel, banMask);
    this.api.kick(channel, nick, `[flood] ${reason}`);
    this.api.log(`Tempbanned ${nick} (${banMask}) from ${channel}: ${reason}`);
    this.auditLog('flood-ban', channel, nick, reason, banMask);
  }

  /**
   * Emit a mod_log row for the action. Without this, operators can't tell
   * a flood-originated kick/ban from a human-ordered one after the fact —
   * `.modlog` would show only human actions. See audit 2026-04-19.
   */
  private auditLog(
    action: 'flood-warn' | 'flood-kick' | 'flood-ban',
    channel: string,
    nick: string,
    reason: string,
    mask?: string,
  ): void {
    try {
      this.api.audit.log(action, {
        channel,
        target: mask ? `${nick} (${mask})` : nick,
        reason,
      });
    } catch {
      // Audit failures must not break enforcement — swallow silently.
    }
  }

  private storeBan(channel: string, mask: string): void {
    const now = Date.now();
    const minutes = this.cfg.banDurationMinutes;
    const expires = minutes === 0 ? 0 : now + minutes * 60_000;
    const record: BanRecord = { mask, channel: this.api.ircLower(channel), ts: now, expires };
    this.api.db.set(`ban:${this.api.ircLower(channel)}:${mask}`, JSON.stringify(record));
  }
}

/**
 * Character set permitted inside a hostname: alphanumerics, `.`, `-`, `:`
 * (IPv6 colons), and `/` (cloaked/vhost forms like `user/account`).
 * Rejects anything else — whitespace in particular, which an
 * RFC-compliant IRC server won't emit but an upstream bug or
 * non-compliant server could, and which would then be parsed by the
 * server as an extra MODE parameter when interpolated into a ban mask.
 * Bracket-wrapped IPv6 literals are accepted too. See audit 2026-04-19.
 */
const HOST_SHAPE_RE = /^[A-Za-z0-9.\-:/[\]]+$/;

/**
 * Build a simple *!*@host ban mask from a hostmask. For cloaked hosts
 * (containing '/'), the exact cloak is preserved. Returns null if the
 * extracted host fails {@link HOST_SHAPE_RE} — caller falls back to a
 * safe default (kick-only).
 */
function buildFloodBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;
  if (!HOST_SHAPE_RE.test(host)) return null;
  return `*!*@${host}`;
}

function isBanRecord(value: unknown): value is BanRecord {
  /* v8 ignore next -- defensive: JSON.parse on stored bans returns object */
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mask === 'string' &&
    typeof v.channel === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.expires === 'number'
  );
}
