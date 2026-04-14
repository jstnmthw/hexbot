import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotDatabase } from '../../src/database';
import { AdminListStore } from '../../src/utils/admin-list-store';

interface TestItem {
  id: string;
  label: string;
  count: number;
}

describe('AdminListStore', () => {
  let db: BotDatabase;
  let store: AdminListStore<TestItem>;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    store = new AdminListStore(db, {
      namespace: '_test',
      keyFn: (item) => item.id,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for a missing key', () => {
    expect(store.get('nope')).toBeNull();
  });

  it('stores and retrieves an item', () => {
    const item: TestItem = { id: 'a', label: 'Alpha', count: 1 };
    store.set(item);
    expect(store.get('a')).toEqual(item);
  });

  it('overwrites an existing item (upsert)', () => {
    store.set({ id: 'a', label: 'V1', count: 1 });
    store.set({ id: 'a', label: 'V2', count: 2 });
    expect(store.get('a')).toEqual({ id: 'a', label: 'V2', count: 2 });
  });

  it('deletes an item', () => {
    store.set({ id: 'a', label: 'Alpha', count: 1 });
    store.del('a');
    expect(store.get('a')).toBeNull();
  });

  it('deleting a non-existent key is a no-op', () => {
    store.del('nope'); // should not throw
    expect(store.get('nope')).toBeNull();
  });

  it('lists all items', () => {
    store.set({ id: 'a', label: 'Alpha', count: 1 });
    store.set({ id: 'b', label: 'Beta', count: 2 });
    const items = store.list();
    expect(items).toHaveLength(2);
    expect(items).toContainEqual({ id: 'a', label: 'Alpha', count: 1 });
    expect(items).toContainEqual({ id: 'b', label: 'Beta', count: 2 });
  });

  it('lists items filtered by prefix', () => {
    store.set({ id: 'ban:#a:mask1', label: 'X', count: 1 });
    store.set({ id: 'ban:#a:mask2', label: 'Y', count: 2 });
    store.set({ id: 'ban:#b:mask1', label: 'Z', count: 3 });

    const filtered = store.list('ban:#a:');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((i) => i.id)).toEqual(
      expect.arrayContaining(['ban:#a:mask1', 'ban:#a:mask2']),
    );
  });

  it('returns empty list when no items match prefix', () => {
    store.set({ id: 'foo', label: 'X', count: 1 });
    expect(store.list('bar')).toEqual([]);
  });

  it('has() returns true for existing keys', () => {
    store.set({ id: 'a', label: 'Alpha', count: 1 });
    expect(store.has('a')).toBe(true);
    expect(store.has('nope')).toBe(false);
  });

  it('uses custom serialize/deserialize', () => {
    const custom = new AdminListStore<string>(db, {
      namespace: '_custom',
      keyFn: (s) => s,
      serialize: (s) => `wrapped:${s}`,
      deserialize: (raw) => raw.replace('wrapped:', ''),
    });

    custom.set('hello');
    expect(custom.get('hello')).toBe('hello');
    // Verify raw DB value is the custom format
    expect(db.get('_custom', 'hello')).toBe('wrapped:hello');
  });

  it('does not bleed across namespaces', () => {
    const store2 = new AdminListStore<TestItem>(db, {
      namespace: '_other',
      keyFn: (item) => item.id,
    });

    store.set({ id: 'a', label: 'Store1', count: 1 });
    store2.set({ id: 'a', label: 'Store2', count: 2 });

    expect(store.get('a')!.label).toBe('Store1');
    expect(store2.get('a')!.label).toBe('Store2');
  });
});
