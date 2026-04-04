import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../plugins/ai-chat/rate-limiter';

function makeLimiter(overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) {
  return new RateLimiter({
    userCooldownSeconds: 30,
    channelCooldownSeconds: 10,
    globalRpm: 10,
    globalRpd: 100,
    ...overrides,
  });
}

describe('RateLimiter', () => {
  it('allows the first call from a user', () => {
    const rl = makeLimiter();
    expect(rl.check('alice', '#chan', 1000).allowed).toBe(true);
  });

  it('blocks a second call inside the user cooldown', () => {
    const rl = makeLimiter({ userCooldownSeconds: 30, channelCooldownSeconds: 0 });
    rl.record('alice', null, 1000);
    const res = rl.check('alice', null, 5000);
    expect(res.allowed).toBe(false);
    expect(res.limitedBy).toBe('user');
    expect(res.retryAfterMs).toBe(30_000 - 4_000);
  });

  it('allows again after the user cooldown elapses', () => {
    const rl = makeLimiter({ userCooldownSeconds: 30, channelCooldownSeconds: 0 });
    rl.record('alice', null, 1000);
    expect(rl.check('alice', null, 31_001).allowed).toBe(true);
  });

  it('enforces channel cooldown independently of user', () => {
    const rl = makeLimiter({ userCooldownSeconds: 0, channelCooldownSeconds: 10 });
    rl.record('alice', '#chan', 1000);
    const res = rl.check('bob', '#chan', 2000);
    expect(res.allowed).toBe(false);
    expect(res.limitedBy).toBe('channel');
  });

  it('ignores channel cooldown for PMs (channelKey null)', () => {
    const rl = makeLimiter({ userCooldownSeconds: 0, channelCooldownSeconds: 10 });
    rl.record('alice', '#chan', 1000);
    expect(rl.check('bob', null, 2000).allowed).toBe(true);
  });

  it('blocks at the global RPM limit', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 3,
      globalRpd: 1000,
    });
    rl.record('a', null, 0);
    rl.record('b', null, 100);
    rl.record('c', null, 200);
    const res = rl.check('d', null, 300);
    expect(res.allowed).toBe(false);
    expect(res.limitedBy).toBe('rpm');
  });

  it('recovers after the RPM window slides past', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 2,
      globalRpd: 1000,
    });
    rl.record('a', null, 0);
    rl.record('b', null, 100);
    expect(rl.check('c', null, 500).allowed).toBe(false);
    // 60s after the first call, it should drop out of the window.
    expect(rl.check('c', null, 60_001).allowed).toBe(true);
  });

  it('blocks at the global RPD limit', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 100,
      globalRpd: 2,
    });
    rl.record('a', null, 0);
    rl.record('b', null, 100);
    const res = rl.check('c', null, 200);
    expect(res.allowed).toBe(false);
    expect(res.limitedBy).toBe('rpd');
  });

  it('lets 0-valued limits disable each layer', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 0,
      globalRpd: 0,
    });
    for (let i = 0; i < 100; i++) rl.record(`u${i}`, '#c', i);
    expect(rl.check('u0', '#c', 101).allowed).toBe(true);
  });

  it('applies RPD block before RPM block', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 1,
      globalRpd: 1,
    });
    rl.record('a', null, 0);
    const res = rl.check('b', null, 100);
    expect(res.limitedBy).toBe('rpd');
  });

  it('reset() wipes all counters', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 30,
      channelCooldownSeconds: 10,
      globalRpm: 1,
      globalRpd: 1,
    });
    rl.record('a', '#c', 0);
    rl.reset();
    expect(rl.check('a', '#c', 10).allowed).toBe(true);
  });

  it('checkGlobal() ignores per-user/per-channel cooldowns', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 60,
      channelCooldownSeconds: 60,
      globalRpm: 100,
      globalRpd: 100,
    });
    rl.record('alice', '#c', 0);
    expect(rl.check('alice', '#c', 100).allowed).toBe(false);
    expect(rl.checkGlobal(100).allowed).toBe(true);
  });

  it('checkGlobal() still enforces RPM/RPD', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 2,
      globalRpd: 100,
    });
    rl.record('a', null, 0);
    rl.record('b', null, 100);
    const res = rl.checkGlobal(200);
    expect(res.allowed).toBe(false);
    expect(res.limitedBy).toBe('rpm');
  });

  it('checkGlobal() enforces RPD before RPM', () => {
    const rl = makeLimiter({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 1,
      globalRpd: 1,
    });
    rl.record('a', null, 0);
    expect(rl.checkGlobal(100).limitedBy).toBe('rpd');
  });

  it('setConfig() updates active limits', () => {
    const rl = makeLimiter({ userCooldownSeconds: 30, channelCooldownSeconds: 0 });
    rl.record('a', null, 0);
    expect(rl.check('a', null, 100).allowed).toBe(false);
    rl.setConfig({
      userCooldownSeconds: 0,
      channelCooldownSeconds: 0,
      globalRpm: 0,
      globalRpd: 0,
    });
    expect(rl.check('a', null, 100).allowed).toBe(true);
  });
});
