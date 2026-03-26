// hexbot — Help registry
// Stores HelpEntry records registered by plugins. Cleared automatically on plugin unload.
import type { HelpEntry } from '../types';

export class HelpRegistry {
  private entries: Map<string, HelpEntry[]> = new Map();

  /** Register (or replace) all help entries for a plugin. */
  register(pluginId: string, entries: HelpEntry[]): void {
    this.entries.set(pluginId, [...entries]);
  }

  /** Remove all help entries for a plugin. */
  unregister(pluginId: string): void {
    this.entries.delete(pluginId);
  }

  /** Return all entries across all plugins. */
  getAll(): HelpEntry[] {
    const result: HelpEntry[] = [];
    for (const entries of this.entries.values()) {
      result.push(...entries);
    }
    return result;
  }

  /** Case-insensitive lookup by command name (leading ! is optional). */
  get(command: string): HelpEntry | undefined {
    const normalized = command.replace(/^!/, '').toLowerCase();
    for (const entries of this.entries.values()) {
      for (const entry of entries) {
        if (entry.command.replace(/^!/, '').toLowerCase() === normalized) {
          return entry;
        }
      }
    }
    return undefined;
  }
}
