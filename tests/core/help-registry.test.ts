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
    expect(all).toContainEqual(entryA);
    expect(all).toContainEqual(entryB);
    expect(all).toContainEqual(entryC);
  });

  it('unregisters only the target plugin entries', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA, entryB]);
    reg.register('seen', [entryC]);

    reg.unregister('chanmod');

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all).toContainEqual(entryC);
  });

  it('get() finds an entry by exact command name', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA, entryB]);

    expect(reg.get('!op')).toEqual(entryA);
    expect(reg.get('!kick')).toEqual(entryB);
  });

  it('get() finds an entry without the leading !', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('op')).toEqual(entryA);
  });

  it('get() is case-insensitive', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('!OP')).toEqual(entryA);
    expect(reg.get('Op')).toEqual(entryA);
  });

  it('get() returns undefined for unknown commands', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);

    expect(reg.get('!unknown')).toBeUndefined();
  });

  it('re-registering the same pluginId replaces prior entries (no duplicates)', () => {
    const reg = new HelpRegistry();
    reg.register('chanmod', [entryA]);
    reg.register('chanmod', [entryB]);

    const all = reg.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entryB);
  });

  it('getAll() returns empty array when no entries are registered', () => {
    const reg = new HelpRegistry();
    expect(reg.getAll()).toEqual([]);
  });
});
