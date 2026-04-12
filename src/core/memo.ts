// HexBot — Memo system (MemoServ proxy)
//
// Two layers:
// 1. MemoServ relay — forward MemoServ notices to online owners/masters
// 2. MemoServ proxy — .memo command with subcommands to interact with MemoServ
//
// No local memo storage. The bot proxies commands to MemoServ and captures
// responses. Only users with n (owner) or m (master) flags can use .memo.
import type { CommandContext, CommandHandler } from '../command-handler';
import type { EventDispatcher } from '../dispatcher';
import type { Logger } from '../logger';
import type { Casemapping, HandlerContext, MemoConfig } from '../types';
import { ircLower } from '../utils/wildcard';

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
  logger?: Logger | null;
  dccManager?: MemoDCCManager | null;
}

// ---------------------------------------------------------------------------
// Pending request state for response capture
// ---------------------------------------------------------------------------

interface PendingRequest {
  ctx: CommandContext;
  buffer: string[];
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Required<MemoConfig> = {
  memoserv_relay: true,
  memoserv_nick: 'MemoServ',
  delivery_cooldown_seconds: 60,
  response_timeout_ms: 3000,
};

const OWNER_ID = 'core:memo';

/** Regex to parse "You have N new memo(s)" from MemoServ. */
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
  private logger: Logger | null;
  private dccManager: MemoDCCManager | null;
  private casemapping: Casemapping = 'rfc1459';

  /** Number of unread memos reported by MemoServ. */
  pendingMemoCount = 0;

  /** Active MemoServ request being captured. */
  private pendingRequest: PendingRequest | null = null;

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
  }

  /** Update casemapping when the server announces it. */
  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
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
    this.logger?.info('Memo system attached');
  }

  /** Clean up timers and state. */
  detach(): void {
    this.dispatcher.unbindAll(OWNER_ID);
    this.commandHandler.unregisterCommand('memo');
    if (this.pendingRequest) {
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest = null;
    }
    this.deliveryCooldown.clear();
    this.logger?.info('Memo system detached');
  }

  // -------------------------------------------------------------------------
  // MemoServ notice handling
  // -------------------------------------------------------------------------

  /** Route a MemoServ notice: to capture buffer if a request is pending, otherwise relay. */
  handleMemoServNotice(text: string): void {
    // Parse unread count from MemoServ notifications
    const countMatch = MEMO_COUNT_RE.exec(text);
    if (countMatch) {
      this.pendingMemoCount = parseInt(countMatch[1], 10);
    }

    // If a .memo command is waiting for a response, capture it
    if (this.pendingRequest) {
      this.pendingRequest.buffer.push(text);
      // Reset timeout — extend for each new line
      clearTimeout(this.pendingRequest.timer);
      this.pendingRequest.timer = setTimeout(
        () => this.deliverPendingResponse(),
        this.config.response_timeout_ms,
      );
      return;
    }

    // Unsolicited — relay to all admins
    this.logger?.info(`MemoServ relay: ${text}`);
    this.relayToOnlineAdmins(`[MemoServ] ${text}`);
    if (this.dccManager) {
      this.dccManager.announce(`*** [MemoServ] ${text}`);
    }
  }

  /** Deliver buffered response to the requesting session. */
  private deliverPendingResponse(): void {
    const req = this.pendingRequest;
    if (!req) return;
    this.pendingRequest = null;

    if (req.buffer.length === 0) {
      req.ctx.reply('No response from MemoServ.');
      return;
    }

    for (const line of req.buffer) {
      req.ctx.reply(`[MemoServ] ${line}`);
    }
  }

  /** Send a command to MemoServ and capture the response. */
  private sendToMemoServ(command: string, ctx: CommandContext): void {
    if (this.pendingRequest) {
      ctx.reply('MemoServ request in progress, try again in a moment.');
      return;
    }

    this.pendingRequest = {
      ctx,
      buffer: [],
      timer: setTimeout(() => this.deliverPendingResponse(), this.config.response_timeout_ms),
    };

    this.client.say(this.config.memoserv_nick, command);
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
        if (
          ircLower(ctx.nick, this.casemapping) !==
          ircLower(this.config.memoserv_nick, this.casemapping)
        )
          return;

        this.handleMemoServNotice(ctx.text);
      },
      OWNER_ID,
    );
  }

  /** Send a NOTICE to all online users with n/m flags. */
  private relayToOnlineAdmins(message: string): void {
    const seen = new Set<string>();
    for (const ch of this.channelState.getAllChannels()) {
      for (const user of ch.users.values()) {
        const record = this.permissions.findByHostmask(user.hostmask);
        if (!record) continue;
        if (!(record.global.includes('n') || record.global.includes('m'))) continue;
        const key = record.handle.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        this.client.notice(user.hostmask.split('!')[0], message);
      }
    }
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
        this.sendToMemoServ(`READ ${arg.toUpperCase()}`, ctx);
        // Reading memos clears the pending count
        this.pendingMemoCount = 0;
        break;
      }

      case 'list': {
        this.sendToMemoServ('LIST', ctx);
        this.pendingMemoCount = 0;
        break;
      }

      case 'del': {
        const target = rest[0];
        if (!target) {
          ctx.reply('Usage: .memo del <id|all>');
          return;
        }
        this.sendToMemoServ(`DEL ${target.toUpperCase()}`, ctx);
        break;
      }

      case 'send': {
        if (rest.length < 2) {
          ctx.reply('Usage: .memo send <nick> <message>');
          return;
        }
        const nick = rest[0];
        // Preserve the original message text (don't lose spacing from split)
        const message = trimmed.substring(trimmed.indexOf(nick) + nick.length).trim();
        this.sendToMemoServ(`SEND ${nick} ${message}`, ctx);
        break;
      }

      case 'info': {
        this.sendToMemoServ('INFO', ctx);
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
        if (!(record.global.includes('n') || record.global.includes('m'))) return;

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
