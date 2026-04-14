// Unit tests for chanmod ban integration with core BanStore.
// Tests liftExpiredBans via setupBans, and ban helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateBansToCore, setupBans } from '../../plugins/chanmod/bans';
import {
  botCanHalfop,
  buildBanMask,
  formatExpiry,
  getUserFlags,
} from '../../plugins/chanmod/helpers';
import { createState } from '../../plugins/chanmod/state';
import { BanStore } from '../../src/core/ban-store';
import { BotDatabase } from '../../src/database';
import { createLogger } from '../../src/logger';
import type { PluginAPI, PluginBanStore, PluginDB } from '../../src/types';
import { createMockPluginAPI } from '../helpers/mock-plugin-api';

/** Wrap a BotDatabase with a namespace to create a PluginDB (as plugin-loader does). */
function makePluginDb(db: BotDatabase, ns: string): PluginDB {
  return {
    get: (key) => db.get(ns, key) ?? undefined,
    set: (key, value) => db.set(ns, key, value),
    del: (key) => db.del(ns, key),
    list: (prefix) => db.list(ns, prefix),
  };
}

function makeApi(botHasOps = true): {
  api: PluginAPI;
  modeSpy: ReturnType<typeof vi.fn>;
  modeCallback: (channel: string, modes: string, param: string) => void;
  banStore: BanStore;
  rawDb: BotDatabase;
} {
  const rawDb = new BotDatabase(':memory:', createLogger('error'));
  rawDb.open();
  const pluginDb = makePluginDb(rawDb, 'chanmod');
  const banStore = new BanStore(rawDb, (s) => s.toLowerCase());

  const botNick = 'hexbot';
  const users = new Map<string, { modes: string[] }>();
  if (botHasOps) users.set(botNick, { modes: ['o'] });

  const modeSpy = vi.fn();
  /** Typed wrapper for passing modeSpy to liftExpiredBans (vitest Mock doesn't satisfy typed callbacks). */
  const modeCallback = (...args: [string, string, string]) => modeSpy(...args);

  // Build a real PluginBanStore from the BanStore instance
  const pluginBanStore: PluginBanStore = {
    storeBan: banStore.storeBan.bind(banStore),
    removeBan: banStore.removeBan.bind(banStore),
    getBan: banStore.getBan.bind(banStore),
    getChannelBans: banStore.getChannelBans.bind(banStore),
    getAllBans: banStore.getAllBans.bind(banStore),
    setSticky: banStore.setSticky.bind(banStore),
    liftExpiredBans: banStore.liftExpiredBans.bind(banStore),
    migrateFromPluginNamespace: banStore.migrateFromPluginNamespace.bind(banStore),
  };

  const api = createMockPluginAPI({
    db: pluginDb,
    banStore: pluginBanStore,
    botConfig: {
      irc: {
        nick: botNick,
        host: 'irc.test',
        port: 6667,
        tls: false,
        username: 'hexbot',
        realname: 'HexBot',
        channels: [],
      },
      owner: { handle: 'owner', hostmask: '*!*@owner.host' },
      identity: { method: 'hostmask', require_acc_for: [] },
      services: { type: 'none', nickserv: 'NickServ', sasl: false },
      logging: { level: 'info', mod_actions: false },
    },
    getChannel: vi.fn().mockReturnValue({ users }),
    mode: modeSpy,
    log: vi.fn(),
    ircLower: (s: string) => s.toLowerCase(),
    bind: vi.fn(),
  });

  return { api, modeSpy, modeCallback, banStore, rawDb };
}

