// HexBot — Internal event bus
// Typed EventEmitter for bot-level events (separate from the IRC dispatcher).
import { EventEmitter } from 'node:events';

import type { ModLogEntry } from './database';

// ---------------------------------------------------------------------------
// Event definitions
// ---------------------------------------------------------------------------

/**
 * Payload emitted on the `audit:log` event. A snapshot of the row that was
 * just persisted to `mod_log` — `id` and `timestamp` are populated from the
 * insert, and `metadata` is already parsed from JSON. Subscribers must treat
 * this object as read-only.
 */
export type AuditLogEvent = ModLogEntry;

export interface BotEvents {
  /**
   * Fired by `BotDatabase` immediately after a successful `mod_log` insert.
   * Lets a future audit-stream plugin ship records off-box (syslog, SIEM,
   * webhook) without polling the table. Filtered consumers (e.g. the
   * Phase 6 `.audit-tail` REPL command) can subscribe directly.
   */
  'audit:log': [entry: AuditLogEvent];
  'bot:connected': [];
  'bot:disconnected': [reason: string];
  'bot:error': [error: Error];
  /**
   * Fired by `Services` when the bot's own NickServ identity is confirmed —
   * either via IRCv3 account-notify (SASL success) or via a NickServ
   * "You are now identified" notice (password IDENTIFY fallback). Consumers
   * (chanmod) use this to trigger a ChanServ re-probe after a SASL miss.
   */
  'bot:identified': [];
  /**
   * Fired by `Services` when the bot loses its NickServ identity — either
   * via IRCv3 account-notify showing the account was removed, or on
   * disconnect (identity state reset to unknown). The symmetric counterpart
   * to `bot:identified`.
   */
  'bot:deidentified': [];
  /**
   * Fired by `connection-lifecycle` when the bot registers with a nick other
   * than the one in config (IRC server appended `_` due to collision). Payload
   * is the actual registered nick. Subscribers (bot.ts) update channelState and
   * bridge, then initiate GHOST if `ghost_on_recover` is configured.
   */
  'bot:nick-collision': [actualNick: string];
  'plugin:loaded': [pluginId: string];
  'plugin:unloaded': [pluginId: string];
  // `plugin:reloaded` and `plugin:reload_failed` were removed alongside
  // `.reload` and the cache-busting import path. Plugin enable/disable
  // cycles fire `plugin:loaded` / `plugin:unloaded` only.
  'mod:op': [channel: string, nick: string, by: string];
  'mod:kick': [channel: string, nick: string, by: string, reason: string];
  'mod:ban': [channel: string, mask: string, by: string];
  /**
   * Emitted when the bot observes that a nick is identified to services.
   * Two paths can fire this: an explicit `verifyUser` ACC/STATUS round-trip
   * succeeding, and — passively — `channel-state.onAccount` noticing an
   * IRCv3 `account-notify` transition from unidentified to identified. The
   * `handle` field carries the services account name.
   */
  'user:identified': [nick: string, handle: string];
  /**
   * Symmetric counterpart to `user:identified`. Emitted from
   * `channel-state.onAccount` when a nick transitions from identified to
   * unidentified (services logout). Carries the previous account name so
   * reconcilers can look up handles by account pattern even though the
   * nick is no longer identified. No explicit verify path emits this —
   * `verifyUser` only fires the positive event.
   */
  'user:deidentified': [nick: string, previousAccount: string];
  'user:added': [handle: string];
  'user:removed': [handle: string];
  'user:flagsChanged': [handle: string, globalFlags: string, channelFlags: Record<string, string>];
  'user:hostmaskAdded': [handle: string, hostmask: string];
  'user:hostmaskRemoved': [handle: string, hostmask: string];
  'user:passwordChanged': [handle: string];
  'channel:userJoined': [channel: string, nick: string];
  'channel:userLeft': [channel: string, nick: string];
  'channel:modeChanged': [channel: string, nick: string, mode: string];
  'channel:modesReady': [channel: string];
  'channel:awayChanged': [channel: string, nick: string, away: boolean];
  'botlink:connected': [botname: string];
  'botlink:disconnected': [botname: string, reason: string];
  'botlink:syncComplete': [botname: string];
  'auth:ban': [ip: string, failures: number, banDurationMs: number];
  'auth:unban': [ip: string];
}

// ---------------------------------------------------------------------------
// Typed event bus
// ---------------------------------------------------------------------------

