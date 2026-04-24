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

import { ChannelState } from '../../src/core/channel-state';
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
  let channelState: ChannelState;

  // Seed channel-state with every user present in every channel they're
  // cited in. The cross-channel sighting oracle guard (audit 2026-04-24)
  // refuses to reveal a sighting when the querier doesn't share the
  // stored channel with the bot, so tests that expect a detail reply
  // need both the target and the querier registered in the stored
  // channel. `populateChannel` is the single seeding helper; tests
  // call it before dispatching the `!seen` query.
  function populateChannel(channel: string, users: string[]): void {
    channelState.injectChannelSync({
      channel,
      topic: '',
      modes: '',
      users: users.map((nick) => ({
        nick,
        ident: 'user',
        hostname: 'host.com',
        modes: [],
      })),
    });
  }

  beforeAll(async () => {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();
    // ChannelState only needs `on`/`removeListener` stubs — the seen
    // plugin's privacy check reads `getChannel(...)?.users.has(nick)`,
    // which depends on the injected sync data, not live JOIN events.
    const fakeClient = {
      on: () => {},
      removeListener: () => {},
      say: () => {},
      changeNick: () => {},
    };
    channelState = new ChannelState(fakeClient, eventBus);

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions: new Permissions(db),
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: null,
      channelState,
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

  it('should report full detail when queried from the same channel', async () => {
    // Both alice (target) and bob (querier) must be in the stored
    // channel for the privacy guard to release the sighting.
    populateChannel('#dev', ['alice', 'bob']);
    const msgCtx = makePubCtx('alice', 'hello there', '#dev');
    await dispatcher.dispatch('pubm', msgCtx);

    // Query from the same channel the message was recorded in
    const queryCtx = makePubCtx('bob', '!seen alice', '#dev');
    await dispatcher.dispatch('pub', queryCtx);

    expect(queryCtx.reply).toHaveBeenCalledOnce();
    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('alice');
    expect(response).toContain('#dev');
    expect(response).toContain('hello there');
    expect(response).toMatch(/\d+s ago/);
  });

  it('should omit channel and message when queried from a different channel', async () => {
    // Record is in #dev, but bob shares #dev so the sighting is revealed
    // — the reply is the terse form that omits channel/message because
    // the querier's current channel differs from the stored one.
    populateChannel('#dev', ['alice', 'bob']);
    const msgCtx = makePubCtx('alice', 'hello there', '#dev');
    await dispatcher.dispatch('pubm', msgCtx);

    // Query from a different channel (bob is in #other now but still in #dev)
    const queryCtx = makePubCtx('bob', '!seen alice', '#other');
    await dispatcher.dispatch('pub', queryCtx);

    expect(queryCtx.reply).toHaveBeenCalledOnce();
    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('alice');
    expect(response).not.toContain('#dev');
    expect(response).not.toContain('hello there');
    expect(response).toMatch(/\d+s ago/);
  });

  it('does NOT reveal a sighting from a channel the querier does not share', async () => {
    // Cross-channel sighting oracle fix (audit 2026-04-24): if bob isn't
    // in #private, querying `!seen alice` must not reveal that alice was
    // active there. The reply collapses to the same "haven't seen" wording
    // used for truly-unknown nicks so the querier can't distinguish
    // "no record" from "record exists but hidden".
    populateChannel('#private', ['alice']); // bob is NOT a member
    const msgCtx = makePubCtx('alice', 'secret channel chatter', '#private');
    await dispatcher.dispatch('pubm', msgCtx);

    const queryCtx = makePubCtx('bob', '!seen alice', '#other');
    await dispatcher.dispatch('pub', queryCtx);

    expect(queryCtx.reply).toHaveBeenCalledOnce();
    expect(queryCtx.reply.mock.calls[0][0]).toBe("I haven't seen alice.");
  });

  it("does NOT store a `!seen foo` query as the querier's own sighting", async () => {
    // Audit 2026-04-24: the `pubm *` bind previously recorded the
    // querier's literal `!seen foo` line as their last-seen message,
    // clobbering whatever they'd actually said last and leaking the
    // target nick into the stored record. The trigger-prefix filter now
    // strips these before they hit the KV store.
    populateChannel('#test', ['querier']);
    const firstCtx = makePubCtx('querier', 'my real last line', '#test');
    await dispatcher.dispatch('pubm', firstCtx);

    // Now the same user queries — this should NOT overwrite the record.
    const queryCtx = makePubCtx('querier', '!seen someone', '#test');
    await dispatcher.dispatch('pubm', queryCtx);

    const raw = db.get('seen', 'seen:querier');
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!);
    expect(record.text).toBe('my real last line');
    expect(record.text).not.toContain('!seen');
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
    populateChannel('#test', ['Alice', 'bob']);
    const msgCtx = makePubCtx('Alice', 'hi');
    await dispatcher.dispatch('pubm', msgCtx);

    const queryCtx = makePubCtx('bob', '!seen alice');
    await dispatcher.dispatch('pub', queryCtx);

    const response = queryCtx.reply.mock.calls[0][0];
    expect(response).toContain('Alice');
  });

  it('should persist data across plugin reload', async () => {
    populateChannel('#test', ['charlie', 'bob']);
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

  it('strips IRC formatting from targetNick in the not-found reply', async () => {
    // A query that embeds IRC color/reset codes must not echo them back
    // verbatim — otherwise an attacker can forge a channel-visible line
    // that looks like the bot emitted extra content. Audit 2026-04-19.
    const spoofed = '\x0312,0spoof\x03';
    const ctx = makePubCtx('bob', `!seen ${spoofed}`);
    await dispatcher.dispatch('pub', ctx);
    const response = ctx.reply.mock.calls[0][0];
    expect(response).not.toContain('\x03');
    // eslint-disable-next-line no-control-regex -- explicit check
    expect(response).not.toMatch(/[\x00-\x1F]/);
    expect(response).toContain('spoof');
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
    // Insert a record from ~5 minutes ago. The sighting channel (#test)
    // must include both the target and the querier for the privacy guard
    // to release the reply.
    populateChannel('#test', ['minuser', 'bob']);
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
    populateChannel('#test', ['houruser', 'bob']);
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
    populateChannel('#test', ['dayuser', 'bob']);
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
