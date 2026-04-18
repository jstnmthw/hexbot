// Thread-based engagement tracker for the ai-chat plugin.
// An engaged user is one the bot has recently replied to and who still
// "holds the floor" — no one else has spoken, they haven't addressed another
// user, and the soft/hard timeouts haven't fired. Engagement is the signal
// the reply policy uses to keep the conversation going without re-address.
//
// State is ephemeral (per-plugin-instance). Persistence would mis-handle
// reboots (stale engagement after restart) and offer no real value — the
// point of engagement is the live, in-flight conversation.

/**
 * Hard caps prevent nick-rotation / invite-spam floods from growing the
 * tracker without bound. Past the per-channel cap we evict the oldest
 * engagement; past the channel cap we evict the channel with the oldest
 * lastExchangeAt across its entries.
 */
const MAX_ENGAGED_PER_CHANNEL = 8;
const MAX_CHANNELS = 256;

export interface EngagementEntry {
  /** Time the engagement started (first bot reply). Used for the hard ceiling. */
  startedAt: number;
  /** Time of the last bot↔user exchange. Used for the soft timeout. */
  lastExchangeAt: number;
}

export interface EngagementTrackerOptions {
  softTimeoutMs: number;
  hardCeilingMs: number;
  now?: () => number;
}

/**
 * Tracks which (channel, nick) pairs are currently engaged in a thread with
 * the bot. A pair becomes engaged on the next `onBotReply` call; engagement
 * ends on:
 *
 *   - another human speaking in the channel (floor lost),
 *   - the engaged user addressing a third nick by name (thread redirected),
 *   - soft timeout since last exchange,
 *   - hard ceiling since the thread started,
 *   - explicit `endEngagement` / `dropChannel` / `clear`.
 */
export class EngagementTracker {
  private channels = new Map<string, Map<string, EngagementEntry>>();
  private softTimeoutMs: number;
  private hardCeilingMs: number;
  private now: () => number;

  constructor(opts: EngagementTrackerOptions) {
    this.softTimeoutMs = opts.softTimeoutMs;
    this.hardCeilingMs = opts.hardCeilingMs;
    this.now = opts.now ?? Date.now;
  }

  /** Update the active timeouts (hot-reload). */
  setTimeouts(softTimeoutMs: number, hardCeilingMs: number): void {
    this.softTimeoutMs = softTimeoutMs;
    this.hardCeilingMs = hardCeilingMs;
  }

  /**
   * Mark a user as engaged. Called after the bot successfully replies to them.
   * If they're already engaged, bumps `lastExchangeAt` but leaves `startedAt`
   * alone so the hard ceiling still fires eventually.
   */
  onBotReply(channel: string, nick: string): void {
    const chKey = channel.toLowerCase();
    const nickKey = nick.toLowerCase();
    const now = this.now();

    let engaged = this.channels.get(chKey);
    if (!engaged) {
      if (this.channels.size >= MAX_CHANNELS) this.evictOldestChannel();
      engaged = new Map();
      this.channels.set(chKey, engaged);
    }

    const existing = engaged.get(nickKey);
    if (existing) {
      existing.lastExchangeAt = now;
      return;
    }

    if (engaged.size >= MAX_ENGAGED_PER_CHANNEL) {
      // Evict oldest engagement in this channel by lastExchangeAt.
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, e] of engaged) {
        if (e.lastExchangeAt < oldestAt) {
          oldestAt = e.lastExchangeAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) engaged.delete(oldestKey);
    }

