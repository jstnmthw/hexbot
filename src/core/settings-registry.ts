// HexBot — Generalized settings registry (core / plugin / channel scopes)
//
// Generalization of `src/core/channel-settings.ts`: the same typed-def +
// KV-backed pattern, but parameterized on a scope and an audit action so
// it can power three runtime instances:
//
//   scope     | namespace      | owner             | audit action prefix
//   ----------+----------------+-------------------+--------------------
//   core      | core           | 'bot'             | coreset
//   plugin    | plugin:<id>    | <pluginId>        | pluginset
//   channel   | chanset        | declaring plugin  | chanset
//
// The `channel` scope folds keys through an injected IRC-aware case
// folder so `#Foo` and `#foo` resolve to the same record. `core` /
// `plugin` scopes use identity folding — the "instance" is bot-wide
// or plugin-wide, so there is no IRC-instance-keyed dimension to
// case-fold.
//
// One pre-normalisation compat fallback remains in `get()`: a miss
// against the folded key retries against the raw-cased key, so
// databases that pre-date channel-key folding don't silently lose
// their stored values. Drop the fallback (and migrate the rows once)
// if the live DB has no pre-normalisation entries.
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

/**
 * Reload class declared on every setting def. Drives the registry's
 * post-write behaviour:
 *   - `live`    : `onChange` fires; the listener applies the new value.
 *   - `reload`  : `onChange` fires, then the def's `onReload` swap closure
 *                 runs (subsystem reattach). Failure is logged, not thrown.
 *   - `restart` : KV is updated, `onChange` fires, but the def's
 *                 `onRestartRequired` is invoked so the registry can
 *                 surface a "stored; takes effect after .restart" hint
 *                 to the operator.
 *
 * Plugins / core subsystems pick the class when they `register()`.
 * Phase 3 introspects this from Zod `.describe('@reload:*')` annotations
 * on `BotConfigOnDiskSchema`.
 */
export type ReloadClass = 'live' | 'reload' | 'restart';

/**
 * Outcome returned by `set()` / `unset()` so the operator-facing
 * `.set` / `.unset` commands can render the right post-write hint
 * (`applied live`, `subsystem reloaded`, `stored; takes effect after
 * .restart`). The `restartReason` is the def's `onRestartRequired`
 * return value, or a default message when the def did not provide one.
 */
export interface SettingsWriteOutcome {
  reloadClass: ReloadClass;
  /** When `reloadClass === 'restart'`, an operator-facing reason string. */
  restartReason?: string;
  /** When `reloadClass === 'reload'`, true if the swap closure threw. */
  reloadFailed?: boolean;
}

/**
 * Setting definition extending the channel-scope shape with a reload
 * class and optional reload/restart hooks. Channel-scope settings are
 * always `live`-class — values are read fresh on every event dispatch,
 * so there is no subsystem to reattach — and so plugins keep registering
 * the leaner {@link ChannelSettingDef} shape. The reload-class fields
 * are only meaningful for the `core` / `plugin` scopes; absent fields
 * default to `live` with no swap closure.
 */
export interface SettingDef extends ChannelSettingDef {
  /** Reload class — defaults to `live` when absent. */
  reloadClass?: ReloadClass;
  /**
   * Subsystem reattach closure — invoked by the registry after the KV
   * write and `onChange` notification when `reloadClass === 'reload'`.
   * Failures are caught and logged; the operator-facing `set()` outcome
   * carries `reloadFailed: true` so the command can render an error hint.
   */
  onReload?: (value: ChannelSettingValue) => void | Promise<void>;
  /**
   * Returns an operator-facing reason string explaining why the change
   * cannot apply live. Used only when `reloadClass === 'restart'`.
   */
  onRestartRequired?: (value: ChannelSettingValue) => string;
}

/** SettingDef with its owning subsystem/plugin attached (registry view). */
export interface SettingEntry extends SettingDef {
  /**
   * Owner of the registration — `'bot'` for core, `<pluginId>` for plugin
   * and channel scopes. Drives `unregister(owner)` cleanup.
   */
  owner: string;
  /** Resolved reload class (defaults to `live` when the def omits it). */
  reloadClass: ReloadClass;
}

