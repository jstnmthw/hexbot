// rss — feed item formatting + channel announcements
//
// Pure rendering helpers plus the drip-fed announce loop. Kept apart from
// fetcher/store so IRC output tweaks never pull in http or dedup logic.
import type { PluginAPI } from '../../src/types';
import type { FeedConfig, FeedItem } from './feed-store';

/** Strip HTML tags from a string in a single O(n) pass. */
export function stripHtmlTags(input: string): string {
  let result = '';
  let buf = '';
  let inTag = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '<') {
      if (!inTag) inTag = true;
      buf += ch;
    } else if (ch === '>' && inTag) {
      // Complete tag — discard buf (the tag content) and this '>'
      inTag = false;
      buf = '';
    } else if (inTag) {
      buf += ch;
    } else {
      result += ch;
    }
  }
  // Unclosed '<' at end of string was not a tag — emit the buffered text
  if (inTag) result += buf;
  return result;
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