    engaged.set(nickKey, { startedAt: now, lastExchangeAt: now });
  }

  /**
   * Process a human channel message. Updates engagement state based on the
   * IRC-native floor semantics:
   *
   *   - If this nick is currently engaged:
   *       - If they address another nick (`other: …`), end their engagement
   *         — they're no longer talking to the bot.
   *       - Otherwise, bump their lastExchangeAt.
   *   - If this nick is NOT currently engaged AND the channel has any
   *     engaged users, end all other users' engagement — a different human
   *     took the floor. This matches the SocialTracker.pendingQuestions
   *     "different nick speaks → answered" rule.
   *
   * `channelNicks` is the current user list for the channel, used to decide
   * whether a leading-name prefix refers to a real participant (vs a word
   * that happens to look like `foo: bar`).
   */
  onHumanMessage(channel: string, nick: string, text: string, channelNicks: string[]): void {
    const chKey = channel.toLowerCase();
    const engaged = this.channels.get(chKey);
    if (!engaged || engaged.size === 0) return;

    const nickKey = nick.toLowerCase();
    const now = this.now();
    const engagedEntry = engaged.get(nickKey);

    if (engagedEntry) {
      // Engaged user spoke. Did they redirect to someone else?
      const addressed = extractAddressedNick(text, channelNicks);
      if (
        addressed &&
        addressed.toLowerCase() !== nickKey &&
        engaged.has(addressed.toLowerCase()) === false
      ) {
        // Addressed a third party — end this user's engagement. (Addressing
        // another engaged user is noisy to resolve; we leave both engaged.)
        engaged.delete(nickKey);
        if (engaged.size === 0) this.channels.delete(chKey);
        return;
      }
      engagedEntry.lastExchangeAt = now;
      return;
    }

    // Another human took the floor — end every currently-engaged user's
    // thread in this channel. Mirrors pendingQuestions' "different nick
    // speaks" clear rule.
    this.channels.delete(chKey);
  }

  /** True if this (channel, nick) pair is currently engaged and unexpired. */
  isEngaged(channel: string, nick: string): boolean {
    const chKey = channel.toLowerCase();
    const nickKey = nick.toLowerCase();
    const engaged = this.channels.get(chKey);
    if (!engaged) return false;
    const entry = engaged.get(nickKey);
    if (!entry) return false;

    const now = this.now();
    if (now - entry.lastExchangeAt > this.softTimeoutMs) {
      engaged.delete(nickKey);
      if (engaged.size === 0) this.channels.delete(chKey);
      return false;
    }
    if (now - entry.startedAt > this.hardCeilingMs) {
      engaged.delete(nickKey);
      if (engaged.size === 0) this.channels.delete(chKey);
      return false;
    }
    return true;
  }

  /** Explicitly end a single user's engagement (e.g. on part/kick). */
  endEngagement(channel: string, nick: string): void {
    const chKey = channel.toLowerCase();
    const engaged = this.channels.get(chKey);
    if (!engaged) return;
    engaged.delete(nick.toLowerCase());
    if (engaged.size === 0) this.channels.delete(chKey);
  }

  /** Drop a channel's entire engaged set (bot part/kick). */
  dropChannel(channel: string): void {
    this.channels.delete(channel.toLowerCase());
  }

  /** Clear everything. */
  clear(): void {
    this.channels.clear();
  }

  /** Current engaged-user count in a channel (testing/introspection). */
  sizeFor(channel: string): number {
    return this.channels.get(channel.toLowerCase())?.size ?? 0;
  }

  private evictOldestChannel(): void {
    let oldestChKey: string | null = null;
    let oldestAt = Infinity;
    for (const [chKey, engaged] of this.channels) {
      for (const entry of engaged.values()) {
        if (entry.lastExchangeAt < oldestAt) {
          oldestAt = entry.lastExchangeAt;
          oldestChKey = chKey;
        }
      }
    }
    if (oldestChKey !== null) this.channels.delete(oldestChKey);
  }
}

/**
 * Return the nick the message appears to address at its head, or null.
 * Matches `<nick>[:,]` at the start of the message and only returns a nick
 * that's actually in `channelNicks` so random words like `well: anyway` don't
 * false-positive. Case-insensitive comparison; returns the nick as it appears
 * in `channelNicks` to preserve canonical casing for the caller.
 */
function extractAddressedNick(text: string, channelNicks: string[]): string | null {
  const trimmed = text.trim();
  const match = /^([^\s:,]+)[:,]/.exec(trimmed);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  for (const nick of channelNicks) {
    if (nick.toLowerCase() === candidate) return nick;
  }
  return null;
}
