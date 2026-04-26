// HexBot — Help registry
// Stores HelpEntry records registered by plugins. Cleared automatically on plugin unload.
import type { LoggerLike } from '../logger';
import type { HelpEntry } from '../types';

/**
 * Normalize a command name for case-insensitive, prefix-agnostic lookup.
 * Strips both `!` (plugin commands) and `.` (core dot-commands) so the
 * shared corpus can be queried by either trigger style.
 */
function normalizeCommand(command: string): string {
  return command.replace(/^[!.]/, '').toLowerCase();
}

export class HelpRegistry {
  // Two-level map: pluginId → (normalized command → entry). The inner Map
  // makes `register()` an upsert-by-command, so a plugin can register from
  // multiple files (or re-register on config change) without piling up
  // duplicates and without sibling files clobbering each other.
  private entries: Map<string, Map<string, HelpEntry>> = new Map();
  private readonly logger: LoggerLike | undefined;

  constructor(logger?: LoggerLike) {
    this.logger = logger;
  }

  /**
   * Register help entries for a plugin. Each entry is upserted by command
   * name within the plugin's bucket — calling `register()` again from a
   * different file in the same plugin appends; calling it again with the
   * same command replaces in place.
   *
   * Cross-bucket collisions (two plugins claiming the same trigger) are
   * non-fatal: the newcomer is logged at warn level and stored under a
   * namespaced key (`<pluginId>:<command>`) so it remains discoverable
   * via `get('<pluginId>:foo')` rather than vanishing silently.
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
      const key = normalizeCommand(entry.command);
      const owner = this.findExistingOwner(key, pluginId);
      if (owner) {
        const namespaced = `${pluginId}:${entry.command}`;
        this.logger?.warn(
          `[help-registry] "${entry.command}" already owned by "${owner}"; ` +
            `"${pluginId}" entry kept under namespaced command "${namespaced}"`,
        );
        bucket.set(`${pluginId}:${key}`, { ...entry, pluginId, command: namespaced });
        continue;
      }
      bucket.set(key, { ...entry, pluginId });
    }
  }

  /**
   * Locate the plugin id that already owns `key` in some other bucket, if
   * any. Skips the caller's own bucket so re-registration in the same
   * plugin (the common upsert path) doesn't trip the collision warning.
   */
  private findExistingOwner(key: string, ownPluginId: string): string | undefined {
    for (const [pluginId, bucket] of this.entries) {
      if (pluginId === ownPluginId) continue;
      if (bucket.has(key)) return pluginId;
    }
    return undefined;
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

  /**
   * Case-insensitive lookup by command name. Leading `!` and `.` are
   * optional. Also resolves the namespaced fallback (`pluginId:command`)
   * so the loser of a collision stays reachable.
   */
  get(command: string): HelpEntry | undefined {
    // Namespaced form (pluginId:command) — go straight to the owning bucket.
    const colonIdx = command.indexOf(':');
    if (colonIdx > 0) {
      const pluginId = command.slice(0, colonIdx);
      const rest = command.slice(colonIdx + 1);
      const bucket = this.entries.get(pluginId);
      if (bucket) {
        const direct = bucket.get(`${pluginId}:${normalizeCommand(rest)}`);
        if (direct) return direct;
        const fallback = bucket.get(normalizeCommand(rest));
        if (fallback) return fallback;
      }
    }

    const key = normalizeCommand(command);
    for (const bucket of this.entries.values()) {
      const entry = bucket.get(key);
      if (entry) return entry;
    }
    return undefined;
  }
}
