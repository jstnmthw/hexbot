// rss — feed fetching + dedup-aware poll loop
//
// Wraps rss-parser with the plugin's dedup semantics. Each call marks any
// newly-seen items as seen in the KV store (via feed-store) and returns
// whichever subset the caller asked for based on `mode`.
//
// Fetching is deliberately NOT delegated to `parser.parseURL`: we own the
// HTTP path so we can enforce the URL allowlist on every redirect, cap the
// response body, refuse XML DOCTYPE declarations (billion-laughs defense),
// and validate the Content-Type before handing anything to xml2js.
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
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
import { type ResolvedAddress, validateFeedUrl } from './url-validator';

/**
 * Narrow custom-field shape so `result.items` doesn't widen to `any`. The
 * plugin does not register any custom RSS fields, so an empty record is
 * the tightest possible generic.
 */
type RssCustomFields = Record<string, never>;
type RssParser = Parser<RssCustomFields, RssCustomFields>;

/** Default response body cap. 5 MiB is several orders of magnitude above
 *  any real-world RSS/Atom feed; existing as a safety net against runaway
 *  responses, slow-loris drips, and intentionally-oversized payloads. */
export const DEFAULT_MAX_FEED_BYTES = 5 * 1024 * 1024;
/** Maximum redirect hops we will follow before giving up. Each hop is
 *  re-validated through `validateFeedUrl`, so a chain of 5 still requires
 *  5 successful SSRF checks. */
const MAX_REDIRECTS = 5;
/** Bytes from the start of the body that {@link containsDoctype} scans.
 *  4 KiB easily covers the XML prolog where DOCTYPE declarations are
 *  legal; bytes past that are element content and can't legally
 *  re-introduce a DOCTYPE. */
const DOCTYPE_SCAN_WINDOW = 4096;
/** Hard wall-clock cap as a multiple of the socket inactivity timeout.
 *  3× lets a legitimately slow server complete while still bounding the
 *  total time a single fetch can hold a socket and the plugin's abort
 *  signal listener. */
const WALL_CLOCK_MULTIPLIER = 3;

export interface FetchFeedOpts {
  timeoutMs: number;
  maxBytes?: number;
  allowHttp?: boolean;
  /**
   * External abort signal — callers (the plugin `teardown`) forward a
   * module-level signal through so an in-flight fetch is interrupted
   * when the plugin is unloaded or reloaded. Composed with the
   * internal wall-clock timer inside {@link doRequest}.
   */
  signal?: AbortSignal;
}

/**
 * Mutable fetcher hook so tests can replace the network layer with a fake
 * without patching the rss-parser import.
 */
export const httpLayer = {
  fetchFeedXml,
};

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

/**
 * Fetch and parse one feed, mark every observed item as seen, and return
 * the subset selected by `mode` (see {@link PollMode}). Aborts if the
 * caller's `fetchOpts.signal` is already triggered or fires partway through.
 *
 * @param maxPerPoll - In `'announce'` mode, hard cap on returned items so a
 *   feed that posts 200 articles in one batch doesn't dump them all at once.
 * @returns The items selected for announcement (possibly empty).
 */
