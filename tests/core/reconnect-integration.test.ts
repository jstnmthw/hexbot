// End-to-end reconnect scenarios against the real connection-lifecycle +
// reconnect-driver stack. Each test emits IRC events on a mock client,
// advances fake timers, and asserts the driver state + connect call count.
//
// The most important test in this file is "Scenario 2" below — it
// reproduces the 2026-04-13 production incident (registration timeout
// mid-reconnect) which left HexBot as a zombie process.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConnectionLifecycleDeps,
  type LifecycleIRCClient,
  registerConnectionEvents,
} from '../../src/core/connection-lifecycle';
import { type ReconnectDriver, createReconnectDriver } from '../../src/core/reconnect-driver';
import { BotEventBus } from '../../src/event-bus';
import type { BotConfig } from '../../src/types';
import { createMockLogger } from '../helpers/mock-logger';

class IntegrationClient extends EventEmitter implements LifecycleIRCClient {
  public joins: Array<{ channel: string; key?: string }> = [];
  public network: LifecycleIRCClient['network'] = {
    supports: (_feature: string): unknown => 'rfc1459',
    cap: { available: new Map<string, string>(), enabled: [] },
  };
  join(channel: string, key?: string): void {
    this.joins.push({ channel, key });
  }
}

const CFG: BotConfig = {
  irc: {
    host: 'irc.example.com',
    port: 6697,
    tls: false,
    nick: 'hexbot',
    username: 'hexbot',
    realname: 'hexbot',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

interface Harness {
  client: IntegrationClient;
  eventBus: BotEventBus;
  driver: ReconnectDriver;
  connect: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  deps: ConnectionLifecycleDeps;
}

function makeHarness(): Harness {
  const client = new IntegrationClient();
  const eventBus = new BotEventBus();
  const logger = createMockLogger();
  const connect = vi.fn();
  const exit = vi.fn();
  const driver = createReconnectDriver({
    connect,
    logger,
    eventBus,
    config: {
      transient_initial_ms: 1_000,
      transient_max_ms: 30_000,
      rate_limited_initial_ms: 300_000,
      rate_limited_max_ms: 1_800_000,
      jitter_ms: 0,
    },
    exit,
  });
  const deps: ConnectionLifecycleDeps = {
    client,
    config: CFG,
    configuredChannels: [],
    eventBus,
    applyCasemapping: () => {},
    applyServerCapabilities: () => {},
    messageQueue: { clear: () => {} },
    dispatcher: { bind: () => {} },
    logger,
    reconnectDriver: driver,
  };
  return { client, eventBus, driver, connect, exit, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnect integration', () => {
  it('Scenario 1: transient disconnect → reconnect', () => {
    const { client, driver, connect, deps } = makeHarness();
    registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    client.emit('registered');
    expect(driver.getState().status).toBe('connected');

    client.emit('close');
    expect(driver.getState().status).toBe('reconnecting');
    expect(driver.getState().lastErrorTier).toBe('transient');

    vi.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // Simulate the re-opened connection reaching registered.
    client.emit('registered');
    expect(driver.getState().status).toBe('connected');
    expect(driver.getState().consecutiveFailures).toBe(0);
  });

  it('Scenario 2: registration timeout mid-reconnect does NOT zombie the bot (2026-04-13 regression)', () => {
    const { client, driver, connect, deps } = makeHarness();
    registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    // Initial successful registration.
    client.emit('registered');

    // First disconnect — will schedule a transient retry.
    client.emit('close');
    expect(driver.getState().status).toBe('reconnecting');

    // Timer fires and driver calls connect(). The "reconnect attempt"
    // reaches TCP-connected but the server tears it down during
    // registration — simulate by emitting a Closing Link error and close,
    // WITHOUT an intervening 'registered' event.
    vi.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    client.emit('irc error', {
      error: 'irc',
      reason: 'Closing Link: hexbot (Registration timed out)',
    });
    client.emit('close');

    // The driver MUST still be scheduling retries. In the old code path
    // the bot went zombie here (registered=true from the initial session,
    // expectingReconnect=false because 'reconnecting' never fires with
    // auto_reconnect:false, no retry ever scheduled).
    expect(driver.getState().status).toBe('reconnecting');
    expect(driver.getState().lastErrorTier).toBe('transient');
    expect(driver.getState().nextAttemptAt).not.toBe(null);

    // Advance past the doubled backoff — retry fires.
    vi.advanceTimersByTime(10_000);
    expect(connect).toHaveBeenCalledTimes(2);

    // Successful re-registration finally.
    client.emit('registered');
    expect(driver.getState().status).toBe('connected');
  });

  it('Scenario 3: K-line → rate-limited with indefinite retry + degraded state', () => {
    const { client, driver, connect, deps } = makeHarness();
    registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    client.emit('registered');

    // First K-line
    client.emit('irc error', {
      error: 'irc',
      reason: 'Closing Link: 1.2.3.4 (K-Lined: spam)',
    });
    client.emit('close');
    expect(driver.getState().lastErrorTier).toBe('rate-limited');
    expect(driver.getState().lastError).toBe('K-Lined');
    expect(driver.getState().status).toBe('reconnecting');

    // Advance past 5min backoff — retry fires
    vi.advanceTimersByTime(300_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // Second K-line — doubles to ~10min
    client.emit('irc error', {
      error: 'irc',
      reason: 'Closing Link: 1.2.3.4 (K-Lined: spam)',
    });
    client.emit('close');
    expect(driver.getState().consecutiveFailures).toBe(2);
    expect(driver.getState().status).toBe('reconnecting');
    vi.advanceTimersByTime(600_000);
    expect(connect).toHaveBeenCalledTimes(2);

    // Third K-line — driver transitions to degraded
    client.emit('irc error', {
      error: 'irc',
      reason: 'Closing Link: 1.2.3.4 (K-Lined: spam)',
    });
    client.emit('close');
    expect(driver.getState().status).toBe('degraded');
    expect(driver.getState().consecutiveFailures).toBe(3);
    vi.advanceTimersByTime(1_200_000);
    expect(connect).toHaveBeenCalledTimes(3);

    // 4th retry — this time the server lets us back in
    client.emit('registered');
    expect(driver.getState().status).toBe('connected');
    expect(driver.getState().consecutiveFailures).toBe(0);
  });

  it('Scenario 4: SASL authentication failed → fatal exit', () => {
    const { client, driver, connect, exit, eventBus, deps } = makeHarness();
    const disconnectHandler = vi.fn();
    eventBus.on('bot:disconnected', disconnectHandler);
    registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    client.emit('irc error', {
      error: 'irc',
      reason: 'SASL authentication failed',
    });
    client.emit('close');

    expect(exit).toHaveBeenCalledWith(2);
    expect(driver.getState().status).toBe('stopped');
    expect(disconnectHandler).toHaveBeenCalledWith(
      expect.stringContaining('fatal: SASL authentication failed'),
    );

    // Advance an hour — NO retry ever scheduled.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connect).not.toHaveBeenCalled();
  });

  it('Scenario 5: initial connection failure takes the same retry loop', () => {
    const { client, driver, connect, deps } = makeHarness();
    registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    // Never emit 'registered' — simulate initial TCP failure via socket error + close.
    client.emit('socket error', new Error('ECONNREFUSED'));
    client.emit('close');

    expect(driver.getState().status).toBe('reconnecting');
    expect(driver.getState().lastErrorTier).toBe('transient');

    vi.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // Second attempt succeeds.
    client.emit('registered');
    expect(driver.getState().status).toBe('connected');
  });

  it('Scenario 6: cancel during rate-limited wait prevents any later retry', () => {
    const { client, driver, connect, deps } = makeHarness();
    const handle = registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    client.emit('irc error', {
      error: 'irc',
      reason: 'Closing Link: K-Lined',
    });
    client.emit('close');
    expect(driver.getState().status).toBe('reconnecting');
    expect(driver.getState().nextAttemptAt).not.toBe(null);

    // Shutdown before the 5-minute retry window elapses.
    handle.cancelReconnect();
    handle.removeListeners();
    handle.stopPresenceCheck();

    expect(driver.getState().status).toBe('stopped');

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
