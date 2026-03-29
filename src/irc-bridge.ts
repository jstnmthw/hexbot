// HexBot — IRC bridge
// Translates irc-framework events into dispatcher events.
// This is the trust boundary — all IRC data entering the dispatcher passes through here.
import type { MessageQueue } from './core/message-queue';
import type { EventDispatcher } from './dispatcher';
import type { Logger } from './logger';
import type { HandlerContext } from './types';
import { isModeArray, parseHostmask, toEventObject } from './utils/irc-event';
import { sanitize } from './utils/sanitize';
import { SlidingWindowCounter } from './utils/sliding-window';
import { splitMessage } from './utils/split-message';

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
}

interface IRCBridgeOptions {
  client: IRCClient;
  dispatcher: EventDispatcher;
  botNick: string;
  messageQueue?: MessageQueue | null;
  channelState?: ChannelStateProvider | null;
  logger?: Logger | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Duration after attach() during which topic events are suppressed (server join burst). */
const STARTUP_GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip IRC formatting/control characters (bold, color, underline, etc.) from text. */
const IRC_FORMATTING_CHARS = String.fromCharCode(0x02, 0x03, 0x0f, 0x16, 0x1d, 0x1e, 0x1f);
const IRC_COLOR_CHAR = String.fromCharCode(0x03);
const IRC_FORMAT_RE = new RegExp(
  `[${IRC_FORMATTING_CHARS}]|${IRC_COLOR_CHAR}\\d{1,2}(,\\d{1,2})?`,
  'g',
);
function stripFormatting(text: string): string {
  return text.replace(IRC_FORMAT_RE, '');
}

/** Validate channel name starts with # or &. */
function isValidChannel(name: string): boolean {
  return /^[#&]/.test(name);
}

// ---------------------------------------------------------------------------
// IRCBridge
// ---------------------------------------------------------------------------

export class IRCBridge {
  private client: IRCClient;
  private dispatcher: EventDispatcher;
  private botNick: string;
  private messageQueue: MessageQueue | null;
  private channelState: ChannelStateProvider | null;
  private logger: Logger | null;
  private listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private ctcpRateLimiter = new SlidingWindowCounter();
  private topicStartupGrace = false;

  constructor(options: IRCBridgeOptions) {
    this.client = options.client;
    this.dispatcher = options.dispatcher;
    this.botNick = options.botNick;
    this.messageQueue = options.messageQueue ?? null;
    this.channelState = options.channelState ?? null;
    this.logger = options.logger?.child('irc-bridge') ?? null;
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

    // Suppress topic events during the initial channel join burst
    this.topicStartupGrace = true;
    setTimeout(() => {
      this.topicStartupGrace = false;
    }, STARTUP_GRACE_MS);

    this.logger?.info('Attached to IRC client');
  }

  /** Remove all listeners (for clean shutdown). */
  detach(): void {
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

  /** Rate limit CTCP responses: max 3 per nick per 10 seconds. */
  private ctcpAllowed(nick: string): boolean {
    const WINDOW_MS = 10_000;
    const MAX_RESPONSES = 3;
    return !this.ctcpRateLimiter.check(nick, WINDOW_MS, MAX_RESPONSES);
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private onPrivmsg(event: Record<string, unknown>): void {
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const target = sanitize(String(event.target ?? ''));
    const message = sanitize(String(event.message ?? ''));

    const isChannel = isValidChannel(target);
    const channel = isChannel ? target : null;

    // Parse command and args from the message text
    const stripped = stripFormatting(message);
    const spaceIdx = stripped.indexOf(' ');
    const command = spaceIdx === -1 ? stripped : stripped.substring(0, spaceIdx);
    // Preserve IRC formatting in args — extract from the original unstripped message
    const firstSpace = message.indexOf(' ');
    const args = firstSpace === -1 ? '' : message.substring(firstSpace + 1).trim();

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: message,
      command,
      args,
    });

    // Build flood key: prefer full hostmask for accuracy, fall back to nick
    const floodKey = ident && hostname ? `${nick}!${ident}@${hostname}` : nick;

    if (isChannel) {
      const flood = this.dispatcher.floodCheck('pub', floodKey, ctx);
      if (flood.blocked) return;
      // Dispatch pub (exact command) and pubm (wildcard on full text)
      this.dispatcher.dispatch('pub', ctx).catch(this.dispatchError('pub'));
      this.dispatcher.dispatch('pubm', ctx).catch(this.dispatchError('pubm'));
    } else {
      const flood = this.dispatcher.floodCheck('msg', floodKey, ctx);
      if (flood.blocked) return;
      // Private message
      this.dispatcher.dispatch('msg', ctx).catch(this.dispatchError('msg'));
      this.dispatcher.dispatch('msgm', ctx).catch(this.dispatchError('msgm'));
    }
  }

  private onAction(event: Record<string, unknown>): void {
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const target = sanitize(String(event.target ?? ''));
    const message = sanitize(String(event.message ?? ''));

    const isChannel = isValidChannel(target);
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

    // Actions dispatch through pubm/msgm (wildcard text match)
    if (isChannel) {
      this.dispatcher.dispatch('pubm', ctx).catch(this.dispatchError('pubm'));
    } else {
      this.dispatcher.dispatch('msgm', ctx).catch(this.dispatchError('msgm'));
    }
  }

  private onJoin(event: Record<string, unknown>): void {
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const channel = sanitize(String(event.channel ?? ''));

    if (!isValidChannel(channel)) return;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: `${channel} ${nick}!${ident}@${hostname}`,
      command: 'JOIN',
      args: '',
    });

    this.dispatcher.dispatch('join', ctx).catch(this.dispatchError('join'));
  }

