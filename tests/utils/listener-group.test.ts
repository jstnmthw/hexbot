// Covers stability audit 2026-04-14: `ListenerGroup.removeAll()` must
// not abort on the first throw from `off()` — otherwise a single bad
// listener leaves every subsequent listener attached, racing with fresh
// listeners from the next reconnect cycle.
import { describe, expect, it, vi } from 'vitest';

import { ListenerGroup } from '../../src/utils/listener-group';

describe('ListenerGroup constructor', () => {
  it('rejects a target that exposes neither removeListener nor off', () => {
    // The guard is the whole point: refusing to track listeners we cannot
    // detach prevents a silent leak on reconnect.
    expect(() => new ListenerGroup({ on: () => {} } as never)).toThrow(TypeError);
    expect(() => new ListenerGroup({ on: () => {} } as never)).toThrow(/refusing to attach/);
  });

  it('accepts a target with only removeListener (Node EventEmitter shape)', () => {
    const t = { on: () => {}, removeListener: () => {} };
    expect(() => new ListenerGroup(t)).not.toThrow();
  });

  it('accepts a target with only off (irc-framework / DOM shape)', () => {
    const t = { on: () => {}, off: () => {} };
    expect(() => new ListenerGroup(t)).not.toThrow();
  });
});

describe('ListenerGroup.on / size', () => {
  it('attaches the listener on the underlying target and tracks size', () => {
    const handlers: Array<{ event: string; fn: unknown }> = [];
    const target = {
      on: (event: string, fn: (...args: unknown[]) => void) => handlers.push({ event, fn }),
      removeListener: () => {},
    };
    const group = new ListenerGroup(target);
    const a = () => {};
    const b = () => {};
    group.on('msg', a);
    group.on('quit', b);
    expect(group.size).toBe(2);
    expect(handlers).toEqual([
      { event: 'msg', fn: a },
      { event: 'quit', fn: b },
    ]);
  });
});

describe('ListenerGroup.removeAll: success path', () => {
  it('detaches every listener and resets size to 0 (removeListener path)', () => {
    const removed: Array<[string, unknown]> = [];
    const target = {
      on: () => {},
      removeListener: (ev: string, fn: unknown) => removed.push([ev, fn]),
    };
    const group = new ListenerGroup(target);
    const fn1 = () => {};
    const fn2 = () => {};
    group.on('a', fn1);
    group.on('b', fn2);
    group.removeAll();
    expect(removed).toEqual([
      ['a', fn1],
      ['b', fn2],
    ]);
    expect(group.size).toBe(0);
  });

  it('uses the off() alias when removeListener is absent', () => {
    const removed: string[] = [];
    const target = {
      on: () => {},
      off: (ev: string) => removed.push(ev),
    };
    const group = new ListenerGroup(target);
    group.on('connect', () => {});
    group.on('close', () => {});
    group.removeAll();
    expect(removed).toEqual(['connect', 'close']);
    expect(group.size).toBe(0);
  });

  it('a second removeAll() is a no-op (empty entries list)', () => {
    const removed: string[] = [];
    const target = { on: () => {}, removeListener: (ev: string) => removed.push(ev) };
    const group = new ListenerGroup(target);
    group.on('x', () => {});
    group.removeAll();
    group.removeAll();
    expect(removed).toEqual(['x']);
  });
});

describe('ListenerGroup.removeAll: per-entry error containment', () => {
  it('removes every listener even when one off() throws', () => {
    const removedEvents: string[] = [];
    let firstRemoveCalled = false;
    const target = {
      on: (_ev: string, _fn: (...args: unknown[]) => void) => {},
      removeListener(ev: string, _fn: (...args: unknown[]) => void): void {
        if (!firstRemoveCalled) {
          firstRemoveCalled = true;
          throw new Error('boom');
        }
        removedEvents.push(ev);
      },
    };
    const group = new ListenerGroup(target);
    group.on('a', () => {});
    group.on('b', () => {});
    group.on('c', () => {});
    // Must not throw even though the first removeListener threw.
    expect(() => group.removeAll()).not.toThrow();
    // The two subsequent listeners still got removed.
    expect(removedEvents).toEqual(['b', 'c']);
    expect(group.size).toBe(0);
  });

  it('logs the failing event name through the injected logger', () => {
    const error = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error,
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };
    const target = {
      on: () => {},
      removeListener: () => {
        throw new Error('off-rejected');
      },
    };
    const group = new ListenerGroup(target, logger);
    group.on('disconnect', () => {});
    group.removeAll();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('removeListener(disconnect) threw'),
      expect.any(Error),
    );
  });
});
