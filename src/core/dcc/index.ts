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

import type { CommandExecutor } from '../../command-handler';
import type { BotDatabase } from '../../database';
import type { BindRegistrar } from '../../dispatcher';
import type { BotEventBus } from '../../event-bus';
import type { LogRecord, LogSink, LoggerLike } from '../../logger';
import { Logger as LoggerClass } from '../../logger';
import type { DccConfig, HandlerContext, PluginServices, UserRecord } from '../../types';
import { toEventObject } from '../../utils/irc-event';
import { sanitize } from '../../utils/sanitize';
import { type Casemapping, ircLower } from '../../utils/wildcard';
import { tryLogModAction } from '../audit';
import { verifyPassword } from '../password';
import { DCCAuthTracker } from './auth-tracker';
import { type BannerStats, renderBanner } from './banner';
import {
  type ConsoleFlagLetter,
  type ConsoleFlagStore,
  DEFAULT_CONSOLE_FLAGS,
  formatFlags,
  parseCanonicalFlags,
  shouldDeliverToSession,
} from './console-flags';
import {
  DCC_PROMPT_TIMEOUT_MS,
  type DccChatPayload,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from './protocol';

// Barrel re-exports — external consumers import from `'./dcc'` instead of
// reaching into individual files.
export { DCCAuthTracker, type DCCAuthLockStatus } from './auth-tracker';
export { type BannerStats } from './banner';
export {
  CONSOLE_FLAG_DESCRIPTIONS,
  CONSOLE_FLAG_LETTERS,
  type ConsoleFlagLetter,
  type ConsoleFlagStore,
  DEFAULT_CONSOLE_FLAGS,
  categorize,
  consoleFlagKey,
  extractExplicitCategory,
  formatFlags,
  isConsoleFlagLetter,
  parseCanonicalFlags,
  parseFlagsMutation,
  shouldDeliverToSession,
} from './console-flags';
export {
  DCC_PROMPT_TIMEOUT_MS,
  type DccChatPayload,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from './protocol';

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

/** Options for DCCSessionEntry.enterRelay — optional pending-confirmation timeout. */
export interface RelayEnterOptions {
  /** If set, start a timer that fires onTimeout unless confirmRelay() is called first. */
  timeoutMs: number;
  /** Fired when the timer elapses without a confirmation. */
  onTimeout: () => void;
}

/** The subset of DCCSession that DCCManager and consumers depend on. */
export interface DCCSessionEntry {
  readonly handle: string;
  readonly nick: string;
  readonly connectedAt: number;
  readonly isRelaying: boolean;
  /** The botname this session is currently relaying to, or null if not relaying. */
  readonly relayTarget: string | null;
  /** The authenticated user's permission flag string (e.g. `"nm"`). */
  readonly handleFlags: string;
  /** Key used for rate-limit tracking — `nick!ident@host`. */
  readonly rateLimitKey: string;
  /** True if the session has been closed (socket destroyed, cleanup called). */
  readonly isClosed: boolean;
  /** True if the session is no longer usable (closed, destroyed, or unwritable). */
  readonly isStale: boolean;
  writeLine(line: string): void;
  close(reason?: string): void;
  enterRelay(
    targetBot: string,
    callback: (line: string) => void,
    options?: RelayEnterOptions,
  ): void;
  exitRelay(): void;
  /** Called when a RELAY_ACCEPT arrives — promotes a pending relay to confirmed. */
  confirmRelay(): void;
  /** Return the current canonical console flag string (e.g. `"mojw"`). */
  getConsoleFlags(): string;
  /** Replace the session's console flags and persist them. */
  setConsoleFlags(flags: Set<ConsoleFlagLetter>): void;
  /** Deliver a log record to this session iff the filter accepts it. */
  receiveLog(record: LogRecord): void;
}

/** The subset of DCCManager that botlink-commands depends on. */
export interface BotlinkDCCView {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(nick: string):
    | {
        handle: string;
        isRelaying: boolean;
        enterRelay(
          targetBot: string,
          callback: (line: string) => void,
          options?: RelayEnterOptions,
        ): void;
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
  logger?: LoggerLike | null;
  /** Injectable session store. Default: new Map(). */
  sessions?: Map<string, DCCSessionEntry>;
  /** Injectable pending-connect store (port → entry). Default: new Map(). */
  pending?: Map<number, PendingDCC>;
  /** Injectable port allocator. Default: RangePortAllocator from config.port_range. */
  portAllocator?: PortAllocator;
  /** Injectable auth tracker. Default: new DCCAuthTracker() with stock parameters. */
  authTracker?: DCCAuthTracker;
  /**
   * Persistent store for per-handle DCC console flag preferences. When
   * omitted the manager falls back to an in-memory store — fine for
   * tests, but the production wiring in `bot.ts` always passes a
   * database-backed implementation.
   */
  consoleFlagStore?: ConsoleFlagStore;
  /**
   * Database used for `mod_log` writes from the DCC auth pipeline —
   * `auth-fail` rows on every password rejection and a distinct
   * `auth-lockout` row when the rate-limit triggers. Optional so the
   * tests that don't care about audit can keep their existing fixtures.
   */
  db?: BotDatabase | null;
  /** Optional live stats provider for the DCC session banner. */
  getStats?: () => BannerStats;
  /**
   * Event bus used to subscribe to `user:passwordChanged` and
   * `user:removed` so the manager can close any live session for a
   * rotated or deleted handle. Optional so existing test fixtures keep
   * working, but the production wiring in `bot.ts` always passes it.
   */
  eventBus?: BotEventBus | null;
}

export interface PendingDCC {
  nick: string;
  user: UserRecord;
  ident: string;
  hostname: string;
  server: NetServer;
  port: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Build an in-memory {@link ConsoleFlagStore}. Used as the default when
 * DCC is constructed without a persistent store (tests, or a bot that
 * hasn't wired up the database yet).
 */
export function createInMemoryConsoleFlagStore(): ConsoleFlagStore {
  const map = new Map<string, string>();
  return {
    get: (handle) => map.get(handle) ?? null,
    set: (handle, flags) => {
      map.set(handle, flags);
    },
    delete: (handle) => {
      map.delete(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// DCCSession
// ---------------------------------------------------------------------------

export class DCCSession implements DCCSessionEntry {
  readonly handle: string;
  /**
   * User permission flag string (e.g. `"nm"`). Kept under the existing
   * `flags` name for backwards compatibility with tests that read it
   * directly; `handleFlags` is the DCCSessionEntry-visible alias.
   */
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
  private logger: LoggerLike | null;
  private consoleFlagStore: ConsoleFlagStore | null;
  private consoleFlags: Set<ConsoleFlagLetter>;

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
    logger?: LoggerLike | null;
    consoleFlagStore?: ConsoleFlagStore | null;
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
    this.consoleFlagStore = opts.consoleFlagStore ?? null;

    const stored = this.consoleFlagStore?.get(this.handle) ?? null;
    this.consoleFlags =
      stored !== null ? parseCanonicalFlags(stored) : parseCanonicalFlags(DEFAULT_CONSOLE_FLAGS);
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

    this.attachLineLengthGuard();
    this.rl = createReadline({ input: this.socket, crlfDelay: Infinity });
    const rl = this.rl;

    // Password prompt — DCC CHAT clients are line-buffered, so the prompt
    // must end in CRLF or it never renders before the user types.
    this.socket.write('Enter your password:\r\n');
    this.phase = 'awaiting_password';
    this.resetPromptIdle();

    rl.on('line', (line: string) => {
      this.pendingLineBytes = 0;
      this.onLine(line);
    });

    this.socket.on('close', () => this.onClose());
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.socket.on('error', () => this.onClose());
  }

  /**
   * Maximum bytes accepted for a single DCC input line before we drop the
   * session. Legitimate commands and passwords are always well under 4 KiB;
   * anything larger is either broken client input or an attacker streaming
   * bytes without a newline to pin memory during the prompt window.
   */
  private static readonly MAX_LINE_BYTES = 4096;
  private pendingLineBytes = 0;

  /**
   * Count bytes that arrive on the socket between newlines and destroy the
   * session if a single line exceeds {@link MAX_LINE_BYTES}. This closes
   * the "fill the prompt buffer without a newline" DoS path: readline
   * buffers everything until `\n`, so without a cap an attacker who wins
   * the CTCP race can stream gigabytes into a prompt that never resolves.
   */
  private attachLineLengthGuard(): void {
    this.socket.on('data', (chunk: Buffer) => {
      const newlineIdx = chunk.lastIndexOf(0x0a);
      if (newlineIdx === -1) {
        this.pendingLineBytes += chunk.length;
      } else {
        this.pendingLineBytes = chunk.length - newlineIdx - 1;
      }
      if (this.pendingLineBytes > DCCSession.MAX_LINE_BYTES) {
        this.socket.destroy(
          new Error(`DCC line length exceeded ${DCCSession.MAX_LINE_BYTES} bytes`),
        );
      }
    });
  }

  /** Read-only view of the session phase — used by tests. */
  get currentPhase(): 'awaiting_password' | 'active' {
    return this.phase;
  }

  /** True if the session has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * True if the session is no longer usable — either our state machine
   * marked it closed, or the underlying socket is dead. Used by the
   * duplicate-session check so reconnects can evict zombies whose 'close'
   * event hasn't fired yet (e.g. NAT dropped the TCP state without RST
   * and the kernel hasn't surfaced ETIMEDOUT yet).
   */
  get isStale(): boolean {
    return this.closed || this.socket.destroyed || !this.socket.writable;
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

    this.attachLineLengthGuard();
    this.rl = createReadline({ input: this.socket, crlfDelay: Infinity });
    const rl = this.rl;

    this.phase = 'active';
    this.showBanner();
    this.resetIdle();

    rl.on('line', (line: string) => {
      this.pendingLineBytes = 0;
      this.onLine(line);
    });

    this.socket.on('close', () => this.onClose());
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.socket.on('error', () => this.onClose());
  }

  /** Send the welcome banner + stats. Called after the password prompt succeeds. */
  private showBanner(): void {
    renderBanner(
      {
        handle: this.handle,
        flags: this.flags,
        nick: this.nick,
        ident: this.ident,
        hostname: this.hostname,
        consoleFlags: this.consoleFlags,
        version: this.versionForBanner,
        botNick: this.botNickForBanner,
        stats: this.manager.getStats(),
        otherSessions: this.manager
          .getSessionList()
          .filter((s) => s.handle !== this.handle)
          .map((s) => s.handle),
      },
      (line) => this.writeLine(line),
    );
  }

  /** Write a line followed by \r\n. No-op if socket is destroyed. */
  writeLine(line: string): void {
    this.write(line + '\r\n');
  }

  /** DCCSessionEntry alias for the user's permission flag string. */
  get handleFlags(): string {
    return this.flags;
  }

  /** Canonical string form of the current console flag set (e.g. `"mojw"`). */
  getConsoleFlags(): string {
    return formatFlags(this.consoleFlags);
  }

  /** Replace the session's console flags and persist them to the flag store. */
  setConsoleFlags(flags: Set<ConsoleFlagLetter>): void {
    this.consoleFlags = new Set(flags);
    this.consoleFlagStore?.set(this.handle, formatFlags(this.consoleFlags));
  }

  /**
   * Deliver a log record to this session if the filter permits. Silently
   * skips the session while the password prompt is still pending — new
   * log lines must not leak before authentication.
   */
  receiveLog(record: LogRecord): void {
    if (this.closed) return;
    if (this.phase !== 'active') return;
    if (!shouldDeliverToSession(record, this.consoleFlags)) return;
    this.writeLine(record.dccFormatted);
  }

  private write(data: string): void {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(data);
    }
  }

  /** Relay callback — when set, all input is forwarded here instead of processed locally. */
  private _relayCallback: ((line: string) => void) | null = null;
  private _relayTarget: string | null = null;
  /** True once the target bot has ACKed the RELAY_REQUEST. */
  private _relayConfirmed = false;
  /** Pending-confirmation timer — cleared on confirm or exit. */
  private _relayTimer: NodeJS.Timeout | null = null;

  /**
   * Put this session into relay mode. All input goes to the callback.
   * If `options` is provided, the relay starts in pending state: the caller
   * must call `confirmRelay()` before `options.timeoutMs` elapses, otherwise
   * `options.onTimeout` fires.
   */
  enterRelay(
    targetBot: string,
    callback: (line: string) => void,
    options?: RelayEnterOptions,
  ): void {
    this._relayCallback = callback;
    this._relayTarget = targetBot;
    this._relayConfirmed = !options;
    if (this._relayTimer) {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
    }
    if (options) {
      this._relayTimer = setTimeout(() => {
        this._relayTimer = null;
        if (this._relayConfirmed) return;
        const target = this._relayTarget;
        this.exitRelay();
        this.writeLine(`*** Relay request to ${target} timed out.`);
        options.onTimeout();
      }, options.timeoutMs);
      this._relayTimer.unref?.();
    }
  }

  /** Promote a pending relay to confirmed. No-op if already confirmed or not relaying. */
  confirmRelay(): void {
    if (!this._relayCallback || this._relayConfirmed) return;
    this._relayConfirmed = true;
    if (this._relayTimer) {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
    }
    this.writeLine(`*** Now relaying to ${this._relayTarget}. Type \x02.relay end\x02 to return.`);
  }

  /** Exit relay mode. */
  exitRelay(): void {
    this._relayCallback = null;
    this._relayTarget = null;
    this._relayConfirmed = false;
    if (this._relayTimer) {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
    }
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

    // Relay mode: forward input to remote bot.
    // Only `.relay end` exits — `.quit` is intentionally forwarded so the user
    // is not surprised by an early exit (the usage string documents `.relay end`).
    if (this._relayCallback) {
      if (trimmed === '.relay end') {
        const target = this._relayTarget;
        this.exitRelay();
        this.writeLine(`*** Relay ended. Back on ${this.manager.getBotName()}.`);
        if (target !== null) {
          this.manager.onRelayEnd?.(this.handle, target);
        }
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

    if (trimmed === '.who' || trimmed === '.online') {
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
        dccSession: this,
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
      this.socket.write('Enter your password:\r\n');
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

  /**
   * Clear every timer owned by this session. A single choke-point so neither
   * `close()` nor `onClose()` can miss the idle-, prompt-, or relay-timer
   * when the socket drops mid-flight.
   */
  private clearAllTimers(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Defensive: close() may arrive while a pending relay is still awaiting
    // confirmation. The happy-path exitRelay() clears this timer first, so
    // the branch only fires if the socket dies mid-handshake.
    /* v8 ignore next 4 */
    if (this._relayTimer !== null) {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
    }
  }

  /** Close the session gracefully. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    this.clearAllTimers();

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

    this.clearAllTimers();
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
  private logger: LoggerLike | null;
  private getStatsFn: (() => BannerStats) | null;
  private db: BotDatabase | null;
  private eventBus: BotEventBus | null;
  // Store as `unknown` functions — the typed `BotEvents` signatures collide
  // with `BotEventBus.off`'s constrained generic, so we widen at storage
  // and keep the narrowing at listener-construction time in attach().
  private eventBusListeners: Array<{ event: string; fn: (...args: never[]) => void }> = [];

  private readonly sessions: Map<string, DCCSessionEntry>;
  private readonly portAllocator: PortAllocator;
  /** Port → awaiting-connect entry. Injectable via `deps.pending` for tests. */
  private readonly pending: Map<number, PendingDCC>;
  private casemapping: Casemapping = 'rfc1459';
  private botNick: string;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private authSweepTimer: NodeJS.Timeout | null = null;
  private readonly consoleFlagStore: ConsoleFlagStore;
  private logSink: LogSink | null = null;

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
    this.pending = deps.pending ?? new Map();
    this.authTracker = deps.authTracker ?? new DCCAuthTracker();
    this.consoleFlagStore = deps.consoleFlagStore ?? createInMemoryConsoleFlagStore();
    this.db = deps.db ?? null;
    this.eventBus = deps.eventBus ?? null;
  }

  /** Read-only access to the console flag store — used by `.console <handle>`. */
  getConsoleFlagStore(): ConsoleFlagStore {
    return this.consoleFlagStore;
  }

  /** Called by DCCSession when the password prompt succeeds. */
  onAuthSuccess(session: DCCSessionEntry): void {
    const key = session.rateLimitKey;
    this.authTracker.recordSuccess(key);
    // Emit the info log before registering the session so the DCC fanout
    // sink does not echo "session active" back to the joining user's own
    // console — they already saw the banner. Existing sessions and the
    // stdout/file sinks still get it.
    this.logger?.info(`DCC session active: ${session.handle} (${session.nick})`);
    this.sessions.set(ircLower(session.nick, this.casemapping), session);
    this.announce(`*** ${session.handle} has joined the console`);
    this.onPartyJoin?.(session.handle, session.nick);
  }

  /** Called by DCCSession when the password prompt fails. */
  onAuthFailure(key: string, handle: string): void {
    const status = this.authTracker.recordFailure(key);
    // Always emit an auth-fail row — never the attempted password, only the
    // remote-peer key (`ip:port`) and the handle that was being authenticated.
    tryLogModAction(
      this.db,
      {
        action: 'auth-fail',
        source: 'dcc',
        target: handle,
        outcome: 'failure',
        metadata: { peer: key, failures: status.failures },
      },
      this.logger,
    );
    if (status.locked) {
      const seconds = Math.ceil((status.lockedUntil - Date.now()) / 1000);
      this.logger?.warn(
        `DCC auth lockout: ${key} (handle=${handle}) locked for ~${seconds}s after repeated failures`,
      );
      // A distinct auth-lockout row makes brute-force attempts queryable as
      // a single event instead of one row per individual failure.
      tryLogModAction(
        this.db,
        {
          action: 'auth-lockout',
          source: 'dcc',
          target: handle,
          outcome: 'failure',
          reason: `locked for ~${seconds}s`,
          metadata: { peer: key, lockedUntil: status.lockedUntil },
        },
        this.logger,
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
    const onNotice = (...args: unknown[]) => this.mirrorNotice(args[0]);
    const onPrivmsg = (...args: unknown[]) => this.mirrorPrivmsg(args[0]);
    this.client.on('notice', onNotice);
    this.client.on('privmsg', onPrivmsg);
    this.ircListeners = [
      { event: 'notice', fn: onNotice },
      { event: 'privmsg', fn: onPrivmsg },
    ];

    // Periodic sweep of the auth tracker — mirrors BotLinkAuthManager.
    // Without this, failed-DCC-auth hostmasks accumulate forever.
    this.authSweepTimer = setInterval(() => this.authTracker.sweep(), 300_000);
    this.authSweepTimer.unref();

    // Subscribe to the global logger so every log line gets a chance to
    // reach a matching DCC session. The sink is removed in detach() so
    // later logs do not walk a stale sessions map.
    this.logSink = (record) => this.fanoutLogToSessions(record);
    LoggerClass.addSink(this.logSink);

    // Close live sessions on password rotation or deletion. Without this,
    // a compromised session that was authenticated under the old password
    // keeps running until idle timeout — rotating the password has no
    // effect on whatever the attacker is already doing.
    if (this.eventBus) {
      const onPasswordChanged = (handle: string): void => {
        this.closeSessionsForHandle(handle, 'password rotated');
      };
      const onUserRemoved = (handle: string): void => {
        this.closeSessionsForHandle(handle, 'user removed');
      };
      this.eventBus.on('user:passwordChanged', onPasswordChanged);
      this.eventBus.on('user:removed', onUserRemoved);
      this.eventBusListeners.push(
        {
          event: 'user:passwordChanged',
          fn: onPasswordChanged as unknown as (...args: never[]) => void,
        },
        {
          event: 'user:removed',
          fn: onUserRemoved as unknown as (...args: never[]) => void,
        },
      );
    }

    this.logger?.info(
      `DCC CHAT listening (${this.config.ip}, ports ${this.config.port_range[0]}–${this.config.port_range[1]})`,
    );
  }

  /**
   * Fan a single log record out to every active session. Exposed as a
   * private method so it can be tested directly without pulling in the
   * full Logger machinery.
   */
  private fanoutLogToSessions(record: LogRecord): void {
    for (const session of this.sessions.values()) {
      try {
        session.receiveLog(record);
        /* v8 ignore start -- defensive: one broken session must not block others */
      } catch {
        // Swallow — mirrors the Logger sink contract.
      }
      /* v8 ignore stop */
    }
  }

  /** Detach and close all sessions. */
  detach(reason = 'Bot shutting down.'): void {
    if (this.authSweepTimer) {
      clearInterval(this.authSweepTimer);
      this.authSweepTimer = null;
    }
    if (this.logSink) {
      LoggerClass.removeSink(this.logSink);
      this.logSink = null;
    }
    this.dispatcher.unbindAll(PLUGIN_ID);
    for (const { event, fn } of this.ircListeners) {
      this.client.removeListener(event, fn);
    }
    this.ircListeners = [];
    if (this.eventBus) {
      for (const { event, fn } of this.eventBusListeners) {
        // Cast is safe: we only ever push listeners we registered on this
        // bus via `.on()` with the same pair, and `.off()` wants the
        // matching narrowed signature back.
        (
          this.eventBus as unknown as {
            off: (e: string, f: (...args: never[]) => void) => void;
          }
        ).off(event, fn);
      }
    }
    this.eventBusListeners = [];
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

  /**
   * Forward a raw IRC notice to all DCC sessions, skipping channel notices
   * and NickServ ACC/STATUS replies (internal permission-verification
   * chatter that shouldn't reach operator consoles). Extracted from
   * {@link attach} so unit tests can drive it directly.
   */
  mirrorNotice(raw: unknown): void {
    const e = toEventObject(raw);
    const nick = String(e.nick ?? '');
    const target = String(e.target ?? '');
    const message = String(e.message ?? '');
    if (/^[#&]/.test(target)) return;
    if (this.services.isNickServVerificationReply(nick, message)) return;
    this.announce(`-${sanitize(nick)}- ${sanitize(message)}`);
  }

  /** Forward a raw IRC PRIVMSG to all DCC sessions, skipping channel messages. */
  mirrorPrivmsg(raw: unknown): void {
    const e = toEventObject(raw);
    const nick = String(e.nick ?? '');
    const target = String(e.target ?? '');
    const message = String(e.message ?? '');
    if (/^[#&]/.test(target)) return;
    this.announce(`<${sanitize(nick)}> ${sanitize(message)}`);
  }

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
    const lowerNick = ircLower(nick, this.casemapping);
    const session = this.sessions.get(lowerNick);
    if (session) {
      if (session.isStale) {
        // Either the session already closed itself, or the socket is dead
        // but onClose hasn't fired yet. Evict and let the new offer through.
        if (session.isClosed) {
          this.sessions.delete(lowerNick);
        } else {
          this.logger?.info(`DCC: evicting stale session for ${nick}`);
          session.close('Stale session replaced.');
        }
      } else {
        this.client.notice(nick, 'DCC CHAT: you already have an active session.');
        return false;
      }
    }
    for (const p of this.pending.values()) {
      if (ircLower(p.nick, this.casemapping) === lowerNick) {
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
    // Kernel TCP keepalive: detect dead peers in ~minutes instead of waiting
    // for a read to surface ETIMEDOUT. Without this, NAT/firewall state loss
    // can leave the session looking alive for 15+ minutes.
    socket.setKeepAlive(true, 60_000);

    // Early error handler — guards the window before DCCSession.start()
    // attaches its own. Once the session is started, its handler also fires
    // (and is idempotent), so both coexist harmlessly.
    socket.on('error', (err) => {
      this.logger?.debug(`DCC socket error for ${pending.nick}: ${err.message}`);
    });

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
      consoleFlagStore: this.consoleFlagStore,
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

  /**
   * Close every live session whose authenticated handle matches `handle`
   * (case-insensitive). Triggered by `user:passwordChanged` and
   * `user:removed` so a compromised session that authenticated under the
   * old credentials cannot survive a rotation.
   */
  private closeSessionsForHandle(handle: string, reason: string): void {
    const lowerHandle = handle.toLowerCase();
    const toClose: Array<[string, DCCSessionEntry]> = [];
    for (const [key, session] of this.sessions.entries()) {
      if (session.handle.toLowerCase() === lowerHandle) {
        toClose.push([key, session]);
      }
    }
    if (toClose.length === 0) return;
    this.logger?.warn(`Closing ${toClose.length} DCC session(s) for ${handle}: ${reason}`);
    for (const [key, session] of toClose) {
      session.close(`Session ended: ${reason}.`);
      this.sessions.delete(key);
    }
  }
}
