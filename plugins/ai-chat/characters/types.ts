// Character definition for the ai-chat plugin.
// A character is a channel regular, not an AI agent. The structured fields
// control runtime behaviour (speech formatting, when to speak); the prompt
// carries the actual personality.

/** A loaded character definition. */
export interface Character {
  name: string;
  archetype: string;
  backstory: string;

  style: {
    casing: 'normal' | 'lowercase' | 'uppercase';
    punctuation: 'proper' | 'minimal' | 'excessive';
    slang: string[];
    catchphrases: string[];
    verbosity: 'terse' | 'normal' | 'verbose';
  };

  chattiness: number; // 0-1: how often they speak unprompted
  triggers: string[]; // topics that make them chime in
  avoids: string[]; // topics they ignore or deflect

  prompt: string; // system prompt template (Rules format)

  /** Per-character generation overrides. All optional — falls back to
   *  global plugin config. */
  generation?: {
    provider?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    repeatPenalty?: number;
    maxOutputTokens?: number;
    maxContextMessages?: number;
  };
}

/** Raw JSON shape before validation — all fields optional for lenient parsing. */
export type CharacterJson = Partial<Character> & {
  style?: Partial<Character['style']>;
};
