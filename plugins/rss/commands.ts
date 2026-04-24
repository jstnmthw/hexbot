// rss — admin command handlers (list, add, remove, check)
//
// Handles the `!rss` subcommand surface. Takes the shared feed map and
// parser from the plugin lifecycle (index.ts) as dependencies so these
// functions stay pure from the plugin's internal state machine and can
// be unit-tested with a stub Map and a mock poll function.
import type Parser from 'rss-parser';

import type { ChannelHandlerContext, PluginAPI } from '../../src/types';
import type { CircuitBreaker } from './circuit-breaker';
import { type FetchFeedOpts, pollFeed } from './feed-fetcher';
import { announceItems } from './feed-formatter';
import { type FeedConfig, deleteRuntimeFeed, isRuntimeFeed, saveRuntimeFeed } from './feed-store';
import { validateFeedUrl } from './url-validator';

/** Runtime config surface the command handlers need. Mirrors RssPluginConfig in index.ts. */
export interface RssCommandsConfig {
  dedup_window_days: number;
  max_title_length: number;
  request_timeout_ms: number;
  max_per_poll: number;
  max_feed_bytes: number;
  allow_http: boolean;
}

export interface RssCommandsDeps {
  api: PluginAPI;
  activeFeeds: Map<string, FeedConfig>;
  parser: Parser<Record<string, never>, Record<string, never>>;
  cfg: RssCommandsConfig;
  abortSignal: () => AbortSignal | undefined;
  /**
   * Per-feed circuit breaker state owned by the plugin lifecycle. Passed
   * in so `handleRemove` can drop a feed's failure tracking alongside the
   * runtime-feed DB row — without this, `!rss add X … !rss remove X …
   * !rss add X` cycles leak state forever.
   */
  circuitBreaker: CircuitBreaker;
}

type CmdOutcome = 'attempt' | 'rejected' | 'ok' | 'error';

/**
 * Narrow an unknown value to `Error` so we can read `.message` safely.
 * The message may embed operator-supplied URL bytes (e.g. validator
 * errors that quote the rejected URL), so we strip IRC formatting / ANSI
 * control bytes before returning — otherwise an attacker who persuades
 * an operator to run `!rss add <url-with-color-codes>` could inject a
 * channel-visible bold/colored line. See audit 2026-04-19.
 */
function errorMessage(err: unknown): string {
  /* v8 ignore next -- defensive: tests always throw Error instances */
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex -- IRC formatting + ANSI
  return raw.replace(/[\x00-\x1F\x7F]/g, '');
}

function fetchOptsFor(cfg: RssCommandsConfig, signal?: AbortSignal): FetchFeedOpts {
  return {
    timeoutMs: cfg.request_timeout_ms,
    maxBytes: cfg.max_feed_bytes,
    allowHttp: cfg.allow_http,
    signal,
  };
}

/**
 * Log a command invocation with outcome. Successes go to info, errors to
 * error, everything else to debug so default log streams stay quiet
 * during normal operation but audit trails remain complete after an
 * operator bumps the log level.
 */
export function logCmd(
  api: PluginAPI,
  ctx: ChannelHandlerContext,
  sub: string,
  outcome: CmdOutcome,
  detail?: string,
): void {
  const who = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
  const msg = `!rss ${sub} by ${who} in ${ctx.channel} — ${outcome}${detail ? `: ${detail}` : ''}`;
  if (outcome === 'ok') api.log(msg);
  else if (outcome === 'error') api.error(msg);
  else api.debug(msg);
}

export function handleList(deps: RssCommandsDeps, ctx: ChannelHandlerContext): void {
  const { api, activeFeeds } = deps;
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
    // Strip IRC formatting from the URL before echoing. `new URL()`
    // tolerates some control-byte characters in the path/fragment
    // components, so a feed URL added via `.load` or an older migration
    // could contain bold/colour bytes that would reshape this line when
    // rendered in the operator's client. See audit 2026-04-24.
    api.notice(
      ctx.nick,
      `  ${feed.id} — ${api.stripFormatting(feed.url)} → ${channels} (every ${interval}s) [${source}]`,
    );
  }
  logCmd(api, ctx, 'list', 'ok', `${activeFeeds.size} feeds`);
}

/**
 * Shape-validate the tokens passed to `!rss add`. Returns an object describing
 * the outcome: either a parsed `{ id, url, channel, interval }` tuple or a
 * `reject` with the notice text and a short log detail. Kept as a pure
 * function so the command handler stays a straight dispatch.
 *
 * Grammar: !rss add <id> <url> [#channel] [interval]
 * Both trailing args are optional and distinguished by prefix:
 *   '#'-prefixed token → channel (falls back to `defaultChannel`)
 *   anything else      → interval (digits validated)
 */
