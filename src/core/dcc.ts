// hexbot — DCC CHAT + Console
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

import type { CommandHandler } from '../command-handler';
import type { EventDispatcher } from '../dispatcher';
import type { Logger } from '../logger';
import type { DccConfig, HandlerContext, UserRecord } from '../types';
import { type Casemapping, ircLower } from '../utils/wildcard';
import type { Permissions } from './permissions';
import type { Services } from './services';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed by DCCManager. */
export interface DCCIRCClient {
  notice(target: string, message: string): void;
  ctcpRequest(target: string, type: string, ...params: string[]): void;
  ctcpResponse(target: string, type: string, ...params: string[]): void;
}

export interface DCCManagerDeps {
  client: DCCIRCClient;
  dispatcher: EventDispatcher;
  permissions: Permissions;
  services: Services;
  commandHandler: CommandHandler;
  config: DccConfig;
  version: string;
  botNick: string;
  logger?: Logger | null;
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

const PROMPT = 'hexbot> ';

// ASCII logo placeholder — replace BANNER_LOGO lines with your own art.
// Each entry is one line of text sent to the user's DCC CHAT window.
const BANNER_LOGO = [
  ' _______               __           __   ',
  '|   |   |.-----.--.--.|  |--.-----.|  |_ ',
  '|       ||  -__|_   _||  _  |  _  ||   _|',
  '|___|___||_____|__.__||_____|_____||____|',
];

export class DCCSession {
  readonly handle: string;
  readonly flags: string;
  readonly nick: string;
  readonly ident: string;
  readonly hostname: string;
  readonly connectedAt: number;

  private socket: Socket;
  private manager: DCCManager;
  private commandHandler: CommandHandler;
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private logger: Logger | null;

  constructor(opts: {
    manager: DCCManager;
    user: UserRecord;
    nick: string;
    ident: string;
    hostname: string;
    socket: Socket;
    commandHandler: CommandHandler;
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

    this.writeLine(`Connected to ${botNick}, running hexbot v${version}`);
    this.writeLine('');
    for (const line of BANNER_LOGO) {
      this.writeLine(line);
    }
    this.writeLine('');
    this.writeLine(
      `Hey ${this.handle}!  My name is ${botNick} and I am running hexbot v${version},`,
    );
    this.writeLine(`on ${platform}.`);
    this.writeLine('');
    this.writeLine(`Local time is now ${now}`);
    this.writeLine('');
    this.writeLine(`Logged in as: ${this.handle} (${this.nick}!${this.ident}@${this.hostname})`);
    this.writeLine(`Your flags: +${this.flags || '-'}`);
    if (this.flags.includes('n')) {
      this.writeLine('');
      this.writeLine('You are an owner of this bot.  Only +n users can see this!');
    }
    this.writeLine('');
    this.writeLine(`Console: ${onConsole}`);
    this.writeLine('');
    this.writeLine('Use .help for basic help.');
    this.writeLine('Use .help <command> for help on a specific command.');
    this.writeLine('Use .console to see who is currently on the console.');
    this.writeLine('');
    this.writeLine('Have fun.');
    this.writeLine('');
    this.writeLine("Commands start with '.' (like '.quit' or '.help')");
    this.writeLine('Everything else goes out to the party line.');
    this.writeLine('');
    this.write(PROMPT);

    this.resetIdle();

    rl.on('line', (line: string) => {
      this.onLine(line).finally(() => {
        if (!this.closed) this.write(PROMPT);
      });
    });

    this.socket.on('close', () => this.onClose());
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

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    this.resetIdle();

    if (!trimmed) return;

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
    this.logger?.info(`DCC session closed: ${this.handle} (${reason ?? 'unknown'})`);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Remove from manager and announce departure
    this.manager.removeSession(this.nick);
    this.manager.announce(`*** ${this.handle} has left the console`);
    this.logger?.info(`DCC disconnected: ${this.handle} (${this.nick})`);
  }
}

// ---------------------------------------------------------------------------
// DCCManager
// ---------------------------------------------------------------------------

const PENDING_TIMEOUT_MS = 30_000;
const PLUGIN_ID = 'core:dcc';

export class DCCManager {
  private client: DCCIRCClient;
  private dispatcher: EventDispatcher;
  private permissions: Permissions;
  private services: Services;
  private commandHandler: CommandHandler;
  private config: DccConfig;
  private version: string;
  private logger: Logger | null;

