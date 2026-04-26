import { beforeEach, describe, expect, it } from 'vitest';

import { seedFromJson } from '../../src/core/seed-from-json';
import { SettingsRegistry } from '../../src/core/settings-registry';
import { BotDatabase } from '../../src/database';

function makeRegistry(): { db: BotDatabase; reg: SettingsRegistry } {
  const db = new BotDatabase(':memory:');
  db.open();
  const reg = new SettingsRegistry({
    scope: 'core',
    namespace: 'core',
    db,
    auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
  });
  return { db, reg };
}

describe('seedFromJson', () => {
  let db: BotDatabase;
  let reg: SettingsRegistry;

  beforeEach(() => {
    ({ db, reg } = makeRegistry());
    reg.register('bot', [
      { key: 'logging.level', type: 'string', default: 'info', description: 'Log level' },
      { key: 'queue.rate', type: 'int', default: 1, description: 'Rate' },
      { key: 'verbose', type: 'flag', default: false, description: 'Verbose' },
      { key: 'irc.host', type: 'string', default: 'irc.example', description: 'IRC host' },
    ]);
  });

  it('seeds every key from JSON on a fresh KV', () => {
    const json = {
      logging: { level: 'debug' },
      queue: { rate: 2 },
      verbose: true,
      irc: { host: 'irc.libera.chat' },
    };
    const counts = seedFromJson(reg, json);
    expect(counts.seeded).toBe(4);
    expect(counts.updated).toBe(0);
    expect(counts.unchanged).toBe(0);
    expect(reg.getString('', 'logging.level')).toBe('debug');
    expect(reg.getInt('', 'queue.rate')).toBe(2);
    expect(reg.getFlag('', 'verbose')).toBe(true);
    expect(reg.getString('', 'irc.host')).toBe('irc.libera.chat');
  });

  it('does not re-seed unchanged JSON values', () => {
    const json = { logging: { level: 'debug' } };
    seedFromJson(reg, json);
    const counts = seedFromJson(reg, json);
    expect(counts.seeded).toBe(0);
    expect(counts.updated).toBe(0);
    expect(counts.unchanged).toBe(1);
  });

  it('updates KV when JSON differs from stored value', () => {
    seedFromJson(reg, { logging: { level: 'debug' } });
    const counts = seedFromJson(reg, { logging: { level: 'warn' } });
    expect(counts.updated).toBe(1);
    expect(counts.seeded).toBe(0);
    expect(reg.getString('', 'logging.level')).toBe('warn');
  });

  it('skips keys missing from JSON', () => {
    const counts = seedFromJson(reg, { logging: { level: 'debug' } });
    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(3); // queue.rate, verbose, irc.host all missing
  });

  it('does NOT propagate JSON deletions (KV is canonical after seed)', () => {
    seedFromJson(reg, { logging: { level: 'debug' }, verbose: true });
    expect(reg.getString('', 'logging.level')).toBe('debug');
    expect(reg.getFlag('', 'verbose')).toBe(true);

    // Operator removes `verbose` from JSON and runs .rehash
    const counts = seedFromJson(reg, { logging: { level: 'debug' } });
    expect(counts.unchanged).toBe(1);
    expect(counts.skipped).toBe(3);
    // Stored value is preserved — operator must `.unset` to revert.
    expect(reg.isSet('', 'verbose')).toBe(true);
    expect(reg.getFlag('', 'verbose')).toBe(true);
  });

  it('counts reload-class hits for the operator-facing summary', () => {
    const reg2 = new SettingsRegistry({
      scope: 'core',
      namespace: 'core',
      db,
      auditActions: { set: 'coreset-set', unset: 'coreset-unset' },
    });
    reg2.register('bot', [
      { key: 'live_key', type: 'string', default: 'a', description: 'live', reloadClass: 'live' },
      {
        key: 'reload_key',
        type: 'string',
        default: 'a',
        description: 'reload',
        reloadClass: 'reload',
      },
      {
        key: 'restart_key',
        type: 'string',
        default: 'a',
        description: 'restart',
        reloadClass: 'restart',
      },
    ]);
    const counts = seedFromJson(reg2, { live_key: 'x', reload_key: 'y', restart_key: 'z' });
    expect(counts.seeded).toBe(3);
    expect(counts.reloaded).toBe(1);
    expect(counts.restartRequired).toBe(1);
  });

  it('skips type-incompatible JSON values', () => {
    // queue.rate is int — feed it a string that isn't a number
    const counts = seedFromJson(reg, { queue: { rate: 'not-a-number' } });
    expect(counts.skipped).toBe(4); // queue.rate skipped + 3 keys missing
    expect(reg.isSet('', 'queue.rate')).toBe(false);
  });

  it('coerces boolean strings for flag-typed keys', () => {
    const counts = seedFromJson(reg, { verbose: 'on' });
    expect(counts.seeded).toBe(1);
    expect(reg.getFlag('', 'verbose')).toBe(true);
  });

  it('returns all-skipped when JSON is null', () => {
    const counts = seedFromJson(reg, null);
    expect(counts.skipped).toBe(4);
    expect(counts.seeded).toBe(0);
  });

  it('flattens a string array into a comma-joined string for string-typed defs', () => {
    // Legacy plugin configs ship `["warn","kick","tempban"]` shapes;
    // coerceFromJson joins them with `,` so they seed cleanly into the
    // string-typed setting the migrated plugin reads.
    const counts = seedFromJson(reg, { logging: { level: ['debug', 'info', 'warn'] } });
    expect(counts.seeded).toBe(1);
    expect(reg.getString('', 'logging.level')).toBe('debug,info,warn');
  });

  it('flattens a numeric array into a comma-joined string for string-typed defs', () => {
    const counts = seedFromJson(reg, { logging: { level: [1, 2, 3] } });
    expect(counts.seeded).toBe(1);
    expect(reg.getString('', 'logging.level')).toBe('1,2,3');
  });

  it('rejects a mixed-type array (object entries) and skips the key', () => {
    const counts = seedFromJson(reg, { logging: { level: ['ok', { bad: true }] } });
    expect(counts.seeded).toBe(0);
    expect(counts.skipped).toBeGreaterThan(0);
    expect(reg.isSet('', 'logging.level')).toBe(false);
  });

  it('stringifies a number JSON value for a string-typed def', () => {
    // `coerceFromJson` coerces `number → String(number)` so a JSON
    // expression like `"port": 6697` populates a string-typed key.
    const counts = seedFromJson(reg, { logging: { level: 6697 } });
    expect(counts.seeded).toBe(1);
    expect(reg.getString('', 'logging.level')).toBe('6697');
  });

  it('seedOnly counts a KV-already-set key as unchanged and skips the write', () => {
    // Pre-seed the value, then run with seedOnly: true. The walker
    // sees `wasSet === true` and short-circuits to `unchanged++`
    // without consulting the JSON value at all.
    reg.set('', 'logging.level', 'trace');
    const counts = seedFromJson(reg, { logging: { level: 'debug' } }, { seedOnly: true });
    expect(counts.unchanged).toBe(1);
    expect(counts.updated).toBe(0);
    // KV value is preserved — JSON did NOT overwrite it.
    expect(reg.getString('', 'logging.level')).toBe('trace');
  });
});
