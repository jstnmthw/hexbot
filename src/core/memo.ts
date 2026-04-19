// HexBot — Memo system (MemoServ proxy)
//
// Two layers:
// 1. MemoServ relay — NOTICE online owners/masters so IRC-only admins get a
//    heads-up on new memos. Admins who currently have a DCC session are
//    skipped: they already see the raw `-MemoServ- …` line via the generic
//    notice mirror in dcc.ts, and notifying them again would produce a
//    duplicate on their IRC client. We also never info-log the notice text
//    itself — the mirror already surfaces it to DCC consoles, and logging
//    the text would double every line in the DCC log sink.
// 2. MemoServ proxy — .memo command that forwards subcommands to MemoServ and
//    lets the generic mirrors display MemoServ's raw reply. Only users with n
//    (owner) or m (master) flags can use .memo.
import type { CommandContext, CommandHandler } from '../command-handler';
import type { EventDispatcher } from '../dispatcher';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { Casemapping, HandlerContext, MemoConfig } from '../types';
import { ircLower } from '../utils/wildcard';
import { hasOwnerOrMaster } from './permissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for sending messages. */
export interface MemoIRCClient {
  notice(target: string, message: string): void;
  say(target: string, message: string): void;
}

/** Minimal DCC manager interface for console delivery. */
export interface MemoDCCManager {
  announce(message: string): void;
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(nick: string): { writeLine(line: string): void } | undefined;
}

/** Minimal channel state interface for finding online users. */
export interface MemoChannelState {
  getAllChannels(): Array<{ name: string; users: Map<string, { hostmask: string }> }>;
}

/** Minimal permissions interface for handle/flag lookups. */
export interface MemoPermissions {
  findByHostmask(fullHostmask: string): { handle: string; global: string } | null;
  listUsers(): Array<{ handle: string; global: string }>;
}

export interface MemoDeps {
  config?: MemoConfig;
  dispatcher: EventDispatcher;
  commandHandler: CommandHandler;
  permissions: MemoPermissions;
  channelState: MemoChannelState;
  client: MemoIRCClient;
  logger?: LoggerLike | null;
  dccManager?: MemoDCCManager | null;
  /**
   * Optional event bus for lifecycle hooks — wired so `attach()` can
   * prune `deliveryCooldown` when a user is removed. Without this, the
   * map accumulates entries for every admin that ever got a delivery
   * notification. See audit finding W-CS1 (2026-04-14).
   */
  eventBus?: BotEventBus;
  /**
   * Predicate: does this handle have an active DCC console via a botnet
   * relay into another bot? When true, `relayToOnlineAdmins` skips the
   * user — the DCC mirror fanout has already delivered the raw service
   * line through the relay, so a duplicate IRC notice would be noise.
   */
  hasRelayConsole?: (handle: string) => boolean;
}

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Required<MemoConfig> = {
  memoserv_relay: true,
  memoserv_nick: 'MemoServ',
  delivery_cooldown_seconds: 60,
};

const OWNER_ID = 'core:memo';

/**
 * Regex to parse "You have N new memo(s)" from MemoServ. Matches both Atheme
 * ("You have 3 new memos.") and Anope ("You have 1 new memo.") phrasing —
 * we capture only the count, ignoring singular/plural and any trailing text.
 */
const MEMO_COUNT_RE = /you have (\d+) new memo/i;

// ---------------------------------------------------------------------------
// MemoManager
// ---------------------------------------------------------------------------

export class MemoManager {
  private config: Required<MemoConfig>;
  private dispatcher: EventDispatcher;
  private commandHandler: CommandHandler;
  private permissions: MemoPermissions;
  private channelState: MemoChannelState;
  private client: MemoIRCClient;
  private logger: LoggerLike | null;
  private dccManager: MemoDCCManager | null;
  private hasRelayConsole: (handle: string) => boolean;
  private casemapping: Casemapping = 'rfc1459';
  private eventBus: BotEventBus | null;
  private onUserRemoved: ((handle: string) => void) | null = null;

  /** Number of unread memos reported by MemoServ. */
  pendingMemoCount = 0;

  /** Per-handle cooldown for join-delivery notifications. */
  private deliveryCooldown = new Map<string, number>();

  constructor(deps: MemoDeps) {
    this.config = { ...DEFAULTS, ...deps.config };
    this.dispatcher = deps.dispatcher;
    this.commandHandler = deps.commandHandler;
    this.permissions = deps.permissions;
    this.channelState = deps.channelState;
    this.client = deps.client;
    this.logger = deps.logger?.child('memo') ?? null;
    this.dccManager = deps.dccManager ?? null;
    this.hasRelayConsole = deps.hasRelayConsole ?? (() => false);
    this.eventBus = deps.eventBus ?? null;
  }

