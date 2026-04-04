// AI provider factory.
import { GeminiProvider } from './gemini';
import { type AIProvider, AIProviderError } from './types';

/** Create an AIProvider instance by name. Throws if the name is unknown. */
export function createProvider(type: string): AIProvider {
  switch (type) {
    case 'gemini':
      return new GeminiProvider();
    default:
      throw new AIProviderError(`Unknown AI provider: ${type}`, 'other');
  }
}
