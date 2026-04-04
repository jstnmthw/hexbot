import { describe, expect, it, vi } from 'vitest';

import {
  type ResilienceConfig,
  ResilientProvider,
} from '../../plugins/ai-chat/providers/resilient';
import {
  type AIProvider,
  AIProviderError,
  type AIResponse,
} from '../../plugins/ai-chat/providers/types';

function makeInner(complete: AIProvider['complete']): AIProvider {
  return {
    name: 'mock',
    initialize: vi.fn(async () => {}),
    complete,
    countTokens: vi.fn(async () => 1),
    getModelName: () => 'mock',
  };
}

const CFG: ResilienceConfig = {
  maxRetries: 2,
  initialBackoffMs: 10,
  failureThreshold: 3,
  openDurationMs: 100,
};

function okRes(text = 'ok'): AIResponse {
  return { text, usage: { input: 1, output: 1 }, model: 'mock' };
}

describe('ResilientProvider', () => {
  it('returns the inner result on success', async () => {
    const inner = makeInner(vi.fn(async () => okRes('hi')));
    const p = new ResilientProvider(inner, CFG);
    const res = await p.complete('sys', [{ role: 'user', content: 'q' }], 100);
    expect(res.text).toBe('hi');
  });

  it('retries on rate_limit errors', async () => {
    let attempts = 0;
    const complete = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new AIProviderError('too many', 'rate_limit');
      return okRes('recovered');
    });
    const sleep = vi.fn(async () => {});
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, sleep);
    const res = await p.complete('sys', [{ role: 'user', content: 'q' }], 100);
    expect(res.text).toBe('recovered');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on network errors', async () => {
    let attempts = 0;
    const complete = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new AIProviderError('server down', 'network');
      return okRes();
    });
    const sleep = vi.fn(async () => {});
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, sleep);
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).resolves.toBeDefined();
  });

  it('does NOT retry on safety errors', async () => {
    const complete = vi.fn(async () => {
      throw new AIProviderError('blocked', 'safety');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      kind: 'safety',
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on auth errors', async () => {
    const complete = vi.fn(async () => {
      throw new AIProviderError('unauthorized', 'auth');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries', async () => {
    const complete = vi.fn(async () => {
      throw new AIProviderError('timeout', 'network');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      kind: 'network',
    });
    // maxRetries=2 → 1 initial + 2 retries = 3 total attempts
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => void delays.push(ms));
    const complete = vi.fn(async () => {
      throw new AIProviderError('timeout', 'network');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, sleep);
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    expect(delays).toEqual([10, 20]); // initial 10, then doubled
  });

  it('opens the circuit after N consecutive failures', async () => {
    const complete = vi.fn(async () => {
      throw new AIProviderError('boom', 'other');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});

    // 3 consecutive non-retryable failures → circuit opens.
    for (let i = 0; i < 3; i++) {
      await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    }
    expect(p.isOpen()).toBe(true);
    expect(complete).toHaveBeenCalledTimes(3);

    // Next call should fail-fast with "Circuit breaker open" without invoking inner.
    await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      message: /Circuit breaker open/,
    });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('recovers after openDurationMs', async () => {
    let now = 0;
    const clock = () => now;
    const complete = vi.fn(async () => {
      throw new AIProviderError('boom', 'other');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, clock, async () => {});

    for (let i = 0; i < 3; i++) {
      await expect(p.complete('sys', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    }
    expect(p.isOpen()).toBe(true);

    // Advance past openDurationMs (100ms).
    now += 200;
    expect(p.isOpen()).toBe(false);
  });

  it('resets consecutive failures after a success', async () => {
    let behavior: 'fail' | 'ok' = 'fail';
    const complete = vi.fn(async () => {
      if (behavior === 'fail') throw new AIProviderError('boom', 'other');
      return okRes();
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});

    // Two failures — not yet enough to open the circuit (threshold=3).
    await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    // One success resets the failure counter.
    behavior = 'ok';
    await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).resolves.toBeDefined();

    // Now fail twice more — should NOT be enough to open the circuit
    // because the counter was reset.
    behavior = 'fail';
    for (let i = 0; i < 2; i++) {
      await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).rejects.toBeDefined();
    }
    expect(p.isOpen()).toBe(false);
  });

  it('passes through initialize/countTokens/getModelName', async () => {
    const inner = makeInner(vi.fn(async () => okRes()));
    const p = new ResilientProvider(inner, CFG);
    await p.initialize({ apiKey: 'k', model: 'm', maxOutputTokens: 10, temperature: 0.5 });
    expect(inner.initialize).toHaveBeenCalled();
    expect(await p.countTokens('hi')).toBe(1);
    expect(p.getModelName()).toBe('mock');
    expect(p.name).toBe('mock');
  });

  it('wraps non-AIProviderError errors into kind=other', async () => {
    const complete = vi.fn(async () => {
      throw new Error('raw error');
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});
    await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      kind: 'other',
      message: 'raw error',
    });
  });

  it('wraps non-Error throws', async () => {
    const complete = vi.fn(async () => {
      throw 'string';
    });
    const p = new ResilientProvider(makeInner(complete), CFG, Date.now, async () => {});
    await expect(p.complete('s', [{ role: 'user', content: 'q' }], 100)).rejects.toMatchObject({
      kind: 'other',
    });
  });
});
