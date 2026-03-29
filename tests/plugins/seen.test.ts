import { resolve } from 'node:path';
import {
  type Mock,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import { EventDispatcher } from '../../src/dispatcher';
import { BotEventBus } from '../../src/event-bus';
import { PluginLoader } from '../../src/plugin-loader';
import type { BotConfig, HandlerContext } from '../../src/types';

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: {
    host: 'localhost',
    port: 6667,
    tls: false,
    nick: 'test',
    username: 'test',
    realname: 'test',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function makePubCtx(
  nick: string,
  text: string,
  channel = '#test',
): HandlerContext & { reply: Mock<(msg: string) => void> } {
  const spaceIdx = text.indexOf(' ');
  const command = spaceIdx === -1 ? text : text.substring(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : text.substring(spaceIdx + 1).trim();
  const reply = vi.fn<(msg: string) => void>();
  const ctx: HandlerContext = {
    nick,
    ident: 'user',
    hostname: 'host.com',
    channel,
    text,
    command,
    args,
    reply,
    replyPrivate: vi.fn(),
  };
  return ctx as HandlerContext & { reply: Mock<(msg: string) => void> };
}

describe('seen plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  beforeAll(async () => {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions: new Permissions(db),
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: null,
    });

    const result = await loader.load(resolve('./plugins/seen/index.ts'));
    expect(result.status).toBe('ok');
  });

  afterAll(async () => {
    if (loader.isLoaded('seen')) {
      await loader.unload('seen');
    }
    db.close();
  });

  it('should track channel messages in the database', async () => {
    const ctx = makePubCtx('alice', 'hello everyone');
    await dispatcher.dispatch('pubm', ctx);

    const raw = db.get('seen', 'seen:alice');
    expect(raw).toBeTruthy();

    const record = JSON.parse(raw!);
    expect(record.nick).toBe('alice');
    expect(record.channel).toBe('#test');
    expect(record.text).toBe('hello everyone');
    expect(record.time).toBeGreaterThan(0);
  });

  it('should report last seen info for a known user', async () => {
    // Track a message from alice
    const msgCtx = makePubCtx('alice', 'hello there', '#dev');
    await dispatcher.dispatch('pubm', msgCtx);

    // Query !seen alice
    const queryCtx = makePubCtx('bob', '!seen alice');
    await dispatcher.dispatch('pub', queryCtx);

    expect(queryCtx.reply).toHaveBeenCalledOnce();
    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('alice');
    expect(response).toContain('#dev');
    expect(response).toContain('hello there');
    expect(response).toMatch(/\d+s ago/);
  });

  it('should return "haven\'t seen" for unknown user', async () => {
    const ctx = makePubCtx('bob', '!seen nobody');
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith("I haven't seen nobody.");
  });

  it('should show usage when no nick provided', async () => {
    const ctx = makePubCtx('bob', '!seen');
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Usage: !seen <nick>');
  });

  it('should be case-insensitive for nick lookups', async () => {
    const msgCtx = makePubCtx('Alice', 'hi');
    await dispatcher.dispatch('pubm', msgCtx);

    const queryCtx = makePubCtx('bob', '!seen alice');
    await dispatcher.dispatch('pub', queryCtx);

    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('Alice');
  });

  it('should persist data across plugin reload', async () => {
    // Track a message
    const msgCtx = makePubCtx('charlie', 'some message');
    await dispatcher.dispatch('pubm', msgCtx);

    // Reload plugin
    await loader.reload('seen');

    // Query should still work (data in DB persists)
    const queryCtx = makePubCtx('bob', '!seen charlie');
    await dispatcher.dispatch('pub', queryCtx);

    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('charlie');
  });

  it('should truncate long messages to 200 chars when tracking', async () => {
    const longText = 'x'.repeat(201);
    const ctx = makePubCtx('alice', longText);
    await dispatcher.dispatch('pubm', ctx);

    const raw = db.get('seen', 'seen:alice');
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!);
    expect(record.text).toBe('x'.repeat(200) + '...');
    expect(record.text.length).toBe(203);
  });

  it('should isolate data from other plugins', async () => {
    // Track a message via the seen plugin
    const msgCtx = makePubCtx('alice', 'hello');
    await dispatcher.dispatch('pubm', msgCtx);

    // Data should be in the 'seen' namespace, not visible in other namespaces
    expect(db.get('seen', 'seen:alice')).toBeTruthy();
    expect(db.get('other-plugin', 'seen:alice')).toBeNull();
  });

  it('should reply "haven\'t seen" when stored JSON is corrupt', async () => {
    // Manually insert corrupt JSON into the seen namespace
    db.set('seen', 'seen:corrupt', '{not valid json!!!');

    const ctx = makePubCtx('bob', '!seen corrupt');
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith("I haven't seen corrupt.");
  });

  it('should delete stale record during query and reply "haven\'t seen"', async () => {
    // To hit the stale-check branch (lines 56-59), we need the record to survive
    // cleanupStale but then fail the age check in the query handler.
    // We achieve this by mocking Date.now() to advance time between calls.
    const baseTime = 1_000_000_000_000;
    const maxAgeMs = 365 * 24 * 60 * 60 * 1000;

    // Record was created at a time just barely within the max age window
    const recordTime = baseTime - maxAgeMs + 500; // 500ms under the limit
    const record = JSON.stringify({
      nick: 'ancient',
      channel: '#test',
      text: 'old message',
      time: recordTime,
    });
    db.set('seen', 'seen:ancient', record);

    // First calls to Date.now() (during cleanupStale): record is fresh
    // Later call (during age check in handler): record is stale
    let callCount = 0;
    const spy = vi.spyOn(Date, 'now');
    spy.mockImplementation(() => {
      callCount++;
      // The first call is in cleanupStale (const now = Date.now()),
      // the second is in the handler (const age = Date.now() - record.time)
      if (callCount <= 1) return baseTime; // cleanupStale: record is fresh (500ms under limit)
      return baseTime + 1000; // handler: record is now 500ms over limit
    });

    const ctx = makePubCtx('bob', '!seen ancient');
    await dispatcher.dispatch('pub', ctx);

    spy.mockRestore();

    expect(ctx.reply).toHaveBeenCalledWith("I haven't seen ancient.");
    // The stale entry should have been deleted during query
    expect(db.get('seen', 'seen:ancient')).toBeNull();
  });

  it('should remove corrupt entries during cleanupStale', async () => {
    // Insert a corrupt entry and a valid recent entry
    db.set('seen', 'seen:badentry', 'NOT JSON');
    const validRecord = JSON.stringify({
      nick: 'gooduser',
      channel: '#test',
      text: 'hi',
      time: Date.now(),
    });
    db.set('seen', 'seen:gooduser', validRecord);

    // Trigger cleanupStale by issuing a !seen query
    const ctx = makePubCtx('bob', '!seen gooduser');
    await dispatcher.dispatch('pub', ctx);

    // The corrupt entry should have been cleaned up
    expect(db.get('seen', 'seen:badentry')).toBeNull();
    // The valid entry should still exist
    expect(db.get('seen', 'seen:gooduser')).toBeTruthy();
  });

  it('should format relative time in minutes', async () => {
    // Insert a record from ~5 minutes ago
    const fiveMinAgo = Date.now() - (5 * 60 * 1000 + 500);
    db.set(
      'seen',
      'seen:minuser',
      JSON.stringify({
        nick: 'minuser',
        channel: '#test',
        text: 'hi',
        time: fiveMinAgo,
      }),
    );

    const ctx = makePubCtx('bob', '!seen minuser');
    await dispatcher.dispatch('pub', ctx);

    const response = ctx.reply.mock.calls[0][0];
    expect(response).toMatch(/\d+m ago/);
  });

  it('should format relative time in hours', async () => {
    // Insert a record from ~3 hours ago
    const threeHrsAgo = Date.now() - (3 * 60 * 60 * 1000 + 500);
    db.set(
      'seen',
      'seen:houruser',
      JSON.stringify({
        nick: 'houruser',
        channel: '#test',
        text: 'hi',
        time: threeHrsAgo,
      }),
    );

    const ctx = makePubCtx('bob', '!seen houruser');
    await dispatcher.dispatch('pub', ctx);

    const response = ctx.reply.mock.calls[0][0];
    expect(response).toMatch(/\d+h \d+m ago/);
  });

  it('should format relative time in days', async () => {
    // Insert a record from ~2 days ago
    const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000 + 500);
    db.set(
      'seen',
      'seen:dayuser',
      JSON.stringify({
        nick: 'dayuser',
        channel: '#test',
        text: 'hi',
        time: twoDaysAgo,
      }),
    );

    const ctx = makePubCtx('bob', '!seen dayuser');
    await dispatcher.dispatch('pub', ctx);

    const response = ctx.reply.mock.calls[0][0];
    expect(response).toMatch(/\d+d \d+h ago/);
  });
});