export async function pollFeed(
  api: PluginAPI,
  parser: RssParser,
  feed: FeedConfig,
  mode: PollMode,
  maxPerPoll: number,
  fetchOpts: FetchFeedOpts,
): Promise<FeedItem[]> {
  if (fetchOpts.signal?.aborted) throw new Error('rss poll aborted');
  const xml = await httpLayer.fetchFeedXml(feed.url, fetchOpts);
  if (fetchOpts.signal?.aborted) throw new Error('rss poll aborted');
  const result = await parser.parseString(xml);
  const newItems: FeedItem[] = [];
  let previewCaptured = false;

  for (const parsed of result.items) {
    // Project down to the plugin's FeedItem shape so downstream callers
    // never see the wider `Parser.Item & RssCustomFields` union.
    const item: FeedItem = {
      guid: parsed.guid,
      title: parsed.title,
      link: parsed.link,
    };
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

/**
 * Fetch feed XML over HTTP(S) with strict SSRF, size, and entity guards.
 *
 * Each redirect is re-validated against the URL allowlist so a public host
 * cannot 302 the bot into a private range. The socket `lookup` is pinned to
 * the validator's DNS result — Node's Agent would otherwise do its own
 * `dns.lookup` on connect, which lets a rebinding DNS server return a
 * public IP during validation and a private IP during fetch (TOCTOU).
 *
 * NOTE: Tests replace `httpLayer.fetchFeedXml` with a stub, so this real
 * implementation is never driven by the unit suite — the URL validator
 * has its own test file, and the HTTP wiring here is thin enough that
 * integration coverage is the right layer for it.
 */
/* v8 ignore start -- real-socket HTTP path; exercised only in integration */
export async function fetchFeedXml(url: string, opts: FetchFeedOpts): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FEED_BYTES;
  let currentUrl = url;
  // Track URLs we've already requested in this redirect chain. A deliberate
  // 301 loop (A → B → A → B ...) would otherwise burn the full MAX_REDIRECTS
  // budget for no new network fetches; refuse on revisit so the failure is
  // deterministic. See audit 2026-04-24.
  const visited = new Set<string>();
  for (let redirect = 0; redirect < MAX_REDIRECTS; redirect++) {
    if (opts.signal?.aborted) throw new Error('rss fetch aborted');
    const validated = await validateFeedUrl(currentUrl, { allowHttp: opts.allowHttp });
    if (visited.has(validated.url.toString())) {
      throw new Error(`redirect loop detected at ${validated.url.toString()}`);
    }
    visited.add(validated.url.toString());
    const previousProtocol = validated.url.protocol;
    const result = await doRequest(
      validated.url,
      validated.resolvedAddresses,
      opts.timeoutMs,
      maxBytes,
      opts.signal,
    );
    if (result.kind === 'body') return result.body;
    const nextUrl = new URL(result.location, validated.url);
    // Refuse https:→http: downgrade on redirect even when `allow_http=true` is
    // set — the config flag is for operators who explicitly want an HTTP-only
    // feed, not for a server to silently downgrade an HTTPS fetch mid-chain.
    // A downgrade there lets a passive MITM on the redirected hop inject
    // arbitrary feed XML. See audit 2026-04-24.
    if (previousProtocol === 'https:' && nextUrl.protocol === 'http:') {
      throw new Error(`refused https→http downgrade on redirect to ${nextUrl.toString()}`);
    }
    currentUrl = nextUrl.toString();
  }
  throw new Error(`too many redirects fetching ${url}`);
}

/** Outcome of one HTTP request: either a fully-read body or a single redirect
 *  hop the caller must re-validate. */
type FetchResult = { kind: 'body'; body: string } | { kind: 'redirect'; location: string };

/**
 * Perform a single HTTP(S) GET with the IP pinned to the validator's
 * resolved address. Returns either the response body or the next URL to
 * follow on a 3xx — the caller (fetchFeedXml) re-validates that URL before
 * issuing the next hop. Rejects on non-2xx/3xx, body cap exceeded, DOCTYPE
 * present, content-type not in the XML allowlist, socket inactivity past
 * `timeoutMs`, or wall-clock past 3× `timeoutMs`.
 */
function doRequest(
  target: URL,
  resolvedAddresses: ResolvedAddress[],
  timeoutMs: number,
  maxBytes: number,
  externalSignal?: AbortSignal,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    // Pin the socket to the validator's first resolved address. Node's
    // http.Agent accepts a `lookup` option and forwards it through to
    // `net.connect` — so the hostname on the URL is used for TLS SNI and
    // the Host header, but the TCP connect always goes to the validated
    // IP. Multi-address failover is not a feature we currently offer: if
    // the first IP is down the fetch fails and the next poll tries again.
    const pinned = resolvedAddresses[0];
    const pinnedLookup: LookupFunction = (_hostname, _options, cb) => {
      cb(null, pinned.address, pinned.family);
    };

    // Wall-clock deadline. `timeout` on http.get is inactivity-only — a
    // slow-drip server that sends a byte every (timeoutMs - 1ms) can hold
    // the connection open until maxBytes, which at default config is
    // hundreds of days. The AbortController fires a hard cap at 3× the
    // inactivity timeout so legitimately slow servers still complete.
    const abort = new AbortController();
    const wallClockMs = timeoutMs * WALL_CLOCK_MULTIPLIER;
    const wallClockTimer = setTimeout(() => {
      abort.abort(new Error(`request wall-clock timeout after ${wallClockMs}ms`));
    }, wallClockMs);

    // Forward the plugin-level abort signal into the internal AbortController
    // so teardown mid-fetch tears the socket down immediately, rather than
    // waiting the full wall-clock timeout.
    let externalHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abort.abort(externalSignal.reason ?? new Error('rss fetch aborted'));
      } else {
        externalHandler = () => {
          abort.abort(externalSignal.reason ?? new Error('rss fetch aborted'));
        };
        externalSignal.addEventListener('abort', externalHandler, { once: true });
      }
    }

    const cleanup = () => {
      clearTimeout(wallClockTimer);
      if (externalSignal && externalHandler) {
        externalSignal.removeEventListener('abort', externalHandler);
      }
    };
    const resolveOnce = (value: FetchResult) => {
      cleanup();
      resolve(value);
    };
    const rejectOnce = (err: Error) => {
      cleanup();
      reject(err);
    };

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(
      target,
      {
        timeout: timeoutMs,
        lookup: pinnedLookup,
        signal: abort.signal,
        headers: {
          'user-agent': 'hexbot-rss/1.0',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            rejectOnce(new Error(`HTTP ${status} without Location header`));
            return;
          }
          resolveOnce({ kind: 'redirect', location });
          return;
        }
        if (status !== 200) {
          res.resume();
          rejectOnce(new Error(`HTTP ${status}`));
          return;
        }
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        // Explicit allowlist — the previous substring match included
        // `text/html` and `text/plain` via the bare `text` alternation,
        // which let a misconfigured upstream funnel HTML responses into
        // the XML parser. A missing Content-Type is also rejected (prior
        // code short-circuited past the check when the header was absent).
        // See audit 2026-04-24.
        const mediaType = contentType.split(';', 1)[0].trim();
        const allowedContentTypes = new Set([
          'application/rss+xml',
          'application/atom+xml',
          'application/xml',
          'text/xml',
        ]);
        if (!allowedContentTypes.has(mediaType)) {
          res.resume();
          rejectOnce(new Error(`unexpected content-type: ${contentType || '(missing)'}`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error(`response body exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (containsDoctype(body)) {
            rejectOnce(new Error('XML DOCTYPE not allowed (billion-laughs defense)'));
            return;
          }
          resolveOnce({ kind: 'body', body });
        });
        res.on('error', rejectOnce);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on('error', rejectOnce);
  });
}

/**
 * True if the body contains an XML DOCTYPE declaration. We refuse any
 * such body: a DOCTYPE can pull in external entities or define billion-laughs
 * style entity expansion, both of which the rss-parser's xml2js backend
 * has historically been vulnerable to.
 */
function containsDoctype(body: string): boolean {
  // Scan only the first few KiB: DOCTYPE declarations must appear in the XML
  // prolog before any element, so a scan window covers every legitimate
  // position and keeps the check cheap on large bodies.
  return /<!DOCTYPE/i.test(body.slice(0, DOCTYPE_SCAN_WINDOW));
}
/* v8 ignore stop */
