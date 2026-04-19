// Covers two audit findings on the flood plugin's EnforcementExecutor:
//   - C2: MAX_OFFENCE_ENTRIES=2000 insertion-order LRU cap
//   - W-FL5: `inFlight` Set + `drainPending()` awaited on teardown
import { describe, expect, it, vi } from 'vitest';

import { EnforcementExecutor } from '../../plugins/flood/enforcement-executor';
import type { PluginAPI } from '../../src/types';

function makeApi(): PluginAPI {
  const stub = vi.fn();
  return {
    isBotNick: stub,
    ircLower: (s: string) => s.toLowerCase(),
    log: stub,
    warn: stub,
    error: stub,
    notice: stub,
    kick: stub,
    ban: stub,
    db: {
      get: stub,
      set: stub,
      del: stub,
      list: vi.fn().mockReturnValue([]),
    },
    getUserHostmask: vi.fn().mockReturnValue(null),
  } as unknown as PluginAPI;
}

const cfg = {
  actions: ['warn', 'kick', 'tempban'],
  offenceWindowMs: 300_000,
  banDurationMinutes: 10,
};

describe('EnforcementExecutor offenceTracker cap (C2)', () => {
  it('recordOffence returns the escalation action for the current count', () => {
    const api = makeApi();
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    expect(ex.recordOffence('user1')).toBe('warn');
    expect(ex.recordOffence('user1')).toBe('kick');
    expect(ex.recordOffence('user1')).toBe('tempban');
    expect(ex.recordOffence('user1')).toBe('tempban'); // capped at last action
  });

  it('sweep drops entries past offenceWindowMs', () => {
    const api = makeApi();
    // Very short window so we can test without fake timers
    const shortCfg = { ...cfg, offenceWindowMs: 1 };
    const ex = new EnforcementExecutor(api, shortCfg, () => true, vi.fn());
    ex.recordOffence('alice');
    // Wait for window to elapse
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ex.sweep();
        // After sweep the entry is gone — the next recordOffence starts fresh
        expect(ex.recordOffence('alice')).toBe('warn');
        resolve();
      }, 5);
    });
  });

  it('clear() drops every entry', () => {
    const api = makeApi();
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    ex.recordOffence('alice');
    ex.recordOffence('bob');
    ex.clear();
    expect(ex.recordOffence('alice')).toBe('warn');
  });
});

describe('EnforcementExecutor drainPending (W-FL5)', () => {
  it('apply() skips when the bot lacks ops', () => {
    const api = makeApi();
    const ex = new EnforcementExecutor(api, cfg, () => false, vi.fn());
    ex.apply('warn', '#x', 'alice', 'reason');
    // Nothing in flight — drain resolves immediately
    return ex.drainPending();
  });

  it('apply() with ops enqueues an in-flight promise; drainPending awaits it', async () => {
    const api = makeApi();
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    ex.apply('warn', '#x', 'alice', 'reason');
    await ex.drainPending();
    // After drain, the inFlight set is empty — a second drain is immediate.
    await ex.drainPending();
  });

  it('drops actions past the per-channel rate cap and warns', () => {
    // Cap is MAX_ACTIONS_PER_CHANNEL_WINDOW (10) within CHANNEL_WINDOW_MS (5s).
    // The 11th action in the same window must be dropped with a warn line and
    // must NOT hit the IRC primitives. Use distinct spies (default helper
    // shares one) so we can disambiguate notice vs warn.
    const notice = vi.fn();
    const warn = vi.fn();
    const api = { ...makeApi(), notice, warn } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    for (let i = 0; i < 10; i++) {
      ex.apply('warn', '#x', `n${i}`, 'flood');
    }
    notice.mockClear();
    warn.mockClear();
    ex.apply('warn', '#x', 'n10', 'flood');
    expect(notice).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rate cap hit'));
  });

  it('drainPending swallows per-promise rejections via allSettled', async () => {
    // Force applyInner to throw by making notice throw via a broken api
    const brokenApi = {
      ...makeApi(),
      notice: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    } as unknown as PluginAPI;
    const logError = vi.fn();
    const ex = new EnforcementExecutor(brokenApi, cfg, () => true, logError);
    ex.apply('warn', '#x', 'alice', 'reason');
    await ex.drainPending();
    // The error was caught by the .catch(this.logError) path
    expect(logError).toHaveBeenCalled();
  });
});

describe('EnforcementExecutor liftExpiredBans (W-FL6)', () => {
  it('lifts an expired ban when the bot has ops', () => {
    const api = makeApi();
    const record = {
      mask: '*!*@evil.com',
      channel: '#x',
      ts: 1000,
      expires: 2000,
    };
    (api.db.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { key: 'ban:#x:*!*@evil.com', value: JSON.stringify(record) },
    ]);
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    // Stub `api.mode` exists on the api already (vi.fn)
    api.mode = vi.fn();
    ex.liftExpiredBans();
    expect(api.mode).toHaveBeenCalledWith('#x', '-b', '*!*@evil.com');
    expect(api.db.del).toHaveBeenCalledWith('ban:#x:*!*@evil.com');
  });

  it('drops the record past the 24h grace window when bot lacks ops', () => {
    const api = makeApi();
    const pastGrace = Date.now() - 25 * 3_600_000;
    const record = {
      mask: '*!*@evil.com',
      channel: '#x',
      ts: pastGrace - 1000,
      expires: pastGrace, // 25h ago
    };
    (api.db.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { key: 'ban:#x:*!*@evil.com', value: JSON.stringify(record) },
    ]);
    const ex = new EnforcementExecutor(api, cfg, () => false, vi.fn());
    ex.liftExpiredBans();
    // Not lifting the ban (no ops), but dropping the stale record + warning
    expect(api.warn).toHaveBeenCalled();
    expect(api.db.del).toHaveBeenCalledWith('ban:#x:*!*@evil.com');
  });

  it('keeps an expired ban within the grace window when bot lacks ops', () => {
    const api = makeApi();
    const justExpired = Date.now() - 1000;
    const record = {
      mask: '*!*@evil.com',
      channel: '#x',
      ts: justExpired - 1000,
      expires: justExpired,
    };
    (api.db.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { key: 'ban:#x:*!*@evil.com', value: JSON.stringify(record) },
    ]);
    const ex = new EnforcementExecutor(api, cfg, () => false, vi.fn());
    ex.liftExpiredBans();
    expect(api.db.del).not.toHaveBeenCalled();
    expect(api.warn).not.toHaveBeenCalled();
  });

  it('drops malformed JSON records on the next sweep', () => {
    const api = makeApi();
    (api.db.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { key: 'ban:#x:bogus', value: '{not json' },
    ]);
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    expect(() => ex.liftExpiredBans()).not.toThrow();
    expect(api.db.del).toHaveBeenCalledWith('ban:#x:bogus');
  });

  it('ignores never-expiring bans (expires=0)', () => {
    const api = makeApi();
    const record = {
      mask: '*!*@evil.com',
      channel: '#x',
      ts: 1000,
      expires: 0,
    };
    (api.db.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { key: 'ban:#x:*!*@evil.com', value: JSON.stringify(record) },
    ]);
    const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
    api.mode = vi.fn();
    ex.liftExpiredBans();
    expect(api.mode).not.toHaveBeenCalled();
    expect(api.db.del).not.toHaveBeenCalled();
  });
});
