// AdminListStore — typed CRUD persistence wrapper over the BotDatabase KV namespace.
// Provides get/set/del/list/has for a single namespace with typed serialization.
import type { BotDatabase } from '../database';

export interface AdminListStoreOptions<T> {
  /** DB namespace (e.g. '_bans', '_linkbans'). */
  namespace: string;
  /** Extract the storage key from an item. */
  keyFn: (item: T) => string;
  /** Custom serializer (default: JSON.stringify). */
  serialize?: (item: T) => string;
  /** Custom deserializer (default: JSON.parse). */
  deserialize?: (raw: string) => T;
  /**
   * Optional warn sink for corrupt-row skips during `list()`. Defaults to
   * `console.warn` so existing call sites keep their current output; a
   * supplied sink lets tests capture and core consumers route through a
   * structured logger.
   */
  warn?: (message: string) => void;
}

export class AdminListStore<T> {
  private readonly db: BotDatabase;
  private readonly namespace: string;
  private readonly keyFn: (item: T) => string;
  private readonly serialize: (item: T) => string;
  private readonly deserialize: (raw: string) => T;
  private readonly warn: (message: string) => void;

  constructor(db: BotDatabase, opts: AdminListStoreOptions<T>) {
    this.db = db;
    this.namespace = opts.namespace;
    this.keyFn = opts.keyFn;
    this.serialize = opts.serialize ?? ((item: T) => JSON.stringify(item));
    this.deserialize = opts.deserialize ?? ((raw: string) => JSON.parse(raw) as T);
    this.warn = opts.warn ?? ((message: string) => console.warn(message));
  }

  /** Get an item by key, or null if not found. */
  get(key: string): T | null {
    const raw = this.db.get(this.namespace, key);
    if (raw == null) return null;
    return this.deserialize(raw);
  }

  /** Store an item (upsert). Key is derived from the item via keyFn. */
  set(item: T): void {
    const key = this.keyFn(item);
    this.db.set(this.namespace, key, this.serialize(item));
  }

  /** Delete an item by key. */
  del(key: string): void {
    this.db.del(this.namespace, key);
  }

  /**
   * List all items, optionally filtered by key prefix. Rows whose
   * serialized value fails to deserialize (corrupted write, manual edit,
   * malformed legacy row) are skipped with a warning rather than taking
   * down the whole listing — see stability audit 2026-04-14.
   */
  list(prefix?: string): T[] {
    const rows = this.db.list(this.namespace, prefix);
    const result: T[] = [];
    for (const row of rows) {
      try {
        result.push(this.deserialize(row.value));
      } catch (err) {
        this.warn(
          `[admin-list-store:${this.namespace}] Skipping corrupt row "${row.key}": ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return this.db.get(this.namespace, key) != null;
  }
}
