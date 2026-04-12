// rss — RSS/Atom feed announcer plugin
// Polls configured feeds and announces new items to IRC channels.
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';

import type { PluginAPI } from '../../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedConfig {
  id: string;
  url: string;
  name?: string;
  channels: string[];
  interval?: number; // seconds, default 3600
}

interface PluginConfig {
  feeds: FeedConfig[];
  dedup_window_days: number;
  max_title_length: number;
  request_timeout_ms: number;
  max_per_poll: number;
}

interface FeedItem {
  guid?: string;
  title?: string;
  link?: string;
}

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

export const name = 'rss';
export const version = '1.0.0';
export const description = 'Polls RSS/Atom feeds and announces new items to configured channels';

// Mutable feed map: merged config + runtime feeds. Keyed by feed id.
let activeFeeds = new Map<string, FeedConfig>();
let parser: Parser;

export async function init(api: PluginAPI): Promise<void> {
  const cfg = loadConfig(api);
  parser = new Parser({ timeout: cfg.request_timeout_ms });

  // Merge config-file feeds with runtime-added feeds from KV
  activeFeeds = new Map<string, FeedConfig>();
  for (const feed of cfg.feeds) activeFeeds.set(feed.id, feed);
  for (const feed of loadRuntimeFeeds(api)) {
    if (!activeFeeds.has(feed.id)) activeFeeds.set(feed.id, feed);
  }

  // Silent first-run seeding: mark all existing items as seen without announcing
  for (const feed of activeFeeds.values()) {
    try {
      await pollFeed(api, feed, cfg, false);
    } catch (err) {
      api.error(`Error seeding feed "${feed.id}":`, (err as Error).message);
    }
  }

  // Single 60s time bind — checks which feeds are due on each tick
  api.bind('time', '-', '60', async () => {
    for (const feed of activeFeeds.values()) {
      const lastPoll = getLastPoll(api, feed.id);
      const interval = (feed.interval ?? 3600) * 1000;
      if (Date.now() - lastPoll < interval) continue;

      try {
        const items = await pollFeed(api, feed, cfg, true);
        if (items.length > 0) {
          await announceItems(api, feed, items, cfg);
        }
      } catch (err) {
        api.error(`Error polling feed "${feed.id}" (${feed.url}):`, (err as Error).message);
      }
    }
  });

  // Daily cleanup of stale dedup entries
  api.bind('time', '-', '86400', () => {
    cleanupSeen(api, cfg);
  });

  // Admin commands
  api.bind('pub', 'm', '!rss', async (ctx) => {
    const parts = ctx.args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? '';

    if (sub === 'list') {
      handleList(api, ctx.nick);
    } else if (sub === 'add') {
      await handleAdd(api, ctx.nick, parts.slice(1), cfg);
    } else if (sub === 'remove') {
      handleRemove(api, ctx.nick, parts[1]);
    } else if (sub === 'check') {
      // check only requires 'o' — but the bind requires 'm', so we also
      // allow it through. Operators who don't have 'm' can't reach the bind
      // at all, but we keep the distinction documented for future loosening.
      await handleCheck(api, ctx.nick, parts[1], cfg);
    } else {
      api.notice(ctx.nick, 'Usage: !rss <list|add|remove|check>');
    }
  });

  // Register help entries
  api.registerHelp([
    {
      command: '!rss',
      flags: 'm',
      usage: '!rss list',
      description: 'List all active RSS feeds',
      detail: [
        '!rss list — list all active feeds with channels and intervals',
        '!rss add <id> <url> <#channel> [interval] — add a feed at runtime',
        '!rss remove <id> — remove a runtime-added feed',
        '!rss check [id] — manually poll a feed (or all feeds)',
      ],
      category: 'rss',
    },
  ]);

  api.log(`Loaded with ${activeFeeds.size} feed(s)`);
}

