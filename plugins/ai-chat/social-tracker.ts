// Social awareness tracker for the ai-chat plugin.
// Tracks channel activity levels, per-user interaction stats, and pending
// questions. Used by the ambient engine to make context-aware participation
// decisions instead of random ones.
import type { PluginDB } from '../../src/types';

// ---------------------------------------------------------------------------
// Activity levels
// ---------------------------------------------------------------------------

export type ActivityLevel = 'dead' | 'slow' | 'normal' | 'active' | 'flooding';

/** Per-channel social state (ephemeral — not persisted). */
export interface ChannelSocialState {
  activity: ActivityLevel;
  /** Rolling window of message timestamps for activity calculation. */
  messageTimestamps: number[];
  /** Per-nick stats within this channel (ephemeral). */
  activeUsers: Map<string, { lastSeen: number; messageCount: number }>;
  /** Timestamp of the last message (any) in this channel. */
  lastMessageAt: number;
  /** Timestamp of the last bot message in this channel. */
  lastBotMessage: number;
  /** True if the most recent message was from the bot. */
  lastWasBot: boolean;
  /** Questions that haven't been answered yet. */
  pendingQuestions: PendingQuestion[];
}

export interface PendingQuestion {
  nick: string;
  text: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Per-user interaction stats (persisted in plugin DB)
// ---------------------------------------------------------------------------

const USER_INTERACTION_PREFIX = 'user-interaction:';
/** Drop user-interaction rows whose lastSeen is older than this. */
const USER_INTERACTION_RETENTION_MS = 90 * 24 * 60 * 60_000;

export interface UserInteraction {
  lastSeen: number;
  totalMessages: number;
  botInteractions: number;
  lastBotInteraction: number;
}

// ---------------------------------------------------------------------------
// Social tracker
// ---------------------------------------------------------------------------

/** Rolling window size for activity calculation (5 minutes). */
const ACTIVITY_WINDOW_MS = 5 * 60_000;
/** Dead threshold: no messages in 30 minutes. */
const DEAD_THRESHOLD_MS = 30 * 60_000;
/** Max age for pending questions before they're cleaned up. */
const QUESTION_MAX_AGE_MS = 10 * 60_000;
/** Channels whose last message is older than this are dropped by the sweep. */
const IDLE_CHANNEL_MS = 24 * 60 * 60_000;
/** Hard cap on tracked channels (defence against invite-spam / auto-join exhaustion). */
const MAX_CHANNELS = 256;
/** How often maintain() actually does work (opportunistically triggered from pruneAndRecalc). */
const MAINTAIN_INTERVAL_MS = 60 * 60_000;

export class SocialTracker {
  private channels = new Map<string, ChannelSocialState>();
  private lastMaintainAt = 0;
  /** Last calendar day we ran the user-interaction DB retention sweep. */
  private lastUserRetentionDay: string | null = null;

  constructor(
    private db: PluginDB | null = null,
    private now: () => number = Date.now,
  ) {}

  /** Record a message in a channel. Updates activity, user stats, and question tracking. */
  onMessage(channel: string, nick: string, text: string, isBot: boolean): void {
    const state = this.getOrCreate(channel);
    const now = this.now();

    state.messageTimestamps.push(now);
    state.lastMessageAt = now;
    state.lastWasBot = isBot;
    if (isBot) {
      state.lastBotMessage = now;
    }

    // Track per-user activity (ephemeral)
    if (!isBot) {
      const nickKey = nick.toLowerCase();
      const user = state.activeUsers.get(nickKey) ?? { lastSeen: 0, messageCount: 0 };
      user.lastSeen = now;
      user.messageCount++;
      state.activeUsers.set(nickKey, user);
    }

    // Question tracking — hard cap keeps the list bounded even inside the
    // 10-min prune window (defence against a crafted `foo?` flood).
    if (!isBot && looksLikeQuestion(text)) {
      if (state.pendingQuestions.length >= 50) state.pendingQuestions.shift();
      state.pendingQuestions.push({ nick, text, at: now });
    }
    // A human message from a DIFFERENT nick means someone responded — clear all
    // pending questions. Same nick speaking again is not a response.
    if (!isBot && state.pendingQuestions.length > 0) {
      const hasOtherNickQuestions = state.pendingQuestions.some(
        (q) => q.nick.toLowerCase() !== nick.toLowerCase(),
      );
      if (hasOtherNickQuestions) {
        state.pendingQuestions = state.pendingQuestions.filter(
          (q) => q.nick.toLowerCase() === nick.toLowerCase(),
        );
      }
    }

    // Recalculate activity level
    this.pruneAndRecalc(channel);

    // Persist user interaction stats
    if (!isBot && this.db) {
      this.recordUserInteraction(nick, false);
    }
  }

