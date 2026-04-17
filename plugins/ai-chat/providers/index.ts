// AI provider factory.
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { ResilientProvider } from './resilient';
import { type AIProvider, type AIProviderConfig, AIProviderError } from './types';

/** Create an AIProvider instance by name. Throws if the name is unknown. */
export function createProvider(type: string): AIProvider {
  switch (type) {
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      throw new AIProviderError(`Unknown AI provider: ${type}`, 'other');
  }
}

/**
 * Create a provider by name, initialize it, and wrap it in ResilientProvider.
 * Single call site for the "bare provider → resilient wrapper" pipeline so
 * additional providers don't need to repeat the wrap logic at each call site.
 */
export async function createResilientProvider(
  type: string,
  config: AIProviderConfig,
): Promise<AIProvider> {
  const bare = createProvider(type);
  await bare.initialize(config);
  return new ResilientProvider(bare);
}
