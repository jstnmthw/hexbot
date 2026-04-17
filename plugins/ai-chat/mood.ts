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

/** Mood decay/recharge rates per hour. */
const RATES = {
  energyDecayPerHour: 0.01,
  energyRechargePerQuietWindow: 0.05,
  engagementRisePerInteraction: 0.1,
  engagementDecayPerHour: 0.02,
  patienceDropPerRepeat: 0.05,
  patienceRechargePerHour: 0.02,
  humorDriftPerHour: 0.05,
};

/** How long a quiet window must last to recharge energy (ms). */
const QUIET_WINDOW_MS = 15 * 60_000;

const DEFAULT_MOOD: BotMood = { energy: 0.7, engagement: 0.5, patience: 0.8, humor: 0.5 };

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

    if (this.mood.energy < 0.3) parts.push('low energy, keep it brief');
    else if (this.mood.energy > 0.7) parts.push('feeling energetic');

    if (this.mood.engagement < 0.3) parts.push('not very engaged');
    else if (this.mood.engagement > 0.7) parts.push('feeling social');

    if (this.mood.patience < 0.3) parts.push('getting impatient');

    if (this.mood.humor > 0.7) parts.push('in a funny mood');
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
    const humorBoost = this.mood.humor > 0.7 ? 1.1 : 1.0;
    return clamp(energyFactor * humorBoost, 0.5, 1.5);
  }

  /** Apply time-based mood drift since last update. */
  private applyTimeDrift(): void {
    const now = this.now();
    const elapsed = now - this.lastUpdate;
    if (elapsed < 1_000) return; // Skip sub-second updates
    this.lastUpdate = now;

    const hours = elapsed / 3_600_000;

    // Energy decays over time
    this.mood.energy = clamp(this.mood.energy - RATES.energyDecayPerHour * hours);

    // Energy recharges during quiet periods
    const quietMs = now - this.lastInteraction;
    if (quietMs >= QUIET_WINDOW_MS) {
      const quietWindows = Math.floor(quietMs / QUIET_WINDOW_MS);
      const recharge = Math.min(quietWindows, 3) * RATES.energyRechargePerQuietWindow;
      this.mood.energy = clamp(this.mood.energy + recharge);
    }

    // Engagement decays over time
    this.mood.engagement = clamp(this.mood.engagement - RATES.engagementDecayPerHour * hours);

    // Patience recharges over time
    this.mood.patience = clamp(this.mood.patience + RATES.patienceRechargePerHour * hours);

    // Humor drifts randomly
    const drift = (Math.random() - 0.5) * 2 * RATES.humorDriftPerHour * hours;
    this.mood.humor = clamp(this.mood.humor + drift);
  }
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}
