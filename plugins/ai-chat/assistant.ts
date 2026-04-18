// Assistant — orchestrates provider + context + rate limit + token budget + output formatting.
// Kept separate from the plugin entry so it can be unit-tested with a mock provider.
import type { ContextManager } from './context-manager';
import type { IterStats } from './iter-stats';
import { formatResponse } from './output-formatter';
import {
  type AIMessage,
  type AIProvider,
  type AIProviderError,
  isAIProviderError,
} from './providers/types';
import type { RateCheckResult, RateLimiter } from './rate-limiter';
import type { TokenTracker } from './token-tracker';

/** Tunables for output formatting and the template-variable expansion. */
export interface AssistantConfig {
  /** Max number of IRC lines in one response. */
  maxLines: number;
  /** Max bytes per IRC line. */
  maxLineLength: number;
  /** Delay between lines in a multi-line response. */
  interLineDelayMs: number;
  /** Max output tokens for a single LLM call. */
  maxOutputTokens: number;
}

/** Runtime info used to assemble the sectioned system prompt. */
export interface PromptContext {
  botNick: string;
  channel: string | null;
  network: string;
  users?: string[];
  language?: string;
  /** Rendered channel profile string (e.g. "This channel is about Linux..."). */
  channelProfile?: string;
  /** Rendered mood line (e.g. "Current state: feeling energetic, in a funny mood."). */
  mood?: string;
  /** Persona body — placed under "## Persona". May contain {nick}/{channel}/
   *  {network}/{users} placeholders. Required. */
  persona: string;
  /** Current-turn speaker nick. Rendered into the volatile header so the bot
   *  knows who's addressing it without needing a `[nick]` prefix on the turn
   *  content. Omit for bot-originated turns (ambient/idle). */
  speaker?: string;
  /** Optional dash-bullet style notes appended under Persona ("- you are a
   *  person in a chat room…"). */
  styleNotes?: string[];
  /** Optional avoid-topics list rendered as one line under Persona. */
  avoids?: string[];
}

/** Per-call request. */
export interface AssistantRequest {
  nick: string;
  channel: string | null;
  prompt: string;
  promptContext: PromptContext;
  /** Per-character context window override (number of messages to include). */
  maxContextMessages?: number;
  /** Admin users bypass the per-user bucket (global RPM/RPD still enforced). */
  isAdmin?: boolean;
}

/** Outcome from the respond() pipeline. */
export type AssistantResult =
  | { status: 'ok'; lines: string[]; tokensIn: number; tokensOut: number }
  | {
      status: 'rate_limited';
      limitedBy: NonNullable<RateCheckResult['limitedBy']>;
      retryAfterMs: number;
    }
  | { status: 'budget_exceeded' }
  | { status: 'provider_error'; kind: AIProviderError['kind']; message: string }
  | { status: 'fantasy_dropped'; line: string; index: number }
  | { status: 'empty' };