describe('chanmod bans — storeBan / getAllBans / getChannelBans via core BanStore', () => {
  let api: PluginAPI;

  beforeEach(() => {
    ({ api } = makeApi());
  });

  it('storeBan stores a permanent ban (durationMs=0)', () => {
    api.banStore.storeBan('#test', '*!*@bad.host', 'Admin', 0);
    const records = api.banStore.getAllBans();
    expect(records.length).toBe(1);
    expect(records[0].expires).toBe(0);
    expect(records[0].mask).toBe('*!*@bad.host');
  });

  it('storeBan stores a timed ban with future expiry', () => {
    const before = Date.now();
    api.banStore.storeBan('#test', '*!*@bad.host', 'Admin', 3_600_000);
    const records = api.banStore.getAllBans();
    expect(records.length).toBe(1);
    expect(records[0].expires).toBeGreaterThan(before);
  });

  it('getChannelBans returns only bans for a specific channel', () => {
    api.banStore.storeBan('#test', '*!*@a.host', 'Admin', 0);
    api.banStore.storeBan('#other', '*!*@b.host', 'Admin', 0);
    const testBans = api.banStore.getChannelBans('#test');
    expect(testBans.length).toBe(1);
    expect(testBans[0].mask).toBe('*!*@a.host');
  });

  it('removeBan deletes the ban entry', () => {
    api.banStore.storeBan('#test', '*!*@gone.host', 'Admin', 0);
    api.banStore.removeBan('#test', '*!*@gone.host');
    expect(api.banStore.getAllBans().length).toBe(0);
  });
});

