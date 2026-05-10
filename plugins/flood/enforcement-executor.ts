// flood — action executor + offence tracking + timed ban persistence
//
// Owns the "given a flood hit, what do we do" path: offence counter, tempban
// storage keyed off the plugin KV namespace, and the kick/ban primitives
// themselves. Offence state lives behind this module so it can be reset on
// reload via `clear()` — index.ts no longer touches the map directly.
import type { PluginAPI } from '../../src/types';

/** Tracker entry for one (event-kind, hostmask, channel) tuple. */
interface OffenceEntry {
  /** Number of distinct flood bursts attributed to this key (drives escalation). */
  count: number;
  /** Last hit timestamp, used for same-burst dedup and offence-window pruning. */
  lastSeen: number;
}

/** KV-persisted record for an active flood-tempban; rehydrated across reloads. */
interface BanRecord {
  mask: string;
  channel: string;
  ts: number;
  /** Epoch-ms expiry, or 0 for "permanent until operator lifts". */
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
// defense against nick-rotation botnets: even with hostmask rekeying, a
// spoof-ident attacker can still produce thousands of unique hostmasks per
// minute. When the tracker is about to grow past this, oldest-insertion-first
// entries get evicted.
const MAX_OFFENCE_ENTRIES = 2000;

/**
 * Per-channel enforcement action cap. A burst of 100+ kicks in ~1s
 * would otherwise hit the server rate limit and risk a collateral
 * K-line. Anything past this cap within the rolling window is
 * dropped with a warn log.
 */
const MAX_ACTIONS_PER_CHANNEL_WINDOW = 10;
/** Rolling window over which {@link MAX_ACTIONS_PER_CHANNEL_WINDOW} applies. */
const CHANNEL_WINDOW_MS = 5_000;

/**
 * Hard cap on the number of distinct channel keys tracked in
 * {@link EnforcementExecutor.channelActionRate}. Bounded by joinable
 * channel count in normal operation, but defensive against a runaway
 * grow path (a future regression that called `reserveChannelSlot`
 * without ever joining the channel). When inserting past the cap,
 * the oldest entry by insertion order is evicted.
 */
const MAX_CHANNEL_RATE_KEYS = 1024;

/**
 * Minimum gap between offences that actually advances the escalation
 * ladder. A long response that overflows the rate-limit threshold fires
 * `check()=true` on every trailing message — without dedup, a single
 * burst ticks warn→kick→tempban in the same second. Hits on the same key
 * within this window update `lastSeen` but leave `count` alone, so one
 * flood event = one strike regardless of how many lines it contained.
 *
 * Tuned to 2s: tight enough that a deliberate re-flood after a kick
 * escalates quickly, loose enough that a single chatbot response
 * overflowing across ~1s of stream doesn't multi-count. Anything longer
 * (5s, 10s) leaves too much room for a sustained flood to hide inside
 * "one burst".
 */
const SAME_BURST_MS = 2_000;

/**
 * After a terminal action (kick or tempban) lands on a target, any
 * follow-up kick/tempban for the same (channel, nick) pair inside this
 * window is suppressed. Belt-and-braces for {@link SAME_BURST_MS} in
 * {@link EnforcementExecutor.recordOffence}: if two different rate-limit
 * kinds trip for the same target at nearly the same moment (msg + join,
 * say), the redundant second KICK would otherwise race a +b and give an
 * autorejoining client a window to beat the ban.
 *
 * Pinned equal to {@link SAME_BURST_MS}: any longer and a legitimate
 * burst-to-burst escalation (e.g. kick at T=0, distinct tempban burst
 * at T=2.5) would be suppressed as if the prior terminal action were
 * still in flight.
 */
const TERMINAL_SUPPRESSION_MS = SAME_BURST_MS;

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
   * line.
   */
  private readonly channelActionRate = new Map<string, { windowStart: number; count: number }>();
  /**
   * Last-terminal-action timestamp per `${channel}:${nick}`. Used by
   * {@link apply} to suppress a follow-up kick/tempban for the same
   * target inside {@link TERMINAL_SUPPRESSION_MS}. Cleared on reload
   * (via {@link clear}) and pruned on the periodic sweep.
   */
  private readonly recentTerminal = new Map<string, number>();
  /**
   * Fire-and-forget enforcement actions currently awaiting completion.
   * `teardown()` awaits all of them before the plugin unloads so a
   * pending ban/kick can't touch the torn-down api.
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
    this.recentTerminal.clear();
  }

  /**
   * Drop per-channel state for `channel`. Wired from the bot PART/KICK
   * branch in index.ts so channel-scoped enforcement state doesn't
   * linger after the bot leaves. `channelActionRate` and `recentTerminal`
   * are channel-scoped and dropped immediately; `offenceTracker` keys
   * for `join:` / `part:` / `nick:` are network-wide on the user's
   * hostmask and deliberately left alone here. `msg:` offence keys are
   * channel-scoped but use a different lowercasing helper than
   * `api.ircLower`, so they are left to age out via the periodic sweep
   * to avoid a partial drop.
   */
  dropChannel(channel: string): void {
    const lowered = this.api.ircLower(channel);
    this.channelActionRate.delete(lowered);
    const targetPrefix = `${lowered}:`;
    for (const key of this.recentTerminal.keys()) {
      if (key.startsWith(targetPrefix)) this.recentTerminal.delete(key);
    }
  }

