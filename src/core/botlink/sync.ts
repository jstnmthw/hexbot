// HexBot — Bot Link State Synchronization
// Converts ChannelState and Permissions into link frames for sync,
// and applies incoming sync frames to local state.
import { isObjectArray } from '../../utils/irc-event';
import type { ChannelState } from '../channel-state';
import type { Permissions } from '../permissions';
import type { LinkFrame } from './types.js';

// ---------------------------------------------------------------------------
// ChannelStateSyncer
// ---------------------------------------------------------------------------

export class ChannelStateSyncer {
  /** Build CHAN frames for all tracked channels. */
  static buildSyncFrames(channelState: ChannelState): LinkFrame[] {
    const frames: LinkFrame[] = [];
    for (const ch of channelState.getAllChannels()) {
      const users: Array<{
        nick: string;
        ident: string;
        hostname: string;
        modes: string[];
      }> = [];
      for (const u of ch.users.values()) {
        users.push({
          nick: u.nick,
          ident: u.ident,
          hostname: u.hostname,
          modes: [...u.modes],
        });
      }
      frames.push({
        type: 'CHAN',
        channel: ch.name,
        topic: ch.topic,
        modes: ch.modes,
        key: ch.key,
        limit: ch.limit,
        users,
      });
    }
    return frames;
  }

  /** Apply a CHAN sync frame to local channel state. */
  static applyFrame(frame: LinkFrame, channelState: ChannelState): void {
    if (frame.type !== 'CHAN') return;

    channelState.injectChannelSync({
      channel: String(frame.channel ?? ''),
      topic: String(frame.topic ?? ''),
      modes: String(frame.modes ?? ''),
      key: frame.key !== undefined ? String(frame.key) : undefined,
      limit: typeof frame.limit === 'number' ? frame.limit : undefined,
      users: isObjectArray(frame.users)
        ? frame.users.map((u) => ({
            nick: String(u.nick ?? ''),
            ident: String(u.ident ?? ''),
            hostname: String(u.hostname ?? ''),
            modes: Array.isArray(u.modes)
              ? u.modes.filter((m): m is string => typeof m === 'string' && /^[a-zA-Z]$/.test(m))
              : [],
          }))
        : [],
    });
  }
}

// ---------------------------------------------------------------------------
// PermissionSyncer
// ---------------------------------------------------------------------------

export class PermissionSyncer {
  /** Build ADDUSER frames for all users. */
  static buildSyncFrames(permissions: Permissions): LinkFrame[] {
    return permissions.listUsers().map((user) => ({
      type: 'ADDUSER',
      handle: user.handle,
      hostmasks: [...user.hostmasks],
      globalFlags: user.global,
      channelFlags: { ...user.channels },
    }));
  }

  /**
   * Apply a permission sync frame (ADDUSER, DELUSER, SETFLAGS) to local permissions.
   * Safe to call repeatedly — uses upsert semantics.
   */
  static applyFrame(frame: LinkFrame, permissions: Permissions): void {
    switch (frame.type) {
      case 'ADDUSER':
      case 'SETFLAGS': {
        const handle = String(frame.handle ?? '');
        if (!handle) return;
        const hostmasks = Array.isArray(frame.hostmasks)
          ? frame.hostmasks.filter((h): h is string => typeof h === 'string')
          : [];
        const globalFlags = String(frame.globalFlags ?? '');
        const channelFlags: Record<string, string> = {};
        if (frame.channelFlags && typeof frame.channelFlags === 'object') {
          for (const [ch, flags] of Object.entries(frame.channelFlags as Record<string, unknown>)) {
            if (typeof flags === 'string') channelFlags[ch] = flags;
          }
        }
        permissions.syncUser(handle, hostmasks, globalFlags, channelFlags, 'botlink-sync');
        break;
      }

      case 'DELUSER': {
        const handle = String(frame.handle ?? '');
        if (!handle) return;
        if (permissions.getUser(handle)) {
          permissions.removeUser(handle, 'botlink-sync');
        }
        break;
      }
    }
  }
}
