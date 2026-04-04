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
      pmMaxMessages: 3,
      maxTokens: 100,
      ttlMs: 60_000,
      ...overrides,
    },
    () => clock.get(),
  );
  return { mgr, clock };
}

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
      { role: 'user', content: '[alice] hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: '[alice] how are you' },
    ]);
  });

  it('caps channel buffers at maxMessages', () => {
    const { mgr } = make({ maxMessages: 3 });
    for (let i = 0; i < 5; i++) mgr.addMessage('#c', 'alice', `m${i}`, false);
    expect(mgr.size('#c', 'alice')).toBe(3);
    const msgs = mgr.getContext('#c', 'alice');
    expect(msgs.map((m) => m.content)).toEqual(['[alice] m2', '[alice] m3', '[alice] m4']);
  });

  it('caps PM buffers at pmMaxMessages', () => {
    const { mgr } = make({ pmMaxMessages: 2 });
    for (let i = 0; i < 4; i++) mgr.addMessage(null, 'alice', `m${i}`, false);
    expect(mgr.size(null, 'alice')).toBe(2);
  });

  it('keeps channel and PM buffers separate', () => {
    const { mgr } = make();
    mgr.addMessage('#c', 'alice', 'channel msg', false);
    mgr.addMessage(null, 'alice', 'pm msg', false);
    expect(mgr.getContext('#c', 'alice').map((m) => m.content)).toEqual(['[alice] channel msg']);
    expect(mgr.getContext(null, 'alice').map((m) => m.content)).toEqual(['[alice] pm msg']);
  });

  it('channel lookup is case-insensitive', () => {
    const { mgr } = make();
    mgr.addMessage('#Chan', 'alice', 'hi', false);
    expect(mgr.size('#chan', 'alice')).toBe(1);
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
    expect(msgs.at(-1)?.content).toBe('[a] msg9');
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
    expect(msgs.map((m) => m.content)).toEqual(['[alice] new']);
  });

  it('deletes the buffer entirely when all messages age out', () => {
    const { mgr, clock } = make({ ttlMs: 10_000 });
    mgr.addMessage('#c', 'alice', 'will expire', false);
    clock.advance(11_000);
    expect(mgr.getContext('#c', 'alice')).toEqual([]);
    expect(mgr.size('#c', 'alice')).toBe(0);
  });

  it('clearContext with channel removes that channel only', () => {
    const { mgr } = make();
    mgr.addMessage('#a', 'x', 'one', false);
    mgr.addMessage('#b', 'y', 'two', false);
    mgr.clearContext('#a');
    expect(mgr.size('#a', 'x')).toBe(0);
    expect(mgr.size('#b', 'y')).toBe(1);
  });

  it('clearContext with null + nick clears a single PM', () => {
    const { mgr } = make();
    mgr.addMessage(null, 'alice', 'pm', false);
    mgr.addMessage(null, 'bob', 'pm', false);
    mgr.clearContext(null, 'alice');
    expect(mgr.size(null, 'alice')).toBe(0);
    expect(mgr.size(null, 'bob')).toBe(1);
  });

  it('clearContext with null and no nick clears all PMs', () => {
    const { mgr } = make();
    mgr.addMessage(null, 'alice', 'pm', false);
    mgr.addMessage(null, 'bob', 'pm', false);
    mgr.clearContext(null);
    expect(mgr.size(null, 'alice')).toBe(0);
    expect(mgr.size(null, 'bob')).toBe(0);
  });

  it('pruneAll evicts stale entries across all buffers', () => {
    const { mgr, clock } = make({ ttlMs: 5000 });
    mgr.addMessage('#a', 'alice', 'old', false);
    mgr.addMessage(null, 'bob', 'old pm', false);
    clock.advance(6000);
    mgr.pruneAll();
    expect(mgr.size('#a', 'alice')).toBe(0);
    expect(mgr.size(null, 'bob')).toBe(0);
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
    mgr.setConfig({ maxMessages: 10, pmMaxMessages: 3, maxTokens: 1000, ttlMs: 60_000 });
    for (let i = 5; i < 10; i++) mgr.addMessage('#c', 'a', `m${i}`, false);
    expect(mgr.size('#c', 'a')).toBe(10);
  });
});
