// HexBot — DCCSessionStore: casemapping-aware session storage
//
// The store is keyed by IRC-folded nick, so a password rotation for handle
// "Alice" must close every session whose stored handle matches under the
// active casemapping (rfc1459 folds `[]\` to `{}|`, ascii does not).
// Failing to fold consistently here historically left orphan sessions that
// could outlive a kicked operator — these tests guard that contract.
import { describe, expect, it, vi } from 'vitest';

import type { DCCSessionEntry } from '../../../src/core/dcc/index';
import { DCCSessionStore } from '../../../src/core/dcc/session-store';

function makeSession(handle: string, nick: string): DCCSessionEntry {
  // We only assert on the fields/methods session-store reaches into.
  return {
    handle,
    nick,
    connectedAt: 1000,
    isRelaying: false,
    relayTarget: null,
    handleFlags: 'm',
    rateLimitKey: `${nick}!u@h`,
    isClosed: false,
    isStale: false,
    writeLine: vi.fn(),
    close: vi.fn(),
    enterRelay: vi.fn(),
    exitRelay: vi.fn(),
    confirmRelay: vi.fn(),
    getConsoleFlags: vi.fn(() => ''),
    setConsoleFlags: vi.fn(),
    receiveLog: vi.fn(),
  } as unknown as DCCSessionEntry;
}

