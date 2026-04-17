import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AnopeNoticeBackend,
  AthemeNoticeBackend,
} from '../../plugins/chanmod/chanserv-notice';
import {
  createProbeState,
  markProbePending,
  setupChanServNotice,
} from '../../plugins/chanmod/chanserv-notice';
import type { BackendAccess } from '../../plugins/chanmod/protection-backend';
import type { ChanmodConfig } from '../../plugins/chanmod/state';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function createMockApi() {
  const binds: Array<{ type: string; handler: (ctx: unknown) => void }> = [];
  const logs: string[] = [];
  return {
    api: {
      bind: (type: string, _flags: string, _mask: string, handler: (ctx: unknown) => void) => {
        binds.push({ type, handler });
      },
      ircLower: (s: string) => s.toLowerCase(),
      debug: (...args: unknown[]) => logs.push(String(args[0])),
      log: (...args: unknown[]) => logs.push(String(args[0])),
      warn: (...args: unknown[]) => logs.push(String(args[0])),
      botConfig: { irc: { nick: 'hexbot' } },
      channelSettings: {
        getString: () => 'none',
        set: () => {},
      },
    } as never,
    binds,
    logs,
    /** Dispatch a notice event to the bound handler. */
    notice(nick: string, text: string) {
      for (const b of binds) {
        if (b.type === 'notice') {
          b.handler({ nick, ident: 'services', hostname: 'services.', channel: null, text });
        }
      }
    },
  };
}

function createMockConfig(type: 'atheme' | 'anope' = 'atheme'): ChanmodConfig {
  return {
    chanserv_nick: 'ChanServ',
    chanserv_services_type: type,
  } as ChanmodConfig;
}

function createMockAthemeBackend() {
  const calls: Array<{ channel: string; flags: string }> = [];
  const accessLevels = new Map<string, BackendAccess>();
  const autoDetected = new Set<string>();
  const backend: AthemeNoticeBackend = {
    name: 'atheme',
    handleFlagsResponse(channel: string, flagString: string) {
      calls.push({ channel, flags: flagString });
      if (!accessLevels.has(channel.toLowerCase()) && flagString !== '(none)') {
        accessLevels.set(channel.toLowerCase(), 'op');
        autoDetected.add(channel.toLowerCase());
      }
    },
    getAccess(channel: string) {
      return accessLevels.get(channel.toLowerCase()) ?? 'none';
    },
    isAutoDetected(channel: string) {
      return autoDetected.has(channel.toLowerCase());
    },
  };
  return { backend, calls };
}

