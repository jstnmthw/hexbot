// HexBot — Channel-specific sharing for bot-link
// Tracks shared ban/exempt lists and produces/applies sync frames.
import type { LoggerLike } from '../../logger.js';
import type { LinkFrame } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BanEntry {
  mask: string;
  setBy: string;
  setAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a mask looks like a ban mask (contains `!` and `@`) and is
 * not literally `*!*@*` — that single mask, applied via a shared ban list
 * sync, would kick every user on the channel via the enforcement loop.
 * Other broad-but-not-universal masks are still allowed; defense in depth
 * relies on the trust model plus the cap in {@link MAX_MASKS_PER_CHANNEL}.
 */
function isValidMask(mask: string): boolean {
  return mask.includes('!') && mask.includes('@') && mask !== '*!*@*';
}

/** Runtime type guard: is `value` a well-formed {@link BanEntry}? */
function isBanEntry(value: unknown): value is BanEntry {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.mask === 'string' && typeof rec.setBy === 'string' && typeof rec.setAt === 'number'
  );
}

/**
 * Hard cap on masks tracked per channel. A compromised or hostile peer
 * could otherwise inject arbitrarily many masks via `syncBans` / `syncExempts`
 * — defense in depth, trusted-peer model is our first line.
 */
const MAX_MASKS_PER_CHANNEL = 256;

/**
 * Hard cap on the number of distinct channels tracked in a MaskList.
 * Prevents a hostile peer from sending sync frames for unbounded
 * distinct channel names (each carrying a mask list up to
 * {@link MAX_MASKS_PER_CHANNEL}). 1024 is far above realistic shared
 * channel counts on any single network while keeping worst-case memory
 * bounded at ~1024 × 256 mask entries per list.
 */
const MAX_CHANNELS_PER_LIST = 1024;

/** Per-channel mask list (bans or exempts). */
class MaskList {
  private entries: Map<string, BanEntry[]> = new Map();
  private readonly logger: LoggerLike | null;

  constructor(logger: LoggerLike | null = null) {
    this.logger = logger;
  }

  get(channel: string): BanEntry[] {
    return this.entries.get(channel.toLowerCase()) ?? [];
  }

  add(channel: string, mask: string, setBy: string, setAt: number): void {
    const lower = channel.toLowerCase();
    if (!this.entries.has(lower)) {
      if (this.entries.size >= MAX_CHANNELS_PER_LIST) {
        this.logger?.warn(
          `dropping mask for ${lower}: channel list at cap (${MAX_CHANNELS_PER_LIST} channels)`,
        );
        return;
      }
      this.entries.set(lower, []);
    }
    const list = this.entries.get(lower)!;
    if (list.some((b) => b.mask === mask)) return;
    if (list.length >= MAX_MASKS_PER_CHANNEL) {
      this.logger?.warn(
        `dropping mask for ${lower}: channel list at cap (${MAX_MASKS_PER_CHANNEL})`,
      );
      return;
    }
    list.push({ mask, setBy, setAt });
  }

  remove(channel: string, mask: string): void {
    const lower = channel.toLowerCase();
    const list = this.entries.get(lower);
    if (!list) return;
    const idx = list.findIndex((b) => b.mask === mask);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (list.length === 0) this.entries.delete(lower);
    }
  }

  sync(channel: string, entries: BanEntry[]): void {
    const lower = channel.toLowerCase();
    if (!this.entries.has(lower) && this.entries.size >= MAX_CHANNELS_PER_LIST) {
      this.logger?.warn(
        `dropping sync for ${lower}: channel list at cap (${MAX_CHANNELS_PER_LIST} channels)`,
      );
      return;
    }
    if (entries.length > MAX_MASKS_PER_CHANNEL) {
      this.logger?.warn(
        `truncating sync for ${lower}: ${entries.length} masks exceeds cap (${MAX_MASKS_PER_CHANNEL})`,
      );
      this.entries.set(lower, entries.slice(0, MAX_MASKS_PER_CHANNEL));
      return;
    }
    this.entries.set(lower, [...entries]);
  }

  channels(): IterableIterator<string> {
    return this.entries.keys();
  }
}

// ---------------------------------------------------------------------------
// SharedBanList — in-memory ban/exempt tracking for shared channels
// ---------------------------------------------------------------------------

export class SharedBanList {
  private bans: MaskList;
  private exempts: MaskList;

  constructor(logger: LoggerLike | null = null) {
    const child = logger?.child('botlink-sharing') ?? null;
    this.bans = new MaskList(child);
    this.exempts = new MaskList(child);
  }