/** Scope discriminator. Only `channel` does IRC-aware key folding. */
export type SettingsScope = 'core' | 'plugin' | 'channel';

/**
 * Audit action strings emitted by the registry. Registries are wired
 * with the `set`/`unset` strings their scope uses so audit filters can
 * stay scope-aware (`chanset-set` vs `coreset-set` vs `pluginset-set`).
 */
export interface SettingsAuditActions {
  set: string;
  unset: string;
}

/**
 * Signature for the IRC-aware case folder. The channel scope wires
 * `(s) => ircLower(s, currentCasemapping)`; the core / plugin scopes use
 * the identity function (settings keys for those scopes are not
 * IRC-instance-keyed).
 */
export type ChannelLower = (channel: string) => string;
const IDENTITY_LOWER: ChannelLower = (s) => s;

export interface SettingsRegistryOptions {
  scope: SettingsScope;
  /** SQLite KV namespace for this registry's stored values. */
  namespace: string;
  db: BotDatabase;
  logger?: LoggerLike;
  /** Audit action strings used by `set()` / `unset()`. */
  auditActions: SettingsAuditActions;
  /**
   * IRC-aware key folder. Required for the `channel` scope; ignored by
   * `core` / `plugin` (which always use identity folding).
   */
  ircLower?: ChannelLower;
}

/**
 * Generalized typed-setting registry powering core / plugin / channel
 * scopes from a single implementation. See module header for the scope
 * matrix.
 */
export class SettingsRegistry {
  private readonly scope: SettingsScope;
  private readonly namespace: string;
  private readonly db: BotDatabase;
  private readonly logger: LoggerLike | undefined;
  private readonly auditActions: SettingsAuditActions;
  private readonly fold: ChannelLower;
  private readonly defs: Map<string, SettingEntry> = new Map();
  /** Per-owner `onChange` listener stacks. */
  private readonly listeners: Map<string, ChannelSettingChangeCallback[]> = new Map();

  constructor(opts: SettingsRegistryOptions) {
    this.scope = opts.scope;
    this.namespace = opts.namespace;
    this.db = opts.db;
    this.logger = opts.logger;
    this.auditActions = opts.auditActions;
    this.fold = opts.scope === 'channel' ? (opts.ircLower ?? IDENTITY_LOWER) : IDENTITY_LOWER;
  }

