// Trigger detection for the AI chat plugin.
// Pure functions — no plugin API access. Safe to unit-test in isolation.

/** Configured trigger policy. */
export interface TriggerConfig {
  directAddress: boolean;
  command: boolean;
  commandPrefix: string;
  keywords: string[];
  randomChance: number;
}

/** The kind of trigger that matched, plus the user's actual question/text. */
export interface TriggerMatch {
  kind: 'direct' | 'command' | 'keyword' | 'random';
  /** The user's message with trigger prefix (nick/command) stripped. */
  prompt: string;
}

/** Heuristic bot-nick patterns from config — list of lowercase glob-like strings. */
export function isLikelyBot(nick: string, patterns: string[], ignoreBots: boolean): boolean {
  if (!ignoreBots) return false;
  const lower = nick.toLowerCase();
  for (const pat of patterns) {
    const p = pat.toLowerCase();
    if (p.startsWith('*') && p.endsWith('*')) {
      if (lower.includes(p.slice(1, -1))) return true;
    } else if (p.startsWith('*')) {
      if (lower.endsWith(p.slice(1))) return true;
    } else if (p.endsWith('*')) {
      if (lower.startsWith(p.slice(0, -1))) return true;
    } else if (lower === p) {
      return true;
    }
  }
  return false;
}

/** True if the nick or hostmask matches any entry in the ignore list. */
export function isIgnored(nick: string, hostmask: string, ignoreList: string[]): boolean {
  const nlow = nick.toLowerCase();
  const hlow = hostmask.toLowerCase();
  for (const entry of ignoreList) {
    const e = entry.toLowerCase();
    if (e === nlow) return true;
    if (hostmaskMatches(hlow, e)) return true;
  }
  return false;
}

/** Minimal glob matching for hostmasks — supports `*` and `?`. */
function hostmaskMatches(hostmask: string, pattern: string): boolean {
  // Fast path: no wildcards
  if (!pattern.includes('*') && !pattern.includes('?')) return hostmask === pattern;
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return regex.test(hostmask);
}

/**
 * Detect whether a channel message should trigger a response.
 *
 * @param text     — raw message text
 * @param botNick  — bot's current nick
 * @param config   — active trigger config
 * @param rng      — random source for randomChance (0..1)
 */
export function detectTrigger(
  text: string,
  botNick: string,
  config: TriggerConfig,
  rng: () => number = Math.random,
): TriggerMatch | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Command trigger: e.g. "!ai what's up"
  if (config.command && config.commandPrefix) {
    const prefix = config.commandPrefix.toLowerCase();
    const lower = trimmed.toLowerCase();
    if (lower === prefix) return { kind: 'command', prompt: '' };
    if (lower.startsWith(prefix + ' ')) {
      return { kind: 'command', prompt: trimmed.substring(config.commandPrefix.length).trim() };
    }
  }

  // Direct address: "hexbot: …" / "hexbot, …" / "hexbot …"
  if (config.directAddress) {
    const nickLow = botNick.toLowerCase();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith(nickLow)) {
      const rest = trimmed.substring(botNick.length);
      const firstChar = rest.charAt(0);
      if (firstChar === ':' || firstChar === ',' || firstChar === ' ' || rest === '') {
        const prompt = rest.replace(/^[:,\s]+/, '').trim();
        if (prompt) return { kind: 'direct', prompt };
      }
    }
    // "… hexbot?" / "… hexbot!" style
    const questionRe = new RegExp(`\\b${escapeRe(nickLow)}[?!]`, 'i');
    if (questionRe.test(lower)) {
      return { kind: 'direct', prompt: trimmed };
    }
  }

  // Keyword trigger: any configured substring match (case-insensitive)
  if (config.keywords.length > 0) {
    const lower = trimmed.toLowerCase();
    for (const kw of config.keywords) {
      if (kw && lower.includes(kw.toLowerCase())) {
        return { kind: 'keyword', prompt: trimmed };
      }
    }
  }

  // Random interjection
  if (config.randomChance > 0 && rng() < config.randomChance) {
    return { kind: 'random', prompt: trimmed };
  }

  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
