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
import type { DccConfig, HandlerContext, PluginServices, UserRecord } from '../types';
import { toEventObject } from '../utils/irc-event';
import { sanitize } from '../utils/sanitize';
import { type Casemapping, ircLower } from '../utils/wildcard';
import { verifyPassword } from './password';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Permissions view DCC needs — a superset of `PluginPermissions`. The DCC
 * path must see `password_hash` to verify the prompt, so `findByHostmask`
 * returns a full `UserRecord` rather than the stripped plugin-facing view.
 * The concrete `Permissions` class satisfies this interface structurally.
 */
export interface DCCPermissions {
  findByHostmask(hostmask: string): UserRecord | null;
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

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

/** Live stats surfaced in the DCC session banner. */
export interface BannerStats {
  channels: string[];
  pluginCount: number;
  bindCount: number;
  userCount: number;
  uptime: number; // milliseconds
}

/** The subset of DCCManager that DCCSession depends on. */
export interface DCCSessionManager {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  broadcast(fromHandle: string, message: string): void;
  announce(message: string): void;
  removeSession(nick: string): void;
  notifyPartyPart(handle: string, nick: string): void;
  getBotName(): string;
  getStats(): BannerStats | null;
  onRelayEnd?: ((handle: string, targetBot: string) => void) | null;
  /**
   * Called when the password prompt succeeds. The session has entered the
   * `active` phase and should be announced to other sessions. Implementations
   * may also clear any rate-limit failure counters for the session's key.
   */
  onAuthSuccess?(session: DCCSessionEntry): void;
  /**
   * Called when the password prompt fails. The session is about to close.
   * Implementations should increment failure counters and emit warnings.
   */
  onAuthFailure?(key: string, handle: string): void;
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
  permissions: DCCPermissions;
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
  /** Injectable auth tracker. Default: new DCCAuthTracker() with stock parameters. */
  authTracker?: DCCAuthTracker;
  /** Optional live stats provider for the DCC session banner. */
  getStats?: () => BannerStats;
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

// ---------------------------------------------------------------------------
// IRC formatting helpers (mIRC color codes)
// ---------------------------------------------------------------------------

const B = '\x02'; // bold toggle
const C = (n: number) => `\x03${String(n).padStart(2, '0')}`; // set color
const RC = '\x0F'; // reset all — avoids bare \x03 eating a following digit as a color code

const red = (s: string) => `${C(4)}${s}${RC}`;
const grey = (s: string) => `${C(14)}${s}${RC}`;
const lbl = (s: string, w = 10) => `${C(4)}${B}${s.padEnd(w)}${B}${RC}`; // teal bold, fixed-width

// ---------------------------------------------------------------------------
// Banner art — braille hex icon with colored "HEXBOT" text art
// ---------------------------------------------------------------------------

function bannerLogo(version: string): string[] {
  return [
    `⠀⠀⠀⠀⣠⣤⣶⣶⣶⣤⣄⡀⠀    `,
    `⠀⠀⣴⣾⣿⣿⣿⣿⣿⣧⡀⠈⠢⠀⠀ `,
    `⠀⣼⣿⣿⣿⣿⣿⣿⣿⡿⠁ ⠀⠀⠀  `,
    `⢰⡿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀  `,
    `⠘⣽⡿⠿⠿⣿⣿⣿⣿⣿⣦⣤⡀⠀⠀ `,
    `⠀⣟⠀⠀⠀⣸⣿⡏⠀⠀⠀⢹⠗⠀⠀  `,
    `⠀⣿⣷⣶⣾⡿⠁⠙⣄⣀⣀⣠⡀ ⠀   ${B}${red(`HexBot`)} v${version}${B}`,
    `⠀⠙⠙⢿⡿⣷⣶⣤⣿⣿⡿⠿⠃⠀⠀   ${grey('Hell is empty and all the bots are here.')}`,
    `⠀⠀⠀⠺⡏⡏⡏⡏⡏⠉⠁⠀⠀⠀⠀⠀`,
    `⠀⠀⠀⠀⠀⠀⠁⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀`,
  ];
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

/**
 * Shorter idle timeout used while the session is awaiting a password. Keeps
 * stalled prompts from squatting on a DCC port.
 */
export const DCC_PROMPT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// DCCAuthTracker — per-hostmask failure counter with exponential backoff
// ---------------------------------------------------------------------------

export interface DCCAuthLockStatus {
  locked: boolean;
  lockedUntil: number;
  failures: number;
}

/**
 * Tracks password-prompt failures per identity (hostmask). Mirrors the
 * backoff strategy in `BotLinkAuthManager` but against DCC keys. Used by
 * `DCCManager` to short-circuit the prompt path for abusive clients.
 *
 * Exported so tests can construct one in isolation. The class owns no
 * timers — the sweep is driven by the enclosing DCCManager to match how
 * the botlink tracker is driven by its enclosing hub.
 */
export class DCCAuthTracker {
  private readonly trackers: Map<
    string,
    { failures: number; firstFailure: number; bannedUntil: number; banCount: number }
  > = new Map();

  /** Max failures per window before a lockout. */
  readonly maxFailures: number;
  /** Sliding window over which failures accumulate. */
  readonly windowMs: number;
  /** Base lockout duration. Doubles on each re-ban up to {@link maxLockMs}. */
  readonly baseLockMs: number;
  /** Upper bound on the exponential lockout duration. */
  readonly maxLockMs: number;

  constructor(
    options: {
      maxFailures?: number;
      windowMs?: number;
      baseLockMs?: number;
      maxLockMs?: number;
    } = {},
  ) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.baseLockMs = options.baseLockMs ?? 300_000;
    this.maxLockMs = options.maxLockMs ?? 86_400_000;
  }

  /** Is this key currently locked out? */
  check(key: string, now: number = Date.now()): DCCAuthLockStatus {
    const tracker = this.trackers.get(key);
    if (!tracker) return { locked: false, lockedUntil: 0, failures: 0 };
    if (tracker.bannedUntil > now) {
      return { locked: true, lockedUntil: tracker.bannedUntil, failures: tracker.failures };
    }
    return { locked: false, lockedUntil: 0, failures: tracker.failures };
  }

  /** Record a failed attempt. May escalate to a lockout. */
  recordFailure(key: string, now: number = Date.now()): DCCAuthLockStatus {
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = { failures: 0, firstFailure: now, bannedUntil: 0, banCount: 0 };
      this.trackers.set(key, tracker);
    }
    if (now - tracker.firstFailure > this.windowMs) {
      tracker.failures = 0;
      tracker.firstFailure = now;
    }
    tracker.failures++;
    if (tracker.failures >= this.maxFailures) {
      const lockDuration = Math.min(this.baseLockMs * 2 ** tracker.banCount, this.maxLockMs);
      tracker.bannedUntil = now + lockDuration;
      tracker.banCount++;
      tracker.failures = 0;
    }
    return {
      locked: tracker.bannedUntil > now,
      lockedUntil: tracker.bannedUntil,
      failures: tracker.failures,
    };
  }

