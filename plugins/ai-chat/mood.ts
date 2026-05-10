// Mood state machine for the ai-chat plugin.
// Internal mood creates temporal variety — the bot doesn't feel like a
// state machine. Mood is ephemeral (not persisted across restarts).

/** The bot's current mood state. All values 0-1. */
export interface BotMood {
  /** Decays over time, recharges during quiet periods. Low = shorter responses. */
  energy: number;
  /** Rises when included in conversation, drops when ignored. */
  engagement: number;
  /** Drops with spam/repeated questions, recharges with rest. */
  patience: number;
  /** Fluctuates semi-randomly. High = jokes, tangents, enthusiasm. */
  humor: number;
}

/**
 * Mood decay/recharge rates. Tuned so a fresh DEFAULT_MOOD takes ~30+ hours
 * of total inactivity to cross any threshold organically — drift should be
 * felt over a session, not observed in a single tick. All values are
 * dimensionless deltas applied to clamped 0..1 mood components.
 */
const RATES = {
  /** Energy bleeds 0.01/h ⇒ ~70h to fully discharge from 0.7 default. */
  energyDecayPerHour: 0.01,
  /** Recharge per fully-elapsed QUIET_WINDOW_MS, capped at 3 windows per call. */
  energyRechargePerQuietWindow: 0.05,
  /** Each direct interaction nudges engagement up — saturates at 1.0. */
  engagementRisePerInteraction: 0.1,
  engagementDecayPerHour: 0.02,
  /** Hard knock per detected repeat — 4 repeats in a row crosses the
   *  "getting impatient" threshold from default 0.8. */
  patienceDropPerRepeat: 0.05,
  patienceRechargePerHour: 0.02,
  /** Random walk amplitude per hour — produces semi-random humor variety
   *  without spiking on any single tick. */
  humorDriftPerHour: 0.05,
};

/** How long a quiet window must last to recharge energy (ms). */
const QUIET_WINDOW_MS = 15 * 60_000;

// Symmetric "noticeably low / noticeably high" cutoffs used by renderMoodLine.
// Anything inside [LOW, HIGH] is considered neutral and produces no modifier
// — keeps the system prompt quiet when nothing interesting is happening.
const MOOD_LOW_THRESHOLD = 0.3;
const MOOD_HIGH_THRESHOLD = 0.7;

/**
 * Initial mood. Energy and patience start above neutral so a fresh bot is
 * upbeat on first message; engagement and humor start mid-range so they can
 * drift either way without immediately tripping the LOW/HIGH thresholds and
 * surfacing a modifier in the very first volatile header.
 */
const DEFAULT_MOOD: BotMood = { energy: 0.7, engagement: 0.5, patience: 0.8, humor: 0.5 };

/**
 * Ephemeral mood state. Drifts autonomously with wall-clock time (energy
 * decays, patience recharges, humor random-walks) and nudges on interaction
 * events. Consumers read `renderMoodLine()` for a prompt-friendly hint and
 * `getVerbosityMultiplier()` to scale the maxLines cap.
 *
 * Lazy drift: time-based decay is applied on every read via `applyTimeDrift`
 * rather than on a timer, so a paused / test-frozen clock produces stable
 * output and there's no interval to tear down.
 */
export class MoodEngine {
  private mood: BotMood;
  private lastUpdate: number;
  private lastInteraction: number;

  constructor(
    private now: () => number = Date.now,
    initialMood?: Partial<BotMood>,
  ) {
    const t = this.now();
    this.mood = { ...DEFAULT_MOOD, ...initialMood };
    this.lastUpdate = t;
    this.lastInteraction = t;
  }

  /** Get a snapshot of the current mood (after applying time-based decay). */
  getMood(): Readonly<BotMood> {
    this.applyTimeDrift();
    return { ...this.mood };
  }

  /** Called when the bot is directly addressed or responds to someone. */
  onInteraction(): void {
    this.applyTimeDrift();
    this.mood.engagement = clamp(this.mood.engagement + RATES.engagementRisePerInteraction);
    this.lastInteraction = this.now();
  }

