// HexBot — Bot Link State Synchronization
// Converts ChannelState and Permissions into link frames for sync,
// and applies incoming sync frames to local state.
import type { LinkFrame } from './botlink';
import type { ChannelState } from './channel-state';
import type { Permissions } from './permissions';

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
      users: Array.isArray(frame.users)
        ? (frame.users as Array<Record<string, unknown>>).map((u) => ({
            /* v8 ignore start */
            nick: String(u.nick ?? ''),
            ident: String(u.ident ?? ''),
            hostname: String(u.hostname ?? ''),
            modes: Array.isArray(u.modes) ? (u.modes as string[]) : [],
            /* v8 ignore stop */
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
        /* v8 ignore next */
        const handle = String(frame.handle ?? '');
        if (!handle) return;
        const hostmasks = Array.isArray(frame.hostmasks) ? (frame.hostmasks as string[]) : [];
        /* v8 ignore next */
        const globalFlags = String(frame.globalFlags ?? '');
        const channelFlags =
          frame.channelFlags && typeof frame.channelFlags === 'object'
            ? (frame.channelFlags as Record<string, string>)
            : {};
        permissions.syncUser(handle, hostmasks, globalFlags, channelFlags, 'botlink-sync');
        break;
      }

      case 'DELUSER': {
        /* v8 ignore next */
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
