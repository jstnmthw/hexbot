// rss — RSS/Atom feed announcer plugin
// Polls configured feeds and announces new items to IRC channels.
import Parser from 'rss-parser';

import type { ChannelHandlerContext, PluginAPI } from '../../src/types';
import { type FetchFeedOpts, pollFeed } from './feed-fetcher';
import { announceItems } from './feed-formatter';
import {
  type FeedConfig,
  cleanupSeen,
  deleteRuntimeFeed,
  getLastPoll,
  isFeedConfig,
  isRuntimeFeed,
  loadRuntimeFeeds,
  saveRuntimeFeed,
} from './feed-store';
import { validateFeedUrl } from './url-validator';

// Re-export for tests that still import from the plugin root.
export { hashItem } from './feed-store';
export { stripHtmlTags, formatItem } from './feed-formatter';

interface RssPluginConfig {
  feeds: FeedConfig[];
  dedup_window_days: number;
  max_title_length: number;
  request_timeout_ms: number;
  max_per_poll: number;
  max_feed_bytes: number;
  allow_http: boolean;
}

function fetchOptsFor(cfg: RssPluginConfig): FetchFeedOpts {
  return {
    timeoutMs: cfg.request_timeout_ms,
    maxBytes: cfg.max_feed_bytes,
    allowHttp: cfg.allow_http,
  };
}

