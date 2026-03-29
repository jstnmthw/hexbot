// Unit tests for plugins/chanmod/bans.ts
// Tests liftExpiredBans, storeBan, getAllBanRecords, getChannelBanRecords directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAllBanRecords,
  getChannelBanRecords,
  liftExpiredBans,
  removeBanRecord,
  setupBans,
  storeBan,
} from '../../plugins/chanmod/bans';
import {
  botCanHalfop,
  buildBanMask,
  formatExpiry,
  getUserFlags,
} from '../../plugins/chanmod/helpers';
import { createState } from '../../plugins/chanmod/state';
import { BotDatabase } from '../../src/database';
import { createLogger } from '../../src/logger';
import type { PluginAPI, PluginDB } from '../../src/types';

/** Wrap a BotDatabase with a namespace to create a PluginDB (as plugin-loader does). */
function makePluginDb(db: BotDatabase, ns: string): PluginDB {
  return {
    get: (key) => db.get(ns, key) ?? undefined,
    set: (key, value) => db.set(ns, key, value),
    del: (key) => db.del(ns, key),
    list: (prefix) => db.list(ns, prefix),
  };
}

function makeApi(botHasOps = true): { api: PluginAPI; modeSpy: ReturnType<typeof vi.fn> } {
  const rawDb = new BotDatabase(':memory:', createLogger('error'));
  rawDb.open();
  const pluginDb = makePluginDb(rawDb, 'chanmod');

  const botNick = 'hexbot';
  const users = new Map<string, { modes: string[] }>();
  if (botHasOps) users.set(botNick, { modes: ['o'] });

  const modeSpy = vi.fn();

  const api = {
    db: pluginDb,
    casemapping: 'rfc1459' as const,
    botConfig: { irc: { nick: botNick } },
    getChannel: vi.fn().mockReturnValue({ users }),
    mode: modeSpy,
    log: vi.fn(),
    ircLower: (s: string) => s.toLowerCase(),
    bind: vi.fn(),
  } as unknown as PluginAPI;

  return { api, modeSpy };
}

describe('chanmod bans — storeBan / getAllBanRecords / getChannelBanRecords', () => {
  let api: PluginAPI;

  beforeEach(() => {
    ({ api } = makeApi());
  });

  it('storeBan stores a permanent ban (durationMinutes=0)', () => {
    storeBan(api, '#test', '*!*@bad.host', 'Admin', 0);
    const records = getAllBanRecords(api);
    expect(records.length).toBe(1);
    expect(records[0].expires).toBe(0);
    expect(records[0].mask).toBe('*!*@bad.host');
  });

  it('storeBan stores a timed ban with future expiry', () => {
    const before = Date.now();
    storeBan(api, '#test', '*!*@bad.host', 'Admin', 60);
    const records = getAllBanRecords(api);
    expect(records.length).toBe(1);
    expect(records[0].expires).toBeGreaterThan(before);
  });

  it('getChannelBanRecords returns only bans for a specific channel', () => {
    storeBan(api, '#test', '*!*@a.host', 'Admin', 0);
    storeBan(api, '#other', '*!*@b.host', 'Admin', 0);
    const testBans = getChannelBanRecords(api, '#test');
    expect(testBans.length).toBe(1);
    expect(testBans[0].mask).toBe('*!*@a.host');
  });

  it('removeBanRecord deletes the ban entry', () => {
    storeBan(api, '#test', '*!*@gone.host', 'Admin', 0);
    removeBanRecord(api, '#test', '*!*@gone.host');
    expect(getAllBanRecords(api).length).toBe(0);
  });
});

