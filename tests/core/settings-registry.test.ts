// Tests the generalized three-scope settings registry. Each scope is
// covered explicitly so the channel-fold path (only the channel scope
// uses ircLower) and the audit-action contract are pinned.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModActor } from '../../src/core/audit';
import { HelpRegistry } from '../../src/core/help-registry';
import { SettingsRegistry } from '../../src/core/settings-registry';
import { BotDatabase } from '../../src/database';
import type { ChannelSettingDef } from '../../src/types';

function makeDb(): BotDatabase {
  const db = new BotDatabase(':memory:');
  db.open();
  return db;
}

const flagDef: ChannelSettingDef = {
  key: 'auto_op',
  type: 'flag',
  default: false,
  description: 'Auto-op on join',
};

const stringDef: ChannelSettingDef = {
  key: 'greet_msg',
  type: 'string',
  default: 'Welcome!',
  description: 'Greeting message',
};

const intDef: ChannelSettingDef = {
  key: 'max_lines',
  type: 'int',
  default: 5,
  description: 'Max lines',
};

function makeCore(db: BotDatabase): SettingsRegistry {
  return new SettingsRegistry({
    scope: 'core',
    namespace: 'core',
    db,
    auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
  });
}

function makePlugin(db: BotDatabase, pluginId: string): SettingsRegistry {
  return new SettingsRegistry({
    scope: 'plugin',
    namespace: `plugin:${pluginId}`,
    db,
    auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
  });
}

function makeChannel(db: BotDatabase): SettingsRegistry {
  return new SettingsRegistry({
    scope: 'channel',
    namespace: 'chanset',
    db,
    auditActions: { set: 'chanset-set', unset: 'chanset-unset' },
    ircLower: (s) => s.toLowerCase(),
  });
}

describe('SettingsRegistry — core scope', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    db = makeDb();
    reg = makeCore(db);
  });

  it('round-trips set/get with no instance dimension', () => {
    reg.register('bot', [stringDef]);
    expect(reg.getString('', 'greet_msg')).toBe('Welcome!');
    reg.set('', 'greet_msg', 'Hi there');
    expect(reg.getString('', 'greet_msg')).toBe('Hi there');
  });

  it('coerces flag/int from stored strings', () => {
    reg.register('bot', [flagDef, intDef]);
    reg.set('', 'auto_op', true);
    reg.set('', 'max_lines', 12);
    expect(reg.getFlag('', 'auto_op')).toBe(true);
    expect(reg.getInt('', 'max_lines')).toBe(12);
  });

  it('unset reverts to registered default and deletes the KV row', () => {
    reg.register('bot', [stringDef]);
    reg.set('', 'greet_msg', 'Hi there');
    reg.unset('', 'greet_msg');
    expect(reg.getString('', 'greet_msg')).toBe('Welcome!');
    expect(reg.isSet('', 'greet_msg')).toBe(false);
  });

  it('does not fold core keys (case-sensitive)', () => {
    reg.register('bot', [stringDef]);
    // Core scope uses identity folding — instance is just `''` per convention.
    // Demonstrate that two distinct instances would be stored independently
    // (they will never differ in core scope, but the contract is identity).
    reg.set('FoO', 'greet_msg', 'mixed');
    reg.set('foo', 'greet_msg', 'lower');
    expect(reg.getString('FoO', 'greet_msg')).toBe('mixed');
    expect(reg.getString('foo', 'greet_msg')).toBe('lower');
  });

  it('writes a coreset-set audit row when actor is supplied', () => {
    reg.register('bot', [stringDef]);
    const actor: ModActor = { source: 'repl', by: 'admin' };
    reg.set('', 'greet_msg', 'Hi', actor);
    const rows = db.getModLog({ limit: 5 });
    expect(rows[0].action).toBe('coreset-set');
    expect(rows[0].target).toBe('greet_msg');
    expect(rows[0].reason).toBe('Hi');
    expect(rows[0].channel).toBeNull();
  });
});

describe('SettingsRegistry — plugin scope', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    db = makeDb();
    reg = makePlugin(db, 'rss');
  });

  it('isolates KV from a sibling plugin namespace', () => {
    const sibling = makePlugin(db, 'flood');
    reg.register('rss', [stringDef]);
    sibling.register('flood', [stringDef]);
    reg.set('', 'greet_msg', 'rss-only');
    expect(reg.getString('', 'greet_msg')).toBe('rss-only');
    // Sibling registry stores under its own namespace so the rss write
    // is invisible to it.
    expect(sibling.getString('', 'greet_msg')).toBe('Welcome!');
  });

  it('writes a pluginset-set audit row with plugin attribution', () => {
    reg.register('rss', [stringDef]);
    const actor: ModActor = { source: 'plugin', by: 'rss', plugin: 'rss' };
    reg.set('', 'greet_msg', 'Hi', actor);
    const rows = db.getModLog({ limit: 5 });
    expect(rows[0].action).toBe('pluginset-set');
    expect(rows[0].plugin).toBe('rss');
  });
});

