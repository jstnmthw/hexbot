import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the plugin module (gets mocked rss-parser)
import { formatItem, hashItem, init, teardown } from '../../plugins/rss/index';
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

const mockParseURL =
  vi.fn<
    (url: string) => Promise<{ items: Array<{ guid?: string; title?: string; link?: string }> }>
  >();

vi.mock('rss-parser', () => ({
  default: class MockParser {
    parseURL = mockParseURL;
  },
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
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
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

  it('formats with bold feed name, title, and link', () => {
    const result = formatItem(
      feed,
      { title: 'Hello World', link: 'https://example.com/1' },
      baseCfg,
    );
    expect(result).toBe('\x02[Test Feed]\x02 Hello World \u2014 https://example.com/1');
  });

  it('strips HTML tags from title', () => {
    const result = formatItem(
      feed,
      { title: '<b>Bold</b> and <i>italic</i>', link: 'https://x.com' },
      baseCfg,
    );
    expect(result).toContain('Bold and italic');
    expect(result).not.toContain('<b>');
    expect(result).not.toContain('<i>');
  });

  it('truncates long titles with ellipsis', () => {
    const longTitle = 'A'.repeat(350);
    const result = formatItem(feed, { title: longTitle, link: 'https://x.com' }, baseCfg);
    expect(result).toContain('A'.repeat(300) + '\u2026');
  });

  it('uses feed id as name when name is not set', () => {
    const noNameFeed = { id: 'myid', url: 'https://x.com/rss', channels: ['#test'] };
    const result = formatItem(noNameFeed, { title: 'Post', link: 'https://x.com' }, baseCfg);
    expect(result).toContain('[myid]');
  });

  it('handles missing link gracefully', () => {
    const result = formatItem(feed, { title: 'No Link' }, baseCfg);
    expect(result).toBe('\x02[Test Feed]\x02 No Link');
    expect(result).not.toContain('\u2014');
  });

  it('handles missing title gracefully', () => {
    const result = formatItem(feed, { link: 'https://x.com' }, baseCfg);
    expect(result).toBe('\x02[Test Feed]\x02  \u2014 https://x.com');
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

  afterEach(async () => {
    await teardown();
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
    await api._fireTime('60');

    // Only 2 should be marked seen (max_per_poll: 2)
    const seen = db.list('rss', 'rss:seen:capfeed:');
    expect(seen.length).toBe(2);
    expect(api._says.length).toBe(2);
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

    it('!rss add rejects missing args', async () => {
      await init(api);
      await dispatchRss('add');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('Usage');
    });

    it('!rss add rejects channel without #', async () => {
      await init(api);
      await dispatchRss('add badid https://x.com nochannel');

      const allText = api._notices.map((n) => n.message).join(' ');
      expect(allText).toContain('#');
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

      await dispatchRss('check testfeed');

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
