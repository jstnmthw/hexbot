// HexBot — Help registry
// Stores HelpEntry records registered by plugins. Cleared automatically on plugin unload.
import type { HelpEntry } from '../types';

/** Normalize a command name for case-insensitive, prefix-agnostic lookup. */
function normalizeCommand(command: string): string {
  return command.replace(/^!/, '').toLowerCase();
}

export class HelpRegistry {
  // Two-level map: pluginId → (normalized command → entry). The inner Map
  // makes `register()` an upsert-by-command, so a plugin can register from
  // multiple files (or re-register on config change) without piling up
  // duplicates and without sibling files clobbering each other.
  private entries: Map<string, Map<string, HelpEntry>> = new Map();

  /**
   * Register help entries for a plugin. Each entry is upserted by command
   * name within the plugin's bucket — calling `register()` again from a
   * different file in the same plugin appends; calling it again with the
   * same command replaces in place.
   *
   * Renaming a command (e.g. `!foo` → `!bar`) without unloading leaves the
   * old entry behind until the plugin is unloaded. Acceptable because
   * renames require a code change, which triggers hot-reload anyway.
   */
  register(pluginId: string, entries: HelpEntry[]): void {
    let bucket = this.entries.get(pluginId);
    if (!bucket) {
      bucket = new Map();
      this.entries.set(pluginId, bucket);
    }
    for (const entry of entries) {
      bucket.set(normalizeCommand(entry.command), { ...entry, pluginId });
    }
  }

  /** Remove all help entries for a plugin. */
  unregister(pluginId: string): void {
    this.entries.delete(pluginId);
  }

  /** Return all entries across all plugins. */
  getAll(): HelpEntry[] {
    const result: HelpEntry[] = [];
    for (const bucket of this.entries.values()) {
      for (const entry of bucket.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Case-insensitive lookup by command name (leading ! is optional). */
  get(command: string): HelpEntry | undefined {
    const key = normalizeCommand(command);
    for (const bucket of this.entries.values()) {
      const entry = bucket.get(key);
      if (entry) return entry;
    }
    return undefined;
  }
}
