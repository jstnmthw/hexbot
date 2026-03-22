// n0xb0t — Channel state tracking
// Tracks who is in each channel, their modes, and hostmasks.
// Updated in real time from IRC events.
import type { BotEventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { ircLower } from '../utils/wildcard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for channel state tracking. */
export interface ChannelStateClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface UserInfo {
  nick: string;
  ident: string;
  hostname: string;
  hostmask: string; // computed: nick!ident@hostname
  modes: string[]; // channel modes: 'o', 'v', etc.
  joinedAt: Date;
}

export interface ChannelInfo {
  name: string;
  topic: string;
  modes: string;
  users: Map<string, UserInfo>;
}

// ---------------------------------------------------------------------------
// ChannelState
// ---------------------------------------------------------------------------

export class ChannelState {
  private channels: Map<string, ChannelInfo> = new Map();
  private client: ChannelStateClient;
  private eventBus: BotEventBus;
  private logger: Logger | null;
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(client: ChannelStateClient, eventBus: BotEventBus, logger?: Logger | null) {
    this.client = client;
    this.eventBus = eventBus;
    this.logger = logger?.child('channel-state') ?? null;
  }

  /** Start listening to IRC events. */
  attach(): void {
    this.listen('join', this.onJoin.bind(this));
    this.listen('part', this.onPart.bind(this));
    this.listen('quit', this.onQuit.bind(this));
    this.listen('kick', this.onKick.bind(this));
    this.listen('nick', this.onNick.bind(this));
    this.listen('mode', this.onMode.bind(this));
    this.listen('userlist', this.onUserlist.bind(this));
    this.listen('wholist', this.onWholist.bind(this));
    this.listen('topic', this.onTopic.bind(this));
    this.logger?.info('Attached to IRC client');
  }

  /** Stop listening. */
  detach(): void {
    for (const { event, fn } of this.listeners) {
      this.client.removeListener(event, fn);
    }
    this.listeners = [];
    this.logger?.info('Detached from IRC client');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getChannel(name: string): ChannelInfo | undefined {
    return this.channels.get(ircLower(name));
  }

  getUser(channel: string, nick: string): UserInfo | undefined {
    const ch = this.channels.get(ircLower(channel));
    if (!ch) return undefined;
    return ch.users.get(ircLower(nick));
  }

  getUserHostmask(channel: string, nick: string): string | undefined {
    const user = this.getUser(channel, nick);
    if (!user) return undefined;
    return user.hostmask;
  }

  isUserInChannel(channel: string, nick: string): boolean {
    return this.getUser(channel, nick) !== undefined;
  }

  getUserModes(channel: string, nick: string): string[] {
    const user = this.getUser(channel, nick);
    return user?.modes ?? [];
  }

  // -------------------------------------------------------------------------
  // IRC event handlers
  // -------------------------------------------------------------------------

  private onJoin(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    const ident = String(event.ident ?? '');
    const hostname = String(event.hostname ?? '');
    const channel = String(event.channel ?? '');

    if (!channel || !nick) return;

    const ch = this.ensureChannel(channel);
    const user: UserInfo = {
      nick,
      ident,
      hostname,
      hostmask: `${nick}!${ident}@${hostname}`,
      modes: [],
      joinedAt: new Date(),
    };
    ch.users.set(ircLower(nick), user);

    this.eventBus.emit('channel:userJoined', channel, nick);
  }

  private onPart(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    const channel = String(event.channel ?? '');

    if (!channel || !nick) return;

    const ch = this.channels.get(ircLower(channel));
    if (ch) {
      ch.users.delete(ircLower(nick));
    }

    this.eventBus.emit('channel:userLeft', channel, nick);
  }

  private onQuit(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    if (!nick) return;

    const lower = ircLower(nick);
    for (const ch of this.channels.values()) {
      ch.users.delete(lower);
    }

    this.eventBus.emit('channel:userLeft', '*', nick);
  }

  private onKick(event: Record<string, unknown>): void {
    const kicked = String(event.kicked ?? '');
    const channel = String(event.channel ?? '');

    if (!channel || !kicked) return;

    const ch = this.channels.get(ircLower(channel));
    if (ch) {
      ch.users.delete(ircLower(kicked));
    }

    this.eventBus.emit('channel:userLeft', channel, kicked);
  }

  private onNick(event: Record<string, unknown>): void {
    const oldNick = String(event.nick ?? '');
    const newNick = String(event.new_nick ?? '');

    if (!oldNick || !newNick) return;

    const oldLower = ircLower(oldNick);
    const newLower = ircLower(newNick);

    for (const ch of this.channels.values()) {
      const user = ch.users.get(oldLower);
      if (user) {
        ch.users.delete(oldLower);
        user.nick = newNick;
        user.hostmask = `${newNick}!${user.ident}@${user.hostname}`;
        ch.users.set(newLower, user);
      }
    }
  }

  private onMode(event: Record<string, unknown>): void {
    const target = String(event.target ?? '');
    const modes = event.modes as Array<{ mode: string; param?: string }> | undefined;

    if (!target || !modes) return;

    const ch = this.channels.get(ircLower(target));
    if (!ch) return;

    for (const m of modes) {
      const mode = String(m.mode ?? '');
      const param = m.param ? String(m.param) : '';

      // User modes: +o, -o, +v, -v, etc. have a nick as param
      if (
        param &&
        (mode === '+o' ||
          mode === '-o' ||
          mode === '+v' ||
          mode === '-v' ||
          mode === '+h' ||
          mode === '-h' ||
          mode === '+a' ||
          mode === '-a' ||
          mode === '+q' ||
          mode === '-q')
      ) {
        const user = ch.users.get(ircLower(param));
        if (user) {
          const modeChar = mode.charAt(1); // 'o', 'v', etc.
          if (mode.charAt(0) === '+') {
            if (!user.modes.includes(modeChar)) {
              user.modes.push(modeChar);
            }
          } else {
            user.modes = user.modes.filter((m) => m !== modeChar);
          }
          this.eventBus.emit('channel:modeChanged', target, param, mode);
        }
      }
    }
  }

  private onUserlist(event: Record<string, unknown>): void {
    const channel = String(event.channel ?? '');
    const users = event.users as Array<Record<string, unknown>> | undefined;

    if (!channel || !users) return;

    const ch = this.ensureChannel(channel);

    for (const u of users) {
      const nick = String(u.nick ?? '');
      if (!nick) continue;

      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const modes = this.parseUserlistModes(u.modes as string | undefined);

      // Only add if not already present (join event may have fired first)
      if (!ch.users.has(ircLower(nick))) {
        ch.users.set(ircLower(nick), {
          nick,
          ident,
          hostname,
          hostmask: `${nick}!${ident}@${hostname}`,
          modes,
          joinedAt: new Date(),
        });
      } else {
        // Update ident/hostname/modes from NAMES if we have them
        const existing = ch.users.get(ircLower(nick))!;
        if (ident) existing.ident = ident;
        if (hostname) existing.hostname = hostname;
        if (ident || hostname) {
          existing.hostmask = `${existing.nick}!${existing.ident}@${existing.hostname}`;
        }
        if (modes.length > 0) existing.modes = modes;
      }
    }
  }

  private onWholist(event: Record<string, unknown>): void {
    const users = event.users as Array<Record<string, unknown>> | undefined;
    if (!users) return;

    for (const u of users) {
      const nick = String(u.nick ?? '');
      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const channel = String(u.channel ?? '');

      if (!nick || !channel) continue;

      const ch = this.channels.get(ircLower(channel));
      if (!ch) continue;

      const user = ch.users.get(ircLower(nick));
      if (user) {
        user.ident = ident;
        user.hostname = hostname;
        user.hostmask = `${nick}!${ident}@${hostname}`;
      }
    }
  }

  private onTopic(event: Record<string, unknown>): void {
    const channel = String(event.channel ?? '');
    const topic = String(event.topic ?? '');

    if (!channel) return;

    const ch = this.ensureChannel(channel);
    ch.topic = topic;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ensureChannel(name: string): ChannelInfo {
    const lower = ircLower(name);
    let ch = this.channels.get(lower);
    if (!ch) {
      ch = { name, topic: '', modes: '', users: new Map() };
      this.channels.set(lower, ch);
    }
    return ch;
  }

  private listen(event: string, handler: (event: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => handler((args[0] ?? {}) as Record<string, unknown>);
    this.client.on(event, fn);
    this.listeners.push({ event, fn });
  }

  /** Parse irc-framework userlist modes string into mode chars. */
  private parseUserlistModes(modes: string | undefined): string[] {
    if (!modes) return [];
    const result: string[] = [];
    // irc-framework uses symbols: @ = op, + = voice, % = halfop
    if (modes.includes('o') || modes.includes('@')) result.push('o');
    if (modes.includes('v') || modes.includes('+')) result.push('v');
    if (modes.includes('h') || modes.includes('%')) result.push('h');
    return result;
  }
}
