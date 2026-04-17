import { describe, expect, it, vi } from 'vitest';

import { createProvider, createResilientProvider } from '../../plugins/ai-chat/providers';
import { GeminiProvider } from '../../plugins/ai-chat/providers/gemini';
import { OllamaProvider } from '../../plugins/ai-chat/providers/ollama';
import { ResilientProvider } from '../../plugins/ai-chat/providers/resilient';
import { AIProviderError } from '../../plugins/ai-chat/providers/types';

describe('createProvider', () => {
  it('returns a GeminiProvider for "gemini"', () => {
    expect(createProvider('gemini')).toBeInstanceOf(GeminiProvider);
  });

  it('returns an OllamaProvider for "ollama"', () => {
    expect(createProvider('ollama')).toBeInstanceOf(OllamaProvider);
  });

  it('throws AIProviderError for unknown types', () => {
    expect(() => createProvider('unknown')).toThrow(AIProviderError);
  });
});

describe('createResilientProvider', () => {
  it('initializes the provider and wraps it in ResilientProvider', async () => {
    const initSpy = vi.spyOn(GeminiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const wrapped = await createResilientProvider('gemini', {
      apiKey: 'x',
      model: 'm',
      maxOutputTokens: 32,
      temperature: 0.5,
    });
    expect(wrapped).toBeInstanceOf(ResilientProvider);
    expect(initSpy).toHaveBeenCalledOnce();
    initSpy.mockRestore();
  });
});
