import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EventDispatcher,
  type FloodNoticeProvider,
  type PermissionsProvider,
} from '../../src/dispatcher';
import type { HandlerContext } from '../../src/types';

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'testuser',
    ident: 'user',
    hostname: 'test.host.com',
    channel: '#test',
    text: '!help',
    command: '!help',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

function makeNoticeProvider(): {
  provider: FloodNoticeProvider;
  sendNotice: ReturnType<typeof vi.fn>;
} {
  const sendNotice = vi.fn();
  return { provider: { sendNotice }, sendNotice };
}

describe('EventDispatcher — flood limiter', () => {
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatcher = new EventDispatcher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Disabled by default
  // ---------------------------------------------------------------------------

  it('is disabled when setFloodConfig() has not been called', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 20; i++) {
      const result = dispatcher.floodCheck('pub', 'user!u@host', ctx);
      expect(result).toEqual({ blocked: false, firstBlock: false });
    }
  });

  // ---------------------------------------------------------------------------
  // Below threshold
  // ---------------------------------------------------------------------------

  it('allows calls below the configured count threshold', () => {
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 5; i++) {
      const result = dispatcher.floodCheck('pub', 'user!u@host', ctx);
      expect(result.blocked).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Threshold hit on the (count+1)th call
  // ---------------------------------------------------------------------------

  it('blocks on the (count+1)th call and sets firstBlock=true', () => {
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 5; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    const result = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(result).toEqual({ blocked: true, firstBlock: true });
  });

  // ---------------------------------------------------------------------------
  // Subsequent blocked calls return firstBlock=false
  // ---------------------------------------------------------------------------

  it('returns firstBlock=false on subsequent blocked calls', () => {
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 6; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    const second = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(second).toEqual({ blocked: true, firstBlock: false });

    const third = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(third).toEqual({ blocked: true, firstBlock: false });
  });

  // ---------------------------------------------------------------------------
  // Notice sent exactly once per window
  // ---------------------------------------------------------------------------

  it('sends a notice exactly once per blocked window', () => {
    const { provider, sendNotice } = makeNoticeProvider();
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    dispatcher.setFloodNotice(provider);
    const ctx = makeCtx();

    for (let i = 0; i < 10; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    expect(sendNotice).toHaveBeenCalledOnce();
    expect(sendNotice).toHaveBeenCalledWith(
      'testuser',
      'You are sending commands too quickly. Please slow down.',
    );
  });

  // ---------------------------------------------------------------------------
  // Window expiry resets the limiter
  // ---------------------------------------------------------------------------

  it('resets after the window expires and sends a fresh notice on the next flood', () => {
    const { provider, sendNotice } = makeNoticeProvider();
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    dispatcher.setFloodNotice(provider);
    const ctx = makeCtx();

    // First flood — 6 calls
    for (let i = 0; i < 6; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }
    expect(sendNotice).toHaveBeenCalledOnce();

    // Advance past the 10-second window
    vi.advanceTimersByTime(11_000);

    // Next call after window: not blocked, clears warned state
    const afterExpiry = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(afterExpiry.blocked).toBe(false);

    // Second flood: notice fires again
    for (let i = 0; i < 6; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }
    expect(sendNotice).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Owner bypass
  // ---------------------------------------------------------------------------

  it('bypasses flood check for users with n flag', () => {
    const permissions: PermissionsProvider = {
      checkFlags: vi.fn().mockReturnValue(true), // always owner
    };
    dispatcher = new EventDispatcher(permissions);
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 20; i++) {
      const result = dispatcher.floodCheck('pub', 'owner!o@host', ctx);
      expect(result.blocked).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Non-owner is not bypassed
  // ---------------------------------------------------------------------------

  it('does not bypass flood for users without n flag', () => {
    const permissions: PermissionsProvider = {
      checkFlags: vi.fn().mockReturnValue(false), // never owner
    };
    dispatcher = new EventDispatcher(permissions);
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 6; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    const result = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(result.blocked).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // pub and msg counters are independent
  // ---------------------------------------------------------------------------

  it('pub and msg counters are independent', () => {
    dispatcher.setFloodConfig({
      pub: { count: 5, window: 10 },
      msg: { count: 5, window: 10 },
    });
    const ctx = makeCtx();

    // Flood pub
    for (let i = 0; i < 10; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    // msg should still be open
    for (let i = 0; i < 5; i++) {
      const result = dispatcher.floodCheck('msg', 'user!u@host', ctx);
      expect(result.blocked).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Different keys are independent
  // ---------------------------------------------------------------------------

  it('different hostmask keys are independent', () => {
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    // Flood first key
    for (let i = 0; i < 10; i++) {
      dispatcher.floodCheck('pub', 'spammer!s@evil.host', ctx);
    }

    // Second user should be unaffected
    for (let i = 0; i < 5; i++) {
      const result = dispatcher.floodCheck('pub', 'innocent!i@good.host', ctx);
      expect(result.blocked).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // No permissions provider: no bypass, flood fires normally
  // ---------------------------------------------------------------------------

  it('floods normally when no permissions provider is attached', () => {
    // dispatcher created without permissions (default)
    dispatcher.setFloodConfig({ pub: { count: 5, window: 10 } });
    const ctx = makeCtx();

    for (let i = 0; i < 6; i++) {
      dispatcher.floodCheck('pub', 'user!u@host', ctx);
    }

    const result = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(result.blocked).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Partial config: only pub specified, msg uses defaults
  // ---------------------------------------------------------------------------

  it('uses defaults for msg when only pub is configured', () => {
    dispatcher.setFloodConfig({ pub: { count: 2, window: 10 } });
    const ctx = makeCtx();

    // pub threshold is 2: 3rd call should block
    dispatcher.floodCheck('pub', 'user!u@host', ctx);
    dispatcher.floodCheck('pub', 'user!u@host', ctx);
    const pubResult = dispatcher.floodCheck('pub', 'user!u@host', ctx);
    expect(pubResult.blocked).toBe(true);

    // msg uses default count of 5: first 5 should not block
    for (let i = 0; i < 5; i++) {
      const result = dispatcher.floodCheck('msg', 'user!u@host', ctx);
      expect(result.blocked).toBe(false);
    }
  });
});

describe('EventDispatcher — per-plugin bind cap', () => {
  it('logs a warning at the soft cap and refuses binds past the hard cap', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };
    const dispatcher = new EventDispatcher(null, logger);
    const handler = () => {};

    // 500 binds takes us up to but not past the warn threshold.
    for (let i = 0; i < 500; i++) {
      dispatcher.bind('pubm', '-', `m${i}`, handler, 'noisy-plugin');
    }
    expect(logger.warn).not.toHaveBeenCalled();

    // 501st bind crosses the warn threshold and logs once.
    dispatcher.bind('pubm', '-', 'm500', handler, 'noisy-plugin');
    const warnCalls = logger.warn.mock.calls.filter((c) => String(c[0]).includes('warn threshold'));
    expect(warnCalls).toHaveLength(1);

    // Fast-forward to the hard cap. listBinds count is the source of truth.
    for (let i = 501; i < 1000; i++) {
      dispatcher.bind('pubm', '-', `m${i}`, handler, 'noisy-plugin');
    }
    expect(dispatcher.listBinds({ pluginId: 'noisy-plugin' })).toHaveLength(1000);

    // Past the hard cap: the new bind is refused and an error is logged.
    dispatcher.bind('pubm', '-', 'overflow', handler, 'noisy-plugin');
    expect(dispatcher.listBinds({ pluginId: 'noisy-plugin' })).toHaveLength(1000);
    const errorCalls = logger.error.mock.calls.filter((c) => String(c[0]).includes('hit bind cap'));
    expect(errorCalls).toHaveLength(1);

    // unbindAll resets the per-plugin tally so the plugin can re-register.
    dispatcher.unbindAll('noisy-plugin');
    expect(dispatcher.listBinds({ pluginId: 'noisy-plugin' })).toHaveLength(0);
    dispatcher.bind('pubm', '-', 'fresh', handler, 'noisy-plugin');
    expect(dispatcher.listBinds({ pluginId: 'noisy-plugin' })).toHaveLength(1);
  });

  it('recomputes per-plugin bind counts when a non-stackable type replaces a sibling plugin bind', () => {
    const dispatcher = new EventDispatcher();
    const handler = () => {};

    // Seed an unrelated bind on a different plugin so the recount loop has
    // an entry to walk after the non-stackable filter clears the replaced
    // one — without it the recount runs against an empty array.
    dispatcher.bind('pubm', '-', '*', handler, 'observer-plugin');

    // pub is non-stackable: a second `pub` on the same mask evicts the
    // first one. The evicted bind belonged to a different plugin, so the
    // dispatcher must recount or the original plugin's tally would stay
    // inflated forever.
    dispatcher.bind('pub', '-', '!hello', handler, 'plugin-a');
    expect(dispatcher.listBinds({ pluginId: 'plugin-a' })).toHaveLength(1);

    dispatcher.bind('pub', '-', '!hello', handler, 'plugin-b');
    expect(dispatcher.listBinds({ pluginId: 'plugin-a' })).toHaveLength(0);
    expect(dispatcher.listBinds({ pluginId: 'plugin-b' })).toHaveLength(1);
    // observer-plugin's bind survived and its tally is intact.
    expect(dispatcher.listBinds({ pluginId: 'observer-plugin' })).toHaveLength(1);
  });

  it('clearFloodState resets per-key flood state', () => {
    const dispatcher = new EventDispatcher();
    expect(() => dispatcher.clearFloodState()).not.toThrow();
  });

  it('warns when a time bind is registered with non-empty flags', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };
    const dispatcher = new EventDispatcher(null, logger);
    dispatcher.bind('time', '+m', '60', () => {}, 'flagged-timer');
    const warnCalls = logger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('timer binds ignore flags'),
    );
    expect(warnCalls).toHaveLength(1);
  });
});

describe('EventDispatcher — auto-disabled timer binds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('splices an auto-disabled timer bind out of binds[] after the failure threshold', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };
    const dispatcher = new EventDispatcher(null, logger);

    let calls = 0;
    const failingTimer = (): void => {
      calls++;
      throw new Error('boom');
    };

    dispatcher.bind('time', '-', '10', failingTimer, 'flaky-plugin');
    expect(dispatcher.listBinds({ pluginId: 'flaky-plugin' })).toHaveLength(1);

    // 10 failures crosses TIMER_FAILURE_THRESHOLD; the dispatcher clears the
    // interval AND splices the entry out so it can't show up as a zombie.
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(10_000);
      // Allow any microtasks scheduled by the dispatcher's promise plumbing
      // to settle before the next tick.
      await Promise.resolve();
    }

    expect(calls).toBeGreaterThanOrEqual(10);
    expect(dispatcher.listBinds({ pluginId: 'flaky-plugin' })).toHaveLength(0);
  });
});
