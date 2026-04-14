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
  actions: string[];
  offenceWindowMs: number;
  banDurationMinutes: number;
}

export class EnforcementExecutor {
  private offenceTracker = new Map<string, OffenceEntry>();

  constructor(
    private readonly api: PluginAPI,
    private readonly cfg: EnforcementConfig,
    private readonly botHasOps: (channel: string) => boolean,
    private readonly logError: (err: unknown) => void,
  ) {}

  /** Reset offence state (called from plugin teardown). */
  clear(): void {
    this.offenceTracker.clear();
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
    this.offenceTracker.set(key, { count: 1, lastSeen: now });
    return this.actionFor(0);
  }

  /** Apply the named action (warn/kick/tempban). Fire-and-forget errors are logged. */
  apply(action: string, channel: string, nick: string, reason: string): void {
    if (!this.botHasOps(channel)) return;
    this.applyInner(action, channel, nick, reason).catch(this.logError);
  }

  /**
   * Lift any timed bans whose expiry has passed. Called from the periodic
   * sweep bind. No-op when the bot doesn't have ops on the recorded channel.
   */
  liftExpiredBans(): void {
    const now = Date.now();
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
      return;
    }
    if (action === 'kick') {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      this.api.log(`Kicked ${nick} from ${channel}: ${reason}`);
      return;
    }
    // action is 'tempban' — last valid action after 'warn' and 'kick'
    const hostmask = this.api.getUserHostmask(channel, nick);
    if (!hostmask) {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    const banMask = buildFloodBanMask(hostmask);
    if (!banMask) {
      this.api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    this.api.ban(channel, banMask);
    this.storeBan(channel, banMask);
    this.api.kick(channel, nick, `[flood] ${reason}`);
    this.api.log(`Tempbanned ${nick} (${banMask}) from ${channel}: ${reason}`);
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
 * Build a simple *!*@host ban mask from a hostmask. For cloaked hosts
 * (containing '/'), the exact cloak is preserved.
 */
function buildFloodBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;
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
