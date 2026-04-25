// rss — feed dedup + runtime persistence
//
// All database reads and writes for the rss plugin live here. Keeping the
// storage shape in one module means the fetcher/formatter never need to
// know about KV keys, and the test surface stays narrow.
import { createHash } from 'node:crypto';
import type Parser from 'rss-parser';

import type { PluginAPI } from '../../src/types';

/**
 * Shape of a single feed, both in plugins.json config and in the KV store
 * for runtime-added feeds (dual-audience: developers editing TS + operators
 * editing JSON rely on IDE hover here).
 */
export interface FeedConfig {
  /** Stable identifier; used as the KV namespace and in user-facing commands. */
  id: string;
  /** Feed URL. Re-validated on every fetch — see `url-validator.ts`. */
  url: string;
  /** Optional display name shown in announcements; falls back to `id`. */
  name?: string;
  /** Channels that receive announcements for this feed. */
  channels: string[];
  /** Poll interval in seconds. Default 3600 (1 hour). */
  interval?: number;
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

/**
 * Stable dedup fingerprint for a feed item. Prefers `guid` (publisher's own
 * identity) and falls back to `title+link` when absent. 16-hex-char truncation
 * of sha1 gives ~64 bits — collision risk is negligible per-feed at the
 * {@link MAX_SEEN_PER_FEED} cap.
 */
export function hashItem(item: FeedItem): string {
  const input = item.guid || `${item.title ?? ''}${item.link ?? ''}`;
  return createHash('sha1').update(input).digest('hex').substring(0, 16);
}

/** True if the fingerprint for `feedId`/`hash` is already recorded as seen. */
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

/**
 * Mark `hash` as seen for `feedId`, stamping the current ISO time as the
 * value (used later by {@link cleanupSeen} to age rows out). Trims oldest
 * entries over the per-feed cap in the same call.
 */
export function markSeen(api: PluginAPI, feedId: string, hash: string): void {
  api.db.set(`rss:seen:${feedId}:${hash}`, new Date().toISOString());
  trimSeenToCap(api, feedId);
}

/**
 * Trim the per-feed seen set down to {@link MAX_SEEN_PER_FEED}, dropping
 * the oldest-stamped entries first. Sort cost is bounded by the cap, so
 * even pathological feeds keep this O(n log n) on a small n.
 */
function trimSeenToCap(api: PluginAPI, feedId: string): void {
  const entries = api.db.list(`rss:seen:${feedId}:`);
  if (entries.length <= MAX_SEEN_PER_FEED) return;
  entries.sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  const excess = entries.length - MAX_SEEN_PER_FEED;
  for (let i = 0; i < excess; i++) {
    api.db.del(entries[i].key);
  }
}

/** Last successful poll time as epoch ms; 0 if never polled or corrupt. */
export function getLastPoll(api: PluginAPI, feedId: string): number {
  const raw = api.db.get(`rss:last_poll:${feedId}`);
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? 0 : ts;
}

/** Record the current wall-clock time as the last poll for `feedId`. */
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

/**
 * Load runtime-added feeds (those added via `!rss add`) from the KV store.
 * Corrupt or shape-invalid entries are dropped during load and warned about.
 */
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

/** Persist a runtime-added feed so it survives plugin reload / bot restart. */
export function saveRuntimeFeed(api: PluginAPI, feed: FeedConfig): void {
  api.db.set(`rss:feed:${feed.id}`, JSON.stringify(feed));
}

/** Delete a runtime-added feed from persistence. */
export function deleteRuntimeFeed(api: PluginAPI, id: string): void {
  api.db.del(`rss:feed:${id}`);
}

/** True if `id` was added at runtime (vs. defined in plugins.json config). */
export function isRuntimeFeed(api: PluginAPI, id: string): boolean {
  return api.db.get(`rss:feed:${id}`) !== undefined;
}
