// Ambient participation engine for the ai-chat plugin.
// Makes the bot speak without being addressed — idle remarks in quiet channels,
// answering unanswered questions, reacting to channel events.
// Delegates channel state tracking to the SocialTracker.
import type { SocialTracker } from './social-tracker';

/** Configuration for the ambient engine. */
export interface AmbientConfig {
  enabled: boolean;
  idle: {
    afterMinutes: number;
    chance: number;
    minUsers: number;
  };
  unansweredQuestions: {
    enabled: boolean;
    waitSeconds: number;
  };
  /** Base chattiness (0-1). Scaled by the active character's chattiness trait. */
  chattiness: number;
  /** Topic keywords that increase the chance of ambient participation. */
  interests: string[];
  eventReactions: {
    joinWb: boolean;
    topicChange: boolean;
  };
}

/** Callback signature for sending an ambient message. */
export type AmbientSender = (
  channel: string,
  kind: AmbientTriggerKind,
  prompt: string,
) => Promise<void>;

export type AmbientTriggerKind = 'idle' | 'unanswered' | 'join_wb' | 'topic';

/**
 * The ambient engine evaluates whether the bot should speak unprompted.
 * It uses the SocialTracker for channel state (activity, questions,
 * back-to-back tracking) and fires a callback with the channel and a
 * suggested prompt. The plugin wires that callback to its pipeline.
 */
export class AmbientEngine {
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private sender: AmbientSender | null = null;
  /** Channels the engine is tracking (set on first message seen). */
  private trackedChannels = new Set<string>();

  constructor(
    private config: AmbientConfig,
    private social: SocialTracker,
    private now: () => number = Date.now,
  ) {}

  /** Start the ambient tick loop. */
  start(sender: AmbientSender, intervalMs = 30_000): void {
    this.sender = sender;
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = setInterval(() => this.tick(), intervalMs);
  }

  /** Stop the tick loop and clear state. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.sender = null;
    this.trackedChannels.clear();
  }

  /** Notify the engine that activity occurred in a channel (for tracking which channels exist). */
  onChannelActivity(channel: string): void {
    this.trackedChannels.add(channel.toLowerCase());
  }

  /** Notify the engine that a user joined a channel. */
  onJoin(channel: string, nick: string): void {
    if (!this.config.eventReactions.joinWb || !this.sender) return;
    if (!this.trackedChannels.has(channel.toLowerCase())) return;
    if (this.social.isLastMessageFromBot(channel)) return;

    this.sender(channel, 'join_wb', `${nick} just joined the channel.`).catch(() => {});
  }

  /** Notify the engine that the channel topic changed. */
  onTopic(channel: string, nick: string, topic: string): void {
    if (!this.config.eventReactions.topicChange || !this.sender) return;
    if (!this.trackedChannels.has(channel.toLowerCase())) return;
    if (this.social.isLastMessageFromBot(channel)) return;

    this.sender(channel, 'topic', `${nick} changed the topic to: ${topic}`).catch(() => {});
  }

  /** Get effective chattiness (config base × character trait). */
  getEffectiveChattiness(characterChattiness: number): number {
    return this.config.chattiness * characterChattiness;
  }

  /** The periodic tick — evaluates idle and unanswered question conditions. */
  tick(): void {
    if (!this.sender) return;
    const now = this.now();

    for (const channelKey of this.trackedChannels) {
      const activity = this.social.getActivity(channelKey);

      // Back-to-back prevention via social tracker
      if (this.social.isLastMessageFromBot(channelKey)) continue;

      // Activity-gated participation:
      // - flooding: no ambient at all
      // - active: only unanswered questions (high bar)
      // - normal: unanswered questions + occasional
      // - slow: idle + unanswered questions
      // - dead: idle remarks only
      if (activity === 'flooding') continue;

      // --- Idle remarks (slow/dead only) ---
      if (activity === 'dead' || activity === 'slow') {
        const state = this.social.getState(channelKey);
        if (state && state.lastMessageAt > 0) {
          const idleMs = now - state.lastMessageAt;
          const idleThresholdMs = this.config.idle.afterMinutes * 60_000;
          if (idleMs >= idleThresholdMs && Math.random() < this.config.idle.chance) {
            this.sender(
              channelKey,
              'idle',
              'The channel has been quiet for a while. Say something casual or interesting.',
            ).catch(() => {});
            continue;
          }
        }
      }

      // --- Unanswered questions (all except dead/flooding) ---
      if (this.config.unansweredQuestions.enabled && activity !== 'dead') {
        const waitMs = this.config.unansweredQuestions.waitSeconds * 1_000;
        const ready = this.social.getUnansweredQuestions(channelKey, waitMs);
        if (ready.length > 0) {
          const q = ready[0];
          this.social.consumeQuestion(channelKey, q);
          this.sender(
            channelKey,
            'unanswered',
            `${q.nick} asked: "${q.text}" — no one answered. You can respond if you have something to say.`,
          ).catch(() => {});
          continue;
        }
      }
    }
  }
}

/** Re-export question heuristic for tests that imported it from ambient. */
export { looksLikeQuestion } from './social-tracker';
