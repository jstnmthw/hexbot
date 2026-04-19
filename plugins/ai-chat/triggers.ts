// Trigger detection for the AI chat plugin.
// Pure functions — no plugin API access. Safe to unit-test in isolation.
//
// Scope note: `detectTrigger` is only concerned with "does the text contain a
// direct signal that the bot is being addressed?" It does NOT decide whether
// to reply — that's `decideReply` in `reply-policy.ts`. In particular, this
// module no longer handles:
//
//   - `!ai <freeform>` freeform command (removed in 0.5.0 — `!ai` is a
//     subcommand console, see `handleSubcommand`).
//   - Random-chance rolls (moved to `reply-policy.ts`, gated by activity /
//     recency / back-to-back guard).
//   - Engagement fallback (moved to `EngagementTracker` + `decideReply`).

/** Configured trigger policy. */
export interface TriggerConfig {
  directAddress: boolean;
  /**
   * Subcommand console prefix (e.g. `!ai`). Retained so `handleSubcommand`
   * can bind to it; `detectTrigger` itself ignores the prefix now.
   */
  commandPrefix: string;
  keywords: string[];
  randomChance: number;
}

/** The kind of trigger that matched, plus the user's actual question/text. */
export interface TriggerMatch {
  kind: 'direct' | 'keyword';
  /** The user's message with trigger prefix (nick) stripped. */
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

/**
 * Minimal glob matching for hostmasks — supports `*` (any run) and `?`
 * (one char). Standalone implementation rather than reusing `src/utils/wildcard`
 * to keep this module pure and dependency-free for unit testing.
 */
function hostmaskMatches(hostmask: string, pattern: string): boolean {
  // Fast path: no wildcards
  if (!pattern.includes('*') && !pattern.includes('?')) return hostmask === pattern;
  // Escape regex metacharacters first, THEN substitute glob `*` / `?` —
  // doing it in the other order would let `pattern.replace(/\*/g, '.*')`
  // get clobbered by the metachar escape that follows.
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
 * Detect whether a channel message contains an explicit trigger (direct
 * address by nick, or keyword hit). Returns null if no trigger matched —
 * the caller decides whether to reply anyway (engagement / rolled path).
 *
 * @param text     — raw message text
 * @param botNick  — bot's current nick
 * @param config   — active trigger config
 */
export function detectTrigger(
  text: string,
  botNick: string,
  config: TriggerConfig,
): TriggerMatch | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Direct address: bot nick appears as a whole word anywhere in the message.
  // `\b<nick>\b` covers every shape that actually addresses the bot in practice
  // — "neo: hi", "neo hi", "hey neo?", "Welcome neo", "Wake up, neo.",
  // "what neo thinks about X" — without having to enumerate punctuation
  // variants. The word-boundary prevents false positives on "hexbotter"
  // or "neonatal". Occasional false positives ("neo-classical") are
  // absorbed by the reply-policy rate/back-to-back guards downstream.
  if (config.directAddress) {
    const nickRe = new RegExp(`\\b${escapeRe(botNick)}\\b`, 'i');
    const m = nickRe.exec(trimmed);
    if (m) {
      // Nick at start followed by a separator — strip it so the prompt is
      // the user's actual question (e.g. "neo: what's up" → "what's up").
      // Any other shape: hand the full text to the LLM so it has context.
      if (m.index === 0) {
        const rest = trimmed.substring(botNick.length);
        if (rest === '') return null;
        if (/^[:,\s]/.test(rest)) {
          const prompt = rest.replace(/^[:,\s]+/, '').trim();
          return prompt ? { kind: 'direct', prompt } : null;
        }
      }
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

  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
