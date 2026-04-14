// HexBot — Channel-specific sharing for bot-link
// Tracks shared ban/exempt lists and produces/applies sync frames.
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

/** Validate that a mask looks like a ban mask (contains ! and @) and is not dangerously broad. */
function isValidMask(mask: string): boolean {
  return mask.includes('!') && mask.includes('@') && mask !== '*!*@*';
}

/** Per-channel mask list (bans or exempts). */
class MaskList {
  private entries: Map<string, BanEntry[]> = new Map();

  get(channel: string): BanEntry[] {
    return this.entries.get(channel.toLowerCase()) ?? [];
  }

  add(channel: string, mask: string, setBy: string, setAt: number): void {
    const lower = channel.toLowerCase();
    if (!this.entries.has(lower)) this.entries.set(lower, []);
    const list = this.entries.get(lower)!;
    if (!list.some((b) => b.mask === mask)) {
      list.push({ mask, setBy, setAt });
    }
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
    this.entries.set(channel.toLowerCase(), [...entries]);
  }

  channels(): IterableIterator<string> {
    return this.entries.keys();
  }
}

// ---------------------------------------------------------------------------
// SharedBanList — in-memory ban/exempt tracking for shared channels
// ---------------------------------------------------------------------------

export class SharedBanList {
  private bans = new MaskList();
  private exempts = new MaskList();

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
        const bans = Array.isArray(frame.bans)
          ? frame.bans.filter(
              (b): b is BanEntry =>
                typeof b === 'object' &&
                b !== null &&
                typeof (b as BanEntry).mask === 'string' &&
                typeof (b as BanEntry).setBy === 'string' &&
                typeof (b as BanEntry).setAt === 'number',
            )
          : [];
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
        const exempts = Array.isArray(frame.exempts)
          ? frame.exempts.filter(
              (e): e is BanEntry =>
                typeof e === 'object' &&
                e !== null &&
                typeof (e as BanEntry).mask === 'string' &&
                typeof (e as BanEntry).setBy === 'string' &&
                typeof (e as BanEntry).setAt === 'number',
            )
          : [];
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