  /**
   * Consume a per-channel action slot. Returns false if the cap has
   * been hit within the current rolling window; caller must drop the
   * action.
   */
  private reserveChannelSlot(channel: string): boolean {
    const now = Date.now();
    const key = this.api.ircLower(channel);
    let state = this.channelActionRate.get(key);
    if (!state || now - state.windowStart > CHANNEL_WINDOW_MS) {
      // Hard cap on distinct keys: evict the oldest by insertion order
      // before inserting a new entry. Bounded by joinable channel count
      // in normal operation; the cap is defense against a future code
      // path that calls reserveChannelSlot without a paired bot-PART.
      if (
        !this.channelActionRate.has(key) &&
        this.channelActionRate.size >= MAX_CHANNEL_RATE_KEYS
      ) {
        const oldest = this.channelActionRate.keys().next().value;
        if (oldest !== undefined) this.channelActionRate.delete(oldest);
      }
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
    for (const [key, ts] of this.recentTerminal) {
      if (now - ts > TERMINAL_SUPPRESSION_MS) {
        this.recentTerminal.delete(key);
      }
    }
  }

  /**
   * Record an offence against `key` and return the escalation action that
   * matches the current count (capped at the last entry in `actions`).
   * Returns `null` when the hit falls inside {@link SAME_BURST_MS} of the
   * last recorded hit — one flood burst is one strike, not one per line.
   * Callers must skip `apply()` on a null return.
   */
  recordOffence(key: string): string | null {
    const now = Date.now();
    const entry = this.offenceTracker.get(key);
    if (entry && now - entry.lastSeen < this.cfg.offenceWindowMs) {
      // Same-burst dedup: update lastSeen (keeps the burst fresh so a
      // continuing flood doesn't age out mid-burst) but leave count alone
      // so the escalation ladder only advances once per distinct burst.
      if (now - entry.lastSeen < SAME_BURST_MS) {
        entry.lastSeen = now;
        return null;
      }
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
    // Terminal-action suppression per (channel, nick): if we already
    // kicked or tempbanned this target inside TERMINAL_SUPPRESSION_MS,
    // drop any follow-up kick/tempban. Prevents a stray second KICK from
    // racing the +b of a tempban (which would let an autorejoining
    // target beat the ban). `warn` is never suppressed — it's harmless
    // and the notice still conveys "you flooded".
    if (action === 'kick' || action === 'tempban') {
      const targetKey = `${this.api.ircLower(channel)}:${this.api.ircLower(nick)}`;
      const last = this.recentTerminal.get(targetKey);
      const now = Date.now();
      if (last !== undefined && now - last < TERMINAL_SUPPRESSION_MS) {
        this.api.log(
          `Flood suppression: dropping duplicate "${action}" for ${nick} in ${channel} (${now - last}ms after prior terminal action)`,
        );
        return;
      }
      this.recentTerminal.set(targetKey, now);
    }
    // Per-channel rate cap. Drop excess actions (don't buffer) — the
    // offence tracker ensures repeat offenders are still escalated
    // on their next flood event, and dropping the tail is safer than
    // queueing 100 kicks that would get us K-lined.
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
   * scan.
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

  /**
   * Map a 0-indexed offence count to its escalation action. Counts past the
   * end of the configured ladder repeat the final entry (typically `tempban`)
   * so a persistent flooder keeps getting the strongest action rather than
   * cycling back to `warn`.
   */
  private actionFor(offenceCount: number): string {
    const { actions } = this.cfg;
    if (actions.length === 0) return 'warn';
    return actions[Math.min(offenceCount, actions.length - 1)];
  }

  /**
   * Execute the chosen action against `nick` in `channel`. Falls back to a
   * plain kick when a tempban can't be built (no hostmask in channel state,
   * or the host fails {@link HOST_SHAPE_RE}) so the user is still removed
   * even if we can't safely persist a ban mask.
   */
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
   * `.modlog` would show only human actions.
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

  /**
   * Persist a tempban record in the plugin KV namespace so {@link liftExpiredBans}
   * can re-pick it up after a plugin reload — without persistence the unban
   * scheduling would be lost on every reload and the ban would stick until a
   * human op intervened.
   */
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
 *
 * Bracket-wrapped IPv6 literals (`[2001:db8::1]`) are stripped in
 * {@link buildFloodBanMask} before this regex runs — the shape must
 * reject bare `[` / `]` so a malformed host doesn't sneak through.
 */
const HOST_SHAPE_RE = /^[A-Za-z0-9.\-:/]+$/;

/**
 * Hard upper bound on the mask length the bot will emit. A pathological
 * long cloak (or a malformed server frame we still accepted before the
 * shape regex rejected it) would otherwise produce a ban mask that
 * exceeds the 512-byte IRC line limit when combined with the `MODE
 * #channel +b` framing, silently dropping the ban on the wire while the
 * record was still persisted.
 */
const MAX_BAN_MASK_LEN = 256;

/**
 * Build a simple *!*@host ban mask from a hostmask. For cloaked hosts
 * (containing '/'), the exact cloak is preserved. IPv6 literals arrive
 * bracket-wrapped (`user@[2001:db8::1]`); the wrapper is stripped before
 * shape validation so the produced mask (`*!*@2001:db8::1`) actually
 * matches future joins from that address — IRC ban-mask matching is
 * character-literal, and the bracketed form would never match. Returns
 * null if the extracted host fails {@link HOST_SHAPE_RE} or the final
 * mask exceeds {@link MAX_BAN_MASK_LEN} — caller falls back to a safe
 * default (kick-only).
 */
function buildFloodBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  let host = hostmask.substring(atIdx + 1);
  if (!host) return null;
  // Strip `[…]` IPv6 literal wrappers. The closing bracket without a
  // matching open (or vice versa) is rejected as malformed.
  if (host.startsWith('[') && host.endsWith(']') && host.length >= 3) {
    host = host.substring(1, host.length - 1);
  }
  if (!HOST_SHAPE_RE.test(host)) return null;
  const mask = `*!*@${host}`;
  if (mask.length > MAX_BAN_MASK_LEN) return null;
  return mask;
}

/** Type guard for a deserialized ban KV row; corrupt rows are deleted by the caller. */
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
