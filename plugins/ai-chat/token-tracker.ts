// Token budget tracker backed by the plugin DB.
// Tracks daily per-user and global token usage under date-keyed DB entries.
import type { PluginDB } from '../../src/types';
import type { TokenUsage } from './providers/types';

/** An extended token record that includes a request counter. */
export interface TokenRecord extends TokenUsage {
  requests: number;
}

/** Limits the tracker enforces. */
export interface TokenBudgetConfig {
  /** Max input+output tokens per user per day. 0 disables the check. */
  perUserDaily: number;
  /** Max input+output tokens across all users per day. 0 disables the check. */
  globalDaily: number;
}

/** Key used for the aggregate (global) daily record. */
export const GLOBAL_KEY = '__global__';

/** How many days of history to keep. Older rows are pruned lazily. */
const RETENTION_DAYS = 30;

/** Lazy daily token tracker — stores rows as `tokens:{YYYY-MM-DD}:{key}`. */
export class TokenTracker {
  private lastCleanupDate: string | null = null;

  constructor(
    private db: PluginDB,
    private config: TokenBudgetConfig,
    private now: () => Date = () => new Date(),
  ) {}

  /** Update the active budget (hot-reload). */
  setConfig(config: TokenBudgetConfig): void {
    this.config = config;
  }

  /** Get today's usage for a nick. */
  getUsage(nick: string): TokenRecord {
    this.cleanupIfNewDay();
    return this.read(this.dateStr(), keyFor(nick));
  }

  /** Get today's global usage. */
  getDailyTotal(): TokenRecord {
    this.cleanupIfNewDay();
    return this.read(this.dateStr(), GLOBAL_KEY);
  }

  /**
   * Check whether `nick` can spend an estimated number of tokens right now.
   * Returns false if either the per-user or global budget would be exceeded.
   */
  canSpend(nick: string, estimatedTokens: number): boolean {
    this.cleanupIfNewDay();
    const date = this.dateStr();

    if (this.config.perUserDaily > 0) {
      const user = this.read(date, keyFor(nick));
      if (user.input + user.output + estimatedTokens > this.config.perUserDaily) return false;
    }

    if (this.config.globalDaily > 0) {
      const global = this.read(date, GLOBAL_KEY);
      if (global.input + global.output + estimatedTokens > this.config.globalDaily) return false;
    }

    return true;
  }

  /** Record actual usage after a completed API call. */
  recordUsage(nick: string, usage: TokenUsage): void {
    this.cleanupIfNewDay();
    const date = this.dateStr();

    const user = this.read(date, keyFor(nick));
    user.input += usage.input;
    user.output += usage.output;
    user.requests += 1;
    this.write(date, keyFor(nick), user);

    const global = this.read(date, GLOBAL_KEY);
    global.input += usage.input;
    global.output += usage.output;
    global.requests += 1;
    this.write(date, GLOBAL_KEY, global);
  }

  /** Wipe today's entry for a nick (admin command). */
  resetUser(nick: string): void {
    this.db.del(`tokens:${this.dateStr()}:${keyFor(nick)}`);
  }

  /**
   * Prune rows older than {@link RETENTION_DAYS} days.
   * Runs at most once per calendar day (keyed on today's date string).
   */
  cleanupIfNewDay(): void {
    const today = this.dateStr();
    if (this.lastCleanupDate === today) return;
    this.lastCleanupDate = today;

    const cutoff = new Date(this.now());
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    const cutoffStr = toDateStr(cutoff);

    for (const row of this.db.list('tokens:')) {
      // key shape: tokens:YYYY-MM-DD:...
      const parts = row.key.split(':');
      if (parts.length < 3) continue;
      const dateStr = parts[1];
      if (dateStr < cutoffStr) this.db.del(row.key);
    }
  }

  private read(date: string, key: string): TokenRecord {
    const raw = this.db.get(`tokens:${date}:${key}`);
    if (!raw) return { input: 0, output: 0, requests: 0 };
    try {
      const parsed = JSON.parse(raw) as Partial<TokenRecord>;
      return {
        input: Number(parsed.input) || 0,
        output: Number(parsed.output) || 0,
        requests: Number(parsed.requests) || 0,
      };
    } catch {
      return { input: 0, output: 0, requests: 0 };
    }
  }

  private write(date: string, key: string, record: TokenRecord): void {
    this.db.set(`tokens:${date}:${key}`, JSON.stringify(record));
  }

  private dateStr(): string {
    return toDateStr(this.now());
  }
}

/** Lowercase a nick (case-insensitive bucketing). */
function keyFor(nick: string): string {
  return nick.toLowerCase();
}

/** Format a Date as YYYY-MM-DD in UTC. */
function toDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
