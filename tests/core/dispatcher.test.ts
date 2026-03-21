import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDispatcher } from '../../src/dispatcher.js';
import type { HandlerContext } from '../../src/types.js';

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

    it('should allow all flags when no permissions system is attached', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', 'n', '!admin', handler, 'test-plugin');

      const ctx = makeCtx({ command: '!admin' });
      await dispatcher.dispatch('pub', ctx);

      // No permissions system → always allows
      expect(handler).toHaveBeenCalledOnce();
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
    it('should fire on interval', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      dispatcher.bind('time', '-', '1', handler, 'test-plugin');

      // Advance past one interval (1 second)
      vi.advanceTimersByTime(1100);

      expect(handler).toHaveBeenCalledOnce();

      // Advance another interval
      vi.advanceTimersByTime(1000);
      expect(handler).toHaveBeenCalledTimes(2);

      dispatcher.unbindAll('test-plugin');
      vi.useRealTimers();
    });

    it('should clean up timers on unbindAll', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      dispatcher.bind('time', '-', '1', handler, 'test-plugin');

      dispatcher.unbindAll('test-plugin');

      vi.advanceTimersByTime(2000);
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
  });
});
