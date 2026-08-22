import { describe, expect, it } from 'vitest';

import {
  MAX_SEEN_PER_FEED,
  deleteRuntimeFeed,
  getLastPoll,
  hasSeen,
  markSeen,
  saveRuntimeFeed,
  setLastPoll,
} from '../../../plugins/rss/feed-store';
import type { PluginAPI, PluginDB } from '../../../src/types';

/**
 * Build an in-memory PluginDB shim that backs the few methods feed-store
 * touches. Avoids spinning up SQLite for what is purely a Map test.
 */
function makeMemoryDb(): PluginDB {
  const store = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      return store.get(key);
    },
    set(key: string, value: string): void {
      store.set(key, value);
    },
    del(key: string): void {
      store.delete(key);
    },
    list(prefix?: string): Array<{ key: string; value: string }> {
      const out: Array<{ key: string; value: string }> = [];
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.push({ key: k, value: v });
      }
      return out;
    },
  };
}

function makeApi(db: PluginDB): PluginAPI {
  return { db } as unknown as PluginAPI;
}

describe('feed-store: trimSeenToCap', () => {
  it('trims oldest dedup entries by ISO timestamp once the cap is exceeded', () => {
    // Pre-seed the cap with synthetic "seen" rows whose values are old ISO
    // timestamps. Then mark a fresh one — the trim must drop the single
    // oldest pre-seeded row, not the new entry.
    const db = makeMemoryDb();
    const api = makeApi(db);
    const feedId = 'test-feed';

    // Seed exactly MAX_SEEN_PER_FEED entries with monotonically increasing
    // ISO timestamps. `pad` keeps the hash slot lexicographically sorted —
    // important so we can predict which one gets trimmed.
    for (let i = 0; i < MAX_SEEN_PER_FEED; i++) {
      const stamp = new Date(1_700_000_000_000 + i * 1000).toISOString();
      db.set(`rss:seen:${feedId}:hash${String(i).padStart(4, '0')}`, stamp);
    }
    expect(db.list(`rss:seen:${feedId}:`).length).toBe(MAX_SEEN_PER_FEED);

    // Insert a fresh entry — its timestamp is "now", strictly newer than
    // every seeded value. The trim should remove the OLDEST seeded row.
    markSeen(api, feedId, 'fresh-hash');

    const remaining = db.list(`rss:seen:${feedId}:`);
    expect(remaining.length).toBe(MAX_SEEN_PER_FEED);
    // hash0000 was the oldest by ISO timestamp; it should have been pruned.
    expect(hasSeen(api, feedId, 'hash0000')).toBe(false);
    // The fresh entry must still be present.
    expect(hasSeen(api, feedId, 'fresh-hash')).toBe(true);
    // A middle-aged seeded entry must survive.
    expect(hasSeen(api, feedId, 'hash0500')).toBe(true);
  });

  it('does not trim when the per-feed count is at or below the cap', () => {
    // No oldest-eviction should fire as long as we stay <= cap. This guards
    // the early-return on the size check.
    const db = makeMemoryDb();
    const api = makeApi(db);
    const feedId = 'small-feed';

    for (let i = 0; i < 5; i++) {
      markSeen(api, feedId, `h${i}`);
    }
    expect(db.list(`rss:seen:${feedId}:`).length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(hasSeen(api, feedId, `h${i}`)).toBe(true);
    }
  });

  it('trims the correct excess count when many are added past the cap at once', () => {
    // Two extra entries beyond the cap — the trim loop should drop exactly
    // two oldest rows, not one and not all of them.
    const db = makeMemoryDb();
    const api = makeApi(db);
    const feedId = 'overflow-feed';

    for (let i = 0; i < MAX_SEEN_PER_FEED; i++) {
      const stamp = new Date(1_700_000_000_000 + i * 1000).toISOString();
      db.set(`rss:seen:${feedId}:hash${String(i).padStart(4, '0')}`, stamp);
    }
    // Add two new entries; second `markSeen` re-runs the trim.
    markSeen(api, feedId, 'new1');
    markSeen(api, feedId, 'new2');

    const remaining = db.list(`rss:seen:${feedId}:`);
    expect(remaining.length).toBe(MAX_SEEN_PER_FEED);
    expect(hasSeen(api, feedId, 'hash0000')).toBe(false);
    expect(hasSeen(api, feedId, 'hash0001')).toBe(false);
    expect(hasSeen(api, feedId, 'hash0002')).toBe(true);
  });
});

describe('feed-store: deleteRuntimeFeed', () => {
  it('drops the last_poll row along with the feed record', () => {
    // No other sweep reaps `rss:last_poll:` rows, so removing a feed has to
    // take its poll clock with it or the row is orphaned for good.
    const db = makeMemoryDb();
    const api = makeApi(db);

    saveRuntimeFeed(api, { id: 'gone', url: 'https://x.test/rss', channels: ['#test'] });
    setLastPoll(api, 'gone');
    expect(db.get('rss:last_poll:gone')).toBeDefined();

    deleteRuntimeFeed(api, 'gone');

    expect(db.get('rss:feed:gone')).toBeUndefined();
    expect(db.get('rss:last_poll:gone')).toBeUndefined();
    // A re-added feed under the same id must look never-polled, so init()'s
    // silent first-run seeding gate fires again instead of announcing a backlog.
    expect(getLastPoll(api, 'gone')).toBe(0);
  });

  it('leaves other feeds untouched', () => {
    const db = makeMemoryDb();
    const api = makeApi(db);

    saveRuntimeFeed(api, { id: 'a', url: 'https://a.test/rss', channels: ['#test'] });
    saveRuntimeFeed(api, { id: 'b', url: 'https://b.test/rss', channels: ['#test'] });
    setLastPoll(api, 'a');
    setLastPoll(api, 'b');

    deleteRuntimeFeed(api, 'a');

    expect(db.get('rss:last_poll:a')).toBeUndefined();
    expect(db.get('rss:last_poll:b')).toBeDefined();
    expect(db.get('rss:feed:b')).toBeDefined();
  });
});
