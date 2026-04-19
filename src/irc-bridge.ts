// HexBot — IRC bridge
// Translates irc-framework events into dispatcher events.
// This is the trust boundary — all IRC data entering the dispatcher passes through here.
import { extractAccountTag, sanitizeField } from './core/irc-event-helpers';
import { type ServerCapabilities, defaultServerCapabilities } from './core/isupport';
import type { MessageQueue } from './core/message-queue';
import type { EventDispatcher } from './dispatcher';
import type { LoggerLike } from './logger';
import type { BindType, HandlerContext } from './types';
import { isModeArray, parseHostmask, toEventObject } from './utils/irc-event';
import { sanitize } from './utils/sanitize';
import { SlidingWindowCounter } from './utils/sliding-window';
import { splitMessage } from './utils/split-message';
import { stripFormatting } from './utils/strip-formatting';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal irc-framework Client interface (for testability). */
export interface IRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  ctcpResponse(target: string, type: string, ...params: string[]): void;
}

interface ChannelStateProvider {
  getUserHostmask(channel: string, nick: string): string | undefined;
  /** Optional: push an account mapping discovered via IRCv3 `account-tag`. */
  setAccountForNick?(nick: string, account: string | null): void;
}

interface IRCBridgeOptions {
  client: IRCClient;
  dispatcher: EventDispatcher;
  botNick: string;
  messageQueue?: MessageQueue | null;
  channelState?: ChannelStateProvider | null;
  logger?: LoggerLike | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Duration after attach() during which topic events are suppressed (server join burst). */
const STARTUP_GRACE_MS = 5000;

// IRCv3 caps that irc-framework requests on our behalf but we deliberately
// do NOT consume here:
//
// - `server-time`: surfaced as `event.time` on every message. Hexbot uses
//   wall-clock time for ban expiry and mod-log timestamps; replaying a
//   bouncer's `chathistory` window would mistime these, but we don't
//   consume chathistory either, so there's nothing to mis-time. Plugins
//   that care (relay bridges, log stores) can read `event.time` off the
//   raw irc-framework event directly until we ship a consumer.
// - `batch`: surfaced as `event.batch`. Relevant for netsplit QUIT
//   bundles and chathistory replay. Hexbot treats every event as
//   independent, which produces extra noise during a netsplit but is
//   correct behaviourally. Revisit if we add a relay/log plugin that
//   needs batch boundaries.
// - `echo-message`: irc-framework gates this behind `enable_echomessage`.
//   Leaving it off means our own PRIVMSGs don't come back — plugins
//   wanting reply confirmation must track sends client-side.
//
// See docs/audits/irc-logic-2026-04-11.md §A.2 for the full capability
// survey that motivated this set of tradeoffs.

// ---------------------------------------------------------------------------
// IRCBridge
// ---------------------------------------------------------------------------

export class IRCBridge {
  private client: IRCClient;
  private dispatcher: EventDispatcher;
  private botNick: string;
  private messageQueue: MessageQueue | null;
  private channelState: ChannelStateProvider | null;
  private logger: LoggerLike | null;
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private ctcpRateLimiter = new SlidingWindowCounter();
  private topicStartupGrace = false;
  private topicStartupGraceTimer: NodeJS.Timeout | null = null;
  private capabilities: ServerCapabilities = defaultServerCapabilities();

  constructor(options: IRCBridgeOptions) {
    this.client = options.client;
    this.dispatcher = options.dispatcher;
    this.botNick = options.botNick;
    this.messageQueue = options.messageQueue ?? null;
    this.channelState = options.channelState ?? null;
    this.logger = options.logger?.child('irc-bridge') ?? null;
  }

  /**
   * Apply a parsed ISUPPORT snapshot. `isValidChannel` uses the advertised
   * `CHANTYPES` so `!channel` on IRCnet-style networks is accepted instead
   * of being silently dropped by the old hardcoded `[#&]` check.
   */
  setCapabilities(caps: ServerCapabilities): void {
    this.capabilities = caps;
  }

