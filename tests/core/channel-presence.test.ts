import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConnectionLifecycleDeps,
  type ConnectionLifecycleHandle,
  type LifecycleIRCClient,
  registerConnectionEvents,
} from '../../src/core/connection-lifecycle';
import { BotEventBus } from '../../src/event-bus';
import type { LoggerLike } from '../../src/logger';
import type { BotConfig } from '../../src/types';
import { createMockLogger } from '../helpers/mock-logger';

// ---------------------------------------------------------------------------
// Mock IRC client
// ---------------------------------------------------------------------------

class MockClient extends EventEmitter implements LifecycleIRCClient {
  public joins: Array<{ channel: string; key?: string }> = [];
  public network = {
    supports: vi.fn<(feature: string) => string | boolean>().mockReturnValue('rfc1459'),
  };

  join(channel: string, key?: string): void {
    this.joins.push({ channel, key });
  }

  quit(_message?: string): void {
    // Simulate closing the connection
    this.emit('close');
  }
}

// ---------------------------------------------------------------------------
// Mock channel state
// ---------------------------------------------------------------------------

class MockChannelState {
  private channels = new Set<string>();

  addChannel(name: string): void {
    this.channels.add(name.toLowerCase());
  }

  removeChannel(name: string): void {
    this.channels.delete(name.toLowerCase());
  }

  getChannel(name: string): unknown | undefined {
    return this.channels.has(name.toLowerCase()) ? { name } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    irc: {
      host: 'irc.example.com',
      port: 6667,
      tls: false,
      nick: 'testbot',
      username: 'test',
      realname: 'Test Bot',
      channels: [],
    },
    owner: { handle: 'admin', hostmask: '*!*@localhost' },
    identity: { method: 'hostmask', require_acc_for: [] },
    services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
    database: ':memory:',
    pluginDir: './plugins',
    logging: { level: 'info', mod_actions: false },
    ...overrides,
  };
}

const makeLogger = createMockLogger;

interface TestContext {
  client: MockClient;
  channelState: MockChannelState;
  logger: LoggerLike;
  handle: ConnectionLifecycleHandle;
}

function makeStubDriver(): import('../../src/core/reconnect-driver').ReconnectDriver {
  return {
    onDisconnect: () => {},
    onConnected: () => {},
    cancel: () => {},
    getState: () => ({
      status: 'connected',
      lastError: null,
      lastErrorTier: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      attemptCount: 0,
    }),
  };
}

