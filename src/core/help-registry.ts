// HexBot — Help registry
// Stores HelpEntry records registered by plugins. Cleared automatically on plugin unload.
import type { LoggerLike } from '../logger';
import type { HelpEntry } from '../types';

/**
 * Strict storage/identity key — case-folded but prefix-preserving so
 * `.ban` (core dot-command) and `!ban` (channel bang-command) are
 * tracked as distinct entries that share a fuzzy alias for bare-name
 * lookups. Two registrations collide only when their strict keys match
 * (same prefix, same name, same case-fold).
 */
function strictKey(command: string): string {
  return command.toLowerCase();
}

/**
 * Fuzzy lookup key — strips the leading `!` or `.` and case-folds. Used
 * by `get()` as a fallback so `!help ban` resolves to whichever prefix
 * variant exists. Not used for storage or collision detection.
 */
function fuzzyKey(command: string): string {
  return command.replace(/^[!.]/, '').toLowerCase();
}

export class HelpRegistry {
  // Two-level map: pluginId → (strictKey → entry). The inner Map makes
  // `register()` an upsert-by-strict-key, so a plugin can register from
  // multiple files (or re-register on config change) without piling up
  // duplicates and without sibling files clobbering each other.
  private entries: Map<string, Map<string, HelpEntry>> = new Map();
  private readonly logger: LoggerLike | undefined;

  constructor(logger?: LoggerLike) {
    this.logger = logger;
  }

  /**
   * Register help entries for a plugin. Each entry is upserted by strict
   * key (case-folded, prefix-preserving) within the plugin's bucket —
   * calling `register()` again from a different file in the same plugin
   * appends; calling it again with the same command replaces in place.
   *
   * Cross-bucket collisions on the strict key (two plugins claiming the
   * same trigger including prefix) are non-fatal: the newcomer is logged
   * at warn level and stored under a namespaced key
   * (`<pluginId>:<command>`) so it remains discoverable via
   * `get('<pluginId>:foo')` rather than vanishing silently. Different
   * prefixes are NOT collisions — `.ban` and `!ban` coexist as distinct
   * entries because they target different command surfaces (admin
   * dot-command vs channel bang-command).
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
      const key = strictKey(entry.command);
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
   * Case-insensitive lookup by command name. Resolution order:
   *   1. Namespaced form `<pluginId>:command` — direct bucket lookup so
   *      the loser of a collision stays reachable.
   *   2. Strict (prefix-exact) match — `.ban` only matches `.ban`,
   *      `!ban` only matches `!ban`.
   *   3. Fuzzy fallback — bare or mismatched-prefix queries find any
   *      registered prefix variant. Lets `!help ban` resolve regardless
   *      of which prefix the entry was registered under.
   */
  get(command: string): HelpEntry | undefined {
    // Namespaced form (pluginId:command) — go straight to the owning bucket.
    const colonIdx = command.indexOf(':');
    if (colonIdx > 0) {
      const pluginId = command.slice(0, colonIdx);
      const rest = command.slice(colonIdx + 1);
      const bucket = this.entries.get(pluginId);
      if (bucket) {
        const direct = bucket.get(`${pluginId}:${strictKey(rest)}`);
        if (direct) return direct;
        const fallback = bucket.get(strictKey(rest));
        if (fallback) return fallback;
      }
    }

    // Strict (prefix-exact) match.
    const strict = strictKey(command);
    for (const bucket of this.entries.values()) {
      const entry = bucket.get(strict);
      if (entry) return entry;
    }

    // Fuzzy fallback — match on prefix-stripped name. Iterates across all
    // buckets and entries; first match wins (insertion order = registration
    // order, so core wins over plugins for legacy compatibility).
    const fuzzy = fuzzyKey(command);
    for (const bucket of this.entries.values()) {
      for (const [storedKey, entry] of bucket) {
        if (fuzzyKey(storedKey) === fuzzy) return entry;
      }
    }
    return undefined;
  }
}
