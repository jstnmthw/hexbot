// HexBot — Channel state tracking
// Tracks who is in each channel, their modes, and hostmasks.
// Updated in real time from IRC events.
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import { isModeArray, isObjectArray, toEventObject } from '../utils/irc-event';
import { type Casemapping, ircLower } from '../utils/wildcard';
import { type ServerCapabilities, defaultServerCapabilities } from './isupport';

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
  /**
   * Away state from IRCv3 `away-notify`.
   * - `true`      — user has set an AWAY message
   * - `false`     — user is explicitly back (RPL_UNAWAY / zero-length AWAY)
   * - `undefined` — no away-notify data received yet
   */
  away?: boolean;
  /** Last-known away reason, if the network advertised one. */
  awayMessage?: string;
}

export interface ChannelInfo {
  name: string;
  topic: string;
  modes: string; // channel mode chars (e.g. 'ntsk'), updated from MODE events and RPL_CHANNELMODEIS
  key: string; // current channel key ('' if none)
  limit: number; // current channel user limit (0 if none)
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
  private logger: LoggerLike | null;
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private botNick = '';
  private casemapping: Casemapping = 'rfc1459';
  private capabilities: ServerCapabilities = defaultServerCapabilities();

  constructor(client: ChannelStateClient, eventBus: BotEventBus, logger?: LoggerLike | null) {
    this.client = client;
    this.eventBus = eventBus;
    this.logger = logger?.child('channel-state') ?? null;
  }