  private sessions: Map<string, DCCSession> = new Map(); // key = ircLower(nick)
  private allocatedPorts: Set<number> = new Set();
  private pending: Map<number, PendingDCC> = new Map(); // key = port
  private casemapping: Casemapping = 'rfc1459';
  private botNick: string;

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
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Attach to the dispatcher — starts listening for DCC CTCP requests. */
  attach(): void {
    this.dispatcher.bind('ctcp', '-', 'DCC', this.onDccCtcp.bind(this), PLUGIN_ID);
    this.logger?.info(
      `DCC CHAT listening (${this.config.ip}, ports ${this.config.port_range[0]}–${this.config.port_range[1]})`,
    );
  }

  /** Detach and close all sessions. */
  detach(reason = 'Bot shutting down.'): void {
    this.dispatcher.unbindAll(PLUGIN_ID);
    this.closeAll(reason);
    // Close any pending (not-yet-accepted) servers
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.server.close();
      this.allocatedPorts.delete(pending.port);
    }
    this.pending.clear();
    this.logger?.info('DCC detached');
  }

  // -------------------------------------------------------------------------
  // Botnet broadcast
  // -------------------------------------------------------------------------

  /** Send a message to all sessions except the one with the given handle. */
  broadcast(fromHandle: string, message: string): void {
    for (const session of this.sessions.values()) {
      if (session.handle !== fromHandle) {
        session.writeLine(`<${fromHandle}> ${message}`);
      }
    }
  }

  /** Send a message to all connected sessions. */
  announce(message: string): void {
    for (const session of this.sessions.values()) {
      session.writeLine(message);
    }
  }

  /** Return a snapshot of the current session list. */
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      handle: s.handle,
      nick: s.nick,
      connectedAt: s.connectedAt,
    }));
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
    const user = await this.validateDccRequest(nick, ctx, parsed);
    if (!user) return;
    await this.acceptDccConnection(nick, ctx.ident, ctx.hostname, user, parsed);
  }

  /**
   * Run all guard checks for an incoming DCC CHAT request.
   * Returns the matching UserRecord if all checks pass, or null if rejected
   * (rejection notice already sent to the nick).
   */
  private async validateDccRequest(
    nick: string,
    ctx: HandlerContext,
    parsed: DccChatPayload,
  ): Promise<UserRecord | null> {
    const { ident, hostname } = ctx;

    // 0. Passive DCC — hexbot only accepts passive (port=0) DCC
    if (!isPassiveDcc(parsed.ip, parsed.port)) {
      this.logger?.info(
        `DCC CHAT rejected (active DCC) from ${nick}: ip=${parsed.ip} port=${parsed.port}`,
      );
      this.client.notice(
        nick,
        'hexbot only accepts passive DCC CHAT. Enable passive/reverse DCC in your client settings, then try /dcc chat hexbot again.',
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

    // 4. Already connected?
    if (this.sessions.has(ircLower(nick, this.casemapping))) {
      this.client.notice(nick, 'DCC CHAT: you already have an active session.');
      return null;
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
    user: import('../types').UserRecord,
    parsed: DccChatPayload,
  ): Promise<void> {
    const port = this.allocatePort();
    if (port === null) {
      this.logger?.error(`DCC port range exhausted for ${nick}`);
      this.client.notice(nick, 'DCC CHAT: no ports available, try again later.');
      return;
    }

    const server = createServer();
    this.allocatedPorts.add(port);

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
        this.allocatedPorts.delete(port);
        this.pending.delete(port);
        this.logger?.info(`DCC offer to ${nick} timed out`);
      }, PENDING_TIMEOUT_MS),
    };
    this.pending.set(port, pending);

    server.once('connection', (socket: Socket) => {
      clearTimeout(pending.timer);
      server.close();
      this.allocatedPorts.delete(port);
      this.pending.delete(port);
      this.openSession(pending, socket);
    });

    server.on('error', (err) => {
      this.logger?.error(`DCC server error on port ${port}:`, err);
      this.allocatedPorts.delete(port);
      this.pending.delete(port);
    });
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

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
    this.logger?.info(`DCC session opened: ${pending.user.handle} (${pending.nick})`);

    session.start(this.version, this.botNick);
  }

  private closeAll(reason?: string): void {
    for (const session of this.sessions.values()) {
      session.close(reason);
    }
    this.sessions.clear();
  }

  private allocatePort(): number | null {
    const [min, max] = this.config.port_range;
    for (let p = min; p <= max; p++) {
      if (!this.allocatedPorts.has(p)) return p;
    }
    return null;
  }
}
