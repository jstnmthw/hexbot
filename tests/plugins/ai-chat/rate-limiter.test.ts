import { describe, expect, it } from 'vitest';

import { RateLimiter, type RateLimiterConfig } from '../../../plugins/ai-chat/rate-limiter';

function makeLimiter(overrides: Partial<RateLimiterConfig> = {}): RateLimiter {
  return new RateLimiter({
    userBurst: 3,
    userRefillSeconds: 12,
    globalRpm: 10,
    globalRpd: 100,
    rpmBackpressurePct: 80,
    ...overrides,
  });
}

describe('RateLimiter', () => {
  describe('per-user token bucket', () => {
    it('allows the first call from a user', () => {
      const rl = makeLimiter();
      expect(rl.check('alice', 1000).allowed).toBe(true);
    });

    it('grants burst tokens worth of rapid calls without delay', () => {
      const rl = makeLimiter({ userBurst: 3 });
      for (let i = 0; i < 3; i++) {
        const res = rl.check('alice', 1000 + i);
        expect(res.allowed).toBe(true);
        rl.record('alice', 1000 + i);
      }
    });

    it('blocks the call after burst is exhausted', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      for (let i = 0; i < 3; i++) rl.record('alice', 1000 + i);
      const res = rl.check('alice', 1100);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('user');
      // Last record was at 1002 (lastRefill); refill is 12000ms; check at 1100.
      expect(res.retryAfterMs).toBe(12_000 - (1100 - 1000));
    });

    it('refills one token after `userRefillSeconds` and allows one more call', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      for (let i = 0; i < 3; i++) rl.record('alice', 1000 + i);
      // Just before refill window — still blocked.
      expect(rl.check('alice', 12_999).allowed).toBe(false);
      // At/after refill — one token granted.
      const ok = rl.check('alice', 13_000);
      expect(ok.allowed).toBe(true);
      rl.record('alice', 13_000);
      // Immediately again — bucket is empty again.
      expect(rl.check('alice', 13_001).allowed).toBe(false);
    });

    it('sustains at one call per `userRefillSeconds` after burst', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      for (let i = 0; i < 3; i++) rl.record('alice', 1000 + i);
      let now = 1000;
      for (let i = 0; i < 5; i++) {
        now += 12_000;
        expect(rl.check('alice', now).allowed).toBe(true);
        rl.record('alice', now);
      }
    });

    it('keeps user buckets independent', () => {
      const rl = makeLimiter({ userBurst: 3 });
      for (let i = 0; i < 3; i++) rl.record('alice', 1000 + i);
      expect(rl.check('alice', 1100).allowed).toBe(false);
      expect(rl.check('bob', 1100).allowed).toBe(true);
    });

    it('refills do not exceed burst capacity (no over-accumulation while idle)', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      rl.record('alice', 1000);
      // Wait an hour — bucket should still cap at 3 tokens, not 300.
      // After capping, user can fire exactly burst (3) in a row, then blocked.
      for (let i = 0; i < 3; i++) {
        expect(rl.check('alice', 3_601_000 + i).allowed).toBe(true);
        rl.record('alice', 3_601_000 + i);
      }
      expect(rl.check('alice', 3_601_100).allowed).toBe(false);
    });

    it('userBurst:0 disables the per-user bucket', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 0, globalRpd: 0 });
      for (let i = 0; i < 100; i++) rl.record('alice', i);
      expect(rl.check('alice', 101).allowed).toBe(true);
    });
  });

  describe('global RPM/RPD windows', () => {
    it('blocks at the global RPM limit', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 3, globalRpd: 1000 });
      rl.record('a', 0);
      rl.record('b', 100);
      rl.record('c', 200);
      const res = rl.check('d', 300);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('rpm');
    });

    it('recovers after the RPM window slides past', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 2, globalRpd: 1000 });
      rl.record('a', 0);
      rl.record('b', 100);
      expect(rl.check('c', 500).allowed).toBe(false);
      expect(rl.check('c', 60_001).allowed).toBe(true);
    });

    it('blocks at the global RPD limit', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 100, globalRpd: 2 });
      rl.record('a', 0);
      rl.record('b', 100);
      const res = rl.check('c', 200);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('rpd');
    });

    it('reports RPD before RPM when both are exhausted', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 1, globalRpd: 1 });
      rl.record('a', 0);
      const res = rl.check('b', 100);
      expect(res.limitedBy).toBe('rpd');
    });

    it('lets all 0-valued limits disable each layer', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 0, globalRpd: 0 });
      for (let i = 0; i < 100; i++) rl.record(`u${i}`, i);
      expect(rl.check('u0', 101).allowed).toBe(true);
    });
  });

  describe('RPM backpressure', () => {
    it('halves effective burst when RPM usage crosses the threshold', () => {
      // globalRpm: 20, threshold: 80% → kicks in once minuteWindow has > 16 entries.
      // Pre-load 17 calls (85% usage); leaves headroom so the per-user bucket
      // is the limiter, not the global RPM cap.
      const rl = makeLimiter({
        userBurst: 4,
        userRefillSeconds: 12,
        globalRpm: 20,
        rpmBackpressurePct: 80,
      });
      for (let i = 0; i < 17; i++) rl.record(`u${i}`, 1000 + i);
      // Alice's burst of 4 should be halved to 2.
      expect(rl.check('alice', 1100).allowed).toBe(true);
      rl.record('alice', 1100);
      expect(rl.check('alice', 1101).allowed).toBe(true);
      rl.record('alice', 1101);
      const res = rl.check('alice', 1102);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('user');
    });

    it('restores full burst when RPM usage drops below threshold', () => {
      const rl = makeLimiter({
        userBurst: 4,
        userRefillSeconds: 12,
        globalRpm: 20,
        rpmBackpressurePct: 80,
      });
      for (let i = 0; i < 17; i++) rl.record(`u${i}`, 1000 + i);
      // Slide forward 61 seconds — minute window is empty.
      const later = 1000 + 61_000;
      // Alice's full burst of 4 should be restored.
      for (let i = 0; i < 4; i++) {
        expect(rl.check('alice', later + i).allowed).toBe(true);
        rl.record('alice', later + i);
      }
      const res = rl.check('alice', later + 100);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('user');
    });

    it('rpmBackpressurePct:0 disables backpressure', () => {
      // globalRpm: 30, threshold: would be 80% = 24 → pre-load 25 to push past it.
      // Headroom: 30 - 25 - 4 = 1 slot left after alice's burst, so RPM doesn't cap.
      const rl = makeLimiter({
        userBurst: 4,
        userRefillSeconds: 12,
        globalRpm: 30,
        rpmBackpressurePct: 0,
      });
      for (let i = 0; i < 25; i++) rl.record(`u${i}`, 1000 + i);
      // Alice's full burst of 4 should still be available — no halving.
      for (let i = 0; i < 4; i++) {
        expect(rl.check('alice', 1100 + i).allowed).toBe(true);
        rl.record('alice', 1100 + i);
      }
      // Fifth call exhausts the bucket — proves burst was 4, not 2.
      expect(rl.check('alice', 1200).limitedBy).toBe('user');
    });
  });

  describe('checkGlobal', () => {
    it('ignores the per-user bucket', () => {
      const rl = makeLimiter({
        userBurst: 1,
        userRefillSeconds: 60,
        globalRpm: 100,
        globalRpd: 100,
      });
      rl.record('alice', 0);
      // Per-user bucket is now empty — check() blocks.
      expect(rl.check('alice', 100).allowed).toBe(false);
      // checkGlobal bypasses per-user bucket.
      expect(rl.checkGlobal(100).allowed).toBe(true);
    });

    it('still enforces RPM/RPD', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 2, globalRpd: 100 });
      rl.record('a', 0);
      rl.record('b', 100);
      const res = rl.checkGlobal(200);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('rpm');
    });

    it('reports RPD before RPM in checkGlobal', () => {
      const rl = makeLimiter({ userBurst: 0, globalRpm: 1, globalRpd: 1 });
      rl.record('a', 0);
      expect(rl.checkGlobal(100).limitedBy).toBe('rpd');
    });
  });

  describe('lifecycle', () => {
    it('reset() clears buckets so full burst is available again', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      for (let i = 0; i < 3; i++) rl.record('alice', 1000 + i);
      expect(rl.check('alice', 1100).allowed).toBe(false);
      rl.reset();
      for (let i = 0; i < 3; i++) {
        expect(rl.check('alice', 2000 + i).allowed).toBe(true);
        rl.record('alice', 2000 + i);
      }
      expect(rl.check('alice', 2100).allowed).toBe(false);
    });

    it('setConfig() hot-reloads burst/refill values for the next check', () => {
      const rl = makeLimiter({ userBurst: 1, userRefillSeconds: 60 });
      rl.record('alice', 0);
      // Small bucket, long refill — blocked.
      expect(rl.check('alice', 100).allowed).toBe(false);
      // Loosen to a much bigger burst.
      rl.setConfig({
        userBurst: 5,
        userRefillSeconds: 1,
        globalRpm: 100,
        globalRpd: 100,
        rpmBackpressurePct: 80,
      });
      // Existing bucket still has 0 tokens, but waiting 1s now refills 1.
      expect(rl.check('alice', 1_100).allowed).toBe(true);
    });
  });

  describe('initialState seed', () => {
    it('pre-populates every window + bucket via constructor seed', () => {
      const now = 1_000_000;
      const rl = new RateLimiter(
        {
          userBurst: 3,
          userRefillSeconds: 12,
          globalRpm: 2,
          globalRpd: 3,
          rpmBackpressurePct: 80,
          ambientPerChannelPerHour: 2,
          ambientGlobalPerHour: 2,
        },
        {
          userBuckets: [['alice', { tokens: 0, lastRefill: now }]],
          minuteWindow: [now - 1_000, now - 500],
          dayWindow: [now - 1_000, now - 500, now - 100],
          ambientChannelWindows: [['#chan', [now - 1_000, now - 500]]],
          ambientGlobalWindow: [now - 1_000, now - 500],
        },
      );
      // RPD (3 already) is the first limit hit.
      const res = rl.check('bob', now);
      expect(res.allowed).toBe(false);
      expect(res.limitedBy).toBe('rpd');
      // Ambient budgets are also pre-filled — both channel and global caps hit.
      expect(rl.checkAmbient('#chan', now)).toBe(false);
    });
  });

  describe('stale bucket eviction', () => {
    it('evicts a fully drained drive-by bucket idle past the cutoff once the sweep cadence fires', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      // 70 buckets at t=0 — pushes size past the 64 floor.
      for (let i = 0; i < 70; i++) rl.record(`user${i}`, 0);
      // A drive-by drains their whole burst and vanishes — tokens frozen at
      // 0 (< burst), the case the old `tokens >= burst` filter never matched.
      for (let i = 0; i < 3; i++) rl.record('driveby', i);
      expect(rl.userBucketCount).toBe(71);
      // 2h later everything above is idle past the 1h cutoff. Drive enough
      // bucket lookups to guarantee the sweep cadence (every 64th lookup)
      // fires at least once, regardless of the counter's current phase.
      const later = 2 * 3_600_000;
      for (let i = 0; i < 128; i++) rl.check('active', later + i);
      // Every stale bucket — including the drained drive-by — was evicted;
      // only the freshly created 'active' bucket remains.
      expect(rl.userBucketCount).toBe(1);
      // The drive-by returning gets a fresh full-burst bucket, exactly what
      // lazy refill would have produced after 2h idle.
      expect(rl.check('driveby', later + 200).allowed).toBe(true);
    });

    it('preserves recently active buckets while sweeping stale ones', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      for (let i = 0; i < 70; i++) rl.record(`user${i}`, 0);
      const later = 2 * 3_600_000;
      // alice drains her burst moments before the sweep window — recently
      // active AND drained, so eviction would wrongly grant her a refill.
      for (let i = 0; i < 3; i++) rl.record('alice', later - 3 + i);
      for (let i = 0; i < 128; i++) rl.check('driver', later + i);
      // The stale t=0 cohort is gone; alice and the driver remain.
      expect(rl.userBucketCount).toBe(2);
      // alice's drained bucket survived — a recreated bucket would have
      // allowed at full burst.
      expect(rl.check('alice', later + 200).allowed).toBe(false);
    });

    it('skips the sweep while bucket count stays at or below the 64 floor', () => {
      const rl = makeLimiter({ userBurst: 3, userRefillSeconds: 12 });
      // Small deployment — only 10 buckets. Even 2h idle, the `size > 64`
      // gate keeps the sweep from running.
      for (let i = 0; i < 10; i++) rl.record(`user${i}`, 0);
      const later = 2 * 3_600_000;
      for (let i = 0; i < 128; i++) rl.check('driver', later + i);
      expect(rl.userBucketCount).toBe(11);
    });
  });

  describe('forgetUser', () => {
    it('drops a single user bucket and lowercases the key', () => {
      const rl = makeLimiter({ userBurst: 3 });
      rl.record('Alice', 0);
      rl.record('Bob', 0);

      rl.forgetUser('Alice');
      // After forgetUser, Alice's bucket is gone — a fresh check returns
      // a full-burst allowance instead of the depleted one.
      const aliceCheck = rl.check('Alice', 0);
      expect(aliceCheck.allowed).toBe(true);
      // Bob is unaffected.
      const bobCheck = rl.check('Bob', 0);
      expect(bobCheck.allowed).toBe(true);
    });

    it('is a no-op for an unknown user', () => {
      const rl = makeLimiter({ userBurst: 3 });
      expect(() => rl.forgetUser('ghost')).not.toThrow();
    });
  });
});