export function teardown(): void {
  activeFeeds.clear();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(api: PluginAPI): PluginConfig {
  const c = api.config as Partial<PluginConfig>;
  return {
    feeds: Array.isArray(c.feeds) ? c.feeds : [],
    dedup_window_days: c.dedup_window_days ?? 30,
    max_title_length: c.max_title_length ?? 300,
    request_timeout_ms: c.request_timeout_ms ?? 10000,
    max_per_poll: c.max_per_poll ?? 5,
  };
}

// ---------------------------------------------------------------------------
// Hashing and deduplication
// ---------------------------------------------------------------------------

export function hashItem(item: FeedItem): string {
  const input = item.guid || `${item.title ?? ''}${item.link ?? ''}`;
  return createHash('sha1').update(input).digest('hex').substring(0, 16);
}

function hasSeen(api: PluginAPI, feedId: string, hash: string): boolean {
  return api.db.get(`rss:seen:${feedId}:${hash}`) !== undefined;
}

function markSeen(api: PluginAPI, feedId: string, hash: string): void {
  api.db.set(`rss:seen:${feedId}:${hash}`, new Date().toISOString());
}

function getLastPoll(api: PluginAPI, feedId: string): number {
  const raw = api.db.get(`rss:last_poll:${feedId}`);
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? 0 : ts;
}

function setLastPoll(api: PluginAPI, feedId: string): void {
  api.db.set(`rss:last_poll:${feedId}`, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollFeed(
  api: PluginAPI,
  feed: FeedConfig,
  config: PluginConfig,
  announce: boolean,
): Promise<FeedItem[]> {
  const result = await parser.parseURL(feed.url);
  const newItems: FeedItem[] = [];

  for (const item of result.items) {
    const hash = hashItem(item);
    if (hasSeen(api, feed.id, hash)) continue;
    markSeen(api, feed.id, hash);
    if (announce) {
      newItems.push(item);
      if (newItems.length >= config.max_per_poll) break;
    }
  }

  setLastPoll(api, feed.id);
  return newItems;
}

// ---------------------------------------------------------------------------
// Formatting and announcing
// ---------------------------------------------------------------------------

export function formatItem(feed: FeedConfig, item: FeedItem, config: PluginConfig): string {
  const feedName = feed.name ?? feed.id;
  let title = (item.title ?? '').replace(/<[^>]*>/g, '').trim();
  if (title.length > config.max_title_length) {
    title = title.substring(0, config.max_title_length) + '\u2026';
  }
  const link = item.link ?? '';
  return `\x02[${feedName}]\x02 ${title}${link ? ` \u2014 ${link}` : ''}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function announceItems(
  api: PluginAPI,
  feed: FeedConfig,
  items: FeedItem[],
  config: PluginConfig,
): Promise<void> {
  if (feed.channels.length === 0) {
    api.warn(`Feed "${feed.id}" has no channels configured — skipping announcement`);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const line = formatItem(feed, items[i], config);
    for (const channel of feed.channels) {
      api.say(channel, line);
    }
    if (i < items.length - 1) await delay(500);
  }
}

// ---------------------------------------------------------------------------
// Stale entry cleanup
// ---------------------------------------------------------------------------

function cleanupSeen(api: PluginAPI, config: PluginConfig): void {
  const maxAgeMs = config.dedup_window_days * 24 * 60 * 60 * 1000;
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

function loadRuntimeFeeds(api: PluginAPI): FeedConfig[] {
  const entries = api.db.list('rss:feed:');
  const feeds: FeedConfig[] = [];
  for (const entry of entries) {
    try {
      feeds.push(JSON.parse(entry.value) as FeedConfig);
    } catch {
      api.warn(`Corrupt runtime feed entry: ${entry.key}`);
      api.db.del(entry.key);
    }
  }
  return feeds;
}

function saveRuntimeFeed(api: PluginAPI, feed: FeedConfig): void {
  api.db.set(`rss:feed:${feed.id}`, JSON.stringify(feed));
}

function deleteRuntimeFeed(api: PluginAPI, id: string): void {
  api.db.del(`rss:feed:${id}`);
}

function isRuntimeFeed(api: PluginAPI, id: string): boolean {
  return api.db.get(`rss:feed:${id}`) !== undefined;
}

// ---------------------------------------------------------------------------
// Admin command handlers (all respond via notice to invoking user)
// ---------------------------------------------------------------------------

function handleList(api: PluginAPI, nick: string): void {
  if (activeFeeds.size === 0) {
    api.notice(nick, 'No feeds configured.');
    return;
  }
  api.notice(nick, `Active feeds (${activeFeeds.size}):`);
  for (const feed of activeFeeds.values()) {
    const interval = feed.interval ?? 3600;
    const channels = feed.channels.join(', ');
    const source = isRuntimeFeed(api, feed.id) ? 'runtime' : 'config';
    api.notice(nick, `  ${feed.id} — ${feed.url} → ${channels} (every ${interval}s) [${source}]`);
  }
}

async function handleAdd(
  api: PluginAPI,
  nick: string,
  args: string[],
  cfg: PluginConfig,
): Promise<void> {
  // args: [id, url, #channel, interval?]
  if (args.length < 3) {
    api.notice(nick, 'Usage: !rss add <id> <url> <#channel> [interval]');
    return;
  }

  const [id, url, channel] = args;
  const interval = args[3] ? parseInt(args[3], 10) : 3600;

  if (activeFeeds.has(id)) {
    api.notice(nick, `Feed "${id}" already exists.`);
    return;
  }

  if (!channel.startsWith('#')) {
    api.notice(nick, `Channel must start with #.`);
    return;
  }

  if (Number.isNaN(interval) || interval < 60) {
    api.notice(nick, 'Interval must be a number >= 60 seconds.');
    return;
  }

  const feed: FeedConfig = { id, url, channels: [channel], interval };
  saveRuntimeFeed(api, feed);
  activeFeeds.set(id, feed);

  // Silent seed
  try {
    await pollFeed(api, feed, cfg, false);
    api.notice(nick, `Feed "${id}" added and seeded. Will announce new items to ${channel}.`);
  } catch (err) {
    api.notice(nick, `Feed "${id}" added but initial fetch failed: ${(err as Error).message}`);
  }
}

function handleRemove(api: PluginAPI, nick: string, id: string | undefined): void {
  if (!id) {
    api.notice(nick, 'Usage: !rss remove <id>');
    return;
  }

  if (!activeFeeds.has(id)) {
    api.notice(nick, `Feed "${id}" not found.`);
    return;
  }

  if (!isRuntimeFeed(api, id)) {
    api.notice(nick, `Feed "${id}" is defined in config — remove it from plugins.json instead.`);
    return;
  }

  deleteRuntimeFeed(api, id);
  activeFeeds.delete(id);
  api.notice(nick, `Feed "${id}" removed.`);
}

async function handleCheck(
  api: PluginAPI,
  nick: string,
  id: string | undefined,
  cfg: PluginConfig,
): Promise<void> {
  const targets = id
    ? ([activeFeeds.get(id)].filter(Boolean) as FeedConfig[])
    : [...activeFeeds.values()];

  if (targets.length === 0) {
    api.notice(nick, id ? `Feed "${id}" not found.` : 'No feeds configured.');
    return;
  }

  let totalNew = 0;
  for (const feed of targets) {
    try {
      const items = await pollFeed(api, feed, cfg, true);
      if (items.length > 0) {
        await announceItems(api, feed, items, cfg);
        totalNew += items.length;
      }
    } catch (err) {
      api.notice(nick, `Error checking "${feed.id}": ${(err as Error).message}`);
    }
  }

  api.notice(nick, `Check complete — ${totalNew} new item(s) across ${targets.length} feed(s).`);
}
