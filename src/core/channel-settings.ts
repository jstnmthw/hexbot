// HexBot — Per-channel settings registry
// Plugins register typed setting definitions; values are stored in the DB under 'chanset' namespace.
import type { BotDatabase } from '../database';
import type { ChannelSettingDef, ChannelSettingEntry, ChannelSettingValue } from '../types';

const NAMESPACE = 'chanset';

export class ChannelSettings {
  private defs: Map<string, ChannelSettingEntry> = new Map();

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
  }

  /**
   * Delete a stored per-channel value. Next get() will return def.default.
   */
  unset(channel: string, key: string): void {
    this.db.del(NAMESPACE, `${channel}:${key}`);
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