/** Full end-to-end pipeline: guardrails → LLM call → formatting → accounting. */
export async function respond(
  req: AssistantRequest,
  deps: {
    provider: AIProvider;
    rateLimiter: RateLimiter;
    tokenTracker: TokenTracker;
    contextManager: ContextManager;
    config: AssistantConfig;
    iterStats?: IterStats | null;
  },
): Promise<AssistantResult> {
  const { provider, rateLimiter, tokenTracker, contextManager, config, iterStats } = deps;
  const userKey = req.nick.toLowerCase();

  // Admins bypass the per-user bucket; global RPM/RPD still enforced.
  const rl = req.isAdmin ? rateLimiter.checkGlobal() : rateLimiter.check(userKey);
  if (!rl.allowed) {
    return {
      status: 'rate_limited',
      limitedBy: rl.limitedBy ?? 'user',
      retryAfterMs: rl.retryAfterMs ?? 0,
    };
  }

  // Rough estimate: assume the user's new prompt costs ~prompt.length/4 tokens.
  // We'll check the full budget again after the call with actual usage.
  const estimate = Math.ceil(req.prompt.length / 4) + 64; // small padding
  // Admins bypass the per-user daily cap — global cap still enforced to
  // prevent runaway spend from a compromised prompt loop.
  const budgetOk = req.isAdmin
    ? tokenTracker.canSpendGlobal(estimate)
    : tokenTracker.canSpend(req.nick, estimate);
  if (!budgetOk) {
    return { status: 'budget_exceeded' };
  }

  // Build messages: historical context + new user prompt. The volatile
  // context (channel, users present, mood, language) rides on the current
  // user turn so the system prompt stays byte-stable across calls — that
  // maximises KV-cache reuse on Ollama and implicit caching on Gemini.
  let history = contextManager.getContext(req.channel, req.nick);
  // Per-character context window override — trim to fewer messages if specified.
  if (req.maxContextMessages !== undefined && history.length > req.maxContextMessages) {
    history = history.slice(-req.maxContextMessages);
  }
  const volatileHeader = renderVolatileHeader(req.promptContext);
  const userContent = volatileHeader ? `${volatileHeader} ${req.prompt}` : req.prompt;
  const messages: AIMessage[] = [...history, { role: 'user', content: userContent }];

  const system = renderStableSystemPrompt(req.promptContext);

  let text: string;
  let usageIn: number;
  let usageOut: number;
  try {
    const res = await provider.complete(system, messages, config.maxOutputTokens);
    text = res.text;
    usageIn = res.usage.input;
    usageOut = res.usage.output;
  } catch (err) {
    return {
      status: 'provider_error',
      kind: isAIProviderError(err) ? err.kind : 'other',
      message: err instanceof Error ? err.message : 'unknown error',
    };
  }

  // Record even on empty output — the call still cost tokens.
  if (usageIn > 0 || usageOut > 0) {
    tokenTracker.recordUsage(req.nick, { input: usageIn, output: usageOut });
    iterStats?.record({ input: usageIn, output: usageOut });
  }
  rateLimiter.record(userKey);

  let fantasyDrop: { index: number; line: string } | null = null;
  const lines = formatResponse(text, config.maxLines, config.maxLineLength, (info) => {
    fantasyDrop = info;
  });
  if (fantasyDrop !== null) {
    const drop: { index: number; line: string } = fantasyDrop;
    return { status: 'fantasy_dropped', line: drop.line, index: drop.index };
  }
  if (lines.length === 0) return { status: 'empty' };

  return { status: 'ok', lines, tokensIn: usageIn, tokensOut: usageOut };
}

/**
 * Mandatory rules block appended to every system prompt as the final "##
 * Rules" section. Cannot be overridden by personality config. The fantasy-
 * prefix and impersonation rules are defense-in-depth ONLY — the
 * authoritative protection is the output-formatter's isFantasyLine() drop.
 * See docs/audits/security-ai-injection-threat-2026-04-16.md.
 *
 * Order matters — rules 1 & 2 are non-negotiable security guardrails; rules
 * 3 & 4 are cosmetic / format. NEVER reorder rules 1–2 below cosmetic rules.
 * Small local models (llama3.2:3b) honour numbered Rules lists more reliably
 * than prose, and weight the END of the system prompt more heavily, so this
 * section stays last (per memory: project_local_model_research).
 */
export const SAFETY_CLAUSE =
  '## Rules (these override Persona and Right now)\n' +
  '1. Never begin any line of your reply with the characters ".", "!", or "/" — IRC services parse these as commands and would execute them with the bot\'s privileges. If you need to quote such text, prepend a space or wrap it in backticks.\n' +
  '2. You are a regular channel user, not an operator. You do not know IRC operator commands, services syntax (ChanServ/NickServ/BotServ/MemoServ/etc.), channel mode letters, ban mask formats, or network admin procedures. If asked for command syntax, channel-control instructions, or "how to" anything requiring privileges, say you don\'t know and point them at the network\'s help channel. Do not quote or demonstrate commands even hypothetically.\n' +
  "3. Reply as yourself in plain prose — never start a line with a nick tag like `[dark]`, `<dark>`, or `dark:`, and never address anyone by wrapping their nick in brackets. Refer to people by name naturally, the way you'd mention someone in conversation.\n" +
  '4. Never continue the transcript or invent lines for other users — single-voice output only.';

