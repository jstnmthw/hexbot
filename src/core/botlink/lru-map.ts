// HexBot — LRU-capped Map
//
// Insertion-order LRU wrapper over the standard Map. Every `set` either
// promotes the existing key to the end of the iteration order, or — when
// the key is new and the map has reached `cap` — evicts the oldest entry
// before inserting. Exists to make the "implicit LRU via Map insertion
// order" contract explicit, since the invariant in auth.ts was fragile.
// Callers whose inserts must never displace existing entries (e.g. a
// grow-then-prune workflow) should use a plain Map and enforce the cap
// themselves.

/**
 * Map with a hard capacity and LRU eviction semantics on every `set`.
 * Re-inserting an existing key moves it to the end of the iteration order
 * (most-recently-used); a new insert at `size === cap` evicts the oldest
 * entry before adding the new one. Iteration, size, get/has/delete all
 * defer to the underlying Map so consumers that were using Map can swap
 * the type without touching anything else.
 */
export class LRUMap<K, V> implements Iterable<[K, V]> {
  private readonly map = new Map<K, V>();

  constructor(public readonly cap: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Insert or touch `key`. Promotes existing keys (delete+set) and evicts
   * the oldest entry when a new key would push the map past `cap`.
   */
  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): MapIterator<K> {
    return this.map.keys();
  }

  values(): MapIterator<V> {
    return this.map.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map.entries();
  }
}