describe('chanmod bans — liftExpiredBans via core BanStore', () => {
  it('does not lift permanent bans (expires=0)', () => {
    const { api, modeSpy, modeCallback } = makeApi();
    api.banStore.storeBan('#test', '*!*@perm.host', 'Admin', 0);
    const lifted = api.banStore.liftExpiredBans(() => true, modeCallback);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('does not lift bans that have not expired yet', () => {
    const { api, modeSpy, modeCallback } = makeApi();
    api.banStore.storeBan('#test', '*!*@future.host', 'Admin', 3_600_000);
    const lifted = api.banStore.liftExpiredBans(() => true, modeCallback);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts expired bans when bot has ops', () => {
    const { api, modeSpy, modeCallback, rawDb } = makeApi(true);
    // Manually store a ban that expires in the past
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000,
    };
    rawDb.set('_bans', 'ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = api.banStore.liftExpiredBans(() => true, modeCallback);
    expect(lifted).toBe(1);
    expect(modeSpy).toHaveBeenCalledWith('#test', '-b', '*!*@expired.host');
    expect(api.banStore.getAllBans().length).toBe(0);
  });

  it('does not lift expired ban when bot has no ops', () => {
    const { api, modeSpy, modeCallback, rawDb } = makeApi(false);
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000,
    };
    rawDb.set('_bans', 'ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = api.banStore.liftExpiredBans(() => false, modeCallback);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts multiple expired bans in one pass', () => {
    const { api, modeSpy, modeCallback, rawDb } = makeApi(true);
    const now = Date.now();
    ['*!*@a.host', '*!*@b.host', '*!*@c.host'].forEach((mask) => {
      rawDb.set(
        '_bans',
        `ban:#test:${mask}`,
        JSON.stringify({
          mask,
          channel: '#test',
          by: 'Admin',
          ts: now - 120_000,
          expires: now - 60_000,
        }),
      );
    });

    const lifted = api.banStore.liftExpiredBans(() => true, modeCallback);
    expect(lifted).toBe(3);
    expect(modeSpy).toHaveBeenCalledTimes(3);
  });
});

describe('chanmod bans — setupBans', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs lifted bans after startup timer fires when expired bans exist (singular)', () => {
    const { api, modeSpy, rawDb } = makeApi(true);
    const state = createState();
    const logSpy = api.log as ReturnType<typeof vi.fn>;

    // Store an expired ban in core _bans namespace
    const now = Date.now();
    rawDb.set(
      '_bans',
      'ban:#test:*!*@expired.host',
      JSON.stringify({
        mask: '*!*@expired.host',
        channel: '#test',
        by: 'Admin',
        ts: now - 120_000,
        expires: now - 60_000,
      }),
    );

    const teardown = setupBans(api, {} as never, state);

    // Advance past the 5000ms startup timer
    vi.advanceTimersByTime(5001);

    expect(modeSpy).toHaveBeenCalledWith('#test', '-b', '*!*@expired.host');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Lifted 1 expired ban'));
    expect(state.startupTimer).toBeNull();

    teardown();
  });

  it('logs lifted bans with plural form when multiple bans expired (covers "s" branch)', () => {
    const { api, modeSpy, rawDb } = makeApi(true);
    const state = createState();
    const logSpy = api.log as ReturnType<typeof vi.fn>;

    const now = Date.now();
    for (const mask of ['*!*@expired1.host', '*!*@expired2.host']) {
      rawDb.set(
        '_bans',
        `ban:#test:${mask}`,
        JSON.stringify({
          mask,
          channel: '#test',
          by: 'Admin',
          ts: now - 120_000,
          expires: now - 60_000,
        }),
      );
    }

    setupBans(api, {} as never, state);
    vi.advanceTimersByTime(5001);

    expect(modeSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Lifted 2 expired bans'));
  });

  it('teardown clears the startup timer when called before it fires', () => {
    const { api } = makeApi(true);
    const state = createState();

    const teardown = setupBans(api, {} as never, state);

    expect(state.startupTimer).not.toBeNull();
    teardown();
    expect(state.startupTimer).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(api.log).not.toHaveBeenCalled();
  });

  it('teardown is safe to call when timer has already fired', () => {
    const { api } = makeApi(true);
    const state = createState();

    const teardown = setupBans(api, {} as never, state);
    vi.advanceTimersByTime(5001);

    expect(state.startupTimer).toBeNull();
    expect(() => teardown()).not.toThrow();
  });
});

describe('chanmod bans — migration from plugin namespace', () => {
  it('migrates old ban records to core namespace', () => {
    const { api, rawDb } = makeApi();

    // Store a ban in old chanmod plugin namespace
    rawDb.set(
      'chanmod',
      'ban:#test:*!*@evil.com',
      JSON.stringify({
        mask: '*!*@evil.com',
        channel: '#test',
        by: 'admin',
        ts: Date.now(),
        expires: 0,
      }),
    );

    const count = migrateBansToCore(api);
    expect(count).toBe(1);
    expect(api.banStore.getBan('#test', '*!*@evil.com')).not.toBeNull();
    expect(rawDb.get('chanmod', 'ban:#test:*!*@evil.com')).toBeNull();
  });

  it('reports zero when no old bans exist', () => {
    const { api } = makeApi();
    const count = migrateBansToCore(api);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// helpers — pure function unit tests for uncovered branches
// ---------------------------------------------------------------------------

describe('chanmod helpers — buildBanMask', () => {
  it('returns null when host is empty (covers !host guard)', () => {
    expect(buildBanMask('nick!ident@', 1)).toBeNull();
    expect(buildBanMask('nick!ident@', 2)).toBeNull();
    expect(buildBanMask('nick!ident@', 3)).toBeNull();
  });

  it('type 2 — returns *!*ident@host', () => {
    expect(buildBanMask('nick!evil@bad.host.com', 2)).toBe('*!*evil@bad.host.com');
  });
});

describe('chanmod helpers — formatExpiry', () => {
  it('returns "expired" when ban has already expired (diff <= 0)', () => {
    const past = Date.now() - 60_000;
    expect(formatExpiry(past)).toBe('expired');
  });
});

describe('chanmod helpers — getUserFlags', () => {
  it('returns null when getUserHostmask returns null', () => {
    const api = createMockPluginAPI({
      getUserHostmask: vi.fn().mockReturnValue(null),
      permissions: { findByHostmask: vi.fn(), checkFlags: vi.fn().mockReturnValue(false) },
      ircLower: (s: string) => s.toLowerCase(),
    });

    const result = getUserFlags(api, '#test', 'GhostUser');
    expect(result).toBeNull();
    expect(api.permissions.findByHostmask).not.toHaveBeenCalled();
  });
});

describe('chanmod helpers — botCanHalfop', () => {
  it("returns false when bot is not in the channel users map (covers modes ?? '' branch)", () => {
    const users = new Map<string, { modes: string[] }>();
    const api = createMockPluginAPI({
      getChannel: vi.fn().mockReturnValue({ users }),
      ircLower: (s: string) => s.toLowerCase(),
    });

    expect(botCanHalfop(api, '#test')).toBe(false);
  });
});

describe('chanmod helpers — buildBanMask additional branches', () => {
  it('returns null when there is no @ in the hostmask', () => {
    expect(buildBanMask('noatsignhere', 1)).toBeNull();
    expect(buildBanMask('noatsignhere', 2)).toBeNull();
    expect(buildBanMask('noatsignhere', 3)).toBeNull();
  });

  it('uses * as ident when no ! precedes @ (ident ternary false branch)', () => {
    expect(buildBanMask('@bad.host.com', 2)).toBe('*!**@bad.host.com');
  });
});
