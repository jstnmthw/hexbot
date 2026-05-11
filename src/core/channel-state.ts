// HexBot — Channel state tracking
// Tracks who is in each channel, their modes, and hostmasks.
// Updated in real time from IRC events.
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import { isModeArray, isObjectArray, toEventObject } from '../utils/irc-event';
import { ListenerGroup } from '../utils/listener-group';
import { sanitize } from '../utils/sanitize';
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
  private listeners: ListenerGroup;
  private botNick = '';
  private casemapping: Casemapping = 'rfc1459';
  private capabilities: ServerCapabilities = defaultServerCapabilities();
  /**
   * Set true in `clearAllChannels` (reconnect path); reset on the first
   * `onJoin`/`onUserlist` of the new session. Late 353/JOIN lines for the
   * pre-reconnect session would otherwise re-create empty channel records
   * that the new session never repopulates. Closes the race window between
   * `clearAllChannels` and the network-side disconnect actually flushing.
   */
  private disconnecting = false;

  /**
   * @param initialState Optional seed for the internal channel and
   *   network-account maps. Keys must already match whatever casemapping the
   *   caller plans to use (pass the seed *after* any `setCasemapping` call
   *   that would otherwise change lookup behavior). Lets tests start from
   *   a known "channel has 10 users, 3 accounts" state without replaying
   *   join/account events.
   */
  constructor(
    client: ChannelStateClient,
    eventBus: BotEventBus,
    logger?: LoggerLike | null,
    initialState?: {
      channels?: Iterable<readonly [string, ChannelInfo]>;
      networkAccounts?: Iterable<readonly [string, string | null]>;
    },
  ) {
    this.client = client;
    this.eventBus = eventBus;
    this.logger = logger?.child('channel-state') ?? null;
    this.listeners = new ListenerGroup(client, this.logger);
    if (initialState?.channels) this.channels = new Map(initialState.channels);
    if (initialState?.networkAccounts) {
      this.networkAccounts = new Map(initialState.networkAccounts);
    }
  }

  /** Set the bot's own nick (used to detect self-PART/KICK for channel cleanup). */
  setBotNick(nick: string): void {
    this.botNick = nick;
  }

  /**
   * Update the case-folding rule for nick/channel keys. Called by Bot when
   * ISUPPORT 005 announces a CASEMAPPING. Existing entries are not re-keyed —
   * a casemapping change mid-session is rare and any stale records refresh
   * naturally on the next NAMES.
   */
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
    this.listeners.removeAll();
    this.logger?.info('Detached from IRC client');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getChannel(name: string): ChannelInfo | undefined {
    return this.channels.get(this.lowerChannel(name));
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
      ch.users.set(this.lowerNick(u.nick), {
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
    const ch = this.channels.get(this.lowerChannel(channel));
    if (!ch) return undefined;
    return ch.users.get(this.lowerNick(nick));
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
    const lower = this.lowerNick(nick);
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
    // Lock new allocations until the next session actually starts joining
    // channels. Late lines from the pre-reconnect session (353/JOIN from
    // the old socket draining) would otherwise re-create empty records
    // the new session never repopulates.
    this.disconnecting = true;
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
    const lower = this.lowerNick(nick);
    const previous = this.networkAccounts.get(lower);
    if (previous === account) return;
    this.networkAccounts.set(lower, account);
    // Mirror the change onto any per-channel UserInfo records so plugin code
    // reading `user.accountName` sees the same value as the dispatcher.
    this.updateUserAcrossChannels(lower, (user) => {
      user.accountName = account;
    });
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

    // Reconnect race guard: a JOIN for a channel we no longer track during
    // the disconnect window must not allocate a new record. The bot will
    // re-issue JOIN on the new session if it actually wants this channel.
    if (this.disconnecting && !this.channels.has(this.lowerChannel(channel))) {
      this.logger?.debug(`dropping late JOIN for ${channel} during disconnecting window`);
      return;
    }
    // First JOIN of the new session — we're past the reconnect drop and
    // the new session is allocating fresh channel state.
    this.disconnecting = false;

    // IRCv3 extended-join (cap `extended-join`, IRCv3.2): when negotiated, the
    // server appends an account name and realname to JOIN. irc-framework sets
    // `account` to `false` when the user is not identified — the wire form is
    // the literal `*`, but the framework normalises that to `false` rather
    // than passing the string through.
    let accountName: string | null | undefined;
    if ('account' in event) {
      accountName =
        event.account === false || event.account === null ? null : String(event.account);
      this.networkAccounts.set(this.lowerNick(nick), accountName);
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
    ch.users.set(this.lowerNick(nick), user);

    this.eventBus.emit('channel:userJoined', channel, nick);
  }

  private onPart(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    const channel = String(event.channel ?? '');
    const lower = this.lowerChannel(channel);

    const ch = this.channels.get(lower);
    if (ch) {
      ch.users.delete(this.lowerNick(nick));
    }

    // Bot left the channel — remove the entire channel entry
    if (this.botNick && this.lowerNick(nick) === this.lowerNick(this.botNick)) {
      this.channels.delete(lower);
    }

    // If the user is no longer in any tracked channel, remove from network
    // accounts. Use an ircLower compare so case-insensitive nick handling
    // stays consistent with the rest of the file — a raw `!==` would
    // incorrectly treat `Bot` and `bot` as different nicks on RFC1459
    // casemapping networks.
    if (!this.botNick || this.lowerNick(nick) !== this.lowerNick(this.botNick)) {
      const nickLower = this.lowerNick(nick);
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

    const lower = this.lowerNick(nick);
    for (const ch of this.channels.values()) {
      ch.users.delete(lower);
    }
    this.networkAccounts.delete(lower);

    this.eventBus.emit('channel:userLeft', '*', nick);
  }

  private onKick(event: Record<string, unknown>): void {
    const kicked = String(event.kicked ?? '');
    const channel = String(event.channel ?? '');
    const lower = this.lowerChannel(channel);

    const ch = this.channels.get(lower);
    if (ch) {
      ch.users.delete(this.lowerNick(kicked));
    }

    // Bot was kicked — remove the entire channel entry
    if (this.botNick && this.lowerNick(kicked) === this.lowerNick(this.botNick)) {
      this.channels.delete(lower);
    }

    this.eventBus.emit('channel:userLeft', channel, kicked);
  }

  private onNick(event: Record<string, unknown>): void {
    const oldNick = String(event.nick);
    const newNick = String(event.new_nick);

    // RFC 2812 §3.1.2 NICK: a successful NICK message is broadcast to every
    // channel the user is in, so we must rekey across all tracked channels.
    // Track bot's own nick changes (e.g. GHOST recovery — HEX_ → HEX).
    if (this.botNick && this.lowerNick(oldNick) === this.lowerNick(this.botNick)) {
      this.botNick = newNick;
    }

    const oldLower = this.lowerNick(oldNick);
    const newLower = this.lowerNick(newNick);

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
        // Surface NICK collisions during a netsplit re-merge. Two distinct
        // identities ending up under the same key would silently merge —
        // the surviving record is whichever NICK fired second, with the
        // earlier user's away/account state lost. We don't change the
        // behavior (overwrite is the only option once the server has
        // decided on a winner), but the warn lets the operator see it.
        const existing = ch.users.get(newLower);
        if (existing && existing !== user) {
          this.logger?.warn(
            `NICK collision in ${ch.name}: ${oldNick} (${user.hostmask}) → ${newNick} ` +
              `overwrites existing record (${existing.hostmask})`,
          );
        }
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

    const ch = this.channels.get(this.lowerChannel(target));
    if (!ch) return;

    for (const m of modes) {
      const mode = m.mode ?? '';
      const param = m.param ? String(m.param) : '';

      // Reject malformed entries with no direction char. A buggy or hostile
      // server emitting `o foo` (missing `+`/`-`) would otherwise be treated
      // as a remove by `processChannelMode`, since `mode.charAt(0) === '+'`
      // is false. Skipping is safer than guessing.
      const direction = mode.charAt(0);
      if (direction !== '+' && direction !== '-') {
        this.logger?.debug(`malformed mode entry, skipping: ${mode}`);
        continue;
      }

      // User prefix modes carry a nick param. Which chars count as prefix modes
      // is ISUPPORT-driven — we consult the current capabilities snapshot so
      // networks with non-standard prefixes (e.g. InspIRCd halfop-only
      // `PREFIX=(oh)@%`) get tracked correctly.
      if (param && mode.length === 2 && this.capabilities.prefixSet.has(mode.charAt(1))) {
        this.processUserPrefixMode(ch, target, mode, param);
      } else {
        this.processChannelMode(ch, mode, param);
      }
    }
  }

  /**
   * Apply a `+o alice` / `-v bob` style prefix-mode change to a user record.
   * Emits `channel:modeChanged` only when the target nick is currently tracked.
   */
  private processUserPrefixMode(
    ch: ChannelInfo,
    target: string,
    mode: string,
    param: string,
  ): void {
    const user = ch.users.get(this.lowerNick(param));
    if (!user) return;
    const modeChar = mode.charAt(1);
    if (mode.charAt(0) === '+') {
      if (!user.modes.includes(modeChar)) {
        user.modes.push(modeChar);
      }
    } else {
      user.modes = user.modes.filter((m) => m !== modeChar);
    }
    this.eventBus.emit('channel:modeChanged', target, param, mode);
  }

  /**
   * Apply a channel-mode flag change (`k`, `l`, type-D flags). Type-A list
   * modes are skipped because their per-mask state isn't tracked in `ch.modes`.
   */
  private processChannelMode(ch: ChannelInfo, mode: string, param: string): void {
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
      return;
    }

    if (modeChar === 'l') {
      if (adding) {
        const parsed = parseInt(param, 10);
        ch.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        if (!ch.modes.includes('l')) ch.modes += 'l';
      } else {
        ch.limit = 0;
        ch.modes = ch.modes.replace('l', '');
      }
      return;
    }

    // Type A list modes (b/e/I by default) represent per-mask state, not a
    // flag; consumers that need ban-list tracking subscribe to RPL_BANLIST.
    if (this.capabilities.chanmodesA.has(modeChar)) return;

    // Simple channel mode flag (i, m, n, p, s, t, etc.)
    if (adding) {
      if (!ch.modes.includes(modeChar)) ch.modes += modeChar;
    } else {
      ch.modes = ch.modes.replace(modeChar, '');
    }
  }

  private onUserlist(event: Record<string, unknown>): void {
    const channel = String(event.channel ?? '');
    if (!isObjectArray(event.users)) return;
    const users = event.users;

    // Reconnect race guard: a 353 NAMES line for a channel we dropped at
    // disconnect must not re-create the record. The new session's JOIN
    // path is the only legitimate allocation site once `clearAllChannels`
    // has fired.
    if (this.disconnecting && !this.channels.has(this.lowerChannel(channel))) {
      this.logger?.debug(`dropping late NAMES for ${channel} during disconnecting window`);
      return;
    }
    this.disconnecting = false;

    const ch = this.ensureChannel(channel);

    for (const u of users) {
      const nick = String(u.nick ?? '');
      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const modes = this.parseUserlistModes(u.modes);

      // Only add if not already present (join event may have fired first)
      const nickKey = this.lowerNick(nick);
      const existing = ch.users.get(nickKey);
      if (!existing) {
        ch.users.set(nickKey, {
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

  /**
   * RPL_WHOREPLY (352) batch from irc-framework: `WHO #chan` returns one
   * row per visible user with full ident/host. We use the result to backfill
   * NAMES entries that came in without ident/host (older networks pre-`UHNAMES`
   * cap), and to keep hostmasks in sync after a chghost we missed.
   */
  private onWholist(event: Record<string, unknown>): void {
    if (!isObjectArray(event.users)) return;
    const users = event.users;

    for (const u of users) {
      const nick = String(u.nick ?? '');
      const ident = String(u.ident ?? '');
      const hostname = String(u.hostname ?? '');
      const channel = String(u.channel ?? '');

      const ch = this.channels.get(this.lowerChannel(channel));
      if (!ch) continue;

      const user = ch.users.get(this.lowerNick(nick));
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

    // Get-only: a TOPIC for a channel we never joined would otherwise grow
    // `this.channels` unboundedly when a hostile or buggy server emits stray
    // 332/TOPIC numerics. `ensureChannel` is reserved for JOIN / USERLIST /
    // injectChannelSync — paths that imply we actually belong to the channel.
    const ch = this.channels.get(this.lowerChannel(channel));
    if (!ch) return;
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

    // Same containment as `onTopic`: an RPL_CHANNELMODEIS for a channel we
    // never joined must not allocate a tracking record. The legitimate flow
    // is JOIN → request modes → 324 reply; if the entry is missing the
    // numeric is stray (netsplit re-merge, server bug) and should be ignored.
    const ch = this.channels.get(this.lowerChannel(channel));
    if (!ch) return;
    let modeChars = '';
    let key = '';
    let limit = ch.limit;
    let limitWasParsed = false;

    for (const m of event.modes) {
      const mode = String(m.mode);
      const modeChar = mode.charAt(1);
      modeChars += modeChar;
      if (modeChar === 'k') key = String(m.param);
      if (modeChar === 'l') {
        // Match the guard in `processChannelMode`: a non-numeric or
        // non-positive `+l` param would otherwise pin `ch.limit = NaN`,
        // poisoning every downstream `< limit` comparison. Keep the
        // previous value if the server hands us a malformed param.
        const parsed = parseInt(String(m.param), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = parsed;
          limitWasParsed = true;
        } else {
          this.logger?.debug(
            `RPL_CHANNELMODEIS: ignoring non-positive +l param "${String(m.param)}" for ${channel}`,
          );
        }
      }
    }

    ch.modes = modeChars;
    ch.key = key;
    // Only overwrite the limit when `+l` was both present and parsed
    // successfully. If `+l` is absent from the modes list at all, the
    // server is telling us there is no limit — clear it.
    if (!modeChars.includes('l')) {
      ch.limit = 0;
    } else if (limitWasParsed) {
      ch.limit = limit;
    }

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

    const lower = this.lowerNick(nick);
    // Capture the previous account BEFORE the map write so the transition
    // check below sees the real delta. `undefined` means we've never
    // tracked this nick (treat as null for the purposes of firing events).
    const previous = this.networkAccounts.get(lower) ?? null;
    this.networkAccounts.set(lower, accountName);

    // Update accountName on all per-channel UserInfo objects for this nick
    this.updateUserAcrossChannels(lower, (user) => {
      user.accountName = accountName;
    });

    if (accountName) {
      this.logger?.debug(`account-notify: ${nick} identified as ${accountName}`);
    } else {
      this.logger?.debug(`account-notify: ${nick} deidentified`);
    }

    // Fire typed events on actual transitions so subscribers (chanmod's
    // auto-op reconciler, future auth-aware plugins) can react to late
    // identification / deidentification the same way they react to
    // explicit `verifyUser` results. A pure no-op (A→A) is suppressed so
    // a duplicate account-notify line from a buggy server doesn't trigger
    // spurious reconciles. An account switch (A→B) is treated as logout
    // then login and emits both events in order — this matches the rare
    // but real case on services that support re-identification mid-session.
    if (previous === accountName) return;
    if (previous !== null) {
      this.eventBus.emit('user:deidentified', nick, previous);
    }
    if (accountName !== null) {
      this.eventBus.emit('user:identified', nick, accountName);
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
    // Sanitize the away reason even though the bridge runs on PRIVMSG-style
    // events — AWAY notifications come through a different irc-framework
    // path and don't all hit the bridge's `sanitizeField`. A reason carrying
    // `\r\n` would otherwise surface verbatim wherever a plugin renders it.
    const rawMessage = typeof event.message === 'string' ? event.message : '';
    const message = sanitize(rawMessage);
    const lower = this.lowerNick(nick);

    const touched = this.updateUserAcrossChannels(lower, (user, ch) => {
      user.away = isAway;
      user.awayMessage = isAway ? message : undefined;
      this.eventBus.emit('channel:awayChanged', ch.name, nick, isAway);
    });

    if (touched) {
      this.logger?.debug(`away-notify: ${nick} is ${isAway ? 'away' : 'back'}`);
    }
  }

  /** IRCv3 chghost: fires when a user's displayed ident/hostname changes. */
  private onUserUpdated(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    // Sanitize chghost payloads — irc-framework delivers them via a
    // dedicated event that skips the bridge's PRIVMSG sanitize pass. A
    // malformed server (or a proxied event from a link compromise) could
    // ship `\r\n` in the new ident/hostname string and smuggle extra
    // lines through any plugin that echoes the field.
    const newIdent = event.new_ident !== undefined ? sanitize(String(event.new_ident)) : undefined;
    const newHostname =
      event.new_hostname !== undefined ? sanitize(String(event.new_hostname)) : undefined;

    const lower = this.lowerNick(nick);
    this.updateUserAcrossChannels(lower, (user) => {
      if (newIdent) user.ident = newIdent;
      if (newHostname) user.hostname = newHostname;
      user.hostmask = `${user.nick}!${user.ident}@${user.hostname}`;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Iterate every tracked channel and, for each one that has the user keyed
   * by `lowerNick`, invoke `update(user, channel)`. Returns true if at least
   * one channel was touched. Collapses the four "for (ch of channels) { get
   * user; if (!user) continue; mutate }" loops that were duplicated across
   * account/away/chghost/account-tag handlers — a dual-source-of-truth
   * hazard because missing any copy silently drops data.
   */
  private updateUserAcrossChannels(
    lowerNick: string,
    update: (user: UserInfo, channel: ChannelInfo) => void,
  ): boolean {
    let touched = false;
    for (const ch of this.channels.values()) {
      const user = ch.users.get(lowerNick);
      if (!user) continue;
      update(user, ch);
      touched = true;
    }
    return touched;
  }

  private lowerNick(nick: string): string {
    return ircLower(nick, this.casemapping);
  }

  private lowerChannel(name: string): string {
    return ircLower(name, this.casemapping);
  }

  /**
   * Get-or-create a channel record. Stores under the case-folded key so
   * subsequent lookups via either casing converge on the same record, but
   * preserves the original casing in `ChannelInfo.name` for display.
   */
  private ensureChannel(name: string): ChannelInfo {
    const lower = this.lowerChannel(name);
    let ch = this.channels.get(lower);
    if (!ch) {
      ch = { name, topic: '', modes: '', key: '', limit: 0, users: new Map() };
      this.channels.set(lower, ch);
    }
    return ch;
  }

  private listen(event: string, handler: (event: Record<string, unknown>) => void): void {
    this.listeners.on(event, (...args: unknown[]) => handler(toEventObject(args[0])));
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