  /** Record a successful attempt — zeroes the failure counter but preserves banCount. */
  recordSuccess(key: string): void {
    const tracker = this.trackers.get(key);
    if (tracker) {
      tracker.failures = 0;
    }
  }

  /** Prune expired trackers — called from DCCManager sweep. */
  sweep(now: number = Date.now()): void {
    const STALE_MS = 86_400_000;
    for (const [key, tracker] of this.trackers) {
      const banExpired = tracker.bannedUntil < now;
      const failureWindowExpired = now - tracker.firstFailure > this.windowMs;
      if (banExpired && failureWindowExpired) {
        if (tracker.banCount === 0) {
          this.trackers.delete(key);
        } else if (now - tracker.bannedUntil > STALE_MS) {
          this.trackers.delete(key);
        }
      }
    }
  }
}

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
  private rl: import('readline').Interface | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private logger: Logger | null;

  /** Session state machine: prompt → active. */
  private phase: 'awaiting_password' | 'active' = 'awaiting_password';
  /** The password hash the prompt must match. Never logged. */
  private readonly passwordHash: string;
  /** Version / botNick captured from `start()` — needed by the deferred banner. */
  private versionForBanner = '';
  private botNickForBanner = '';

  constructor(opts: {
    manager: DCCSessionManager;
    user: UserRecord;
    passwordHash: string;
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
    this.passwordHash = opts.passwordHash;
    this.nick = opts.nick;
    this.ident = opts.ident;
    this.hostname = opts.hostname;
    this.socket = opts.socket;
    this.commandHandler = opts.commandHandler;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.connectedAt = Date.now();
    this.logger = opts.logger ?? null;
  }

  /** Key used for rate-limit tracking — `nick!ident@host`. */
  get rateLimitKey(): string {
    return `${this.nick}!${this.ident}@${this.hostname}`;
  }

  /**
   * Start the session: wire up readline, send the password prompt, and wait
   * for the first line of input. The banner is **not** sent until the
   * password prompt succeeds — see {@link showBanner}.
   */
  start(version: string, botNick: string): void {
    this.versionForBanner = version;
    this.botNickForBanner = botNick;

    this.rl = createReadline({ input: this.socket, crlfDelay: Infinity });
    const rl = this.rl;

    // Password prompt — DCC CHAT clients are line-buffered, so the prompt
    // must end in CRLF or it never renders before the user types.
    this.socket.write('Password:\r\n');
    this.phase = 'awaiting_password';
    this.resetPromptIdle();

    rl.on('line', (line: string) => {
      this.onLine(line);
    });

    this.socket.on('close', () => this.onClose());
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.socket.on('error', () => this.onClose());
  }

  /** Read-only view of the session phase — used by tests. */
  get currentPhase(): 'awaiting_password' | 'active' {
    return this.phase;
  }

  /**
   * Render the welcome banner directly, without going through the password
   * prompt. **Only for the dev preview script** (`scripts/preview-banner.ts`)
   * and tests that need to verify banner output. Never called from the
   * production DCC flow.
   */
  renderBannerPreview(version: string, botNick: string): void {
    this.versionForBanner = version;
    this.botNickForBanner = botNick;
    this.phase = 'active';
    this.showBanner();
  }

  /**
   * Start the session in the `active` phase, bypassing the password prompt.
   * **Test-only.** Production always goes through {@link start}, which sends
   * the prompt and waits for a verified password. Existing tests that are
   * *not* about the prompt itself use this entry point to stay focused on
   * the behaviour under test (relay, command routing, idle timer, …).
   * Prompt-specific tests invoke `start()` directly.
   */
  startActiveForTesting(version: string, botNick: string): void {
    this.versionForBanner = version;
    this.botNickForBanner = botNick;

    this.rl = createReadline({ input: this.socket, crlfDelay: Infinity });
    const rl = this.rl;

    this.phase = 'active';
    this.showBanner();
    this.resetIdle();

    rl.on('line', (line: string) => {
      this.onLine(line);
    });

    this.socket.on('close', () => this.onClose());
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.socket.on('error', () => this.onClose());
  }

  /** Send the welcome banner + stats. Called after the password prompt succeeds. */
  private showBanner(): void {
    const version = this.versionForBanner;
    const botNick = this.botNickForBanner;

    const d = new Date();
    const time = d.toLocaleTimeString();
    const tz = d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
    const date = d.toLocaleDateString();
    const stats = this.manager.getStats();
    const others = this.manager
      .getSessionList()
      .filter((s) => s.handle !== this.handle)
      .map((s) => s.handle);
    const consoleLine =
      others.length > 0
        ? `${others.length} other(s) here: ${others.join(', ')}`
        : 'you are the only one here';

    // Logo
    for (const line of bannerLogo(version)) {
      this.writeLine(line);
    }

    // Greeting
    this.writeLine('');
    this.writeLine(
      `Hey ${B}${this.handle}${B}! My name is ${B}${botNick}${B} and the local time is ${time} (${tz}) on ${date}.`,
    );

    // Owner-only notice
    if (this.flags.includes('n')) {
      this.writeLine('');
      this.writeLine(`${red(`${B}★${B}`)} You are an owner of this bot.`);
    }

    // Stats table
    this.writeLine('');
    const flagDisplay = this.flags ? `+${this.flags}` : '+-';
    this.writeLine(
      `  ${lbl('Session')}${B}${this.handle}${B} (${this.nick}!${this.ident}@${this.hostname})`,
    );
    this.writeLine(`  ${lbl('Flags')}${flagDisplay}`);
    if (stats) {
      const chanList = stats.channels.length > 0 ? stats.channels.join(', ') : grey('none');
      this.writeLine(
        `  ${lbl('Channels')}${B}${stats.channels.length}${B} joined ${grey('│')} ${chanList}`,
      );
      this.writeLine(
        `  ${lbl('Plugins')}${B}${stats.pluginCount}${B} loaded ${grey('│')} ${B}${stats.bindCount}${B} binds`,
      );
      this.writeLine(`  ${lbl('Users')}${B}${stats.userCount}${B} registered`);
      this.writeLine(`  ${lbl('Uptime')}${formatUptime(stats.uptime)}`);
    }
    this.writeLine(`  ${lbl('Console')}${consoleLine}`);

    // Quick-start commands
    this.writeLine('');
    this.writeLine(`Use ${B}.help${B} for basic help.`);
    this.writeLine(`Use ${B}.help${B} <command> for help on a specific command.`);
    this.writeLine(`Use ${B}.console${B} to see who is on the console.`);
    this.writeLine('');
    this.writeLine(`Commands start with '.' — everything else is console chat.`);
    this.writeLine('');
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
    // Password-prompt phase — consume one line and verify. No trimming of
    // the password itself; users may intentionally use leading/trailing
    // characters. But DCC protocol delivers lines without the CRLF already.
    if (this.phase === 'awaiting_password') {
      await this.handlePasswordLine(line);
      return;
    }

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

  /** Shorter timer used while the password prompt is open. */
  private resetPromptIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close('Password prompt timed out.');
    }, DCC_PROMPT_TIMEOUT_MS);
  }

  /**
   * Handle the first (and only) line received during the `awaiting_password`
   * phase. On success, transition to `active` and show the banner. On
   * failure, notify the manager (so it can escalate) and disconnect.
   */
  private async handlePasswordLine(line: string): Promise<void> {
    // A DCC client may send CRLF or LF; readline already strips the trailing
    // newline but a user may accidentally include whitespace. We accept the
    // password verbatim minus leading/trailing whitespace.
    const candidate = line.replace(/[\r\n]+$/g, '').trim();

    // Treat the prompt itself as something that can be aborted with a blank
    // line — otherwise the session would silently count it as a failure.
    if (candidate.length === 0) {
      this.socket.write('Password:\r\n');
      this.resetPromptIdle();
      return;
    }

    let ok: boolean;
    try {
      ok = await verifyPassword(candidate, this.passwordHash);
      /* v8 ignore start -- verifyPassword only throws on scrypt OOM / invalid params; defensive */
    } catch (err) {
      this.logger?.error(`DCC password verification error for ${this.handle}: ${String(err)}`);
      ok = false;
    }
    /* v8 ignore stop */

    if (this.closed) return; // session may have been closed while awaiting scrypt

    if (!ok) {
      this.logger?.warn(
        `DCC CHAT: bad password from ${this.handle} (${this.nick}!${this.ident}@${this.hostname})`,
      );
      this.manager.onAuthFailure?.(this.rateLimitKey, this.handle);
      this.socket.write('DCC CHAT: bad password.\r\n');
      this.close('Authentication failed.');
      return;
    }

    // Password accepted — transition to active phase.
    this.phase = 'active';
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.manager.onAuthSuccess?.(this);
    this.showBanner();
    this.resetIdle();
  }

  /** Close the session gracefully. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.rl?.close();

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
    this.rl?.close();

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
  private permissions: DCCPermissions;
  private services: PluginServices;
  private commandHandler: CommandExecutor;
  private config: DccConfig;
  private version: string;
  private logger: Logger | null;
  private getStatsFn: (() => BannerStats) | null;

  private readonly sessions: Map<string, DCCSessionEntry>;
  private readonly portAllocator: PortAllocator;
  private pending: Map<number, PendingDCC> = new Map(); // key = port
  private casemapping: Casemapping = 'rfc1459';
  private botNick: string;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  /** Failure tracker for the password prompt — exponential backoff on repeat. */
  readonly authTracker: DCCAuthTracker;

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
    this.getStatsFn = deps.getStats ?? null;
    this.sessions = deps.sessions ?? new Map();
    this.portAllocator = deps.portAllocator ?? new RangePortAllocator(deps.config.port_range);
    this.authTracker = deps.authTracker ?? new DCCAuthTracker();
  }

  /** Called by DCCSession when the password prompt succeeds. */
  onAuthSuccess(session: DCCSessionEntry): void {
    const key = (session as DCCSession).rateLimitKey;
    this.authTracker.recordSuccess(key);
    this.sessions.set(ircLower(session.nick, this.casemapping), session);
    this.announce(`*** ${session.handle} has joined the console`);
    this.onPartyJoin?.(session.handle, session.nick);
    this.logger?.info(`DCC session active: ${session.handle} (${session.nick})`);
  }

  /** Called by DCCSession when the password prompt fails. */
  onAuthFailure(key: string, handle: string): void {
    const status = this.authTracker.recordFailure(key);
    if (status.locked) {
      const seconds = Math.ceil((status.lockedUntil - Date.now()) / 1000);
      this.logger?.warn(
        `DCC auth lockout: ${key} (handle=${handle}) locked for ~${seconds}s after repeated failures`,
      );
    }
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Attach to the dispatcher — starts listening for DCC CTCP requests. */
  attach(): void {
    this.warnIfDeprecatedNickservVerify();
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

  /** Get live stats for the DCC session banner. */
  getStats(): BannerStats | null {
    return this.getStatsFn?.() ?? null;
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
   * Returns the matching UserRecord if every check passes, or null if rejected.
   * **Side effect:** each individual guard sends its own IRC notice + log on
   * failure — callers must treat a null return as "already handled", not a
   * silent failure.
   */
  private async rejectIfInvalid(
    nick: string,
    ctx: HandlerContext,
    parsed: DccChatPayload,
  ): Promise<UserRecord | null> {
    if (!this.checkPassiveDcc(nick, parsed)) return null;
    const user = this.lookupUserOrReject(nick, ctx.ident, ctx.hostname);
    if (!user) return null;
    if (!this.checkUserFlags(nick, ctx, user)) return null;
    if (!this.checkSessionLimit(nick)) return null;
    if (!this.checkNotAlreadyConnected(nick)) return null;
    // `nickserv_verify` is no longer consulted — authentication now runs
    // through the password prompt inside DCCSession. The config knob is
    // kept as a no-op for 0.3.0 with a startup deprecation warning.
    return user;
  }

  /** Reject active-DCC requests (HexBot only accepts passive). */
  private checkPassiveDcc(nick: string, parsed: DccChatPayload): boolean {
    if (isPassiveDcc(parsed.ip, parsed.port)) return true;
    this.logger?.info(
      `DCC CHAT rejected (active DCC) from ${nick}: ip=${parsed.ip} port=${parsed.port}`,
    );
    this.client.notice(
      nick,
      'HexBot only accepts passive DCC CHAT. Enable passive/reverse DCC in your client settings, then try /dcc chat hexbot again.',
    );
    return false;
  }

  /** Look up the user by full hostmask, or reject with a notice. */
  private lookupUserOrReject(nick: string, ident: string, hostname: string): UserRecord | null {
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = this.permissions.findByHostmask(fullHostmask);
    if (user) return user;
    this.logger?.info(`DCC CHAT rejected (no hostmask match) for ${fullHostmask}`);
    this.client.notice(nick, 'DCC CHAT: your hostmask is not in the user database.');
    return null;
  }

  /** Verify user has the required DCC flags. Delegates to permissions so owner (n) implies all. */
  private checkUserFlags(nick: string, ctx: HandlerContext, user: UserRecord): boolean {
    const requiredFlags = this.config.require_flags;
    if (this.permissions.checkFlags(requiredFlags, ctx)) return true;
    this.logger?.info(
      `DCC CHAT rejected (insufficient flags) for ${nick}: has="${user.global}" needs="${requiredFlags}"`,
    );
    this.client.notice(nick, `DCC CHAT: insufficient flags (requires +${requiredFlags}).`);
    return false;
  }

  /** Cap total concurrent sessions. */
  private checkSessionLimit(nick: string): boolean {
    if (this.sessions.size < this.config.max_sessions) return true;
    this.client.notice(nick, `DCC CHAT: maximum sessions (${this.config.max_sessions}) reached.`);
    return false;
  }

  /** Reject if the user already has an active session or a pending connection. */
  private checkNotAlreadyConnected(nick: string): boolean {
    if (this.sessions.has(ircLower(nick, this.casemapping))) {
      this.client.notice(nick, 'DCC CHAT: you already have an active session.');
      return false;
    }
    for (const p of this.pending.values()) {
      if (ircLower(p.nick, this.casemapping) === ircLower(nick, this.casemapping)) {
        this.client.notice(nick, 'DCC CHAT: a connection is already pending.');
        return false;
      }
    }
    return true;
  }

  /**
   * Log a startup deprecation warning if `nickserv_verify` is still set.
   * Called once from `attach()` — the knob is retained for one release as a
   * no-op so operators upgrading from 0.2.x don't fail on schema validation.
   */
  private warnIfDeprecatedNickservVerify(): void {
    if (this.config.nickserv_verify) {
      this.logger?.warn(
        'nickserv_verify is deprecated and no longer used — DCC now requires per-user passwords. ' +
          'See docs/DCC.md for the migration path. This setting will be removed in 0.4.0.',
      );
    }
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
      clearTimeout(pending.timer);
      this.portAllocator.release(port);
      this.pending.delete(port);
    });
    /* v8 ignore stop */
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /**
   * Accept a newly-connected DCC CHAT socket. Gates on two new conditions
   * beyond the CTCP accept: the user must have a password hash on file, and
   * their hostmask must not be currently locked out by the auth tracker.
   *
   * Exposed (via this named helper, not `v8 ignore`'d) so tests can drive
   * the flow with a mock socket and a `PendingDCC` built in-process.
   */
  openSession(pending: PendingDCC, socket: Socket): void {
    const key = `${pending.nick}!${pending.ident}@${pending.hostname}`;

    // Rate-limit gate — refuse new prompts for recently-abused identities.
    const status = this.authTracker.check(key);
    if (status.locked) {
      const seconds = Math.max(1, Math.ceil((status.lockedUntil - Date.now()) / 1000));
      socket.write(
        `DCC CHAT: too many failed password attempts — locked for ~${seconds}s. Try again later.\r\n`,
      );
      socket.destroy();
      this.logger?.warn(
        `DCC CHAT: rejected ${pending.user.handle} (${key}) — locked out for ${seconds}s`,
      );
      return;
    }

    // Migration gate — no password means no DCC until an admin runs .chpass.
    const passwordHash = pending.user.password_hash;
    if (!passwordHash) {
      socket.write(
        'DCC CHAT: this handle has no password set. Ask an admin to run ' +
          '.chpass <handle> <newpass> from the REPL, then reconnect.\r\n',
      );
      socket.destroy();
      this.logger?.info(
        `DCC CHAT: rejected ${pending.user.handle} (${key}) — no password_hash on file`,
      );
      return;
    }

    const session = new DCCSession({
      manager: this,
      user: pending.user,
      passwordHash,
      nick: pending.nick,
      ident: pending.ident,
      hostname: pending.hostname,
      socket,
      commandHandler: this.commandHandler,
      idleTimeoutMs: this.config.idle_timeout_ms,
      logger: this.logger,
    });

    this.logger?.info(`DCC CHAT: prompting ${pending.user.handle} (${pending.nick}) for password`);

    session.start(this.version, this.botNick);
  }

  private closeAll(reason?: string): void {
    for (const session of this.sessions.values()) {
      session.close(reason);
    }
    this.sessions.clear();
  }
}
