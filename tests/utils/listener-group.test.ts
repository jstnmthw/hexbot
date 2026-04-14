// Covers stability audit 2026-04-14: `ListenerGroup.removeAll()` must
// not abort on the first throw from `off()` — otherwise a single bad
// listener leaves every subsequent listener attached, racing with fresh
// listeners from the next reconnect cycle.
import { describe, expect, it } from 'vitest';

import { ListenerGroup } from '../../src/utils/listener-group';

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
});