describe('chanmod bans — liftExpiredBans', () => {
  it('does not lift permanent bans (expires=0)', () => {
    const { api, modeSpy } = makeApi();
    storeBan(api, '#test', '*!*@perm.host', 'Admin', 0);
    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('does not lift bans that have not expired yet', () => {
    const { api, modeSpy } = makeApi();
    storeBan(api, '#test', '*!*@future.host', 'Admin', 60); // 60 minutes in future
    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts expired bans when bot has ops', () => {
    const { api, modeSpy } = makeApi(true); // bot has ops
    // Manually store a ban that expires in the past
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000, // expired 1 minute ago
    };
    api.db.set('ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(1);
    expect(modeSpy).toHaveBeenCalledWith('#test', '-b', '*!*@expired.host');
    expect(getAllBanRecords(api).length).toBe(0);
  });

  it('does not lift expired ban when bot has no ops', () => {
    const { api, modeSpy } = makeApi(false); // bot has no ops
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000,
    };
    api.db.set('ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts multiple expired bans in one pass', () => {
    const { api, modeSpy } = makeApi(true);
    const now = Date.now();
    ['*!*@a.host', '*!*@b.host', '*!*@c.host'].forEach((mask) => {
      api.db.set(
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

    const lifted = liftExpiredBans(api);
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
    const { api, modeSpy } = makeApi(true);
    const state = createState();
    const logSpy = api.log as ReturnType<typeof vi.fn>;

    // Store an expired ban
    const now = Date.now();
    api.db.set(
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
    const { api, modeSpy } = makeApi(true);
    const state = createState();
    const logSpy = api.log as ReturnType<typeof vi.fn>;

    const now = Date.now();
    // Store two expired bans
    for (const mask of ['*!*@expired1.host', '*!*@expired2.host']) {
      api.db.set(
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

    // Timer is still pending
    expect(state.startupTimer).not.toBeNull();

    // Calling teardown before the timer fires should clear it
    teardown();
    expect(state.startupTimer).toBeNull();

    // Advancing time should not trigger the startup logic
    vi.advanceTimersByTime(10_000);
    expect(api.log).not.toHaveBeenCalled();
  });

  it('teardown is safe to call when timer has already fired', () => {
    const { api } = makeApi(true);
    const state = createState();

    const teardown = setupBans(api, {} as never, state);
    vi.advanceTimersByTime(5001); // timer fires, sets startupTimer = null

    expect(state.startupTimer).toBeNull();
    // Calling teardown again should not throw
    expect(() => teardown()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// helpers — pure function unit tests for uncovered branches
// ---------------------------------------------------------------------------

describe('chanmod helpers — buildBanMask', () => {
  it('returns null when host is empty (covers !host guard)', () => {
    // hostmask with empty host: "nick!ident@"
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
    const past = Date.now() - 60_000; // 1 minute in the past
    expect(formatExpiry(past)).toBe('expired');
  });
});

describe('chanmod helpers — getUserFlags', () => {
  it('returns null when getUserHostmask returns null', () => {
    const api = {
      getUserHostmask: vi.fn().mockReturnValue(null),
      permissions: { findByHostmask: vi.fn() },
      ircLower: (s: string) => s.toLowerCase(),
    } as unknown as PluginAPI;

    const result = getUserFlags(api, '#test', 'GhostUser');
    expect(result).toBeNull();
    expect(api.permissions.findByHostmask).not.toHaveBeenCalled();
  });
});

describe('chanmod helpers — botCanHalfop', () => {
  it("returns false when bot is not in the channel users map (covers modes ?? '' branch)", () => {
    // Channel exists but the bot nick is absent from its users map
    const users = new Map<string, { modes: string[] }>();
    const api = {
      botConfig: { irc: { nick: 'hexbot' } },
      getChannel: vi.fn().mockReturnValue({ users }),
      ircLower: (s: string) => s.toLowerCase(),
    } as unknown as PluginAPI;

    expect(botCanHalfop(api, '#test')).toBe(false);
  });
});

describe('chanmod helpers — buildBanMask additional branches', () => {
  it('returns null when there is no @ in the hostmask', () => {
    // atIdx === -1 branch in buildBanMask
    expect(buildBanMask('noatsignhere', 1)).toBeNull();
    expect(buildBanMask('noatsignhere', 2)).toBeNull();
    expect(buildBanMask('noatsignhere', 3)).toBeNull();
  });

  it('uses * as ident when no ! precedes @ (ident ternary false branch)', () => {
    // bangIdx === -1: ident falls back to '*' → type 2 mask = *!**@host
    expect(buildBanMask('@bad.host.com', 2)).toBe('*!**@bad.host.com');
  });
});
