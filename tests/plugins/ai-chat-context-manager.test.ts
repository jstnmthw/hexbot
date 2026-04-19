import { describe, expect, it } from 'vitest';

import { ContextManager } from '../../plugins/ai-chat/context-manager';

function make(overrides: Partial<ConstructorParameters<typeof ContextManager>[0]> = {}) {
  let now = 1_000_000;
  const clock = {
    get: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const mgr = new ContextManager(
    {
      maxMessages: 5,
      maxTokens: 100,
      ttlMs: 60_000,
      ...overrides,
    },
    () => clock.get(),
  );
  return { mgr, clock };
}

describe('ContextManager per-entry char cap', () => {
  it('truncates messages longer than maxMessageChars with an ellipsis', () => {
    const { mgr } = make({ maxMessageChars: 10 });
    mgr.addMessage('#c', 'alice', 'x'.repeat(50), false);
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs).toHaveLength(1);
    // 10 chars total: 9 'x' + the '…' marker.
    expect(msgs[0].content).toBe('alice: ' + 'x'.repeat(9) + '…');
  });

  it('does not truncate when text is at or under cap', () => {
    const { mgr } = make({ maxMessageChars: 10 });
    mgr.addMessage('#c', 'bot', 'short', true);
    const msgs = mgr.getContext('#c', 'bot');
    expect(msgs[0].content).toBe('short');
  });

  it('leaves text untouched when no cap is configured', () => {
    const { mgr } = make({});
    mgr.addMessage('#c', 'alice', 'x'.repeat(500), false);
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs[0].content).toBe('alice: ' + 'x'.repeat(500));
  });
});

describe('ContextManager byte-budget enforcement', () => {
  // Audit 2026-04-19 — addMessage must evict oldest entries when cumulative
  // bytes exceed maxTokens*4 (the char-per-token heuristic).
  it('evicts oldest entries when cumulative bytes exceed maxTokens*4', () => {
    // maxTokens=20 → maxBytes=80. Messages of ~50 bytes each can't all fit.
    const { mgr } = make({ maxTokens: 20, maxMessages: 100 });
    for (let i = 0; i < 10; i++) {
      mgr.addMessage('#c', 'alice', 'x'.repeat(40), false);
    }
    // After eviction, total bytes should be under 80 (plus the most recent,
    // which the cap keeps even if oversized).
    const size = mgr.size('#c');
    expect(size).toBeGreaterThanOrEqual(1);
    // The size after eviction should be much smaller than 10.
    expect(size).toBeLessThanOrEqual(3);
  });

  it('never evicts the last-remaining entry even if oversized', () => {
    const { mgr } = make({ maxTokens: 1, maxMessages: 100 });
    mgr.addMessage('#c', 'alice', 'x'.repeat(1000), false);
    // A single over-budget entry is kept — the alternative is an empty
    // buffer and a zero-context call, worse than the call with oversized ctx.
    expect(mgr.size('#c')).toBe(1);
  });
});

