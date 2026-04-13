// rss — RSS/Atom feed announcer plugin
// Polls configured feeds and announces new items to IRC channels.
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';

import type { ChannelHandlerContext, PluginAPI } from '../../src/types';

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
      await pollFeed(api, feed, cfg, 'silent');
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
        const items = await pollFeed(api, feed, cfg, 'announce');
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
    logCmd(api, ctx, sub || '(empty)', 'attempt');

    if (sub === 'list') {
      handleList(api, ctx);
    } else if (sub === 'add') {
      await handleAdd(api, ctx, parts.slice(1), cfg);
    } else if (sub === 'remove') {
      handleRemove(api, ctx, parts[1]);
    } else if (sub === 'check') {
      // check only requires 'o' — but the bind requires 'm', so we also
      // allow it through. Operators who don't have 'm' can't reach the bind
      // at all, but we keep the distinction documented for future loosening.
      await handleCheck(api, ctx, parts[1], cfg);
    } else {
      api.notice(ctx.nick, 'Usage: !rss <list|add|remove|check>');
      logCmd(api, ctx, sub || '(empty)', 'rejected', 'unknown subcommand');
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
        '!rss add <id> <url> [#channel] [interval] — add a feed at runtime; channel defaults to the one you ran this command in',
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

/**
 * Poll modes:
 * - 'silent'      — mark every current item seen, announce nothing. Used on
 *                   bot startup so config-file feeds don't replay on reboot.
 * - 'announce'    — return up to max_per_poll unseen items. Used by the
 *                   regular timer tick and by `!rss check`.
 * - 'seedPreview' — mark every current item seen (like 'silent'), but return
 *                   only the newest one so `!rss add` can post a single
 *                   instant-feedback preview.
 */
type PollMode = 'silent' | 'announce' | 'seedPreview';

async function pollFeed(
  api: PluginAPI,
  feed: FeedConfig,
  config: PluginConfig,
  mode: PollMode,
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
      if (newItems.length >= config.max_per_poll) break;
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

// ---------------------------------------------------------------------------
// Formatting and announcing
// ---------------------------------------------------------------------------

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

export function formatItem(feed: FeedConfig, item: FeedItem, config: PluginConfig): string {
  const feedName = feed.name ?? feed.id;
  let title = stripHtmlTags(item.title ?? '').trim();
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

  api.log(`Announced ${items.length} item(s) from "${feed.id}" to ${feed.channels.join(', ')}`);
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

type CmdOutcome = 'attempt' | 'rejected' | 'ok';

// Successes log at info, attempts and rejections at debug. Debug keeps
// per-invocation noise out of the default log stream but preserves the full
// audit trail when the operator flips the level during an incident.
function logCmd(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  sub: string,
  outcome: CmdOutcome,
  detail?: string,
): void {
  const who = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
  const msg = `!rss ${sub} by ${who} in ${ctx.channel} — ${outcome}${detail ? `: ${detail}` : ''}`;
  if (outcome === 'ok') api.log(msg);
  else api.debug(msg);
}

function handleList(api: PluginAPI, ctx: ChannelHandlerContext): void {
  if (activeFeeds.size === 0) {
    api.notice(ctx.nick, 'No feeds configured.');
    logCmd(api, ctx, 'list', 'ok', '0 feeds');
    return;
  }
  api.notice(ctx.nick, `Active feeds (${activeFeeds.size}):`);
  for (const feed of activeFeeds.values()) {
    const interval = feed.interval ?? 3600;
    const channels = feed.channels.join(', ');
    const source = isRuntimeFeed(api, feed.id) ? 'runtime' : 'config';
    api.notice(
      ctx.nick,
      `  ${feed.id} — ${feed.url} → ${channels} (every ${interval}s) [${source}]`,
    );
  }
  logCmd(api, ctx, 'list', 'ok', `${activeFeeds.size} feeds`);
}

async function handleAdd(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  args: string[],
  cfg: PluginConfig,
): Promise<void> {
  // Grammar: !rss add <id> <url> [#channel] [interval]
  // Both trailing args are optional and distinguished by prefix:
  //   '#'-prefixed token → channel (falls back to invoking channel)
  //   anything else      → interval (digits validated below)
  // If this command ever gains a msg/REPL path, channel must become
  // mandatory in that context since ctx.channel would be null.
  if (args.length < 2) {
    api.notice(ctx.nick, 'Usage: !rss add <id> <url> [#channel] [interval]');
    logCmd(api, ctx, 'add', 'rejected', 'bad usage');
    return;
  }

  const [id, url] = args;

  let channel: string | undefined;
  let intervalStr: string | undefined;
  for (const tok of args.slice(2)) {
    if (tok.startsWith('#')) {
      channel = tok;
    } else {
      intervalStr = tok;
    }
  }
  if (!channel) channel = ctx.channel;
  const interval = intervalStr ? parseInt(intervalStr, 10) : 3600;

  if (activeFeeds.has(id)) {
    api.notice(ctx.nick, `Feed "${id}" already exists.`);
    logCmd(api, ctx, 'add', 'rejected', `id collision: ${id}`);
    return;
  }

  if (Number.isNaN(interval) || interval < 60) {
    api.notice(ctx.nick, 'Interval must be a number >= 60 seconds.');
    logCmd(api, ctx, 'add', 'rejected', 'bad interval');
    return;
  }

  const feed: FeedConfig = { id, url, channels: [channel], interval };
  saveRuntimeFeed(api, feed);
  activeFeeds.set(id, feed);
  api.audit.log('rss-feed-add', {
    channel,
    target: id,
    reason: url,
    metadata: { interval },
  });

  // Seed every current item as seen, and return the newest as a one-shot
  // preview so the admin gets instant confirmation the feed is working.
  try {
    const preview = await pollFeed(api, feed, cfg, 'seedPreview');
    if (preview.length > 0) {
      await announceItems(api, feed, preview, cfg);
      api.notice(
        ctx.nick,
        `Feed "${id}" added. Posted latest article to ${channel} as preview; future items will announce automatically.`,
      );
    } else {
      api.notice(
        ctx.nick,
        `Feed "${id}" added (no items in feed yet). Future items will announce to ${channel}.`,
      );
    }
    logCmd(api, ctx, 'add', 'ok', `id=${id} url=${url} chan=${channel} interval=${interval}s`);
  } catch (err) {
    const errMsg = (err as Error).message;
    api.notice(ctx.nick, `Feed "${id}" added but initial fetch failed: ${errMsg}`);
    logCmd(api, ctx, 'add', 'ok', `id=${id} (seed failed: ${errMsg})`);
  }
}

function handleRemove(api: PluginAPI, ctx: ChannelHandlerContext, id: string | undefined): void {
  if (!id) {
    api.notice(ctx.nick, 'Usage: !rss remove <id>');
    logCmd(api, ctx, 'remove', 'rejected', 'bad usage');
    return;
  }

  if (!activeFeeds.has(id)) {
    api.notice(ctx.nick, `Feed "${id}" not found.`);
    logCmd(api, ctx, 'remove', 'rejected', `unknown id: ${id}`);
    return;
  }

  if (!isRuntimeFeed(api, id)) {
    api.notice(
      ctx.nick,
      `Feed "${id}" is defined in config — remove it from plugins.json instead.`,
    );
    logCmd(api, ctx, 'remove', 'rejected', `config-defined: ${id}`);
    return;
  }

  deleteRuntimeFeed(api, id);
  activeFeeds.delete(id);
  api.notice(ctx.nick, `Feed "${id}" removed.`);
  logCmd(api, ctx, 'remove', 'ok', `id=${id}`);
  api.audit.log('rss-feed-remove', { channel: ctx.channel, target: id });
}

async function handleCheck(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  id: string | undefined,
  cfg: PluginConfig,
): Promise<void> {
  const targets = id
    ? ([activeFeeds.get(id)].filter(Boolean) as FeedConfig[])
    : [...activeFeeds.values()];

  if (targets.length === 0) {
    api.notice(ctx.nick, id ? `Feed "${id}" not found.` : 'No feeds configured.');
    logCmd(api, ctx, 'check', 'rejected', id ? `unknown id: ${id}` : 'no feeds');
    return;
  }

  let totalNew = 0;
  for (const feed of targets) {
    try {
      const items = await pollFeed(api, feed, cfg, 'announce');
      if (items.length > 0) {
        await announceItems(api, feed, items, cfg);
        totalNew += items.length;
      }
    } catch (err) {
      api.notice(ctx.nick, `Error checking "${feed.id}": ${(err as Error).message}`);
      api.error(`Error checking feed "${feed.id}":`, (err as Error).message);
    }
  }

  api.notice(
    ctx.nick,
    `Check complete — ${totalNew} new item(s) across ${targets.length} feed(s).`,
  );
  logCmd(api, ctx, 'check', 'ok', `${targets.length} feed(s), ${totalNew} new item(s)`);
}