describe('DCCSessionStore: basic key/value ops', () => {
  it('stores, retrieves, and deletes by case-folded nick', () => {
    const map = new Map<string, DCCSessionEntry>();
    const store = new DCCSessionStore(map);
    const sess = makeSession('alice', 'Alice');

    store.set('Alice', sess);
    expect(store.size).toBe(1);
    expect(store.has('alice')).toBe(true);
    expect(store.has('ALICE')).toBe(true);
    expect(store.get('alice')).toBe(sess);

    expect(store.delete('aLiCe')).toBe(true);
    expect(store.delete('aLiCe')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('exposes values() and entries() iterators', () => {
    const store = new DCCSessionStore(new Map());
    const a = makeSession('alice', 'alice');
    const b = makeSession('bob', 'bob');
    store.set('alice', a);
    store.set('bob', b);

    expect([...store.values()]).toEqual(expect.arrayContaining([a, b]));
    const entryNicks = [...store.entries()].map(([k]) => k).sort();
    expect(entryNicks).toEqual(['alice', 'bob']);
  });

  it('clear() drops every entry without calling close()', () => {
    const store = new DCCSessionStore(new Map());
    const sess = makeSession('alice', 'alice');
    store.set('alice', sess);
    store.clear();
    expect(store.size).toBe(0);
    expect(sess.close).not.toHaveBeenCalled();
  });

  it('snapshot() exposes only handle/nick/connectedAt', () => {
    const store = new DCCSessionStore(new Map());
    store.set('alice', makeSession('alice', 'Alice'));
    store.set('bob', makeSession('bob', 'Bob'));

    const snap = store.snapshot();
    expect(snap).toHaveLength(2);
    for (const row of snap) {
      expect(Object.keys(row).sort()).toEqual(['connectedAt', 'handle', 'nick']);
    }
  });
});

describe('DCCSessionStore: casemapping fold', () => {
  it('rfc1459 folds [], \\ to {}, |', () => {
    const store = new DCCSessionStore(new Map());
    store.setCasemapping('rfc1459');
    store.set('Foo[bar]', makeSession('foo[bar]', 'Foo[bar]'));
    expect(store.has('foo{bar}')).toBe(true);
    expect(store.has('FOO{BAR}')).toBe(true);
  });

  it('ascii fold treats [] and {} as distinct', () => {
    const store = new DCCSessionStore(new Map());
    store.setCasemapping('ascii');
    store.set('Foo[bar]', makeSession('foo[bar]', 'Foo[bar]'));
    expect(store.has('foo{bar}')).toBe(false);
    expect(store.has('foo[bar]')).toBe(true);
  });

  it('changing casemapping does not re-key existing entries', () => {
    // The store does not rewrite stored keys when the casemapping flips
    // — that is the manager's responsibility on ISUPPORT change. Pin the
    // current behavior so a future "fix" doesn't silently start losing
    // sessions: under rfc1459 `[` folds to `{`, so the stored key is
    // `foo{bar}`. After flipping to ascii (which does not fold), the
    // entry is reachable only via the original-fold key.
    const store = new DCCSessionStore(new Map());
    store.setCasemapping('rfc1459');
    store.set('Foo[bar]', makeSession('foo[bar]', 'Foo[bar]'));
    store.setCasemapping('ascii');
    expect(store.has('foo[bar]')).toBe(false); // ascii fold ≠ stored key
    expect(store.has('foo{bar}')).toBe(true); // stored key still reachable
  });
});

describe('DCCSessionStore.collectByHandle', () => {
  it('collects every session sharing the handle (case-insensitive)', () => {
    const store = new DCCSessionStore(new Map());
    const a1 = makeSession('Alice', 'alice-mobile');
    const a2 = makeSession('alice', 'alice-desktop');
    const b1 = makeSession('Bob', 'bob');
    store.set('alice-mobile', a1);
    store.set('alice-desktop', a2);
    store.set('bob', b1);

    const matches = store.collectByHandle('ALICE');
    expect(matches.map(([_, s]) => s)).toEqual(expect.arrayContaining([a1, a2]));
    expect(matches.map(([_, s]) => s)).not.toContain(b1);
  });

  it('returns an empty array when no session matches', () => {
    const store = new DCCSessionStore(new Map());
    store.set('bob', makeSession('Bob', 'bob'));
    expect(store.collectByHandle('alice')).toEqual([]);
  });
});

describe('DCCSessionStore.closeForHandle', () => {
  it('closes and removes every matching session, logging a single warn', () => {
    const store = new DCCSessionStore(new Map());
    const a1 = makeSession('Alice', 'alice-mobile');
    const a2 = makeSession('alice', 'alice-desktop');
    const b1 = makeSession('Bob', 'bob');
    store.set('alice-mobile', a1);
    store.set('alice-desktop', a2);
    store.set('bob', b1);
    // session-store only reaches into `warn`; cast through `unknown` so the
    // test isn't coupled to LoggerLike's full surface (child/setLevel/etc).
    const loggerSpy = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const logger = loggerSpy as unknown as import('../../../src/logger').LoggerLike;

    store.closeForHandle('alice', 'password rotated', logger);

    expect(a1.close).toHaveBeenCalledWith('Session ended: password rotated.');
    expect(a2.close).toHaveBeenCalledWith('Session ended: password rotated.');
    expect(b1.close).not.toHaveBeenCalled();
    expect(store.has('alice-mobile')).toBe(false);
    expect(store.has('alice-desktop')).toBe(false);
    expect(store.has('bob')).toBe(true);
    expect(loggerSpy.warn).toHaveBeenCalledTimes(1);
    expect(loggerSpy.warn.mock.calls[0][0]).toContain('Closing 2 DCC session(s) for alice');
  });

  it('is a no-op when no session matches and skips the warn line', () => {
    const store = new DCCSessionStore(new Map());
    const b1 = makeSession('Bob', 'bob');
    store.set('bob', b1);
    // session-store only reaches into `warn`; cast through `unknown` so the
    // test isn't coupled to LoggerLike's full surface (child/setLevel/etc).
    const loggerSpy = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const logger = loggerSpy as unknown as import('../../../src/logger').LoggerLike;

    store.closeForHandle('ghost', 'whatever', logger);

    expect(b1.close).not.toHaveBeenCalled();
    expect(loggerSpy.warn).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it('tolerates a missing logger', () => {
    const store = new DCCSessionStore(new Map());
    store.set('alice', makeSession('alice', 'alice'));
    expect(() => store.closeForHandle('alice', 'shutdown', null)).not.toThrow();
    expect(() => store.closeForHandle('alice', 'shutdown')).not.toThrow();
  });
});

describe('DCCSessionStore.closeAll', () => {
  it('calls close() on every session and clears the map', () => {
    const store = new DCCSessionStore(new Map());
    const a = makeSession('alice', 'alice');
    const b = makeSession('bob', 'bob');
    store.set('alice', a);
    store.set('bob', b);

    store.closeAll('shutdown');

    expect(a.close).toHaveBeenCalledWith('shutdown');
    expect(b.close).toHaveBeenCalledWith('shutdown');
    expect(store.size).toBe(0);
  });

  it('passes undefined when no reason is given', () => {
    const store = new DCCSessionStore(new Map());
    const a = makeSession('alice', 'alice');
    store.set('alice', a);
    store.closeAll();
    expect(a.close).toHaveBeenCalledWith(undefined);
  });
});
