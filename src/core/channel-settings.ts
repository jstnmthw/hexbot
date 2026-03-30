// HexBot — Per-channel settings registry
// Plugins register typed setting definitions; values are stored in the DB under 'chanset' namespace.
import type { BotDatabase } from '../database';
import type { ChannelSettingDef, ChannelSettingEntry, ChannelSettingValue } from '../types';

const NAMESPACE = 'chanset';

/** Callback signature for channel setting change notifications. */
export type ChannelSettingChangeCallback = (
  channel: string,
  key: string,
  value: ChannelSettingValue,
) => void;

export class ChannelSettings {
  private defs: Map<string, ChannelSettingEntry> = new Map();
  private changeListeners: Map<string, ChannelSettingChangeCallback[]> = new Map();

  constructor(private readonly db: BotDatabase) {}

  /**
   * Register per-channel setting definitions for a plugin.
   * Key collisions from a different pluginId are logged and skipped.
   * Re-registering the same key from the same pluginId silently replaces it.
   */
  register(pluginId: string, defs: ChannelSettingDef[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.key);
      if (existing && existing.pluginId !== pluginId) {
        console.warn(
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
   */
  get(channel: string, key: string): ChannelSettingValue {
    const def = this.defs.get(key);
    if (!def) return '';

    const stored = this.db.get(NAMESPACE, `${channel}:${key}`);
    if (stored === null) return def.default;

    return this.coerce(def, stored);
  }

  /**
   * Store a per-channel setting value. No-ops with a warning if the key is unknown.
   */
  set(channel: string, key: string, value: ChannelSettingValue): void {
    if (!this.defs.has(key)) {
      console.warn(`[channel-settings] Unknown key "${key}" — cannot set`);
      return;
    }
    this.db.set(NAMESPACE, `${channel}:${key}`, String(value));
    this.notifyChange(channel, key, value);
  }

  /**
   * Delete a stored per-channel value. Next get() will return def.default.
   */
  unset(channel: string, key: string): void {
    this.db.del(NAMESPACE, `${channel}:${key}`);
    // Notify with the new effective value (the default)
    const def = this.defs.get(key);
    this.notifyChange(channel, key, def!.default);
  }

  /**
   * Register a callback that fires when any per-channel setting is set or unset.
   * Keyed by pluginId for automatic cleanup on plugin unload.
   */
  onChange(pluginId: string, callback: ChannelSettingChangeCallback): void {
    const list = this.changeListeners.get(pluginId) ?? [];
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
      const stored = this.db.get(NAMESPACE, `${channel}:${entry.key}`);
      const isDefault = stored === null;
      const value = isDefault ? entry.default : this.coerce(entry, stored);
      return { entry, value, isDefault };
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private notifyChange(channel: string, key: string, value: ChannelSettingValue): void {
    for (const callbacks of this.changeListeners.values()) {
      for (const cb of callbacks) {
        try {
          cb(channel, key, value);
        } catch (err) {
          /* v8 ignore next -- defensive: callback errors should not crash the settings system */
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
