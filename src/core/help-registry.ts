// HexBot — Help registry
// Stores HelpEntry records registered by plugins. Cleared automatically on plugin unload.
import type { LoggerLike } from '../logger';
import type { HelpEntry } from '../types';
import { stripFormatting } from '../utils/strip-formatting';

/**
 * Cap each plugin-supplied display string. Help text is fundamentally
 * untrusted (a plugin author is "the user" from the bot's perspective),
 * and any single help cell that exceeds this length will line-wrap
 * unpredictably in DCC consoles and IRC clients alike.
 */
const HELP_FIELD_MAX = 256;

/**
 * Strip IRC formatting bytes (\x02 \x03 \x0f \x1f etc.) and truncate.
 * Plugins must not be able to inject color codes that repaint other
 * plugins' help output when `!help` lists them all in one block. Run on
 * every plugin-supplied display field at register time so the cleaned
 * value lives in storage rather than being re-cleaned on every lookup.
 */
function cleanHelpField(value: string): string {
  const stripped = stripFormatting(value);
  return stripped.length > HELP_FIELD_MAX ? `${stripped.slice(0, HELP_FIELD_MAX - 1)}…` : stripped;
}

function cleanHelpEntry(entry: HelpEntry): HelpEntry {
  return {
    ...entry,
    usage: cleanHelpField(entry.usage),
    description: cleanHelpField(entry.description),
    detail: entry.detail?.map(cleanHelpField),
    category: entry.category !== undefined ? cleanHelpField(entry.category) : entry.category,
  };
}

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
    for (const rawEntry of entries) {
      const entry = cleanHelpEntry(rawEntry);
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

  /**
   * Remove all help entries for a plugin. Called from the plugin loader on
   * unload — namespaced collision losers (`<pluginId>:<command>` entries
   * stored under another plugin's bucket) survive because they live in
   * the *other* plugin's bucket; that's intentional, since the original
   * owner's help should remain usable when an interloper is unloaded.
   */
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

    // Fuzzy fallback — match on prefix-stripped name. Walk core buckets
    // first so a future refactor that loads plugins before core commands
    // doesn't let plugin entries shadow `.help <name>`. Identifier `core`
    // is the conventional core-registration owner (see
    // `command-handler.ts:registerCommand`).
    const fuzzy = fuzzyKey(command);
    const coreBucket = this.entries.get('core');
    if (coreBucket) {
      for (const [storedKey, entry] of coreBucket) {
        if (fuzzyKey(storedKey) === fuzzy) return entry;
      }
    }
    for (const [pluginId, bucket] of this.entries) {
      if (pluginId === 'core') continue;
      for (const [storedKey, entry] of bucket) {
        if (fuzzyKey(storedKey) === fuzzy) return entry;
      }
    }
    return undefined;
  }
}