function createMockAnopeBackend() {
  const calls: Array<{ channel: string; level: number }> = [];
  const accessLevels = new Map<string, BackendAccess>();
  const autoDetected = new Set<string>();
  const backend: AnopeNoticeBackend = {
    name: 'anope',
    handleAccessResponse(channel: string, level: number) {
      calls.push({ channel, level });
      if (!accessLevels.has(channel.toLowerCase()) && level >= 5) {
        accessLevels.set(channel.toLowerCase(), 'op');
        autoDetected.add(channel.toLowerCase());
      }
    },
    getAccess(channel: string) {
      return accessLevels.get(channel.toLowerCase()) ?? 'none';
    },
    isAutoDetected(channel: string) {
      return autoDetected.has(channel.toLowerCase());
    },
  };
  return { backend, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Atheme FLAGS notice parsing
// ---------------------------------------------------------------------------

describe('ChanServ notice handler — Atheme FLAGS', () => {
  it('parses "2 hexbot +AOehiortv" format and calls handleFlagsResponse', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', '2 hexbot +AOehiortv');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].flags).toBe('+AOehiortv');
    expect(logs.some((l) => l.includes('FLAGS response for #test'))).toBe(true);
  });

  it('parses "Flags for hexbot in #test are +o" alternate format', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', 'Flags for hexbot in #test are +oiA');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].flags).toBe('+oiA');
  });

  it('parses "not found on the access list" error as (none)', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', 'hexbot was not found on the access list of #test.');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].flags).toBe('(none)');
  });

  it('resolves probe on "The channel #test is not registered"', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', 'The channel #test is not registered.');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].flags).toBe('(none)');
  });

  it('ignores notices from non-ChanServ nicks', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('NickServ', '2 hexbot +AOehiortv');

    expect(calls).toHaveLength(0);
  });

  it('ignores notices with different bot nick', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', '2 otherbot +AOehiortv');

    expect(calls).toHaveLength(0);
  });

  it('ignores malformed ChanServ notices', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('ChanServ', 'You are not authorized to perform this operation.');
    notice('ChanServ', 'hexbot is now identified for account hexbot');

    expect(calls).toHaveLength(0);
  });

  it('case-insensitive ChanServ nick matching', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    notice('chanserv', '2 hexbot +o');

    expect(calls).toHaveLength(1);
  });

  it('does not call backend when no pending probe exists', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    // No markProbePending call

    notice('ChanServ', '2 hexbot +o');

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anope ACCESS LIST notice parsing
// ---------------------------------------------------------------------------

describe('ChanServ notice handler — Anope ACCESS LIST', () => {
  it('parses "  1  hexbot  5" format and calls handleAccessResponse', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({
      api,
      config: createMockConfig('anope'),
      backend,
      probeState,
    });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '  1  hexbot  5');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].level).toBe(5);
    expect(logs.some((l) => l.includes('ACCESS response for #test'))).toBe(true);
  });

  it('parses founder-level access (10000)', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '  1  hexbot  10000  [last-seen: now]');

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(10000);
  });

  it('handles "End of access list" when bot is not in the list', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', 'End of access list.');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].level).toBe(0);
  });

  it('ignores notices from non-ChanServ nicks', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('NickServ', '  1  hexbot  5');

    expect(calls).toHaveLength(0);
  });

  it('parses XOP format (SOP) — Rizon/Anope with XOP levels', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '    1   SOP  hexbot');

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(10);
  });

  it('parses XOP format (AOP)', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '    2   AOP  hexbot');

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(5);
  });

  it('parses XOP format (QOP) as founder', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '    1   QOP  hexbot');

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(10000);
  });

  it('handles "#channel access list is empty." (Rizon)', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#hexbot', 'anope');

    notice('ChanServ', '#hexbot access list is empty.');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#hexbot');
    expect(calls[0].level).toBe(0);
  });

  it('resolves probe on "Channel #test isn\'t registered"', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', "Channel #test isn't registered.");

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(0);
  });

  it('resolves probe on generic "Access denied"', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', 'Access denied.');

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anope INFO probe (founder detection)
// ---------------------------------------------------------------------------

describe('ChanServ notice handler — Anope INFO (founder detection)', () => {
  it('detects bot as founder from INFO response', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#hexbot', 'anope-info');

    notice('ChanServ', 'Information for channel #hexbot:');
    notice('ChanServ', '        Founder: hexbot');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#hexbot');
    expect(calls[0].level).toBe(10000);
    expect(logs.some((l) => l.includes('bot is founder'))).toBe(true);
  });

  it('defers ACCESS LIST empty commit until INFO resolves (Rizon flow)', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    // Both probes pending (as auto-op.ts does on join)
    markProbePending(api, probeState, '#hexbot', 'anope');
    markProbePending(api, probeState, '#hexbot', 'anope-info');

    // ACCESS LIST resolves first as empty — commit must be deferred, not applied.
    notice('ChanServ', '#hexbot access list is empty.');
    expect(calls).toHaveLength(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(1);
    expect(logs.some((l) => l.includes('deferring commit until INFO probe resolves'))).toBe(true);

    // INFO response arrives and commits founder directly — no intermediate 'none' commit.
    notice('ChanServ', 'Information for channel #hexbot:');
    notice('ChanServ', '        Founder: hexbot');
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(10000);
    // Founder result supersedes the deferred no-access entry.
    expect(probeState.deferredAnopeNoAccess.size).toBe(0);
  });

  it('flushes deferred no-access commit when INFO resolves as not-founder', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');
    markProbePending(api, probeState, '#test', 'anope-info');

    notice('ChanServ', '#test access list is empty.');
    expect(calls).toHaveLength(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(1);

    notice('ChanServ', 'Information for channel #test:');
    notice('ChanServ', '        Founder: someoneelse');
    notice('ChanServ', 'For more verbose information, type /msg ChanServ INFO #test ALL.');

    // INFO ruled out founder → deferred 'none' commit is flushed now.
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(0);
  });

  it('commits immediately when INFO probe is not pending (no deferral)', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    // Only ACCESS probe (INFO skipped or already resolved)
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', '#test access list is empty.');
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(0);
  });

  it('resolves as not-founder when bot nick does not match', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope-info');

    notice('ChanServ', 'Information for channel #test:');
    notice('ChanServ', '        Founder: someoneelse');
    notice('ChanServ', 'For more verbose information, type /msg ChanServ INFO #test ALL.');

    expect(calls).toHaveLength(0);
    expect(probeState.pendingInfoProbes.size).toBe(0);
    expect(logs.some((l) => l.includes('not founder'))).toBe(true);
  });

  it('ignores INFO response when no info probe is pending', () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    // Only ACCESS probe, no info probe
    markProbePending(api, probeState, '#test', 'anope');

    notice('ChanServ', 'Information for channel #test:');
    notice('ChanServ', '        Founder: hexbot');

    expect(calls).toHaveLength(0);
  });

  it('detects founder when channel name is IRC-bold-wrapped', () => {
    const { api, notice, logs } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#hexbot', 'anope-info');

    // Anope may wrap channel name in \x02 (bold) markers
    notice('ChanServ', 'Information for channel \x02#hexbot\x02:');
    notice('ChanServ', '        Founder: hexbot');

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#hexbot');
    expect(calls[0].level).toBe(10000);
    expect(logs.some((l) => l.includes('bot is founder'))).toBe(true);
  });

  it('cleans up INFO probe on timeout', async () => {
    const { api } = createMockApi();
    const probeState = createProbeState();

    markProbePending(api, probeState, '#test', 'anope-info');
    expect(probeState.pendingInfoProbes.size).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(probeState.pendingInfoProbes.size).toBe(0);
  });

  it('flushes deferredAnopeNoAccess when INFO probe times out', async () => {
    const { api, notice } = createMockApi();
    const { backend, calls } = createMockAnopeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig('anope'), backend, probeState });
    markProbePending(api, probeState, '#test', 'anope');
    markProbePending(api, probeState, '#test', 'anope-info');

    // ACCESS LIST resolves empty first — commit is deferred.
    notice('ChanServ', '#test access list is empty.');
    expect(calls).toHaveLength(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(1);

    // INFO never arrives — timeout must flush the deferred entry.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(probeState.pendingInfoProbes.size).toBe(0);
    expect(probeState.deferredAnopeNoAccess.size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('#test');
    expect(calls[0].level).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe timeout
// ---------------------------------------------------------------------------

describe('ChanServ notice handler — probe timeout', () => {
  it('cleans up pending probe after 10s timeout', async () => {
    const { api, logs } = createMockApi();
    const probeState = createProbeState();

    markProbePending(api, probeState, '#test', 'atheme');
    expect(probeState.pendingAthemeProbes.size).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(probeState.pendingAthemeProbes.size).toBe(0);
    expect(logs.some((l) => l.includes('timed out'))).toBe(true);
  });

  it('does not log timeout if probe was already consumed', async () => {
    const { api, notice, logs } = createMockApi();
    const { backend } = createMockAthemeBackend();
    const probeState = createProbeState();

    setupChanServNotice({ api, config: createMockConfig(), backend, probeState });
    markProbePending(api, probeState, '#test', 'atheme');

    // Response arrives before timeout
    notice('ChanServ', '2 hexbot +o');
    expect(probeState.pendingAthemeProbes.size).toBe(0);

    // Advance past timeout — no duplicate log
    logs.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logs.filter((l) => l.includes('timed out'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anope GETKEY response parsing
// ---------------------------------------------------------------------------

describe('ChanServ notice handler — Anope GETKEY', () => {
  it('parses "Key for channel #chan is thekey." and fires callback', () => {
    const { api, notice } = createMockApi();
    const { backend } = createMockAnopeBackend();
    const probeState = createProbeState();
    const config = createMockConfig('anope');

    setupChanServNotice({ api, config, backend, probeState });

    let receivedKey: string | null | undefined;
    probeState.pendingGetKey.set('#test', (key) => {
      receivedKey = key;
    });

    notice('ChanServ', 'Key for channel \x02#test\x02 is \x02secretkey\x02.');
    expect(receivedKey).toBe('secretkey');
    expect(probeState.pendingGetKey.size).toBe(0);
  });

  it('parses "Key for channel #chan is thekey." without bold markers', () => {
    const { api, notice } = createMockApi();
    const { backend } = createMockAnopeBackend();
    const probeState = createProbeState();
    const config = createMockConfig('anope');

    setupChanServNotice({ api, config, backend, probeState });

    let receivedKey: string | null | undefined;
    probeState.pendingGetKey.set('#test', (key) => {
      receivedKey = key;
    });

    notice('ChanServ', 'Key for channel #test is mykey.');
    expect(receivedKey).toBe('mykey');
  });

  it('parses "Channel #chan has no key." and fires callback with null', () => {
    const { api, notice } = createMockApi();
    const { backend } = createMockAnopeBackend();
    const probeState = createProbeState();
    const config = createMockConfig('anope');

    setupChanServNotice({ api, config, backend, probeState });

    let receivedKey: string | null | undefined;
    probeState.pendingGetKey.set('#test', (key) => {
      receivedKey = key;
    });

    notice('ChanServ', 'Channel \x02#test\x02 has no key.');
    expect(receivedKey).toBeNull();
    expect(probeState.pendingGetKey.size).toBe(0);
  });

  it('ignores GETKEY response when no pending callback', () => {
    const { api, notice } = createMockApi();
    const { backend } = createMockAnopeBackend();
    const probeState = createProbeState();
    const config = createMockConfig('anope');

    setupChanServNotice({ api, config, backend, probeState });

    // No pending GETKEY — should not throw or log errors
    notice('ChanServ', 'Key for channel \x02#other\x02 is \x02somekey\x02.');
    expect(probeState.pendingGetKey.size).toBe(0);
  });
});
