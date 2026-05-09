// HexBot — Services core module
// NickServ integration — bot authentication and user identity verification.
import type { BotDatabase } from '../database';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { ServicesConfig, VerifyResult } from '../types';
import { toEventObject } from '../utils/irc-event';
import { ListenerGroup } from '../utils/listener-group';
import { type Casemapping, ircLower, wildcardMatch } from '../utils/wildcard';
import { tryLogModAction } from './audit';
import type { ChannelState } from './channel-state';
import { tryParseAccResponse, tryParseStatusResponse } from './services-parser';

export type { VerifyResult };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for services. */
export interface ServicesClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  say(target: string, message: string): void;
  changeNick(nick: string): void;
}

/**
 * Four-state bot identity: 'unknown' at session start, 'pending' while
 * waiting for a NickServ ack, 'identified' once confirmed, 'unidentified'
 * once a "please identify" notice arrives without a successful ack following.
 */
export type BotIdentifyState = 'unknown' | 'pending' | 'identified' | 'unidentified';

interface PendingVerify {
  nick: string;
  /**
   * Share one underlying promise across every concurrent caller asking
   * about the same nick. Each `verifyUser()` call returns this promise
   * directly instead of issuing its own ACC/STATUS round-trip.
   */
  promise: Promise<VerifyResult>;
  /** The single `resolve` for the shared promise. */
  resolve: (result: VerifyResult) => void;
  /**
   * Cancels the timeout timer and signals the pending verification to
   * terminate. We use AbortController rather than a bare `clearTimeout`
   * reference so callers (detach, cancel-on-reissue, resolveVerification)
   * all route through the same `abort()` path — one way to tear down a
   * pending verify means one way to leak it.
   */
  controller: AbortController;
  method: 'acc' | 'status';
}

/**
 * Cap on the number of concurrent pending NickServ verifications. A
 * lagged services provider would otherwise let these pile up without
 * bound when every privileged dispatch triggers a new round-trip. Once
 * at the cap, new calls fail closed (verified:false) with a warning.
 */
const MAX_PENDING_VERIFIES = 128;

