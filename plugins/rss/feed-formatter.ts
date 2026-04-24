// rss — feed item formatting + channel announcements
//
// Pure rendering helpers plus the drip-fed announce loop. Kept apart from
// fetcher/store so IRC output tweaks never pull in http or dedup logic.
import type { PluginAPI } from '../../src/types';
import type { FeedConfig, FeedItem } from './feed-store';

/**
 * Minimal HTML-entity decoder covering the named entities feed publishers
 * emit most often plus the numeric / hex forms. Runs *before* tag stripping
 * so a crafted title like `&lt;script&gt;alert(1)&lt;/script&gt;` doesn't
 * surface as literal `<script>` text that confuses downstream viewers.
 * The lookup table is intentionally narrow — full HTML entity coverage
 * would pull in a dependency without changing the threat model.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]{1,10});/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    const replacement = NAMED_ENTITIES[body.toLowerCase()];
    return replacement ?? match;
  });
}

/**
 * Strip HTML tags in a single O(n) pass. Entities are decoded first so
 * `&lt;b&gt;`-style literals resolve before we look for `<` / `>`.
 */
export function stripHtmlTags(input: string): string {
  const decoded = decodeEntities(input);
  let result = '';
  let buf = '';
  let inTag = false;
  for (let i = 0; i < decoded.length; i++) {
    const ch = decoded[i];
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

/**
 * Render a feed item as a single IRC line with a bold `[feedName]` prefix.
 * Titles are HTML-tag-stripped and truncated to `maxTitleLength` (with a
 * horizontal-ellipsis). All user-visible fields pass through
 * `api.stripFormatting` so publisher-injected color/bold codes can't
 * spoof bot formatting in the channel.
 */
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

/** Per-item drip delay used between successive announce lines. */
const ANNOUNCE_DRIP_MS = 500;

/**
 * Resolve after `ms` or immediately when `signal` aborts. Listener is
 * detached after either outcome so the signal doesn't leak a handler per
 * call. Used by {@link announceItems} so `teardown()` can interrupt the
 * drip-feed without waiting out the final sleep.
 */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drip-feed a batch of items to every channel configured on `feed`, sleeping
 * `ANNOUNCE_DRIP_MS` between items so a large batch doesn't flood the
 * channel or trip the server's own rate limiter. The `signal` is honored
 * at each sleep and each item boundary so `teardown()` interrupts
 * mid-batch cleanly. Formatting stays in {@link formatItem}; this
 * function is pure loop + send + sleep.
 */
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
    if (i < items.length - 1) {
      await interruptibleSleep(ANNOUNCE_DRIP_MS, signal);
    }
  }

  api.log(`Announced ${items.length} item(s) from "${feed.id}" to ${feed.channels.join(', ')}`);
}
