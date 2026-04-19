import { describe, expect, it } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
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

  it('upsert is case- and prefix-insensitive on the command name', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    const aliased: HelpEntry = { ...entryA, command: 'OP', description: 'Aliased' };
    reg.register('chanmod', [aliased]);

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ description: 'Aliased' });
  });

  it('getAll() returns empty array when no entries are registered', () => {
    const reg = new HelpRegistry();
    expect(reg.getAll()).toEqual([]);
  });
});