  /** Record that the bot interacted with a user (responded to them). */
  recordBotInteraction(nick: string): void {
    if (!this.db) return;
    this.recordUserInteraction(nick, true);
  }

  /** Get the current activity level for a channel. */
  getActivity(channel: string): ActivityLevel {
    const state = this.channels.get(channel.toLowerCase());
    if (!state) return 'dead';
    this.pruneAndRecalc(channel);
    return state.activity;
  }

  /** Get full social state for a channel (for ambient engine integration). */
  getState(channel: string): ChannelSocialState | undefined {
    return this.channels.get(channel.toLowerCase());
  }

  /** Check if the last message in the channel was from the bot. */
  isLastMessageFromBot(channel: string): boolean {
    return this.channels.get(channel.toLowerCase())?.lastWasBot ?? false;
  }

  /** Get pending unanswered questions older than `minAgeMs`. */
  getUnansweredQuestions(channel: string, minAgeMs: number): PendingQuestion[] {
    const state = this.channels.get(channel.toLowerCase());
    if (!state) return [];
    const now = this.now();
    return state.pendingQuestions.filter((q) => now - q.at >= minAgeMs);
  }

  /** Remove a specific question from the pending list. */
  consumeQuestion(channel: string, question: PendingQuestion): void {
    const state = this.channels.get(channel.toLowerCase());
    if (!state) return;
    state.pendingQuestions = state.pendingQuestions.filter((q) => q !== question);
  }

