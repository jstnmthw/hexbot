import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConnectionLifecycleDeps,
  type ConnectionLifecycleHandle,
  type LifecycleIRCClient,
  registerConnectionEvents,
} from '../../src/core/connection-lifecycle';
import { BotEventBus } from '../../src/event-bus';
import type { Logger } from '../../src/logger';
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
  logger: Logger;
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
    vi.useFakeTimers();
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
