// n0xb0t — Services core module
// NickServ integration — bot authentication and user identity verification.

import type { BotEventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { ServicesConfig, IdentityConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for services. */
export interface ServicesClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  say(target: string, message: string): void;
}

export interface VerifyResult {
  verified: boolean;
  account: string | null;
}

interface PendingVerify {
  nick: string;
  resolve: (result: VerifyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ServicesDeps {
  client: ServicesClient;
  servicesConfig: ServicesConfig;
  identityConfig: IdentityConfig;
  eventBus: BotEventBus;
  logger?: Logger | null;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export class Services {
  private client: ServicesClient;
  private servicesConfig: ServicesConfig;
  private identityConfig: IdentityConfig;
  private eventBus: BotEventBus;
  private logger: Logger | null;
  private pending: Map<string, PendingVerify> = new Map();
  private noticeListener: ((...args: unknown[]) => void) | null = null;

  constructor(deps: ServicesDeps) {
    this.client = deps.client;
    this.servicesConfig = deps.servicesConfig;
    this.identityConfig = deps.identityConfig;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger?.child('services') ?? null;
  }

  /** Start listening for NickServ responses. */
  attach(): void {
    this.noticeListener = (...args: unknown[]) => {
      const event = (args[0] ?? {}) as Record<string, unknown>;
      this.onNotice(event);
    };
    this.client.on('notice', this.noticeListener);
    this.logger?.info('Attached to IRC client');
  }

  /** Stop listening. */
  detach(): void {
    if (this.noticeListener) {
      this.client.removeListener('notice', this.noticeListener);
      this.noticeListener = null;
    }
    // Clean up pending verifications
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ verified: false, account: null });
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
    const lowerNick = nick.toLowerCase();

    // Cancel any existing pending verification for this nick
    const existing = this.pending.get(lowerNick);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve({ verified: false, account: null });
      this.pending.delete(lowerNick);
    }

    return new Promise<VerifyResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(lowerNick);
        this.logger?.warn(`Verification timeout for ${nick}`);
        resolve({ verified: false, account: null });
      }, timeoutMs);

      this.pending.set(lowerNick, { nick, resolve, timer });

      // Send the verification command
      if (this.servicesConfig.type === 'anope') {
        this.client.say(target, `STATUS ${nick}`);
      } else {
        // Atheme and default
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

  // -------------------------------------------------------------------------
  // NickServ response parsing
  // -------------------------------------------------------------------------

  private onNotice(event: Record<string, unknown>): void {
    const nick = String(event.nick ?? '');
    const message = String(event.message ?? '');

    // Only process notices from NickServ
    const nickServTarget = this.getNickServTarget();
    // NickServ might be 'NickServ' or 'nickserv@services.dal.net' — compare the nick part
    const fromNick = nickServTarget.includes('@')
      ? nickServTarget.split('@')[0]
      : nickServTarget;

    if (nick.toLowerCase() !== fromNick.toLowerCase()) return;

    // Try to parse ACC response (Atheme): "nick ACC level"
    const accMatch = message.match(/^(\S+)\s+ACC\s+(\d+)/i);
    if (accMatch) {
      const targetNick = accMatch[1];
      const level = parseInt(accMatch[2], 10);
      this.resolveVerification(targetNick, level >= 3, level >= 3 ? targetNick : null);
      return;
    }

    // Try to parse STATUS response (Anope): "STATUS nick level"
    const statusMatch = message.match(/^STATUS\s+(\S+)\s+(\d+)/i);
    if (statusMatch) {
      const targetNick = statusMatch[1];
      const level = parseInt(statusMatch[2], 10);
      this.resolveVerification(targetNick, level >= 3, level >= 3 ? targetNick : null);
      return;
    }
  }

  private resolveVerification(nick: string, verified: boolean, account: string | null): void {
    const lower = nick.toLowerCase();
    const pending = this.pending.get(lower);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(lower);

    if (verified) {
      this.eventBus.emit('user:identified', nick, account ?? nick);
    }

    pending.resolve({ verified, account });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getNickServTarget(): string {
    return this.servicesConfig.nickserv || 'NickServ';
  }
}
