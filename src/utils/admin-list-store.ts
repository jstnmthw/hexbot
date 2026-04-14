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
}

export class AdminListStore<T> {
  private readonly db: BotDatabase;
  private readonly namespace: string;
  private readonly keyFn: (item: T) => string;
  private readonly serialize: (item: T) => string;
  private readonly deserialize: (raw: string) => T;

  constructor(db: BotDatabase, opts: AdminListStoreOptions<T>) {
    this.db = db;
    this.namespace = opts.namespace;
    this.keyFn = opts.keyFn;
    this.serialize = opts.serialize ?? ((item: T) => JSON.stringify(item));
    this.deserialize = opts.deserialize ?? ((raw: string) => JSON.parse(raw) as T);
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

  /** List all items, optionally filtered by key prefix. */
  list(prefix?: string): T[] {
    const rows = this.db.list(this.namespace, prefix);
    return rows.map((row) => this.deserialize(row.value));
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return this.db.get(this.namespace, key) != null;
  }
}
