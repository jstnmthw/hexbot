// rss — RSS/Atom feed announcer plugin
// Polls configured feeds and announces new items to IRC channels.
import Parser from 'rss-parser';

import type { PluginAPI } from '../../src/types';
import { CircuitBreaker } from './circuit-breaker';
import {
  type RssCommandsConfig,
  type RssCommandsDeps,
  handleAdd,
  handleCheck,
  handleList,
  handleRemove,
  logCmd,
} from './commands';
import { type FetchFeedOpts, pollFeed } from './feed-fetcher';
import { announceItems } from './feed-formatter';
import {
  type FeedConfig,
  cleanupSeen,
  getLastPoll,
  isFeedConfig,
  loadRuntimeFeeds,
} from './feed-store';

// Re-export for tests that still import from the plugin root.
export { hashItem } from './feed-store';
export { stripHtmlTags, formatItem } from './feed-formatter';

/**
 * Plugin-internal config, loaded by {@link loadConfig}. Extends the
 * operator-facing `RssCommandsConfig` with the static feed list from
 * plugins.json (runtime-added feeds are loaded separately from the KV store).
 */
interface RssPluginConfig extends RssCommandsConfig {
  feeds: FeedConfig[];
}

/**
 * Project the runtime config into the {@link FetchFeedOpts} shape the
 * fetcher consumes. Reads the live `abortController.signal` so a teardown
 * after this call still aborts in-flight requests.
 */
function fetchOptsFor(cfg: RssPluginConfig): FetchFeedOpts {
  return {
    timeoutMs: cfg.request_timeout_ms,
    maxBytes: cfg.max_feed_bytes,
    allowHttp: cfg.allow_http,
    signal: abortController?.signal,
  };
}

/**
 * Narrow an unknown value to `Error` so we can read `.message` safely.
 * Strips control bytes to prevent IRC formatting / ANSI injection via a
 * persisted feed URL that surfaces in an error path.
 */
function errorMessage(err: unknown): string {
  /* v8 ignore next -- defensive: tests always throw Error instances */
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex -- IRC formatting + ANSI
  return raw.replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Deterministic per-feed millisecond offset within `intervalMs`. djb2 hash
 * keeps the calculation stable across reloads (same feed id → same offset)
 * and cheap (no crypto). Used to stagger the first announce poll so a
 * batch of feeds added in one operator session don't tick on the same
 * boundary every interval.
 */
function feedOffsetMs(id: string, intervalMs: number): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  return Math.abs(hash) % Math.max(1, intervalMs);
}

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

export const name = 'rss';
export const version = '1.0.0';
export const description = 'Polls RSS/Atom feeds and announces new items to configured channels';

// Mutable feed map: merged config + runtime feeds. Keyed by feed id.
// On id collision, plugins.json config wins (see init's merge loop) — a
// runtime `!rss add` for an id already in config is rejected by handleAdd.
let activeFeeds = new Map<string, FeedConfig>();
// Parametrize the parser to an empty extension so its `Item` type stays
// narrow — the default generic widens custom fields to `any`, contaminating
// every downstream `result.items` read.
type RssCustomFields = Record<string, never>;
/**
 * Parser instances are cheap — construct a fresh one per fetch so
 * the active `request_timeout_ms` is always the live config value
 * rather than a frozen load-time snapshot. The rss-parser instance
 * caches the timeout in its constructor, so sharing one across
 * polls meant a mid-session `.set timeout ...` would be ignored.
 */
function makeParser(timeoutMs: number): Parser<RssCustomFields, RssCustomFields> {
  return new Parser<RssCustomFields, RssCustomFields>({ timeout: timeoutMs });
}
let parser: Parser<RssCustomFields, RssCustomFields>;
/**
 * Module-level abort signal. Aborted in {@link teardown} so any in-flight
 * HTTP fetch or drip-fed announce loop that outlives the plugin module
 * (e.g. a 30s wall-clock timer still mid-flight) stops touching the
 * torn-down `api` reference.
 */
let abortController: AbortController | null = null;

/**
 * Per-feed poll-in-progress guard. Without this, a feed that takes
 * longer than the 60s tick (slow upstream, large body, stuck DNS)
 * gets a second concurrent invocation on the next tick, racing on
 * setLastPoll and potentially double-announcing items. Keyed by
 * feed id.
 */
const activePolls = new Set<string>();

/** Per-feed circuit breaker for chronically failing feeds. */
const circuitBreaker = new CircuitBreaker();