describe('SettingsRegistry — channel scope', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    db = makeDb();
    reg = makeChannel(db);
  });

  it('folds the channel name so #Foo and #foo share state', () => {
    reg.register('chanmod', [stringDef]);
    reg.set('#Foo', 'greet_msg', 'mixed-case');
    expect(reg.getString('#foo', 'greet_msg')).toBe('mixed-case');
  });

  it('falls back to raw-cased KV for pre-normalisation entries', () => {
    reg.register('chanmod', [stringDef]);
    // Simulate a legacy raw-cased entry that the registry would emit
    // before the casemapping rolled in.
    db.set('chanset', '#Foo:greet_msg', 'legacy');
    expect(reg.getString('#Foo', 'greet_msg')).toBe('legacy');
    // A subsequent set rewrites under the folded key, but the legacy
    // row is still present until the next unset.
    reg.set('#Foo', 'greet_msg', 'new');
    expect(reg.getString('#foo', 'greet_msg')).toBe('new');
  });

  it('writes a chanset-set audit row with the channel attribution', () => {
    reg.register('chanmod', [stringDef]);
    const actor: ModActor = { source: 'plugin', by: 'op', plugin: 'chanmod' };
    reg.set('#hexbot', 'greet_msg', 'hi', actor);
    const rows = db.getModLog({ limit: 5 });
    expect(rows[0].action).toBe('chanset-set');
    expect(rows[0].channel).toBe('#hexbot');
  });
});

describe('SettingsRegistry — onChange / unregister contract', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    db = makeDb();
    reg = makePlugin(db, 'rss');
  });

  it('fires onChange listeners on set and unset', () => {
    reg.register('rss', [stringDef]);
    const cb = vi.fn();
    reg.onChange('rss', cb);
    reg.set('', 'greet_msg', 'hi');
    reg.unset('', 'greet_msg');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, '', 'greet_msg', 'hi');
    expect(cb).toHaveBeenNthCalledWith(2, '', 'greet_msg', stringDef.default);
  });

  it('unregister(owner) drops only that owner s defs but preserves stored values', () => {
    reg.register('rss', [stringDef]);
    reg.set('', 'greet_msg', 'hi');
    reg.unregister('rss');
    expect(reg.getDef('greet_msg')).toBeUndefined();
    // Re-register, the stored value is still in KV.
    reg.register('rss', [stringDef]);
    expect(reg.getString('', 'greet_msg')).toBe('hi');
  });

  it('offChange(owner) drains every callback registered under that owner', () => {
    reg.register('rss', [stringDef]);
    const cb = vi.fn();
    reg.onChange('rss', cb);
    reg.offChange('rss');
    reg.set('', 'greet_msg', 'hi');
    expect(cb).not.toHaveBeenCalled();
  });

  it('cross-owner key collisions are dropped with the first writer winning', () => {
    reg.register('rss', [stringDef]);
    reg.register('flood', [{ ...stringDef, description: 'flood version' }]);
    expect(reg.getDef('greet_msg')!.owner).toBe('rss');
    expect(reg.getDef('greet_msg')!.description).toBe(stringDef.description);
  });
});

describe('SettingsRegistry — reload class', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    db = makeDb();
    reg = makeCore(db);
  });

  it('returns reloadClass=live by default and on explicit live def', () => {
    reg.register('bot', [{ ...stringDef, reloadClass: 'live' }]);
    expect(reg.set('', 'greet_msg', 'hi').reloadClass).toBe('live');
  });

  it('invokes onReload when reloadClass=reload and surfaces failure', () => {
    const onReload = vi.fn();
    reg.register('bot', [{ ...stringDef, reloadClass: 'reload', onReload }]);
    const out = reg.set('', 'greet_msg', 'hi');
    expect(out.reloadClass).toBe('reload');
    expect(onReload).toHaveBeenCalledWith('hi');
    expect(out.reloadFailed).toBeFalsy();
  });

  it('marks reloadFailed=true when onReload throws', () => {
    reg.register('bot', [
      {
        ...stringDef,
        reloadClass: 'reload',
        onReload: () => {
          throw new Error('boom');
        },
      },
    ]);
    const out = reg.set('', 'greet_msg', 'hi');
    expect(out.reloadClass).toBe('reload');
    expect(out.reloadFailed).toBe(true);
  });

  it('returns reloadClass=restart with the reason from onRestartRequired', () => {
    reg.register('bot', [
      {
        ...stringDef,
        reloadClass: 'restart',
        onRestartRequired: () => 'stored; takes effect after .restart',
      },
    ]);
    const out = reg.set('', 'greet_msg', 'new.host');
    expect(out.reloadClass).toBe('restart');
    expect(out.restartReason).toMatch(/restart/i);
  });
});