  private onPart(event: Record<string, unknown>): void {
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const channel = sanitize(event.channel as string);
    const message = sanitize(String(event.message ?? ''));

    if (!isValidChannel(channel)) return;

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
    const kicker = sanitize(String(event.nick ?? ''));
    const channel = sanitize(event.channel as string);
    const kicked = sanitize(String(event.kicked ?? ''));
    const message = sanitize(String(event.message ?? ''));

    if (!isValidChannel(channel)) return;

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
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const newNick = sanitize(String(event.new_nick ?? ''));

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
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const target = sanitize(event.target as string);
    if (!isModeArray(event.modes) || !isValidChannel(target)) return;
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
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const target = sanitize(String(event.target ?? ''));
    const message = sanitize(String(event.message ?? ''));

    const isChannel = isValidChannel(target);
    const channel = isChannel ? target : null;

    const ctx = this.buildContext({
      nick,
      ident,
      hostname,
      channel,
      text: message,
      command: 'NOTICE',
      args: message,
    });

    this.dispatcher.dispatch('notice', ctx).catch(this.dispatchError('notice'));
  }

  private onCtcp(event: Record<string, unknown>): void {
    const nick = sanitize(String(event.nick ?? ''));
    const ident = sanitize(String(event.ident ?? ''));
    const hostname = sanitize(String(event.hostname ?? ''));
    const type = sanitize(String(event.type ?? '')).toUpperCase();
    const rawMessage = sanitize(String(event.message ?? ''));

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

    if (!this.ctcpAllowed(nick)) return;
    this.dispatcher.dispatch('ctcp', ctx).catch(this.dispatchError('ctcp'));
  }

  private onTopic(event: Record<string, unknown>): void {
    if (this.topicStartupGrace) return;

    const channel = sanitize(event.channel as string);
    if (!isValidChannel(channel)) return;

    const nick = sanitize(event.nick as string);
    const ident = sanitize(event.ident as string);
    const hostname = sanitize(event.hostname as string);
    const topic = sanitize(event.topic as string);

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
    const nick = sanitize(event.nick as string);
    const ident = sanitize(event.ident as string);
    const hostname = sanitize(event.hostname as string);
    const message = sanitize(event.message as string);

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
    const nick = sanitize(event.nick as string);
    const ident = sanitize(event.ident as string);
    const hostname = sanitize(event.hostname as string);
    const channel = sanitize(event.channel as string);

    if (!isValidChannel(channel)) return;

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
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Wrap a typed handler for use with the generic irc-framework event API. */
  private listenIrc(event: string, handler: (event: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => handler(toEventObject(args[0]));
    this.client.on(event, fn);
    this.listeners.push({ event, fn });
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
    const enqueue = (fn: () => void) => {
      /* v8 ignore next -- queue.enqueue path: messageQueue is never set in tests (always null); tested via MessageQueue unit tests */
      if (queue) queue.enqueue(fn);
      else fn();
    };
    return {
      ...fields,
      reply: (msg: string) => {
        const target = fields.channel ?? fields.nick;
        const lines = splitMessage(sanitize(msg));
        for (const line of lines) {
          enqueue(() => client.say(target, line));
        }
      },
      replyPrivate: (msg: string) => {
        const lines = splitMessage(sanitize(msg));
        for (const line of lines) {
          enqueue(() => client.notice(fields.nick, line));
        }
      },
    };
  }

  private dispatchError(type: string): (err: unknown) => void {
    return (err) => {
      this.logger?.error(`Dispatch error (${type}):`, err);
    };
  }
}
