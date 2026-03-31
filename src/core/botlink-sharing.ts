// HexBot — Channel-specific sharing for bot-link
// Tracks shared ban/exempt lists and produces/applies sync frames.
import type { LinkFrame } from './botlink';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BanEntry {
  mask: string;
  setBy: string;
  setAt: number;
}

// ---------------------------------------------------------------------------
// SharedBanList — in-memory ban/exempt tracking for shared channels
// ---------------------------------------------------------------------------

export class SharedBanList {
  private bans: Map<string, BanEntry[]> = new Map();
  private exempts: Map<string, BanEntry[]> = new Map();

  // -----------------------------------------------------------------------
  // Bans
  // -----------------------------------------------------------------------

  getBans(channel: string): BanEntry[] {
    return this.bans.get(channel.toLowerCase()) ?? [];
  }

  addBan(channel: string, mask: string, setBy: string, setAt: number): void {
    const lower = channel.toLowerCase();
    if (!this.bans.has(lower)) this.bans.set(lower, []);
    const list = this.bans.get(lower)!;
    if (!list.some((b) => b.mask === mask)) {
      list.push({ mask, setBy, setAt });
    }
  }

  removeBan(channel: string, mask: string): void {
    const lower = channel.toLowerCase();
    const list = this.bans.get(lower);
    if (!list) return;
    const idx = list.findIndex((b) => b.mask === mask);
    if (idx !== -1) list.splice(idx, 1);
  }

  syncBans(channel: string, bans: BanEntry[]): void {
    this.bans.set(channel.toLowerCase(), [...bans]);
  }

  // -----------------------------------------------------------------------
  // Exempts
  // -----------------------------------------------------------------------

  getExempts(channel: string): BanEntry[] {
    return this.exempts.get(channel.toLowerCase()) ?? [];
  }

  addExempt(channel: string, mask: string, setBy: string, setAt: number): void {
    const lower = channel.toLowerCase();
    if (!this.exempts.has(lower)) this.exempts.set(lower, []);
    const list = this.exempts.get(lower)!;
    if (!list.some((b) => b.mask === mask)) {
      list.push({ mask, setBy, setAt });
    }
  }

  removeExempt(channel: string, mask: string): void {
    const lower = channel.toLowerCase();
    const list = this.exempts.get(lower);
    if (!list) return;
    const idx = list.findIndex((b) => b.mask === mask);
    if (idx !== -1) list.splice(idx, 1);
  }

  syncExempts(channel: string, exempts: BanEntry[]): void {
    this.exempts.set(channel.toLowerCase(), [...exempts]);
  }

  /** Get all channels that have ban or exempt entries. */
  getChannels(): string[] {
    const channels = new Set<string>();
    for (const ch of this.bans.keys()) channels.add(ch);
    for (const ch of this.exempts.keys()) channels.add(ch);
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
        const bans = Array.isArray(frame.bans) ? (frame.bans as BanEntry[]) : [];
        banList.syncBans(channel, bans);
        return null;
      }

      case 'CHAN_BAN_ADD': {
        const mask = String(frame.mask ?? '');
        banList.addBan(channel, mask, String(frame.setBy ?? ''), Number(frame.setAt ?? 0));
        if (frame.enforce) {
          return { action: 'enforce_ban', channel, mask };
        }
        return null;
      }

      case 'CHAN_BAN_DEL': {
        banList.removeBan(channel, String(frame.mask ?? ''));
        return null;
      }

      case 'CHAN_EXEMPT_SYNC': {
        const exempts = Array.isArray(frame.exempts) ? (frame.exempts as BanEntry[]) : [];
        banList.syncExempts(channel, exempts);
        return null;
      }

      case 'CHAN_EXEMPT_ADD': {
        banList.addExempt(
          channel,
          String(frame.mask ?? ''),
          String(frame.setBy ?? ''),
          Number(frame.setAt ?? 0),
        );
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
