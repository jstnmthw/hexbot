// HexBot — Seed-from-JSON walker
//
// On first boot, the SQLite KV is empty: every registered setting reads
// its registered default. JSON config files (`bot.json` /
// `plugins.json`) provide the operator's intended initial values, but
// after first boot KV is canonical (matches the `password_env`
// precedent — see DESIGN.md and docs/plans/live-config-updates.md §1).
//
// `seedFromJson` walks every key registered against a `SettingsRegistry`,
// looks the key up in the JSON tree by dotted path, and:
//   - writes the JSON value if KV is unset for that key  (`seeded`)
//   - writes the JSON value if KV differs from JSON       (`updated`)
//   - leaves KV alone otherwise                            (`unchanged`)
//
// JSON deletions are intentionally NOT propagated — once an operator
// removes a key from JSON, the KV value persists. This mirrors
// `password_env`: the file is a seed, not authoritative. Operators
// revert via `.unset <scope> <key>`.
//
// Returns per-reload-class counts so `.rehash`'s reply can render
// "12 applied live, 2 reloaded, 1 awaiting .restart".
import type { ChannelSettingValue } from '../types';
import type { ModActor } from './audit';
import type { SettingEntry, SettingsRegistry } from './settings-registry';

export interface SeedCounts {
  /** First-time write (KV had no value). */
  seeded: number;
  /** KV value changed to match a different JSON value. */
  updated: number;
  /** KV already matched JSON; no write. */
  unchanged: number;
  /** JSON missing this key, or value couldn't coerce — KV untouched. */
  skipped: number;
  /** Of the seeded+updated set, how many had reloadClass=reload. */
  reloaded: number;
  /** Of the seeded+updated set, how many had reloadClass=restart. */
  restartRequired: number;
}

const ZERO_COUNTS: SeedCounts = {
  seeded: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  reloaded: 0,
  restartRequired: 0,
};

export interface SeedOptions {
  /** Audit attribution. Omit for boot-time seeds (unattributed). */
  actor?: ModActor;
  /** Registry instance argument — `''` for core/plugin singletons; channel name for channel scope. */
  instance?: string;
  /**
   * Boot-time semantics: only write when KV is unset for that key.
   * `.rehash`-time semantics (the default) write when KV is unset OR
   * the stored value differs from JSON.
   *
   * The split honours docs/plans/live-config-updates.md §1: KV is
   * canonical after first boot, so a routine restart never overwrites
   * an operator-set value with a stale JSON value. Operators pull JSON
   * edits in deliberately via `.rehash`.
   */
  seedOnly?: boolean;
  /**
   * Optional override for the JSON-side path lookup. Defaults to a
   * dotted-path walk of `def.key` (e.g. `"irc.host"` → `json.irc.host`).
   * Plugins whose keys aren't dotted dotted (most of them) work either way.
   */
  pickPath?: (json: Record<string, unknown>, key: string) => unknown;
}

/**
 * Walk `json` by dotted path and return the leaf value, or `undefined`
 * when any segment is missing. Treats arrays as opaque leaves — no
 * indexing into them — because the registered settings model has no
 * array-typed setting (yet).
 */
export function pickByDottedPath(json: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let cursor: unknown = json;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/**
 * Coerce a JSON-side value to the runtime {@link ChannelSettingValue}
 * the def declares. Returns `null` when the value is structurally
 * incompatible (e.g. an array against a `string` def, or a non-coercible
 * shape) — callers count this as `skipped` so a future operator-driven
 * `.set` is the only path that reaches the typed write.
 */
export function coerceFromJson(def: SettingEntry, jsonValue: unknown): ChannelSettingValue | null {
  if (jsonValue === null) return null;
  switch (def.type) {
    case 'flag':
      if (typeof jsonValue === 'boolean') return jsonValue;
      if (typeof jsonValue === 'string') {
        const lower = jsonValue.toLowerCase();
        if (lower === 'true' || lower === 'on' || lower === 'yes') return true;
        if (lower === 'false' || lower === 'off' || lower === 'no') return false;
      }
      return null;
    case 'int':
      if (typeof jsonValue === 'number' && Number.isInteger(jsonValue)) return jsonValue;
      return null;
    case 'string':
      // Stringify scalars (number/boolean) so simple JSON expressions
      // like `"port": 6697` populate a string-typed key. Arrays/objects
      // are too structured to flatten safely; skip them.
      if (typeof jsonValue === 'string') return jsonValue;
      if (typeof jsonValue === 'number' || typeof jsonValue === 'boolean') {
        return String(jsonValue);
      }
      return null;
  }
}

/**
 * Seed (or `.rehash`-update) every registered key in `registry` from
 * `json`. KV-canonical-after-first-boot semantics: only writes when KV
 * is unset OR KV value differs from JSON. JSON deletions are NOT
 * propagated. Returns per-reload-class counts so the caller can render
 * an operator-facing summary.
 */
export function seedFromJson(
  registry: SettingsRegistry,
  json: Record<string, unknown> | null | undefined,
  options: SeedOptions = {},
): SeedCounts {
  const counts: SeedCounts = { ...ZERO_COUNTS };
  const defs = registry.getAllDefs();
  if (!json) {
    // No JSON file (or the relevant sub-object is missing). Every
    // registered key was unaffected by this rehash — count them as
    // skipped so the reply still tallies.
    counts.skipped = defs.length;
    return counts;
  }
  const pick = options.pickPath ?? pickByDottedPath;
  const instance = options.instance ?? '';
  for (const def of defs) {
    const jsonValue = pick(json, def.key);
    if (jsonValue === undefined) {
      counts.skipped++;
      continue;
    }
    const coerced = coerceFromJson(def, jsonValue);
    if (coerced === null) {
      counts.skipped++;
      continue;
    }
    const wasSet = registry.isSet(instance, def.key);
    if (wasSet) {
      // Boot semantics: never overwrite an operator-set value with the
      // (potentially stale) JSON value. `.rehash` is the deliberate
      // path operators take to pull JSON edits in.
      if (options.seedOnly) {
        counts.unchanged++;
        continue;
      }
      const existing = registry.get(instance, def.key);
      if (existing === coerced) {
        counts.unchanged++;
        continue;
      }
    }
    const outcome = registry.set(instance, def.key, coerced, options.actor);
    if (wasSet) counts.updated++;
    else counts.seeded++;
    if (outcome.reloadClass === 'reload') counts.reloaded++;
    else if (outcome.reloadClass === 'restart') counts.restartRequired++;
  }
  return counts;
}

/** Sum two SeedCounts — used by `.rehash` to roll up across scopes. */
export function addCounts(a: SeedCounts, b: SeedCounts): SeedCounts {
  return {
    seeded: a.seeded + b.seeded,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    skipped: a.skipped + b.skipped,
    reloaded: a.reloaded + b.reloaded,
    restartRequired: a.restartRequired + b.restartRequired,
  };
}
