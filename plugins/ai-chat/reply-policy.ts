// Unified reply policy for the ai-chat plugin.
//
// `decideReply` is the single place that decides what to do with a non-bot,
// permission-allowed channel message. It collapses what used to be three
// overlapping paths (direct-address / engagement-timer / random-chance) into
// four tiers with a clear order of precedence:
//
//   1. 'address'  — direct address, bot-nick mention, or a configured keyword.
//   2. 'engaged'  — bot and user are still trading turns (EngagementTracker).
//   3. 'rolled'   — probabilistic unprompted reply, gated by ambient budget.
//   4. 'skip'     — no reason to reply.
//
// Keeping this pure (no PluginAPI, no timers, no side effects) lets tests
// pin behaviour down a roll at a time.
import type { ActivityLevel } from './social-tracker';
import type { TriggerMatch } from './triggers';

/** Outcome of the reply-policy decision. */
export type ReplyDecision = 'address' | 'engaged' | 'rolled' | 'skip';

/**
 * Snapshot of the social-tracker state the policy needs. Passing a plain
 * object keeps the policy pure and makes fakes trivial in tests.
 */
export interface SocialSnapshot {
  activity: ActivityLevel;
  lastWasBot: boolean;
  /**
   * `true` when the speaker has recently interacted with the bot (within the
   * recency window, typically 15 min). Used for the recency boost on rolled
   * replies. Callers compute this from `SocialTracker.getUserInteraction`.
   */
  recentBotInteraction: boolean;
}

/** Inputs to `decideReply`. */
export interface ReplyPolicyInput {
  text: string;
  trigger: TriggerMatch | null;
  engaged: boolean;
  social: SocialSnapshot;
  /** Active character's chattiness trait (0-1). Multiplicative on the roll. */
  characterChattiness: number;
  /** Config `triggers.random_chance`. 0 disables the rolled path entirely. */
  randomChance: number;
  /** RNG injected for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Matches the `startsWithCommandSigil` heuristic already used in `pubm`.
 * Replies never fire for messages that look like commands to another plugin
 * or services — `!help foo`, `.deop bar`, `/quit`, etc. Direct address
 * (`neo: ...`) is a separate earlier-tier check so it still fires normally.
 */
const COMMAND_SIGIL_RE = /^[!./~@%$&+]/;
export function startsWithCommandSigil(text: string): boolean {
  return COMMAND_SIGIL_RE.test(text.trim());
}

/**
 * Activity scaling for the rolled-reply probability. Mirrors the ambient
 * engine's "don't pile on during floods, perk up during lulls" posture:
 *
 *   - dead / slow   — 1.0× (the bot's voice is welcome, not noise).
 *   - normal        — 1.0× baseline.
 *   - active        — 0.5× (plenty of humans talking, be sparser).
 *   - flooding      — 0 (never roll-reply — the existing ambient engine
 *                     also suppresses itself here).
 */
export function activityScale(activity: ActivityLevel): number {
  switch (activity) {
    case 'dead':
    case 'slow':
      return 1.0;
    case 'normal':
      return 1.0;
    case 'active':
      return 0.5;
    case 'flooding':
      return 0;
  }
}

/** Recency boost: 1.5× if the user has been interacting with the bot recently. */
export function recencyBoost(recent: boolean): number {
  return recent ? 1.5 : 1.0;
}

/**
 * Compute the probability of a rolled reply for this message given the
 * current social state. Returns 0 to suppress the roll entirely.
 */
export function rolledProbability(input: {
  text: string;
  social: SocialSnapshot;
  randomChance: number;
  characterChattiness: number;
}): number {
  if (input.randomChance <= 0) return 0;
  if (input.social.lastWasBot) return 0; // back-to-back guard
  if (startsWithCommandSigil(input.text)) return 0;
  const scale = activityScale(input.social.activity);
  if (scale === 0) return 0;
  const boost = recencyBoost(input.social.recentBotInteraction);
  const p = input.randomChance * input.characterChattiness * scale * boost;
  return Math.max(0, Math.min(1, p));
}

/**
 * The unified reply decision. Pure function — same inputs always produce
 * the same decision. Callers in the pubm handler map each decision to a
 * downstream branch (pipeline + rate-limit path).
 */
export function decideReply(input: ReplyPolicyInput): ReplyDecision {
  if (input.trigger) return 'address';
  if (input.engaged) {
    // Even engaged replies honour the command-sigil guard — an engaged user
    // typing `!help` is talking to another plugin, not continuing the thread.
    if (startsWithCommandSigil(input.text)) return 'skip';
    return 'engaged';
  }
  const p = rolledProbability({
    text: input.text,
    social: input.social,
    randomChance: input.randomChance,
    characterChattiness: input.characterChattiness,
  });
  if (p <= 0) return 'skip';
  const rng = input.rng ?? Math.random;
  return rng() < p ? 'rolled' : 'skip';
}
