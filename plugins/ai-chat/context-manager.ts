// Sliding-window conversation context for AI chat.
// Keeps per-channel and per-PM buffers of recent messages, trimmed to fit a token budget.
import type { AIMessage } from './providers/types';

/** A buffered message in a channel or PM. */
export interface ContextEntry {
  nick: string;
  text: string;
  isBot: boolean;
  timestamp: number;
}

/** Tunables passed to the context manager. */
export interface ContextManagerConfig {
  /** Max messages to keep per channel buffer. */
  maxMessages: number;
  /** Target token budget for serialized context (heuristic, chars/4). */
  maxTokens: number;
  /** Messages older than this are pruned on access. */
  ttlMs: number;
}

/** Rough char→token ratio used for trimming — ~4 chars per token for English. */
const CHARS_PER_TOKEN = 4;

/**
 * Per-channel sliding-window message buffers.
 *
 * Serializes entries into an AIMessage[] with role 'user' for humans and
 * 'assistant' for the bot, annotated with the speaker's nick so the model
 * can distinguish participants.
 */
export class ContextManager {
  private channels = new Map<string, ContextEntry[]>();

  constructor(
    private config: ContextManagerConfig,
    private now: () => number = Date.now,
  ) {}

  /** Update the active tunables. */
  setConfig(config: ContextManagerConfig): void {
    this.config = config;
  }

  /**
   * Record a message.
   * @param channel  — channel name (required — PM support removed)
   * @param nick     — speaker
   * @param text     — message content
   * @param isBot    — true if this was a message sent by the bot
   */
  addMessage(channel: string | null, nick: string, text: string, isBot: boolean): void {
    if (channel === null) return; // PM removed — silently ignore
    const entry: ContextEntry = { nick, text, isBot, timestamp: this.now() };
    const key = channel.toLowerCase();

    let buf = this.channels.get(key);
    if (!buf) {
      buf = [];
      this.channels.set(key, buf);
    }
    buf.push(entry);
    if (buf.length > this.config.maxMessages) buf.splice(0, buf.length - this.config.maxMessages);
  }

  /**
   * Build the AI-facing messages array for a channel.
   * The oldest messages are dropped until the serialized length fits the token budget.
   */
  getContext(channel: string | null, _nick: string): AIMessage[] {
    if (channel === null) return []; // PM removed
    const key = channel.toLowerCase();
    const buf = this.pruneAndGet(key);
    if (buf.length === 0) return [];

    // Build messages newest-first, then reverse — lets us stop as soon as we exceed budget.
    const maxChars = this.config.maxTokens * CHARS_PER_TOKEN;
    const messages: AIMessage[] = [];
    let chars = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const e = buf[i];
      const content = e.isBot ? e.text : `[${e.nick}] ${e.text}`;
      if (chars + content.length > maxChars && messages.length > 0) break;
      messages.push({ role: e.isBot ? 'assistant' : 'user', content });
      chars += content.length;
    }
    return messages.reverse();
  }

  /** Drop the buffer for a channel. */
  clearContext(channel: string): void {
    this.channels.delete(channel.toLowerCase());
  }

  /** Return the number of messages currently buffered for a channel. */
  size(channel: string): number {
    return this.channels.get(channel.toLowerCase())?.length ?? 0;
  }

  /** Evict entries older than the configured TTL (idempotent). */
  pruneAll(): void {
    for (const key of this.channels.keys()) this.pruneAndGet(key);
  }

  private pruneAndGet(key: string): ContextEntry[] {
    const buf = this.channels.get(key);
    if (!buf) return [];
    const cutoff = this.now() - this.config.ttlMs;
    // Find first entry still within the TTL window.
    let drop = 0;
    while (drop < buf.length && buf[drop].timestamp < cutoff) drop++;
    if (drop > 0) buf.splice(0, drop);
    if (buf.length === 0) this.channels.delete(key);
    return buf;
  }
}