export async function init(api: PluginAPI): Promise<void> {
  const cfg = loadConfig(api);
  abortController = new AbortController();
  parser = makeParser(cfg.request_timeout_ms);

  // Merge config-file feeds with runtime-added feeds from KV
  activeFeeds = new Map<string, FeedConfig>();
  for (const feed of cfg.feeds) activeFeeds.set(feed.id, feed);
  for (const feed of loadRuntimeFeeds(api)) {
    if (!activeFeeds.has(feed.id)) activeFeeds.set(feed.id, feed);
  }

  const fetchOpts = fetchOptsFor(cfg);

  // Silent first-run seeding: mark all existing items as seen without announcing.
  // Gated on `getLastPoll === 0` (feed has never been polled) so a restart
  // doesn't silently absorb items that were published between boots and
  // doesn't re-stamp lastPoll to now (which would defer the next announce
  // poll by a full interval). Previously-announced items are already
  // filtered by the `hasSeen` dedup check in pollFeed, so we don't need
  // another pass here to prevent replay on reload.
  for (const feed of activeFeeds.values()) {
    if (getLastPoll(api, feed.id) > 0) continue;
    try {
      await pollFeed(api, parser, feed, 'silent', cfg.max_per_poll, fetchOpts);
    } catch (err) {
      api.error(`Error seeding feed "${feed.id}":`, errorMessage(err));
    }
  }

  // Track whether each feed has done at least one announce poll since
  // init. Until then, the eligibility test uses the per-feed `offset`
  // rather than the full interval so sibling feeds drift apart. Once a
  // feed polls, its `lastPoll` timestamp diverges naturally and the
  // regular `now - lastPoll >= interval` cadence preserves the stagger.
  const firstPollDone = new Set<string>();
  // Single 60s time bind — checks which feeds are due on each tick.
  //
  // Guards:
  //  1. Per-feed in-progress lock so a slow feed cannot be polled twice
  //     concurrently. Races on setLastPoll and duplicate announces.
  //  2. Per-feed circuit breaker so a chronically failing feed (bad DNS,
  //     500 for a week) doesn't flood the log stream. After N
  //     consecutive failures, the next attempt is deferred with
  //     exponential backoff.
  //  3. Deterministic per-feed offset so feeds with the same interval
  //     don't all tick on the same boundary. Adding 10 hourly feeds at
  //     once would otherwise produce a 10-feed concurrent fetch every
  //     hour on the dot — same DNS, same upstream, same announce burst
  //     on IRC. The offset is derived from the feed id so it stays
  //     stable across reloads, and only applies until the first
  //     announce poll runs.
  api.bind('time', '-', '60', async () => {
    const now = Date.now();
    for (const feed of activeFeeds.values()) {
      const lastPoll = getLastPoll(api, feed.id);
      const interval = (feed.interval ?? 3600) * 1000;
      // First-announce-poll stagger: require `offset` ms (a deterministic
      // value in `[0, interval)`) of elapsed time instead of the full
      // interval. Two feeds with the same interval but different ids
      // become eligible at different points within the first interval,
      // so their lastPoll timestamps diverge once they actually fire.
      // After the first poll the natural `lastPoll + interval` rule
      // preserves the stagger.
      const required = firstPollDone.has(feed.id) ? interval : feedOffsetMs(feed.id, interval);
      if (now - lastPoll < required) continue;
      if (activePolls.has(feed.id)) {
        api.debug(`Skipping tick for "${feed.id}" — previous poll still in flight`);
        continue;
      }
      if (circuitBreaker.isOpen(feed.id, now)) continue;

      activePolls.add(feed.id);
      const startMs = Date.now();
      try {
        const items = await pollFeed(api, parser, feed, 'announce', cfg.max_per_poll, fetchOpts);
        circuitBreaker.recordSuccess(feed.id);
        // Drop the offset gate after the first announce poll lands —
        // subsequent ticks fall through to the `now - lastPoll < interval`
        // path, which is naturally staggered now that lastPoll has
        // diverged across feeds.
        firstPollDone.add(feed.id);
        const elapsed = Date.now() - startMs;
        api.log(`Polled "${feed.id}" — ${items.length} new item(s) in ${elapsed}ms`);
        if (items.length > 0) {
          await announceItems(api, feed, items, cfg.max_title_length, abortController?.signal);
        }
      } catch (err) {
        api.error(`Error polling feed "${feed.id}" (${feed.url}):`, errorMessage(err));
        circuitBreaker.recordFailure(api, feed.id);
      } finally {
        activePolls.delete(feed.id);
      }
    }
  });

  // Daily cleanup of stale dedup entries. Hourly would burn DB scans for
  // little gain — dedup entries don't need fine-grained pruning, only a
  // bounded ceiling. The per-feed MAX_SEEN_PER_FEED cap in feed-store
  // handles the high-volume case in real time.
  api.bind('time', '-', '86400', () => {
    cleanupSeen(api, cfg.dedup_window_days);
  });

  // Admin commands — routed through commands.ts so this file stays a
  // thin lifecycle owner (feed map, parser, abort signal, timers).
  const deps: RssCommandsDeps = {
    api,
    activeFeeds,
    parser,
    cfg,
    abortSignal: () => abortController?.signal,
    circuitBreaker,
  };
  api.bind('pub', 'm', '!rss', async (ctx) => {
    const parts = ctx.args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? '';
    logCmd(api, ctx, sub || '(empty)', 'attempt');

    if (sub === 'list') {
      handleList(deps, ctx);
    } else if (sub === 'add') {
      await handleAdd(deps, ctx, parts.slice(1));
    } else if (sub === 'remove') {
      handleRemove(deps, ctx, parts[1]);
    } else if (sub === 'check') {
      await handleCheck(deps, ctx, parts[1]);
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
  // Order matters: abort BEFORE clearing the maps so any in-flight fetch
  // that's about to call back into the plugin sees the abort signal
  // first and bails — clearing `activeFeeds` first would let a late
  // `pollFeed` return an empty announce list and then race against
  // `activeFeeds.clear()` while iterating channels.
  //
  // Abort any in-flight HTTP fetch or drip-fed announce loop before we
  // drop the `activeFeeds` reference. Without this a still-pending
  // wall-clock timer in feed-fetcher would keep calling through to
  // the torn-down `api`.
  abortController?.abort(new Error('rss plugin torn down'));
  abortController = null;
  activeFeeds.clear();
  activePolls.clear();
  circuitBreaker.reset();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Read the operator config and apply per-key fallbacks. Invalid feed
 *  entries are silently dropped via {@link isFeedConfig}. The `feeds`
 *  array stays in `bootConfig` (deeply-structured per-feed records);
 *  scalar tunables move to typed `api.settings` so operators can change
 *  them via `.set rss <key> <value>` without restarting. */
function loadConfig(api: PluginAPI): RssPluginConfig {
  api.settings.register([
    {
      key: 'dedup_window_days',
      type: 'int',
      default: 30,
      description: 'Drop dedup entries older than this many days',
    },
    {
      key: 'max_title_length',
      type: 'int',
      default: 300,
      description: 'Truncate feed item titles after this many characters',
    },
    {
      key: 'request_timeout_ms',
      type: 'int',
      default: 10_000,
      description: 'HTTP timeout for a single feed fetch (ms)',
    },
    {
      key: 'max_per_poll',
      type: 'int',
      default: 5,
      description: 'Maximum new items announced per feed per poll',
    },
    {
      key: 'max_feed_bytes',
      type: 'int',
      default: 5 * 1024 * 1024,
      description: 'Maximum feed body size accepted (bytes)',
    },
    {
      key: 'allow_http',
      type: 'flag',
      default: false,
      description: 'Permit unencrypted http:// feed URLs (https-only when false)',
    },
    {
      key: 'max_feeds',
      type: 'int',
      default: 100,
      description: 'Hard cap on the number of active feeds — `!rss add` refuses past this',
    },
  ]);
  const rawFeeds = api.settings.bootConfig.feeds;
  const feeds: FeedConfig[] = Array.isArray(rawFeeds) ? rawFeeds.filter(isFeedConfig) : [];
  const intOr = (key: string, fallback: number): number =>
    api.settings.isSet(key) ? api.settings.getInt(key) : fallback;
  return {
    feeds,
    dedup_window_days: intOr('dedup_window_days', 30),
    max_title_length: intOr('max_title_length', 300),
    request_timeout_ms: intOr('request_timeout_ms', 10_000),
    max_per_poll: intOr('max_per_poll', 5),
    max_feed_bytes: intOr('max_feed_bytes', 5 * 1024 * 1024),
    allow_http: api.settings.getFlag('allow_http'),
    max_feeds: intOr('max_feeds', 100),
  };
}