  getBans(channel: string): BanEntry[] {
    return this.bans.get(channel);
  }
  addBan(channel: string, mask: string, setBy: string, setAt: number): void {
    this.bans.add(channel, mask, setBy, setAt);
  }
  removeBan(channel: string, mask: string): void {
    this.bans.remove(channel, mask);
  }
  syncBans(channel: string, bans: BanEntry[]): void {
    this.bans.sync(channel, bans);
  }

  getExempts(channel: string): BanEntry[] {
    return this.exempts.get(channel);
  }
  addExempt(channel: string, mask: string, setBy: string, setAt: number): void {
    this.exempts.add(channel, mask, setBy, setAt);
  }
  removeExempt(channel: string, mask: string): void {
    this.exempts.remove(channel, mask);
  }
  syncExempts(channel: string, exempts: BanEntry[]): void {
    this.exempts.sync(channel, exempts);
  }

  /** Get all channels that have ban or exempt entries. */
  getChannels(): string[] {
    const channels = new Set<string>();
    for (const ch of this.bans.channels()) channels.add(ch);
    for (const ch of this.exempts.channels()) channels.add(ch);
    return Array.from(channels);
  }
}

// ---------------------------------------------------------------------------
// BanListSyncer — build/apply ban sharing frames
// ---------------------------------------------------------------------------

export class BanListSyncer {
  /**
   * Build CHAN_BAN_SYNC and CHAN_EXEMPT_SYNC frames for all shared channels.
   * @param banList The shared ban list
   * @param isShared Callback to check if a channel has shared: true
   */
  static buildSyncFrames(
    banList: SharedBanList,
    isShared: (channel: string) => boolean,
  ): LinkFrame[] {
    const frames: LinkFrame[] = [];
    for (const channel of banList.getChannels()) {
      if (!isShared(channel)) continue;
      const bans = banList.getBans(channel);
      if (bans.length > 0) {
        frames.push({ type: 'CHAN_BAN_SYNC', channel, bans });
      }
      const exempts = banList.getExempts(channel);
      if (exempts.length > 0) {
        frames.push({ type: 'CHAN_EXEMPT_SYNC', channel, exempts });
      }
    }
    return frames;
  }

  /**
   * Apply an incoming ban/exempt sharing frame to the local ban list.
   * Returns an action descriptor if enforcement is needed, or null.
   */
  static applyFrame(
    frame: LinkFrame,
    banList: SharedBanList,
    isShared: (channel: string) => boolean,
  ): { action: 'enforce_ban'; channel: string; mask: string } | null {
    const channel = String(frame.channel ?? '');
    if (!channel || !isShared(channel)) return null;

    switch (frame.type) {
      case 'CHAN_BAN_SYNC': {
        const bans = Array.isArray(frame.bans) ? frame.bans.filter(isBanEntry) : [];
        banList.syncBans(
          channel,
          bans.filter((b) => isValidMask(b.mask)),
        );
        return null;
      }

      case 'CHAN_BAN_ADD': {
        const mask = String(frame.mask ?? '');
        if (!isValidMask(mask)) return null;
        banList.addBan(channel, mask, String(frame.setBy ?? ''), Number(frame.setAt ?? 0));
        if (frame.enforce) {
          // The consumer of `enforce_ban` is responsible for capping how
          // many nicks it sweeps in one pass — a `*!*@*` mask combined
          // with `enforce:true` from a peer would otherwise let one
          // shared frame kick every user on the channel. Document the
          // contract here so the cap survives any future refactor.
          return { action: 'enforce_ban', channel, mask };
        }
        return null;
      }

      case 'CHAN_BAN_DEL': {
        banList.removeBan(channel, String(frame.mask ?? ''));
        return null;
      }

      case 'CHAN_EXEMPT_SYNC': {
        const exempts = Array.isArray(frame.exempts) ? frame.exempts.filter(isBanEntry) : [];
        banList.syncExempts(
          channel,
          exempts.filter((e) => isValidMask(e.mask)),
        );
        return null;
      }

      case 'CHAN_EXEMPT_ADD': {
        const mask = String(frame.mask ?? '');
        if (!isValidMask(mask)) return null;
        banList.addExempt(channel, mask, String(frame.setBy ?? ''), Number(frame.setAt ?? 0));
        return null;
      }

      case 'CHAN_EXEMPT_DEL': {
        banList.removeExempt(channel, String(frame.mask ?? ''));
        return null;
      }

      default:
        return null;
    }
  }
}
