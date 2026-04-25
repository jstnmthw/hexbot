// Stress test — drives 50 disconnect/reconnect cycles through the real
// connection-lifecycle + reconnect-driver stack to catch listener
// accumulation or orphaned timers before they show up in production.
//
// This is a stability test, not a memory test: we assert that listener
// counts are stable and that vi.getTimerCount() returns to zero after
// shutdown. Heap-growth assertions are intentionally not included —
// under fake timers the memory picture is noisy and produces flaky CI.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConnectionLifecycleDeps,
  type LifecycleIRCClient,
  registerConnectionEvents,
} from '../../src/core/connection-lifecycle';
import { createReconnectDriver } from '../../src/core/reconnect-driver';
import { BotEventBus } from '../../src/event-bus';
import { createMockLogger } from '../helpers/mock-logger';

class StressClient extends EventEmitter implements LifecycleIRCClient {
  public joins: Array<{ channel: string; key?: string }> = [];
  public network: LifecycleIRCClient['network'] = {
    supports: (_feature: string): unknown => 'rfc1459',
    cap: { available: new Map<string, string>(), enabled: [] },
  };
  join(channel: string, key?: string): void {
    this.joins.push({ channel, key });
  }
  quit(_message?: string): void {
    // Simulate closing the connection
    this.emit('close');
  }
}

describe('reconnect stress (50 cycles)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps listener counts stable and leaks no timers across 50 cycles', () => {
    const client = new StressClient();
    const eventBus = new BotEventBus();
    const logger = createMockLogger();
    const connect = vi.fn(() => {
      // Simulate a synchronous "reconnect" — the driver fires this from a
      // setTimeout, so calling it repeatedly is equivalent to the real client
      // re-opening a socket. We don't actually run connect() on the client.
    });

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
      exit: () => {
        throw new Error('exit should not be called in this test');
      },
    });

    const deps: ConnectionLifecycleDeps = {
      client,
      config: {
        irc: {
          host: 'irc.example.com',
          port: 6697,
          tls: false,
          nick: 'stress',
          username: 'stress',
          realname: 'stress',
          channels: [],
        },
        owner: { handle: 'admin', hostmask: '*!*@localhost' },
        identity: { method: 'hostmask', require_acc_for: [] },
        services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
        database: ':memory:',
        pluginDir: './plugins',
        logging: { level: 'info', mod_actions: false },
      },
      configuredChannels: [],
      eventBus,
      applyCasemapping: () => {},
      applyServerCapabilities: () => {},
      messageQueue: { clear: () => {} },
      dispatcher: { bind: () => {} },
      logger,
      reconnectDriver: driver,
    };

    const handle = registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    const baselineListeners = {
      registered: client.listenerCount('registered'),
      close: client.listenerCount('close'),
      ircError: client.listenerCount('irc error'),
      socketError: client.listenerCount('socket error'),
      unknownCommand: client.listenerCount('unknown command'),
    };

    // Drive 50 cycles: registered → close → (driver schedules retry) →
    // advance timers so the retry fires → registered → ...
    for (let i = 0; i < 50; i++) {
      client.emit('registered');
      client.emit('close');
      // Driver is holding a transient retry timer. Advance past the cap
      // so it fires and the loop can continue.
      vi.advanceTimersByTime(35_000);
    }

    // After 50 cycles, listener counts on the client must match the baseline.
    expect(client.listenerCount('registered')).toBe(baselineListeners.registered);
    expect(client.listenerCount('close')).toBe(baselineListeners.close);
    expect(client.listenerCount('irc error')).toBe(baselineListeners.ircError);
    expect(client.listenerCount('socket error')).toBe(baselineListeners.socketError);
    expect(client.listenerCount('unknown command')).toBe(baselineListeners.unknownCommand);

    // The driver called connect() 50 times (once per retry cycle).
    expect(connect).toHaveBeenCalledTimes(50);

    // Final connected state — driver must be idle, no pending timer.
    client.emit('registered');
    expect(driver.getState().status).toBe('connected');
    expect(driver.getState().nextAttemptAt).toBe(null);

    // Shutdown path: listeners cleared, driver canceled, no timers remain.
    handle.stopPresenceCheck();
    handle.cancelReconnect();
    handle.removeListeners();

    expect(client.listenerCount('registered')).toBe(0);
    expect(client.listenerCount('close')).toBe(0);
    expect(client.listenerCount('irc error')).toBe(0);
    expect(client.listenerCount('socket error')).toBe(0);
    // vi.getTimerCount() = 0 confirms we have no orphaned fake-timers
    // sitting in the queue after teardown.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel() during a pending rate-limited retry leaves no orphaned timers', () => {
    const client = new StressClient();
    const eventBus = new BotEventBus();
    const logger = createMockLogger();
    const connect = vi.fn();
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
      exit: () => {
        throw new Error('exit should not be called');
      },
    });

    const deps: ConnectionLifecycleDeps = {
      client,
      config: {
        irc: {
          host: 'irc.example.com',
          port: 6697,
          tls: false,
          nick: 'stress',
          username: 'stress',
          realname: 'stress',
          channels: [],
        },
        owner: { handle: 'admin', hostmask: '*!*@localhost' },
        identity: { method: 'hostmask', require_acc_for: [] },
        services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
        database: ':memory:',
        pluginDir: './plugins',
        logging: { level: 'info', mod_actions: false },
      },
      configuredChannels: [],
      eventBus,
      applyCasemapping: () => {},
      applyServerCapabilities: () => {},
      messageQueue: { clear: () => {} },
      dispatcher: { bind: () => {} },
      logger,
      reconnectDriver: driver,
    };

    const handle = registerConnectionEvents(
      deps,
      () => {},
      () => {},
    );

    client.emit('registered');
    client.emit('irc error', { error: 'irc', reason: 'Closing Link: K-Lined' });
    client.emit('close');

    expect(driver.getState().status).toBe('reconnecting');
    expect(driver.getState().nextAttemptAt).not.toBe(null);

    handle.cancelReconnect();
    handle.removeListeners();
    handle.stopPresenceCheck();

    expect(vi.getTimerCount()).toBe(0);
    expect(driver.getState().status).toBe('stopped');

    // Advance far past the would-be retry — connect() must not fire.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connect).not.toHaveBeenCalled();
  });
});
