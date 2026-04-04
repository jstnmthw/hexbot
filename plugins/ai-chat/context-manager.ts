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
  /** Max messages to keep per PM buffer. */
  pmMaxMessages: number;
  /** Target token budget for serialized context (heuristic, chars/4). */
  maxTokens: number;
  /** Messages older than this are pruned on access. */
  ttlMs: number;
}

/** Rough char→token ratio used for trimming — ~4 chars per token for English. */
const CHARS_PER_TOKEN = 4;

/**
 * Per-channel and per-user sliding-window message buffers.
 *
 * Serializes entries into an AIMessage[] with role 'user' for humans and
 * 'assistant' for the bot, annotated with the speaker's nick so the model
 * can distinguish participants.
 */
export class ContextManager {
  private channels = new Map<string, ContextEntry[]>();
  private pms = new Map<string, ContextEntry[]>();

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
   * @param channel  — channel name, or null for PM (then nick is the buffer key)
   * @param nick     — speaker
   * @param text     — message content
   * @param isBot    — true if this was a message sent by the bot
   */
  addMessage(channel: string | null, nick: string, text: string, isBot: boolean): void {
    const entry: ContextEntry = { nick, text, isBot, timestamp: this.now() };
    const map = channel === null ? this.pms : this.channels;
    const key = channel === null ? nick.toLowerCase() : channel.toLowerCase();
    const maxCount = channel === null ? this.config.pmMaxMessages : this.config.maxMessages;

    let buf = map.get(key);
    if (!buf) {
      buf = [];
      map.set(key, buf);
    }
    buf.push(entry);
    if (buf.length > maxCount) buf.splice(0, buf.length - maxCount);
  }

  /**
   * Build the AI-facing messages array for a channel (or nick for PM).
   * The oldest messages are dropped until the serialized length fits the token budget.
   */
  getContext(channel: string | null, nick: string): AIMessage[] {
    const map = channel === null ? this.pms : this.channels;
    const key = channel === null ? nick.toLowerCase() : channel.toLowerCase();
    const buf = this.pruneAndGet(map, key);
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

  /** Drop the buffer for a channel (or nick for PM). */
  clearContext(channel: string | null, nick?: string): void {
    if (channel === null) {
      if (nick) this.pms.delete(nick.toLowerCase());
      else this.pms.clear();
    } else {
      this.channels.delete(channel.toLowerCase());
    }
  }

  /** Return the number of messages currently buffered for a target. */
  size(channel: string | null, nick: string): number {
    const map = channel === null ? this.pms : this.channels;
    const key = channel === null ? nick.toLowerCase() : channel.toLowerCase();
    return map.get(key)?.length ?? 0;
  }

  /** Evict entries older than the configured TTL (idempotent). */
  pruneAll(): void {
    for (const key of this.channels.keys()) this.pruneAndGet(this.channels, key);
    for (const key of this.pms.keys()) this.pruneAndGet(this.pms, key);
  }

  private pruneAndGet(map: Map<string, ContextEntry[]>, key: string): ContextEntry[] {
    const buf = map.get(key);
    if (!buf) return [];
    const cutoff = this.now() - this.config.ttlMs;
    // Find first entry still within the TTL window.
    let drop = 0;
    while (drop < buf.length && buf[drop].timestamp < cutoff) drop++;
    if (drop > 0) buf.splice(0, drop);
    if (buf.length === 0) map.delete(key);
    return buf;
  }
}
