// HexBot — Per-channel settings registry
// Plugins register typed setting definitions; values are stored in the DB under 'chanset' namespace.
//
// Channel-key normalisation: every read/write goes through an injected
// `ircLower` normaliser so `#Foo` and `#foo` land on the same record,
// honouring the network's CASEMAPPING. For backwards compatibility with
// pre-normalisation databases, `get()` falls back to the raw channel name
// on a miss so operators don't silently lose existing settings.
import type { BotDatabase } from '../database';
import type { LoggerLike } from '../logger';
import type {
  ChannelSettingChangeCallback,
  ChannelSettingDef,
  ChannelSettingEntry,
  ChannelSettingValue,
} from '../types';
import type { ModActor } from './audit';
import { tryLogModAction } from './audit';

export type { ChannelSettingChangeCallback };

const NAMESPACE = 'chanset';

/**
 * Signature for the IRC-aware case folder. Bot wires this via
 * `(s) => ircLower(s, currentCasemapping)` so settings written before
 * `CAP LS`/`005` arrive still hash compatibly with later writes.
 */
export type ChannelLower = (channel: string) => string;

const DEFAULT_LOWER: ChannelLower = (s) => s.toLowerCase();

export class ChannelSettings {
  private defs: Map<string, ChannelSettingEntry> = new Map();
  private changeListeners: Map<string, ChannelSettingChangeCallback[]> = new Map();
  private readonly ircLower: ChannelLower;
  private readonly logger: LoggerLike | undefined;
  private readonly db: BotDatabase;

  constructor(db: BotDatabase, logger?: LoggerLike, ircLower?: ChannelLower) {
    this.db = db;
    this.logger = logger;
    this.ircLower = ircLower ?? DEFAULT_LOWER;
  }

