import { beforeEach, describe, expect, it } from 'vitest';

import { ChannelSettings } from '../../src/core/channel-settings';
import { BotDatabase } from '../../src/database';
import type { ChannelSettingDef } from '../../src/types';

function makeDb(): BotDatabase {
  const db = new BotDatabase(':memory:');
  db.open();
  return db;
}

const flagDef: ChannelSettingDef = {
  key: 'bitch',
  type: 'flag',
  default: false,
  description: 'Deop users without op flag',
};

const stringDef: ChannelSettingDef = {
  key: 'greet_msg',
  type: 'string',
  default: 'Welcome!',
  description: 'Per-channel greeting',
};

const intDef: ChannelSettingDef = {
  key: 'max_lines',
  type: 'int',
  default: 5,
  description: 'Max flood lines',
};

describe('ChannelSettings', () => {
  let db: BotDatabase;
  let cs: ChannelSettings;

  beforeEach(() => {
    db = makeDb();
    cs = new ChannelSettings(db);
  });

  describe('register / getDef', () => {
    it('registers a def and makes it retrievable', () => {
      cs.register('myplugin', [flagDef]);
      const entry = cs.getDef('bitch');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('bitch');
      expect(entry!.pluginId).toBe('myplugin');
      expect(entry!.type).toBe('flag');
    });

    it('registers multiple defs at once', () => {
      cs.register('myplugin', [flagDef, stringDef, intDef]);
      expect(cs.getDef('bitch')).toBeDefined();
      expect(cs.getDef('greet_msg')).toBeDefined();
      expect(cs.getDef('max_lines')).toBeDefined();
    });

    it('returns undefined for unknown key', () => {
      expect(cs.getDef('nonexistent')).toBeUndefined();
    });

    it('re-registering same pluginId replaces def without error', () => {
      cs.register('myplugin', [{ ...flagDef, description: 'old' }]);
      cs.register('myplugin', [{ ...flagDef, description: 'new' }]);
      expect(cs.getDef('bitch')!.description).toBe('new');
    });

    it('key collision from different plugin is skipped (original preserved)', () => {
      cs.register('plugin-a', [flagDef]);
      cs.register('plugin-b', [{ ...flagDef, description: 'from plugin-b' }]);
      const entry = cs.getDef('bitch');
      expect(entry!.pluginId).toBe('plugin-a');
      expect(entry!.description).toBe(flagDef.description);
    });
  });

  describe('get — returns default when no stored value', () => {
    it('flag default (false)', () => {
      cs.register('p', [flagDef]);
      expect(cs.get('#test', 'bitch')).toBe(false);
    });

    it('string default', () => {
      cs.register('p', [stringDef]);
      expect(cs.get('#test', 'greet_msg')).toBe('Welcome!');
    });

    it('int default', () => {
      cs.register('p', [intDef]);
      expect(cs.get('#test', 'max_lines')).toBe(5);
    });

    it("returns '' for unknown key (graceful degradation)", () => {
      expect(cs.get('#test', 'not_registered')).toBe('');
    });
  });

  describe('set + get — type coercion', () => {
    it('flag stored as "true" → coerced to boolean true', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      expect(cs.get('#test', 'bitch')).toBe(true);
    });

    it('flag stored as "false" → coerced to boolean false', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', false);
      expect(cs.get('#test', 'bitch')).toBe(false);
    });

    it('int stored as "42" → coerced to 42', () => {
      cs.register('p', [intDef]);
      cs.set('#test', 'max_lines', 42);
      expect(cs.get('#test', 'max_lines')).toBe(42);
    });

    it('string stored as "hello" → returned as "hello"', () => {
      cs.register('p', [stringDef]);
      cs.set('#test', 'greet_msg', 'hello');
      expect(cs.get('#test', 'greet_msg')).toBe('hello');
    });

    it('values are channel-scoped (different channels independent)', () => {
      cs.register('p', [flagDef]);
      cs.set('#foo', 'bitch', true);
      cs.set('#bar', 'bitch', false);
      expect(cs.get('#foo', 'bitch')).toBe(true);
      expect(cs.get('#bar', 'bitch')).toBe(false);
    });

    it('set warns and no-ops for unknown key', () => {
      // Should not throw
      expect(() => cs.set('#test', 'unknown', 'value')).not.toThrow();
      expect(cs.get('#test', 'unknown')).toBe('');
    });
  });

  describe('unset', () => {
    it('subsequent get returns def.default after unset', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      cs.unset('#test', 'bitch');
      expect(cs.get('#test', 'bitch')).toBe(false);
    });

    it('isSet returns false after unset', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      cs.unset('#test', 'bitch');
      expect(cs.isSet('#test', 'bitch')).toBe(false);
    });

    it('does not throw when unsetting an unregistered key', () => {
      // Key was never registered — unset should be a no-op (no crash)
      expect(() => cs.unset('#test', 'nonexistent')).not.toThrow();
    });
  });

  describe('isSet', () => {
    it('returns false before set', () => {
      cs.register('p', [flagDef]);
      expect(cs.isSet('#test', 'bitch')).toBe(false);
    });

    it('returns true after set', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      expect(cs.isSet('#test', 'bitch')).toBe(true);
    });

    it('returns false after unset', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      cs.unset('#test', 'bitch');
      expect(cs.isSet('#test', 'bitch')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('removes defs for a plugin from getAllDefs()', () => {
      cs.register('plugin-a', [flagDef]);
      cs.register('plugin-b', [stringDef]);
      cs.unregister('plugin-a');
      const defs = cs.getAllDefs();
      expect(defs).toHaveLength(1);
      expect(defs[0].key).toBe('greet_msg');
    });

    it('stored DB values survive unregister (re-register and get returns stored value)', () => {
      cs.register('p', [flagDef]);
      cs.set('#test', 'bitch', true);
      cs.unregister('p');

      // Value should still be in DB — re-register and confirm
      cs.register('p', [flagDef]);
      expect(cs.get('#test', 'bitch')).toBe(true);
    });
  });

  describe('getAllDefs', () => {
    it('returns all defs across all plugins in registration order', () => {
      cs.register('plugin-a', [flagDef]);
      cs.register('plugin-b', [stringDef, intDef]);
      const defs = cs.getAllDefs();
      expect(defs).toHaveLength(3);
      expect(defs.map((d) => d.key)).toEqual(['bitch', 'greet_msg', 'max_lines']);
    });

    it('returns empty array when nothing is registered', () => {
      expect(cs.getAllDefs()).toEqual([]);
    });
  });

  describe('getChannelSnapshot', () => {
    it('lists all defs with correct values and isDefault flags', () => {
      cs.register('p', [flagDef, stringDef]);
      cs.set('#test', 'bitch', true);

      const snapshot = cs.getChannelSnapshot('#test');
      expect(snapshot).toHaveLength(2);

      const bitchEntry = snapshot.find((s) => s.entry.key === 'bitch')!;
      expect(bitchEntry.value).toBe(true);
      expect(bitchEntry.isDefault).toBe(false);

      const greetEntry = snapshot.find((s) => s.entry.key === 'greet_msg')!;
      expect(greetEntry.value).toBe('Welcome!');
      expect(greetEntry.isDefault).toBe(true);
    });

    it('returns empty array when no defs are registered', () => {
      expect(cs.getChannelSnapshot('#test')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // CASEMAPPING normalisation (§12 Phase 7)
  // -------------------------------------------------------------------------

  describe('channel case normalisation', () => {
    it('treats `#Foo` and `#foo` as the same record when a folder is injected', () => {
      const normalized = new ChannelSettings(db, undefined, (s) => s.toLowerCase());
      normalized.register('myplugin', [flagDef]);

      normalized.set('#Foo', 'bitch', true);
      expect(normalized.get('#foo', 'bitch')).toBe(true);
      expect(normalized.get('#FOO', 'bitch')).toBe(true);
      expect(normalized.isSet('#fOo', 'bitch')).toBe(true);
    });

    it('falls back to a legacy raw-cased record when the folded key misses', () => {
      // Simulate a pre-normalisation database: write directly via the
      // BotDatabase under the raw channel name, then read back through
      // the normalised ChannelSettings instance using the SAME casing.
      // Callers that later query with a different casing (e.g. all-lower)
      // will see the def default — the audit calls out a one-time
      // operator-facing re-set as the accepted cost of the cutover.
      const normalized = new ChannelSettings(db, undefined, (s) => s.toLowerCase());
      normalized.register('myplugin', [stringDef]);
      db.set('chanset', '#Legacy:greet_msg', 'hi legacy');
      expect(normalized.get('#Legacy', 'greet_msg')).toBe('hi legacy');
    });

    it('unset removes both the folded and any legacy raw-cased record', () => {
      const normalized = new ChannelSettings(db, undefined, (s) => s.toLowerCase());
      normalized.register('myplugin', [flagDef]);
      db.set('chanset', '#Mix:bitch', 'true'); // legacy
      normalized.set('#mix', 'bitch', false); // writes folded entry

      expect(normalized.isSet('#mix', 'bitch')).toBe(true);
      normalized.unset('#Mix', 'bitch');
      expect(normalized.isSet('#mix', 'bitch')).toBe(false);
      expect(normalized.isSet('#Mix', 'bitch')).toBe(false);
    });

    it('getChannelSnapshot prefers the folded record over a legacy one', () => {
      const normalized = new ChannelSettings(db, undefined, (s) => s.toLowerCase());
      normalized.register('myplugin', [flagDef]);
      db.set('chanset', '#Mix:bitch', 'false'); // legacy raw value
      normalized.set('#mix', 'bitch', true); // folded value wins

      const snapshot = normalized.getChannelSnapshot('#MIX');
      const entry = snapshot.find((s) => s.entry.key === 'bitch')!;
      expect(entry.value).toBe(true);
      expect(entry.isDefault).toBe(false);
    });
  });

  describe('set with actor — mod_log audit', () => {
    it('writes a chanset row when an actor is supplied', () => {
      cs.register('myplugin', [flagDef]);
      cs.set('#chan', 'bitch', true, { by: 'alice', source: 'irc' });

      const rows = db.getModLog({ action: 'chanset-set' });
      expect(rows).toHaveLength(1);
      expect(rows[0].by).toBe('alice');
      expect(rows[0].target).toBe('bitch');
      expect(rows[0].reason).toBe('true');
      // `plugin` is absent for non-plugin sources (it would be rejected by
      // the mod_log insert).
      expect(rows[0].plugin).toBe(null);
    });

    it('attaches plugin=<def.pluginId> on plugin-sourced mutations', () => {
      cs.register('myplugin', [flagDef]);
      cs.set('#chan', 'bitch', true, { by: 'bot', source: 'plugin', plugin: 'myplugin' });

      const rows = db.getModLog({ action: 'chanset-set' });
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('plugin');
      expect(rows[0].plugin).toBe('myplugin');
    });

    it('skips the audit row when no actor is supplied (legacy caller)', () => {
      cs.register('myplugin', [flagDef]);
      cs.set('#chan', 'bitch', true);
      expect(db.getModLog({ action: 'chanset-set' })).toHaveLength(0);
    });
  });
});
