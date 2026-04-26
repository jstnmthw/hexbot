import { describe, expect, it, vi } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
import type { LoggerLike } from '../../src/logger';
import type { HelpEntry } from '../../src/types';

const entryA: HelpEntry = {
  command: '!op',
  flags: 'o',
  usage: '!op [nick]',
  description: 'Op a nick',
  category: 'moderation',
};

const entryB: HelpEntry = {
  command: '!kick',
  flags: 'o',
  usage: '!kick <nick> [reason]',
  description: 'Kick a nick',
  category: 'moderation',
};

const entryC: HelpEntry = {
  command: '!seen',
  flags: '-',
  usage: '!seen <nick>',
  description: 'Show when a nick was last seen',
  category: 'info',
};

/** Minimal LoggerLike double — only the surface HelpRegistry actually calls. */
function makeLogger(): LoggerLike & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn().mockReturnValue('info'),
  } as unknown as LoggerLike & { warn: ReturnType<typeof vi.fn> };
}

describe('HelpRegistry', () => {
  it('registers entries and returns them via getAll()', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA, entryB]);
    reg.register('seen', [entryC]);

    const all = reg.getAll();
    expect(all).toHaveLength(3);
    expect(all).toContainEqual(expect.objectContaining(entryA));
    expect(all).toContainEqual(expect.objectContaining(entryB));
    expect(all).toContainEqual(expect.objectContaining(entryC));
  });

  it('unregisters only the target plugin entries', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA, entryB]);
    reg.register('seen', [entryC]);

    reg.unregister('chanmod');

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all).toContainEqual(expect.objectContaining(entryC));
  });

  it('get() finds an entry by exact command name', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA, entryB]);

    expect(reg.get('!op')).toMatchObject(entryA);
    expect(reg.get('!kick')).toMatchObject(entryB);
  });

  it('get() finds an entry without the leading !', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('op')).toMatchObject(entryA);
  });

  it('get() finds an entry registered with a leading . prefix', () => {
    const reg = new HelpRegistry();
    const dotEntry: HelpEntry = {
      command: '.set',
      flags: 'n',
      usage: '.set <scope> [<key>] [<value>]',
      description: 'Set a config value',
      category: 'admin',
    };
    reg.register('core', [dotEntry]);

    expect(reg.get('.set')).toMatchObject(dotEntry);
    expect(reg.get('set')).toMatchObject(dotEntry);
    expect(reg.get('!set')).toMatchObject(dotEntry);
  });

  it('get() is case-insensitive', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('!OP')).toMatchObject(entryA);
    expect(reg.get('Op')).toMatchObject(entryA);
  });

  it('get() returns undefined for unknown commands', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('!unknown')).toBeUndefined();
  });

  it('multiple register() calls from the same plugin append entries (no clobber)', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    reg.register('chanmod', [entryB]);

    const all = reg.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual(expect.objectContaining(entryA));
    expect(all).toContainEqual(expect.objectContaining(entryB));
  });

  it('re-registering the same command upserts in place (no duplicate)', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    const updated: HelpEntry = { ...entryA, description: 'Op a nick (updated)' };
    reg.register('chanmod', [updated]);

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject(updated);
  });

  it('upsert is case-insensitive on the command name', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    const aliased: HelpEntry = { ...entryA, command: '!OP', description: 'Aliased' };
    reg.register('chanmod', [aliased]);

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ description: 'Aliased' });
  });

  it('different prefixes (.ban vs !ban) are tracked as distinct entries, not a collision', () => {
    const logger = makeLogger();
    const reg = new HelpRegistry(logger);
    const dotBan: HelpEntry = {
      command: '.ban',
      flags: '+o',
      usage: '.ban [#channel] <mask> [duration]',
      description: 'Admin ban (dot-command)',
      category: 'moderation',
    };
    const bangBan: HelpEntry = {
      command: '!ban',
      flags: 'o',
      usage: '!ban <nick|mask> [minutes]',
      description: 'Channel ban (bang-command)',
      category: 'moderation',
    };
    reg.register('core', [dotBan]);
    reg.register('chanmod', [bangBan]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(reg.getAll()).toHaveLength(2);
    // Strict prefix match wins — each query returns its prefix's variant.
    expect(reg.get('.ban')).toMatchObject(dotBan);
    expect(reg.get('!ban')).toMatchObject(bangBan);
    // Bare query falls through to the fuzzy fallback; first registered
    // (core's `.ban`) wins.
    expect(reg.get('ban')).toMatchObject(dotBan);
  });

  it('getAll() returns empty array when no entries are registered', () => {
    const reg = new HelpRegistry();
    expect(reg.getAll()).toEqual([]);
  });

  it('warns on cross-plugin collision and keeps loser under a namespaced key', () => {
    const logger = makeLogger();
    const reg = new HelpRegistry(logger);
    const winner: HelpEntry = {
      command: '!ping',
      flags: '-',
      usage: '!ping',
      description: 'First plugin pings',
      category: 'fun',
    };
    const loser: HelpEntry = {
      command: '!ping',
      flags: '-',
      usage: '!ping <target>',
      description: 'Second plugin pings differently',
      category: 'fun',
    };

    reg.register('first', [winner]);
    reg.register('second', [loser]);

    expect(logger.warn).toHaveBeenCalledOnce();
    const warnMsg = logger.warn.mock.calls[0][0];
    expect(warnMsg).toContain('!ping');
    expect(warnMsg).toContain('first');
    expect(warnMsg).toContain('second:!ping');

    // Winner stays reachable under the bare name.
    expect(reg.get('!ping')).toMatchObject({ description: winner.description });
    // Loser still discoverable under the namespaced form.
    expect(reg.get('second:!ping')).toMatchObject({ description: loser.description });

    // getAll() returns BOTH entries so audit/index tooling sees the conflict.
    const all = reg.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual(expect.objectContaining({ description: winner.description }));
    expect(all).toContainEqual(expect.objectContaining({ description: loser.description }));
  });

  it('does not warn or namespace when the same plugin re-registers (upsert path)', () => {
    const logger = makeLogger();
    const reg = new HelpRegistry(logger);
    reg.register('chanmod', [entryA]);
    reg.register('chanmod', [{ ...entryA, description: 'updated' }]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(reg.getAll()).toHaveLength(1);
  });

  it('survives a collision with no logger wired (warning is a no-op)', () => {
    // Bot wires a logger in production; integration test fixtures may
    // not. The warning becomes a silent drop, but the namespaced
    // fallback still has to land.
    const reg = new HelpRegistry();
    reg.register('first', [{ ...entryA, command: '!ping' }]);
    reg.register('second', [{ ...entryA, command: '!ping', description: 'second' }]);
    expect(reg.get('!ping')?.description).toBe(entryA.description);
    expect(reg.get('second:!ping')?.description).toBe('second');
  });

  it('namespaced lookup falls back through the colon prefix when bucket is missing', () => {
    // Defensive get() path — `unknown:foo` should miss cleanly rather
    // than throw.
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    expect(reg.get('unknown:!op')).toBeUndefined();
  });

  it('namespaced lookup falls through to the bucket bare-key when no namespaced entry exists', () => {
    // Owner registered a command with no collision, then a caller
    // looks it up via `<owner>:<command>`. Direct `<owner>:<key>` miss
    // should fall through to the bare `<key>` within that owner's bucket.
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]); // stored under bare key '!op'
    expect(reg.get('chanmod:!op')).toMatchObject(entryA);
  });
});