function setup(
  configuredChannels: Array<{ name: string; key?: string }>,
  configOverrides?: Partial<BotConfig>,
): TestContext {
  const client = new MockClient();
  const channelState = new MockChannelState();
  const logger = makeLogger();

  const deps: ConnectionLifecycleDeps = {
    client,
    config: makeConfig(configOverrides),
    configuredChannels,
    eventBus: new BotEventBus(),
    applyCasemapping: vi.fn(),
    applyServerCapabilities: vi.fn(),
    messageQueue: { clear: vi.fn() },
    dispatcher: { bind: vi.fn() },
    logger,
    channelState,
    reconnectDriver: makeStubDriver(),
  };

  const handle = registerConnectionEvents(
    deps,
    () => {},
    () => {},
  );

  // Fire 'registered' to start the presence check timer
  client.emit('registered');
  // Clear the initial joins from startup
  client.joins = [];

  return { client, channelState, logger, handle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channel presence check', () => {
  beforeEach(() => {
    // Fake Date.now() too — the bounded-retry schedule stores absolute epoch
    // times in `nextRetryAt` and compares against Date.now().
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends JOIN for a configured channel the bot is not in', () => {
    const { client, handle } = setup([{ name: '#test' }]);
    // Bot is not in #test — presence check should try to join
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toContainEqual({ channel: '#test', key: undefined });
    handle.stopPresenceCheck();
  });

  it('does not send JOIN when the bot is already in all configured channels', () => {
    const { client, channelState, handle } = setup([{ name: '#test' }]);
    channelState.addChannel('#test');
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(0);
    handle.stopPresenceCheck();
  });

  it('passes the configured channel key on rejoin', () => {
    const { client, handle } = setup([{ name: '#secret', key: 'hunter2' }]);
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toContainEqual({ channel: '#secret', key: 'hunter2' });
    handle.stopPresenceCheck();
  });

  it('retries on every tick for a persistently missing channel', () => {
    const { client, handle } = setup([{ name: '#gone' }]);
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(3);
    handle.stopPresenceCheck();
  });

  it('stops retrying once the bot is in the channel', () => {
    const { client, channelState, handle } = setup([{ name: '#test' }]);
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(1);

    // Bot successfully joined
    channelState.addChannel('#test');
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(1); // no new join
    handle.stopPresenceCheck();
  });

  it('resumes retrying if the bot leaves the channel again', () => {
    const { client, channelState, handle } = setup([{ name: '#test' }]);
    channelState.addChannel('#test');
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(0);

    // Bot was kicked/parted
    channelState.removeChannel('#test');
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(1);
    handle.stopPresenceCheck();
  });

  it('handles multiple configured channels independently', () => {
    const { client, channelState, handle } = setup([
      { name: '#alpha' },
      { name: '#beta' },
      { name: '#gamma' },
    ]);
    channelState.addChannel('#beta'); // only in #beta
    vi.advanceTimersByTime(30_000);
    const joinedChannels = client.joins.map((j) => j.channel);
    expect(joinedChannels).toContain('#alpha');
    expect(joinedChannels).not.toContain('#beta');
    expect(joinedChannels).toContain('#gamma');
    handle.stopPresenceCheck();
  });

  it('respects a custom interval', () => {
    const { client, handle } = setup([{ name: '#test' }], {
      channel_rejoin_interval_ms: 60_000,
    });
    vi.advanceTimersByTime(30_000);
    expect(client.joins).toHaveLength(0); // not yet
    vi.advanceTimersByTime(30_000); // 60s total
    expect(client.joins).toHaveLength(1);
    handle.stopPresenceCheck();
  });

  it('is disabled when interval is 0', () => {
    const { client, handle } = setup([{ name: '#test' }], {
      channel_rejoin_interval_ms: 0,
    });
    vi.advanceTimersByTime(120_000);
    expect(client.joins).toHaveLength(0);
    handle.stopPresenceCheck();
  });

  it('logs warn on first miss, debug on subsequent retries', () => {
    const { logger, handle } = setup([{ name: '#test' }]);
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Not in configured channel #test'),
    );

    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Retrying join for #test'));
    handle.stopPresenceCheck();
  });

  it('resets warning after successful rejoin then subsequent miss', () => {
    const { channelState, logger, handle } = setup([{ name: '#test' }]);

    // First miss — warn
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Not in configured channel #test'),
    );

    // Successful rejoin
    channelState.addChannel('#test');
    vi.advanceTimersByTime(30_000);

    // Lost again — should warn again, not debug
    channelState.removeChannel('#test');
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    vi.advanceTimersByTime(30_000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Not in configured channel #test'),
    );
    handle.stopPresenceCheck();
  });

  it('stopPresenceCheck() prevents further ticks', () => {
    const { client, handle } = setup([{ name: '#test' }]);
    handle.stopPresenceCheck();
    vi.advanceTimersByTime(120_000);
    expect(client.joins).toHaveLength(0);
  });

  it('stopPresenceCheck() is safe to call multiple times', () => {
    const { handle } = setup([{ name: '#test' }]);
    handle.stopPresenceCheck();
    handle.stopPresenceCheck(); // should not throw
  });

  // -------------------------------------------------------------------------
  // Bounded retry on permanent-failure channels (+b / +i / +k / +r)
  // -------------------------------------------------------------------------

  describe('bounded retry on permanent-failure', () => {
    it('skips retry until first backoff tier elapses, then attempts JOIN', () => {
      const { client, handle } = setup([{ name: '#banned' }], {
        channel_rejoin_interval_ms: 30_000,
        channel_retry_schedule_ms: [300_000, 900_000, 2_700_000],
      });
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      // Presence ticks during the 5-minute backoff: no JOIN attempts.
      vi.advanceTimersByTime(270_000);
      expect(client.joins).toHaveLength(0);

      // Just past the first tier (5 min from the failure): next tick retries.
      vi.advanceTimersByTime(60_000);
      expect(client.joins).toContainEqual({ channel: '#banned', key: undefined });

      handle.stopPresenceCheck();
    });

    it('advances through each backoff tier and then gives up', () => {
      const { client, handle } = setup([{ name: '#banned' }], {
        channel_rejoin_interval_ms: 30_000,
        channel_retry_schedule_ms: [300_000, 900_000, 2_700_000],
      });
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      // Tier 0 retry (5 min)
      vi.advanceTimersByTime(330_000);
      expect(client.joins).toHaveLength(1);

      // Tier 1 retry (15 min after the tier-0 retry)
      vi.advanceTimersByTime(900_000);
      expect(client.joins).toHaveLength(2);

      // Tier 2 retry (45 min after the tier-1 retry)
      vi.advanceTimersByTime(2_700_000);
      expect(client.joins).toHaveLength(3);

      // Exhausted: no further retries despite many presence ticks.
      vi.advanceTimersByTime(3_600_000);
      expect(client.joins).toHaveLength(3);

      handle.stopPresenceCheck();
    });

    it('does not reset tier when JOIN fails again during retry', () => {
      const { client, handle } = setup([{ name: '#banned' }], {
        channel_rejoin_interval_ms: 30_000,
        channel_retry_schedule_ms: [300_000, 900_000, 2_700_000],
      });
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      // Tier 0 retry fires and fails again — listener must not reset tier.
      vi.advanceTimersByTime(330_000);
      expect(client.joins).toHaveLength(1);
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });

      // If the tier were reset, the next retry would fire at +5 min. Verify
      // nothing fires inside the original tier-1 window (15 min).
      vi.advanceTimersByTime(600_000);
      expect(client.joins).toHaveLength(1);

      // After the full tier-1 delay, retry #2 fires as expected.
      vi.advanceTimersByTime(330_000);
      expect(client.joins).toHaveLength(2);

      handle.stopPresenceCheck();
    });

    it('clears the failure entry when the bot successfully joins', () => {
      const { client, channelState, handle } = setup([{ name: '#banned' }], {
        channel_rejoin_interval_ms: 30_000,
        channel_retry_schedule_ms: [300_000, 900_000, 2_700_000],
      });
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      // Simulate operator unban + manual rejoin before the first tier elapses.
      channelState.addChannel('#banned');
      vi.advanceTimersByTime(30_000);
      expect(client.joins).toHaveLength(0); // still in channel, no JOIN needed

      // Subsequent kick restarts the schedule from tier 0.
      channelState.removeChannel('#banned');
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });

      vi.advanceTimersByTime(270_000);
      expect(client.joins).toHaveLength(0);
      vi.advanceTimersByTime(60_000);
      expect(client.joins).toHaveLength(1);

      handle.stopPresenceCheck();
    });

    it('disables retry entirely when schedule is empty', () => {
      const { client, handle } = setup([{ name: '#banned' }], {
        channel_rejoin_interval_ms: 30_000,
        channel_retry_schedule_ms: [],
      });
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      vi.advanceTimersByTime(3_600_000);
      expect(client.joins).toHaveLength(0);

      handle.stopPresenceCheck();
    });

    it('uses default schedule when config is omitted', () => {
      const { client, handle } = setup([{ name: '#banned' }]);
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      client.joins = [];

      // Default first tier is 5 min.
      vi.advanceTimersByTime(270_000);
      expect(client.joins).toHaveLength(0);
      vi.advanceTimersByTime(60_000);
      expect(client.joins).toHaveLength(1);

      handle.stopPresenceCheck();
    });

    it('resets retry state on reconnect', () => {
      const client = new MockClient();
      const channelState = new MockChannelState();
      const logger = makeLogger();

      const deps: ConnectionLifecycleDeps = {
        client,
        config: makeConfig({
          channel_rejoin_interval_ms: 30_000,
          channel_retry_schedule_ms: [300_000, 900_000, 2_700_000],
        }),
        configuredChannels: [{ name: '#banned' }],
        eventBus: new BotEventBus(),
        applyCasemapping: vi.fn(),
        applyServerCapabilities: vi.fn(),
        messageQueue: { clear: vi.fn() },
        dispatcher: { bind: vi.fn() },
        logger,
        channelState,
        reconnectDriver: makeStubDriver(),
      };

      const handle = registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });
      // Advance through tier 0 and tier 1 so the entry is mid-schedule
      // (tier 2 pending) before the reconnect.
      vi.advanceTimersByTime(330_000); // tier 0 fires
      vi.advanceTimersByTime(930_000); // tier 1 fires

      // Reconnect: clears the permanent-failure map. The normal presence
      // check will JOIN on its next tick — that's expected and desired.
      client.emit('registered');
      client.joins = [];

      // New failure after reconnect must start from tier 0 (5 min), not
      // tier 2 (45 min). If state leaked, we'd wait 45 min before retry.
      client.emit('irc error', { error: 'banned_from_channel', channel: '#banned' });

      // At tier 0's boundary (5 min), a retry fires.
      vi.advanceTimersByTime(270_000);
      const joinsBeforeTier0 = client.joins.length;
      vi.advanceTimersByTime(60_000);
      expect(client.joins.length).toBeGreaterThan(joinsBeforeTier0);

      handle.stopPresenceCheck();
    });
  });

  it('restarts the timer on reconnect (second registered event)', () => {
    const client = new MockClient();
    const channelState = new MockChannelState();
    const logger = makeLogger();

    const deps: ConnectionLifecycleDeps = {
      client,
      config: makeConfig({ channel_rejoin_interval_ms: 10_000 }),
      configuredChannels: [{ name: '#test' }],
      eventBus: new BotEventBus(),
      applyCasemapping: vi.fn(),
      applyServerCapabilities: vi.fn(),
      messageQueue: { clear: vi.fn() },
      dispatcher: { bind: vi.fn() },
      logger,
      channelState,
      reconnectDriver: makeStubDriver(),
    };

    const handle = registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    // First connect
    client.emit('registered');
    client.joins = [];

    // Advance partway through the interval
    vi.advanceTimersByTime(5_000);
    expect(client.joins).toHaveLength(0);

    // Reconnect — timer resets
    client.emit('registered');
    client.joins = [];

    // 5s after reconnect — old timer would have fired at this point but was cleared
    vi.advanceTimersByTime(5_000);
    expect(client.joins).toHaveLength(0);

    // 10s after reconnect — new timer fires
    vi.advanceTimersByTime(5_000);
    expect(client.joins).toHaveLength(1);

    handle.stopPresenceCheck();
  });
});
