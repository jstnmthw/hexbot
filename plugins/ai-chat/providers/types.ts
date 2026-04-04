// AI provider adapter interface.
// Defines the shape every LLM provider (Gemini, Claude, OpenAI, Ollama, …) must implement.
// The plugin only talks to providers through this interface.

/** A single message exchanged with the AI model. */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Token usage reported after a completion. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** The result of a single completion call. */
export interface AIResponse {
  text: string;
  usage: TokenUsage;
  model: string;
}

/** Configuration passed to a provider's initialize(). */
export interface AIProviderConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
}

/**
 * Provider adapter contract. Implementations wrap a specific LLM vendor API
 * (Gemini, Claude, OpenAI, …) and expose a uniform surface the plugin uses.
 */
export interface AIProvider {
  /** Human-readable name of the provider (e.g. "gemini"). */
  readonly name: string;

  /** Set up the client. Called once at plugin startup. */
  initialize(config: AIProviderConfig): Promise<void>;

  /**
   * Generate a completion.
   * @param systemPrompt  — persona/instructions prepended to the conversation
   * @param messages      — conversation history (ordered, includes the latest user turn)
   * @param maxTokens     — upper bound on output tokens for this call
   */
  complete(systemPrompt: string, messages: AIMessage[], maxTokens: number): Promise<AIResponse>;

  /** Count tokens for the given text using the provider's tokenizer. */
  countTokens(text: string): Promise<number>;

  /** Return the model identifier currently in use. */
  getModelName(): string;
}

/** Error classes providers can throw so callers can discriminate. */
export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'rate_limit' | 'safety' | 'network' | 'auth' | 'other',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