  /** Update casemapping when the server announces it. */
  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  private lowerNick(nick: string): string {
    return ircLower(nick, this.casemapping);
  }

  /** Set or replace the DCC manager reference (wired after DCC init). */
  setDCCManager(dcc: MemoDCCManager): void {
    this.dccManager = dcc;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Register all binds and commands. */
  attach(): void {
    this.registerMemoCommand();
    if (this.config.memoserv_relay) {
      this.registerMemoServRelay();
    }
    this.registerJoinDelivery();
    if (this.eventBus) {
      // Prune the delivery-cooldown entry when a user is removed so the
      // map doesn't accumulate entries for handles that no longer exist.
      this.onUserRemoved = (handle: string): void => {
        this.deliveryCooldown.delete(this.lowerNick(handle));
      };
      this.eventBus.on('user:removed', this.onUserRemoved);
    }
    this.logger?.info('Memo system attached');
  }

  /** Clean up timers and state. */
  detach(): void {
    this.dispatcher.unbindAll(OWNER_ID);
    this.commandHandler.unregisterCommand('memo');
    if (this.eventBus && this.onUserRemoved) {
      this.eventBus.off('user:removed', this.onUserRemoved);
      this.onUserRemoved = null;
    }
    this.deliveryCooldown.clear();
    this.logger?.info('Memo system detached');
  }

  // -------------------------------------------------------------------------
  // MemoServ notice handling
  // -------------------------------------------------------------------------

  /**
   * Route a MemoServ notice: parse the unread count and NOTICE IRC-only
   * admins. DCC/REPL sessions already see the raw notice via the generic
   * mirrors, so we don't announce to DCC here and we don't info-log the
   * text (the log sink would then deliver a second copy alongside the
   * mirror). A debug-level decision line is emitted when the count changes
   * so file logs still have a trace.
   */
  handleMemoServNotice(text: string): void {
    const countMatch = MEMO_COUNT_RE.exec(text);
    if (countMatch) {
      this.pendingMemoCount = parseInt(countMatch[1], 10);
    }

    const notified = this.relayToOnlineAdmins(`[MemoServ] ${text}`);
    if (countMatch) {
      this.logger?.debug(
        `MemoServ: ${this.pendingMemoCount} unread, notified ${notified} IRC-only admin(s)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // MemoServ relay (notice bind)
  // -------------------------------------------------------------------------

  private registerMemoServRelay(): void {
    this.dispatcher.bind(
      'notice',
      '-',
      '*',
      (ctx: HandlerContext) => {
        // Only private notices (not channel notices)
        if (ctx.channel) return;
        // Match sender nick against configured MemoServ nick
        if (this.lowerNick(ctx.nick) !== this.lowerNick(this.config.memoserv_nick)) return;

        this.handleMemoServNotice(ctx.text);
      },
      OWNER_ID,
    );
  }

  /**
   * NOTICE every online +n/+m admin who is *not* currently on the DCC
   * console. DCC-connected admins (locally, or via a botnet relay into
   * another bot) see the raw `-MemoServ- …` line via the generic mirror,
   * so relaying would duplicate. Returns the number of admins actually
   * notified.
   */
  private relayToOnlineAdmins(message: string): number {
    const seen = new Set<string>();
    let notified = 0;
    for (const ch of this.channelState.getAllChannels()) {
      for (const user of ch.users.values()) {
        const record = this.permissions.findByHostmask(user.hostmask);
        if (!record) continue;
        if (!hasOwnerOrMaster(record)) continue;
        const key = record.handle.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const nick = user.hostmask.split('!')[0];
        if (this.dccManager?.getSession(nick)) continue;
        if (this.hasRelayConsole(record.handle)) continue;
        this.client.notice(nick, message);
        notified++;
      }
    }
    return notified;
  }

  // -------------------------------------------------------------------------
  // .memo command (admin console)
  // -------------------------------------------------------------------------

  private registerMemoCommand(): void {
    this.commandHandler.registerCommand(
      'memo',
      {
        flags: '+m|+n',
        description: 'MemoServ proxy — read, send, and manage network memos',
        usage: '.memo [help|read|list|del|send|info]',
        category: 'memo',
      },
      (args, ctx) => this.handleMemoCommand(args, ctx),
    );
  }

  private handleMemoCommand(args: string, ctx: CommandContext): void {
    const trimmed = args.trim();
    if (!trimmed) {
      // Default: show pending count
      if (this.pendingMemoCount > 0) {
        ctx.reply(
          `MemoServ reports ${this.pendingMemoCount} unread memo(s). Type .memo list to view.`,
        );
      } else {
        ctx.reply('No pending memos from MemoServ.');
      }
      return;
    }

    const [sub, ...rest] = trimmed.split(/\s+/);

    switch (sub.toLowerCase()) {
      case 'help': {
        ctx.reply('MemoServ proxy commands:');
        ctx.reply('  .memo              — Show pending memo count');
        ctx.reply('  .memo read [last|new|<id>] — Read memo (default: last)');
        ctx.reply('  .memo list         — List all memos');
        ctx.reply('  .memo del <id|all> — Delete memo(s)');
        ctx.reply('  .memo send <nick> <message> — Send memo as bot');
        ctx.reply('  .memo info         — MemoServ settings/limits');
        break;
      }

      case 'read': {
        const arg = rest[0] ?? 'LAST';
        this.client.say(this.config.memoserv_nick, `READ ${arg.toUpperCase()}`);
        this.pendingMemoCount = 0;
        break;
      }

      case 'list': {
        this.client.say(this.config.memoserv_nick, 'LIST');
        this.pendingMemoCount = 0;
        break;
      }

      case 'del': {
        const target = rest[0];
        if (!target) {
          ctx.reply('Usage: .memo del <id|all>');
          return;
        }
        this.client.say(this.config.memoserv_nick, `DEL ${target.toUpperCase()}`);
        break;
      }

      case 'send': {
        if (rest.length < 2) {
          ctx.reply('Usage: .memo send <nick> <message>');
          return;
        }
        const nick = rest[0];
        // RFC-1459 nick shape plus a length cap. Without this, a crafted
        // `nick` argument could carry control characters into the
        // MemoServ command line or exploit the services-protocol parser
        // on the destination network.
        // Regex: first char is a letter or special (`_[]\`^{|}`); subsequent
        // 0-31 chars add digits and `-`. 32-char total cap matches the
        // RFC 2812 NICKLEN ceiling — networks may advertise lower via
        // ISUPPORT but never higher.
        if (!/^[A-Za-z_[\]\\`^{|}][A-Za-z0-9_[\]\\`^{|}-]{0,31}$/.test(nick)) {
          ctx.reply(`Invalid nick: "${nick}"`);
          return;
        }
        const message = trimmed.substring(trimmed.indexOf(nick) + nick.length).trim();
        if (message.length === 0) {
          ctx.reply('Usage: .memo send <nick> <message>');
          return;
        }
        this.client.say(this.config.memoserv_nick, `SEND ${nick} ${message}`);
        break;
      }

      case 'info': {
        this.client.say(this.config.memoserv_nick, 'INFO');
        break;
      }

      default:
        ctx.reply(`Unknown memo subcommand "${sub}". Type .memo help for usage.`);
    }
  }

