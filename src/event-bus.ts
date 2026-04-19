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
  'plugin:loaded': [pluginId: string];
  'plugin:unloaded': [pluginId: string];
  'plugin:reloaded': [pluginId: string];
  /**
   * Fired when `reload()` successfully tore down the old plugin but
   * failed to load the new one. Operators must intervene — the plugin
   * is now in the unloaded state. Payload is the plugin name and the
   * load error string. See stability audit 2026-04-14.
   */
  'plugin:reload_failed': [pluginId: string, error: string];
  'mod:op': [channel: string, nick: string, by: string];
  'mod:kick': [channel: string, nick: string, by: string, reason: string];
  'mod:ban': [channel: string, mask: string, by: string];
  /**
   * Emitted when the bot observes that a nick is identified to services.
   * Two paths can fire this: an explicit `verifyUser` ACC/STATUS round-trip
   * succeeding, and — passively — `channel-state.onAccount` noticing an
   * IRCv3 `account-notify` transition from unidentified to identified. The
   * `handle` field carries the services account name. See
   * docs/services-identify-before-join.md.
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

export class BotEventBus extends EventEmitter {
  /**
   * Per-owner listener registry. Populated by {@link trackListener} so
   * {@link removeByOwner} can drain every subscription a plugin (or
   * subsystem) added without each owner having to bookkeep its own
   * list. See audit finding W-BO1 (2026-04-14).
   */
  private readonly ownerListeners = new Map<
    string,
    Array<{ event: keyof BotEvents; fn: (...args: never[]) => void }>
  >();

  constructor() {
    super();
    // Four-plus plugins routinely subscribe to the same event (e.g.
    // `user:added`, `user:flagsChanged`), which trips Node's default
    // 10-listener warning even when every subscription is legitimate and
    // tracked. Raise to 50 explicitly — high enough for the MVP plugin
    // set plus core subsystems, low enough to still catch a real leak.
    // Do NOT set this to Infinity; that would silence genuine leaks.
    this.setMaxListeners(50);
  }

  override emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
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