  /** Set the bot's own nick (used to detect self-PART/KICK for channel cleanup). */
  setBotNick(nick: string): void {
    this.botNick = nick;
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Apply a parsed ISUPPORT snapshot; drives PREFIX-aware mode tracking. */
  setCapabilities(caps: ServerCapabilities): void {
    this.capabilities = caps;
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
    // RPL_CHANNELMODEIS (324): server response to MODE #channel query
    this.listen('channel info', this.onChannelInfo.bind(this));
    // IRCv3: account-notify (fires when a user identifies or deidentifies)
    this.listen('account', this.onAccount.bind(this));
    // IRCv3: chghost (fires when a user's ident/hostname changes — requires enable_chghost: true)
    this.listen('user updated', this.onUserUpdated.bind(this));
    // IRCv3: away-notify. irc-framework splits AWAY into 'away' (user set a
    // message) and 'back' (user cleared it). We track both so plugins can
    // ask "is this user away?" without a WHOIS round-trip.
    this.listen('away', (event) => this.onAway(event, true));
    this.listen('back', (event) => this.onAway(event, false));
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

  /** Return all tracked channels (used by bot-link sync). */
  getAllChannels(): ChannelInfo[] {
    return Array.from(this.channels.values());
  }

  /**
   * Inject a full channel state snapshot from a bot-link CHAN sync frame.
   * Creates or replaces the channel and all its users.
   */
  injectChannelSync(data: {
    channel: string;
    topic: string;
    modes: string;
    key?: string;
    limit?: number;
    users: Array<{ nick: string; ident: string; hostname: string; modes: string[] }>;
  }): void {
    const ch = this.ensureChannel(data.channel);
    ch.topic = data.topic;
    ch.modes = data.modes;
    ch.key = data.key ?? '';
    ch.limit = data.limit ?? 0;
    ch.users.clear();

    for (const u of data.users) {
      ch.users.set(ircLower(u.nick, this.casemapping), {
        nick: u.nick,
        ident: u.ident,
        hostname: u.hostname,
        hostmask: `${u.nick}!${u.ident}@${u.hostname}`,
        modes: [...u.modes],
        joinedAt: new Date(),
      });
    }
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

  /**
   * Drop the entire network-wide account map. Called on reconnect so stale
   * identity data can't survive across sessions and let an imposter who
   * took a known user's nick inherit their permissions. Per-channel user
   * records are not touched — NAMES will refresh them on rejoin. Fresh
   * account data arrives via extended-join / account-notify / account-tag
   * on the new session.
   */
  clearNetworkAccounts(): void {
    if (this.networkAccounts.size === 0) return;
    this.logger?.debug(`clearing ${this.networkAccounts.size} cached account entries on reconnect`);
    this.networkAccounts.clear();
    // Also strip accountName from any per-channel UserInfo so a subsequent
    // `user.accountName` read can't return a pre-reconnect value.
    for (const ch of this.channels.values()) {
      for (const user of ch.users.values()) {
        user.accountName = undefined;
      }
    }
  }

  /**
   * Drop the entire per-channel map. Called on reconnect alongside
   * `clearNetworkAccounts()` so channels the bot used to be in but isn't
   * rejoining cannot leave residual `ChannelInfo`/`UserInfo` graphs pinned
   * in memory across years of uptime. NAMES for rejoined channels will
   * repopulate fresh state on the new session.
   */
  clearAllChannels(): void {
    if (this.channels.size === 0) return;
    this.logger?.debug(`clearing ${this.channels.size} tracked channels on reconnect`);
    this.channels.clear();
  }

  /**
   * Update the network-wide account map from a source outside the event
   * stream — currently only `irc-bridge` when consuming the IRCv3
   * `account-tag` on an incoming PRIVMSG. Centralising this here keeps the
   * dispatcher's verification fast-path uniform regardless of which cap
   * delivered the account data.
   */
  setAccountForNick(nick: string, account: string | null): void {
    const lower = ircLower(nick, this.casemapping);
    const previous = this.networkAccounts.get(lower);
    if (previous === account) return;
    this.networkAccounts.set(lower, account);
    // Mirror the change onto any per-channel UserInfo records so plugin code
    // reading `user.accountName` sees the same value as the dispatcher.
    for (const ch of this.channels.values()) {
      const user = ch.users.get(lower);
      if (user) user.accountName = account;
    }
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
    const channel = String(event.channel);

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
    const nick = String(event.nick ?? '');
    const channel = String(event.channel ?? '');
    const lower = ircLower(channel, this.casemapping);

    const ch = this.channels.get(lower);
    if (ch) {
      ch.users.delete(ircLower(nick, this.casemapping));
    }

    // Bot left the channel — remove the entire channel entry
    if (
      this.botNick &&
      ircLower(nick, this.casemapping) === ircLower(this.botNick, this.casemapping)
    ) {
      this.channels.delete(lower);
    }

    // If the user is no longer in any tracked channel, remove from network
    // accounts. Use an ircLower compare so case-insensitive nick handling
    // stays consistent with the rest of the file — a raw `!==` would
    // incorrectly treat `Bot` and `bot` as different nicks on RFC1459
    // casemapping networks.
    if (
      !this.botNick ||
      ircLower(nick, this.casemapping) !== ircLower(this.botNick, this.casemapping)
    ) {
      const nickLower = ircLower(nick, this.casemapping);
      if (this.networkAccounts.has(nickLower)) {
        let stillPresent = false;
        for (const ch of this.channels.values()) {
          if (ch.users.has(nickLower)) {
            stillPresent = true;
            break;
          }
        }
        if (!stillPresent) this.networkAccounts.delete(nickLower);
      }
    }

    this.eventBus.emit('channel:userLeft', channel, nick);
  }

  private onQuit(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');

    const lower = ircLower(nick, this.casemapping);
    for (const ch of this.channels.values()) {
      ch.users.delete(lower);
    }
    this.networkAccounts.delete(lower);

    this.eventBus.emit('channel:userLeft', '*', nick);
  }

  private onKick(event: Record<string, unknown>): void {
    const kicked = String(event.kicked ?? '');
    const channel = String(event.channel ?? '');
    const lower = ircLower(channel, this.casemapping);

    const ch = this.channels.get(lower);
    if (ch) {
      ch.users.delete(ircLower(kicked, this.casemapping));
    }

    // Bot was kicked — remove the entire channel entry
    if (
      this.botNick &&
      ircLower(kicked, this.casemapping) === ircLower(this.botNick, this.casemapping)
    ) {
      this.channels.delete(lower);
    }

    this.eventBus.emit('channel:userLeft', channel, kicked);
  }

  private onNick(event: Record<string, unknown>): void {
    const oldNick = String(event.nick);
    const newNick = String(event.new_nick);

    const oldLower = ircLower(oldNick, this.casemapping);
    const newLower = ircLower(newNick, this.casemapping);

    // Carry account info forward to the new nick
    if (this.networkAccounts.has(oldLower)) {
      /* v8 ignore next -- has() just checked, `?? null` is unreachable */
      const account = this.networkAccounts.get(oldLower) ?? null;
      this.networkAccounts.delete(oldLower);
      this.networkAccounts.set(newLower, account);
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
    const target = String(event.target);
    if (!isModeArray(event.modes)) return;
    const modes = event.modes;

    const ch = this.channels.get(ircLower(target, this.casemapping));
    if (!ch) return;

    for (const m of modes) {
      const mode = m.mode ?? '';
      const param = m.param ? String(m.param) : '';

      // User prefix modes carry a nick param. Which chars count as prefix modes
      // is ISUPPORT-driven — we consult the current capabilities snapshot so
      // networks with non-standard prefixes (e.g. InspIRCd halfop-only
      // `PREFIX=(oh)@%`) get tracked correctly.
      if (param && mode.length === 2 && this.capabilities.prefixSet.has(mode.charAt(1))) {
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
        continue;
      }

      // Channel modes: update ch.modes, ch.key, ch.limit
      const adding = mode.charAt(0) === '+';
      const modeChar = mode.charAt(1);

      if (modeChar === 'k') {
        if (adding) {
          ch.key = param;
          if (!ch.modes.includes('k')) ch.modes += 'k';
        } else {
          ch.key = '';
          ch.modes = ch.modes.replace('k', '');
        }
      } else if (modeChar === 'l') {
        if (adding) {
          const parsed = parseInt(param, 10);
          ch.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          if (!ch.modes.includes('l')) ch.modes += 'l';
        } else {
          ch.limit = 0;
          ch.modes = ch.modes.replace('l', '');
        }
      } else if (this.capabilities.chanmodesA.has(modeChar)) {
        // Type A list modes (b/e/I by default) — we don't track the lists
        // themselves in ch.modes because they represent per-mask state, not
        // a flag. Consumers that need ban-list tracking subscribe to RPL_BANLIST.
      } else {
        // Simple channel mode flag (i, m, n, p, s, t, etc.)
        if (adding) {
          if (!ch.modes.includes(modeChar)) ch.modes += modeChar;
        } else {
          ch.modes = ch.modes.replace(modeChar, '');
        }
      }
    }
  }

  private onUserlist(event: Record<string, unknown>): void {
    const channel = String(event.channel ?? '');
    if (!isObjectArray(event.users)) return;
    const users = event.users;

    const ch = this.ensureChannel(channel);

    for (const u of users) {
      const nick = String(u.nick ?? '');
      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const modes = this.parseUserlistModes(u.modes);

      // Only add if not already present (join event may have fired first)
      const lowerNick = ircLower(nick, this.casemapping);
      const existing = ch.users.get(lowerNick);
      if (!existing) {
        ch.users.set(lowerNick, {
          nick,
          ident,
          hostname,
          hostmask: `${nick}!${ident}@${hostname}`,
          modes,
          joinedAt: new Date(),
        });
      } else {
        // Update ident/hostname/modes from NAMES if we have them
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
      const nick = String(u.nick ?? '');
      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const channel = String(u.channel ?? '');

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
    const channel = String(event.channel ?? '');
    const topic = String(event.topic ?? '');

    const ch = this.ensureChannel(channel);
    ch.topic = topic;
  }

  /**
   * RPL_CHANNELMODEIS (324): server response to MODE #channel query.
   * Populates ch.modes, ch.key, and ch.limit from the full channel mode state.
   * irc-framework emits { channel, modes: [{mode, param}], raw_modes, raw_params }.
   */
  private onChannelInfo(event: Record<string, unknown>): void {
    const channel = String(event.channel);
    // RPL_CREATIONTIME and RPL_CHANNEL_URL also emit 'channel info' without modes
    if (!isModeArray(event.modes)) return;

    const ch = this.ensureChannel(channel);
    let modeChars = '';
    let key = '';
    let limit = 0;

    for (const m of event.modes) {
      const mode = String(m.mode);
      const modeChar = mode.charAt(1);
      modeChars += modeChar;
      if (modeChar === 'k') key = String(m.param);
      if (modeChar === 'l') limit = parseInt(String(m.param), 10);
    }

    ch.modes = modeChars;
    ch.key = key;
    ch.limit = limit;

    this.eventBus.emit('channel:modesReady', channel);
    this.logger?.debug(
      `channel info: ${channel} modes=${modeChars} key=${key || '(none)'} limit=${limit || '(none)'}`,
    );
  }

  /** IRCv3 account-notify: fires when a user's identification status changes. */
  private onAccount(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');

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

  /**
   * IRCv3 away-notify. `isAway` is true on `AWAY :reason`, false on `AWAY`
   * (no reason) / RPL_UNAWAY. Applies to every channel the user is in —
   * away state is a network-wide property so we fan out to all channels
   * that know about the nick, matching what account-notify does.
   */
  private onAway(event: Record<string, unknown>, isAway: boolean): void {
    const nick = String(event.nick ?? '');
    if (!nick) return;
    const message = typeof event.message === 'string' ? event.message : '';
    const lower = ircLower(nick, this.casemapping);

    let touched = false;
    for (const ch of this.channels.values()) {
      const user = ch.users.get(lower);
      if (!user) continue;
      user.away = isAway;
      user.awayMessage = isAway ? message : undefined;
      touched = true;
      this.eventBus.emit('channel:awayChanged', ch.name, nick, isAway);
    }

    if (touched) {
      this.logger?.debug(`away-notify: ${nick} is ${isAway ? 'away' : 'back'}`);
    }
  }

  /** IRCv3 chghost: fires when a user's displayed ident/hostname changes. */
  private onUserUpdated(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
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
      ch = { name, topic: '', modes: '', key: '', limit: 0, users: new Map() };
      this.channels.set(lower, ch);
    }
    return ch;
  }

  private listen(event: string, handler: (event: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => handler(toEventObject(args[0]));
    this.client.on(event, fn);
    this.listeners.push({ event, fn });
  }

  /**
   * Normalise a user's prefix modes from a NAMES reply into mode chars.
   *
   * irc-framework's RPL_NAMEREPLY handler walks `network.options.PREFIX` and
   * emits an **array** of mode chars (e.g. `['o', 'v']` for `@+nick`). If
   * `multi-prefix` is active every applicable prefix is represented; without
   * it, only the highest. We accept the array form and filter it to the
   * prefix modes advertised by the connected network.
   *
   * The string branch (symbol characters or mode-char text) is retained as a
   * defensive fallback for bot-link CHAN sync frames and any legacy path
   * that ships `modes` as a concatenated string.
   */
  private parseUserlistModes(modes: unknown): string[] {
    if (!modes) return [];
    const tokens = Array.isArray(modes) ? modes.map(String) : String(modes).split('');
    const { symbolToPrefix, prefixSet } = this.capabilities;
    const result: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      const mode = symbolToPrefix[token] ?? (prefixSet.has(token) ? token : null);
      if (mode && !seen.has(mode)) {
        seen.add(mode);
        result.push(mode);
      }
    }
    return result;
  }
}
