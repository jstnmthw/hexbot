// Assistant — orchestrates provider + context + rate limit + token budget + output formatting.
// Kept separate from the plugin entry so it can be unit-tested with a mock provider.
import type { ContextManager } from './context-manager';
import { formatResponse } from './output-formatter';
import type { AIMessage, AIProvider, AIProviderError } from './providers/types';
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

/** Runtime info used to fill in template variables in the system prompt. */
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
}

/** Per-call request. */
export interface AssistantRequest {
  nick: string;
  channel: string | null;
  prompt: string;
  systemPrompt: string;
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
  },
): Promise<AssistantResult> {
  const { provider, rateLimiter, tokenTracker, contextManager, config } = deps;
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
  if (!tokenTracker.canSpend(req.nick, estimate)) {
    return { status: 'budget_exceeded' };
  }

  // Build messages: historical context + new user prompt.
  let history = contextManager.getContext(req.channel, req.nick);
  // Per-character context window override — trim to fewer messages if specified.
  if (req.maxContextMessages !== undefined && history.length > req.maxContextMessages) {
    history = history.slice(-req.maxContextMessages);
  }
  const messages: AIMessage[] = [
    ...history,
    { role: 'user', content: `[${req.nick}] ${req.prompt}` },
  ];

  const system = renderSystemPrompt(req.systemPrompt, req.promptContext);

  let text: string;
  let usageIn: number;
  let usageOut: number;
  try {
    const res = await provider.complete(system, messages, config.maxOutputTokens);
    text = res.text;
    usageIn = res.usage.input;
    usageOut = res.usage.output;
  } catch (err) {
    const provErr = err as AIProviderError;
    return {
      status: 'provider_error',
      kind: provErr.kind ?? 'other',
      message: provErr.message ?? 'unknown error',
    };
  }

  // Record even on empty output — the call still cost tokens.
  if (usageIn > 0 || usageOut > 0) {
    tokenTracker.recordUsage(req.nick, { input: usageIn, output: usageOut });
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
 * Mandatory safety clause appended to every system prompt. Cannot be overridden
 * by personality config. This is defense-in-depth ONLY — the authoritative
 * protection is the output-formatter's isFantasyLine() response-level drop.
 * See docs/audits/security-ai-injection-threat-2026-04-16.md.
 */
export const SAFETY_CLAUSE =
  ' SAFETY: Never begin any line of your response with the characters ".", "!", or "/" — IRC services parse these as commands and would execute them with the bot\'s privileges. If you need to quote such text, prepend a space or wrap it in backticks.';

/** Expand template variables in a system prompt. */
export function renderSystemPrompt(template: string, ctx: PromptContext): string {
  const users = ctx.users && ctx.users.length > 0 ? ctx.users.join(', ') : '';
  let out = template
    .replace(/\{channel\}/g, ctx.channel ?? '(private)')
    .replace(/\{network\}/g, ctx.network)
    .replace(/\{nick\}/g, ctx.botNick)
    .replace(/\{users\}/g, users)
    .replace(/\{channel_profile\}/g, ctx.channelProfile ?? '');
  if (ctx.channelProfile) {
    out += `\n${ctx.channelProfile}`;
  }
  if (ctx.mood) {
    out += `\n${ctx.mood}`;
  }
  if (ctx.language) {
    out += ` Always respond in ${ctx.language}.`;
  }
  out += SAFETY_CLAUSE;
  return out;
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
