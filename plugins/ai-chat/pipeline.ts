// ai-chat — response and session pipelines.
//
// Extracted from index.ts so the plugin entry stays focused on wiring +
// event handlers. The two pipelines both:
//   1. Gate on the (non-module) rate-limiter / token budget
//   2. Build a PromptContext from the active character + channel profile
//   3. Call into assistant.respond() / provider.complete()
//   4. Format / style the lines, then send with the per-line post-gate.
//
// Module-scope state in the plugin is threaded in via PipelineDeps — the
// single bundle lets callers construct it once in init() and reuse it for
// every pubm dispatch without re-plumbing 8+ individual refs.
import type { HandlerContext, PluginAPI } from '../../src/types';
import {
  type AssistantConfig,
  type PromptContext,
  renderStableSystemPrompt,
  renderVolatileHeader,
  respond,
} from './assistant';
import type { Character } from './characters/types';
import type { AiChatConfig } from './config';
import type { ContextManager } from './context-manager';
import type { EngagementTracker } from './engagement-tracker';
import type { IterStats } from './iter-stats';
import type { MoodEngine } from './mood';
import { applyCharacterStyle, formatResponse } from './output-formatter';
import { isFounderPostGate, postGateFor } from './permission-gates';
import { type AIMessage, type AIProvider, isAIProviderError } from './providers/types';
import type { RateLimiter } from './rate-limiter';
import type { ReplyDecision } from './reply-policy';
import { sendLinesGated } from './sender';
import { type SessionIdentity, type SessionManager } from './session-manager';
import type { SocialTracker } from './social-tracker';
import type { TokenTracker } from './token-tracker';

/**
 * Module-scope state threaded into the pipeline functions. Every field is
 * nullable to mirror the init/teardown lifecycle in index.ts — the pipeline
 * short-circuits when any required piece is missing rather than throwing.
 *
 * `activeCharacter` is passed as a callback instead of the raw character
 * map because it reaches into `state.characters` (owned by index.ts) and
 * the DB for per-channel overrides; keeping it behind a thunk avoids
 * giving pipeline.ts a direct handle to the plugin's `state` object.
 */
export interface PipelineDeps {
  provider: AIProvider | null;
  rateLimiter: RateLimiter | null;
  tokenTracker: TokenTracker | null;
  contextManager: ContextManager | null;
  iterStats: IterStats | null;
  moodEngine: MoodEngine | null;
  engagementTracker: EngagementTracker | null;
  socialTracker: SocialTracker | null;
  sessionManager: SessionManager | null;
  /** Resolve the active character + language for a channel (may read DB). */
  activeCharacter: (channel: string | null) => {
    character: Character;
    language: string | undefined;
  };
  /** Build a SessionIdentity from a handler context for session gating. */
  makeSessionIdentity: (ctx: HandlerContext) => SessionIdentity;
  /** Notice ops when the provider is rate-limited (debounced per channel). */
  noticeOpsRateLimited: (channel: string | null, detail: string) => void;
}

