// Covers two LockdownController behaviors:
//   - dropChannel on bot part/kick
//   - early-return in record() while a channel is already locked
import { describe, expect, it, vi } from 'vitest';

import { LockdownController } from '../../../plugins/flood/lockdown';
import type { PluginAPI } from '../../../src/types';

function makeApi(): PluginAPI {
  return {
    ircLower: (s: string) => s.toLowerCase(),
    mode: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    channelSettings: {
      getString: vi.fn().mockReturnValue('R'),
    },
    audit: { log: vi.fn() },
  } as unknown as PluginAPI;
}

const cfg = {
  lockCount: 2,
  lockWindowMs: 10_000,
  lockDurationMs: 60_000,
};

describe('LockdownController (W-FL2/W-FL3)', () => {
  it('triggers a lockdown once lockCount distinct flooders trip the window', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, cfg, () => true);
    lockdown.record('#x', 'alice!a@a');
    lockdown.record('#x', 'bob!b@b');
    expect(api.mode).toHaveBeenCalledWith('#x', '+R');
    lockdown.clear();
  });

  it('record() early-returns for a channel already locked down', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, cfg, () => true);
    lockdown.record('#x', 'a!a@a');
    lockdown.record('#x', 'b!b@b'); // trips lockdown
    // Further `record` calls on the now-locked channel should not grow state
    lockdown.record('#x', 'c!c@c');
    lockdown.record('#x', 'd!d@d');
    // Only the initial +R mode change happened
    expect(api.mode).toHaveBeenCalledTimes(1);
    lockdown.clear();
  });

  it('record() is a no-op when lockCount is 0 (lockdown disabled)', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, { ...cfg, lockCount: 0 }, () => true);
    lockdown.record('#x', 'alice!a@a');
    expect(api.mode).not.toHaveBeenCalled();
  });

  it('dropChannel clears active lock timer and per-channel state', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, cfg, () => true);
    lockdown.record('#x', 'a!a@a');
    lockdown.record('#x', 'b!b@b'); // locked
    lockdown.dropChannel('#x');
    // After drop, a new round of records should be able to trip lockdown again
    lockdown.record('#x', 'c!c@c');
    lockdown.record('#x', 'd!d@d');
    expect(api.mode).toHaveBeenCalledTimes(2); // the second +R
    lockdown.clear();
  });

  it('dropChannel is a no-op for a channel with no lock state', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, cfg, () => true);
    expect(() => lockdown.dropChannel('#unknown')).not.toThrow();
  });

  it('clear() cancels any active lockdown timers', () => {
    const api = makeApi();
    const lockdown = new LockdownController(api, cfg, () => true);
    lockdown.record('#x', 'a!a@a');
    lockdown.record('#x', 'b!b@b');
    lockdown.clear();
    // No throw and no further mode changes
    expect(api.mode).toHaveBeenCalledTimes(1);
  });
});