/** Narrow an unknown value to `Error` so we can read `.message` safely. */
function errorMessage(err: unknown): string {
  /* v8 ignore next -- defensive: tests always throw Error instances */
  return err instanceof Error ? err.message : String(err);
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

  const fetchOpts = fetchOptsFor(cfg);

  // Silent first-run seeding: mark all existing items as seen without announcing
  for (const feed of activeFeeds.values()) {
    try {
      await pollFeed(api, parser, feed, 'silent', cfg.max_per_poll, fetchOpts);
    } catch (err) {
      api.error(`Error seeding feed "${feed.id}":`, errorMessage(err));
    }
  }

  // Single 60s time bind — checks which feeds are due on each tick
  api.bind('time', '-', '60', async () => {
    for (const feed of activeFeeds.values()) {
      const lastPoll = getLastPoll(api, feed.id);
      const interval = (feed.interval ?? 3600) * 1000;
      if (Date.now() - lastPoll < interval) continue;

      try {
        const items = await pollFeed(api, parser, feed, 'announce', cfg.max_per_poll, fetchOpts);
        if (items.length > 0) {
          await announceItems(api, feed, items, cfg.max_title_length);
        }
      } catch (err) {
        api.error(`Error polling feed "${feed.id}" (${feed.url}):`, errorMessage(err));
      }
    }
  });

  // Daily cleanup of stale dedup entries
  api.bind('time', '-', '86400', () => {
    cleanupSeen(api, cfg.dedup_window_days);
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

function loadConfig(api: PluginAPI): RssPluginConfig {
  const c = api.config;
  const rawFeeds = c.feeds;
  const feeds: FeedConfig[] = Array.isArray(rawFeeds) ? rawFeeds.filter(isFeedConfig) : [];
  const numOrDefault = (key: string, fallback: number): number => {
    const v = c[key];
    return typeof v === 'number' ? v : fallback;
  };
  return {
    feeds,
    dedup_window_days: numOrDefault('dedup_window_days', 30),
    max_title_length: numOrDefault('max_title_length', 300),
    request_timeout_ms: numOrDefault('request_timeout_ms', 10000),
    max_per_poll: numOrDefault('max_per_poll', 5),
    max_feed_bytes: numOrDefault('max_feed_bytes', 5 * 1024 * 1024),
    allow_http: c.allow_http === true,
  };
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
  cfg: RssPluginConfig,
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

  // Shape guards — reject garbage before we touch the DB or the network.
  // `id` is used as a KV key and in log lines, `url` rides into http.get,
  // and `interval` sets a setTimeout; each needs to be a well-formed
  // primitive before we go any further.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    api.notice(ctx.nick, 'Feed id must be 1–32 chars of [A-Za-z0-9_-].');
    logCmd(api, ctx, 'add', 'rejected', `bad id: ${id}`);
    return;
  }
  if (url.length === 0 || url.length > 2048) {
    api.notice(ctx.nick, 'Feed URL must be 1–2048 chars.');
    logCmd(api, ctx, 'add', 'rejected', 'bad url length');
    return;
  }

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
  // eslint-disable-next-line no-control-regex -- IRC channel names exclude BEL (0x07) per RFC 2812
  if (!/^#[^\s,\x07:]{1,49}$/.test(channel)) {
    api.notice(ctx.nick, `Invalid channel: "${channel}"`);
    logCmd(api, ctx, 'add', 'rejected', `bad channel: ${channel}`);
    return;
  }
  // Strict integer parse — `parseInt("60abc")` returns 60, which silently
  // masks operator typos. Require the token to be digits-only.
  const interval = intervalStr
    ? /^\d+$/.test(intervalStr)
      ? Number(intervalStr)
      : Number.NaN
    : 3600;

  if (activeFeeds.has(id)) {
    api.notice(ctx.nick, `Feed "${id}" already exists.`);
    logCmd(api, ctx, 'add', 'rejected', `id collision: ${id}`);
    return;
  }

  if (!Number.isInteger(interval) || interval < 60 || interval > 86400) {
    api.notice(ctx.nick, 'Interval must be an integer between 60 and 86400 seconds.');
    logCmd(api, ctx, 'add', 'rejected', 'bad interval');
    return;
  }

  // SSRF guard: validate the URL (scheme, DNS-resolved IPs) before we touch
  // the DB or the network. An operator with `+m` can still submit any URL;
  // this is what keeps them from aiming the bot at cloud metadata, the
  // bot-link hub port, or internal network resources.
  try {
    await validateFeedUrl(url, { allowHttp: cfg.allow_http });
  } catch (err) {
    const msg = errorMessage(err);
    api.notice(ctx.nick, `Feed URL rejected: ${msg}`);
    logCmd(api, ctx, 'add', 'rejected', `url validation: ${msg}`);
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
    const preview = await pollFeed(
      api,
      parser,
      feed,
      'seedPreview',
      cfg.max_per_poll,
      fetchOptsFor(cfg),
    );
    if (preview.length > 0) {
      await announceItems(api, feed, preview, cfg.max_title_length);
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
    const errMsg = errorMessage(err);
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
  cfg: RssPluginConfig,
): Promise<void> {
  const targets: FeedConfig[] = id
    ? (() => {
        const f = activeFeeds.get(id);
        return f ? [f] : [];
      })()
    : [...activeFeeds.values()];

  if (targets.length === 0) {
    api.notice(ctx.nick, id ? `Feed "${id}" not found.` : 'No feeds configured.');
    logCmd(api, ctx, 'check', 'rejected', id ? `unknown id: ${id}` : 'no feeds');
    return;
  }

  const fetchOpts = fetchOptsFor(cfg);
  let totalNew = 0;
  for (const feed of targets) {
    try {
      const items = await pollFeed(api, parser, feed, 'announce', cfg.max_per_poll, fetchOpts);
      if (items.length > 0) {
        await announceItems(api, feed, items, cfg.max_title_length);
        totalNew += items.length;
      }
    } catch (err) {
      api.notice(ctx.nick, `Error checking "${feed.id}": ${errorMessage(err)}`);
      api.error(`Error checking feed "${feed.id}":`, errorMessage(err));
    }
  }

  api.notice(
    ctx.nick,
    `Check complete — ${totalNew} new item(s) across ${targets.length} feed(s).`,
  );
  logCmd(api, ctx, 'check', 'ok', `${targets.length} feed(s), ${totalNew} new item(s)`);
}
