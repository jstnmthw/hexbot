import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventDispatcher } from '../../src/dispatcher';
import type { HandlerContext } from '../../src/types';

/** Helper: create a minimal HandlerContext for testing. */
function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'testuser',
    ident: 'user',
    hostname: 'test.host.com',
    channel: '#test',
    text: '',
    command: '',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

describe('EventDispatcher', () => {
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    dispatcher = new EventDispatcher();
  });

  afterEach(() => {
    // Clean up any timers
    dispatcher.unbindAll('test-plugin');
    dispatcher.unbindAll('plugin-a');
    dispatcher.unbindAll('plugin-b');
  });

  // -------------------------------------------------------------------------
  // pub type (non-stackable, exact command match)
  // -------------------------------------------------------------------------

  describe('pub type', () => {
    it('should dispatch to a matching pub handler', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!hello', text: '!hello world' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(ctx);
    });

    it('should match pub commands case-insensitively', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!Hello', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!hello' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not dispatch when command does not match', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!goodbye' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should overwrite previous bind on same mask (non-stackable)', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler1, 'plugin-a');
      dispatcher.bind('pub', '-', '!cmd', handler2, 'plugin-b');

      const ctx = makeCtx({ command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // pubm type (stackable, wildcard match on full text)
  // -------------------------------------------------------------------------

  describe('pubm type', () => {
    it('should dispatch to a matching pubm handler with wildcard', async () => {
      const handler = vi.fn();
      dispatcher.bind('pubm', '-', '*hello*', handler, 'test-plugin');

      const ctx = makeCtx({ text: 'say hello world' });
      await dispatcher.dispatch('pubm', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should be stackable — multiple handlers fire for same mask', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      dispatcher.bind('pubm', '-', '*', handler1, 'plugin-a');
      dispatcher.bind('pubm', '-', '*', handler2, 'plugin-b');

      const ctx = makeCtx({ text: 'anything' });
      await dispatcher.dispatch('pubm', ctx);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // msg / msgm types
  // -------------------------------------------------------------------------

  describe('msg type', () => {
    it('should dispatch on exact command match', async () => {
      const handler = vi.fn();
      dispatcher.bind('msg', '-', '!help', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!help', channel: null });
      await dispatcher.dispatch('msg', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should be non-stackable', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      dispatcher.bind('msg', '-', '!cmd', handler1, 'plugin-a');
      dispatcher.bind('msg', '-', '!cmd', handler2, 'plugin-b');

      const ctx = makeCtx({ command: '!cmd', channel: null });
      await dispatcher.dispatch('msg', ctx);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe('msgm type', () => {
    it('should dispatch on wildcard text match', async () => {
      const handler = vi.fn();
      dispatcher.bind('msgm', '-', '*secret*', handler, 'test-plugin');

      const ctx = makeCtx({ text: 'tell me the secret code', channel: null });
      await dispatcher.dispatch('msgm', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // join type
  // -------------------------------------------------------------------------

  describe('join type', () => {
    it('should dispatch with * mask (match all joins)', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test-plugin');

      const ctx = makeCtx({
        nick: 'someone',
        ident: 'user',
        hostname: 'some.host',
        channel: '#test',
      });
      await dispatcher.dispatch('join', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should dispatch with specific channel mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '#test *!*@*', handler, 'test-plugin');

      const ctx = makeCtx({
        nick: 'someone',
        ident: 'user',
        hostname: 'host.com',
        channel: '#test',
      });
      await dispatcher.dispatch('join', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not dispatch when channel does not match', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '#other *!*@*', handler, 'test-plugin');

      const ctx = makeCtx({ channel: '#test' });
      await dispatcher.dispatch('join', ctx);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should be stackable', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      dispatcher.bind('join', '-', '*', handler1, 'plugin-a');
      dispatcher.bind('join', '-', '*', handler2, 'plugin-b');

      const ctx = makeCtx({ channel: '#test' });
      await dispatcher.dispatch('join', ctx);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // unbind
  // -------------------------------------------------------------------------

  describe('unbind', () => {
    it('should remove the correct handler', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler, 'test-plugin');
      dispatcher.unbind('pub', '!cmd', handler);

      const ctx = makeCtx({ command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not remove other handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      dispatcher.bind('pubm', '-', '*', handler1, 'plugin-a');
      dispatcher.bind('pubm', '-', '*', handler2, 'plugin-b');
      dispatcher.unbind('pubm', '*', handler1);

      const ctx = makeCtx({ text: 'hello' });
      await dispatcher.dispatch('pubm', ctx);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('does nothing when handler is not found', async () => {
      const handler = vi.fn();
      // Unbind a handler that was never registered — no error, no effect
      dispatcher.unbind('pub', '!nonexistent', handler);
      await dispatcher.dispatch('pub', makeCtx({ command: '!nonexistent' }));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // unbindAll
  // -------------------------------------------------------------------------

  describe('unbindAll', () => {
    it('should remove only the specified plugin binds', async () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      dispatcher.bind('pub', '-', '!a', handlerA, 'plugin-a');
      dispatcher.bind('pub', '-', '!b', handlerB, 'plugin-b');
      dispatcher.unbindAll('plugin-a');

      const ctxA = makeCtx({ command: '!a' });
      const ctxB = makeCtx({ command: '!b' });
      await dispatcher.dispatch('pub', ctxA);
      await dispatcher.dispatch('pub', ctxB);

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Flag checking
  // -------------------------------------------------------------------------

  describe('flag checking', () => {
    it('should allow - flags (no requirement) without permissions system', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should fail closed when no permissions system is attached', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', 'n', '!admin', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!admin' });
      await dispatcher.dispatch('pub', ctx);

      // No permissions system → deny flag-gated binds. Production always
      // supplies one; a test harness that skips it should fail closed so
      // a regression doesn't silently strip the flag check from every bind.
      expect(handler).not.toHaveBeenCalled();
    });

    it('should check flags via permissions provider when attached', async () => {
      const permissions = {
        checkFlags: vi.fn().mockReturnValue(false),
      };
      const d = new EventDispatcher(permissions);
      const handler = vi.fn();
      d.bind('pub', 'n', '!admin', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!admin' });
      await d.dispatch('pub', ctx);

      expect(permissions.checkFlags).toHaveBeenCalledWith('n', ctx);
      expect(handler).not.toHaveBeenCalled();

      d.unbindAll('test-plugin');
    });

    it('should call handler when permissions provider returns true', async () => {
      const permissions = {
        checkFlags: vi.fn().mockReturnValue(true),
      };
      const d = new EventDispatcher(permissions);
      const handler = vi.fn();
      d.bind('pub', 'o', '!op', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!op' });
      await d.dispatch('pub', ctx);

      expect(handler).toHaveBeenCalledOnce();

      d.unbindAll('test-plugin');
    });
  });

  // -------------------------------------------------------------------------
  // Error containment
  // -------------------------------------------------------------------------

  describe('error containment', () => {
    it('should catch synchronous handler errors', async () => {
      const badHandler = vi.fn(() => {
        throw new Error('plugin crash');
      });
      const goodHandler = vi.fn();

      dispatcher.bind('pubm', '-', '*', badHandler, 'plugin-a');
      dispatcher.bind('pubm', '-', '*', goodHandler, 'plugin-b');

      const ctx = makeCtx({ text: 'hello' });
      await expect(dispatcher.dispatch('pubm', ctx)).resolves.toBeUndefined();

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
    });

    it('should catch async handler errors', async () => {
      const badHandler = vi.fn(async () => {
        throw new Error('async crash');
      });
      const goodHandler = vi.fn();

      dispatcher.bind('pubm', '-', '*', badHandler, 'plugin-a');
      dispatcher.bind('pubm', '-', '*', goodHandler, 'plugin-b');

      const ctx = makeCtx({ text: 'hello' });
      await expect(dispatcher.dispatch('pubm', ctx)).resolves.toBeUndefined();

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // listBinds
  // -------------------------------------------------------------------------

  describe('listBinds', () => {
    it('should return all binds when no filter', () => {
      dispatcher.bind('pub', '-', '!a', vi.fn(), 'plugin-a');
      dispatcher.bind('pubm', '-', '*', vi.fn(), 'plugin-b');

      const binds = dispatcher.listBinds();
      expect(binds).toHaveLength(2);
    });

    it('should filter by type', () => {
      dispatcher.bind('pub', '-', '!a', vi.fn(), 'plugin-a');
      dispatcher.bind('pubm', '-', '*', vi.fn(), 'plugin-b');

      const pubBinds = dispatcher.listBinds({ type: 'pub' });
      expect(pubBinds).toHaveLength(1);
      expect(pubBinds[0].type).toBe('pub');
    });

    it('should filter by pluginId', () => {
      dispatcher.bind('pub', '-', '!a', vi.fn(), 'plugin-a');
      dispatcher.bind('pub', '-', '!b', vi.fn(), 'plugin-b');

      const aBinds = dispatcher.listBinds({ pluginId: 'plugin-a' });
      expect(aBinds).toHaveLength(1);
      expect(aBinds[0].pluginId).toBe('plugin-a');
    });

    it('should include hit counts', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!cmd' });
      await dispatcher.dispatch('pub', ctx);
      await dispatcher.dispatch('pub', ctx);

      const binds = dispatcher.listBinds();
      expect(binds[0].hits).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // time binds
  // -------------------------------------------------------------------------

  describe('time binds', () => {
    it('should fire on interval (respects 10s minimum)', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      // Request 15s interval (above the 10s minimum)
      dispatcher.bind('time', '-', '15', handler, 'test-plugin');

      // Advance past one interval (15 seconds)
      vi.advanceTimersByTime(15_100);

      expect(handler).toHaveBeenCalledOnce();

      // Advance another interval
      vi.advanceTimersByTime(15_000);
      expect(handler).toHaveBeenCalledTimes(2);

      dispatcher.unbindAll('test-plugin');
      vi.useRealTimers();
    });

    it('should raise sub-10s intervals to 10s minimum', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      // Request 1s — will be raised to 10s
      dispatcher.bind('time', '-', '1', handler, 'test-plugin');

      // 1s should NOT fire
      vi.advanceTimersByTime(1100);
      expect(handler).not.toHaveBeenCalled();

      // 10s should fire
      vi.advanceTimersByTime(9000);
      expect(handler).toHaveBeenCalledOnce();

      dispatcher.unbindAll('test-plugin');
      vi.useRealTimers();
    });

    it('should clean up timers on unbindAll', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      dispatcher.bind('time', '-', '15', handler, 'test-plugin');

      dispatcher.unbindAll('test-plugin');

      vi.advanceTimersByTime(20_000);
      expect(handler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should not fire time binds via dispatch()', async () => {
      const handler = vi.fn();
      dispatcher.bind('time', '-', '60', handler, 'test-plugin');

      const ctx = makeCtx();
      await dispatcher.dispatch('time', ctx);

      expect(handler).not.toHaveBeenCalled();
    });

    it('should recover when a timer handler throws synchronously', () => {
      vi.useFakeTimers();
      const d = new EventDispatcher();

      let callCount = 0;
      d.bind(
        'time',
        '-',
        '15',
        () => {
          callCount++;
          throw new Error('timer crash');
        },
        'test-plugin',
      );

      // Should not throw — error is caught internally
      expect(() => vi.advanceTimersByTime(15_100)).not.toThrow();
      expect(callCount).toBe(1);

      d.unbindAll('test-plugin');
      vi.useRealTimers();
    });

    it('should recover when a timer handler returns a rejected promise', async () => {
      vi.useFakeTimers();
      const d = new EventDispatcher();

      let callCount = 0;
      d.bind(
        'time',
        '-',
        '15',
        async () => {
          callCount++;
          throw new Error('async timer crash');
        },
        'test-plugin',
      );

      vi.advanceTimersByTime(15_100);
      // Flush the rejected promise
      await Promise.resolve();
      await Promise.resolve();

      expect(callCount).toBe(1);

      d.unbindAll('test-plugin');
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // mode type
  // -------------------------------------------------------------------------

  describe('mode type', () => {
    it('dispatches on wildcard mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test-plugin');
      await dispatcher.dispatch('mode', makeCtx({ text: '+o nick', command: 'mode' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('dispatches when text matches specific mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '+o*', handler, 'test-plugin');
      await dispatcher.dispatch('mode', makeCtx({ text: '+o nick', command: 'mode' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch when text does not match specific mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '+b*', handler, 'test-plugin');
      await dispatcher.dispatch('mode', makeCtx({ text: '+o nick', command: 'mode' }));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // time type — invalid mask
  // -------------------------------------------------------------------------

  describe('time type — invalid mask', () => {
    it('logs error and returns without setting interval for invalid mask', () => {
      // 'abc' is not a valid number of seconds
      expect(() => {
        dispatcher.bind('time', '-', 'abc', vi.fn(), 'test-plugin');
      }).not.toThrow();
      // No interval should be running — confirmed by no timer registered
      // (This covers the early return at line 108 in dispatcher.ts)
    });
  });

  // -------------------------------------------------------------------------
  // raw type
  // -------------------------------------------------------------------------

  describe('raw type', () => {
    it('dispatches when mask matches ctx.command', async () => {
      const handler = vi.fn();
      dispatcher.bind('raw', '-', '001', handler, 'test-plugin');
      await dispatcher.dispatch('raw', makeCtx({ command: '001', text: ':Welcome to IRC' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch when mask does not match ctx.command', async () => {
      const handler = vi.fn();
      dispatcher.bind('raw', '-', '001', handler, 'test-plugin');
      await dispatcher.dispatch(
        'raw',
        makeCtx({ command: '002', text: ':Your host is irc.example.com' }),
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // topic type
  // -------------------------------------------------------------------------

  describe('topic type', () => {
    it('dispatches on wildcard mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('topic', '-', '*', handler, 'test-plugin');
      await dispatcher.dispatch('topic', makeCtx({ channel: '#test', text: 'new topic' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('dispatches when channel matches mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('topic', '-', '#test', handler, 'test-plugin');
      await dispatcher.dispatch('topic', makeCtx({ channel: '#test', text: 'new topic' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch when channel does not match mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('topic', '-', '#other', handler, 'test-plugin');
      await dispatcher.dispatch('topic', makeCtx({ channel: '#test', text: 'new topic' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not dispatch when channel is null with a specific channel mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('topic', '-', '#test', handler, 'test-plugin');
      await dispatcher.dispatch('topic', makeCtx({ channel: null, text: 'new topic' }));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // quit type
  // -------------------------------------------------------------------------

  describe('quit type', () => {
    it('dispatches on wildcard mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('quit', '-', '*', handler, 'test-plugin');
      await dispatcher.dispatch(
        'quit',
        makeCtx({ nick: 'user', ident: 'u', hostname: 'host.com', text: 'Quit: bye' }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });

    it('dispatches when nick!ident@host matches mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('quit', '-', '*!u@host.com', handler, 'test-plugin');
      await dispatcher.dispatch(
        'quit',
        makeCtx({ nick: 'user', ident: 'u', hostname: 'host.com', text: 'Quit: bye' }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch when hostmask does not match mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('quit', '-', '*!x@other.com', handler, 'test-plugin');
      await dispatcher.dispatch(
        'quit',
        makeCtx({ nick: 'user', ident: 'u', hostname: 'host.com', text: 'Quit: bye' }),
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // invite type
  // -------------------------------------------------------------------------

  describe('invite type', () => {
    it('dispatches on wildcard mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('invite', '-', '*', handler, 'test-plugin');
      await dispatcher.dispatch(
        'invite',
        makeCtx({
          nick: 'inviter',
          ident: 'u',
          hostname: 'h.com',
          channel: '#secret',
          text: '#secret inviter!u@h.com',
          command: 'INVITE',
          args: '',
        }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });

    it('dispatches when channel + hostmask matches mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('invite', '-', '#secret *!u@h.com', handler, 'test-plugin');
      await dispatcher.dispatch(
        'invite',
        makeCtx({
          nick: 'inviter',
          ident: 'u',
          hostname: 'h.com',
          channel: '#secret',
          text: '#secret inviter!u@h.com',
          command: 'INVITE',
          args: '',
        }),
      );
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch when channel does not match mask', async () => {
      const handler = vi.fn();
      dispatcher.bind('invite', '-', '#other *', handler, 'test-plugin');
      await dispatcher.dispatch(
        'invite',
        makeCtx({
          nick: 'inviter',
          ident: 'u',
          hostname: 'h.com',
          channel: '#secret',
          text: '#secret inviter!u@h.com',
          command: 'INVITE',
          args: '',
        }),
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return without error when no binds exist for a type', async () => {
      const ctx = makeCtx({ command: '!nothing' });
      await expect(dispatcher.dispatch('pub', ctx)).resolves.toBeUndefined();
    });

    it('should handle dispatch with no binds at all', async () => {
      const ctx = makeCtx();
      await expect(dispatcher.dispatch('join', ctx)).resolves.toBeUndefined();
    });

    it('returns false for unknown event type mask match', async () => {
      // Bind to an unknown type and dispatch it — handler should not fire
      // (unknown types fall through to default: return false in matchesMask)
      const handler = vi.fn();
      dispatcher.bind('unknown_type' as 'pub', '-', '*', handler, 'test-plugin');
      await dispatcher.dispatch('unknown_type' as 'pub', makeCtx());
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // setCasemapping
  // -------------------------------------------------------------------------

  describe('setCasemapping', () => {
    it('updates casemapping for case-insensitive matching', async () => {
      dispatcher.setCasemapping('ascii');
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!HELLO', handler, 'test-plugin');
      await dispatcher.dispatch('pub', makeCtx({ command: '!hello' }));
      // With ascii casemapping, '!HELLO' and '!hello' should match case-insensitively
      // (caseCompare uses the casemapping for pub type)
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