// ---------------------------------------------------------------------------
// Hourly cleanup via time bind
// ---------------------------------------------------------------------------

describe('seen plugin — hourly cleanup', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  // Fake timers must be installed BEFORE the plugin loads so the setInterval
  // created by the 'time' bind is captured by vitest's fake timer system.
  beforeEach(async () => {
    vi.useFakeTimers();
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();
    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions: new Permissions(db),
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: null,
    });
    const result = await loader.load(resolve('./plugins/seen/index.ts'));
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (loader.isLoaded('seen')) await loader.unload('seen');
    db.close();
  });

  it('removes expired entries when the time bind fires', () => {
    // Insert an entry that is older than maxAge (365 days)
    const maxAgeMs = 365 * 24 * 60 * 60 * 1000;
    const expiredRecord = JSON.stringify({
      nick: 'olduser',
      channel: '#test',
      text: 'hi',
      time: Date.now() - maxAgeMs - 1000,
    });
    db.set('seen', 'seen:olduser', expiredRecord);
    expect(db.get('seen', 'seen:olduser')).toBeTruthy();

    // Advance 1 hour to fire the time bind (3600s = 3_600_000ms)
    vi.advanceTimersByTime(3_600_000);

    // Expired entry should be removed by cleanupStale
    expect(db.get('seen', 'seen:olduser')).toBeNull();
  });

  it('removes corrupt entries when the time bind fires', () => {
    db.set('seen', 'seen:baduser', 'NOT VALID JSON');
    expect(db.get('seen', 'seen:baduser')).toBeTruthy();

    vi.advanceTimersByTime(3_600_000);

    expect(db.get('seen', 'seen:baduser')).toBeNull();
  });
});
