import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ReconnectDriver,
  type ReconnectDriverConfig,
  createReconnectDriver,
} from '../../src/core/reconnect-driver';
import { BotEventBus } from '../../src/event-bus';
import { createMockLogger } from '../helpers/mock-logger';

const BASE_CONFIG: ReconnectDriverConfig = {
  transient_initial_ms: 1_000,
  transient_max_ms: 30_000,
  rate_limited_initial_ms: 300_000,
  rate_limited_max_ms: 1_800_000,
  jitter_ms: 0, // deterministic backoff in most tests
};

interface Harness {
  driver: ReconnectDriver;
  connect: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  eventBus: BotEventBus;
}

function makeHarness(configOverride: Partial<ReconnectDriverConfig> = {}): Harness {
  const connect = vi.fn();
  const exit = vi.fn();
  const eventBus = new BotEventBus();
  const driver = createReconnectDriver({
    connect,
    logger: createMockLogger(),
    eventBus,
    config: { ...BASE_CONFIG, ...configOverride },
    exit,
  });
  return { driver, connect, exit, eventBus };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReconnectDriver', () => {
  describe('transient tier', () => {
    it('schedules first retry at transient_initial_ms', () => {
      const { driver, connect } = makeHarness();
      driver.onDisconnect({ tier: 'transient' });
      expect(connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(connect).toHaveBeenCalledOnce();
    });

    it('doubles the delay on each consecutive failure until the cap', () => {
      const { driver, connect } = makeHarness();
      // 1s, 2s, 4s, 8s, 16s, 30s (cap), 30s (cap)
      const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (const delay of expected) {
        driver.onDisconnect({ tier: 'transient' });
        vi.advanceTimersByTime(delay - 1);
        expect(connect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(connect).toHaveBeenCalledOnce();
        connect.mockClear();
      }
    });

    it('keeps status at reconnecting regardless of failure count', () => {
      const { driver } = makeHarness();
      for (let i = 0; i < 10; i++) {
        driver.onDisconnect({ tier: 'transient' });
        expect(driver.getState().status).toBe('reconnecting');
        vi.advanceTimersByTime(config_max());
      }
    });
  });

  describe('rate-limited tier', () => {
    it('schedules first retry at rate_limited_initial_ms', () => {
      const { driver, connect } = makeHarness();
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      vi.advanceTimersByTime(299_999);
      expect(connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(connect).toHaveBeenCalledOnce();
    });

    it('doubles up to the cap at 3 doublings, then stays at max', () => {
      const { driver, connect } = makeHarness();
      // attempt 1: 300k; 2: 600k; 3: 1.2M; 4: cap 1.8M; 5: cap 1.8M
      const expected = [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000];
      for (const delay of expected) {
        driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
        vi.advanceTimersByTime(delay - 1);
        expect(connect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(connect).toHaveBeenCalledOnce();
        connect.mockClear();
      }
    });

    it('transitions to degraded after 3 consecutive failures', () => {
      const { driver } = makeHarness();
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      expect(driver.getState().status).toBe('reconnecting');
      vi.advanceTimersByTime(1_000_000);

      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      expect(driver.getState().status).toBe('reconnecting');
      vi.advanceTimersByTime(1_000_000);

      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      expect(driver.getState().status).toBe('degraded');
    });

    it('surfaces the label in state', () => {
      const { driver } = makeHarness();
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      expect(driver.getState().lastError).toBe('K-Lined');
      expect(driver.getState().lastErrorTier).toBe('rate-limited');
    });
  });

  describe('fatal tier', () => {
    it('calls exit with the policy code on the third consecutive fatal (W1.2 budget)', () => {
      const { driver, exit, eventBus } = makeHarness();
      const disconnectSpy = vi.fn();
      eventBus.on('bot:disconnected', disconnectSpy);

      const fatal = {
        tier: 'fatal' as const,
        label: 'SASL authentication failed',
        exitCode: 2,
      };
      // Under-budget — should treat as rate-limited.
      driver.onDisconnect(fatal);
      expect(exit).not.toHaveBeenCalled();
      driver.onDisconnect(fatal);
      expect(exit).not.toHaveBeenCalled();
      // Third fatal trips the budget and exits.
      driver.onDisconnect(fatal);

      expect(exit).toHaveBeenCalledWith(2);
      expect(disconnectSpy).toHaveBeenCalledWith('fatal: SASL authentication failed');
    });

    it('sets status to stopped on the third consecutive fatal', () => {
      const { driver } = makeHarness();
      const fatal = {
        tier: 'fatal' as const,
        label: 'SASL mechanism not supported',
        exitCode: 2,
      };
      driver.onDisconnect(fatal);
      driver.onDisconnect(fatal);
      driver.onDisconnect(fatal);
      expect(driver.getState().status).toBe('stopped');
    });

    it('treats under-budget fatals as rate-limited reconnects (W1.2)', () => {
      const { driver, connect, exit, eventBus } = makeHarness();
      const disconnectSpy = vi.fn();
      eventBus.on('bot:disconnected', disconnectSpy);

      driver.onDisconnect({
        tier: 'fatal',
        label: 'SASL authentication failed',
        exitCode: 2,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalledWith('fatal-budget: SASL authentication failed');
      expect(driver.getState().status).toBe('reconnecting');
      // Advance past rate-limited initial delay; the driver should retry.
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(connect).toHaveBeenCalled();
    });

    it('resets the fatal budget after a successful registration', () => {
      const { driver, exit } = makeHarness();
      const fatal = {
        tier: 'fatal' as const,
        label: 'SASL authentication failed',
        exitCode: 2,
      };
      driver.onDisconnect(fatal);
      driver.onDisconnect(fatal);
      // Recover, resetting the counter.
      driver.onConnected();
      // Two more fatals — still under the fresh budget of 3.
      driver.onDisconnect(fatal);
      driver.onDisconnect(fatal);
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('onConnected', () => {
    it('resets consecutiveFailures, attemptCount, lastError, status', () => {
      const { driver } = makeHarness();
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      driver.onDisconnect({ tier: 'rate-limited', label: 'K-Lined' });
      expect(driver.getState().status).toBe('degraded');
      expect(driver.getState().consecutiveFailures).toBe(3);

      driver.onConnected();
      const state = driver.getState();
      expect(state.status).toBe('connected');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.attemptCount).toBe(0);
      expect(state.lastError).toBe(null);
      expect(state.lastErrorTier).toBe(null);
      expect(state.nextAttemptAt).toBe(null);
    });

    it('cancels any pending retry timer', () => {
      const { driver, connect } = makeHarness();
      driver.onDisconnect({ tier: 'transient' });
      driver.onConnected();
      vi.advanceTimersByTime(60_000);
      expect(connect).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('clears the pending retry and sets status to stopped', () => {
      const { driver, connect } = makeHarness();
      driver.onDisconnect({ tier: 'transient' });
      driver.cancel();
      vi.advanceTimersByTime(60_000);
      expect(connect).not.toHaveBeenCalled();
      expect(driver.getState().status).toBe('stopped');
      expect(driver.getState().nextAttemptAt).toBe(null);
    });
  });

  describe('jitter', () => {
    it('adds a bounded random offset to the delay', () => {
      const { driver, connect } = makeHarness({ jitter_ms: 5_000 });
      // Force jitter to exactly 2500 by pinning Math.random to 0.5.
      // Base 1000 + jitter 2500 = 3500.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        driver.onDisconnect({ tier: 'transient' });
        vi.advanceTimersByTime(3_499);
        expect(connect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(connect).toHaveBeenCalledOnce();
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('never exceeds base + jitter_ms', () => {
      const { driver, connect } = makeHarness({ jitter_ms: 5_000 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
      try {
        driver.onDisconnect({ tier: 'transient' });
        // Max possible: 1000 + (floor(0.9999*5000)=4999) = 5999.
        vi.advanceTimersByTime(6_000);
        expect(connect).toHaveBeenCalledOnce();
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe('error handling', () => {
    it('logs and continues when the connect callback throws synchronously', () => {
      const { driver } = makeHarness();
      const badConnect = vi.fn(() => {
        throw new Error('DNS blew up');
      });
      // Swap in a driver with a throwing connect callback.
      const throwingDriver = createReconnectDriver({
        connect: badConnect,
        logger: createMockLogger(),
        eventBus: new BotEventBus(),
        config: BASE_CONFIG,
        exit: vi.fn(),
      });

      throwingDriver.onDisconnect({ tier: 'transient' });
      // Advance past the first retry — badConnect runs and throws.
      // The test passes if no unhandled error escapes the timer loop.
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      expect(badConnect).toHaveBeenCalledTimes(1);
      // State was NOT updated by the throw — the next onDisconnect would
      // re-schedule as usual. The driver no longer has a pending timer.
      expect(throwingDriver.getState().nextAttemptAt).toBe(null);
      // Reference the outer driver just so the linter sees it used.
      expect(driver).toBeDefined();
    });

    it('handles a non-Error thrown value', () => {
      const badConnect = vi.fn(() => {
        const notAnError: unknown = 'plain string failure';
        throw notAnError;
      });
      const throwingDriver = createReconnectDriver({
        connect: badConnect,
        logger: createMockLogger(),
        eventBus: new BotEventBus(),
        config: BASE_CONFIG,
        exit: vi.fn(),
      });
      throwingDriver.onDisconnect({ tier: 'transient' });
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      expect(badConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('nextAttemptAt', () => {
    it('is set to Date.now() + delay after onDisconnect', () => {
      const now = 1_000_000_000_000;
      vi.setSystemTime(now);
      const { driver } = makeHarness();
      driver.onDisconnect({ tier: 'transient' });
      expect(driver.getState().nextAttemptAt).toBe(now + 1_000);
    });

    it('is cleared after the scheduled connect fires', () => {
      const { driver } = makeHarness();
      driver.onDisconnect({ tier: 'transient' });
      vi.advanceTimersByTime(1_000);
      expect(driver.getState().nextAttemptAt).toBe(null);
    });
  });
});

function config_max(): number {
  return BASE_CONFIG.transient_max_ms + BASE_CONFIG.jitter_ms + 1;
}
