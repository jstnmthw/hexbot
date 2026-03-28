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
