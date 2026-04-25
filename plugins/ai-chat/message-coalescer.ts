// Coalesce rapid same-(channel, nick) PRIVMSG fragments into one logical
// message before any downstream processing fires.
//
// IRC servers split any PRIVMSG over ~440 bytes into multiple wire frames.
// From the bot's perspective each fragment is a fresh `pubm` event. Without
// coalescing, every fragment:
//   - adds a separate entry to the context buffer (so the LLM sees the
//     user's one logical message as N partial turns),
//   - fires the engagement / social trackers N times (inflating
//     "active" signal and bouncing engagement state),
//   - and triggers the AI pipeline N times (N × provider work, N × token
//     spend, and the model produces N confused replies that don't know
//     the other fragments exist).
//
// The coalescer debounces by a short window (default 250 ms — well above
// IRC server fragment latency, well below human-perceptible). Within the
// window, fragments accumulate; on expiry, `onFire` runs once with the
// merged text.
//
// Bot-originated messages should bypass the coalescer entirely — they need
// to land in context immediately so the next user prompt sees the latest
// reply.
import type { HandlerContext } from '../../src/types';

/** What the coalescer hands back when a burst expires. */
export interface CoalescedMessage {
  channel: string;
  nick: string;
  /** Fragments joined with a single space. */
  text: string;
  /** The latest HandlerContext from the burst — canonical ctx for downstream. */
  ctx: HandlerContext;
  /** Number of fragments that were merged. 1 means no coalescing happened. */
  fragmentCount: number;
}

/** Per-burst pending state. Internal only. */
interface PendingBurst {
  parts: string[];
  bytes: number;
  ctx: HandlerContext;
  timer: ReturnType<typeof setTimeout>;
  onFire: (msg: CoalescedMessage) => void;
}

export class MessageCoalescer {
  private readonly windowMs: number;
  /** Hard cap on accumulated UTF-8 bytes per burst — drops further fragments
   *  on overflow rather than growing the buffer unbounded. */
  private readonly maxBytes: number;
  private readonly pending = new Map<string, PendingBurst>();

  constructor(windowMs: number, maxBytes: number) {
    this.windowMs = windowMs;
    this.maxBytes = maxBytes;
  }

  /**
   * Submit a fragment. If a burst is already open for (channel, nickKey),
   * the fragment is appended (up to `maxBytes`) and the timer reset.
   * Otherwise a new burst opens. `onFire` is invoked exactly once when the
   * burst's timer expires; subsequent submits to the same key after fire
   * start a fresh burst.
   *
   * The first `onFire` callback wins for a given burst — later submits in
   * the same window keep using the original callback even if the caller
   * passes a different one. That keeps callback identity stable across
   * fragments (which all came from the same caller anyway).
   */
  submit(
    channel: string,
    nick: string,
    text: string,
    ctx: HandlerContext,
    onFire: (msg: CoalescedMessage) => void,
  ): void {
    const key = this.keyOf(channel, nick);
    // Buffer.byteLength matches the IRC wire encoding (UTF-8) so the cap is
    // expressed in the same units the server fragments at — a string-length
    // cap would under-count multibyte content (emoji, CJK).
    const fragmentBytes = Buffer.byteLength(text, 'utf8');
    const existing = this.pending.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      // Drop fragments that would push the burst past the byte cap. The
      // alternative — slicing — would split a multibyte codepoint.
      if (existing.bytes + fragmentBytes <= this.maxBytes) {
        existing.parts.push(text);
        existing.bytes += fragmentBytes;
      }
      existing.ctx = ctx;
      existing.timer = setTimeout(() => this.fire(key), this.windowMs);
      return;
    }

    const entry: PendingBurst = {
      parts: [text],
      bytes: fragmentBytes,
      ctx,
      onFire,
      // Placeholder; reassigned immediately below. setTimeout returns a
      // Timeout handle synchronously, so by the time `fire` could run
      // (next event-loop tick at the earliest) the property is set.
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    entry.timer = setTimeout(() => this.fire(key), this.windowMs);
    this.pending.set(key, entry);
  }

  /** Flush all pending bursts immediately and clear timers. Used at teardown. */
  teardown(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  /** Number of bursts currently pending. For diagnostics / tests. */
  pendingCount(): number {
    return this.pending.size;
  }

  private keyOf(channel: string, nick: string): string {
    return `${channel}|${nick.toLowerCase()}`;
  }

  private fire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    entry.onFire({
      channel: entry.ctx.channel ?? '',
      nick: entry.ctx.nick,
      text: entry.parts.join(' '),
      ctx: entry.ctx,
      fragmentCount: entry.parts.length,
    });
  }
}
