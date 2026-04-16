// Unit tests for the Assistant pipeline (provider + rate limiter + token tracker + context).
import { describe, expect, it, vi } from 'vitest';

import {
  type AssistantConfig,
  type PromptContext,
  SAFETY_CLAUSE,
  renderSystemPrompt,
  respond,
  sendLines,
} from '../../plugins/ai-chat/assistant';
import { ContextManager } from '../../plugins/ai-chat/context-manager';
import { type AIProvider, AIProviderError } from '../../plugins/ai-chat/providers/types';
import { RateLimiter } from '../../plugins/ai-chat/rate-limiter';
import { TokenTracker } from '../../plugins/ai-chat/token-tracker';
import type { PluginDB } from '../../src/types';

function makeDb(): PluginDB {
  const store = new Map<string, string>();
  return {
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    del: (k) => void store.delete(k),
    list: (prefix = '') =>
      [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, value: v })),
  };
}

function makeProvider(text = 'hi there', usage = { input: 10, output: 5 }): AIProvider {
  return {
    name: 'mock',
    initialize: vi.fn(async () => {}),
    complete: vi.fn(async () => ({ text, usage, model: 'mock-model' })),
    countTokens: vi.fn(async () => 1),
    getModelName: () => 'mock-model',
  };
}

const CONFIG: AssistantConfig = {
  maxLines: 4,
  maxLineLength: 400,
  interLineDelayMs: 0,
  maxOutputTokens: 256,
};

const PROMPT_CTX: PromptContext = { botNick: 'hexbot', channel: '#test', network: 'irc.test' };

function makeDeps(providerOverride?: AIProvider) {
  return {
    provider: providerOverride ?? makeProvider(),
    rateLimiter: new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      globalRpm: 100,
      globalRpd: 1000,
      rpmBackpressurePct: 80,
    }),
    tokenTracker: new TokenTracker(makeDb(), { perUserDaily: 10_000, globalDaily: 100_000 }),
    contextManager: new ContextManager({
      maxMessages: 10,
      maxTokens: 1000,
      ttlMs: 60_000,
    }),
    config: CONFIG,
  };
}

describe('renderSystemPrompt', () => {
  it('substitutes {nick}, {channel}, {network}', () => {
    const out = renderSystemPrompt('Hi, I am {nick} in {channel} on {network}.', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
    });
    expect(out).toBe(`Hi, I am hexbot in #c on irc.test.${SAFETY_CLAUSE}`);
  });

  it('uses "(private)" for null channel', () => {
    const out = renderSystemPrompt('I am in {channel}.', {
      botNick: 'hexbot',
      channel: null,
      network: 'irc.test',
    });
    expect(out).toBe(`I am in (private).${SAFETY_CLAUSE}`);
  });

  it('substitutes {users} when provided', () => {
    const out = renderSystemPrompt('Users: {users}', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
      users: ['alice', 'bob'],
    });
    expect(out).toBe(`Users: alice, bob${SAFETY_CLAUSE}`);
  });

  it('appends language suffix when set, followed by safety clause', () => {
    const out = renderSystemPrompt('Base', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
      language: 'French',
    });
    expect(out).toBe(`Base Always respond in French.${SAFETY_CLAUSE}`);
  });

  it('always appends the fantasy-command safety clause', () => {
    const out = renderSystemPrompt('Just a prompt.', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
    });
    expect(out).toContain('SAFETY:');
    expect(out).toContain('Never begin any line');
  });

  it('appends channel profile when provided', () => {
    const out = renderSystemPrompt('Base prompt.', {
      botNick: 'hexbot',
      channel: '#linux',
      network: 'irc.test',
      channelProfile: 'This channel is about Linux. The culture here is technical.',
    });
    expect(out).toContain('This channel is about Linux');
    expect(out).toContain('The culture here is technical');
  });

  it('appends mood line when provided', () => {
    const out = renderSystemPrompt('Base prompt.', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
      mood: 'Current state: feeling energetic, in a funny mood.',
    });
    expect(out).toContain('feeling energetic');
    expect(out).toContain('funny mood');
  });

  it('replaces {channel_profile} template variable', () => {
    const out = renderSystemPrompt('Context: {channel_profile}', {
      botNick: 'hexbot',
      channel: '#c',
      network: 'irc.test',
      channelProfile: 'This is a tech channel.',
    });
    expect(out).toContain('Context: This is a tech channel.');
  });
});