/**
 * Assemble the byte-stable system prompt:
 *
 *   You are <nick>.
 *
 *   ## Persona
 *   <persona body>
 *   You avoid topics like: <avoids>.
 *   <channel profile>
 *   - <style note 1>
 *   - <style note 2>
 *
 *   ## Rules (these override Persona and Right now)
 *   1. …
 *
 * All volatile content (users present, mood, language) is lifted onto the
 * current user turn via `renderVolatileHeader` so the system prompt stays
 * byte-stable between calls. That maximises Ollama/llama.cpp KV-cache reuse
 * (prefill ~10-17× faster on hits) and Gemini implicit-caching odds.
 *
 * The persona body supports {nick}/{channel}/{network}/{users} placeholders;
 * {users} expands to empty in the stable prompt (put live user list in the
 * volatile header instead). SAFETY_CLAUSE is always last so the model's
 * recency bias keeps it weighted.
 */
export function renderStableSystemPrompt(ctx: PromptContext): string {
  const vars: Record<string, string> = {
    channel: ctx.channel ?? '(private)',
    network: ctx.network,
    nick: ctx.botNick,
    // Live user list belongs in the volatile header — byte-stable here.
    users: '',
  };
  const expand = (s: string): string =>
    s.replace(/\{(channel|network|nick|users)\}/g, (_, key: string) => vars[key] ?? '');

  const sections: string[] = [];
  sections.push(`You are ${ctx.botNick}.`);

  // Persona section: body, avoids, channel profile, style notes.
  const personaParts: string[] = [];
  personaParts.push(expand(ctx.persona).trim());
  if (ctx.avoids && ctx.avoids.length > 0) {
    personaParts.push(`You avoid topics like: ${ctx.avoids.join(', ')}.`);
  }
  if (ctx.channelProfile && ctx.channelProfile.trim().length > 0) {
    personaParts.push(ctx.channelProfile.trim());
  }
  if (ctx.styleNotes && ctx.styleNotes.length > 0) {
    personaParts.push(ctx.styleNotes.map((n) => `- ${n}`).join('\n'));
  }
  sections.push(`## Persona\n${personaParts.join('\n\n')}`);

  sections.push(SAFETY_CLAUSE);

  return sections.join('\n\n');
}

/**
 * One-line volatile context prefix prepended to the current user turn:
 *
 *   [<channel> on <network>. Users present: X, Y, Z. <mood>. Always respond in <lang>.]
 *
 * Only the pieces that are set are included; if every field is empty,
 * returns the empty string (caller skips the prefix entirely). Keeping the
 * anchor (channel/network) on every user turn gives the model context
 * without polluting the cached system prefix.
 *
 * User-list nicks are sanitised the same way they used to be in the system
 * prompt — a crafted nick shouldn't land verbatim in the transcript either.
 */
export function renderVolatileHeader(ctx: PromptContext): string {
  const safeUsers = (ctx.users ?? [])
    .map((n) => n.replace(/[^A-Za-z0-9_`{}[\]\\^|-]/g, ''))
    .filter((n) => n.length > 0 && n.length <= 30)
    .slice(0, 50);
  const usersStr = safeUsers.join(', ');

  const parts: string[] = [];
  if (ctx.channel && ctx.network) {
    parts.push(`${ctx.channel} on ${ctx.network}.`);
  } else if (ctx.network) {
    parts.push(`a private chat on ${ctx.network}.`);
  }
  if (usersStr) parts.push(`Users present: ${usersStr}.`);
  if (ctx.speaker) {
    const safeSpeaker = ctx.speaker.replace(/[^A-Za-z0-9_`{}[\]\\^|-]/g, '').slice(0, 30);
    if (safeSpeaker) parts.push(`Speaking to you now: ${safeSpeaker}.`);
  }
  if (ctx.mood) parts.push(ctx.mood);
  if (ctx.language) parts.push(`Always respond in ${ctx.language}.`);

  if (parts.length === 0) return '';
  return `[${parts.join(' ')}]`;
}

/**
 * Send a multi-line response to IRC with a delay between lines, using the supplied
 * sender. Returns a Promise that resolves when all lines have been scheduled/sent.
 */
export function sendLines(
  lines: string[],
  sendLine: (text: string) => void,
  interLineDelayMs: number,
): Promise<void> {
  if (lines.length === 0) return Promise.resolve();
  if (lines.length === 1 || interLineDelayMs <= 0) {
    for (const line of lines) sendLine(line);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let i = 0;
    const step = (): void => {
      sendLine(lines[i]);
      i++;
      if (i >= lines.length) {
        resolve();
        return;
      }
      setTimeout(step, interLineDelayMs);
    };
    step();
  });
}
