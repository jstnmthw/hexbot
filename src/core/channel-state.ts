// HexBot — Channel state tracking
// Tracks who is in each channel, their modes, and hostmasks.
// Updated in real time from IRC events.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import { isModeArray, isObjectArray, toEventObject } from '../utils/irc-event';
import { type Casemapping, ircLower } from '../utils/wildcard';

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
  /** Services account name. null = known not identified. undefined = unknown (no account-notify/extended-join data). */
  accountName?: string | null;
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
  /* v8 ignore next -- V8 branch artifact for class field initializer; always initialized */
  private channels: Map<string, ChannelInfo> = new Map();
  /** Network-wide account map. Key: nick (lowercase). Value: account name or null (known not identified). */
  private networkAccounts: Map<string, string | null> = new Map();
  private client: ChannelStateClient;
  private eventBus: BotEventBus;
  private logger: Logger | null;
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private casemapping: Casemapping = 'rfc1459';

  constructor(client: ChannelStateClient, eventBus: BotEventBus, logger?: Logger | null) {
    this.client = client;
    this.eventBus = eventBus;
    this.logger = logger?.child('channel-state') ?? null;
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
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
    // IRCv3: account-notify (fires when a user identifies or deidentifies)
    this.listen('account', this.onAccount.bind(this));
    // IRCv3: chghost (fires when a user's ident/hostname changes — requires enable_chghost: true)
    this.listen('user updated', this.onUserUpdated.bind(this));
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
    return this.channels.get(ircLower(name, this.casemapping));
  }

  getUser(channel: string, nick: string): UserInfo | undefined {
    const ch = this.channels.get(ircLower(channel, this.casemapping));
    if (!ch) return undefined;
    return ch.users.get(ircLower(nick, this.casemapping));
  }

  getUserHostmask(channel: string, nick: string): string | undefined {
    const user = this.getUser(channel, nick);
    if (!user) return undefined;
    return user.hostmask;
  }

  isUserInChannel(channel: string, nick: string): boolean {
    return this.getUser(channel, nick) !== undefined;
  }

  /**
   * Return the services account for a nick from the network-wide account map.
   * - `string`    — nick is identified as this account (from account-notify or extended-join)
   * - `null`      — nick is known NOT to be identified
   * - `undefined` — no account-notify/extended-join data received yet for this nick
   */
  getAccountForNick(nick: string): string | null | undefined {
    const lower = ircLower(nick, this.casemapping);
    if (!this.networkAccounts.has(lower)) return undefined;
    return this.networkAccounts.get(lower);
  }

  getUserModes(channel: string, nick: string): string[] {
    const user = this.getUser(channel, nick);
    return user!.modes;
  }

  // -------------------------------------------------------------------------
  // IRC event handlers
  // -------------------------------------------------------------------------

  private onJoin(event: Record<string, unknown>): void {
    const nick = event.nick as string;
    const ident = event.ident as string;
    const hostname = event.hostname as string;
    const channel = event.channel as string;

    // IRCv3 extended-join: account field is present when the cap is negotiated.
    // irc-framework sets it to false (not the string '*') when the user is not identified.
    let accountName: string | null | undefined;
    if ('account' in event) {
      accountName =
        event.account === false || event.account === null ? null : String(event.account);
      this.networkAccounts.set(ircLower(nick, this.casemapping), accountName);
    }

    const ch = this.ensureChannel(channel);
    const user: UserInfo = {
      nick,
      ident,
      hostname,
      hostmask: `${nick}!${ident}@${hostname}`,
      modes: [],
      joinedAt: new Date(),
      accountName,
    };
    ch.users.set(ircLower(nick, this.casemapping), user);

    this.eventBus.emit('channel:userJoined', channel, nick);
  }

  private onPart(event: Record<string, unknown>): void {
    const nick = event.nick as string;
    const channel = event.channel as string;

    this.channels
      .get(ircLower(channel, this.casemapping))!
      .users.delete(ircLower(nick, this.casemapping));

    this.eventBus.emit('channel:userLeft', channel, nick);
  }

  private onQuit(event: Record<string, unknown>): void {
    const nick = event.nick as string;

    const lower = ircLower(nick, this.casemapping);
    for (const ch of this.channels.values()) {
      ch.users.delete(lower);
    }
    this.networkAccounts.delete(lower);

    this.eventBus.emit('channel:userLeft', '*', nick);
  }

  private onKick(event: Record<string, unknown>): void {
    const kicked = event.kicked as string;
    const channel = event.channel as string;

    const ch = this.channels.get(ircLower(channel, this.casemapping));
    if (ch) {
      ch.users.delete(ircLower(kicked, this.casemapping));
    }

    this.eventBus.emit('channel:userLeft', channel, kicked);
  }

  private onNick(event: Record<string, unknown>): void {
    const oldNick = event.nick as string;
    const newNick = event.new_nick as string;

    const oldLower = ircLower(oldNick, this.casemapping);
    const newLower = ircLower(newNick, this.casemapping);

    // Carry account info forward to the new nick
    if (this.networkAccounts.has(oldLower)) {
      const account = this.networkAccounts.get(oldLower);
      this.networkAccounts.delete(oldLower);
      this.networkAccounts.set(newLower, account!);
    }

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
    const target = event.target as string;
    /* v8 ignore next -- irc-framework always provides a valid modes array */
    if (!isModeArray(event.modes)) return;
    const modes = event.modes;

    const ch = this.channels.get(ircLower(target, this.casemapping))!;

    for (const m of modes) {
      const mode = m.mode as string;
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
        const user = ch.users.get(ircLower(param, this.casemapping));
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
    const channel = event.channel as string;
    /* v8 ignore next -- irc-framework always provides a valid users array */
    if (!isObjectArray(event.users)) return;
    const users = event.users;

    const ch = this.ensureChannel(channel);

    for (const u of users) {
      const nick = u.nick as string;
      const ident = u.ident as string;
      const hostname = u.hostname as string;
      const modes = this.parseUserlistModes(typeof u.modes === 'string' ? u.modes : undefined);

      // Only add if not already present (join event may have fired first)
      if (!ch.users.has(ircLower(nick, this.casemapping))) {
        ch.users.set(ircLower(nick, this.casemapping), {
          nick,
          ident,
          hostname,
          hostmask: `${nick}!${ident}@${hostname}`,
          modes,
          joinedAt: new Date(),
        });
      } else {
        // Update ident/hostname/modes from NAMES if we have them
        const existing = ch.users.get(ircLower(nick, this.casemapping))!;
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
    if (!isObjectArray(event.users)) return;
    const users = event.users;

    for (const u of users) {
      const nick = u.nick as string;
      const ident = u.ident as string;
      const hostname = u.hostname as string;
      const channel = u.channel as string;

      const ch = this.channels.get(ircLower(channel, this.casemapping));
      if (!ch) continue;

      const user = ch.users.get(ircLower(nick, this.casemapping));
      if (user) {
        user.ident = ident;
        user.hostname = hostname;
        user.hostmask = `${nick}!${ident}@${hostname}`;
      }
    }
  }

  private onTopic(event: Record<string, unknown>): void {
    const channel = event.channel as string;
    const topic = event.topic as string;

    const ch = this.ensureChannel(channel);
    ch.topic = topic;
  }

  /** IRCv3 account-notify: fires when a user's identification status changes. */
  private onAccount(event: Record<string, unknown>): void {
    const nick = event.nick as string;

    // irc-framework sets account to false when the user deidentifies
    const accountName: string | null =
      event.account === false || event.account === null ? null : String(event.account);

    const lower = ircLower(nick, this.casemapping);
    this.networkAccounts.set(lower, accountName);

    // Update accountName on all per-channel UserInfo objects for this nick
    for (const ch of this.channels.values()) {
      const user = ch.users.get(lower);
      if (user) {
        user.accountName = accountName;
      }
    }

    if (accountName) {
      this.logger?.debug(`account-notify: ${nick} identified as ${accountName}`);
    } else {
      this.logger?.debug(`account-notify: ${nick} deidentified`);
    }
  }

  /** IRCv3 chghost: fires when a user's displayed ident/hostname changes. */
  private onUserUpdated(event: Record<string, unknown>): void {
    const nick = event.nick as string;
    const newIdent = event.new_ident !== undefined ? String(event.new_ident) : undefined;
    const newHostname = event.new_hostname !== undefined ? String(event.new_hostname) : undefined;

    const lower = ircLower(nick, this.casemapping);
    for (const ch of this.channels.values()) {
      const user = ch.users.get(lower);
      if (user) {
        if (newIdent) user.ident = newIdent;
        if (newHostname) user.hostname = newHostname;
        user.hostmask = `${user.nick}!${user.ident}@${user.hostname}`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ensureChannel(name: string): ChannelInfo {
    const lower = ircLower(name, this.casemapping);
    let ch = this.channels.get(lower);
    if (!ch) {
      ch = { name, topic: '', modes: '', users: new Map() };
      this.channels.set(lower, ch);
    }
    return ch;
  }

  private listen(event: string, handler: (event: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => handler(toEventObject(args[0]));
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
