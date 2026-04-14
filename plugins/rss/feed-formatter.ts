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

export function formatItem(
  api: PluginAPI,
  feed: FeedConfig,
  item: FeedItem,
  maxTitleLength: number,
): string {
  const feedName = api.stripFormatting(feed.name ?? feed.id);
  let title = api.stripFormatting(stripHtmlTags(item.title ?? '').trim());
  if (title.length > maxTitleLength) {
    title = title.substring(0, maxTitleLength) + '\u2026';
  }
  const link = api.stripFormatting(item.link ?? '');
  return `\x02[${feedName}]\x02 ${title}${link ? ` \u2014 ${link}` : ''}`;
}

export async function announceItems(
  api: PluginAPI,
  feed: FeedConfig,
  items: FeedItem[],
  maxTitleLength: number,
  signal?: AbortSignal,
): Promise<void> {
  if (feed.channels.length === 0) {
    api.warn(`Feed "${feed.id}" has no channels configured — skipping announcement`);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) return;
    const line = formatItem(api, feed, items[i], maxTitleLength);
    for (const channel of feed.channels) {
      api.say(channel, line);
    }
    // Drip-feed at 500ms per item so a burst doesn't flood the channel or
    // trip the server's own rate limiter. The sleep is interruptible: if
    // the plugin is torn down mid-drip the abort resolves the sleep
    // immediately so we return without touching `api` again.
    if (i < items.length - 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 500);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  api.log(`Announced ${items.length} item(s) from "${feed.id}" to ${feed.channels.join(', ')}`);
}