/** Render a channel profile string for prompt injection, or undefined if none configured. */
export function renderChannelProfile(
  cfg: AiChatConfig,
  channel: string | null,
): string | undefined {
  if (!channel) return undefined;
  const profile = cfg.channelProfiles[channel] ?? cfg.channelProfiles[channel.toLowerCase()];
  if (!profile) return undefined;
  const parts: string[] = [];
  if (profile.topic) parts.push(`This channel is about ${profile.topic}.`);
  if (profile.culture) parts.push(`The culture here is ${profile.culture}.`);
  if (profile.role) parts.push(`Your role is ${profile.role}.`);
  if (profile.depth) parts.push(`Answer with ${profile.depth} depth.`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Recency window for the rolled-reply boost — 15 minutes. */
const RECENT_BOT_INTERACTION_MS = 15 * 60_000;

export function hasRecentBotInteraction(tracker: SocialTracker | null, nick: string): boolean {
  if (!tracker) return false;
  const stats = tracker.getUserInteraction(nick);
  if (!stats || stats.botInteractions === 0) return false;
  return Date.now() - stats.lastBotInteraction < RECENT_BOT_INTERACTION_MS;
}

/**
 * Full response pipeline: gate on rate-limit / budget, call the LLM via
 * `respond()`, then format + send lines through the post-gated sender.
 *
 * `source` drives branching on rate-limit notices (rolled replies stay
 * silent; address/engaged get private feedback) and on the ambient budget
 * (rolled replies count as ambient utterances).
 */
export async function runPipeline(
  api: PluginAPI,
  cfg: AiChatConfig,
  deps: PipelineDeps,
  ctx: HandlerContext,
  prompt: string,
  botNick: string,
  network: string,
  source: ReplyDecision,
  isAdmin = false,
): Promise<void> {
  const {
    provider,
    rateLimiter,
    tokenTracker,
    contextManager,
    iterStats,
    moodEngine,
    engagementTracker,
    socialTracker,
    activeCharacter,
    noticeOpsRateLimited,
  } = deps;
  if (!rateLimiter || !tokenTracker || !contextManager) return;
  // Rolled replies count against the ambient budget — a random-chance reply
  // is an unprompted utterance, same class as idle / unanswered-question
  // ambient. Address/engaged replies are direct responses and keep the
  // per-user bucket pathway (inside respond()).
  if (source === 'rolled' && ctx.channel) {
    if (!rateLimiter.checkAmbient(ctx.channel)) {
      api.debug(
        `pipeline rolled-skip ch=${ctx.channel} nick=${ctx.nick} reason=ambient_budget_full`,
      );
      return;
    }
  }
  // Rolled replies are unprompted — stay quiet on user-bucket / budget
  // blocks so we don't spam noticeOps or reveal limiter state to the
  // channel. Address/engaged replies came from an explicit user action, so
  // they get the private rate-limit notice.
  const noticeOnBlock = source !== 'rolled';

  const { character, language } = activeCharacter(ctx.channel);

  api.debug(
    `pipeline enter ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
      `character=${character.name}${language ? `/${language}` : ''} ` +
      `provider=${provider?.name ?? 'none'} admin=${isAdmin} promptLen=${prompt.length}`,
  );

  // No provider? Degraded placeholder mode.
  if (!provider) {
    ctx.reply('AI chat is currently unavailable.');
    return;
  }

  // Apply per-character generation overrides
  const maxOutputTokens = character.generation?.maxOutputTokens ?? cfg.maxOutputTokens;

  // Apply mood verbosity multiplier to maxLines
  const moodMultiplier = moodEngine?.getVerbosityMultiplier() ?? 1;
  const effectiveMaxLines = Math.max(1, Math.round(cfg.output.maxLines * moodMultiplier));

  const assistantCfg: AssistantConfig = {
    maxLines: effectiveMaxLines,
    maxLineLength: cfg.output.maxLineLength,
    interLineDelayMs: cfg.output.interLineDelayMs,
    maxOutputTokens,
  };

  // Notify mood engine of the interaction
  moodEngine?.onInteraction();

  const promptCtx: PromptContext = {
    botNick,
    channel: ctx.channel,
    network,
    language,
    channelProfile: renderChannelProfile(cfg, ctx.channel),
    mood: moodEngine?.renderMoodLine(),
    persona: character.persona,
    styleNotes: character.style.notes,
    avoids: character.avoids,
    speaker: ctx.nick,
  };

  // Use per-character context window if specified
  const maxContextMessages = character.generation?.maxContextMessages;
  const result = await respond(
    {
      nick: ctx.nick,
      channel: ctx.channel,
      prompt,
      promptContext: promptCtx,
      maxContextMessages,
      isAdmin,
    },
    { provider, rateLimiter, tokenTracker, contextManager, config: assistantCfg, iterStats },
  );

  switch (result.status) {
    case 'rate_limited': {
      const secs = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      if (noticeOnBlock) {
        ctx.replyPrivate(`Rate limited (${result.limitedBy}) — try again in ${secs}s.`);
      }
      api.debug(
        `pipeline rate_limited ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
          `limitedBy=${result.limitedBy} retryAfterSec=${secs} notice=${noticeOnBlock}`,
      );
      return;
    }
    case 'budget_exceeded':
      if (noticeOnBlock) ctx.replyPrivate('Daily token budget exceeded — try again tomorrow.');
      api.debug(
        `pipeline budget_exceeded ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
          `notice=${noticeOnBlock}`,
      );
      return;
    case 'provider_error': {
      api.error(`provider error (${result.kind}): ${result.message}`);
      if (result.kind === 'safety') {
        ctx.reply("Sorry — I can't help with that.");
      } else if (result.kind === 'rate_limit') {
        // Stay silent in-channel — repeating "AI is temporarily unavailable"
        // on every triggered message during an outage is noisy and reveals
        // upstream state to the channel. Tell ops privately instead.
        noticeOpsRateLimited(ctx.channel, result.message);
      } else {
        ctx.reply('AI is temporarily unavailable.');
      }
      return;
    }
    case 'empty':
      api.debug('empty LLM response — nothing to send');
      return;
    case 'fantasy_dropped':
      api.warn(
        `dropped response containing fantasy-prefix line ${result.index}: ` +
          JSON.stringify(result.line.slice(0, 80)),
      );
      return;
    case 'ok': {
      if (isFounderPostGate(api, cfg, ctx.channel, 'pipeline')) return;
      // Apply character style (casing, verbosity enforcement) AFTER
      // formatResponse has normalized and fantasy-prefix-stripped the
      // lines. Order matters for security: running style (e.g. a casing
      // transform) before the fantasy-prefix filter could re-introduce
      // prefix characters that the filter just removed. See ai-chat
      // injection-defense scope note in the 2026-04-17 memory.
      const styled = applyCharacterStyle(result.lines, {
        casing: character.style.casing,
        verbosity: character.style.verbosity,
      });
      contextManager.addMessage(ctx.channel, botNick, styled.join(' '), true);
      // Record engagement so the user's next messages are treated as
      // continuations. Also record ambient budget tick for rolled replies.
      if (ctx.channel) {
        engagementTracker?.onBotReply(ctx.channel, ctx.nick);
        if (source === 'rolled') rateLimiter.recordAmbient(ctx.channel);
      }
      socialTracker?.recordBotInteraction(ctx.nick);
      api.log(
        `response sent channel=${ctx.channel ?? '(unknown)'} nick=${ctx.nick} ` +
          `character=${character.name} lines=${styled.length} in=${result.tokensIn} out=${result.tokensOut}`,
      );
      await sendLinesGated(
        styled,
        postGateFor(api, cfg, ctx.channel),
        'pipeline',
        (line) => ctx.reply(line),
        cfg.output.interLineDelayMs,
      );
      return;
    }
  }
}

/**
 * Session pipeline — route a message as a move inside an active game session.
 * Different from the regular pipeline:
 *   - bypasses the per-user token bucket (global RPM/RPD still applies),
 *   - uses the game's prompt as persona (no character style / mood),
 *   - uses `[nick] text` bracket-tag attribution (see the NOTE below).
 */
export async function runSessionPipeline(
  api: PluginAPI,
  cfg: AiChatConfig,
  deps: PipelineDeps,
  ctx: HandlerContext,
  text: string,
  botNickValue: string,
  networkName: string,
): Promise<void> {
  const {
    provider,
    rateLimiter,
    tokenTracker,
    sessionManager,
    iterStats,
    makeSessionIdentity,
    noticeOpsRateLimited,
  } = deps;
  if (!rateLimiter || !tokenTracker || !sessionManager || !provider) return;
  const session = sessionManager.getSession(ctx.nick, ctx.channel, makeSessionIdentity(ctx));
  if (!session) return;

  const userKey = ctx.nick.toLowerCase();
  const isAdmin = api.permissions.checkFlags(cfg.permissions.adminFlag, ctx);
  // Sessions bypass the per-user bucket — only enforce global RPM/RPD.
  const rl = rateLimiter.checkGlobal();
  if (!rl.allowed) {
    const secs = Math.max(1, Math.ceil((rl.retryAfterMs ?? 0) / 1000));
    ctx.replyPrivate(`Rate limited (${rl.limitedBy ?? 'rpm'}) — try again in ${secs}s.`);
    api.debug(
      `session rate_limited ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
        `limitedBy=${rl.limitedBy ?? 'rpm'} retryAfterSec=${secs}`,
    );
    return;
  }
  const estimate = Math.ceil(text.length / 4) + 64;
  // Admins bypass the per-user daily cap — global cap still enforced.
  const budgetOk = isAdmin
    ? tokenTracker.canSpendGlobal(estimate)
    : tokenTracker.canSpend(ctx.nick, estimate);
  if (!budgetOk) {
    ctx.replyPrivate('Daily token budget exceeded — try again tomorrow.');
    return;
  }

  // Game sessions use the game-defined prompt as the persona body. No style
  // notes / avoids / channel profile / mood — the game owns the framing.
  // Split stable/volatile the same way the regular pipeline does so sessions
  // get the same KV-cache benefits.
  const sessionPromptCtx: PromptContext = {
    botNick: botNickValue,
    channel: ctx.channel,
    network: networkName,
    persona: session.systemPrompt,
  };
  const systemPrompt = renderStableSystemPrompt(sessionPromptCtx);
  const volatileHeader = renderVolatileHeader(sessionPromptCtx);
  // NOTE: session path uses `[nick] text` bracket-tag attribution — this
  // intentionally differs from the regular chat path, which uses `nick: text`
  // for history and no nick prefix on the current turn (see
  // context-manager.ts and assistant.renderVolatileHeader). Game prompts
  // treat the player as a distinct entity ("the player said: …") and the
  // bracket tag makes that boundary obvious to the model even inside games
  // with multi-role transcripts (trivia host / contestant).
  const userMsg: AIMessage = {
    role: 'user',
    content: volatileHeader ? `${volatileHeader} [${ctx.nick}] ${text}` : `[${ctx.nick}] ${text}`,
  };

  try {
    const res = await provider.complete(
      systemPrompt,
      [...session.context, userMsg],
      cfg.maxOutputTokens,
    );
    tokenTracker.recordUsage(ctx.nick, res.usage);
    iterStats?.record(res.usage);
    rateLimiter.record(userKey);

    const lines = formatResponse(
      res.text,
      cfg.output.maxLines,
      cfg.output.maxLineLength,
      ({ index, line }) => {
        api.warn(
          `session: dropped response containing fantasy-prefix line ${index}: ` +
            JSON.stringify(line.slice(0, 80)),
        );
      },
    );
    if (lines.length === 0) return;

    sessionManager.addMessage(session, userMsg);
    sessionManager.addMessage(session, { role: 'assistant', content: lines.join(' ') });

    if (isFounderPostGate(api, cfg, ctx.channel, 'session')) return;
    await sendLinesGated(
      lines,
      postGateFor(api, cfg, ctx.channel),
      'session',
      (line) => ctx.reply(line),
      cfg.output.interLineDelayMs,
    );
  } catch (err) {
    const kind = isAIProviderError(err) ? err.kind : 'other';
    const message = err instanceof Error ? err.message : String(err);
    api.error(`session provider error (${kind}): ${message}`);
    if (kind === 'rate_limit') {
      noticeOpsRateLimited(ctx.channel, message);
    } else {
      ctx.reply('AI is temporarily unavailable.');
    }
  }
}
