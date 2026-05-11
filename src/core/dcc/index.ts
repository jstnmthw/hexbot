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
import type { BotEventBus, BotEvents } from '../../event-bus';
import type { LogRecord, LogSink, LoggerLike } from '../../logger';
import { Logger as LoggerClass } from '../../logger';
import type { DccConfig, HandlerContext, PluginServices, UserRecord } from '../../types';
import { stripFormatting } from '../../utils/strip-formatting';
import type { Casemapping } from '../../utils/wildcard';
import { tryLogModAction } from '../audit';
import { clearAuditTailForSession, clearPagerForSession } from '../commands/modlog-commands';
import { verifyPassword } from '../password';
import { DCCAuthTracker } from './auth-tracker';
import { type BannerLoginSummary, type BannerStats, renderBanner } from './banner';
import {
  type ConsoleFlagLetter,
  type ConsoleFlagStore,
  DEFAULT_CONSOLE_FLAGS,
  formatFlags,
  parseCanonicalFlags,
  shouldDeliverToSession,
} from './console-flags';
import {
  type MirrorRateLimiter,
  createMirrorRateLimiter,
  extractMirrorEvent as extractMirrorEventImpl,
  mirrorNotice as mirrorNoticeImpl,
  mirrorPrivmsg as mirrorPrivmsgImpl,
} from './irc-mirror';
import { buildLoginSummary } from './login-summary';
import {
  DCC_PROMPT_TIMEOUT_MS,
  type DccChatPayload,
  ipToDecimal,
  isPassiveDcc,
  parseDccChatPayload,
} from './protocol';
import { DCCSessionStore } from './session-store';

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

/**
 * Bot-side connection-state snapshot surfaced to DCC sessions. Mirrors the
 * subset of `ReconnectState` that the prompt path actually needs. Modelled
 * locally (rather than re-exported from `reconnect-driver.ts`) to keep
 * `dcc/index.ts`'s import surface minimal.
 */
export type DCCReconnectStatus = 'connected' | 'reconnecting' | 'degraded' | 'stopped';

/** The subset of DCCManager that DCCSession depends on. */
export interface DCCSessionManager {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  broadcast(fromHandle: string, message: string): void;
  announce(message: string): void;
  removeSession(nick: string): void;
  notifyPartyPart(handle: string, nick: string): void;
  getBotName(): string;
  getStats(): BannerStats | null;
  /**
   * Snapshot of the bot's IRC reconnect state — surfaced to DCC sessions
   * so an operator on a still-open console can see `[disconnected]`
   * while the bot is mid-reconnect rather than discovering it via a
   * silently-failing command. `null` when the manager has no reconnect
   * driver wired up (test fixtures, dev preview).
   */
  getReconnectStatus?(): DCCReconnectStatus | null;
  onRelayEnd?: ((handle: string, targetBot: string) => void) | null;
  /**
   * Re-fetch the live `password_hash` for `handle` from the underlying
   * permissions store. DCCSession.handlePasswordLine() consults this at
   * verify time so a `.chpass` rotation (or `user:removed`) that lands
   * during the prompt window invalidates the captured hash from
   * openSession() — without it, an attacker who learns the OLD password
   * could authenticate against the rotated record. Returns `null` when
   * the user no longer exists or has no hash on file.
   *
   * Optional so test mocks needn't implement it; DCCSession falls back
   * to its captured hash when unset.
   */
  getCurrentPasswordHashForHandle?(handle: string): string | null;
  /**
   * Register a session that has not yet authenticated so the manager's
   * eviction sweeps (`user:passwordChanged`, `user:removed`) can close
   * it during the prompt window. Without this, sessions in
   * `awaiting_password` live only as a closure inside `openSession()`
   * — they're invisible to `closeSessionsForHandle()` until the
   * password verification adds them to the live session map.
   */
  registerPendingSession?(session: DCCSessionEntry): void;
  /** Counterpart: drop the session once it has transitioned out of `awaiting_password`. */
  unregisterPendingSession?(session: DCCSessionEntry): void;
  /**
   * Called when the password prompt succeeds. The session has entered the
   * `active` phase and should be announced to other sessions. Implementations
   * may also clear any rate-limit failure counters for the session's key.
   *
   * Returns the `mod_log` row id of the `login/success` row written for
   * this session, or `null` when no row was written (degraded db, test
   * mock). DCCSession threads the id into `getLoginSummaryForHandle()`
   * so the row we literally just wrote is excluded from the "previous
   * login" lookup.
   */
  onAuthSuccess?(session: DCCSessionEntry): number | null;
  /**
   * Called when the password prompt fails. The session is about to close.
   * Implementations should increment failure counters and emit warnings.
   */
  onAuthFailure?(key: string, handle: string): void;
  /**
   * Build the failed-login warning block for the banner. Returns `null`
   * when the implementation has no db wired up (test fixtures) or there
   * is nothing to warn about. Optional so mocks don't have to implement
   * it — DCCSession defaults to `null` when absent.
   */
  getLoginSummaryForHandle?(
    handle: string,
    beforeLoginId: number | null,
  ): BannerLoginSummary | null;
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
   * Bot start timestamp source (unix seconds). Used by the failed-login
   * banner as the "since" anchor when a handle has no prior login row
   * (first-ever auth, or retention-swept). Reuses {@link Bot.startedAt}
   * in production; a lambda is used so the manager can be constructed
   * before the bot's own `startedAt` is finalized.
   */
  getBootTs?: () => number;
  /**
   * Event bus used to subscribe to `user:passwordChanged` and
   * `user:removed` so the manager can close any live session for a
   * rotated or deleted handle. Optional so existing test fixtures keep
   * working, but the production wiring in `bot.ts` always passes it.
   */
  eventBus?: BotEventBus | null;
  /**
   * Snapshot getter for the bot's IRC reconnect state. Surfaced to DCC
   * sessions so the prompt path can render `[disconnected]` while the
   * bot is mid-reconnect. Returns `null` when the bot has no driver
   * (e.g. early init or dev preview) — DCC then assumes connected.
   */
  getReconnectStatus?: () => DCCReconnectStatus | null;
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
  /** Cached `nick!ident@host` — stable for the life of the session. */
  private readonly _rateLimitKey: string;
  /**
   * `mod_log` row id of the `login/success` row written for this session,
   * or null when no row was written. Threaded into the banner's
   * login-summary lookup so the row we just wrote is never returned as
   * the "previous login".
   */
  private lastWrittenLoginId: number | null = null;

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
    this._rateLimitKey = `${opts.nick}!${opts.ident}@${opts.hostname}`;