describe('SettingsRegistry — help corpus mirroring', () => {
  let db: BotDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  it('registers a synthetic scope-header entry on construction when summary is supplied', () => {
    const help = new HelpRegistry();
    new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      helpRegistry: help,
      scopeLabel: 'core',
      scopeSummary: 'Bot-wide singletons',
      commandPrefix: '.',
    });

    const header = help.get('.set core');
    expect(header).toBeDefined();
    expect(header?.category).toBe('set:core');
    expect(header?.description).toBe('Bot-wide singletons');
    expect(header?.flags).toBe('n');
  });

  it('mirrors per-def help entries on register() under the def owner bucket', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      helpRegistry: help,
      scopeLabel: 'core',
      scopeSummary: 'Bot-wide singletons',
    });
    reg.register('bot', [{ ...stringDef, description: 'Greeting message' }]);

    const entry = help.get('.set core greet_msg');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('set:core');
    expect(entry?.description).toBe('Greeting message');
    expect(entry?.usage).toBe('.set core greet_msg <string>');
    expect(entry?.pluginId).toBe('bot');
    // Detail line carries type/default/reload metadata so `.help set core greet_msg`
    // can render it without re-deriving from the def at lookup time.
    expect(entry?.detail?.[0]).toContain('Type: string');
    expect(entry?.detail?.[0]).toContain('Default: Welcome!');
    expect(entry?.detail?.[0]).toContain('Reload: live');
  });

  it('uses the configured command prefix when mirroring entries', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'plugin',
      namespace: 'plugin:rss',
      db,
      auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
      helpRegistry: help,
      scopeLabel: 'rss',
      scopeSummary: 'RSS feed announcer',
      commandPrefix: '!',
    });
    reg.register('rss', [stringDef]);

    expect(help.get('!set rss')).toBeDefined();
    expect(help.get('!set rss greet_msg')?.usage).toBe('!set rss greet_msg <string>');
  });

  it('formats default values for ON/OFF flags, empty strings, and ints', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      helpRegistry: help,
      scopeLabel: 'core',
      scopeSummary: 'Core',
    });
    reg.register('bot', [
      { key: 'feature', type: 'flag', default: true, description: 'On flag' },
      { key: 'host', type: 'string', default: '', description: 'Empty string default' },
      { key: 'count', type: 'int', default: 5, description: 'Int default' },
    ]);

    expect(help.get('.set core feature')?.detail?.[0]).toContain('Default: ON');
    expect(help.get('.set core host')?.detail?.[0]).toContain('Default: (empty)');
    expect(help.get('.set core count')?.detail?.[0]).toContain('Default: 5');
  });

  it('emits an Allowed line when the def declares allowedValues', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      helpRegistry: help,
      scopeLabel: 'core',
      scopeSummary: 'Core',
    });
    reg.register('bot', [
      {
        key: 'log.level',
        type: 'string',
        default: 'info',
        description: 'Log level',
        allowedValues: ['debug', 'info', 'warn', 'error'],
      },
    ]);

    const detail = help.get('.set core log.level')?.detail;
    expect(detail).toEqual(
      expect.arrayContaining([expect.stringContaining('Allowed: debug, info, warn, error')]),
    );
  });

  it('omits help mirroring entirely when helpRegistry is not supplied', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
      // No helpRegistry / scopeLabel / scopeSummary — registry stays in
      // "settings only" mode.
    });
    reg.register('bot', [stringDef]);

    expect(help.getAll()).toHaveLength(0);
  });

  it('drops mirrored entries when the owner plugin unloads (helpRegistry.unregister)', () => {
    const help = new HelpRegistry();
    const reg = new SettingsRegistry({
      scope: 'plugin',
      namespace: 'plugin:rss',
      db,
      auditActions: { set: 'pluginset-set', unset: 'pluginset-unset' },
      helpRegistry: help,
      scopeLabel: 'rss',
      scopeSummary: 'RSS feed announcer',
    });
    reg.register('rss', [stringDef]);
    expect(help.get('.set rss greet_msg')).toBeDefined();
    expect(help.get('.set rss')).toBeDefined();

    // Plugin unload calls help.unregister(pluginId) — both the per-key
    // entry AND the scope header (registered into the plugin bucket) go.
    help.unregister('rss');
    expect(help.get('.set rss greet_msg')).toBeUndefined();
    expect(help.get('.set rss')).toBeUndefined();
  });
});
