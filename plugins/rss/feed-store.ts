// rss — feed dedup + runtime persistence
//
// All database reads and writes for the rss plugin live here. Keeping the
// storage shape in one module means the fetcher/formatter never need to
// know about KV keys, and the test surface stays narrow.
import { createHash } from 'node:crypto';
import type Parser from 'rss-parser';

import type { PluginAPI } from '../../src/types';

export interface FeedConfig {
  id: string;
  url: string;
  name?: string;
  channels: string[];
  interval?: number; // seconds, default 3600
}

/** Minimal shape of a feed entry consumed by this plugin. */
export type FeedItem = Pick<Parser.Item, 'guid' | 'title' | 'link'>;

/** Type guard for a runtime-stored FeedConfig record. */
export function isFeedConfig(value: unknown): value is FeedConfig {
  /* v8 ignore next -- defensive: JSON.parse on stored feeds returns object */
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.url === 'string' &&
    Array.isArray(v.channels) &&
    v.channels.every((c): c is string => typeof c === 'string')
  );
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

export function hashItem(item: FeedItem): string {
  const input = item.guid || `${item.title ?? ''}${item.link ?? ''}`;
  return createHash('sha1').update(input).digest('hex').substring(0, 16);
}

export function hasSeen(api: PluginAPI, feedId: string, hash: string): boolean {
  return api.db.get(`rss:seen:${feedId}:${hash}`) !== undefined;
}

/**
 * Hard cap on dedup entries retained per feed. A high-volume feed that posts
 * 30k+ items in a day would otherwise accumulate all of them between daily
 * `cleanupSeen` sweeps, causing `db.list('rss:seen:')` to briefly hold them
 * all in memory. Trimming oldest-first on every write keeps the table bounded.
 * See memleak audit 2026-04-14 INFO note.
 */
export const MAX_SEEN_PER_FEED = 1000;

export function markSeen(api: PluginAPI, feedId: string, hash: string): void {
  api.db.set(`rss:seen:${feedId}:${hash}`, new Date().toISOString());
  trimSeenToCap(api, feedId);
}

function trimSeenToCap(api: PluginAPI, feedId: string): void {
  const entries = api.db.list(`rss:seen:${feedId}:`);
  if (entries.length <= MAX_SEEN_PER_FEED) return;
  entries.sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  const excess = entries.length - MAX_SEEN_PER_FEED;
  for (let i = 0; i < excess; i++) {
    api.db.del(entries[i].key);
  }
}

export function getLastPoll(api: PluginAPI, feedId: string): number {
  const raw = api.db.get(`rss:last_poll:${feedId}`);
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? 0 : ts;
}

export function setLastPoll(api: PluginAPI, feedId: string): void {
  api.db.set(`rss:last_poll:${feedId}`, new Date().toISOString());
}

/** Prune dedup entries older than `dedupWindowDays`. */
export function cleanupSeen(api: PluginAPI, dedupWindowDays: number): void {
  const maxAgeMs = dedupWindowDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const entries = api.db.list('rss:seen:');

  for (const entry of entries) {
    const ts = Date.parse(entry.value);
    if (Number.isNaN(ts) || now - ts > maxAgeMs) {
      api.db.del(entry.key);
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime feed persistence
// ---------------------------------------------------------------------------

export function loadRuntimeFeeds(api: PluginAPI): FeedConfig[] {
  const entries = api.db.list('rss:feed:');
  const feeds: FeedConfig[] = [];
  for (const entry of entries) {
    try {
      const parsed: unknown = JSON.parse(entry.value);
      /* v8 ignore next 5 */
      if (!isFeedConfig(parsed)) {
        api.warn(`Corrupt runtime feed entry: ${entry.key}`);
        api.db.del(entry.key);
        continue;
      }
      feeds.push(parsed);
    } catch {
      api.warn(`Corrupt runtime feed entry: ${entry.key}`);
      api.db.del(entry.key);
    }
  }
  return feeds;
}

export function saveRuntimeFeed(api: PluginAPI, feed: FeedConfig): void {
  api.db.set(`rss:feed:${feed.id}`, JSON.stringify(feed));
}

export function deleteRuntimeFeed(api: PluginAPI, id: string): void {
  api.db.del(`rss:feed:${id}`);
}

export function isRuntimeFeed(api: PluginAPI, id: string): boolean {
  return api.db.get(`rss:feed:${id}`) !== undefined;
}