  private isValidChannel(name: string): boolean {
    return this.capabilities.isValidChannel(name);
  }

  /** Register all irc-framework event listeners. */
  attach(): void {
    this.listenIrc('privmsg', this.onPrivmsg.bind(this));
    this.listenIrc('action', this.onAction.bind(this));
    this.listenIrc('join', this.onJoin.bind(this));
    this.listenIrc('part', this.onPart.bind(this));
    this.listenIrc('kick', this.onKick.bind(this));
    this.listenIrc('nick', this.onNick.bind(this));
    this.listenIrc('mode', this.onMode.bind(this));
    this.listenIrc('notice', this.onNotice.bind(this));
    this.listenIrc('ctcp request', this.onCtcp.bind(this));
    this.listenIrc('topic', this.onTopic.bind(this));
    this.listenIrc('quit', this.onQuit.bind(this));
    this.listenIrc('invite', this.onInvite.bind(this));

    // Join-error numerics (471/473/474/475) via irc-framework's 'irc error' event
    this.listenIrc('irc error', this.onIrcError.bind(this));
    // 477 (need to register nick) is unknown to irc-framework — catch via raw numeric
    this.listenIrc('unknown command', this.onUnknownCommand.bind(this));

    // Suppress topic events during the initial channel join burst
    this.topicStartupGrace = true;
    this.topicStartupGraceTimer = setTimeout(() => {
      this.topicStartupGrace = false;
      this.topicStartupGraceTimer = null;
    }, STARTUP_GRACE_MS);

    this.logger?.info('Attached to IRC client');
  }

  /** Remove all listeners (for clean shutdown). */
  detach(): void {
    if (this.topicStartupGraceTimer) {
      clearTimeout(this.topicStartupGraceTimer);
      this.topicStartupGraceTimer = null;
    }
    this.topicStartupGrace = false;
    for (const { event, fn } of this.listeners) {
      this.client.removeListener(event, fn);
    }
    this.listeners = [];
    this.dispatcher.unbindAll('core');
    this.logger?.info('Detached from IRC client');
  }

  /** Update the bot nick (e.g., after a nick change). */
  setBotNick(nick: string): void {
    this.botNick = nick;
  }

  // -------------------------------------------------------------------------
  // Built-in CTCP handlers
  // -------------------------------------------------------------------------

  /**
   * Rate limit CTCP responses: max 3 per sender per 10 seconds.
   *
   * Keyed by the persistent portion of the identity (`ident@host`) so an
   * attacker can't dodge the limit by rotating nicks between CTCP floods.
   * See §11 of `docs/audits/irc-logic-2026-04-11.md`.
   */
  private ctcpAllowed(senderKey: string): boolean {
    const WINDOW_MS = 10_000;
    const MAX_RESPONSES = 3;
    return !this.ctcpRateLimiter.check(senderKey, WINDOW_MS, MAX_RESPONSES);
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private onPrivmsg(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const target = sanitizeField(event, 'target');
    const message = sanitizeField(event, 'message');

    const isChannel = this.isValidChannel(target);
    const channel = isChannel ? target : null;
    const account = this.checkAccount(event, nick);
    const { command, args } = this.parseCommand(message);

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: message,
      command,
      args,
    });
    if (account !== undefined) ctx.account = account;

    if (isChannel) {
      this.dispatchMessage('pub', { nick, ident, hostname, ctx }, ['pub', 'pubm']);
    } else {
      this.dispatchMessage('msg', { nick, ident, hostname, ctx }, ['msg', 'msgm']);
    }
  }

