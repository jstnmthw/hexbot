// HexBot — Services core module
// NickServ integration — bot authentication and user identity verification.
import type { BotDatabase } from '../database';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { ServicesConfig, VerifyResult } from '../types';
import { toEventObject } from '../utils/irc-event';
import { ListenerGroup } from '../utils/listener-group';
import { type Casemapping, ircLower } from '../utils/wildcard';
import { tryLogModAction } from './audit';

export type { VerifyResult };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for services. */
export interface ServicesClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  say(target: string, message: string): void;
}

interface PendingVerify {
  nick: string;
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
  private pending: Map<string, PendingVerify> = new Map();
  private listeners: ListenerGroup;
  private casemapping: Casemapping = 'rfc1459';

  constructor(deps: ServicesDeps) {
    this.client = deps.client;
    this.servicesConfig = deps.servicesConfig;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger?.child('services') ?? null;
    this.db = deps.db ?? null;
    this.listeners = new ListenerGroup(deps.client);
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Start listening for NickServ responses. */
  attach(): void {
    this.listeners.on('notice', (...args: unknown[]) => {
      this.onNotice(toEventObject(args[0]));
    });
    this.logger?.info('Attached to IRC client');
  }

  /** Stop listening. */
  detach(): void {
    this.listeners.removeAll();
    // Clean up pending verifications — abort() fires the signal handler
    // which clears the setTimeout and resolves the awaiting promise.
    for (const p of this.pending.values()) {
      p.controller.abort();
    }
    this.pending.clear();
    this.logger?.info('Detached from IRC client');
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
    this.logger?.info('Sent IDENTIFY to NickServ');
  }

  /**
   * Verify a user's identity via NickServ ACC/STATUS.
   * Returns a promise that resolves with the verification result.
   * @param nick - The nick to verify
   * @param timeoutMs - Timeout in milliseconds (default 5000)
   */
  async verifyUser(nick: string, timeoutMs: number = 5000): Promise<VerifyResult> {
    // Services type 'none' — always verified
    if (this.servicesConfig.type === 'none') {
      return { verified: true, account: nick };
    }

    const target = this.getNickServTarget();
    const lowerNick = ircLower(nick, this.casemapping);

    // Cancel any existing pending verification for this nick — the old
    // promise will resolve to `{verified:false, account:null}` via the
    // abort handler below.
    const existing = this.pending.get(lowerNick);
    if (existing) {
      this.pending.delete(lowerNick);
      existing.controller.abort();
    }

    const controller = new AbortController();
    return new Promise<VerifyResult>((resolve) => {
      const timer = setTimeout(() => {
        // Natural timeout path — audit and resolve as a timeout-failure.
        if (this.pending.get(lowerNick)?.controller === controller) {
          this.pending.delete(lowerNick);
        }
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
            metadata: { timeoutMs },
          },
          this.logger,
        );
        resolve({ verified: false, account: null });
      }, timeoutMs);

      // `abort()` is the single cancellation idiom for every teardown path
      // (detach, re-issue for the same nick, resolveVerification success).
      // Clearing the timer here ensures a cancelled verify never fires the
      // timeout-audit above.
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve({ verified: false, account: null });
        },
        { once: true },
      );

      // Send the verification command
      const method = this.servicesConfig.type === 'anope' ? 'status' : 'acc';
      this.pending.set(lowerNick, { nick, resolve, controller, method });

      if (method === 'status') {
        this.client.say(target, `STATUS ${nick}`);
      } else {
        this.client.say(target, `ACC ${nick}`);
      }
    });
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

    this.logger?.debug(`NickServ notice: ${message}`);

    const acc = this.tryParseAccResponse(message);
    if (acc) {
      this.logger?.debug(`ACC response: nick=${acc.nick} level=${acc.level}`);
      this.resolveVerification(acc.nick, acc.level >= 3, acc.level >= 3 ? acc.nick : null);
      return;
    }

    const status = this.tryParseStatusResponse(message);
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

    // No pattern matched — log for debugging
    if (this.pending.size > 0) {
      this.logger?.debug(`NickServ notice did not match ACC or STATUS pattern: ${message}`);
    }
  }

  /** Parse an Atheme ACC response: "nick ACC level" → {nick, level} or null. */
  private tryParseAccResponse(message: string): { nick: string; level: number } | null {
    const m = message.match(/^(\S+)\s+ACC\s+(\d+)/i);
    if (!m) return null;
    return { nick: m[1], level: parseInt(m[2], 10) };
  }

  /** Parse an Anope STATUS response: "STATUS nick level" → {nick, level} or null. */
  private tryParseStatusResponse(message: string): { nick: string; level: number } | null {
    const m = message.match(/^STATUS\s+(\S+)\s+(\d+)/i);
    if (!m) return null;
    return { nick: m[1], level: parseInt(m[2], 10) };
  }

  private resolveVerification(nick: string, verified: boolean, account: string | null): void {
    const lower = ircLower(nick, this.casemapping);
    const pending = this.pending.get(lower);
    if (!pending) return;

    this.pending.delete(lower);

    if (verified && account !== null) {
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
  // Helpers
  // -------------------------------------------------------------------------

  private getNickServTarget(): string {
    return this.servicesConfig.nickserv || 'NickServ';
  }
}