describe('respond', () => {
  it('returns ok with formatted lines on success', async () => {
    const deps = makeDeps(makeProvider('Hello world'));
    const res = await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'You are helpful.',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.lines).toEqual(['Hello world']);
      expect(res.tokensIn).toBe(10);
      expect(res.tokensOut).toBe(5);
    }
  });

  it('records token usage in the tracker', async () => {
    const deps = makeDeps();
    await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(deps.tokenTracker.getUsage('alice')).toEqual({ input: 10, output: 5, requests: 1 });
  });

  it('records rate-limit usage', async () => {
    const deps = makeDeps();
    await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    // Second call with userBurst=0 is fine but the dayWindow counter is bumped:
    const t = deps.rateLimiter.check('alice');
    expect(t.allowed).toBe(true);
  });

  it('returns rate_limited when limiter blocks', async () => {
    const deps = makeDeps();
    deps.rateLimiter.setConfig({
      userBurst: 1,
      userRefillSeconds: 60,
      globalRpm: 100,
      globalRpd: 100,
      rpmBackpressurePct: 80,
    });
    deps.rateLimiter.record('alice');
    const res = await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(res.status).toBe('rate_limited');
  });

  it('returns budget_exceeded when token budget would be crossed', async () => {
    const deps = makeDeps();
    deps.tokenTracker.setConfig({ perUserDaily: 10, globalDaily: 100_000 });
    deps.tokenTracker.recordUsage('alice', { input: 5, output: 5 });
    const res = await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(res.status).toBe('budget_exceeded');
  });

  it('returns provider_error on provider throw', async () => {
    const provider = makeProvider();
    (provider.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new AIProviderError('safety blocked', 'safety'),
    );
    const deps = makeDeps(provider);
    const res = await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(res.status).toBe('provider_error');
    if (res.status === 'provider_error') expect(res.kind).toBe('safety');
  });

  it('returns empty when LLM yields whitespace only', async () => {
    const deps = makeDeps(makeProvider('   '));
    const res = await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    expect(res.status).toBe('empty');
  });

  it('sends context history to the provider', async () => {
    const deps = makeDeps();
    deps.contextManager.addMessage('#test', 'alice', 'prior message', false);
    deps.contextManager.addMessage('#test', 'hexbot', 'earlier reply', true);
    await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'follow up',
        systemPrompt: 'sys',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    const callArgs = (deps.provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[1];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: '[alice] prior message' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'earlier reply' });
    expect(messages[2]).toEqual({ role: 'user', content: '[alice] follow up' });
  });

  it('passes the system prompt through renderSystemPrompt', async () => {
    const deps = makeDeps();
    await respond(
      {
        nick: 'alice',
        channel: '#test',
        prompt: 'hi',
        systemPrompt: 'I am {nick} on {network}.',
        promptContext: PROMPT_CTX,
      },
      deps,
    );
    const callArgs = (deps.provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe(`I am hexbot on irc.test.${SAFETY_CLAUSE}`);
  });
});

describe('sendLines', () => {
  it('sends nothing for empty array', async () => {
    const fn = vi.fn();
    await sendLines([], fn, 100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends a single line immediately', async () => {
    const fn = vi.fn();
    await sendLines(['one'], fn, 500);
    expect(fn).toHaveBeenCalledWith('one');
  });

  it('sends all lines immediately when delay is zero', async () => {
    const fn = vi.fn();
    await sendLines(['a', 'b', 'c'], fn, 0);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('sends lines with delay', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const p = sendLines(['a', 'b', 'c'], fn, 100);
      // First send is synchronous.
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(3);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
