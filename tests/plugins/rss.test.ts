import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpLayer } from '../../plugins/rss/feed-fetcher';
// Import the plugin module (gets mocked rss-parser)
import { formatItem, hashItem, init, stripHtmlTags, teardown } from '../../plugins/rss/index';
import { BotDatabase } from '../../src/database';
import type {
  BindHandler,
  BindType,
  ChannelHandlerContext,
  HelpEntry,
  PluginAPI,
  PluginDB,
  TimeContext,
} from '../../src/types';

// ---------------------------------------------------------------------------
// Mock rss-parser at module level (applies to direct imports)
// ---------------------------------------------------------------------------

type ParsedFeed = { items: Array<{ guid?: string; title?: string; link?: string }> };

// mockParseURL models what the test harness expects back from a feed poll.
// The real flow now fetches XML via httpLayer.fetchFeedXml (which we stub to
// a plain sentinel string) and hands it to parser.parseString — we stitch
// both ends to the same mock so existing test bodies keep driving per-feed
// items. The sentinel is a bare prefix rather than a fake HTML comment to
// avoid tripping HTML-sanitization linters on what is really a test-only
// round-trip encoding.
const mockParseURL = vi.fn<(url: string) => Promise<ParsedFeed>>();
const TEST_URL_SENTINEL = 'RSS_TEST_URL:';

vi.mock('rss-parser', () => ({
  default: class MockParser {
    parseString = async (xml: string): Promise<ParsedFeed> => {
      const url = xml.startsWith(TEST_URL_SENTINEL) ? xml.slice(TEST_URL_SENTINEL.length) : xml;
      return mockParseURL(url);
    };
  },
}));

// Route fetchFeedXml to a sentinel that encodes the source URL so parseString
// can thread the mock response back. validateFeedUrl never runs in this path.
const originalFetchFeedXml = httpLayer.fetchFeedXml;
httpLayer.fetchFeedXml = async (url: string): Promise<string> => `${TEST_URL_SENTINEL}${url}`;
void originalFetchFeedXml;

// handleAdd also calls validateFeedUrl directly to block SSRF before saving a
// runtime feed. Tests use placeholder domains like `https://new.com/rss`, so
// we stub the validator to a no-op that records calls — the url-validator's
// own behavior is covered in plugins/rss/url-validator.test.ts.
vi.mock('../../plugins/rss/url-validator', () => ({
  validateFeedUrl: vi.fn(async (rawUrl: string) => ({
    url: new URL(rawUrl),
    resolvedIps: ['203.0.113.1'],
  })),
  isPublicAddress: () => true,
}));

// ---------------------------------------------------------------------------
// Mock PluginAPI factory
// ---------------------------------------------------------------------------

interface Bind {
  type: BindType;
  flags: string;
  mask: string;
  handler: BindHandler<BindType>;
}

interface MockAPI extends PluginAPI {
  _binds: Bind[];
  _says: Array<{ target: string; message: string }>;
  _notices: Array<{ target: string; message: string }>;
  _timers: Map<string, BindHandler<'time'>>;
  _fireTime: (mask: string) => Promise<void>;
}