  /** Get persisted interaction stats for a user. */
  getUserInteraction(nick: string): UserInteraction | null {
    if (!this.db) return null;
    const raw = this.db.get(`${USER_INTERACTION_PREFIX}${nick.toLowerCase()}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UserInteraction;
    } catch {
      return null;
    }
  }

  /** Check if a user has ever interacted with the bot. */
  hasInteractedWithBot(nick: string): boolean {
    const stats = this.getUserInteraction(nick);
    return stats !== null && stats.botInteractions > 0;
  }

  /** Clear all ephemeral state. */
  clear(): void {
    this.channels.clear();
  }

  /** Drop a single channel's ephemeral state (wire to bot part/kick events). */
  dropChannel(channel: string): void {
    this.channels.delete(channel.toLowerCase());
  }

  // -------------------------------------------------------------------------

  private getOrCreate(channel: string): ChannelSocialState {
    const key = channel.toLowerCase();
    let state = this.channels.get(key);
    if (!state) {
      state = {
        activity: 'dead',
        messageTimestamps: [],
        activeUsers: new Map(),
        lastMessageAt: 0,
        lastBotMessage: 0,
        lastWasBot: false,
        pendingQuestions: [],
      };
      this.channels.set(key, state);
    }
    return state;
  }

  private pruneAndRecalc(channel: string): void {
    const state = this.channels.get(channel.toLowerCase());
    if (!state) return;
    const now = this.now();

    // Prune old timestamps
    state.messageTimestamps = state.messageTimestamps.filter((t) => now - t < ACTIVITY_WINDOW_MS);

    // Prune old pending questions
    state.pendingQuestions = state.pendingQuestions.filter((q) => now - q.at < QUESTION_MAX_AGE_MS);

    // Evict stale per-nick entries so a nick-rotation flood can't keep growing
    // activeUsers forever. Anything outside the active window is dropped.
    const userCutoff = now - ACTIVITY_WINDOW_MS;
    for (const [nickKey, u] of state.activeUsers) {
      if (u.lastSeen < userCutoff) state.activeUsers.delete(nickKey);
    }

    // Calculate activity level based on messages in the last 5 minutes
    const count = state.messageTimestamps.length;
    const perMinute = count / (ACTIVITY_WINDOW_MS / 60_000);

    if (count === 0) {
      // Check if channel has been silent for 30+ minutes
      state.activity =
        state.lastMessageAt > 0 && now - state.lastMessageAt >= DEAD_THRESHOLD_MS ? 'dead' : 'slow';
    } else if (perMinute < 2) {
      state.activity = 'slow';
    } else if (perMinute <= 5) {
      state.activity = 'normal';
    } else if (perMinute <= 10) {
      state.activity = 'active';
    } else {
      state.activity = 'flooding';
    }

    // Opportunistic global sweep: drop idle channels and enforce hard cap.
    this.maintain(now);
  }

  /** Drop channels idle > 24h and enforce the channel-count hard cap. Throttled. */
  private maintain(now: number): void {
    if (now - this.lastMaintainAt < MAINTAIN_INTERVAL_MS) return;
    this.lastMaintainAt = now;

    const idleCutoff = now - IDLE_CHANNEL_MS;
    for (const [key, state] of this.channels) {
      if (state.lastMessageAt < idleCutoff) this.channels.delete(key);
    }

    // Hard cap: delete oldest-inserted entries (Map iteration is insertion-ordered).
    if (this.channels.size > MAX_CHANNELS) {
      const excess = this.channels.size - MAX_CHANNELS;
      const iter = this.channels.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (next.done) break;
        this.channels.delete(next.value);
      }
    }
  }

  private recordUserInteraction(nick: string, wasBotInteraction: boolean): void {
    if (!this.db) return;
    this.retainUserInteractionRows();
    const key = `${USER_INTERACTION_PREFIX}${nick.toLowerCase()}`;
    const now = this.now();
    let stats: UserInteraction;

    const raw = this.db.get(key);
    if (raw) {
      try {
        stats = JSON.parse(raw) as UserInteraction;
      } catch {
        stats = { lastSeen: 0, totalMessages: 0, botInteractions: 0, lastBotInteraction: 0 };
      }
    } else {
      stats = { lastSeen: 0, totalMessages: 0, botInteractions: 0, lastBotInteraction: 0 };
    }

    stats.lastSeen = now;
    stats.totalMessages++;
    if (wasBotInteraction) {
      stats.botInteractions++;
      stats.lastBotInteraction = now;
    }

    this.db.set(key, JSON.stringify(stats));
  }

  /**
   * Drop user-interaction rows whose lastSeen is older than 90 days. Runs at
   * most once per calendar day (mirrors TokenTracker.cleanupIfNewDay) so a
   * burst of onMessage calls doesn't hammer the DB.
   */
  private retainUserInteractionRows(): void {
    if (!this.db) return;
    const now = this.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.lastUserRetentionDay === today) return;
    this.lastUserRetentionDay = today;

    const cutoff = now - USER_INTERACTION_RETENTION_MS;
    for (const row of this.db.list(USER_INTERACTION_PREFIX)) {
      try {
        const stats = JSON.parse(row.value) as Partial<UserInteraction>;
        if (typeof stats.lastSeen === 'number' && stats.lastSeen < cutoff) {
          this.db.del(row.key);
        }
      } catch {
        // corrupt row — drop it
        this.db.del(row.key);
      }
    }
  }
}

/** Heuristic: does this message look like a question? */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  const lower = trimmed.toLowerCase();
  const interrogatives = [
    'who ',
    'what ',
    'where ',
    'when ',
    'why ',
    'how ',
    'does ',
    'is ',
    'can ',
    'should ',
  ];
  return interrogatives.some((w) => lower.startsWith(w));
}