  /**
   * Register typed setting definitions under an owner. Re-registering
   * the same key from the same owner replaces it; key collisions across
   * owners are logged and skipped (first-writer-wins).
   */
  register(owner: string, defs: SettingDef[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.key);
      if (existing && existing.owner !== owner) {
        this.logger?.warn(
          `Key collision: "${def.key}" already registered by "${existing.owner}" — skipping "${owner}"`,
        );
        continue;
      }
      this.defs.set(def.key, {
        ...def,
        owner,
        reloadClass: def.reloadClass ?? 'live',
      });
    }
  }

  /**
   * Drop every def registered by `owner`. Stored KV values are
   * intentionally preserved — operator data survives plugin unloads.
   */
  unregister(owner: string): void {
    for (const [key, entry] of this.defs) {
      if (entry.owner === owner) this.defs.delete(key);
    }
  }

  /**
   * Read a setting value. `instance` is the channel name for channel
   * scope; for core / plugin scope it is unused (callers pass `''` and
   * the registry treats it as a singleton). On unknown keys returns
   * `''` for graceful degradation (plugin may be unloaded).
   *
   * Reads first try the folded key; on a miss they fall back to the
   * raw-cased key so pre-normalisation databases still surface their
   * values. This affects the channel scope only — core / plugin scopes
   * use identity folding so the fallback is a no-op equivalence.
   */
  get(instance: string, key: string): ChannelSettingValue {
    const def = this.defs.get(key);
    if (!def) return '';
    const folded = this.makeKey(instance, key);
    let stored = this.db.get(this.namespace, folded);
    if (stored === null && folded !== `${instance}:${key}`) {
      stored = this.db.get(this.namespace, `${instance}:${key}`);
    }
    if (stored === null) return def.default;
    return this.coerce(def, stored);
  }

  getFlag(instance: string, key: string): boolean {
    const v = this.get(instance, key);
    return typeof v === 'boolean' ? v : false;
  }

  getString(instance: string, key: string): string {
    const v = this.get(instance, key);
    return typeof v === 'string' ? v : '';
  }

  getInt(instance: string, key: string): number {
    const v = this.get(instance, key);
    return typeof v === 'number' ? v : 0;
  }

  /**
   * Write a setting value. Returns the reload-class outcome so the
   * operator-facing command can render the right hint. The KV write,
   * `onChange` fan-out, and reload/restart hooks always run in this
   * order so listeners observe the new value before reattach.
   *
   * `actor` is optional but strongly encouraged — when provided, the
   * mutation is recorded to `mod_log` under the registry's configured
   * audit action. The unattributed path is reserved for plugin
   * internals and migrations.
   */
  set(
    instance: string,
    key: string,
    value: ChannelSettingValue,
    actor?: ModActor,
  ): SettingsWriteOutcome {
    const def = this.defs.get(key);
    if (!def) {
      this.logger?.warn(`Unknown key "${key}" — cannot set`);
      return { reloadClass: 'live' };
    }
    this.db.set(this.namespace, this.makeKey(instance, key), String(value));
    this.notifyChange(instance, key, value);
    if (actor) {
      this.writeAudit(this.auditActions.set, instance, key, String(value), def, actor);
    }
    return this.applyReloadClass(def, value);
  }

  /**
   * Delete a stored value — next read returns the registered default.
   * Notifies listeners with the default so they can apply the revert.
   * Audit row is written with the default-value as the `reason` (so
   * `.modlog` shows what the operator reverted to).
   */
  unset(instance: string, key: string, actor?: ModActor): SettingsWriteOutcome {
    const def = this.defs.get(key);
    const folded = this.makeKey(instance, key);
    this.db.del(this.namespace, folded);
    const raw = `${instance}:${key}`;
    if (raw !== folded) this.db.del(this.namespace, raw);
    if (def) {
      this.notifyChange(instance, key, def.default);
      if (actor) {
        this.writeAudit(this.auditActions.unset, instance, key, String(def.default), def, actor);
      }
      return this.applyReloadClass(def, def.default);
    }
    return { reloadClass: 'live' };
  }

  /**
   * Register a callback that fires when any setting in this registry
   * is set or unset. Owner-keyed for cleanup on plugin unload / core
   * shutdown. Reference-deduplicated to guard against double-init.
   */
  onChange(owner: string, cb: ChannelSettingChangeCallback): void {
    const list = this.listeners.get(owner) ?? [];
    if (list.includes(cb)) return;
    list.push(cb);
    this.listeners.set(owner, list);
  }

  offChange(owner: string): void {
    this.listeners.delete(owner);
  }

  /** True if `(instance, key)` has an explicit stored value. */
  isSet(instance: string, key: string): boolean {
    if (this.db.get(this.namespace, this.makeKey(instance, key)) !== null) return true;
    return this.db.get(this.namespace, `${instance}:${key}`) !== null;
  }

  getDef(key: string): SettingEntry | undefined {
    return this.defs.get(key);
  }

  /** All registered defs across all owners, in registration order. */
  getAllDefs(): SettingEntry[] {
    return Array.from(this.defs.values());
  }

  /**
   * Snapshot every registered def with its current value for the given
   * instance (channel name for channel scope; `''` or any string for
   * core / plugin singletons).
   */
  getSnapshot(
    instance: string,
  ): Array<{ entry: SettingEntry; value: ChannelSettingValue; isDefault: boolean }> {
    return Array.from(this.defs.values()).map((entry) => {
      const folded = this.makeKey(instance, entry.key);
      let stored = this.db.get(this.namespace, folded);
      if (stored === null && folded !== `${instance}:${entry.key}`) {
        stored = this.db.get(this.namespace, `${instance}:${entry.key}`);
      }
      const isDefault = stored === null;
      const value = stored === null ? entry.default : this.coerce(entry, stored);
      return { entry, value, isDefault };
    });
  }

  /**
   * Underlying KV namespace — exposed so `seedFromJson` and operator
   * commands can render scope-aware messages without hand-coding the
   * namespace string.
   */
  getNamespace(): string {
    return this.namespace;
  }

  getScope(): SettingsScope {
    return this.scope;
  }

  /**
   * Adapter that re-shapes a registry-internal {@link SettingEntry}
   * (which uses `owner: string`) into the plugin-facing
   * {@link ChannelSettingEntry} shape (which uses `pluginId: string`).
   * The two are the same data with different field names — the rename
   * is the only difference, kept for plugin-API ergonomics.
   */
  toChannelSettingEntry(entry: SettingEntry): ChannelSettingEntry {
    return {
      key: entry.key,
      type: entry.type,
      default: entry.default,
      description: entry.description,
      ...(entry.allowedValues !== undefined ? { allowedValues: entry.allowedValues } : {}),
      pluginId: entry.owner,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private makeKey(instance: string, key: string): string {
    return `${this.fold(instance)}:${key}`;
  }

  private notifyChange(instance: string, key: string, value: ChannelSettingValue): void {
    for (const callbacks of this.listeners.values()) {
      for (const cb of callbacks) {
        try {
          cb(instance, key, value);
        } catch (err) {
          this.logger?.error(`onChange callback error for key "${key}":`, err);
        }
      }
    }
  }

  private writeAudit(
    action: string,
    instance: string,
    key: string,
    reason: string,
    def: SettingEntry,
    actor: ModActor,
  ): void {
    // The `plugin` field is required on plugin-source rows and forbidden
    // on every other source. Honour an actor-supplied plugin id first,
    // then fall back to the def's owning plugin when the actor's source
    // demands one.
    const pluginId =
      actor.plugin ?? (actor.source === 'plugin' && this.scope !== 'core' ? def.owner : undefined);
    tryLogModAction(
      this.db,
      {
        action,
        // For channel scope `instance` is the channel; for core/plugin
        // scope there is no channel — pass null.
        channel: this.scope === 'channel' ? instance : null,
        target: key,
        reason,
        source: actor.source,
        by: actor.by,
        ...(pluginId ? { plugin: pluginId } : {}),
      },
      this.logger ?? null,
    );
  }

  private applyReloadClass(def: SettingEntry, value: ChannelSettingValue): SettingsWriteOutcome {
    if (def.reloadClass === 'live') {
      return { reloadClass: 'live' };
    }
    if (def.reloadClass === 'reload') {
      let reloadFailed = false;
      try {
        const out = def.onReload?.(value);
        if (out instanceof Promise) {
          out.catch((err) => {
            this.logger?.error(`onReload for "${def.key}" rejected:`, err);
          });
        }
      } catch (err) {
        reloadFailed = true;
        this.logger?.error(`onReload for "${def.key}" threw:`, err);
      }
      return { reloadClass: 'reload', reloadFailed };
    }
    // restart
    const reason = def.onRestartRequired?.(value) ?? `core.${def.key} takes effect after .restart`;
    return { reloadClass: 'restart', restartReason: reason };
  }

  private coerce(def: SettingDef, stored: string): ChannelSettingValue {
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

/**
 * Pattern for the `@reload:<class>` token embedded in Zod schema
 * descriptions. Read by {@link parseReloadClassFromDescription} to
 * derive the registry's reload class from a schema annotation.
 */
const RELOAD_TOKEN_RE = /@reload:(live|reload|restart)\b/;

/**
 * Pull the `@reload:<class>` token out of a `.describe(...)` string
 * (e.g. `'@reload:live'` → `'live'`). Returns `'live'` when the string
 * is empty, undefined, or omits the token — `live` is the safest
 * default because it surfaces an immediate `onChange`, letting the
 * subsystem decide if a reattach is needed at runtime.
 */
export function parseReloadClassFromDescription(description?: string): ReloadClass {
  if (!description) return 'live';
  const match = RELOAD_TOKEN_RE.exec(description);
  return match ? (match[1] as ReloadClass) : 'live';
}

/**
 * Read the `@reload:*` token from a Zod schema's `.description`. Wraps
 * {@link parseReloadClassFromDescription} so callers don't have to peek
 * into Zod internals — every Zod schema exposes its description on the
 * shared `description` property.
 */
export function parseReloadClassFromZod(schema: { description?: string }): ReloadClass {
  return parseReloadClassFromDescription(schema.description);
}