export interface ServicesDeps {
  client: ServicesClient;
  servicesConfig: ServicesConfig;
  eventBus: BotEventBus;
  logger?: LoggerLike | null;
  /**
   * Database used to record `nickserv-verify-timeout` rows when a NickServ
   * identity check times out. Optional so tests that don't care about the
   * audit trail can leave it unset.
   */
  db?: BotDatabase | null;
  /**
   * The bot's configured primary nick. Used to detect the bot's own
   * account-notify (SASL success) and NickServ "please identify" notices.
   * Optional for backwards compatibility with tests that pre-date the
   * identify-state tracking.
   */
  botNick?: string;
  /**
   * Channel-state tracker. When supplied, a successful `verifyUser` writes
   * the resolved account back to channel-state before emitting
   * `user:identified`, so any listener that subsequently reads
   * `chanUser.accountName` agrees with what NickServ just told us. Without
   * this bridge, plugins that listen to `user:identified` and re-enter
   * `verifyUser` (e.g. chanmod's auto-op reconciler) would loop until
   * something else terminates the chain — typically the IRC server's
   * `+v`/`+o` echo finally landing in `chanUser.modes`.
   */
  channelState?: ChannelState;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export class Services {
  private client: ServicesClient;
  private servicesConfig: ServicesConfig;
  private eventBus: BotEventBus;
  private logger: LoggerLike | null;
  private db: BotDatabase | null;
  private botNick: string;
  private channelState: ChannelState | null;
  private pending: Map<string, PendingVerify> = new Map();
  private listeners: ListenerGroup;
  private casemapping: Casemapping = 'rfc1459';
  /**
   * Resolved `services.services_host_pattern` — empty string when the
   * operator hasn't configured a pattern. Cached as a plain string (not
   * the config reference) so the hot notice-ingest path skips the
   * config lookup and fallback on every call.
   */
  private readonly servicesHostPattern: string;
  /**
   * Running count of NickServ verifications that failed due to timeout
   * (as opposed to a real "not identified" response). Surfaced via
   * {@link getServicesTimeoutCount} so `.status` can show an operator
   * that the services provider is lagging.
   */
  private servicesTimeoutCount = 0;
  /** Count of pending verifies rejected because the cap was hit. */
  private pendingCapRejectionCount = 0;

  // -------------------------------------------------------------------------
  // Bot identify state
  // -------------------------------------------------------------------------

  /**
   * Four-state bot identity. Transitions:
   *   unknown → pending  : identify() or SASL fallback IDENTIFY sent
   *   pending → identified : "You are now identified" notice or account-notify
   *   unknown/pending → unidentified : "please identify" notice (no fallback possible)
   *   any → unknown : on disconnect (session reset)
   * Used to skip NickServ verify calls that will never succeed and
   * to surface `botIdentified` in `.status`.
   */
  private _botIdentifyState: BotIdentifyState = 'unknown';

  /**
   * True once an IDENTIFY fallback has been sent for the current session, so
   * a noisy "please identify" flood doesn't send multiple IDENTIFY lines.
   */
  private _identifyFallbackSent = false;

  /**
   * Timestamp of the last `bot:connected` event. Used by {@link verifyUser}
   * to apply a longer NickServ timeout in the post-reconnect window, when
   * services may be catching up from a flood of reconnecting clients.
   */
  private reconnectedAt: number | null = null;

  /** Stored eventBus listeners so they can be removed in {@link detach}. */
  private readonly _onConnected: () => void;
  private readonly _onDisconnected: () => void;

  constructor(deps: ServicesDeps) {
    this.client = deps.client;
    this.servicesConfig = deps.servicesConfig;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger?.child('services') ?? null;
    this.db = deps.db ?? null;
    this.botNick = deps.botNick ?? '';
    this.channelState = deps.channelState ?? null;
    this.listeners = new ListenerGroup(deps.client, this.logger);
    this.servicesHostPattern = (deps.servicesConfig.services_host_pattern ?? '').trim();

    // Capture listener refs for removal in detach() — arrow functions lose
    // identity if created inline in on/off pairs.
    this._onConnected = () => {
      this.reconnectedAt = Date.now();
      this._identifyFallbackSent = false;
      // I-1: warn if SASL is configured but the bot is still not identified
      // a few seconds after registration. This fires seconds after reconnect
      // rather than waiting for chanmod probe timeouts to surface the miss.
      if (this.servicesConfig.sasl) {
        setTimeout(() => {
          if (this._botIdentifyState !== 'identified') {
            this.logger?.warn(
              'SASL configured but bot is not identified after connect — SASL may have failed silently. ' +
                'Check for a "This nickname is registered" NickServ notice.',
            );
          }
        }, 3_000).unref();
      }
    };
    this._onDisconnected = () => {
      const wasIdentified = this._botIdentifyState === 'identified';
      this._botIdentifyState = 'unknown';
      this._identifyFallbackSent = false;
      this.reconnectedAt = null;
      if (wasIdentified) {
        this.eventBus.emit('bot:deidentified');
      }
    };
  }

  /**
   * Apply the network's CASEMAPPING. Drives the lowercase-nick keys used in
   * the pending-verify map and `account-notify` self-detection.
   */
  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Start listening for NickServ responses. */
  attach(): void {
    this.listeners.on('notice', (...args: unknown[]) => {
      this.onNotice(toEventObject(args[0]));
    });
    // IRCv3 account-notify: fires when the bot's own SASL authentication
    // succeeds (nick='*' pre-registration) or when a post-registration
    // account change is observed. Used to set _botIdentifyState without
    // waiting for NickServ notices.
    this.listeners.on('account', (...args: unknown[]) => {
      this.onAccountNotify(toEventObject(args[0]));
    });
    this.eventBus.on('bot:connected', this._onConnected);
    this.eventBus.on('bot:disconnected', this._onDisconnected);
    this.logger?.info('Attached to IRC client');
  }

  /** Stop listening. */
  detach(): void {
    this.listeners.removeAll();
    this.eventBus.off('bot:connected', this._onConnected);
    this.eventBus.off('bot:disconnected', this._onDisconnected);
    // Clean up pending verifications — abort() fires the signal handler
    // which clears the setTimeout and resolves the awaiting promise.
    for (const p of this.pending.values()) {
      p.controller.abort();
    }
    this.pending.clear();
    this.logger?.info('Detached from IRC client');
  }

  /**
   * Abort every in-flight NickServ verify. Intended for the disconnect
   * path so a mid-verification socket drop fails the awaiting caller
   * immediately instead of waiting for the natural timeout and writing
   * a misleading `nickserv-verify-timeout` audit row.
   */
  cancelPendingVerifies(reason: string): void {
    if (this.pending.size === 0) return;
    this.logger?.info(`Cancelling ${this.pending.size} pending verify(s): ${reason}`);
    for (const p of this.pending.values()) {
      p.controller.abort();
    }
    this.pending.clear();
  }

  /**
   * Authenticate the bot with NickServ (non-SASL fallback).
   * Call this after the bot is registered on the network.
   * SASL is handled by irc-framework at connect time — this is the fallback.
   */
  identify(): void {
    if (this.servicesConfig.sasl) return; // SASL handles auth
    if (this.servicesConfig.type === 'none') return;
    if (!this.servicesConfig.password) return;

    const target = this.getNickServTarget();
    this.client.say(target, `IDENTIFY ${this.servicesConfig.password}`);
    this._botIdentifyState = 'pending';
    this.logger?.info('Sent IDENTIFY to NickServ');
  }

  /**
   * Verify a user's identity via NickServ ACC/STATUS.
   *
   * Concurrent callers asking about the same nick share a single
   * in-flight promise — the old behavior canceled the existing
   * pending verification and started a fresh one on every duplicate,
   * restarting the timeout and piling up abandoned promises under
   * dispatch pressure.
   *
   * Fail-closed behavior: on timeout the promise resolves
   * `{verified:false, account:null}` and {@link servicesTimeoutCount}
   * is incremented so `.status` can report services degradation.
   *
   * @param nick - The nick to verify
   * @param timeoutMs - Timeout in milliseconds (default 5000)
   */
  async verifyUser(nick: string, timeoutMs: number = 5000): Promise<VerifyResult> {
    // Services type 'none' — always verified
    if (this.servicesConfig.type === 'none') {
      return { verified: true, account: nick };
    }

    // C-3: if the bot is known-unidentified, NickServ will ignore STATUS/ACC
    // queries from us (Rizon/Anope silently drops them). Fail fast with a
    // structured reason so the caller sees a clean verified:false rather than
    // a 5-second timeout.
    if (this._botIdentifyState === 'unidentified') {
      this.logger?.warn(
        `Skipping NickServ verify for ${nick} — bot is not identified (will retry once bot identifies)`,
      );
      return { verified: false, account: null };
    }

    // W-3: use a longer timeout in the post-reconnect window. NickServ is
    // under heavy load when all reconnecting clients flood in simultaneously.
    // Apply within 30s of bot:connected; once outside the window, the normal
    // 5s default is appropriate.
    const RECONNECT_GRACE_WINDOW_MS = 30_000;
    const RECONNECT_GRACE_TIMEOUT_MS = 15_000;
    const inGraceWindow =
      this.reconnectedAt !== null && Date.now() - this.reconnectedAt < RECONNECT_GRACE_WINDOW_MS;
    const effectiveTimeout = inGraceWindow
      ? Math.max(timeoutMs, RECONNECT_GRACE_TIMEOUT_MS)
      : timeoutMs;

    const target = this.getNickServTarget();
    const lowerNick = ircLower(nick, this.casemapping);

    // Dedupe: return the existing in-flight promise rather than
    // canceling it. Every concurrent caller for the same nick waits
    // on the same ACC/STATUS round-trip and sees the same result.
    const existing = this.pending.get(lowerNick);
    if (existing) {
      return existing.promise;
    }

    // Enforce the concurrent-verify cap. A frozen services provider
    // would otherwise let these accumulate without bound under
    // dispatch pressure (every privileged command creates a new
    // promise). Fail closed above the cap — callers see verified:false
    // and the dispatcher denies the command with a clean reason.
    if (this.pending.size >= MAX_PENDING_VERIFIES) {
      this.pendingCapRejectionCount++;
      this.logger?.warn(
        `Pending verify cap reached (${MAX_PENDING_VERIFIES}) — failing closed for ${nick}. ` +
          `Services provider is likely overloaded or unreachable.`,
      );
      // Audit the cap rejection — the stability-audit baseline for the
      // pending-verify cap requires a `mod_log` trail so review can tell a
      // real services outage (many `nickserv-verify-cap` rows in a short
      // window) apart from a single user-triggered anomaly.
      tryLogModAction(
        this.db,
        {
          action: 'nickserv-verify-cap',
          by: 'bot',
          source: 'system',
          target: nick,
          reason: `pending verify cap (${MAX_PENDING_VERIFIES}) reached`,
          metadata: { totalRejected: this.pendingCapRejectionCount },
        },
        this.logger,
      );
      return { verified: false, account: null };
    }

    const controller = new AbortController();
    let resolveOuter!: (v: VerifyResult) => void;
    const promise = new Promise<VerifyResult>((resolve) => {
      resolveOuter = resolve;
      const timer = setTimeout(() => {
        // Natural timeout path — audit and resolve as a timeout-failure.
        if (this.pending.get(lowerNick)?.controller === controller) {
          this.pending.delete(lowerNick);
        }
        this.servicesTimeoutCount++;
        this.logger?.warn(`Verification timeout for ${nick}`);
        // Audit the silent failure mode — operators reviewing a denied
        // privileged action need to distinguish "user not identified" from
        // "services were unreachable". The action label leaves no doubt.
        tryLogModAction(
          this.db,
          {
            action: 'nickserv-verify-timeout',
            source: 'system',
            target: nick,
            outcome: 'failure',
            metadata: {
              timeoutMs: effectiveTimeout,
              servicesTimeoutCount: this.servicesTimeoutCount,
            },
          },
          this.logger,
        );
        resolve({ verified: false, account: null });
      }, effectiveTimeout);

      // `abort()` is the single cancellation idiom for every teardown path
      // (detach, resolveVerification success). Clearing the timer here
      // ensures a canceled verify never fires the timeout-audit above.
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve({ verified: false, account: null });
        },
        { once: true },
      );
    });

