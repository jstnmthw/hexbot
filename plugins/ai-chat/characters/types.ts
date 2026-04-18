// Character definition for the ai-chat plugin.
// A character is a channel regular, not an AI agent. The structured fields
// control runtime behaviour (speech formatting, when to speak); the persona
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
    /** Dash-bullet style notes rendered under the Persona section of the
     *  system prompt (e.g. "responses are 1-3 lines max"). */
    notes: string[];
  };

  chattiness: number; // 0-1: how often they speak unprompted
  triggers: string[]; // topics that make them chime in
  avoids: string[]; // topics rendered as "You avoid topics like: …" under Persona

  /** Persona body — the "who you are" template with {nick}/{channel}/{network}
   *  placeholders. No Rules block — security rules are appended by the assistant. */
  persona: string;

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

/** Raw JSON shape before validation — all fields optional for lenient parsing.
 *  `style` is omitted from the top-level Partial and re-added as a deep-Partial
 *  so authors can supply any subset of style fields without TS demanding the
 *  whole object. */
export type CharacterJson = Omit<Partial<Character>, 'style'> & {
  style?: Partial<Character['style']>;
};
