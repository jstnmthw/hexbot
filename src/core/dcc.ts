// HexBot — DCC CHAT + Console
// Implements passive DCC CHAT for remote administration and a shared console
// where connected users can manage the bot and chat with each other.
//
// Flow:
//   1. User sends CTCP "DCC CHAT chat 0 0 <token>" to the bot (passive request)
//   2. DCCManager checks flags, allocates a TCP port, sends CTCP reply with port
//   3. User's client connects; DCCSession takes over the socket
//   4. Lines starting with '.' are routed through CommandHandler
//   5. Plain text is broadcast to all other connected sessions (party line)
import { createServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { createInterface as createReadline } from 'node:readline';

import type { CommandExecutor } from '../command-handler';
import type { BindRegistrar } from '../dispatcher';
import type { Logger } from '../logger';
import type {
  DccConfig,
  HandlerContext,
  PluginPermissions,
  PluginServices,
  UserRecord,
} from '../types';
import { toEventObject } from '../utils/irc-event';
import { sanitize } from '../utils/sanitize';
import { type Casemapping, ircLower } from '../utils/wildcard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed by DCCManager. */
export interface DCCIRCClient {
  notice(target: string, message: string): void;
  ctcpRequest(target: string, type: string, ...params: string[]): void;
  ctcpResponse(target: string, type: string, ...params: string[]): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

/** Port allocation strategy — injectable for testing. */
export interface PortAllocator {
  /** Find a free port, or null if exhausted. Does NOT mark as used. */
  allocate(): number | null;
  /** Mark a port as in use. */
  markUsed(port: number): void;
  /** Release a port back to the pool. */
  release(port: number): void;
}

/** Default port allocator: scans a contiguous range [min, max]. */
export class RangePortAllocator implements PortAllocator {
  private readonly used = new Set<number>();

  constructor(private readonly range: [number, number]) {}

  allocate(): number | null {
    const [min, max] = this.range;
    for (let p = min; p <= max; p++) {
      if (!this.used.has(p)) return p;
    }
    return null;
  }

  markUsed(port: number): void {
    this.used.add(port);
  }

  release(port: number): void {
    this.used.delete(port);
  }
}

/** The subset of DCCManager that DCCSession depends on. */
export interface DCCSessionManager {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  broadcast(fromHandle: string, message: string): void;
  announce(message: string): void;
  removeSession(nick: string): void;
  notifyPartyPart(handle: string, nick: string): void;
  getBotName(): string;
  onRelayEnd?: ((handle: string, targetBot: string) => void) | null;
}

/** The subset of DCCSession that DCCManager and consumers depend on. */
export interface DCCSessionEntry {
  readonly handle: string;
  readonly nick: string;
  readonly connectedAt: number;
  readonly isRelaying: boolean;
  writeLine(line: string): void;
  close(reason?: string): void;
  enterRelay(targetBot: string, callback: (line: string) => void): void;
  exitRelay(): void;
}

/** The subset of DCCManager that botlink-commands depends on. */
export interface BotlinkDCCView {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(nick: string):
    | {
        handle: string;
        isRelaying: boolean;
        enterRelay(targetBot: string, callback: (line: string) => void): void;
      }
    | undefined;
  announce?(message: string): void;
}

export interface DCCManagerDeps {
  client: DCCIRCClient;
  dispatcher: BindRegistrar;
  permissions: PluginPermissions;
  services: PluginServices;
  commandHandler: CommandExecutor;
  config: DccConfig;
  version: string;
  botNick: string;
  logger?: Logger | null;
  /** Injectable session store. Default: new Map(). */
  sessions?: Map<string, DCCSessionEntry>;
  /** Injectable port allocator. Default: RangePortAllocator from config.port_range. */
  portAllocator?: PortAllocator;
}

interface PendingDCC {
  nick: string;
  user: UserRecord;
  ident: string;
  hostname: string;
  server: NetServer;
  port: number;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Convert a dotted IPv4 string to a 32-bit unsigned decimal integer,
 * as required by the DCC CTCP protocol.
 *
 * @example ipToDecimal('1.2.3.4') === 16909060
 */
export function ipToDecimal(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  let result = 0;
  for (const part of parts) {
    const byte = parseInt(part, 10);
    if (!Number.isFinite(byte) || byte < 0 || byte > 255) return 0;
    result = (result << 8) | byte;
  }
  // Treat as unsigned 32-bit
  return result >>> 0;
}

export interface DccChatPayload {
  subtype: string; // e.g. 'CHAT'
  ip: number;
  port: number;
  token: number; // 0 if not present (active DCC)
}

/**
 * Parse a DCC CTCP payload string into its components.
 * Returns null on parse failure or if subtype is not 'CHAT'.
 *
 * Active DCC:  "CHAT chat <ip> <port>"
 * Passive DCC: "CHAT chat 0 0 <token>"
 */
export function parseDccChatPayload(args: string): DccChatPayload | null {
  const parts = args.trim().split(/\s+/);
  // Minimum: "CHAT chat <ip> <port>" = 4 tokens
  if (parts.length < 4) return null;

  const subtype = parts[0].toUpperCase();
  if (subtype !== 'CHAT') return null;

  const ip = parseInt(parts[2], 10);
  const port = parseInt(parts[3], 10);
  const token = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;

  if (!Number.isFinite(ip) || !Number.isFinite(port)) return null;

  return { subtype, ip, port, token };
}

/** Returns true if the DCC request is passive (port=0 with a token).
 *  Some clients (e.g. mIRC) send their real IP with port=0; others send ip=0.
 *  Port=0 is the universal passive-DCC indicator. */
export function isPassiveDcc(_ip: number, port: number): boolean {
  return port === 0;
}

// ---------------------------------------------------------------------------
// DCCSession
// ---------------------------------------------------------------------------

// ASCII logo placeholder — replace BANNER_LOGO lines with your own art.
// Each entry is one line of text sent to the user's DCC CHAT window.
const BANNER_LOGO = [
  '⠀⠀⠀⠀⣠⣤⣶⣶⣶⣤⣄⡀⠀⠀⠀',
  '⠀⠀⣴⣾⣿⣿⣿⣿⣿⣧⡀⠈⠢⠀⠀',
  '⠀⣼⣿⣿⣿⣿⣿⣿⣿⡿⠁⠀⠀⠀⠀      dBP dBP dBBBP`Bb  .BP    dBBBBb  dBBBBP dBBBBBBP',
  '⢰⡿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀                    .BP.P        dBP  dBP.BP    ',
  "⠘⣽⡿⠿⠿⣿⣿⣿⣿⣿⣦⣤⡀⠀⠀   dBBBBBP dBBP     dBK     dBBBK'  dBP.BP   dBP",
  "⠀⣟⠀⠀⠀⣸⣿⡏⠀⠀⠀⢹⠗⠀⠀⠀  dBP dBP dBP      dB'dB   dB' db  dBP.BP   dBP",
  "⠀⣿⣷⣶⣾⡿⠁⠙⣄⣀⣀⣠⡀⠀⠀ dBP dBP dBBBBP   dB' dBP dBBBBP' dBBBBP   dBP",
  '⠀⠙⠙⢿⡿⣷⣶⣤⣿⣿⡿⠿⠃⠀⠀',
  '⠀⠀⠀⠺⡏⡏⡏⡏⡏⠉⠁⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠁⠁⠀⠀⠀⠀⠀⠀⠀⠀',
];

export class DCCSession implements DCCSessionEntry {
  readonly handle: string;
  readonly flags: string;
  readonly nick: string;
  readonly ident: string;
  readonly hostname: string;
  readonly connectedAt: number;

  private socket: Socket;
  private manager: DCCSessionManager;
  private commandHandler: CommandExecutor;
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private logger: Logger | null;

  constructor(opts: {
    manager: DCCSessionManager;
    user: UserRecord;
    nick: string;
    ident: string;
    hostname: string;
    socket: Socket;
    commandHandler: CommandExecutor;
    idleTimeoutMs: number;
    logger?: Logger | null;
  }) {
    this.manager = opts.manager;
    this.handle = opts.user.handle;
    this.flags = opts.user.global;
    this.nick = opts.nick;
    this.ident = opts.ident;
    this.hostname = opts.hostname;
    this.socket = opts.socket;
    this.commandHandler = opts.commandHandler;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.connectedAt = Date.now();
    this.logger = opts.logger ?? null;
  }

  /** Start the session: send banner, begin readline loop. */
  start(version: string, botNick: string): void {
    // Wrap socket in readline — DCC uses \r\n but readline handles both
    const rl = createReadline({ input: this.socket, crlfDelay: Infinity });

    // Banner
    const now = new Date().toLocaleString();
    const platform = `Node.js ${process.version} on ${process.platform}`;
    const others = this.manager
      .getSessionList()
      .filter((s) => s.handle !== this.handle)
      .map((s) => s.handle);
    const onConsole =
      others.length > 0
        ? `${others.length} other(s) here: ${others.join(', ')}`
        : 'you are the only one here';

    for (const line of BANNER_LOGO) {
      this.writeLine(line);
    }
    this.writeLine('');
    this.writeLine(
      `Hey ${this.handle}! My name is ${botNick} and I am running HexBot v${version},`,
    );
    this.writeLine(`on ${platform}.`);
    this.writeLine('');
    this.writeLine(`Local time is now ${now}`);
    this.writeLine('');
    this.writeLine(`Logged in as: ${this.handle} (${this.nick}!${this.ident}@${this.hostname})`);
    this.writeLine(`Your flags: +${this.flags || '-'}`);
    if (this.flags.includes('n')) {
      this.writeLine('');
      this.writeLine('You are an owner of this bot. Only +n users can see this.');
    }
    this.writeLine('');
    this.writeLine(`Console: ${onConsole}`);
    this.writeLine('');
    this.writeLine('Use .help for basic help.');
    this.writeLine('Use .help <command> for help on a specific command.');
    this.writeLine('Use .console to see who is currently on the console.');
    this.writeLine('');
    this.writeLine("Commands start with '.' (like '.quit' or '.help')");
    this.writeLine('Everything else goes out to the console.');

    this.resetIdle();

    rl.on('line', (line: string) => {
      this.onLine(line);
    });

    this.socket.on('close', () => this.onClose());
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.socket.on('error', () => this.onClose());
  }

  /** Write a line followed by \r\n. No-op if socket is destroyed. */
  writeLine(line: string): void {
    this.write(line + '\r\n');
  }

  private write(data: string): void {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(data);
    }
  }

  /** Relay callback — when set, all input is forwarded here instead of processed locally. */
  private _relayCallback: ((line: string) => void) | null = null;
  private _relayTarget: string | null = null;

  /** Put this session into relay mode. All input goes to the callback. */
  enterRelay(targetBot: string, callback: (line: string) => void): void {
    this._relayCallback = callback;
    this._relayTarget = targetBot;
  }

  /** Exit relay mode. */
  exitRelay(): void {
    this._relayCallback = null;
    this._relayTarget = null;
  }

  /** True if the session is currently relayed to a remote bot. */
  get isRelaying(): boolean {
    return this._relayCallback !== null;
  }

  get relayTarget(): string | null {
    return this._relayTarget;
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    this.resetIdle();

    if (!trimmed) return;

    // Relay mode: forward input to remote bot
    if (this._relayCallback) {
      if (trimmed === '.relay end' || trimmed === '.quit') {
        const target = this._relayTarget;
        this.exitRelay();
        this.writeLine(`*** Relay ended. Back on ${this.manager.getBotName()}.`);
        this.manager.onRelayEnd?.(this.handle, target!);
        return;
      }
      this._relayCallback(trimmed);
      return;
    }

    // DCC-only session management commands
    if (trimmed === '.quit' || trimmed === '.exit') {
      this.close('Disconnected.');
      return;
    }

    if (trimmed === '.console' || trimmed === '.who') {
      const list = this.manager.getSessionList();
      if (list.length === 0) {
        this.writeLine('No users on the console.');
      } else {
        this.writeLine(`Console (${list.length}):`);
        for (const s of list) {
          const marker = s.handle === this.handle ? ' (you)' : '';
          const uptime = Math.floor((Date.now() - s.connectedAt) / 1000);
          this.writeLine(`  ${s.handle} (${s.nick}) — connected ${uptime}s ago${marker}`);
        }
      }
      return;
    }

    // Bot command
    if (trimmed.startsWith('.')) {
      await this.commandHandler.execute(trimmed, {
        source: 'dcc',
        nick: this.nick,
        ident: this.ident,
        hostname: this.hostname,
        channel: null,
        reply: (msg: string) => {
          for (const part of msg.split('\n')) {
            this.writeLine(part);
          }
        },
      });
      return;
    }

    // Party line broadcast
    this.writeLine(`<${this.handle}> ${trimmed}`);
    this.manager.broadcast(this.handle, trimmed);
  }

  private resetIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close('Idle timeout.');
    }, this.idleTimeoutMs);
  }

  /** Close the session gracefully. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.socket.destroyed) {
      if (reason) this.socket.write(`*** ${reason}\r\n`);
      this.socket.destroy();
    }

    this.manager.removeSession(this.nick);
    this.manager.announce(`*** ${this.handle} has left the console`);
    this.manager.notifyPartyPart(this.handle, this.nick);
    this.logger?.info(`DCC session closed: ${this.handle} (${reason ?? 'unknown'})`);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    // Remove from manager and announce departure
    this.manager.removeSession(this.nick);
    this.manager.announce(`*** ${this.handle} has left the console`);
    this.manager.notifyPartyPart(this.handle, this.nick);
    this.logger?.info(`DCC disconnected: ${this.handle} (${this.nick})`);
  }
}

// ---------------------------------------------------------------------------
// DCCManager
// ---------------------------------------------------------------------------

const PENDING_TIMEOUT_MS = 30_000;
const PLUGIN_ID = 'core:dcc';

export class DCCManager implements DCCSessionManager, BotlinkDCCView {
  private client: DCCIRCClient;
  private dispatcher: BindRegistrar;
  private permissions: PluginPermissions;
  private services: PluginServices;
  private commandHandler: CommandExecutor;
  private config: DccConfig;
  private version: string;
  private logger: Logger | null;

  private readonly sessions: Map<string, DCCSessionEntry>;
  private readonly portAllocator: PortAllocator;
  private pending: Map<number, PendingDCC> = new Map(); // key = port
  private casemapping: Casemapping = 'rfc1459';
  private botNick: string;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(deps: DCCManagerDeps) {
    this.client = deps.client;
    this.dispatcher = deps.dispatcher;
    this.permissions = deps.permissions;
    this.services = deps.services;
    this.commandHandler = deps.commandHandler;
    this.config = deps.config;
    this.version = deps.version;
    this.botNick = deps.botNick;
    this.logger = deps.logger?.child('dcc') ?? null;
    this.sessions = deps.sessions ?? new Map();
    this.portAllocator = deps.portAllocator ?? new RangePortAllocator(deps.config.port_range);
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Attach to the dispatcher — starts listening for DCC CTCP requests. */
  attach(): void {
    this.dispatcher.bind('ctcp', '-', 'DCC', this.onDccCtcp.bind(this), PLUGIN_ID);

    // Mirror incoming private messages and notices to all DCC sessions so
    // operators can see responses from services (e.g. NickServ, LimitServ).
    /* v8 ignore start -- handlers registered via client.on() are unreachable: test MockIRCClient has a no-op on() */
    const onNotice = (...args: unknown[]) => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      if (/^[#&]/.test(target)) return; // skip channel notices
      this.announce(`-${sanitize(nick)}- ${sanitize(message)}`);
    };
    const onPrivmsg = (...args: unknown[]) => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      if (/^[#&]/.test(target)) return; // skip channel messages
      this.announce(`<${sanitize(nick)}> ${sanitize(message)}`);
    };
    /* v8 ignore stop */
    this.client.on('notice', onNotice);
    this.client.on('privmsg', onPrivmsg);
    this.ircListeners = [
      { event: 'notice', fn: onNotice },
      { event: 'privmsg', fn: onPrivmsg },
    ];

    this.logger?.info(
      `DCC CHAT listening (${this.config.ip}, ports ${this.config.port_range[0]}–${this.config.port_range[1]})`,
    );
  }

  /** Detach and close all sessions. */
  detach(reason = 'Bot shutting down.'): void {
    this.dispatcher.unbindAll(PLUGIN_ID);
    for (const { event, fn } of this.ircListeners) {
      this.client.removeListener(event, fn);
    }
    this.ircListeners = [];
    this.closeAll(reason);
    // Close any pending (not-yet-accepted) servers
    /* v8 ignore start -- pending DCC servers require real TCP; this.pending is always empty in tests */
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.server.close();
      this.portAllocator.release(pending.port);
    }
    /* v8 ignore stop */
    this.pending.clear();
    this.logger?.info('DCC detached');
  }

  // -------------------------------------------------------------------------
  // Botnet broadcast
  // -------------------------------------------------------------------------

  /** Callback: relay session ended by user. */
  onRelayEnd: ((handle: string, targetBot: string) => void) | null = null;

  /** Callback: local user sent party line chat. Wired to botlink by bot.ts. */
  onPartyChat: ((handle: string, message: string) => void) | null = null;
  /** Callback: local DCC session opened. */
  onPartyJoin: ((handle: string, nick: string) => void) | null = null;
  /** Callback: local DCC session closed. */
  onPartyPart: ((handle: string, nick: string) => void) | null = null;

  /** Send a message to all sessions except the one with the given handle. */
  broadcast(fromHandle: string, message: string): void {
    for (const session of this.sessions.values()) {
      if (session.handle !== fromHandle) {
        session.writeLine(`<${fromHandle}> ${message}`);
      }
    }
    this.onPartyChat?.(fromHandle, message);
  }

  /** Send a message to all connected sessions. */
  announce(message: string): void {
    for (const session of this.sessions.values()) {
      session.writeLine(message);
    }
  }

  /** Notify botlink that a DCC session closed. Called by DCCSession. */
  notifyPartyPart(handle: string, nick: string): void {
    this.onPartyPart?.(handle, nick);
  }

  /** Return a snapshot of the current session list. */
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      handle: s.handle,
      nick: s.nick,
      connectedAt: s.connectedAt,
    }));
  }

  /** Get a session by IRC nick. */
  getSession(nick: string): DCCSessionEntry | undefined {
    return this.sessions.get(ircLower(nick, this.casemapping));
  }

  /** Get the bot's name (for relay display). */
  getBotName(): string {
    return this.botNick;
  }

  /** Remove a session by IRC nick (called by DCCSession.onClose). */
  removeSession(nick: string): void {
    this.sessions.delete(ircLower(nick, this.casemapping));
  }

  // -------------------------------------------------------------------------
  // CTCP DCC handler
  // -------------------------------------------------------------------------

  private async onDccCtcp(ctx: HandlerContext): Promise<void> {
    const { nick } = ctx;
    this.logger?.debug(`DCC CTCP from ${nick}: args="${ctx.args}"`);
    const parsed = parseDccChatPayload(ctx.args);
    if (!parsed) {
      this.logger?.debug(`DCC CTCP from ${nick}: not a CHAT subtype, ignoring`);
      return;
    }
    const user = await this.rejectIfInvalid(nick, ctx, parsed);
    if (!user) return;
    await this.acceptDccConnection(nick, ctx.ident, ctx.hostname, user, parsed);
  }

  /**
   * Run all guard checks for an incoming DCC CHAT request.
   * Returns the matching UserRecord if all checks pass, or null if rejected.
   * **Side effect:** sends an IRC notice to `nick` on rejection — callers must
   * treat a null return as "already handled", not a silent failure.
   */
  private async rejectIfInvalid(
    nick: string,
    ctx: HandlerContext,
    parsed: DccChatPayload,
  ): Promise<UserRecord | null> {
    const { ident, hostname } = ctx;

    // 0. Passive DCC — HexBot only accepts passive (port=0) DCC
    if (!isPassiveDcc(parsed.ip, parsed.port)) {
      this.logger?.info(
        `DCC CHAT rejected (active DCC) from ${nick}: ip=${parsed.ip} port=${parsed.port}`,
      );
      this.client.notice(
        nick,
        'HexBot only accepts passive DCC CHAT. Enable passive/reverse DCC in your client settings, then try /dcc chat hexbot again.',
      );
      return null;
    }

    // 1. Hostmask lookup
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = this.permissions.findByHostmask(fullHostmask);
    if (!user) {
      this.logger?.info(`DCC CHAT rejected (no hostmask match) for ${fullHostmask}`);
      this.client.notice(nick, 'DCC CHAT: your hostmask is not in the user database.');
      return null;
    }

    // 2. Flag check — delegate to permissions so owner flag (n) implies all others
    const requiredFlags = this.config.require_flags;
    if (!this.permissions.checkFlags(requiredFlags, ctx)) {
      this.logger?.info(
        `DCC CHAT rejected (insufficient flags) for ${nick}: has="${user.global}" needs="${requiredFlags}"`,
      );
      this.client.notice(nick, `DCC CHAT: insufficient flags (requires +${requiredFlags}).`);
      return null;
    }

    // 3. Session limit
    if (this.sessions.size >= this.config.max_sessions) {
      this.client.notice(nick, `DCC CHAT: maximum sessions (${this.config.max_sessions}) reached.`);
      return null;
    }

    // 4. Already connected or pending?
    if (this.sessions.has(ircLower(nick, this.casemapping))) {
      this.client.notice(nick, 'DCC CHAT: you already have an active session.');
      return null;
    }
    for (const p of this.pending.values()) {
      if (ircLower(p.nick, this.casemapping) === ircLower(nick, this.casemapping)) {
        this.client.notice(nick, 'DCC CHAT: a connection is already pending.');
        return null;
      }
    }

    // 5. NickServ verify (optional) — must complete before port allocation
    if (this.config.nickserv_verify) {
      const result = await this.services.verifyUser(nick);
      if (!result.verified) {
        this.client.notice(nick, 'DCC CHAT: NickServ verification failed. Please identify first.');
        return null;
      }
    }

    return user;
  }

  /**
   * Allocate a TCP port, open the server, send the passive DCC reply, and
   * wait for the user's client to connect.
   */
  private async acceptDccConnection(
    nick: string,
    ident: string,
    hostname: string,
    user: UserRecord,
    parsed: DccChatPayload,
  ): Promise<void> {
    const port = this.portAllocator.allocate();
    /* v8 ignore next -- FALSE branch: port available leads to createServer block already ignored; unreachable without real TCP */
    if (port === null) {
      this.logger?.error(`DCC port range exhausted for ${nick}`);
      this.client.notice(nick, 'DCC CHAT: no ports available, try again later.');
      return;
    }
    /* v8 ignore next -- leads directly into TCP server creation; unreachable without real TCP */
    this.openDccServer(port, nick, ident, hostname, user, parsed);
  }

  /**
   * Open a TCP server on the given port, send the passive DCC CTCP reply,
   * and register timeout + connection handlers.
   */
  /* v8 ignore next -- entire method creates a real TCP server via createServer(); untestable without real TCP */
  private openDccServer(
    port: number,
    nick: string,
    ident: string,
    hostname: string,
    user: UserRecord,
    parsed: DccChatPayload,
  ): void {
    /* v8 ignore start -- TCP server lifecycle (listen, connection, timeout, close); requires real TCP */
    const server = createServer();
    this.portAllocator.markUsed(port);

    server.listen(port, '0.0.0.0', () => {
      const ipDecimal = ipToDecimal(this.config.ip);
      const token = parsed.token !== 0 ? parsed.token : Math.floor(Math.random() * 0xffff) + 1;
      this.client.ctcpRequest(nick, 'DCC', `CHAT chat ${ipDecimal} ${port} ${token}`);
      this.logger?.info(`Passive DCC offered to ${nick} on port ${port}`);
    });

    const pending: PendingDCC = {
      nick,
      user,
      ident,
      hostname,
      server,
      port,
      timer: setTimeout(() => {
        server.close();
        this.portAllocator.release(port);
        this.pending.delete(port);
        this.logger?.info(`DCC offer to ${nick} timed out`);
      }, PENDING_TIMEOUT_MS),
    };
    this.pending.set(port, pending);

    server.once('connection', (socket: Socket) => {
      clearTimeout(pending.timer);
      server.close();
      this.portAllocator.release(port);
      this.pending.delete(port);
      this.openSession(pending, socket);
    });

    server.on('error', (err) => {
      this.logger?.error(`DCC server error on port ${port}:`, err);
      this.portAllocator.release(port);
      this.pending.delete(port);
    });
    /* v8 ignore stop */
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /* v8 ignore start -- openSession requires a live TCP socket; covered by manual integration tests */
  private openSession(pending: PendingDCC, socket: Socket): void {
    const session = new DCCSession({
      manager: this,
      user: pending.user,
      nick: pending.nick,
      ident: pending.ident,
      hostname: pending.hostname,
      socket,
      commandHandler: this.commandHandler,
      idleTimeoutMs: this.config.idle_timeout_ms,
      logger: this.logger,
    });

    this.sessions.set(ircLower(pending.nick, this.casemapping), session);
    this.announce(`*** ${pending.user.handle} has joined the console`);
    this.onPartyJoin?.(pending.user.handle, pending.nick);
    this.logger?.info(`DCC session opened: ${pending.user.handle} (${pending.nick})`);

    session.start(this.version, this.botNick);
    /* v8 ignore stop */
  }

  private closeAll(reason?: string): void {
    for (const session of this.sessions.values()) {
      session.close(reason);
    }
    this.sessions.clear();
  }
}