/**
 * Per-event listener-count thresholds at which we log a warning. Earlier
 * tripwires than the cap so a slow accumulation (e.g. a plugin re-enable
 * cycle that fails to detach) is visible long before Node's
 * MaxListenersExceededWarning fires. Each threshold logs once per event
 * to avoid log spam during a steady-state subscription burst at startup.
 */
const LISTENER_WARN_THRESHOLDS = [10, 15] as const;

export class BotEventBus extends EventEmitter {
  /**
   * Per-owner listener registry. Populated by {@link trackListener} so
   * {@link removeByOwner} can drain every subscription a plugin (or
   * subsystem) added without each owner having to bookkeep its own
   * list.
   */
  private readonly ownerListeners = new Map<
    string,
    Array<{ event: keyof BotEvents; fn: (...args: never[]) => void }>
  >();
  /** Per-event set of thresholds we've already warned about. */
  private readonly warnedThresholds = new Map<string, Set<number>>();

  constructor() {
    super();
    // Cap at 20 — high enough for the MVP plugin set plus core
    // subsystems (every plugin api factory subscriber is mapped through
    // a single shared wrapper, so the count is closer to "subsystems"
    // than "plugins × events"), low enough that a real leak from a
    // failed cleanup cycle hits the cap quickly. The 10/15 thresholds
    // below give earlier signal so operators see the trend before the
    // cap fires. Do NOT raise this without diagnosing the trip — the
    // cap exists to catch leaks, not to silence them.
    this.setMaxListeners(20);
  }

  /**
   * Emit a one-shot warning whenever the listener count for `event`
   * crosses one of {@link LISTENER_WARN_THRESHOLDS}. Stays silent on
   * subsequent crossings of the same threshold so a churny event doesn't
   * spam logs every time a listener is added and removed.
   */
  private checkListenerThresholds(event: string | symbol): void {
    const count = this.listenerCount(event);
    const key = String(event);
    let warned = this.warnedThresholds.get(key);
    for (const threshold of LISTENER_WARN_THRESHOLDS) {
      if (count >= threshold) {
        if (!warned) {
          warned = new Set();
          this.warnedThresholds.set(key, warned);
        }
        if (!warned.has(threshold)) {
          warned.add(threshold);
          console.warn(
            `[event-bus] listener count for "${key}" reached ${count} (threshold ${threshold}/20). Suspect leak if this keeps climbing.`,
          );
        }
      }
    }
  }

  override emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * @deprecated for plugin / subsystem use — prefer {@link trackListener}
   * which auto-cleans on `removeByOwner`. Direct `.on()` is still valid for
   * core callers that already manage their own `.off()` lifecycle (Services,
   * MemoManager, DCCManager, etc., which capture the listener ref into a
   * field and detach explicitly). For any code path whose lifetime is
   * shorter than the bus and that doesn't store the listener for explicit
   * `.off()`, this is the wrong API — it leaks listeners across reloads.
   */
  override on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    this.checkListenerThresholds(event);
    return this;
  }

  override once<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  /**
   * Register a listener that will be automatically removed when
   * {@link removeByOwner} is called with the same owner id. Prefer this
   * over bare `.on()` from any subsystem whose lifetime is shorter than
   * the bus itself — it closes the reload-residue loophole where a
   * forgotten teardown leaks every listener the owner ever registered.
   */
  trackListener<K extends keyof BotEvents>(
    owner: string,
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): void {
    this.on(event, listener);
    const list = this.ownerListeners.get(owner) ?? [];
    // Store as the widest signature so the heterogeneous list type-checks;
    // `off()`'s own overload accepts this via contravariance at the call
    // site in removeByOwner.
    list.push({ event, fn: listener as unknown as (...args: never[]) => void });
    this.ownerListeners.set(owner, list);
  }

  /**
   * Drain every listener registered under `owner` via {@link trackListener}.
   * Safe to call for an unknown owner (no-op) so teardown paths can call
   * it unconditionally.
   */
  removeByOwner(owner: string): void {
    const list = this.ownerListeners.get(owner);
    if (!list) return;
    for (const { event, fn } of list) {
      // Contravariant bridge: the listener was stored as `(...never[]) => void`
      // but off() wants `(...BotEvents[K]) => void`. The stored fn is the
      // same reference we passed to .on(), so the cast is safe.
      (this.off as (event: keyof BotEvents, fn: (...args: never[]) => void) => this)(event, fn);
    }
    this.ownerListeners.delete(owner);
  }
}