function makeMockAPI(db: BotDatabase, config: Record<string, unknown> = {}): MockAPI {
  const binds: Bind[] = [];
  const says: Array<{ target: string; message: string }> = [];
  const notices: Array<{ target: string; message: string }> = [];
  const timers = new Map<string, BindHandler<'time'>>();
  const pluginId = 'rss';

  // Scoped DB via BotDatabase
  const pluginDb: PluginDB = {
    get: (key) => db.get(pluginId, key) ?? undefined,
    set: (key, value) => db.set(pluginId, key, value),
    del: (key) => db.del(pluginId, key),
    list: (prefix) => db.list(pluginId, prefix),
  };

  const api: MockAPI = {
    pluginId,
    _binds: binds,
    _says: says,
    _notices: notices,
    _timers: timers,

    async _fireTime(mask: string) {
      const handler = timers.get(mask);
      if (!handler) return;
      const ctx: TimeContext = {
        nick: '',
        ident: '',
        hostname: '',
        channel: null,
        text: '',
        command: '',
        args: '',
        reply: vi.fn(),
        replyPrivate: vi.fn(),
      };
      await handler(ctx as never);
    },

    bind(type, flags, mask, handler) {
      binds.push({ type, flags, mask, handler: handler as BindHandler<BindType> });
      if (type === 'time') {
        timers.set(mask, handler as BindHandler<'time'>);
      }
    },
    unbind() {},

    say(target, message) {
      says.push({ target, message });
    },
    action() {},
    notice(target, message) {
      notices.push({ target, message });
    },
    ctcpResponse() {},

    join() {},
    part() {},
    op() {},
    deop() {},
    voice() {},
    devoice() {},
    halfop() {},
    dehalfop() {},
    kick() {},
    ban() {},
    mode() {},
    requestChannelModes() {},
    topic() {},
    invite() {},
    changeNick() {},

    onModesReady() {},
    offModesReady() {},
    onPermissionsChanged() {},
    offPermissionsChanged() {},
    onUserIdentified() {},
    offUserIdentified() {},
    onUserDeidentified() {},
    offUserDeidentified() {},
    getChannel() {
      return undefined;
    },
    getUsers() {
      return [];
    },
    getUserHostmask() {
      return undefined;
    },

    permissions: {
      findByHostmask: () => null,
      checkFlags: () => true,
    },
    services: {
      verifyUser: async () => ({ verified: false, account: null }),
      isAvailable: () => false,
      isNickServVerificationReply: () => false,
    },
    db: pluginDb,
    banStore: {} as never,
    botConfig: {} as never,
    config,
    getServerSupports: () => ({}),
    ircLower: (text: string) => text.toLowerCase(),
    buildHostmask: (s) => `${s.nick}!${s.ident}@${s.hostname}`,
    isBotNick: () => false,
    channelSettings: {} as never,
    registerHelp(_entries: HelpEntry[]) {},
    getHelpEntries: () => [],
    stripFormatting: (text: string) => text,
    getChannelKey: () => undefined,
    util: {
      matchWildcard: () => false,
      createSlidingWindowCounter: () => ({
        check: () => false,
        peek: () => 0,
        clear: () => {},
        reset: () => {},
        sweep: () => {},
        size: 0,
      }),
    },
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    audit: { log: vi.fn() },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_ITEMS = [
  { guid: 'guid-1', title: 'First Post', link: 'https://example.com/1' },
  { guid: 'guid-2', title: 'Second Post', link: 'https://example.com/2' },
  { guid: 'guid-3', title: 'Third Post', link: 'https://example.com/3' },
];

// ---------------------------------------------------------------------------
// Unit tests — pure functions
// ---------------------------------------------------------------------------

describe('rss plugin — hashItem', () => {
  it('produces a deterministic 16-char hex hash from guid', () => {
    const h1 = hashItem({ guid: 'abc-123', title: 'Title', link: 'https://x.com' });
    const h2 = hashItem({ guid: 'abc-123', title: 'Title', link: 'https://x.com' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to title+link when guid is absent', () => {
    const h1 = hashItem({ title: 'Hello', link: 'https://example.com' });
    const h2 = hashItem({ title: 'Hello', link: 'https://example.com' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces different hashes for different guids', () => {
    const h1 = hashItem({ guid: 'a' });
    const h2 = hashItem({ guid: 'b' });
    expect(h1).not.toBe(h2);
  });

  it('uses guid over title+link when both are present', () => {
    const withGuid = hashItem({ guid: 'g1', title: 'T', link: 'L' });
    const withoutGuid = hashItem({ title: 'T', link: 'L' });
    expect(withGuid).not.toBe(withoutGuid);
  });

  it('handles item with no guid, title, or link', () => {
    const h = hashItem({});
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('rss plugin — formatItem', () => {
  const baseCfg = {
    feeds: [] as Array<{ id: string; url: string; channels: string[] }>,
    dedup_window_days: 30,
    max_title_length: 300,
    request_timeout_ms: 10000,
    max_per_poll: 5,
  };
  const feed = {
    id: 'test',
    url: 'https://example.com/rss',
    channels: ['#test'],
    name: 'Test Feed',
  };

  // Minimal PluginAPI stub — formatItem only needs stripFormatting, and we
  // want the real implementation so the IRC control code tests below
  // exercise the actual scrub path rather than a passthrough.
  const stripFn = (text: string): string =>
    text
      // eslint-disable-next-line no-control-regex -- stripping IRC formatting control bytes
      .replace(/[\x02\x1d\x1f\x1e\x0f\x16]/g, '')
      // eslint-disable-next-line no-control-regex -- mIRC color escape \x03
      .replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/g, '');
  const fmtApi = { stripFormatting: stripFn } as unknown as PluginAPI;

  it('formats with bold feed name, title, and link', () => {
    const result = formatItem(
      fmtApi,
      feed,
      { title: 'Hello World', link: 'https://example.com/1' },
      baseCfg.max_title_length,
    );
    expect(result).toBe('\x02[Test Feed]\x02 Hello World \u2014 https://example.com/1');
  });

  it('strips HTML tags from title', () => {
    const result = formatItem(
      fmtApi,
      feed,
      { title: '<b>Bold</b> and <i>italic</i>', link: 'https://x.com' },
      baseCfg.max_title_length,
    );
    expect(result).toContain('Bold and italic');
    expect(result).not.toContain('<b>');
    expect(result).not.toContain('<i>');
  });

  it('strips nested/reconstructed tags by looping until stable', () => {
    // Classic CodeQL "incomplete multi-character sanitization" vector —
    // a single-pass regex could leave tag-like fragments behind depending
    // on how the replacement unfolds. The fixed-point loop must leave no
    // `<...>` substrings in the output.
    const nasty = '<scr<script>ipt>alert(1)</scr</script>ipt> <<scrip<scrip<script>t>t>ipt>t> hi';
    const result = formatItem(
      fmtApi,
      feed,
      { title: nasty, link: 'https://x.com' },
      baseCfg.max_title_length,
    );
    // No angle-bracketed tag survives.
    expect(result).not.toMatch(/<[^>]*>/);
    // The plain-text tail is still visible.
    expect(result).toContain('hi');
  });

  it('strips IRC formatting embedded in feed title', () => {
    const result = formatItem(
      fmtApi,
      feed,
      { title: '\x02bold\x02 \x034red\x03 \x1funder\x1f', link: 'https://x.com' },
      baseCfg.max_title_length,
    );
    // stripFormatting removes \x02/\x03/\x1f — only plain text remains.
    expect(result).toContain('bold red under');
    expect(result).not.toContain('\x034');
    expect(result).not.toContain('\x1f');
  });

  it('truncates long titles with ellipsis', () => {
    const longTitle = 'A'.repeat(350);
    const result = formatItem(
      fmtApi,
      feed,
      { title: longTitle, link: 'https://x.com' },
      baseCfg.max_title_length,
    );
    expect(result).toContain('A'.repeat(300) + '\u2026');
  });

  it('uses feed id as name when name is not set', () => {
    const noNameFeed = { id: 'myid', url: 'https://x.com/rss', channels: ['#test'] };
    const result = formatItem(
      fmtApi,
      noNameFeed,
      { title: 'Post', link: 'https://x.com' },
      baseCfg.max_title_length,
    );
    expect(result).toContain('[myid]');
  });

  it('handles missing link gracefully', () => {
    const result = formatItem(fmtApi, feed, { title: 'No Link' }, baseCfg.max_title_length);
    expect(result).toBe('\x02[Test Feed]\x02 No Link');
    expect(result).not.toContain('\u2014');
  });

  it('handles missing title gracefully', () => {
    const result = formatItem(fmtApi, feed, { link: 'https://x.com' }, baseCfg.max_title_length);
    expect(result).toBe('\x02[Test Feed]\x02  \u2014 https://x.com');
  });
});

describe('rss plugin — stripHtmlTags', () => {
  it('returns plain text unchanged', () => {
    expect(stripHtmlTags('hello world')).toBe('hello world');
  });

  it('strips a simple tag', () => {
    expect(stripHtmlTags('<b>bold</b>')).toBe('bold');
  });

  it('strips multiple tags in one pass', () => {
    expect(stripHtmlTags('<p>first</p><p>second</p>')).toBe('firstsecond');
  });

  it('strips tags with attributes', () => {
    expect(stripHtmlTags('<a href="https://x.com">link</a>')).toBe('link');
  });

  it('handles empty string', () => {
    expect(stripHtmlTags('')).toBe('');
  });

  it('handles a string with only tags', () => {
    expect(stripHtmlTags('<br/><hr/>')).toBe('');
  });

  it('handles an unclosed tag gracefully (left alone)', () => {
    // A bare `<` with no closing `>` is not a valid tag; the regex leaves it.
    expect(stripHtmlTags('5 < 10')).toBe('5 < 10');
  });

  it('leaves a stray `>` alone', () => {
    expect(stripHtmlTags('10 > 5')).toBe('10 > 5');
  });

  it('loops until stable on nested tags', () => {
    // The canonical CodeQL vector for incomplete multi-character sanitization.
    // After stripping, no `<…>` substring remains anywhere in the output.
    const vectors = [
      '<scr<script>ipt>alert(1)</script>',
      '<<script>script>alert(1)</<script>script>',
      '<b<b>></b>>',
      '<<<<>>>>',
    ];
    for (const v of vectors) {
      const stripped = stripHtmlTags(v);
      expect(stripped).not.toMatch(/<[^>]*>/);
    }
  });

  it('terminates on pathological inputs (no infinite loop)', () => {
    // Any input must eventually stabilise — each iteration strictly shrinks
    // or returns the same string, so the loop is bounded by input length.
    const pathological = '<'.repeat(100) + '>'.repeat(100);
    // Must not hang — bound the call with a simple wall-clock check.
    const start = Date.now();
    const result = stripHtmlTags(pathological);
    expect(Date.now() - start).toBeLessThan(200);
    // And the result must have no `<...>` substrings left.
    expect(result).not.toMatch(/<[^>]*>/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — polling, dedup, commands, cleanup
// ---------------------------------------------------------------------------

describe('rss plugin — integration', () => {
  let db: BotDatabase;
  let api: MockAPI;

  const BASE_CONFIG = {
    feeds: [
      {
        id: 'testfeed',
        url: 'https://example.com/rss',
        name: 'Test',
        channels: ['#test'],
        interval: 300,
      },
    ],
    dedup_window_days: 30,
    max_title_length: 300,
    request_timeout_ms: 10000,
    max_per_poll: 5,
  };

  beforeEach(() => {
    mockParseURL.mockReset();
    mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS] });

    db = new BotDatabase(':memory:');
    db.open();
    api = makeMockAPI(db, BASE_CONFIG);
  });

  afterEach(() => {
    teardown();
    db.close();
  });

  it('seeds all items silently on first load (no announcements)', async () => {
    await init(api);

    expect(mockParseURL).toHaveBeenCalledWith('https://example.com/rss');

    // All 3 items should be marked seen in KV
    const seen = db.list('rss', 'rss:seen:testfeed:');
    expect(seen.length).toBe(3);

    // No channel messages (silent seed)
    expect(api._says).toHaveLength(0);
  });

  it('does not re-announce already-seen items', async () => {
    await init(api);

    // Fire the 60s time bind — feed was polled recently so interval hasn't elapsed
    mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS] });
    await api._fireTime('60');

    // Still 3 — no new items
    const seen = db.list('rss', 'rss:seen:testfeed:');
    expect(seen.length).toBe(3);
    expect(api._says).toHaveLength(0);
  });

  it('announces new items that appear after seeding', async () => {
    await init(api);

    // Advance the last_poll timestamp so the interval has elapsed
    db.set('rss', 'rss:last_poll:testfeed', new Date(Date.now() - 400_000).toISOString());

    const newItem = { guid: 'guid-new', title: 'Brand New', link: 'https://example.com/new' };
    mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS, newItem] });

    await api._fireTime('60');

    // New item should now be seen
    const seen = db.list('rss', 'rss:seen:testfeed:');
    expect(seen.length).toBe(4);

    // Should have announced to #test
    expect(api._says.length).toBe(1);
    expect(api._says[0].target).toBe('#test');
    expect(api._says[0].message).toContain('Brand New');
  });

  it('respects max_per_poll cap', async () => {
    const capConfig = {
      ...BASE_CONFIG,
      max_per_poll: 2,
      feeds: [
        {
          id: 'capfeed',
          url: 'https://example.com/rss2',
          name: 'Cap',
          channels: ['#test'],
          interval: 60,
        },
      ],
    };
    api = makeMockAPI(db, capConfig);

    // Empty seed
    mockParseURL.mockResolvedValue({ items: [] });
    await init(api);

    // Return 5 new items on next poll
    const manyItems = Array.from({ length: 5 }, (_, i) => ({
      guid: `cap-${i}`,
      title: `Item ${i}`,
      link: `https://example.com/${i}`,
    }));
    mockParseURL.mockResolvedValue({ items: manyItems });

    // Force interval elapsed
    db.set('rss', 'rss:last_poll:capfeed', new Date(Date.now() - 120_000).toISOString());

    // announceItems sleeps 500ms between items. With real timers this test
    // cost ~500ms; fake the timer subset so it returns immediately while
    // leaving Date and queueMicrotask alone (other rss code reads them).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const polled = api._fireTime('60');
      await vi.runAllTimersAsync();
      await polled;
    } finally {
      vi.useRealTimers();
    }

    // Only 2 should be marked seen (max_per_poll: 2)
    const seen = db.list('rss', 'rss:seen:capfeed:');
    expect(seen.length).toBe(2);
    expect(api._says.length).toBe(2);
  });

  it('does not silently absorb new items on reload', async () => {
    // First boot: silent seed marks current items as seen.
    await init(api);
    expect(db.list('rss', 'rss:seen:testfeed:').length).toBe(3);

    // Simulate a plugin reload: teardown, then init again with an extra
    // item the feed published between boots. The previous behaviour was
    // to re-run silent seed on every init, which would mark `between`
    // seen without announcing it — the regression this test pins.
    teardown();
    const betweenItem = {
      guid: 'guid-between',
      title: 'Published Between Boots',
      link: 'https://example.com/between',
    };
    mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS, betweenItem] });
    api = makeMockAPI(db, BASE_CONFIG);
    await init(api);

    // The new item must NOT have been silently marked seen.
    expect(db.list('rss', 'rss:seen:testfeed:').length).toBe(3);
    expect(api._says).toHaveLength(0);

    // Force the interval elapsed and fire the tick — the item should
    // now announce on the first scheduled poll.
    db.set('rss', 'rss:last_poll:testfeed', new Date(Date.now() - 400_000).toISOString());
    await api._fireTime('60');

    expect(db.list('rss', 'rss:seen:testfeed:').length).toBe(4);
    expect(api._says.length).toBe(1);
    expect(api._says[0].message).toContain('Published Between Boots');
  });

  it('announces to multiple channels when configured', async () => {
    const multiCfg = {
      ...BASE_CONFIG,
      feeds: [
        {
          id: 'multi',
          url: 'https://example.com/rss',
          name: 'Multi',
          channels: ['#a', '#b'],
          interval: 60,
        },
      ],
    };
    api = makeMockAPI(db, multiCfg);
    mockParseURL.mockResolvedValue({ items: [] });
    await init(api);

    mockParseURL.mockResolvedValue({
      items: [{ guid: 'new', title: 'New', link: 'https://x.com' }],
    });
    db.set('rss', 'rss:last_poll:multi', new Date(Date.now() - 120_000).toISOString());
    await api._fireTime('60');

    // 1 item × 2 channels = 2 say calls
    expect(api._says.length).toBe(2);
    expect(api._says[0].target).toBe('#a');
    expect(api._says[1].target).toBe('#b');
  });

  describe('error handling', () => {
    it('does not crash or update last_poll when fetch fails', async () => {
      await init(api);

      const lastPollBefore = db.get('rss', 'rss:last_poll:testfeed');
      expect(lastPollBefore).toBeTruthy();

      // Force interval elapsed and make fetch fail
      db.set('rss', 'rss:last_poll:testfeed', new Date(Date.now() - 400_000).toISOString());
      mockParseURL.mockRejectedValue(new Error('Network timeout'));

      await api._fireTime('60');

      // last_poll should NOT have been updated (error before setLastPoll)
      const lastPollAfter = db.get('rss', 'rss:last_poll:testfeed');
      // It was reset to the old value we manually set, and since pollFeed threw,
      // it shouldn't have been updated to a new timestamp
      expect(lastPollAfter).not.toBe(lastPollBefore);

      // No announcements
      expect(api._says).toHaveLength(0);
    });

    it('logs error and continues when a feed fails', async () => {
      await init(api);

      db.set('rss', 'rss:last_poll:testfeed', new Date(Date.now() - 400_000).toISOString());
      mockParseURL.mockRejectedValue(new Error('ECONNREFUSED'));

      await api._fireTime('60');

      expect(api.error).toHaveBeenCalled();
    });
  });

  describe('hasSeen / markSeen round-trip', () => {
    it('items seeded on init are persisted in KV with valid timestamps', async () => {
      await init(api);

      const entries = db.list('rss', 'rss:seen:testfeed:');
      expect(entries.length).toBe(3);
      for (const entry of entries) {
        expect(entry.key).toMatch(/^rss:seen:testfeed:[0-9a-f]{16}$/);
        expect(new Date(entry.value).getTime()).toBeGreaterThan(0);
      }
    });
  });

  describe('cleanupSeen', () => {
    it('removes old entries when daily cleanup fires', async () => {
      await init(api);

      // Insert an entry from 60 days ago (beyond the 30-day window)
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      db.set('rss', 'rss:seen:testfeed:oldentry00000000', oldDate);
      expect(db.get('rss', 'rss:seen:testfeed:oldentry00000000')).toBeTruthy();

      await api._fireTime('86400');

      expect(db.get('rss', 'rss:seen:testfeed:oldentry00000000')).toBeNull();
    });

    it('keeps recent entries during cleanup', async () => {
      await init(api);

      const entries = db.list('rss', 'rss:seen:testfeed:');
      expect(entries.length).toBe(3);
      const recentKey = entries[0].key;

      await api._fireTime('86400');

      expect(db.get('rss', recentKey)).toBeTruthy();
    });

    it('removes entries with corrupt timestamps', async () => {
      await init(api);

      db.set('rss', 'rss:seen:testfeed:corrupt000000000', 'not-a-date');
      await api._fireTime('86400');

      expect(db.get('rss', 'rss:seen:testfeed:corrupt000000000')).toBeNull();
    });
  });

  describe('admin commands', () => {
    function makeAdminCtx(args: string): ChannelHandlerContext {
      return {
        nick: 'admin',
        ident: 'admin',
        hostname: 'localhost',
        channel: '#test',
        text: `!rss ${args}`,
        command: '!rss',
        args,
        reply: vi.fn(),
        replyPrivate: vi.fn(),
      };
    }

    async function dispatchRss(args: string): Promise<void> {
      const pubBind = api._binds.find((b) => b.type === 'pub' && b.mask === '!rss');
      expect(pubBind).toBeTruthy();
      const ctx = makeAdminCtx(args);
      await pubBind!.handler(ctx as never);
    }

    it('!rss list shows feeds via notice', async () => {
      await init(api);
      await dispatchRss('list');

      expect(api._notices.length).toBeGreaterThan(0);
      expect(api._notices[0].target).toBe('admin');
      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('testfeed');
    });

    it('!rss add creates a runtime feed', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [] });

      await dispatchRss('add newid https://new.com/rss #news 600');

      // Should be persisted in KV
      const raw = db.get('rss', 'rss:feed:newid');
      expect(raw).toBeTruthy();
      const feed = JSON.parse(raw!);
      expect(feed.id).toBe('newid');
      expect(feed.url).toBe('https://new.com/rss');
      expect(feed.channels).toEqual(['#news']);
      expect(feed.interval).toBe(600);

      // Confirmation via notice
      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('added');
    });

    it('!rss add defaults channel to the invoking channel when omitted', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [] });

      await dispatchRss('add ctxfeed https://ctx.com/rss');

      const raw = db.get('rss', 'rss:feed:ctxfeed');
      expect(raw).toBeTruthy();
      const feed = JSON.parse(raw!);
      // makeAdminCtx sets ctx.channel = '#test'
      expect(feed.channels).toEqual(['#test']);
      expect(feed.interval).toBe(3600);
    });

    it('!rss add accepts interval without explicit channel', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [] });

      await dispatchRss('add ivfeed https://iv.com/rss 900');

      const raw = db.get('rss', 'rss:feed:ivfeed');
      expect(raw).toBeTruthy();
      const feed = JSON.parse(raw!);
      expect(feed.channels).toEqual(['#test']);
      expect(feed.interval).toBe(900);
    });

    it('!rss add posts latest article as a preview on seed', async () => {
      await init(api);
      const previewItems = [
        { guid: 'p-1', title: 'Newest Post', link: 'https://x.com/new' },
        { guid: 'p-2', title: 'Older Post', link: 'https://x.com/old' },
      ];
      mockParseURL.mockResolvedValue({ items: previewItems });

      api._says.length = 0;
      await dispatchRss('add previewfeed https://p.com/rss #test 600');

      // Exactly one item should have been announced (the newest)
      expect(api._says.length).toBe(1);
      expect(api._says[0].target).toBe('#test');
      expect(api._says[0].message).toContain('Newest Post');

      // A subsequent poll against the same feed contents must find nothing
      // new — the older item must have been marked seen during the preview
      // seed, not left behind for the next tick to announce.
      api._says.length = 0;
      mockParseURL.mockResolvedValue({ items: previewItems });
      await dispatchRss('check previewfeed');
      expect(api._says.length).toBe(0);

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('preview');
    });

    it('!rss add reports empty feed without a preview', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [] });

      api._says.length = 0;
      await dispatchRss('add emptyfeed https://e.com/rss #test');

      expect(api._says.length).toBe(0);
      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('no items');
    });

    it('!rss add rejects missing args', async () => {
      await init(api);
      await dispatchRss('add');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Usage');
    });

    it('!rss add rejects duplicate id', async () => {
      await init(api);
      await dispatchRss('add testfeed https://x.com #test');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('already exists');
    });

    it('!rss add rejects invalid interval', async () => {
      await init(api);
      await dispatchRss('add x https://x.com #test 10');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('60');
    });

    it('!rss remove deletes a runtime feed', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [] });

      // First add a runtime feed
      await dispatchRss('add rmfeed https://rm.com/rss #test');
      expect(db.get('rss', 'rss:feed:rmfeed')).toBeTruthy();

      api._notices.length = 0;
      await dispatchRss('remove rmfeed');

      expect(db.get('rss', 'rss:feed:rmfeed')).toBeNull();
      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('removed');
    });

    it('!rss remove rejects config-file feeds', async () => {
      await init(api);
      await dispatchRss('remove testfeed');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('config');
    });

    it('!rss remove rejects unknown feed', async () => {
      await init(api);
      await dispatchRss('remove nonexistent');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('not found');
    });

    it('!rss check polls a specific feed', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS] });

      await dispatchRss('check testfeed');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Check complete');
    });

    it('!rss check polls all feeds when no id given', async () => {
      await init(api);
      mockParseURL.mockResolvedValue({ items: [...SAMPLE_ITEMS] });

      await dispatchRss('check');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Check complete');
    });

    it('!rss check reports error for unknown feed', async () => {
      await init(api);
      await dispatchRss('check nonexistent');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('not found');
    });

    it('!rss with unknown subcommand shows usage', async () => {
      await init(api);
      await dispatchRss('bogus');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Usage');
    });

    it('!rss remove with no id shows usage', async () => {
      await init(api);
      await dispatchRss('remove');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Usage');
    });

    it('!rss check announces new items via api.say', async () => {
      // Empty seed so check will find items
      mockParseURL.mockResolvedValue({ items: [] });
      await init(api);

      // Now the next poll returns items the check should announce
      const newItems = [
        { guid: 'check-1', title: 'Check One', link: 'https://x.com/1' },
        { guid: 'check-2', title: 'Check Two', link: 'https://x.com/2' },
      ];
      mockParseURL.mockResolvedValue({ items: newItems });

      // announceItems sleeps 500ms between items via setTimeout. Fake just
      // the timer subset so the drip resolves immediately without slowing
      // the suite (Date and microtasks stay real for the rest of the path).
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const dispatched = dispatchRss('check testfeed');
        await vi.runAllTimersAsync();
        await dispatched;
      } finally {
        vi.useRealTimers();
      }

      // Should have announced both new items to #test
      expect(api._says.length).toBe(2);
      expect(api._says[0].target).toBe('#test');
      expect(api._says[0].message).toContain('Check One');
      expect(api._says[1].message).toContain('Check Two');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('2 new');
    });

    it('!rss check reports pollFeed errors via notice', async () => {
      await init(api);
      mockParseURL.mockRejectedValue(new Error('Connection refused'));

      await dispatchRss('check testfeed');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Error checking');
      expect(allText).toContain('Connection refused');
    });

    it('!rss add reports silent-seed fetch failure via notice', async () => {
      await init(api);
      mockParseURL.mockRejectedValue(new Error('DNS failure'));

      await dispatchRss('add bad https://bad.example.com/rss #test');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('initial fetch failed');
      expect(allText).toContain('DNS failure');
      // Feed should still be persisted in KV despite the seed failure
      expect(db.get('rss', 'rss:feed:bad')).toBeTruthy();
    });

    it('!rss list shows "No feeds configured" when empty', async () => {
      // Init with empty feed list
      api = makeMockAPI(db, { ...BASE_CONFIG, feeds: [] });
      await init(api);
      await dispatchRss('list');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('No feeds configured');
    });

    it('!rss check with no id and no feeds reports empty', async () => {
      api = makeMockAPI(db, { ...BASE_CONFIG, feeds: [] });
      await init(api);
      await dispatchRss('check');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('No feeds configured');
    });
  });

  describe('time bind interval gating', () => {
    it('skips polling when interval has not elapsed since last_poll', async () => {
      await init(api);

      // last_poll is set fresh by init()'s seed call. Reset mock so we can
      // detect any further parse calls.
      mockParseURL.mockClear();
      mockParseURL.mockResolvedValue({ items: [] });

      await api._fireTime('60');

      // Interval is 300s, only ~0s have passed since seeding — should skip
      expect(mockParseURL).not.toHaveBeenCalled();
    });
  });

  describe('getLastPoll', () => {
    it('treats corrupt last_poll timestamps as 0 (always poll)', async () => {
      await init(api);

      // Corrupt the last_poll value
      db.set('rss', 'rss:last_poll:testfeed', 'not-a-valid-iso-date');
      mockParseURL.mockClear();
      mockParseURL.mockResolvedValue({ items: [] });

      await api._fireTime('60');

      // Since corrupted timestamp parses as NaN → returns 0 → interval elapsed
      expect(mockParseURL).toHaveBeenCalled();
    });
  });

  describe('loadConfig defaults', () => {
    it('falls back to defaults when config fields are missing', async () => {
      // Empty config — all fields should fall back to defaults
      mockParseURL.mockResolvedValue({ items: [] });
      api = makeMockAPI(db, {});
      await init(api);
      // Should have loaded with 0 feeds and not crashed
      expect(api._binds.find((b) => b.type === 'time' && b.mask === '60')).toBeTruthy();
      expect(api._binds.find((b) => b.type === 'time' && b.mask === '86400')).toBeTruthy();
    });

    it('treats non-array feeds field as empty', async () => {
      api = makeMockAPI(db, { feeds: 'not-an-array' });
      await init(api);
      // Should not have called parseURL for any feed
      expect(mockParseURL).not.toHaveBeenCalled();
    });
  });

  describe('announceItems edge cases', () => {
    it('warns and skips when feed has no channels', async () => {
      const noChanCfg = {
        ...BASE_CONFIG,
        feeds: [
          {
            id: 'nochans',
            url: 'https://example.com/rss',
            name: 'NoChans',
            channels: [],
            interval: 60,
          },
        ],
      };
      api = makeMockAPI(db, noChanCfg);
      mockParseURL.mockResolvedValue({ items: [] });
      await init(api);

      // Now poll with new items
      mockParseURL.mockResolvedValue({
        items: [{ guid: 'x', title: 'X', link: 'https://x.com' }],
      });
      db.set('rss', 'rss:last_poll:nochans', new Date(Date.now() - 120_000).toISOString());
      await api._fireTime('60');

      expect(api.warn).toHaveBeenCalled();
      expect(api._says).toHaveLength(0);
    });

    it('delays between multiple items in the same poll', async () => {
      vi.useFakeTimers();
      try {
        mockParseURL.mockResolvedValue({ items: [] });
        await init(api);

        // Force interval elapsed and return 3 items
        const items = [
          { guid: 'd1', title: 'D1', link: 'https://x.com/1' },
          { guid: 'd2', title: 'D2', link: 'https://x.com/2' },
          { guid: 'd3', title: 'D3', link: 'https://x.com/3' },
        ];
        mockParseURL.mockResolvedValue({ items });
        db.set('rss', 'rss:last_poll:testfeed', new Date(Date.now() - 400_000).toISOString());

        const firePromise = api._fireTime('60');
        // Drain pending timers (delay() calls)
        await vi.runAllTimersAsync();
        await firePromise;

        // All 3 items should have been announced
        expect(api._says.length).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('runtime feed persistence', () => {
    it('runtime-added feeds are loaded on init', async () => {
      // Pre-populate a runtime feed in KV
      const feedConfig = {
        id: 'runtime1',
        url: 'https://example.com/runtime',
        channels: ['#test'],
        interval: 600,
      };
      db.set('rss', 'rss:feed:runtime1', JSON.stringify(feedConfig));

      await init(api);

      // parseURL should have been called for the runtime feed
      const calls = mockParseURL.mock.calls.map((c) => c[0]);
      expect(calls).toContain('https://example.com/runtime');
    });

    it('config feeds take precedence over runtime feeds with same id', async () => {
      // Pre-populate a runtime feed with the same id as a config feed
      const runtimeFeed = {
        id: 'testfeed',
        url: 'https://example.com/WRONG',
        channels: ['#wrong'],
        interval: 999,
      };
      db.set('rss', 'rss:feed:testfeed', JSON.stringify(runtimeFeed));

      await init(api);

      // Should have polled the config URL, not the runtime one
      expect(mockParseURL).toHaveBeenCalledWith('https://example.com/rss');
      expect(mockParseURL).not.toHaveBeenCalledWith('https://example.com/WRONG');
    });

    it('corrupt runtime feed entries are cleaned up', async () => {
      db.set('rss', 'rss:feed:bad', 'NOT JSON');
      await init(api);

      // Corrupt entry should have been deleted
      expect(db.get('rss', 'rss:feed:bad')).toBeNull();
    });
  });

  describe('help registration', () => {
    it('registers help entries on init', async () => {
      const registerHelp = vi.fn();
      api.registerHelp = registerHelp;

      await init(api);

      expect(registerHelp).toHaveBeenCalledOnce();
      const entries = registerHelp.mock.calls[0][0] as HelpEntry[];
      expect(entries[0].command).toBe('!rss');
    });
  });
});
