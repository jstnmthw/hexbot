// rss — feed item formatting + channel announcements
//
// Pure rendering helpers plus the drip-fed announce loop. Kept apart from
// fetcher/store so IRC output tweaks never pull in http or dedup logic.
import type { PluginAPI } from '../../src/types';
import type { FeedConfig, FeedItem } from './feed-store';

/**
 * Strip HTML tags from a string by running the tag regex to a fixed point.
 *
 * A single-pass `replace(/<[^>]*>/g, '')` is flagged by CodeQL as
 * "incomplete multi-character sanitization" because cleverly-nested input
 * can leave tag-like fragments behind that would have been caught by a
 * second pass. The output here goes to IRC (which doesn't render HTML) so
 * the practical XSS risk is nil, but we still want clean-looking titles
 * and we don't want this pattern to appear in future audits. Looping until
 * the string stabilises is the canonical fix; it terminates because every
 * non-terminal iteration strictly shortens the string.
 */
export function stripHtmlTags(input: string): string {
  let prev: string;
  let curr = input;
  do {
    prev = curr;
    curr = curr.replace(/<[^>]*>/g, '');
  } while (curr !== prev);
  return curr;
}

export function formatItem(feed: FeedConfig, item: FeedItem, maxTitleLength: number): string {
  const feedName = feed.name ?? feed.id;
  let title = stripHtmlTags(item.title ?? '').trim();
  if (title.length > maxTitleLength) {
    title = title.substring(0, maxTitleLength) + '\u2026';
  }
  const link = item.link ?? '';
  return `\x02[${feedName}]\x02 ${title}${link ? ` \u2014 ${link}` : ''}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function announceItems(
  api: PluginAPI,
  feed: FeedConfig,
  items: FeedItem[],
  maxTitleLength: number,
): Promise<void> {
  if (feed.channels.length === 0) {
    api.warn(`Feed "${feed.id}" has no channels configured — skipping announcement`);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const line = formatItem(feed, items[i], maxTitleLength);
    for (const channel of feed.channels) {
      api.say(channel, line);
    }
    if (i < items.length - 1) await delay(500);
  }

  api.log(`Announced ${items.length} item(s) from "${feed.id}" to ${feed.channels.join(', ')}`);
}