  /**
   * Register per-channel setting definitions for a plugin.
   * Key collisions from a different pluginId are logged and skipped.
   * Re-registering the same key from the same pluginId silently replaces it.
   */
  register(pluginId: string, defs: ChannelSettingDef[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.key);
      if (existing && existing.pluginId !== pluginId) {
        (this.logger ?? console).warn(
          `[channel-settings] Key collision: "${def.key}" already registered by "${existing.pluginId}" — skipping "${pluginId}"`,
        );
        continue;
      }
      this.defs.set(def.key, { ...def, pluginId });
    }
  }

  /**
   * Remove all definitions registered by a plugin.
   * Stored DB values are intentionally preserved — operator data survives plugin unloads.
   */
  unregister(pluginId: string): void {
    for (const [key, entry] of this.defs) {
      if (entry.pluginId === pluginId) {
        this.defs.delete(key);
      }
    }
  }

  /**
   * Read a per-channel setting value. Returns def.default if no stored value exists.
   * Returns '' if the key is unknown (graceful degradation — plugin may be unloaded).
   *
   * Reads first try the case-folded key; on a miss they fall back to the
   * raw-cased key so pre-normalisation databases still surface their values.
   * Any future `set()` will rewrite under the folded key.
   */
  get(channel: string, key: string): ChannelSettingValue {
    const def = this.defs.get(key);
    if (!def) return '';

    const folded = this.makeKey(channel, key);
    let stored = this.db.get(NAMESPACE, folded);
    if (stored === null && folded !== `${channel}:${key}`) {
      stored = this.db.get(NAMESPACE, `${channel}:${key}`);
    }
    if (stored === null) return def.default;

    return this.coerce(def, stored);
  }

  /** Read a flag (boolean) setting. Returns false for unknown keys. */
  getFlag(channel: string, key: string): boolean {
    const val = this.get(channel, key);
    return typeof val === 'boolean' ? val : false;
  }

  /** Read a string setting. Returns '' for unknown keys. */
  getString(channel: string, key: string): string {
    const val = this.get(channel, key);
    return typeof val === 'string' ? val : '';
  }

  /** Read an int setting. Returns 0 for unknown keys. */
  getInt(channel: string, key: string): number {
    const val = this.get(channel, key);
    return typeof val === 'number' ? val : 0;
  }

  /**
   * Store a per-channel setting value. No-ops with a warning if the key is unknown.
   *
   * `actor` is optional but strongly encouraged — when provided, the mutation
   * is recorded to `mod_log` as a `chanset` action. Leaving it unset is the
   * "unattributed plugin internals" path (migrations, boot-time seeding).
   * Plugins should always pass `api.auditActor(ctx)` when a user triggers
   * the change, otherwise the mutation becomes invisible to audit review.
   */
  set(channel: string, key: string, value: ChannelSettingValue, actor?: ModActor): void {
    if (!this.defs.has(key)) {
      console.warn(`[channel-settings] Unknown key "${key}" — cannot set`);
      return;
    }
    this.db.set(NAMESPACE, this.makeKey(channel, key), String(value));
    this.notifyChange(channel, key, value);
    if (actor) {
      const entry = this.defs.get(key);
      // The `plugin` field is required on plugin-source rows and forbidden
      // on every other source. Delegate plugin-id resolution to the actor
      // if it already carries one (plugin-sourced audits do), otherwise
      // attach the def's owning plugin when the actor's source demands it.
      const pluginId = actor.plugin ?? (actor.source === 'plugin' ? entry?.pluginId : undefined);
      tryLogModAction(
        this.db,
        {
          action: 'chanset',
          channel,
          target: key,
          reason: String(value),
          source: actor.source,
          by: actor.by,
          ...(pluginId ? { plugin: pluginId } : {}),
        },
        this.logger ?? null,
      );
    }
  }

  /**
   * Delete a stored per-channel value. Next get() will return def.default.
   *
   * Also deletes any legacy raw-cased entry so a follow-up read doesn't
   * silently resurrect the old value from the pre-normalisation path.
   */
  unset(channel: string, key: string): void {
    const folded = this.makeKey(channel, key);
    this.db.del(NAMESPACE, folded);
    const raw = `${channel}:${key}`;
    if (raw !== folded) this.db.del(NAMESPACE, raw);
    // Notify with the new effective value (the default)
    const def = this.defs.get(key);
    if (def) this.notifyChange(channel, key, def.default);
  }

  /**
   * Register a callback that fires when any per-channel setting is set or unset.
   * Keyed by pluginId for automatic cleanup on plugin unload.
   *
   * Dedup is by reference: if a plugin's `init()` is re-invoked with the
   * same closure (e.g. a reload retry loop that keeps the same module
   * instance), we skip the duplicate instead of stacking N copies that
   * would all fire on every change.
   */
  onChange(pluginId: string, callback: ChannelSettingChangeCallback): void {
    const list = this.changeListeners.get(pluginId) ?? [];
    if (list.includes(callback)) return;
    list.push(callback);
    this.changeListeners.set(pluginId, list);
  }

  /**
   * Remove all change listeners for a plugin.
   */
  offChange(pluginId: string): void {
    this.changeListeners.delete(pluginId);
  }

  /**
   * Returns true if an operator has explicitly stored a value for this key/channel.
   */
  isSet(channel: string, key: string): boolean {
    if (this.db.get(NAMESPACE, this.makeKey(channel, key)) !== null) return true;
    // Legacy raw-cased record check — same fallback as get().
    return this.db.get(NAMESPACE, `${channel}:${key}`) !== null;
  }

  getDef(key: string): ChannelSettingEntry | undefined {
    return this.defs.get(key);
  }

  /** All registered defs across all plugins, in registration order. */
  getAllDefs(): ChannelSettingEntry[] {
    return Array.from(this.defs.values());
  }

  /** Returns all registered defs with their current values for the given channel. */
  getChannelSnapshot(
    channel: string,
  ): Array<{ entry: ChannelSettingEntry; value: ChannelSettingValue; isDefault: boolean }> {
    return Array.from(this.defs.values()).map((entry) => {
      // Prefer the folded record, fall back to the raw-cased legacy key.
      const folded = this.makeKey(channel, entry.key);
      let stored = this.db.get(NAMESPACE, folded);
      if (stored === null && folded !== `${channel}:${entry.key}`) {
        stored = this.db.get(NAMESPACE, `${channel}:${entry.key}`);
      }
      const isDefault = stored === null;
      const value = stored === null ? entry.default : this.coerce(entry, stored);
      return { entry, value, isDefault };
    });
  }

  /**
   * Build the composite DB key for a (channel, setting) pair. Channel is
   * folded through the injected casemapping so that `#Foo` and `#foo`
   * always resolve to the same record; the setting key is already a
   * plugin-owned identifier so it's not folded.
   */
  private makeKey(channel: string, key: string): string {
    return `${this.ircLower(channel)}:${key}`;
  }

  private notifyChange(channel: string, key: string, value: ChannelSettingValue): void {
    for (const callbacks of this.changeListeners.values()) {
      for (const cb of callbacks) {
        try {
          cb(channel, key, value);
        } catch (err) {
          console.error(`[channel-settings] onChange callback error for key "${key}":`, err);
        }
      }
    }
  }

  private coerce(def: ChannelSettingEntry, stored: string): ChannelSettingValue {
    switch (def.type) {
      case 'flag':
        return stored === 'true';
      case 'int':
        return parseInt(stored, 10);
      case 'string':
        return stored;
    }
  }
}
