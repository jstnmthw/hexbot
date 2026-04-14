// rss — feed fetching + dedup-aware poll loop
//
// Wraps rss-parser with the plugin's dedup semantics. Each call marks any
// newly-seen items as seen in the KV store (via feed-store) and returns
// whichever subset the caller asked for based on `mode`.
import type Parser from 'rss-parser';

import type { PluginAPI } from '../../src/types';
import {
  type FeedConfig,
  type FeedItem,
  hasSeen,
  hashItem,
  markSeen,
  setLastPoll,
} from './feed-store';

/**
 * Poll modes:
 * - 'silent'      — mark every current item seen, announce nothing. Used on
 *                   bot startup so config-file feeds don't replay on reboot.
 * - 'announce'    — return up to `maxPerPoll` unseen items. Used by the
 *                   regular timer tick and by `!rss check`.
 * - 'seedPreview' — mark every current item seen (like 'silent'), but return
 *                   only the newest one so `!rss add` can post a single
 *                   instant-feedback preview.
 */
export type PollMode = 'silent' | 'announce' | 'seedPreview';

export async function pollFeed(
  api: PluginAPI,
  parser: Parser,
  feed: FeedConfig,
  mode: PollMode,
  maxPerPoll: number,
): Promise<FeedItem[]> {
  const result = await parser.parseURL(feed.url);
  const newItems: FeedItem[] = [];
  let previewCaptured = false;

  for (const item of result.items) {
    const hash = hashItem(item);
    if (hasSeen(api, feed.id, hash)) continue;
    markSeen(api, feed.id, hash);
    if (mode === 'announce') {
      newItems.push(item);
      if (newItems.length >= maxPerPoll) break;
    } else if (mode === 'seedPreview' && !previewCaptured) {
      newItems.push(item);
      previewCaptured = true;
      // Don't break — keep marking the rest of the feed seen so they don't
      // announce on the next tick. Only the first item goes to the channel.
    }
  }

  setLastPoll(api, feed.id);
  return newItems;
}