    const stored = this.consoleFlagStore?.get(this.handle) ?? null;
    this.consoleFlags =
      stored !== null ? parseCanonicalFlags(stored) : parseCanonicalFlags(DEFAULT_CONSOLE_FLAGS);
  }

  /** Key used for rate-limit tracking — `nick!ident@host`. */
  get rateLimitKey(): string {
    return this._rateLimitKey;
  }

  /**
   * Start the session: wire up readline, send the password prompt, and wait
   * for the first line of input. The banner is **not** sent until the
   * password prompt succeeds — see {@link showBanner}. version/botNick are
   * captured here (not in the constructor) so a single DCCSession instance
   * can be re-used by tests that drive the prompt directly.
   *
   * `preStartErrorHandler` is the early `socket.once('error', …)` listener
   * that {@link DCCManager.openSession} installs to bridge the window
   * before the session's own error handler is attached. We remove it
   * here so the per-session closure (which captures `this`) is the only
   * 'error' listener for the rest of the session lifetime.
   */
  start(version: string, botNick: string, preStartErrorHandler?: (err: Error) => void): void {
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

    this.lineHandler = (line: string) => {
      // readline has just delivered a complete line — every byte that
      // contributed to it is no longer "pending". Reset before dispatch so
      // the next chunk's accounting starts clean.
      this.pendingLineBytes = 0;
      this.onLine(line);
    };
    rl.on('line', this.lineHandler);

    if (preStartErrorHandler) {
      this.socket.off('error', preStartErrorHandler);
    }
    this.attachLifecycleHandlers();
  }

  /**
   * Maximum bytes accepted for a single DCC input line before we drop the
   * session. Legitimate commands and passwords are always well under 4 KiB;
   * anything larger is either broken client input or an attacker streaming
   * bytes without a newline to pin memory during the prompt window.
   */
  private static readonly MAX_LINE_BYTES = 4096;
  /**
   * Cap on blank lines accepted during the password prompt. Each blank
   * resets the idle timer, so without this an attacker could keep a
   * half-authenticated socket open indefinitely by dripping empty lines.
   */
  private static readonly MAX_BLANK_PROMPTS = 3;
  private pendingLineBytes = 0;
  private blankPromptCount = 0;
  /**
   * Named reference to the 'data' listener installed by
   * {@link attachLineLengthGuard}. Stored so {@link clearAllTimers} can
   * remove it explicitly — without this, the closure (which captures
   * `this`) lives until the socket itself is destroyed.
   */
  private dataGuard: ((chunk: Buffer) => void) | null = null;
  /**
   * Named references to the socket lifecycle listeners installed by
   * {@link start} / {@link startActiveForTesting}. Stored so
   * {@link clearAllTimers} can `socket.off()` them — without this, the
   * closures (which capture `this`) live until the socket itself is
   * destroyed and GC'd, retaining the full session graph during the
   * window where the socket has emitted `close` but isn't yet collected.
   */
  private closeHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;
  /**
   * Named reference to the readline 'line' listener. Released via
   * `rl.close()` in `teardownSession`, but the named field lets us
   * `rl.off('line', this.lineHandler)` symmetrically with
   * {@link dataGuard} so heap snapshots taken between socket-close and
   * GC don't show an anonymous `this`-capturing closure.
   */
  private lineHandler: ((line: string) => void) | null = null;

  /**
   * Count bytes that arrive on the socket between newlines and destroy the
   * session if a single line exceeds {@link MAX_LINE_BYTES}. This closes
   * the "fill the prompt buffer without a newline" DoS path: readline
   * buffers everything until `\n`, so without a cap an attacker who wins
   * the CTCP race can stream gigabytes into a prompt that never resolves.
   */
  private attachLineLengthGuard(): void {
    this.dataGuard = (chunk: Buffer) => {
      // 0x0a = LF. We track bytes accumulated since the most recent newline
      // — when the chunk has no LF we extend the running count; when it
      // does, we reset to whatever follows the LAST LF (the partial trailing
      // line that readline will continue to buffer).
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
    };
    this.socket.on('data', this.dataGuard);
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
   * the behavior under test (relay, command routing, idle timer, …).
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

    this.lineHandler = (line: string) => {
      // See `start()` — reset the pending-bytes guard on each completed line.
      this.pendingLineBytes = 0;
      this.onLine(line);
    };
    rl.on('line', this.lineHandler);

    this.attachLifecycleHandlers();
  }

  /**
   * Wire the named close/error handlers onto the socket. Shared by
   * {@link start} and {@link startActiveForTesting} so the named-field
   * cleanup in {@link clearAllTimers} works for both entry points.
   */
  private attachLifecycleHandlers(): void {
    this.closeHandler = () => this.onClose();
    /* v8 ignore next -- socket error event unreachable in tests: Duplex.emit('error') propagates even with a handler */
    this.errorHandler = () => this.onClose();
    this.socket.on('close', this.closeHandler);
    this.socket.on('error', this.errorHandler);
  }

  /** Send the welcome banner + stats. Called after the password prompt succeeds. */
  private showBanner(): void {
    const loginSummary =
      this.manager.getLoginSummaryForHandle?.(this.handle, this.lastWrittenLoginId) ?? null;
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
        loginSummary,
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

  /**
   * Relay state machine. Transitions only go through `setRelayState()` so
   * invalid combinations (e.g. a pending timer while `Idle`) are unreachable.
   *
   *   Idle ──enterRelay(confirmed)──▶ Confirmed ──exitRelay()──▶ Idle
   *   Idle ──enterRelay(pending)───▶ Pending   ──confirmRelay()──▶ Confirmed
   *                                  Pending   ──timer fires──▶ Idle (with onTimeout)
   *                                  Pending   ──exitRelay()──▶ Idle
   */
  private relay:
    | { state: 'idle' }
    | {
        state: 'pending';
        target: string;
        callback: (line: string) => void;
        timer: NodeJS.Timeout;
        onTimeout: () => void;
      }
    | { state: 'confirmed'; target: string; callback: (line: string) => void } = { state: 'idle' };

  /**
   * Centralised relay-state transition. Clears any outstanding pending-timer
   * when leaving the `pending` state so callers don't have to remember.
   */
  private setRelayState(next: typeof this.relay): void {
    if (this.relay.state === 'pending') {
      clearTimeout(this.relay.timer);
    }
    this.relay = next;
  }

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
    if (!options) {
      this.setRelayState({ state: 'confirmed', target: targetBot, callback });
      return;
    }
    const timer = setTimeout(() => {
      // The timer only fires if we're still pending — confirmRelay() and
      // exitRelay() both clear it via setRelayState().
      /* v8 ignore next */
      if (this.relay.state !== 'pending') return;
      const target = this.relay.target;
      const onTimeout = this.relay.onTimeout;
      this.setRelayState({ state: 'idle' });
      this.writeLine(`*** Relay request to ${target} timed out.`);
      onTimeout();
    }, options.timeoutMs);
    timer.unref?.();
    this.setRelayState({
      state: 'pending',
      target: targetBot,
      callback,
      timer,
      onTimeout: options.onTimeout,
    });
  }

  /** Promote a pending relay to confirmed. No-op if already confirmed or not relaying. */
  confirmRelay(): void {
    if (this.relay.state !== 'pending') return;
    const { target, callback } = this.relay;
    this.setRelayState({ state: 'confirmed', target, callback });
    this.writeLine(`*** Now relaying to ${target}. Type \x02.relay end\x02 to return.`);
  }

  /** Exit relay mode. */
  exitRelay(): void {
    this.setRelayState({ state: 'idle' });
  }

  /** True if the session is currently relayed to a remote bot. */
  get isRelaying(): boolean {
    return this.relay.state !== 'idle';
  }

  get relayTarget(): string | null {
    return this.relay.state === 'idle' ? null : this.relay.target;
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
    if (this.relay.state !== 'idle') {
      if (trimmed === '.relay end') {
        const target = this.relay.target;
        this.exitRelay();
        this.writeLine(`*** Relay ended. Back on ${this.manager.getBotName()}.`);
        this.manager.onRelayEnd?.(this.handle, target);
        return;
      }
      // Reject nested relay attempts locally. Without this guard `.relay <other>`
      // is forwarded as RELAY_INPUT to the target bot, which either bounces it
      // (source is 'botlink', not 'dcc') or silently drops it — the operator
      // just sees nothing happen.
      if (/^\.relay(\s|$)/i.test(trimmed)) {
        this.writeLine(
          `*** Relay already in progress to ${this.relay.target}. Type \x02.relay end\x02 to return to ${this.manager.getBotName()}.`,
        );
        return;
      }
      this.relay.callback(trimmed);
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

    // Surface bot-side IRC reconnect state on each input line. An operator
    // on a still-open DCC console would otherwise issue commands silently
    // into the void while the bot is mid-reconnect. The notice is emitted
    // once per line (not as a sticky prompt — DCC has no readline-style
    // prompt the bot can paint).
    this.maybeWriteReconnectNotice();

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

  /**
   * Emit a one-line `[disconnected]` notice when the bot is mid-reconnect.
   * Called from the active-phase line handler so the operator sees the
   * state on every command they type while IRC is down. Silent when the
   * manager has no reconnect-status hook (test fixtures) or the bot is
   * connected.
   */
  private maybeWriteReconnectNotice(): void {
    const status = this.manager.getReconnectStatus?.() ?? null;
    if (status === null || status === 'connected') return;
    this.writeLine(`*** [${status}] bot is not currently connected to IRC.`);
  }

  private resetIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close('Idle timeout.');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /** Shorter timer used while the password prompt is open. */
  private resetPromptIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close('Password prompt timed out.');
    }, DCC_PROMPT_TIMEOUT_MS);
    this.idleTimer.unref?.();
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
    // Cap the number of blank re-prompts per session so an attacker can't
    // reset the idle timer indefinitely and pin the socket open without
    // ever committing to a password attempt.
    if (candidate.length === 0) {
      this.blankPromptCount++;
      if (this.blankPromptCount > DCCSession.MAX_BLANK_PROMPTS) {
        this.socket.write('DCC CHAT: too many blank prompts.\r\n');
        this.close('Blank-prompt limit exceeded.');
        return;
      }
      this.socket.write('Enter your password:\r\n');
      this.resetPromptIdle();
      return;
    }

    // Re-fetch the live password_hash so a `.chpass` rotation that landed
    // mid-prompt invalidates this attempt — closes the TOCTOU between
    // openSession()'s capture of `pending.user.password_hash` and the
    // user's response. Manager returns null when the user was removed
    // mid-prompt; treat that as auth failure (no record, no login).
    // Falls back to the captured hash when the manager doesn't implement
    // the lookup (test mocks).
    const liveHash =
      this.manager.getCurrentPasswordHashForHandle?.(this.handle) ?? this.passwordHash;
    if (!liveHash) {
      this.logger?.warn(
        `DCC CHAT: rejecting ${this.handle} (${this._rateLimitKey}) — password_hash gone (user removed or rotated mid-prompt)`,
      );
      this.manager.onAuthFailure?.(this._rateLimitKey, this.handle);
      this.socket.write('DCC CHAT: account no longer accessible.\r\n');
      this.close('Account removed mid-prompt.');
      return;
    }
    // verifyPassword is total: no try/catch needed — scrypt/storage errors
    // surface as ok:false with a distinguishable reason for logging.
    const result = await verifyPassword(candidate, liveHash);

    if (this.closed) return; // session may have been closed while awaiting scrypt

    if (!result.ok) {
      /* v8 ignore next -- scrypt-error / malformed only reachable on corrupt DB rows */
      if (result.reason !== 'mismatch') {
        this.logger?.error(
          `DCC password verification ${result.reason} for ${this.handle} (${this._rateLimitKey})`,
        );
      } else {
        this.logger?.warn(`DCC CHAT: bad password from ${this.handle} (${this._rateLimitKey})`);
      }
      this.manager.onAuthFailure?.(this._rateLimitKey, this.handle);
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
    // Manager writes the `login/success` row and returns its id so the
    // banner's login-summary lookup can exclude the row we just wrote
    // via the `beforeId` cursor. A mock manager that doesn't implement
    // this returns undefined → captured as null.
    this.lastWrittenLoginId = this.manager.onAuthSuccess?.(this) ?? null;
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
    // Detach the line-length guard 'data' listener so its closure (which
    // captures `this`) is eligible for GC immediately on close, rather
    // than waiting for the socket itself to be destroyed and collected.
    if (this.dataGuard !== null) {
      this.socket.off('data', this.dataGuard);
      this.dataGuard = null;
    }
    // Same treatment for the close/error lifecycle handlers — without
    // explicit removal, the closures (which capture `this`) live until
    // the socket is destroyed, retaining the session graph in heap
    // snapshots during peer-drop spikes.
    if (this.closeHandler !== null) {
      this.socket.off('close', this.closeHandler);
      this.closeHandler = null;
    }
    if (this.errorHandler !== null) {
      this.socket.off('error', this.errorHandler);
      this.errorHandler = null;
    }
    // rl.close() in teardownSession also drops listeners, but explicit
    // off() symmetric with dataGuard / closeHandler keeps the closure
    // GC-eligible immediately rather than waiting for rl finalization.
    if (this.rl !== null && this.lineHandler !== null) {
      this.rl.off('line', this.lineHandler);
    }
    this.lineHandler = null;
    // Defensive: close() may arrive while a pending relay is still awaiting
    // confirmation. The happy-path exitRelay() clears this timer first, so
    // the branch only fires if the socket dies mid-handshake. setRelayState()
    // owns the clearTimeout — routing through it keeps the state consistent.
    /* v8 ignore next */
    if (this.relay.state === 'pending') this.setRelayState({ state: 'idle' });
  }

  /** Close the session gracefully. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    if (!this.socket.destroyed) {
      // Wrap the farewell write — a concurrent `close` event between the
      // destroyed-check and the write can still throw EPIPE. We must
      // always proceed to destroy() regardless.
      if (reason) {
        try {
          this.socket.write(`*** ${reason}\r\n`);
        } catch (err) {
          this.logger?.debug(`DCC farewell write failed (${this.handle}):`, err);
        }
      }
      this.socket.destroy();
    }

    this.teardownSession(`DCC session closed: ${this.handle} (${reason ?? 'unknown'})`);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;

    this.teardownSession(`DCC disconnected: ${this.handle} (${this.nick})`);
  }

  /**
   * Shared teardown path for both graceful {@link close} and socket-driven
   * {@link onClose}: cancel timers, close the readline, drop the session
   * from the manager, announce departure on the party line, and eagerly
   * unsubscribe modlog pager / audit-tail handlers tied to this DCC
   * session (without the eager drop they linger for `IDLE_TIMEOUT_MS`
   * after close).
   *
   * Socket destruction stays in {@link close} because only that path
   * writes a farewell message and calls `destroy()` manually;
   * {@link onClose} fires after the socket is already torn down.
   */
  private teardownSession(logMessage: string): void {
    this.clearAllTimers();
    this.rl?.close();
    // Drop from the pending set if we're still in `awaiting_password` —
    // a socket disconnect during prompt never fires `onAuthSuccess` /
    // `onAuthFailure`, so without this the entry leaks until the next
    // process restart. Idempotent: Set.delete on a missing entry is a
    // no-op, so the post-active path stays safe.
    this.manager.unregisterPendingSession?.(this);
    this.manager.removeSession(this.nick);
    this.manager.announce(`*** ${this.handle} has left the console`);
    this.manager.notifyPartyPart(this.handle, this.nick);
    clearPagerForSession(`dcc:${this.handle}`);
    clearAuditTailForSession(`dcc:${this.handle}`);
    this.logger?.info(logMessage);
  }
}