  // -------------------------------------------------------------------------
  // Join delivery
  // -------------------------------------------------------------------------

  private registerJoinDelivery(): void {
    this.dispatcher.bind(
      'join',
      '-',
      '*',
      (ctx: HandlerContext) => {
        if (!ctx.channel) return;
        if (this.pendingMemoCount <= 0) return;

        const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
        const record = this.permissions.findByHostmask(hostmask);
        if (!record) return;
        if (!hasOwnerOrMaster(record)) return;

        const handleKey = record.handle.toLowerCase();
        const now = Date.now();
        const lastNotified = this.deliveryCooldown.get(handleKey) ?? 0;
        if (now - lastNotified < this.config.delivery_cooldown_seconds * 1000) return;

        this.deliveryCooldown.set(handleKey, now);
        this.client.notice(
          ctx.nick,
          `MemoServ reports ${this.pendingMemoCount} unread memo(s). Type .memo list to view.`,
        );
      },
      OWNER_ID,
    );
  }

  // -------------------------------------------------------------------------
  // DCC connect notification
  // -------------------------------------------------------------------------

  /** Call from onPartyJoin callback to notify on DCC connect. */
  notifyOnDCCConnect(_handle: string, nick: string): void {
    if (this.pendingMemoCount <= 0) return;
    const session = this.dccManager?.getSession(nick);
    if (session) {
      session.writeLine(
        `*** MemoServ reports ${this.pendingMemoCount} unread memo(s). Type .memo list to view.`,
      );
    }
  }
}
