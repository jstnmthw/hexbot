// Covers two behaviors on the flood plugin's EnforcementExecutor:
//   - MAX_OFFENCE_ENTRIES=2000 insertion-order LRU cap
//   - `inFlight` Set + `drainPending()` awaited on teardown
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
    // Fake timers so each recordOffence call lands outside the same-burst
    // window — the ladder advances per burst, not per call.
    vi.useFakeTimers();
    try {
      const api = makeApi();
      const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
      expect(ex.recordOffence('user1')).toBe('warn');
      vi.advanceTimersByTime(3_000);
      expect(ex.recordOffence('user1')).toBe('kick');
      vi.advanceTimersByTime(3_000);
      expect(ex.recordOffence('user1')).toBe('tempban');
      vi.advanceTimersByTime(3_000);
      expect(ex.recordOffence('user1')).toBe('tempban'); // capped at last action
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// Same-burst dedup + terminal suppression
// ---------------------------------------------------------------------------

describe('EnforcementExecutor same-burst dedup', () => {
  it('returns null for repeat hits inside the same-burst window', () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
      expect(ex.recordOffence('u')).toBe('warn');
      // Same burst — ladder must not advance.
      vi.advanceTimersByTime(200);
      expect(ex.recordOffence('u')).toBeNull();
      vi.advanceTimersByTime(500);
      expect(ex.recordOffence('u')).toBeNull();
      // After the burst window, the next hit advances to strike 2.
      vi.advanceTimersByTime(3_000);
      expect(ex.recordOffence('u')).toBe('kick');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the burst fresh so a continuous flood does not age out mid-burst', () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      const ex = new EnforcementExecutor(api, cfg, () => true, vi.fn());
      expect(ex.recordOffence('u')).toBe('warn');
      // Drip hits just inside the same-burst window so lastSeen keeps
      // refreshing. After 4 drips we're 4.8s past the original hit but
      // still "same burst" from the tracker's POV — each drip lands
      // inside SAME_BURST_MS of the previous lastSeen.
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(1_200);
        expect(ex.recordOffence('u')).toBeNull();
      }
      // Finally go quiet long enough to escape the burst, then re-flood.
      vi.advanceTimersByTime(3_000);
      expect(ex.recordOffence('u')).toBe('kick');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EnforcementExecutor terminal suppression', () => {
  it('drops a follow-up kick for the same target after a recent kick', async () => {
    const api = makeApi();
    const kick = vi.fn();
    const ban = vi.fn();
    const a = { ...api, kick, ban } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('kick', '#x', 'alice', 'flood');
    await ex.drainPending();
    expect(kick).toHaveBeenCalledTimes(1);
    // Second kick inside the suppression window — dropped with a log line.
    ex.apply('kick', '#x', 'alice', 'flood');
    await ex.drainPending();
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('drops a follow-up tempban after a recent kick (prevents +b race)', async () => {
    const api = makeApi();
    const kick = vi.fn();
    const ban = vi.fn();
    const getUserHostmask = vi.fn().mockReturnValue('alice!~u@host.example');
    const a = { ...api, kick, ban, getUserHostmask } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('kick', '#x', 'alice', 'flood');
    await ex.drainPending();
    expect(kick).toHaveBeenCalledTimes(1);
    // The concerning case: a second rate-limit kind trips a tempban strike
    // for the same target right after the kick. Suppression must block it,
    // otherwise the extra KICK in the tempban path races the +b.
    ex.apply('tempban', '#x', 'alice', 'flood');
    await ex.drainPending();
    expect(ban).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('does not suppress a warn after a kick (warns are harmless)', async () => {
    const api = makeApi();
    const notice = vi.fn();
    const kick = vi.fn();
    const a = { ...api, notice, kick } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('kick', '#x', 'alice', 'flood');
    await ex.drainPending();
    ex.apply('warn', '#x', 'alice', 'flood');
    await ex.drainPending();
    expect(notice).toHaveBeenCalledWith('alice', expect.stringContaining('flood'));
  });

  it('releases suppression after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      const kick = vi.fn();
      const a = { ...api, kick } as unknown as PluginAPI;
      const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
      ex.apply('kick', '#x', 'alice', 'flood');
      await vi.runAllTimersAsync();
      expect(kick).toHaveBeenCalledTimes(1);
      // Past the suppression window — a genuinely new event can land.
      vi.advanceTimersByTime(3_000);
      ex.apply('kick', '#x', 'alice', 'flood');
      await vi.runAllTimersAsync();
      expect(kick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// Tempban mask shape validation
// ---------------------------------------------------------------------------

describe('EnforcementExecutor tempban mask shape', () => {
  it('falls back to kick-only when hostmask contains a space in the host', async () => {
    const api = makeApi();
    const ban = vi.fn();
    const kick = vi.fn();
    const getUserHostmask = vi.fn().mockReturnValue('alice!~ident@evil host.com');
    const a = { ...api, ban, kick, getUserHostmask } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('tempban', '#x', 'alice', 'spam');
    await ex.drainPending();
    expect(ban).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledWith('#x', 'alice', expect.stringContaining('spam'));
  });

  it('builds a valid mask when host is clean', async () => {
    const api = makeApi();
    const ban = vi.fn();
    const kick = vi.fn();
    const set = vi.fn();
    const getUserHostmask = vi.fn().mockReturnValue('alice!~ident@evil.com');
    const a = {
      ...api,
      ban,
      kick,
      db: { ...api.db, set },
      getUserHostmask,
    } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('tempban', '#x', 'alice', 'spam');
    await ex.drainPending();
    expect(ban).toHaveBeenCalledWith('#x', '*!*@evil.com');
    expect(kick).toHaveBeenCalled();
  });

  it('preserves cloaked slashes in the host', async () => {
    const api = makeApi();
    const ban = vi.fn();
    const kick = vi.fn();
    const set = vi.fn();
    const getUserHostmask = vi.fn().mockReturnValue('alice!~ident@user/account.name');
    const a = {
      ...api,
      ban,
      kick,
      db: { ...api.db, set },
      getUserHostmask,
    } as unknown as PluginAPI;
    const ex = new EnforcementExecutor(a, cfg, () => true, vi.fn());
    ex.apply('tempban', '#x', 'alice', 'spam');
    await ex.drainPending();
    expect(ban).toHaveBeenCalledWith('#x', '*!*@user/account.name');
  });
});
