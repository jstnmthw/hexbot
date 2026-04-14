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
import { validateFeedUrl } from './url-validator';

export const DEFAULT_MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REDIRECTS = 5;
const DOCTYPE_SCAN_WINDOW = 4096;

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
 * Each redirect is re-validated against the URL allowlist so a public host
 * cannot 302 the bot into a private range.
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
    const result = await doRequest(validated.url, opts.timeoutMs, maxBytes);
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

function doRequest(target: URL, timeoutMs: number, maxBytes: number): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(
      target,
      {
        timeout: timeoutMs,
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
            reject(new Error(`HTTP ${status} without Location header`));
            return;
          }
          resolve({ kind: 'redirect', location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        if (contentType && !/xml|rss|atom|text/.test(contentType)) {
          res.resume();
          reject(new Error(`unexpected content-type: ${contentType}`));
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
            reject(new Error('XML DOCTYPE not allowed (billion-laughs defense)'));
            return;
          }
          resolve({ kind: 'body', body });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function containsDoctype(body: string): boolean {
  // Scan only the first few KiB: DOCTYPE declarations must appear in the XML
  // prolog before any element, so a scan window covers every legitimate
  // position and keeps the check cheap on large bodies.
  return /<!DOCTYPE/i.test(body.slice(0, DOCTYPE_SCAN_WINDOW));
}
/* v8 ignore stop */