  /** Called when a repeated/spammy question is detected. */
  onRepeat(): void {
    this.applyTimeDrift();
    this.mood.patience = clamp(this.mood.patience - RATES.patienceDropPerRepeat);
  }

  /**
   * Render a one-line mood modifier for injection into the system prompt.
   * Returns empty string if mood is neutral (no modifier needed).
   */
  renderMoodLine(): string {
    this.applyTimeDrift();
    const parts: string[] = [];

    if (this.mood.energy < MOOD_LOW_THRESHOLD) parts.push('low energy, keep it brief');
    else if (this.mood.energy > MOOD_HIGH_THRESHOLD) parts.push('feeling energetic');

    if (this.mood.engagement < MOOD_LOW_THRESHOLD) parts.push('not very engaged');
    else if (this.mood.engagement > MOOD_HIGH_THRESHOLD) parts.push('feeling social');

    if (this.mood.patience < MOOD_LOW_THRESHOLD) parts.push('getting impatient');

    // Humor uses an asymmetric threshold pair (0.2 vs HIGH=0.7): "serious"
    // requires the humor random walk to drift considerably below neutral
    // before the system prompt picks up a tonal shift, so brief dips don't
    // produce flickering "serious mood" annotations on every other turn.
    if (this.mood.humor > MOOD_HIGH_THRESHOLD) parts.push('in a funny mood');
    else if (this.mood.humor < 0.2) parts.push('serious mood');

    if (parts.length === 0) return '';
    return `Current state: ${parts.join(', ')}.`;
  }

  /**
   * Get a maxLines multiplier based on mood. Stacks with character verbosity.
   * Returns a value between 0.5 and 1.5.
   */
  getVerbosityMultiplier(): number {
    this.applyTimeDrift();
    // Low energy → fewer lines, high energy + humor → more lines
    const energyFactor = 0.5 + this.mood.energy; // 0.5-1.5
    const humorBoost = this.mood.humor > MOOD_HIGH_THRESHOLD ? 1.1 : 1.0;
    return clamp(energyFactor * humorBoost, 0.5, 1.5);
  }

  /** Apply time-based mood drift since last update. */
  private applyTimeDrift(): void {
    const now = this.now();
    const elapsed = now - this.lastUpdate;
    // Skip sub-second updates: per-message bursts would otherwise generate
    // floating-point noise (`elapsed/3.6e6` underflows the rates) without
    // changing observable behavior.
    if (elapsed < 1_000) return;
    this.lastUpdate = now;

    const hours = elapsed / 3_600_000;

    // Energy decays over time
    this.mood.energy = clamp(this.mood.energy - RATES.energyDecayPerHour * hours);

    // Energy recharges during quiet periods
    const quietMs = now - this.lastInteraction;
    if (quietMs >= QUIET_WINDOW_MS) {
      const quietWindows = Math.floor(quietMs / QUIET_WINDOW_MS);
      // Cap recharge at 3 windows so a bot returning from a multi-day idle
      // doesn't pin energy to 1.0 in one drift step — gradual ramp is more
      // realistic than instant max.
      const recharge = Math.min(quietWindows, 3) * RATES.energyRechargePerQuietWindow;
      this.mood.energy = clamp(this.mood.energy + recharge);
    }

    // Engagement decays over time
    this.mood.engagement = clamp(this.mood.engagement - RATES.engagementDecayPerHour * hours);

    // Patience recharges over time
    this.mood.patience = clamp(this.mood.patience + RATES.patienceRechargePerHour * hours);

    // Humor drifts randomly. (Math.random() - 0.5) * 2 → [-1, 1], scaled by
    // the hourly amplitude × elapsed hours. Math.random() is fine here:
    // mood is non-security-relevant flavor, never a security primitive.
    const drift = (Math.random() - 0.5) * 2 * RATES.humorDriftPerHour * hours;
    this.mood.humor = clamp(this.mood.humor + drift);
  }
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}