  private onAction(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const target = sanitizeField(event, 'target');
    const message = sanitizeField(event, 'message');

    const isChannel = this.isValidChannel(target);
    const channel = isChannel ? target : null;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: message,
      command: '',
      args: message,
    });

    // CTCP ACTION is the same primitive as PRIVMSG from the spam/flood
    // perspective — one inbound frame counts against the same bucket so an
    // attacker can't just spam `/me` to bypass the pub/msg flood limit.
    if (isChannel) {
      this.dispatchMessage('pub', { nick, ident, hostname, ctx }, ['pubm']);
    } else {
      this.dispatchMessage('msg', { nick, ident, hostname, ctx }, ['msgm']);
    }
  }

  private onJoin(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const channel = sanitizeField(event, 'channel');

    if (!this.isValidChannel(channel)) return;

    // extended-join surfaces the services account name on the JOIN event. We
    // prime the dispatcher's fast path and stamp the ctx so flag-gated binds
    // (and auto-op specifically) can skip a NickServ ACC round-trip when the
    // server has already vouched for the joiner.
    const account = this.checkAccount(event, nick);

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: `${channel} ${nick}!${ident}@${hostname}`,
      command: 'JOIN',
      args: '',
    });
    if (account !== undefined) ctx.account = account;

    this.dispatcher.dispatch('join', ctx).catch(this.dispatchError('join'));
  }

  private onPart(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const channel = sanitizeField(event, 'channel');
    const message = sanitizeField(event, 'message');

    if (!this.isValidChannel(channel)) return;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: `${channel} ${nick}!${ident}@${hostname}`,
      command: 'PART',
      args: message,
    });

    this.dispatcher.dispatch('part', ctx).catch(this.dispatchError('part'));
  }

  private onKick(event: Record<string, unknown>): void {
    const kicker = sanitizeField(event, 'nick');
    const channel = sanitizeField(event, 'channel');
    const kicked = sanitizeField(event, 'kicked');
    const message = sanitizeField(event, 'message');

    if (!this.isValidChannel(channel)) return;

    // Look up the kicked user's hostmask from channel state (more accurate than the kicker's ident/hostname)
    const kickedHostmask = this.channelState?.getUserHostmask(channel, kicked);
    const { ident: kickedIdent, hostname: kickedHostname } = kickedHostmask
      ? parseHostmask(kickedHostmask)
      : { ident: '', hostname: '' };

    // For kick events, the context nick is the kicked user
    const reason = message ? `${message} (by ${kicker})` : `by ${kicker}`;
    const ctx = this.buildContext({
      nick: kicked,
      ident: kickedIdent,
      hostname: kickedHostname,
      channel,
      text: `${channel} ${kicked}!${kickedIdent}@${kickedHostname}`,
      command: 'KICK',
      args: reason,
    });

    this.dispatcher.dispatch('kick', ctx).catch(this.dispatchError('kick'));
  }

  private onNick(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const newNick = sanitizeField(event, 'new_nick');

    // Track bot's own nick changes
    if (nick === this.botNick) {
      this.botNick = newNick;
    }

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel: null,
      text: newNick,
      command: 'NICK',
      args: newNick,
    });

    this.dispatcher.dispatch('nick', ctx).catch(this.dispatchError('nick'));
  }

  private onMode(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const target = sanitizeField(event, 'target');
    if (!isModeArray(event.modes) || !this.isValidChannel(target)) return;
    const modes = event.modes;

    // Break compound modes into individual dispatches
    for (const m of modes) {
      const modeStr = sanitize(String(m.mode ?? ''));
      const param = m.param ? sanitize(String(m.param)) : '';
      const modeText = `${target} ${modeStr}${param ? ' ' + param : ''}`;

      const ctx = this.buildContext({
        nick,
        ident,
        hostname,
        channel: target,
        text: modeText,
        command: modeStr,
        args: param,
      });

      this.dispatcher.dispatch('mode', ctx).catch(this.dispatchError('mode'));
    }
  }

  private onNotice(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const target = sanitizeField(event, 'target');
    const message = sanitizeField(event, 'message');

    const isChannel = this.isValidChannel(target);
    const channel = isChannel ? target : null;

    // RFC 2812 §3.3.2: "automatic replies MUST NEVER be sent in response to
    // a NOTICE message." Hexbot parses commands only in onPrivmsg — this
    // path never dispatches to pub/msg binds, only to notice/rawlog binds.
    // Keep it that way when refactoring.
    const account = this.checkAccount(event, nick);

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: message,
      command: 'NOTICE',
      args: message,
    });
    if (account !== undefined) ctx.account = account;

    this.dispatcher.dispatch('notice', ctx).catch(this.dispatchError('notice'));
  }

  private onCtcp(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const type = sanitizeField(event, 'type').toUpperCase();
    const rawMessage = sanitizeField(event, 'message');

    // irc-framework includes the CTCP type in the message (e.g. "PING 1234567890").
    // Strip the type prefix so ctx.text contains only the payload.
    const payload = rawMessage.startsWith(type + ' ')
      ? rawMessage.substring(type.length + 1)
      : rawMessage === type
        ? ''
        : rawMessage;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel: null,
      text: payload,
      command: type,
      args: payload,
    });

    // Keyed on `ident@host` (the *persistent* portion of the identity)
    // so a nick-rotation attack can't bypass the per-sender limit. The
    // audit called this "full hostmask", but the nick is the rotatable
    // bit — dropping it is what closes the loophole. Falls back to the
    // nick only if both ident and hostname are empty, which is rare and
    // typically indicates a server-generated pseudo-source.
    this.logger?.info(
      `CTCP ${type}${payload ? ' ' + payload : ''} from ${nick}!${ident}@${hostname}`,
    );

    const rateLimitKey = ident && hostname ? `${ident}@${hostname}` : nick;
    if (!this.ctcpAllowed(rateLimitKey)) return;
    this.dispatcher.dispatch('ctcp', ctx).catch(this.dispatchError('ctcp'));
  }

  private onTopic(event: Record<string, unknown>): void {
    if (this.topicStartupGrace) return;

    const channel = sanitizeField(event, 'channel');
    if (!this.isValidChannel(channel)) return;

    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const topic = sanitizeField(event, 'topic');

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: topic,
      command: 'topic',
      args: '',
    });

    this.dispatcher.dispatch('topic', ctx).catch(this.dispatchError('topic'));
  }

  private onQuit(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const message = sanitizeField(event, 'message');

    // Don't dispatch the bot's own quit
    if (nick === this.botNick) return;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel: null,
      text: message,
      command: 'quit',
      args: '',
    });

    this.dispatcher.dispatch('quit', ctx).catch(this.dispatchError('quit'));
  }

  private onInvite(event: Record<string, unknown>): void {
    const nick = sanitizeField(event, 'nick');
    const ident = sanitizeField(event, 'ident');
    const hostname = sanitizeField(event, 'hostname');
    const channel = sanitizeField(event, 'channel');

    if (!this.isValidChannel(channel)) return;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: `${channel} ${nick}!${ident}@${hostname}`,
      command: 'INVITE',
      args: '',
    });

    this.dispatcher.dispatch('invite', ctx).catch(this.dispatchError('invite'));
  }

  // -------------------------------------------------------------------------
  // Join-error dispatching (471/473/474/475/477)
  // -------------------------------------------------------------------------

  /** Known irc-framework error names that map to join failures. */
  private static readonly JOIN_ERROR_NAMES = new Set([
    'channel_is_full',
    'invite_only_channel',
    'banned_from_channel',
    'bad_channel_key',
  ]);

  private onIrcError(event: Record<string, unknown>): void {
    const error = String(event.error ?? '');
    if (!IRCBridge.JOIN_ERROR_NAMES.has(error)) return;

    const channel = sanitizeField(event, 'channel');
    if (!this.isValidChannel(channel)) return;

    const reason = sanitizeField(event, 'reason');

    const ctx = this.buildContext({
      nick: this.botNick,
      ident: '',
      hostname: '',
      channel,
      text: reason,
      command: error,
      args: '',
    });

    this.dispatcher.dispatch('join_error', ctx).catch(this.dispatchError('join_error'));
  }

  private onUnknownCommand(event: Record<string, unknown>): void {
    if (String(event.command ?? '') !== '477') return;

    const params = Array.isArray(event.params) ? (event.params as unknown[]) : [];
    const channel = sanitize(String(params[1] ?? ''));
    if (!this.isValidChannel(channel)) return;

    const reason = sanitize(String(params.slice(2).join(' ') || ''));

    const ctx = this.buildContext({
      nick: this.botNick,
      ident: '',
      hostname: '',
      channel,
      text: reason,
      command: 'need_registered_nick',
      args: '',
    });

    this.dispatcher.dispatch('join_error', ctx).catch(this.dispatchError('join_error'));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Wrap a typed handler for use with the generic irc-framework event API. */
  private listenIrc(event: string, handler: (event: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => handler(toEventObject(args[0]));
    this.client.on(event, fn);
    this.listeners.push({ event, fn });
  }

  /**
   * Extract the IRCv3 `account-tag` from an event and prime the
   * channel-state fast path with it. Returns the raw tag value so callers
   * can stamp it onto the dispatched `HandlerContext` unchanged.
   */
  private checkAccount(event: Record<string, unknown>, nick: string): string | null | undefined {
    const account = extractAccountTag(event);
    if (account !== undefined && nick && this.channelState?.setAccountForNick) {
      // Feed the dispatcher's verification fast-path so `n`/`m`-flagged
      // commands stop needing a round-trip NickServ ACC query on every hit.
      this.channelState.setAccountForNick(nick, account);
    }
    return account;
  }

  /**
   * Split an incoming PRIVMSG body into `command` and `args`. The command
   * token is taken from the formatting-stripped text (so `\x02.foo\x02`
   * parses as `.foo`), while `args` is sliced from the original message to
   * preserve embedded formatting for downstream handlers.
   */
  private parseCommand(message: string): { command: string; args: string } {
    const stripped = stripFormatting(message);
    const spaceIdx = stripped.indexOf(' ');
    const command = spaceIdx === -1 ? stripped : stripped.substring(0, spaceIdx);
    const firstSpace = message.indexOf(' ');
    const args = firstSpace === -1 ? '' : message.substring(firstSpace + 1).trim();
    return { command, args };
  }

  /**
   * Flood-check a PRIVMSG/ACTION and fan it out to one or more dispatcher
   * event types. The flood key prefers the full hostmask for accuracy and
   * falls back to the bare nick when ident/host are missing.
   */
  private dispatchMessage(
    floodType: 'pub' | 'msg',
    source: { nick: string; ident: string; hostname: string; ctx: HandlerContext },
    dispatchTypes: BindType[],
  ): void {
    const { nick, ident, hostname, ctx } = source;
    const floodKey = ident && hostname ? `${nick}!${ident}@${hostname}` : nick;
    const flood = this.dispatcher.floodCheck(floodType, floodKey, ctx);
    if (flood.blocked) return;
    for (const type of dispatchTypes) {
      this.dispatcher.dispatch(type, ctx).catch(this.dispatchError(type));
    }
  }

  private buildContext(fields: {
    nick: string;
    ident: string;
    hostname: string;
    channel: string | null;
    text: string;
    command: string;
    args: string;
  }): HandlerContext {
    const client = this.client;
    const queue = this.messageQueue;
    const enqueue = (target: string, fn: () => void) => {
      /* v8 ignore next -- queue.enqueue path: messageQueue is never set in tests (always null); tested via MessageQueue unit tests */
      if (queue) queue.enqueue(target, fn);
      else fn();
    };
    return {
      ...fields,
      reply: (msg: string) => {
        const target = fields.channel ?? fields.nick;
        const lines = splitMessage(sanitize(msg));
        for (const line of lines) {
          enqueue(target, () => client.say(target, line));
        }
      },
      replyPrivate: (msg: string) => {
        const lines = splitMessage(sanitize(msg));
        for (const line of lines) {
          enqueue(fields.nick, () => client.notice(fields.nick, line));
        }
      },
    };
  }

  private dispatchError(type: BindType): (err: unknown) => void {
    return (err) => {
      this.logger?.error(`Dispatch error (${type}):`, err);
    };
  }
}
