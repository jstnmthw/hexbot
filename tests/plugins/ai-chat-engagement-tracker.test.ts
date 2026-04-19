import { describe, expect, it } from 'vitest';

import { EngagementTracker } from '../../plugins/ai-chat/engagement-tracker';

function makeTracker(opts: { now: () => number; soft?: number; hard?: number }): EngagementTracker {
  return new EngagementTracker({
    softTimeoutMs: opts.soft ?? 10 * 60_000,
    hardCeilingMs: opts.hard ?? 30 * 60_000,
    now: opts.now,
  });
}

describe('EngagementTracker', () => {
  it('is not engaged by default', () => {
    const t = makeTracker({ now: () => 0 });
    expect(t.isEngaged('#c', 'alice')).toBe(false);
  });

  it('becomes engaged after onBotReply', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
  });

  it('is case-insensitive on channel and nick', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#C', 'Alice');
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
    expect(tr.isEngaged('#C', 'ALICE')).toBe(true);
  });

  it('onHumanMessage from engaged user extends engagement', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 60_000 });
    tr.onBotReply('#c', 'alice');
    t = 30_000;
    tr.onHumanMessage('#c', 'alice', 'still talking', ['alice']);
    t = 80_000; // past original soft window, but we extended at 30s
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
  });

  it('onHumanMessage from a different human ends engagement', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onHumanMessage('#c', 'bob', 'hi everyone', ['alice', 'bob']);
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('engaged user addressing a third nick ends their engagement', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onHumanMessage('#c', 'alice', 'bob: hey check this out', ['alice', 'bob', 'carol']);
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('engaged user addressing a non-participant does NOT end engagement', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    // "well:" is not a channel nick — treated as ordinary speech.
    tr.onHumanMessage('#c', 'alice', 'well: that is interesting', ['alice']);
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
  });

  it('soft timeout expires engagement after silence', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 10_000 });
    tr.onBotReply('#c', 'alice');
    t = 11_000;
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('hard ceiling ends engagement even with continuous exchanges', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 60_000, hard: 100_000 });
    tr.onBotReply('#c', 'alice');
    for (let i = 1; i <= 5; i++) {
      t = i * 20_000;
      tr.onHumanMessage('#c', 'alice', 'still here', ['alice']);
    }
    t = 101_000;
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('dropChannel clears that channels engaged set', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onBotReply('#other', 'bob');
    tr.dropChannel('#c');
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
    expect(tr.isEngaged('#other', 'bob')).toBe(true);
  });

  it('endEngagement removes a single user without affecting others in same channel', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onBotReply('#c', 'bob');
    tr.endEngagement('#c', 'alice');
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
    expect(tr.isEngaged('#c', 'bob')).toBe(true);
  });

  it('supports two concurrent engaged users in one channel', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 10_000 });
    tr.onBotReply('#c', 'alice');
    tr.onBotReply('#c', 'bob');
    // Neither user speaking ends the other's engagement — they're both engaged.
    // But onHumanMessage from a third party DOES end both.
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
    expect(tr.isEngaged('#c', 'bob')).toBe(true);
    t = 5_000;
    // alice speaks — her own engagement extends; bob's doesn't change.
    tr.onHumanMessage('#c', 'alice', 'yep', ['alice', 'bob']);
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
    expect(tr.isEngaged('#c', 'bob')).toBe(true);
    // carol speaks — both end.
    tr.onHumanMessage('#c', 'carol', 'hi', ['alice', 'bob', 'carol']);
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
    expect(tr.isEngaged('#c', 'bob')).toBe(false);
  });

  it('clear removes all state', () => {
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onBotReply('#d', 'bob');
    tr.clear();
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
    expect(tr.isEngaged('#d', 'bob')).toBe(false);
  });

  it('caps engaged users per channel (evicts oldest)', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t });
    // 8 is the cap; adding a 9th should evict the oldest.
    for (let i = 0; i < 9; i++) {
      t = i * 1000;
      tr.onBotReply('#c', `user${i}`);
    }
    expect(tr.sizeFor('#c')).toBeLessThanOrEqual(8);
    expect(tr.isEngaged('#c', 'user0')).toBe(false);
    expect(tr.isEngaged('#c', 'user8')).toBe(true);
  });

  it('re-engaging an already-engaged user bumps lastExchangeAt only', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 60_000, hard: 100_000 });
    tr.onBotReply('#c', 'alice');
    t = 50_000;
    tr.onBotReply('#c', 'alice');
    // Hard ceiling is measured from startedAt (t=0), so 101s is still past.
    t = 101_000;
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('setTimeouts updates active soft/hard windows in place', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t, soft: 60_000, hard: 1_000_000 });
    tr.onBotReply('#c', 'alice');
    // Tighten the soft window to 1s; the existing entry should now expire.
    tr.setTimeouts(1_000, 1_000_000);
    t = 5_000;
    expect(tr.isEngaged('#c', 'alice')).toBe(false);
  });

  it('endEngagement is a no-op for an unknown channel', () => {
    const tr = makeTracker({ now: () => 0 });
    expect(() => tr.endEngagement('#nope', 'alice')).not.toThrow();
  });

  it('engaged user addressing the bot itself stays engaged', () => {
    // The redirect check ignores nicks already in the engaged set, so when
    // an engaged user re-addresses the bot they don't lose the floor.
    const tr = makeTracker({ now: () => 0 });
    tr.onBotReply('#c', 'alice');
    tr.onBotReply('#c', 'hexbot');
    tr.onHumanMessage('#c', 'alice', 'hexbot: still here?', ['alice', 'hexbot']);
    expect(tr.isEngaged('#c', 'alice')).toBe(true);
  });

  it('evicts the oldest channel once MAX_CHANNELS (256) is exceeded', () => {
    let t = 0;
    const tr = makeTracker({ now: () => t });
    // Fill to the cap. Each channel gets one engagement at a known time.
    for (let i = 0; i < 256; i++) {
      t = i * 1000;
      tr.onBotReply(`#ch${i}`, 'a');
    }
    // 257th channel forces eviction of the oldest (#ch0).
    t = 256 * 1000;
    tr.onBotReply('#ch256', 'a');
    expect(tr.isEngaged('#ch0', 'a')).toBe(false);
    expect(tr.isEngaged('#ch256', 'a')).toBe(true);
    expect(tr.isEngaged('#ch1', 'a')).toBe(true);
  });
});
