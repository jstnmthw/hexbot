// Sliding-window conversation context for AI chat.
// Keeps per-channel and per-PM buffers of recent messages, trimmed to fit a token budget.
import type { AIMessage } from './providers/types';

/**
 * Strip a nick to the RFC 2812 reserved character set (and truncate) before
 * surfacing it in a prompt. Keeps the inline `nick: text` attribution safe
 * against a nick containing `:`, whitespace, or control bytes that a model
 * might mis-parse as role metadata or prompt injection. Same regex used by
 * the volatile header's speaker sanitizer, kept here so history entries and
 * session `[nick]` prefixes apply the same filter.
 */
export function safeSpeakerName(nick: string): string {
  return nick.replace(/[^A-Za-z0-9_`{}[\]\\^|-]/g, '').slice(0, 30);
}

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
  /**
   * How to shrink the buffer when it overflows `maxMessages`.
   * - `'bulk'` (default) — halve the buffer in one step. The history
   *   prefix is then byte-stable until the NEXT overflow, so downstream
   *   KV-cache / implicit-cache hits every turn between prunes.
   * - `'sliding'` — drop exactly the oldest-over-cap on each add. Prefix
   *   drifts every turn; every call is a cache miss. Escape hatch for
   *   operators who want the old behavior.
   */
  pruneStrategy?: 'bulk' | 'sliding';
  /**
   * Per-entry character cap. Defense-in-depth: even though the input
   * prompt cap (`cfg.input.maxPromptChars`) blocks oversize user
   * messages at the pipeline boundary, bot output and future code paths
   * can still call `addMessage()` directly. Truncate per-entry so a
   * single giant message can't blow through the byte budget below.
   * Optional — undefined means no per-entry cap (legacy behavior).
   */
  maxMessageChars?: number;
}

/** Sentinel appended to truncated entries so model + reader see the cut. */
const TRUNCATION_MARKER = '...';

/** Rough char→token ratio used for trimming — ~4 chars per token for English. */
const CHARS_PER_TOKEN = 4;

/**
 * Hard cap on tracked channels. Mirrors `SocialTracker.MAX_CHANNELS` and
 * `EngagementTracker.MAX_CHANNELS` so the three ai-chat per-channel maps
 * scale together rather than each accumulating channels independently.
 * On overflow the least-recently-touched channel buffer is dropped — its
 * messages were either already aged past TTL or sit on the cold side of
 * the working set.
 */
const MAX_CHANNELS = 256;

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
    initialChannels?: Iterable<readonly [string, readonly ContextEntry[]]>,
  ) {
    if (initialChannels) {
      // Copy each entry array so the caller's arrays stay immutable and our
      // internal buffers remain mutable (splice/push during add/prune).
      this.channels = new Map(Array.from(initialChannels, ([k, v]) => [k, [...v]]));
    }
  }

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
    const cap = this.config.maxMessageChars;
    const stored =
      cap !== undefined && cap > 0 && text.length > cap
        ? text.slice(0, cap - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
        : text;
    const entry: ContextEntry = { nick, text: stored, isBot, timestamp: this.now() };
    const key = channel.toLowerCase();

    let buf = this.channels.get(key);
    if (!buf) {
      // Eject the LRU channel before inserting a new one. Map iteration
      // order is insertion order, so deleting the first key drops the
      // oldest write. We refresh insertion order on every active channel
      // by `delete + set` further down on the same code path.
      if (this.channels.size >= MAX_CHANNELS) {
        const oldest = this.channels.keys().next().value;
        if (oldest !== undefined) this.channels.delete(oldest);
      }
      buf = [];
      this.channels.set(key, buf);
    } else {
      // Promote-on-touch so the LRU eviction targets cold channels.
      this.channels.delete(key);
      this.channels.set(key, buf);
    }
    buf.push(entry);
    if (buf.length > this.config.maxMessages) {
      // Bulk-prune (default): halve the buffer atomically on overflow so the
      // history prefix stays byte-stable between prunes. That lets Ollama's
      // llama.cpp KV-cache and Gemini's implicit cache hit every turn except
      // the prune point itself, instead of drifting on every message.
      // Sliding: drop-oldest-per-turn — preserves old behavior if an
      // operator explicitly opts in.
      if (this.config.pruneStrategy === 'sliding') {
        buf.splice(0, buf.length - this.config.maxMessages);
      } else {
        buf.splice(0, Math.ceil(buf.length / 2));
      }
    }

    // Byte-budget enforcement. The message-count cap above can't bound total
    // bytes: many small messages plus one cap-sized one can still push
    // serialized context past the configured maxTokens budget, inflating
    // single-call cost. Cap cumulative bytes at maxTokens*4 (the chars-per-
    // token heuristic used at serialize time) and evict oldest entries
    // until the buffer fits.
    const maxBytes = this.config.maxTokens * CHARS_PER_TOKEN;
    let total = 0;
    for (const e of buf) total += e.nick.length + e.text.length + 2;
    while (total > maxBytes && buf.length > 1) {
      const oldest = buf[0];
      total -= oldest.nick.length + oldest.text.length + 2;
      buf.splice(0, 1);
    }
  }

  /**
   * Build the AI-facing messages array for a channel.
   *
   * @param channel        — channel to pull history from (null for PMs, which are disabled)
   * @param _nick          — current speaker (unused today; reserved for per-nick filtering)
   * @param maxMessages    — optional per-character message cap. Applied as a
   *   bulk-prune threshold: when the buffer exceeds `maxMessages × 1.5`, it's
   *   pruned down to `maxMessages` in one step, then held stable until the
   *   next overflow. This preserves the byte-stable history prefix that
   *   llama.cpp KV-cache and Gemini implicit cache rely on. A plain
   *   `slice(-N)` at the call site would shift the included window by one
   *   message every turn once `buffer.length > N` — 100% cache-miss rate.
   * @param options        — per-call formatting options. `dropNickPrefix` omits
   *   the `nick: ` prose prefix on user entries so small local models can't
   *   mirror the pattern back as fabricated speaker turns.
   */
  getContext(
    channel: string | null,
    _nick: string,
    maxMessages?: number,
    options?: { dropNickPrefix?: boolean },
  ): AIMessage[] {
    if (channel === null) return []; // PM removed
    const key = channel.toLowerCase();
    const buf = this.pruneAndGet(key);
    if (buf.length === 0) return [];

    // Bulk-prune to the per-character cap: only when we're significantly over
    // the cap (1.5×), prune down to exactly the cap. Between prunes the
    // buffer stays byte-stable, so every turn reuses the same prefix.
    if (maxMessages !== undefined && maxMessages > 0 && buf.length > maxMessages * 1.5) {
      buf.splice(0, buf.length - maxMessages);
    }

    // Build messages newest-first, then reverse — lets us stop as soon as we exceed budget.
    const maxChars = this.config.maxTokens * CHARS_PER_TOKEN;
    const messages: AIMessage[] = [];
    let chars = 0;
    const effectiveCap = maxMessages !== undefined && maxMessages > 0 ? maxMessages : buf.length;
    let included = 0;
    for (let i = buf.length - 1; i >= 0 && included < effectiveCap; i--) {
      const e = buf[i];
      // `nick: text` prose prefix by default — small local models (llama3
      // family) mirror the bracket pattern into their output, but medium-
      // and large-class models benefit from the inline attribution. On
      // small-class deployments the caller sets `dropNickPrefix: true` and
      // we rely on the volatile header to carry the speaker identity.
      // Apply the same `safeSpeakerName` filter here as the volatile header
      // so a nick with punctuation can't masquerade as role metadata inside
      // the history stream.
      const speaker = safeSpeakerName(e.nick) || 'user';
      const content = e.isBot || options?.dropNickPrefix ? e.text : `${speaker}: ${e.text}`;
      if (chars + content.length > maxChars && messages.length > 0) break;
      messages.push({ role: e.isBot ? 'assistant' : 'user', content });
      chars += content.length;
      included++;
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

  /**
   * Return the N most-recent distinct non-bot speakers in a channel, newest
   * first. Used to surface speaker attribution in the volatile header for
   * `model_class: "small"` deployments where the inline `nick: ` prefix has
   * been stripped from history.
   */
  recentSpeakers(channel: string, n: number, excludeNick?: string): string[] {
    const buf = this.channels.get(channel.toLowerCase());
    if (!buf) return [];
    const exclude = excludeNick?.toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = buf.length - 1; i >= 0 && out.length < n; i--) {
      const e = buf[i];
      if (e.isBot) continue;
      const key = e.nick.toLowerCase();
      if (seen.has(key) || key === exclude) continue;
      seen.add(key);
      out.push(e.nick);
    }
    return out;
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