// ---------------------------------------------------------------------------
// DCCManager
// ---------------------------------------------------------------------------

/**
 * Time we'll hold a TCP listener open waiting for the user's DCC client to
 * dial back after we've sent the passive DCC reply CTCP. 30s mirrors the
 * password-prompt timeout in protocol.ts and is well above any realistic
 * connect latency — the limiting factor for legitimate users is how long
 * they take to acknowledge the file/chat dialog in their client.
 */
const PENDING_TIMEOUT_MS = 30_000;
const PLUGIN_ID = 'core:dcc';

/**
 * Remove a listener from `bus` without re-declaring its per-event signature.
 * `BotEventBus.off`'s typed overload forces the listener's args tuple to
 * match the event name, but we store heterogeneous listeners in a single
 * array; all `off` actually needs is the original function reference.
 * The single cast is encapsulated here so grepping for listener-removal
 * casts in the DCC layer produces exactly one hit.
 */
function offBusListener(
  bus: BotEventBus,
  event: keyof BotEvents,
  fn: (...args: never[]) => void,
): void {
  (bus as unknown as { off: (e: string, f: (...args: never[]) => void) => void }).off(event, fn);
}

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
  private getReconnectStatusFn: (() => DCCReconnectStatus | null) | null;
  private db: BotDatabase | null;
  private eventBus: BotEventBus | null;
  // The typed `BotEvents` signatures collide with `BotEventBus.off`'s
  // constrained generic when storing heterogeneous handlers in one array,
  // so the stored function type is `(...args: never[]) => void` — any
  // concrete handler assigns into it via contravariance. Removal happens
  // through `offBusListener` which owns the single bridging cast.
  private eventBusListeners: Array<{
    event: keyof BotEvents;
    fn: (...args: never[]) => void;
  }> = [];

  /**
   * IRC-casemapping-aware store wrapping the sessions map. Built from
   * `deps.sessions` so tests that pre-seed a plain `Map` keep working —
   * the store just adopts whatever map the caller injected.
   */
  private readonly sessionStore: DCCSessionStore;
  private readonly portAllocator: PortAllocator;
  /** Port → awaiting-connect entry. Injectable via `deps.pending` for tests. */
  private readonly pending: Map<number, PendingDCC>;
  private botNick: string;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private authSweepTimer: NodeJS.Timeout | null = null;
  private readonly consoleFlagStore: ConsoleFlagStore;
  private logSink: LogSink | null = null;
  /**
   * True after {@link attach} has wired up its listeners and timers. Used
   * to short-circuit double-attach — without this, a second `attach()`
   * call without an intervening `detach()` would overwrite
   * {@link ircListeners}, {@link eventBusListeners}, and
   * {@link authSweepTimer}, leaking the original set.
   */
  private attached = false;

  /** Failure tracker for the password prompt — exponential backoff on repeat. */
  readonly authTracker: DCCAuthTracker;

  /**
   * Sessions in `awaiting_password` phase — not yet in `sessionStore`.
   * Tracked separately so {@link closeSessionsForHandle} can sweep them
   * during a password rotation or user removal. Without this set, an
   * in-flight prompt is invisible to eviction and an attacker who learns
   * the old password can complete the prompt against a captured (stale)
   * hash. Closes the TOCTOU together with the live-hash refetch in
   * `DCCSession.handlePasswordLine`.
   */
  private readonly pendingSessions = new Set<DCCSessionEntry>();

  /**
   * Per-manager 1-second sliding-window rate limiter for the IRC→DCC
   * console mirror. Per-instance (vs. a module-level array) so two
   * DCCManagers in the same process don't share a window and a future
   * hot-reload of irc-mirror.ts can't orphan the old timestamp captures.
   */
  private readonly mirrorRateLimiter: MirrorRateLimiter = createMirrorRateLimiter();

  /**
   * Per-identity rate gate on the `auth-fail` mod_log write. A brute-force
   * attacker cycling 5 attempts per window would otherwise produce 5
   * synchronous SQLite inserts per identity per attempt cycle. We collapse
   * those to at most one row per identity per 60s window; the suppressed
   * count is folded into the `auth-lockout` row so audit history still
   * shows the total attempts. Cleared on lockout-lift and on the periodic
   * sweep alongside the auth tracker.
   */
  private readonly authFailGate: Map<
    string,
    { lastWriteTs: number; suppressedSinceWrite: number }
  > = new Map();
  /** Sliding window for the auth-fail gate. Matches the audit's prescribed 60s. */
  private static readonly AUTH_FAIL_GATE_WINDOW_MS = 60_000;

  private getBootTs: (() => number) | null;

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
    this.getReconnectStatusFn = deps.getReconnectStatus ?? null;
    this.sessionStore = new DCCSessionStore(deps.sessions ?? new Map());
    this.portAllocator = deps.portAllocator ?? new RangePortAllocator(deps.config.port_range);
    this.pending = deps.pending ?? new Map();
    this.authTracker = deps.authTracker ?? new DCCAuthTracker();
    this.consoleFlagStore = deps.consoleFlagStore ?? createInMemoryConsoleFlagStore();
    this.db = deps.db ?? null;
    this.eventBus = deps.eventBus ?? null;
    this.getBootTs = deps.getBootTs ?? null;
  }

  /**
   * Snapshot of the bot's IRC reconnect state — surfaced to DCC sessions
   * so the prompt path can render `[disconnected]` while the bot is
   * mid-reconnect. Returns `null` when no driver is wired (test fixtures,
   * dev preview); DCCSession defaults to "connected" semantics in that
   * case so the prefix stays out of fixture output.
   */
  getReconnectStatus(): DCCReconnectStatus | null {
    return this.getReconnectStatusFn?.() ?? null;
  }

  /** Read-only access to the console flag store — used by `.console <handle>`. */
  getConsoleFlagStore(): ConsoleFlagStore {
    return this.consoleFlagStore;
  }

  /**
   * Called by DCCSession when the password prompt succeeds. Writes the
   * `login/success` row and returns its `mod_log` id so the session can
   * thread it into the banner's login-summary lookup via the `beforeId`
   * cursor — excluding the row we literally just wrote from the
   * "previous login" query. Returns `null` when no row was written
   * (`db` is absent, retention disabled, or the write was degraded).
   */
  onAuthSuccess(session: DCCSessionEntry): number | null {
    const key = session.rateLimitKey;
    this.authTracker.recordSuccess(key);
    // Promotion out of `awaiting_password`: drop from the pending set so
    // the live session map is the only place it lives from here on.
    this.pendingSessions.delete(session);
    // Emit the info log before registering the session so the DCC fanout
    // sink does not echo "session active" back to the joining user's own
    // console — they already saw the banner. Existing sessions and the
    // stdout/file sinks still get it.
    this.logger?.info(`DCC session active: ${session.handle} (${session.nick})`);
    this.sessionStore.set(session.nick, session);
    this.announce(`*** ${session.handle} has joined the console`);
    this.onPartyJoin?.(session.handle, session.nick);
    // Write the `login/success` row after the in-memory state is
    // consistent — a degraded audit write must not block the session
    // from going active.
    return tryLogModAction(
      this.db,
      {
        action: 'login',
        source: 'dcc',
        by: session.handle,
        target: session.handle,
        outcome: 'success',
        metadata: { peer: session.rateLimitKey },
      },
      this.logger,
    );
  }

  /**
   * Build the failed-login warning block for the banner. `beforeLoginId`
   * is the id of the `login/success` row the manager just wrote in
   * {@link onAuthSuccess} — passed through as the `beforeId` cursor so
   * the row we literally just wrote is excluded from the "previous
   * login" lookup. Returns `null` when there's no db wired up.
   */
  getLoginSummaryForHandle(
    handle: string,
    beforeLoginId: number | null,
  ): BannerLoginSummary | null {
    if (!this.db) return null;
    const bootTs = this.getBootTs?.() ?? Math.floor(Date.now() / 1000);
    const summary = buildLoginSummary(this.db, handle, bootTs, beforeLoginId);
    return {
      failedSince: summary.failedSince,
      mostRecent: summary.mostRecent,
      lockoutsSince: summary.lockoutsSince,
      usedBootFallback: summary.usedBootFallback,
    };
  }

  /** Called by DCCSession when the password prompt fails. */
  onAuthFailure(key: string, handle: string): void {
    // The session is about to call close() which tears the socket down;
    // drop it from the pending set up front so a concurrent
    // closeSessionsForHandle sweep doesn't double-close it via .close().
    for (const session of this.pendingSessions) {
      if (session.rateLimitKey === key) {
        this.pendingSessions.delete(session);
        break;
      }
    }
    const status = this.authTracker.recordFailure(key);
    // Per-identity rate gate: at most one `auth-fail` row per 60s window.
    // A brute-force storm against a single identity would otherwise drive
    // O(maxFailures) synchronous SQLite inserts per cycle; collapsing them
    // here keeps the audit log meaningful without amplifying the storm.
    const now = Date.now();
    const gate = this.authFailGate.get(key);
    const windowMs = DCCManager.AUTH_FAIL_GATE_WINDOW_MS;
    if (gate && now - gate.lastWriteTs < windowMs) {
      gate.suppressedSinceWrite++;
    } else {
      // Either no prior write or the window has lapsed — emit the row and
      // reset the suppression counter. Never logs the attempted password,
      // only the remote-peer key (`ip:port`) and the handle.
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
      this.authFailGate.set(key, { lastWriteTs: now, suppressedSinceWrite: 0 });
    }
    if (status.locked) {
      const seconds = Math.ceil((status.lockedUntil - Date.now()) / 1000);
      this.logger?.warn(
        `DCC auth lockout: ${key} (handle=${handle}) locked for ~${seconds}s after repeated failures`,
      );
      // A distinct auth-lockout row makes brute-force attempts queryable as
      // a single event instead of one row per individual failure. Fold
      // the suppressed count into the metadata so audit reviewers can see
      // the total attempts that fed into the lockout, not just the rows.
      const totalSuppressed = this.authFailGate.get(key)?.suppressedSinceWrite ?? 0;
      tryLogModAction(
        this.db,
        {
          action: 'auth-lockout',
          source: 'dcc',
          target: handle,
          outcome: 'failure',
          reason: `locked for ~${seconds}s`,
          metadata: {
            peer: key,
            lockedUntil: status.lockedUntil,
            suppressedFailRows: totalSuppressed,
          },
        },
        this.logger,
      );
      // Lockout fired — drop the gate so the post-lockout window starts
      // fresh. Subsequent attempts after the lockout lifts will get their
      // own `auth-fail` row again (matches the audit's "cleared via
      // lockout-lift" prescription).
      this.authFailGate.delete(key);
    }
  }

  setCasemapping(cm: Casemapping): void {
    this.sessionStore.setCasemapping(cm);
  }

  /** Attach to the dispatcher — starts listening for DCC CTCP requests. */
  attach(): void {
    if (this.attached) {
      this.logger?.warn('DCCManager.attach() called twice without detach(); ignoring');
      return;
    }
    this.attached = true;
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
    // Also drains expired entries from the auth-fail mod_log gate so
    // long-idle identities don't pin gate state forever.
    this.authSweepTimer = setInterval(() => {
      this.authTracker.sweep();
      const now = Date.now();
      const windowMs = DCCManager.AUTH_FAIL_GATE_WINDOW_MS;
      for (const [key, entry] of this.authFailGate) {
        if (now - entry.lastWriteTs >= windowMs) {
          this.authFailGate.delete(key);
        }
      }
    }, 300_000);
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
    //
    // Also drop the per-handle console-flag row from the store on
    // deletion — otherwise every removed user leaves a stale kv entry
    // that accumulates forever.
    if (this.eventBus) {
      const onPasswordChanged = (handle: string): void => {
        this.closeSessionsForHandle(handle, 'password rotated');
      };
      const onUserRemoved = (handle: string): void => {
        this.closeSessionsForHandle(handle, 'user removed');
        try {
          this.consoleFlagStore.delete(handle);
        } catch (err) {
          this.logger?.warn(`Failed to drop console-flag row for ${handle}:`, err);
        }
      };
      this.eventBus.on('user:passwordChanged', onPasswordChanged);
      this.eventBus.on('user:removed', onUserRemoved);
      this.eventBusListeners.push(
        { event: 'user:passwordChanged', fn: onPasswordChanged },
        { event: 'user:removed', fn: onUserRemoved },
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
    for (const session of this.sessionStore.values()) {
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
    this.attached = false;
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
        offBusListener(this.eventBus, event, fn);
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
   * Thin wrapper around {@link extractMirrorEventImpl} preserved so any
   * existing internal or test caller keeps working after the extraction.
   * The real implementation lives in `./irc-mirror`.
   */
  private extractMirrorEvent(
    raw: unknown,
  ): { nick: string; target: string; message: string } | null {
    return extractMirrorEventImpl(raw);
  }

  /**
   * Forward a raw IRC notice to all DCC sessions, skipping channel notices
   * and NickServ ACC/STATUS replies. Delegates to the pure helper in
   * `./irc-mirror` so the guard chain can be unit-tested in isolation.
   */
  mirrorNotice(raw: unknown): void {
    mirrorNoticeImpl(this.services, (line) => this.announce(line), raw, this.mirrorRateLimiter);
  }

  /** Forward a raw IRC PRIVMSG to all DCC sessions, skipping channel messages. */
  mirrorPrivmsg(raw: unknown): void {
    mirrorPrivmsgImpl((line) => this.announce(line), raw, this.mirrorRateLimiter);
  }

  /**
   * Send a message to all sessions except the one with the given handle.
   *
   * Per-session error boundary: if a session's socket is half-open
   * (or its writeLine throws for any other reason), mark the session
   * stale and close it, but always continue the loop so one broken
   * session doesn't silence party-line chat for everyone.
   */
  broadcast(fromHandle: string, message: string): void {
    for (const session of this.sessionStore.values()) {
      if (session.handle === fromHandle) continue;
      try {
        session.writeLine(`<${fromHandle}> ${message}`);
      } catch (err) {
        this.logger?.warn(`DCC broadcast to ${session.handle} threw — closing stale session:`, err);
        try {
          session.close('write error during broadcast');
        } catch {
          /* best-effort: session may already be tearing down */
        }
      }
    }
    this.onPartyChat?.(fromHandle, message);
  }

  /**
   * Send a message to all connected sessions.
   *
   * Per-session isolation as in {@link broadcast}.
   */
  announce(message: string): void {
    for (const session of this.sessionStore.values()) {
      try {
        session.writeLine(message);
      } catch (err) {
        this.logger?.warn(`DCC announce to ${session.handle} threw — closing stale session:`, err);
        try {
          session.close('write error during announce');
        } catch {
          /* best-effort: session may already be tearing down */
        }
      }
    }
  }

  /** Notify botlink that a DCC session closed. Called by DCCSession. */
  notifyPartyPart(handle: string, nick: string): void {
    this.onPartyPart?.(handle, nick);
  }

  /** Return a snapshot of the current session list. */
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }> {
    return this.sessionStore.snapshot();
  }

  /** Get a session by IRC nick. */
  getSession(nick: string): DCCSessionEntry | undefined {
    return this.sessionStore.get(nick);
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
    this.sessionStore.delete(nick);
  }

  // -------------------------------------------------------------------------
  // CTCP DCC handler
  // -------------------------------------------------------------------------

  private async onDccCtcp(ctx: HandlerContext): Promise<void> {
    const { nick } = ctx;
    // Strip IRC formatting before debug-logging the CTCP args. The bridge
    // already removes `\r\n\0`, but bold / color / reverse codes survive
    // and can repaint the operator's terminal when the log is tailed.
    this.logger?.debug(`DCC CTCP from ${nick}: args="${stripFormatting(ctx.args)}"`);
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
    // Duplicate-eviction runs BEFORE the session-limit check: if the user
    // already has a zombie session occupying a slot, we need to evict it
    // first so the session-limit check sees the freed slot. Otherwise a
    // stuck socket permanently locks the user out at max_sessions=N.
    if (!this.checkNotAlreadyConnected(nick)) return null;
    if (!this.checkSessionLimit(nick)) return null;
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
    this.client.notice(nick, 'DCC CHAT: request denied.');
    return null;
  }

  /** Verify user has the required DCC flags. Delegates to permissions so owner (n) implies all. */
  private checkUserFlags(nick: string, ctx: HandlerContext, user: UserRecord): boolean {
    const requiredFlags = this.config.require_flags ?? 'm';
    if (this.permissions.checkFlags(requiredFlags, ctx)) return true;
    this.logger?.info(
      `DCC CHAT rejected (insufficient flags) for ${nick}: has="${user.global}" needs="${requiredFlags}"`,
    );
    this.client.notice(nick, 'DCC CHAT: request denied.');
    return false;
  }

  /** Cap total concurrent sessions. */
  private checkSessionLimit(nick: string): boolean {
    if (this.sessionStore.size < (this.config.max_sessions ?? 5)) return true;
    this.client.notice(nick, 'DCC CHAT: request denied.');
    return false;
  }

  /** Reject if the user already has an active session or a pending connection. */
  private checkNotAlreadyConnected(nick: string): boolean {
    const lowerNick = this.sessionStore.sessionKey(nick);
    const session = this.sessionStore.get(nick);
    if (session) {
      if (session.isStale) {
        // Either the session already closed itself (isClosed=true → its
        // own teardownSession ran; just drop the residual entry), or the
        // socket is dead but onClose hasn't fired yet (call close() to
        // run teardownSession via the normal path). Pager / audit-tail
        // cleanup runs uniformly in both branches so the isClosed path
        // — which used to rely on close()'s early-return and skip
        // cleanup — still releases the `dcc:<handle>` entries.
        if (session.isClosed) {
          this.sessionStore.delete(nick);
        } else {
          this.logger?.info(`DCC: evicting stale session for ${nick}`);
          session.close('Stale session replaced.');
        }
        clearPagerForSession(`dcc:${session.handle}`);
        clearAuditTailForSession(`dcc:${session.handle}`);
      } else {
        this.client.notice(nick, 'DCC CHAT: request denied.');
        return false;
      }
    }
    for (const p of this.pending.values()) {
      if (this.sessionStore.sessionKey(p.nick) === lowerNick) {
        this.client.notice(nick, 'DCC CHAT: request denied.');
        return false;
      }
    }
    return true;
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
      this.client.notice(nick, 'DCC CHAT: request denied.');
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
      // Reuse the client-supplied token when present so the peer can
      // correlate our reply with their original passive offer; otherwise
      // mint a non-zero 16-bit token (`+1` keeps it strictly > 0 — a zero
      // token reads as "no token" to some clients and breaks correlation).
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
        cleanupPending(`timeout (${nick})`);
        this.logger?.info(`DCC offer to ${nick} timed out`);
      }, PENDING_TIMEOUT_MS),
    };
    pending.timer.unref?.();
    this.pending.set(port, pending);

    // Idempotent cleanup keyed by `port`. Both the success path
    // (`'connection'`) and the failure paths (timeout, `'error'`) end up
    // here; running twice is safe because the `pending.has(port)` check
    // gates the port-pool release. Without this, a microsecond race
    // between `'connection'` and a late `'error'` (Linux socket-accept
    // races, EADDRINUSE on a closing listener) double-released the port,
    // potentially freeing a slot owned by a parallel offer to a different
    // nick.
    const cleanupPending = (label: string): void => {
      const entry = this.pending.get(port);
      if (entry !== pending) return; // already cleaned up by a peer path
      clearTimeout(pending.timer);
      try {
        server.close();
      } catch {
        /* ignore — server may already be closed */
      }
      this.portAllocator.release(port);
      this.pending.delete(port);
      this.logger?.debug(`DCC pending port ${port} cleaned up: ${label}`);
    };

    // Detach the persistent `'error'` listener as soon as `'connection'`
    // fires. After we hand off to `openSession` the `server` is closed and
    // any subsequent `'error'` we'd see is moot — but if we *don't* detach
    // and the kernel emits a stray late `'error'` (closing-listener
    // edge case), that handler would re-run `cleanupPending` against a
    // port slot the openSession has now repurposed.
    const onError = (err: Error): void => {
      this.logger?.error(`DCC server error on port ${port}:`, err);
      cleanupPending(`error: ${err.message}`);
    };
    server.on('error', onError);

    server.once('connection', (socket: Socket) => {
      server.off('error', onError);
      cleanupPending(`accept (${nick})`);
      this.openSession(pending, socket);
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
    // attaches its own. Capture only the nick string (not the entire
    // PendingDCC) so the closure doesn't retain a UserRecord, server
    // reference, ident/hostname strings, and the cleared port-timeout
    // timer for the full session lifetime. Stored as a named function
    // so DCCSession.start() can socket.off() it once its own permanent
    // error handler is attached.
    //
    // Attached via `.once('error', ...)` so the handler self-removes after
    // the first emission — under heavy lockout/no-password churn the
    // earlier `.on(...)` attached handler stayed bound until the socket
    // was GC'd, retaining the captured `pendingNick` / `logger` closure
    // per rejected connection. `.once()` keeps the late-error catch
    // (tests / TLS teardown races) without that residue.
    const pendingNick = pending.nick;
    const logger = this.logger;
    const preHandshakeErrorHandler = (err: Error): void => {
      logger?.debug(`DCC socket error for ${pendingNick}: ${err.message}`);
    };
    socket.once('error', preHandshakeErrorHandler);

    const key = `${pending.nick}!${pending.ident}@${pending.hostname}`;

    // Rate-limit gate — refuse new prompts for recently-abused identities.
    const status = this.authTracker.check(key);
    if (status.locked) {
      const seconds = Math.max(1, Math.ceil((status.lockedUntil - Date.now()) / 1000));
      // Wrap the rejection write + destroy in try/catch: a late RST during
      // the handshake window can fire `'error'` after the once-listener
      // self-removes, so a `socket.write` throw on the rejection path would
      // escape as an unhandled error.
      try {
        socket.write(
          `DCC CHAT: too many failed password attempts — locked for ~${seconds}s. Try again later.\r\n`,
        );
        socket.destroy();
      } catch (err) {
        this.logger?.debug(
          `DCC CHAT: lockout-rejection write failed for ${key}: ${(err as Error).message}`,
        );
      }
      this.logger?.warn(
        `DCC CHAT: rejected ${pending.user.handle} (${key}) — locked out for ${seconds}s`,
      );
      return;
    }

    // Migration gate — no password means no DCC until an admin runs .chpass.
    const passwordHash = pending.user.password_hash;
    if (!passwordHash) {
      // Same posture as the lockout path above — a late RST during the
      // pre-handshake window must not escape as an unhandled error.
      try {
        socket.write(
          'DCC CHAT: this handle has no password set. Ask an admin to run ' +
            '.chpass <handle> <newpass> from the REPL, then reconnect.\r\n',
        );
        socket.destroy();
      } catch (err) {
        this.logger?.debug(
          `DCC CHAT: no-password rejection write failed for ${key}: ${(err as Error).message}`,
        );
      }
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
      idleTimeoutMs: this.config.idle_timeout_ms ?? 300_000,
      logger: this.logger,
      consoleFlagStore: this.consoleFlagStore,
    });

    this.logger?.info(`DCC CHAT: prompting ${pending.user.handle} (${pending.nick}) for password`);

    // Track in-flight pending sessions BEFORE start() so a synchronous
    // throw inside start() (or an `'error'` event in the microtask gap
    // where `start()` has removed `preHandshakeErrorHandler` but not yet
    // attached the lifecycle handlers) leaves the set entry to be reaped
    // via the close-path. If `start()` itself throws, the catch below
    // re-attaches the pre-handshake handler and removes the pending
    // session entry to avoid a leak.
    this.pendingSessions.add(session);
    try {
      session.start(this.version, this.botNick, preHandshakeErrorHandler);
    } catch (err) {
      this.logger?.error(`DCCSession.start() threw for ${pending.nick}:`, err);
      // Re-attach a fallback `'error'` listener so a late socket error
      // doesn't escape into Node's `unhandledException` path. We also
      // drop the half-registered session so password rotation doesn't
      // attempt to walk it.
      socket.once('error', preHandshakeErrorHandler);
      try {
        socket.destroy();
      } catch {
        /* ignore — socket may already be destroyed */
      }
      this.pendingSessions.delete(session);
    }
  }

  /** Live password-hash lookup used by DCCSession to close the prompt-phase TOCTOU. */
  getCurrentPasswordHashForHandle(handle: string): string | null {
    // Permissions has a cheap by-handle accessor; falling through to
    // findByHostmask would require synthesizing a hostmask. The internal
    // path keeps the semantics tight: present-but-empty == null.
    const recordPermissions = this.permissions as DCCPermissions & {
      getPasswordHash?: (handle: string) => string | null;
    };
    if (typeof recordPermissions.getPasswordHash === 'function') {
      return recordPermissions.getPasswordHash(handle);
    }
    return null;
  }

  registerPendingSession(session: DCCSessionEntry): void {
    this.pendingSessions.add(session);
  }

  unregisterPendingSession(session: DCCSessionEntry): void {
    this.pendingSessions.delete(session);
  }

  private closeAll(reason?: string): void {
    this.sessionStore.closeAll(reason);
  }

  /**
   * Close every live session whose authenticated handle matches `handle`
   * (case-insensitive). Triggered by `user:passwordChanged` and
   * `user:removed` so a compromised session that authenticated under the
   * old credentials cannot survive a rotation.
   *
   * Also walks `pendingSessions` so any in-flight `awaiting_password`
   * prompt for the same handle is torn down — without this, an attacker
   * holding the old password could complete the prompt during the
   * rotation window. The live-hash refetch in `handlePasswordLine` is
   * the primary defense; this set sweep closes the eviction gap.
   */
  private closeSessionsForHandle(handle: string, reason: string): void {
    this.sessionStore.closeForHandle(handle, reason, this.logger);
    // Iterate a snapshot — `session.close()` triggers the close handler
    // which calls `unregisterPendingSession`, mutating the set.
    const lower = handle.toLowerCase();
    for (const session of [...this.pendingSessions]) {
      if (session.handle.toLowerCase() === lower) {
        this.pendingSessions.delete(session);
        // The cast widens `close` to optional so a hand-rolled
        // `DCCSessionEntry` test fixture that omits the method (the
        // surrounding `registerPendingSession` is itself optional on
        // `DCCSessionManager`) cannot crash this teardown path.
        const closable = session as DCCSessionEntry & { close?: (reason: string) => void };
        closable.close?.(reason);
        this.logger?.warn(
          `DCC CHAT: closed pending session for ${session.handle} (${session.nick}) — ${reason}`,
        );
      }
    }
  }
}