describe('ContextManager', () => {
  it('returns empty when nothing has been added', () => {
    const { mgr } = make();
    expect(mgr.getContext('#c', 'alice')).toEqual([]);
  });

  it('returns messages in chronological order', () => {
    const { mgr, clock } = make();
    mgr.addMessage('#c', 'alice', 'hi', false);
    clock.advance(10);
    mgr.addMessage('#c', 'hexbot', 'hey', true);
    clock.advance(10);
    mgr.addMessage('#c', 'alice', 'how are you', false);

    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs).toEqual([
      { role: 'user', content: 'alice: hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'alice: how are you' },
    ]);
  });

  it('bulk-prunes channel buffers by halving when they exceed maxMessages', () => {
    // Default strategy is 'bulk': when the buffer overflows, drop the oldest
    // half in one step so the remaining prefix is byte-stable across calls.
    // This is cache-friendly: Ollama/llama.cpp KV-cache and Gemini implicit
    // cache hit every turn between prunes instead of drifting per-message.
    const { mgr } = make({ maxMessages: 4 });
    for (let i = 0; i < 5; i++) mgr.addMessage('#c', 'alice', `m${i}`, false);
    // After overflow at i=4, buf had 5 entries → ceil(5/2) = 3 dropped,
    // leaving 2 newest messages (m3, m4).
    expect(mgr.size('#c')).toBe(2);
    expect(mgr.getContext('#c', 'alice').map((m) => m.content)).toEqual(['alice: m3', 'alice: m4']);
  });

  it('does not re-prune until the buffer overflows again', () => {
    // Adding one message after a bulk-prune must NOT trigger another prune —
    // the prefix stays byte-stable until the buffer fills to maxMessages + 1
    // again.
    const { mgr } = make({ maxMessages: 4 });
    for (let i = 0; i < 5; i++) mgr.addMessage('#c', 'alice', `m${i}`, false);
    expect(mgr.size('#c')).toBe(2);
    mgr.addMessage('#c', 'alice', 'after-prune', false);
    expect(mgr.size('#c')).toBe(3);
    mgr.addMessage('#c', 'alice', 'also-after', false);
    expect(mgr.size('#c')).toBe(4);
    // One more brings us to 5 > maxMessages=4: bulk-prune again.
    mgr.addMessage('#c', 'alice', 'trigger', false);
    expect(mgr.size('#c')).toBe(2);
  });

  it('sliding prune strategy drops exactly one per overflow', () => {
    // Escape hatch for operators who want the original per-turn behaviour —
    // pruneStrategy: 'sliding' is wired through addMessage.
    const { mgr } = make({ maxMessages: 3, pruneStrategy: 'sliding' });
    for (let i = 0; i < 5; i++) mgr.addMessage('#c', 'alice', `m${i}`, false);
    expect(mgr.size('#c')).toBe(3);
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs.map((m) => m.content)).toEqual(['alice: m2', 'alice: m3', 'alice: m4']);
  });

  it('silently ignores PM messages (PM support removed)', () => {
    const { mgr } = make();
    mgr.addMessage(null, 'alice', 'pm msg', false);
    expect(mgr.getContext(null, 'alice')).toEqual([]);
  });

  it('channel lookup is case-insensitive', () => {
    const { mgr } = make();
    mgr.addMessage('#Chan', 'alice', 'hi', false);
    expect(mgr.size('#chan')).toBe(1);
  });

  it('trims oldest messages to fit the token budget', () => {
    // maxTokens 10 → ~40 chars budget
    const { mgr } = make({ maxTokens: 10, maxMessages: 50 });
    for (let i = 0; i < 10; i++) mgr.addMessage('#c', 'a', `msg${i}`, false);
    const msgs = mgr.getContext('#c', 'a');
    // Should return only the most recent few messages that fit ~40 chars.
    const totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(40);
    expect(msgs.length).toBeGreaterThan(0);
    // Newest message is always preserved
    expect(msgs.at(-1)?.content).toBe('a: msg9');
  });

  it('always keeps at least one message even if over budget', () => {
    const { mgr } = make({ maxTokens: 1 });
    mgr.addMessage(
      '#c',
      'alice',
      'a very long message that far exceeds the tiny token budget',
      false,
    );
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs).toHaveLength(1);
  });

  it('prunes entries older than the TTL', () => {
    const { mgr, clock } = make({ ttlMs: 10_000 });
    mgr.addMessage('#c', 'alice', 'old', false);
    clock.advance(11_000);
    mgr.addMessage('#c', 'alice', 'new', false);
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs.map((m) => m.content)).toEqual(['alice: new']);
  });

  it('deletes the buffer entirely when all messages age out', () => {
    const { mgr, clock } = make({ ttlMs: 10_000 });
    mgr.addMessage('#c', 'alice', 'will expire', false);
    clock.advance(11_000);
    expect(mgr.getContext('#c', 'alice')).toEqual([]);
    expect(mgr.size('#c')).toBe(0);
  });

  it('clearContext with channel removes that channel only', () => {
    const { mgr } = make();
    mgr.addMessage('#a', 'x', 'one', false);
    mgr.addMessage('#b', 'y', 'two', false);
    mgr.clearContext('#a');
    expect(mgr.size('#a')).toBe(0);
    expect(mgr.size('#b')).toBe(1);
  });

  it('pruneAll evicts stale entries across all buffers', () => {
    const { mgr, clock } = make({ ttlMs: 5000 });
    mgr.addMessage('#a', 'alice', 'old', false);
    clock.advance(6000);
    mgr.pruneAll();
    expect(mgr.size('#a')).toBe(0);
  });

  it('assistant messages are annotated without the nick prefix', () => {
    const { mgr } = make();
    mgr.addMessage('#c', 'hexbot', 'greetings', true);
    const msgs = mgr.getContext('#c', 'anybody');
    expect(msgs).toEqual([{ role: 'assistant', content: 'greetings' }]);
  });

  it('setConfig updates limits', () => {
    const { mgr } = make({ maxMessages: 5 });
    for (let i = 0; i < 5; i++) mgr.addMessage('#c', 'a', `m${i}`, false);
    mgr.setConfig({ maxMessages: 10, maxTokens: 1000, ttlMs: 60_000 });
    for (let i = 5; i < 10; i++) mgr.addMessage('#c', 'a', `m${i}`, false);
    expect(mgr.size('#c')).toBe(10);
  });

  it('token-budget trim in getContext still acts as a safety net on oversized buffers', () => {
    // Even with bulk-prune, the per-call token budget still enforces the
    // upper bound on serialized output size (the two are complementary).
    const { mgr } = make({ maxMessages: 100, maxTokens: 5 });
    for (let i = 0; i < 50; i++) mgr.addMessage('#c', 'a', `msg${i}`, false);
    const msgs = mgr.getContext('#c', 'a');
    const totalChars = msgs.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(20);
  });

  describe('initialChannels seed', () => {
    it('pre-populates a channel buffer from the constructor seed', () => {
      const now = 1_000_000;
      const seeded = [
        { nick: 'alice', text: 'hi', isBot: false, timestamp: now - 1_000 },
        { nick: 'hexbot', text: 'hello', isBot: true, timestamp: now - 500 },
      ];
      const mgr = new ContextManager({ maxMessages: 5, maxTokens: 100, ttlMs: 60_000 }, () => now, [
        ['#c', seeded],
      ]);
      expect(mgr.size('#c')).toBe(2);
      const msgs = mgr.getContext('#c', 'alice');
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    });
  });
});
