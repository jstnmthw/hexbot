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
    /**
     * Optional warn-level logger. Tick-loop and event-reaction errors are
     * surfaced here so an ambient bug doesn't stealth-disable the feature
     * (a silently-swallowed synchronous throw would otherwise leave the
     * interval running but producing nothing for the process lifetime).
     */
    private warn: (msg: string) => void = () => {},
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

    // Reject anything that isn't a plausible IRC nick before handing it to
    // the LLM, and delimit it so the model treats it as data, not instruction.
    const safeNick = filterNick(nick);
    if (!safeNick) return;
    this.sender(
      channel,
      'join_wb',
      `A user named <<<${safeNick}>>> just joined the channel.`,
    ).catch((err) => this.warn(`ambient join_wb sender rejected: ${describeError(err)}`));
  }

  /** Notify the engine that the channel topic changed. */
  onTopic(channel: string, nick: string, topic: string): void {
    if (!this.config.eventReactions.topicChange || !this.sender) return;
    if (!this.trackedChannels.has(channel.toLowerCase())) return;
    if (this.social.isLastMessageFromBot(channel)) return;

    // Delimit user-supplied topic text so the LLM treats it as data rather
    // than as instructions. The system prompt's SAFETY_CLAUSE plus the
    // output-formatter's fantasy-drop remain the primary defences; this
    // just narrows the injection surface.
    const safeNick = filterNick(nick);
    const delimitedTopic = `<<<${sanitiseForPrompt(topic)}>>>`;
    const who = safeNick ? `<<<${safeNick}>>>` : 'someone';
    this.sender(channel, 'topic', `${who} changed the topic to: ${delimitedTopic}`).catch((err) =>
      this.warn(`ambient topic sender rejected: ${describeError(err)}`),
    );
  }

  /** Get effective chattiness (config base × character trait). */
  getEffectiveChattiness(characterChattiness: number): number {
    return this.config.chattiness * characterChattiness;
  }

  /** The periodic tick — evaluates idle and unanswered question conditions. */
  tick(): void {
    try {
      this.tickInner();
    } catch (err) {
      // A synchronous throw here (e.g. a bug in social-tracker or in a
      // sender callback before it returns its promise) would otherwise
      // silently disable ambient for the process lifetime.
      this.warn(`ambient tick threw: ${describeError(err)}`);
    }
  }

  private tickInner(): void {
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
            ).catch((err) => this.warn(`ambient idle sender rejected: ${describeError(err)}`));
            continue;
          }
        }
      }

      // --- Unanswered questions (all except dead/flooding) ---
      if (this.config.unansweredQuestions.enabled && activity !== 'dead') {
        const waitMs = this.config.unansweredQuestions.waitSeconds * 1_000;
        const ready = this.social.getUnansweredQuestions(channelKey, waitMs);
        // Drop any question older than the most recent bot reply — the bot
        // already spoke after it, so it's effectively answered (correctly or
        // not). Without this, ambient fires on a question the bot has
        // already addressed a turn ago. See audit persona-master-refactor.
        const state = this.social.getState(channelKey);
        const lastBotMsg = state?.lastBotMessage ?? 0;
        const freshReady = ready.filter((q) => q.at > lastBotMsg);
        if (freshReady.length > 0) {
          const q = freshReady[0];
          this.social.consumeQuestion(channelKey, q);
          const safeNick = filterNick(q.nick);
          const who = safeNick ? `<<<${safeNick}>>>` : 'someone';
          const delimited = `<<<${sanitiseForPrompt(q.text)}>>>`;
          this.sender(
            channelKey,
            'unanswered',
            `Earlier ${who} asked: ${delimited} — the thread went quiet. Chime in if you have something worth saying, or steer to something else. Only name them if it genuinely clarifies who you're replying to; otherwise just speak.`,
          ).catch((err) => this.warn(`ambient unanswered sender rejected: ${describeError(err)}`));
          continue;
        }
      }
    }
  }
}

/**
 * Strip characters that couldn't plausibly be in an IRC nick. Returns the
 * filtered string, or empty when nothing survives (caller should then skip
 * the ambient emission).
 */
function filterNick(nick: string): string {
  const cleaned = nick.replace(/[^A-Za-z0-9_`{}[\]\\^|-]/g, '').slice(0, 30);
  return cleaned;
}

/**
 * Neutralise characters that could close our delimiter or inject prompt
 * structure. The SAFETY_CLAUSE + fantasy-command dropper remain the primary
 * defences; this is a narrow sanity filter on spans we interpolate raw.
 */
function sanitiseForPrompt(text: string): string {
  return text
    .replace(/[<>]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 256);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-export question heuristic for tests that imported it from ambient. */
export { looksLikeQuestion } from './social-tracker';
