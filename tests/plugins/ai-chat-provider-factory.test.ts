import { describe, expect, it } from 'vitest';

import { createProvider } from '../../plugins/ai-chat/providers';
import { GeminiProvider } from '../../plugins/ai-chat/providers/gemini';
import { AIProviderError } from '../../plugins/ai-chat/providers/types';

describe('createProvider', () => {
  it('returns a GeminiProvider for "gemini"', () => {
    expect(createProvider('gemini')).toBeInstanceOf(GeminiProvider);
  });

  it('throws AIProviderError for unknown types', () => {
    expect(() => createProvider('unknown')).toThrow(AIProviderError);
  });
});
