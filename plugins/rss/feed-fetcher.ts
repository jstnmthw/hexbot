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

export const DEFAULT_MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REDIRECTS = 5;
const DOCTYPE_SCAN_WINDOW = 4096;
/** Hard wall-clock cap as a multiple of the socket inactivity timeout. */
const WALL_CLOCK_MULTIPLIER = 3;

export interface FetchFeedOpts {
  timeoutMs: number;
  maxBytes?: number;
  allowHttp?: boolean;
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

export async function pollFeed(
  api: PluginAPI,
  parser: Parser,
  feed: FeedConfig,
  mode: PollMode,
  maxPerPoll: number,
  fetchOpts: FetchFeedOpts,
): Promise<FeedItem[]> {
  const xml = await httpLayer.fetchFeedXml(feed.url, fetchOpts);
  const result = await parser.parseString(xml);
  const newItems: FeedItem[] = [];
  let previewCaptured = false;

  for (const item of result.items) {
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
 * public IP during validation and a private IP during fetch. See the
 * earlier audit at docs/audits/rss-2026-04-14.md for the full write-up.
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
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const validated = await validateFeedUrl(currentUrl, { allowHttp: opts.allowHttp });
    const result = await doRequest(
      validated.url,
      validated.resolvedAddresses,
      opts.timeoutMs,
      maxBytes,
    );
    if (result.kind === 'body') return result.body;
    if (redirect === MAX_REDIRECTS) {
      throw new Error(`too many redirects fetching ${url}`);
    }
    currentUrl = new URL(result.location, validated.url).toString();
  }
  // Unreachable — the loop above either returns a body, throws, or enters
  // another iteration. The explicit throw keeps TypeScript's control flow
  // analysis happy.
  /* v8 ignore next */
  throw new Error(`too many redirects fetching ${url}`);
}

type FetchResult = { kind: 'body'; body: string } | { kind: 'redirect'; location: string };

function doRequest(
  target: URL,
  resolvedAddresses: ResolvedAddress[],
  timeoutMs: number,
  maxBytes: number,
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

    const cleanup = () => clearTimeout(wallClockTimer);
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
        if (contentType && !/xml|rss|atom|text/.test(contentType)) {
          res.resume();
          rejectOnce(new Error(`unexpected content-type: ${contentType}`));
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

function containsDoctype(body: string): boolean {
  // Scan only the first few KiB: DOCTYPE declarations must appear in the XML
  // prolog before any element, so a scan window covers every legitimate
  // position and keeps the check cheap on large bodies.
  return /<!DOCTYPE/i.test(body.slice(0, DOCTYPE_SCAN_WINDOW));
}
/* v8 ignore stop */