type AddArgsResult =
  | { ok: true; id: string; url: string; channel: string; interval: number }
  | { ok: false; notice: string; detail: string };

export function parseAddArgs(args: string[], defaultChannel: string): AddArgsResult {
  if (args.length < 2) {
    return {
      ok: false,
      notice: 'Usage: !rss add <id> <url> [#channel] [interval]',
      detail: 'bad usage',
    };
  }

  const [id, url] = args;

  // Shape guards — reject garbage before we touch the DB or the network.
  // `id` is used as a KV key and in log lines, `url` rides into http.get,
  // and `interval` sets a setTimeout; each needs to be a well-formed
  // primitive before we go any further.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    return {
      ok: false,
      notice: 'Feed id must be 1–32 chars of [A-Za-z0-9_-].',
      detail: `bad id: ${id}`,
    };
  }
  if (url.length === 0 || url.length > 2048) {
    return {
      ok: false,
      notice: 'Feed URL must be 1–2048 chars.',
      detail: 'bad url length',
    };
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
  if (!channel) channel = defaultChannel;
  // eslint-disable-next-line no-control-regex -- IRC channel names exclude BEL (0x07) per RFC 2812
  if (!/^#[^\s,\x07:]{1,49}$/.test(channel)) {
    return {
      ok: false,
      notice: `Invalid channel: "${channel}"`,
      detail: `bad channel: ${channel}`,
    };
  }
  // Strict integer parse — `parseInt("60abc")` returns 60, which silently
  // masks operator typos. Require the token to be digits-only.
  const interval = intervalStr
    ? /^\d+$/.test(intervalStr)
      ? Number(intervalStr)
      : Number.NaN
    : 3600;

  if (!Number.isInteger(interval) || interval < 60 || interval > 86400) {
    return {
      ok: false,
      notice: 'Interval must be an integer between 60 and 86400 seconds.',
      detail: 'bad interval',
    };
  }

  return { ok: true, id, url, channel, interval };
}

export async function handleAdd(
  deps: RssCommandsDeps,
  ctx: ChannelHandlerContext,
  args: string[],
): Promise<void> {
  const { api, activeFeeds, parser, cfg } = deps;
  // If this command ever gains a msg/REPL path, channel must become
  // mandatory in that context since ctx.channel would be null.
  const parsed = parseAddArgs(args, ctx.channel);
  if (!parsed.ok) {
    api.notice(ctx.nick, parsed.notice);
    logCmd(api, ctx, 'add', 'rejected', parsed.detail);
    return;
  }
  const { id, url, channel, interval } = parsed;

  if (activeFeeds.has(id)) {
    api.notice(ctx.nick, `Feed "${id}" already exists.`);
    logCmd(api, ctx, 'add', 'rejected', `id collision: ${id}`);
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
  // Strip IRC formatting from the URL before it lands in mod_log. The
  // field is scrubbed at display time by the audit writer, but stripping
  // at the source keeps the raw row byte-clean for downstream consumers
  // (exports, REPL `.audit-tail`, etc). See audit 2026-04-24.
  api.audit.log('rss-feed-add', {
    channel,
    target: id,
    reason: api.stripFormatting(url),
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
      fetchOptsFor(cfg, deps.abortSignal()),
    );
    if (preview.length > 0) {
      await announceItems(api, feed, preview, cfg.max_title_length, deps.abortSignal());
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
    // Feed is persisted regardless — the next scheduled poll will retry.
    // Log at error level so operators notice the failed seed even though
    // the user-facing notice already explains the situation.
    api.notice(ctx.nick, `Feed "${id}" added but initial fetch failed: ${errMsg}`);
    logCmd(api, ctx, 'add', 'error', `id=${id} url=${url} seed failed: ${errMsg}`);
  }
}

export function handleRemove(
  deps: RssCommandsDeps,
  ctx: ChannelHandlerContext,
  id: string | undefined,
): void {
  const { api, activeFeeds } = deps;
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
  deps.circuitBreaker.forget(id);
  api.notice(ctx.nick, `Feed "${id}" removed.`);
  logCmd(api, ctx, 'remove', 'ok', `id=${id}`);
  api.audit.log('rss-feed-remove', { channel: ctx.channel, target: id });
}

export async function handleCheck(
  deps: RssCommandsDeps,
  ctx: ChannelHandlerContext,
  id: string | undefined,
): Promise<void> {
  const { api, activeFeeds, parser, cfg } = deps;
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

  const fetchOpts = fetchOptsFor(cfg, deps.abortSignal());
  let totalNew = 0;
  for (const feed of targets) {
    try {
      const items = await pollFeed(api, parser, feed, 'announce', cfg.max_per_poll, fetchOpts);
      if (items.length > 0) {
        await announceItems(api, feed, items, cfg.max_title_length, deps.abortSignal());
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