    // Send the verification command
    const method = this.servicesConfig.type === 'anope' ? 'status' : 'acc';
    this.pending.set(lowerNick, {
      nick,
      promise,
      resolve: resolveOuter,
      controller,
      method,
    });

    if (method === 'status') {
      this.client.say(target, `STATUS ${nick}`);
    } else {
      this.client.say(target, `ACC ${nick}`);
    }

    return promise;
  }

  /**
   * Return the running counter of verification timeouts since bot
   * start. Surfaced via `.status` so operators can see at a glance
   * whether services are degrading even without a user report.
   */
  getServicesTimeoutCount(): number {
    return this.servicesTimeoutCount;
  }

  /** Current pending verify map size — exposed for observability. */
  getPendingVerifyCount(): number {
    return this.pending.size;
  }

  /** Running count of verifies rejected because the cap was hit. */
  getPendingCapRejectionCount(): number {
    return this.pendingCapRejectionCount;
  }

  /** Return the configured services type. */
  getServicesType(): string {
    return this.servicesConfig.type;
  }

  /** Return true if services are configured and not 'none'. */
  isAvailable(): boolean {
    return this.servicesConfig.type !== 'none';
  }

  /**
   * Return true if the given notice looks like a NickServ ACC/STATUS reply —
   * i.e. `nick` matches the configured NickServ target (nick-portion only,
   * case-insensitive) AND `message` parses as either an ACC or STATUS
   * response. Used by the DCC private-notice mirror to suppress the
   * internal permission-verification chatter from operator consoles.
   */
  isNickServVerificationReply(nick: string, message: string): boolean {
    const target = this.getNickServTarget();
    const fromNick = target.includes('@') ? target.split('@')[0] : target;
    if (nick.toLowerCase() !== fromNick.toLowerCase()) return false;
    return Services.matchesVerificationShape(message);
  }

  /** Pure-function check: does this message parse as a NickServ ACC or STATUS reply? */
  static matchesVerificationShape(message: string): boolean {
    return /^(\S+)\s+ACC\s+\d+/i.test(message) || /^STATUS\s+(\S+)\s+\d+/i.test(message);
  }

  // -------------------------------------------------------------------------
  // NickServ response parsing
  // -------------------------------------------------------------------------

  private onNotice(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    const message = String(event.message ?? '');
    const hostname = String(event.hostname ?? '');

    // Only process notices from NickServ
    const nickServTarget = this.getNickServTarget();
    // NickServ might be 'NickServ' or 'nickserv@services.dal.net' — compare the nick part
    const fromNick = nickServTarget.includes('@') ? nickServTarget.split('@')[0] : nickServTarget;

    if (nick.toLowerCase() !== fromNick.toLowerCase()) {
      // Debug: log notices from other sources only when we have pending verifications
      if (this.pending.size > 0) {
        this.logger?.debug(`Ignoring notice from ${nick} (expected ${fromNick}): ${message}`);
      }
      return;
    }

    // Defence-in-depth: when a services_host_pattern is configured, reject
    // notices from a sender whose hostname doesn't match it. On
    // non-services-reserved networks a user can `/nick NickServ` and craft
    // ACC replies to resolve pending verifications with whatever level
    // they want. Matching against `services.servicesConfig` at construction
    // time keeps the hot path allocation-free.
    if (this.servicesHostPattern && !wildcardMatch(this.servicesHostPattern, hostname, true)) {
      this.logger?.warn(
        `[security] Ignoring NickServ-nick notice from unexpected host ${hostname} ` +
          `(does not match services_host_pattern="${this.servicesHostPattern}")`,
      );
      return;
    }

    this.logger?.debug(`NickServ notice: ${message}`);

    // GHOST ack fast-path: unblock any pending `ghostAndReclaim` caller as
    // soon as NickServ confirms the ghost landed (Atheme "has been ghosted",
    // Anope "has been killed" / "is not online"). Lets reclaim proceed
    // ahead of the 1.5s upper bound without changing the semantics of the
    // legacy sleep. Unknown phrases fall through to the timeout as before.
    if (
      this.pendingGhostResolver &&
      /\bghost(?:ed)?\b|\bhas been killed\b|\bis not online\b/i.test(message)
    ) {
      this.pendingGhostResolver();
    }

    const acc = tryParseAccResponse(message);
    if (acc) {
      this.logger?.debug(`ACC response: nick=${acc.nick} level=${acc.level}`);
      this.resolveVerification(acc.nick, acc.level >= 3, acc.level >= 3 ? acc.nick : null);
      return;
    }

    const status = tryParseStatusResponse(message);
    if (status) {
      this.logger?.debug(`STATUS response: nick=${status.nick} level=${status.level}`);
      this.resolveVerification(
        status.nick,
        status.level >= 3,
        status.level >= 3 ? status.nick : null,
      );
      return;
    }

    // Detect "Unknown command" and retry with the other method.
    // Some IRC networks (e.g. Anope) don't support the ACC command (Atheme-style)
    // and respond with "Unknown command ACC". In that case we fall back to STATUS,
    // and vice versa for networks that don't support STATUS.
    // Regex: capture the command name after the literal "Unknown command "
    // prefix that both Atheme and Anope emit verbatim for unknown subcommands.
    const unknownCmd = message.match(/^Unknown command (\S+)/i);
    if (unknownCmd) {
      const failedCmd = unknownCmd[1].toUpperCase();
      for (const [_key, pending] of this.pending) {
        const shouldRetry =
          ((failedCmd === 'ACC' || failedCmd === 'ACC.') && pending.method === 'acc') ||
          ((failedCmd === 'STATUS' || failedCmd === 'STATUS.') && pending.method === 'status');
        if (shouldRetry) {
          const altMethod = pending.method === 'acc' ? 'status' : 'acc';
          const target = this.getNickServTarget();
          pending.method = altMethod;
          this.logger?.info(
            `${failedCmd} not supported, falling back to ${altMethod.toUpperCase()} for ${pending.nick}`,
          );
          if (altMethod === 'status') {
            this.client.say(target, `STATUS ${pending.nick}`);
          } else {
            this.client.say(target, `ACC ${pending.nick}`);
          }
          return;
        }
      }
    }

    // C-1: detect NickServ telling the bot to identify (SASL missed).
    // Covers Anope ("This nickname is registered and protected") and
    // Atheme ("This nickname is registered"). On match, record the
    // unidentified state and, if SASL+password is configured, send a
    // password IDENTIFY as a one-shot fallback for the current session.
    const pleaseIdentify = /(?:This nickname is registered|nickname.*registered.*protected)/i.test(
      message,
    );
    if (pleaseIdentify) {
      if (this.servicesConfig.sasl && this.servicesConfig.password && !this._identifyFallbackSent) {
        this._identifyFallbackSent = true;
        this.logger?.warn(
          'NickServ "please identify" received — SASL may have failed; falling back to password IDENTIFY',
        );
        this.client.say(this.getNickServTarget(), `IDENTIFY ${this.servicesConfig.password}`);
        this._botIdentifyState = 'pending';
      } else {
        this._botIdentifyState = 'unidentified';
        if (!this.servicesConfig.sasl) {
          this.logger?.warn('NickServ "please identify" received while bot is not identified');
        }
      }
      return;
    }

    // C-1 / W-2: detect NickServ confirming identity (after IDENTIFY fallback
    // or slow SASL confirm). Covers Anope ("Password accepted"),
    // Atheme ("You are now identified for"), and generic patterns.
    const nowIdentified =
      /(?:you are now identified|password accepted|you are now recognized|you have been logged in)/i.test(
        message,
      );
    if (nowIdentified && this._botIdentifyState !== 'identified') {
      this._botIdentifyState = 'identified';
      this.logger?.info('Bot identity confirmed by NickServ notice');
      this.eventBus.emit('bot:identified');
      return;
    }

    // No pattern matched — log for debugging
    if (this.pending.size > 0) {
      this.logger?.debug(`NickServ notice did not match ACC or STATUS pattern: ${message}`);
    }
  }

  private resolveVerification(nick: string, verified: boolean, account: string | null): void {
    const lower = ircLower(nick, this.casemapping);
    const pending = this.pending.get(lower);
    if (!pending) return;

    this.pending.delete(lower);

    if (verified && account !== null) {
      // Update channel-state's account cache *before* the emit so any
      // `user:identified` listener that re-enters via `chanUser.accountName`
      // (e.g. chanmod's auto-op reconciler) sees the freshly-verified
      // account and can short-circuit Stage A instead of issuing another
      // ACC round-trip. Without this bridge the chain loops until the
      // IRC server echoes the granted prefix mode.
      this.channelState?.setAccountForNick(nick, account);
      this.eventBus.emit('user:identified', nick, account);
    }

    // Resolve with the real result *first* — then abort to cancel the
    // pending setTimeout. The abort listener calls resolve() again with a
    // failure result, but Promises are idempotent so the first resolve()
    // wins. This keeps `abort()` the single cancellation idiom without
    // losing the real verification result.
    pending.resolve({ verified, account });
    pending.controller.abort();
  }

  // -------------------------------------------------------------------------
  // Bot identify state — public API
  // -------------------------------------------------------------------------

  /**
   * True if the bot's own NickServ identity has been confirmed for the current
   * session (either via SASL account-notify or a "You are now identified"
   * notice). False while unknown or after a "please identify" prompt.
   * Surfaced via `.status` so operators can see the identify state at a glance.
   */
  isBotIdentified(): boolean {
    return this._botIdentifyState === 'identified';
  }

  /**
   * Four-value identify state: 'identified', 'pending', 'unidentified', or 'unknown'.
   * 'unknown' — no NickServ/SASL signal received yet this session.
   * 'pending' — IDENTIFY sent, waiting for NickServ confirmation.
   * 'identified' — confirmed by account-notify or "You are now identified" notice.
   * 'unidentified' — NickServ confirmed the bot is NOT identified (no fallback possible).
   */
  getBotIdentifyState(): BotIdentifyState {
    return this._botIdentifyState;
  }

  /**
   * Forcibly mark the bot as identified. Called by external callers (e.g.
   * after a successful IDENTIFY on a non-SASL network) when the normal
   * NickServ "You are now identified" notice path has not yet fired.
   */
  markBotIdentified(): void {
    if (this._botIdentifyState !== 'identified') {
      this._botIdentifyState = 'identified';
      this.eventBus.emit('bot:identified');
    }
  }

  /**
   * GHOST the squatted primary nick and reclaim it. Sends NickServ GHOST,
   * waits for the server to kill the squatter, then sends NICK to take the
   * nick back. The caller is responsible for updating channelState/bridge
   * botNick before calling this — irc-bridge tracks the nick change via
   * its own 'nick' listener once the server confirms. After the nick change,
   * the normal NickServ "please identify" → fallback IDENTIFY path fires
   * to re-establish identity.
   */
  async ghostAndReclaim(nick: string, password: string): Promise<void> {
    // Flush any in-flight resolver from a prior overlapping call. Without
    // this, a second ghostAndReclaim() within 1.5s leaves the old
    // setTimeout scheduled; when it fires it nulls out the *new* race's
    // resolver, so the second reclaim waits the full 1.5s instead of
    // unblocking on ack.
    if (this.pendingGhostResolver) {
      const prev = this.pendingGhostResolver;
      this.pendingGhostResolver = null;
      prev();
    }
    this._identifyFallbackSent = false; // reset so the re-identify path can fire
    const target = this.getNickServTarget();
    this.client.say(target, `GHOST ${nick} ${password}`);
    this.logger?.warn(`Sent GHOST for ${nick} — waiting for NickServ ack (1.5s cap)`);
    // Race the NickServ ack notice against the legacy 1.5s upper-bound
    // sleep — whichever fires first. Most services respond in < 100 ms, so
    // the earlier-ack path lets reclaim complete sooner; the sleep stays as
    // a safety net for services that never reply.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.pendingGhostResolver === finish) this.pendingGhostResolver = null;
        resolve();
      };
      this.pendingGhostResolver = finish;
      const timer = setTimeout(finish, 1500).unref();
    });
    this.client.changeNick(nick);
    this.logger?.info(`Sent NICK ${nick} to reclaim primary nick after GHOST`);
  }

  /**
   * Pending `ghostAndReclaim` resolver — set while the race is active,
   * cleared when either the ack arrives or the timeout fires. The notice
   * handler matches GHOST-success / already-offline phrases and calls this
   * to unblock the reclaim early.
   */
  private pendingGhostResolver: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Handle an IRCv3 account-notify for the bot's own nick.
   * Pre-registration: nick='*', account=<bot account name> (SASL success).
   * Post-registration: nick=<bot nick>, account=<account name>.
   * Fires `bot:identified` on the event bus when the bot's own identity is
   * confirmed.
   */
  private onAccountNotify(event: Record<string, unknown>): void {
    if (!this.botNick) return; // botNick not configured — skip
    const nick = String(event.nick ?? '');
    const account: string | null =
      event.account === false || event.account === null ? null : String(event.account);

    const lower = ircLower(nick, this.casemapping);
    const botLower = ircLower(this.botNick, this.casemapping);
    const isBotOwn = nick === '*' || lower === botLower;
    if (!isBotOwn) return;

    if (account !== null) {
      if (this._botIdentifyState !== 'identified') {
        this._botIdentifyState = 'identified';
        this.logger?.info(`Bot identified as ${account} via account-notify (SASL)`);
        this.eventBus.emit('bot:identified');
      }
    } else {
      const wasIdentified = this._botIdentifyState === 'identified';
      this._botIdentifyState = 'unidentified';
      this.logger?.debug('Bot deidentified via account-notify');
      if (wasIdentified) {
        this.eventBus.emit('bot:deidentified');
      }
    }
  }

  private getNickServTarget(): string {
    return this.servicesConfig.nickserv || 'NickServ';
  }
}
