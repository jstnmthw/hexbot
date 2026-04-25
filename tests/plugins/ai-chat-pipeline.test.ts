// Unit tests for the response and session pipelines in ai-chat/pipeline.ts.
//
// The pipeline is a heavy orchestrator: rate-limit gating, ambient budget,
// provider call (via assistant.respond), result-status branching,
// post-gate, drip-feed send, and side-effect bookkeeping. These tests mock
// `respond()` (and the session provider) directly so we don't have to rebuild
// real RateLimiter/TokenTracker/ContextManager state for every status branch.
// The ambient/budget surfaces that DO matter are tested with real
// implementations so the integration is exercised.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { respond } from '../../plugins/ai-chat/assistant';
import type { Character } from '../../plugins/ai-chat/characters/types';
import type { AiChatConfig } from '../../plugins/ai-chat/config';
import type { ContextManager } from '../../plugins/ai-chat/context-manager';
import type { EngagementTracker } from '../../plugins/ai-chat/engagement-tracker';
import type { IterStats } from '../../plugins/ai-chat/iter-stats';
import type { MoodEngine } from '../../plugins/ai-chat/mood';
import {
  type PipelineDeps,
  hasRecentBotInteraction,
  renderChannelProfile,
  runPipeline,
  runSessionPipeline,
} from '../../plugins/ai-chat/pipeline';
import { type AIProvider, AIProviderError } from '../../plugins/ai-chat/providers/types';
import { RateLimiter } from '../../plugins/ai-chat/rate-limiter';
import type { Session, SessionManager } from '../../plugins/ai-chat/session-manager';
import type { SocialTracker, UserInteraction } from '../../plugins/ai-chat/social-tracker';
import type { TokenTracker } from '../../plugins/ai-chat/token-tracker';
import type { HandlerContext } from '../../src/types';
import { createMockPluginAPI } from '../helpers/mock-plugin-api';

// -----------------------------------------------------------------------------
// Mock the assistant module so the pipeline is tested in isolation from the
// LLM-call orchestration. The renderStableSystemPrompt / renderVolatileHeader
// functions are still needed (the session pipeline calls them directly), so
// pass through real implementations from a partial mock.
// -----------------------------------------------------------------------------
vi.mock('../../plugins/ai-chat/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../plugins/ai-chat/assistant')>(
    '../../plugins/ai-chat/assistant',
  );
  return {
    ...actual,
    respond: vi.fn(),
  };
});

const respondMock = respond as ReturnType<typeof vi.fn>;

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const BASE_CONFIG: AiChatConfig = {
  provider: 'gemini',
  apiKey: 'k',
  model: 'm',
  modelClass: 'medium',
  temperature: 0.9,
  maxOutputTokens: 256,
  character: 'friendly',
  charactersDir: 'characters',
  channelCharacters: {},
  channelProfiles: {},
  triggers: { directAddress: true, commandPrefix: '!ai', keywords: [], randomChance: 0 },
  engagement: { softTimeoutMs: 600_000, hardCeilingMs: 1_800_000 },
  context: {
    maxMessages: 25,
    maxTokens: 2000,
    ttlMs: 60_000,
    pruneStrategy: 'bulk',
    maxMessageChars: 1000,
  },
  rateLimits: {
    userBurst: 3,
    userRefillSeconds: 12,
    globalRpm: 10,
    globalRpd: 800,
    rpmBackpressurePct: 80,
    ambientPerChannelPerHour: 5,
    ambientGlobalPerHour: 20,
  },
  tokenBudgets: { perUserDaily: 50_000, globalDaily: 200_000 },
  permissions: {
    requiredFlag: '-',
    adminFlag: 'm',
    ignoreList: [],
    ignoreBots: true,
    botNickPatterns: ['*bot', '*Bot', '*BOT'],
  },
  output: {
    maxLines: 4,
    maxLineLength: 440,
    interLineDelayMs: 0,
    stripUrls: false,
    promptLeakThreshold: 80,
  },
  input: { maxPromptChars: 2000, maxInflight: 4, coalesceWindowMs: 0 },
  ambient: {
    enabled: false,
    idle: { afterMinutes: 15, chance: 0.3, minUsers: 2 },
    unansweredQuestions: { enabled: true, waitSeconds: 90 },
    chattiness: 0.08,
    interests: [],
    eventReactions: { joinWb: false, topicChange: false },
  },
  security: {
    privilegeGating: false,
    privilegedModeThreshold: 'h',
    privilegedRequiredFlag: 'm',
    disableWhenPrivileged: false,
    // Default OFF for pipeline tests so the post-gate stays open unless a
    // specific test enables it.
    disableWhenFounder: false,
  },
  sessions: { enabled: true, inactivityMs: 600_000, gamesDir: 'games' },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    requestTimeoutMs: 60_000,
    useServerTokenizer: false,
    keepAlive: '30m',
    numCtx: 4096,
    repeatPenalty: 0,
    repeatLastN: 0,
    stop: [],
  },
  dropInlineNickPrefix: false,
  defensiveVolatileHeader: false,
};

const BASE_CHARACTER: Character = {
  name: 'friendly',
  archetype: 'helpful',
  backstory: '',
  style: {
    casing: 'normal',
    punctuation: 'proper',
    slang: [],
    catchphrases: [],
    verbosity: 'normal',
    notes: [],
  },
  chattiness: 0.5,
  triggers: [],
  avoids: [],
  persona: 'You are friendly.',
};

function makeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    name: 'mock',
    initialize: vi.fn(async () => {}),
    complete: vi.fn(async () => ({ text: 'hi', usage: { input: 5, output: 3 }, model: 'm' })),
    countTokens: vi.fn(async () => 1),
    getModelName: () => 'm',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'alice',
    ident: 'u',
    hostname: 'h',
    channel: '#c',
    text: 'hello',
    command: '',
    args: 'hello',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  } as HandlerContext;
}

/**
 * Build a PipelineDeps populated with vi.fn-backed stubs for every collaborator
 * the pipeline can call. Tests override individual fields via `...overrides`.
 * Keeping all fields defined (not undefined) means a typo in a test won't
 * silently take a "missing dep → return early" branch.
 */
function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const provider = makeProvider();
  const rateLimiter = new RateLimiter({
    userBurst: 3,
    userRefillSeconds: 12,
    globalRpm: 100,
    globalRpd: 1000,
    rpmBackpressurePct: 80,
    ambientPerChannelPerHour: 5,
    ambientGlobalPerHour: 20,
  });
  const tokenTracker = {
    canSpend: vi.fn().mockReturnValue(true),
    canSpendGlobal: vi.fn().mockReturnValue(true),
    recordUsage: vi.fn(),
  } as unknown as TokenTracker;
  const contextManager = {
    addMessage: vi.fn(),
    getContext: vi.fn().mockReturnValue([]),
  } as unknown as ContextManager;
  const iterStats = {
    record: vi.fn(),
  } as unknown as IterStats;
  const moodEngine = {
    onInteraction: vi.fn(),
    getVerbosityMultiplier: vi.fn().mockReturnValue(1),
    renderMoodLine: vi.fn().mockReturnValue(''),
  } as unknown as MoodEngine;
  const engagementTracker = {
    onBotReply: vi.fn(),
  } as unknown as EngagementTracker;
  const socialTracker = {
    recordBotInteraction: vi.fn(),
    getUserInteraction: vi.fn().mockReturnValue(null),
  } as unknown as SocialTracker;
  const sessionManager = {
    getSession: vi.fn().mockReturnValue(null),
    addMessage: vi.fn(),
  } as unknown as SessionManager;

  return {
    provider,
    rateLimiter,
    tokenTracker,
    contextManager,
    iterStats,
    moodEngine,
    engagementTracker,
    socialTracker,
    sessionManager,
    semaphore: null,
    activeCharacter: vi.fn().mockReturnValue({ character: BASE_CHARACTER, language: undefined }),
    makeSessionIdentity: vi.fn().mockReturnValue({ account: null, identHost: 'u@h' }),
    noticeOpsRateLimited: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  respondMock.mockReset();
  // Default: a successful 'ok' result. Per-test overrides as needed.
  respondMock.mockResolvedValue({
    status: 'ok',
    lines: ['hello world'],
    tokensIn: 5,
    tokensOut: 3,
  });
});

// -----------------------------------------------------------------------------
// renderChannelProfile
// -----------------------------------------------------------------------------

describe('renderChannelProfile', () => {
  it('returns undefined when channel is null', () => {
    expect(renderChannelProfile(BASE_CONFIG, null)).toBeUndefined();
  });

  it('returns undefined when no profile is configured for the channel', () => {
    expect(renderChannelProfile(BASE_CONFIG, '#unknown')).toBeUndefined();
  });

  it('builds a string from topic only', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#linux': { topic: 'Linux' } } };
    expect(renderChannelProfile(cfg, '#linux')).toBe('This channel is about Linux.');
  });

  it('builds a string from culture only', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#c': { culture: 'technical' } } };
    expect(renderChannelProfile(cfg, '#c')).toBe('The culture here is technical.');
  });

  it('builds a string from role only', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#c': { role: 'a helper' } } };
    expect(renderChannelProfile(cfg, '#c')).toBe('Your role is a helper.');
  });

  it('builds a string from depth only', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#c': { depth: 'deep' } } };
    expect(renderChannelProfile(cfg, '#c')).toBe('Answer with deep depth.');
  });

  it('combines all fields in order', () => {
    const cfg = {
      ...BASE_CONFIG,
      channelProfiles: {
        '#c': { topic: 'Linux', culture: 'technical', role: 'a helper', depth: 'deep' },
      },
    };
    expect(renderChannelProfile(cfg, '#c')).toBe(
      'This channel is about Linux. The culture here is technical. Your role is a helper. Answer with deep depth.',
    );
  });

  it('falls back to the lowercase channel key when the exact case is absent', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#linux': { topic: 'Linux' } } };
    expect(renderChannelProfile(cfg, '#LINUX')).toBe('This channel is about Linux.');
  });

  it('returns undefined when a profile exists but has no populated fields', () => {
    const cfg = { ...BASE_CONFIG, channelProfiles: { '#c': {} } };
    expect(renderChannelProfile(cfg, '#c')).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// hasRecentBotInteraction
// -----------------------------------------------------------------------------

describe('hasRecentBotInteraction', () => {
  function trackerWithStats(stats: UserInteraction | null): SocialTracker {
    return {
      getUserInteraction: vi.fn().mockReturnValue(stats),
    } as unknown as SocialTracker;
  }

  it('returns false when tracker is null', () => {
    expect(hasRecentBotInteraction(null, 'alice')).toBe(false);
  });

  it('returns false when tracker has no stats for the nick', () => {
    expect(hasRecentBotInteraction(trackerWithStats(null), 'alice')).toBe(false);
  });

  it('returns false when botInteractions is zero (never replied to)', () => {
    const t = trackerWithStats({
      lastSeen: Date.now(),
      totalMessages: 5,
      botInteractions: 0,
      lastBotInteraction: 0,
    });
    expect(hasRecentBotInteraction(t, 'alice')).toBe(false);
  });

  it('returns true when last bot interaction is within the 15-minute window', () => {
    const t = trackerWithStats({
      lastSeen: Date.now(),
      totalMessages: 1,
      botInteractions: 1,
      lastBotInteraction: Date.now() - 60_000,
    });
    expect(hasRecentBotInteraction(t, 'alice')).toBe(true);
  });

  it('returns false when last bot interaction is older than the 15-minute window', () => {
    const t = trackerWithStats({
      lastSeen: Date.now(),
      totalMessages: 1,
      botInteractions: 1,
      lastBotInteraction: Date.now() - 16 * 60_000,
    });
    expect(hasRecentBotInteraction(t, 'alice')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// runPipeline — bail-outs
// -----------------------------------------------------------------------------

describe('runPipeline bail-outs', () => {
  // Each of these deps is nullable in PipelineDeps because index.ts builds
  // the bundle progressively during init/teardown — the pipeline must
  // short-circuit silently if it fires while a piece is still null
  // (otherwise we crash on a teardown-race PRIVMSG). One parameterized
  // test pins the contract for every nullable dep.
  it.each([
    ['rateLimiter', { rateLimiter: null }],
    ['tokenTracker', { tokenTracker: null }],
    ['contextManager', { contextManager: null }],
  ] as const)('returns silently when %s is missing', async (_name, override) => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps(override);
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(respondMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("emits 'AI chat is currently unavailable.' when provider is null", async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps({ provider: null });
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.reply).toHaveBeenCalledWith('AI chat is currently unavailable.');
    expect(respondMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// runPipeline — input prompt cap
// -----------------------------------------------------------------------------

describe('runPipeline busy / semaphore', () => {
  it("'busy' status sends a private notice for address source", async () => {
    respondMock.mockResolvedValueOnce({ status: 'busy' });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.replyPrivate).toHaveBeenCalledWith('Busy — try again in a moment.');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'busy' status stays silent for rolled source", async () => {
    respondMock.mockResolvedValueOnce({ status: 'busy' });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
  });
});

describe('runPipeline prompt cap', () => {
  it('rejects oversize prompt with private notice for address source', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const cfg = {
      ...BASE_CONFIG,
      input: { maxPromptChars: 10, maxInflight: 4, coalesceWindowMs: 0 },
    };
    await runPipeline(api, cfg, deps, ctx, 'this is too long', 'hexbot', 'irc.test', 'address');
    expect(respondMock).not.toHaveBeenCalled();
    expect(ctx.replyPrivate).toHaveBeenCalledWith('Message too long — keep it under 10 chars.');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('stays silent on oversize prompt for rolled source', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const cfg = {
      ...BASE_CONFIG,
      input: { maxPromptChars: 10, maxInflight: 4, coalesceWindowMs: 0 },
    };
    await runPipeline(api, cfg, deps, ctx, 'this is too long', 'hexbot', 'irc.test', 'rolled');
    expect(respondMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
  });

  it('accepts a prompt at the cap boundary', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const cfg = {
      ...BASE_CONFIG,
      input: { maxPromptChars: 5, maxInflight: 4, coalesceWindowMs: 0 },
    };
    await runPipeline(api, cfg, deps, ctx, 'hello', 'hexbot', 'irc.test', 'address');
    expect(respondMock).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// runPipeline — ambient budget for rolled replies
// -----------------------------------------------------------------------------

describe('runPipeline rolled-source ambient budget', () => {
  it('returns without notice when ambient budget is full for the channel', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    // Saturate the channel ambient bucket: 5 per-channel-per-hour by default.
    for (let i = 0; i < 5; i++) deps.rateLimiter!.recordAmbient('#c');
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(respondMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
  });

  it('proceeds when ambient budget has room and records ambient on success', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const recordSpy = vi.spyOn(deps.rateLimiter!, 'recordAmbient');
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(respondMock).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('hello world');
    // Recorded exactly once on the success path.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith('#c');
  });
});

// -----------------------------------------------------------------------------
// runPipeline — result.status branches
// -----------------------------------------------------------------------------

describe('runPipeline result-status branches', () => {
  it("'rate_limited' sends a private notice for address source with seconds remaining", async () => {
    respondMock.mockResolvedValue({
      status: 'rate_limited',
      limitedBy: 'user',
      retryAfterMs: 12_345,
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.replyPrivate).toHaveBeenCalledWith('Rate limited (user) — try again in 13s.');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'rate_limited' stays silent for rolled source (no private notice)", async () => {
    respondMock.mockResolvedValue({
      status: 'rate_limited',
      limitedBy: 'rpm',
      retryAfterMs: 5_000,
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'budget_exceeded' sends a private notice for engaged source", async () => {
    respondMock.mockResolvedValue({ status: 'budget_exceeded' });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'engaged');
    expect(ctx.replyPrivate).toHaveBeenCalledWith(
      'Daily token budget exceeded — try again tomorrow.',
    );
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'budget_exceeded' stays silent for rolled source", async () => {
    respondMock.mockResolvedValue({ status: 'budget_exceeded' });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(ctx.replyPrivate).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'provider_error' kind 'safety' sends the canned safety reply in-channel", async () => {
    respondMock.mockResolvedValue({
      status: 'provider_error',
      kind: 'safety',
      message: 'blocked',
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.reply).toHaveBeenCalledWith("Sorry — I can't help with that.");
    expect(deps.noticeOpsRateLimited).not.toHaveBeenCalled();
  });

  it("'provider_error' kind 'rate_limit' notices ops privately and stays silent in-channel", async () => {
    respondMock.mockResolvedValue({
      status: 'provider_error',
      kind: 'rate_limit',
      message: 'upstream 429',
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(deps.noticeOpsRateLimited).toHaveBeenCalledWith('#c', 'upstream 429');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'provider_error' other kinds send the generic unavailable reply", async () => {
    respondMock.mockResolvedValue({
      status: 'provider_error',
      kind: 'network',
      message: 'ECONNRESET',
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.reply).toHaveBeenCalledWith('AI is temporarily unavailable.');
    expect(deps.noticeOpsRateLimited).not.toHaveBeenCalled();
  });

  it("'empty' returns silently — no reply, no warn", async () => {
    respondMock.mockResolvedValue({ status: 'empty' });
    const api = createMockPluginAPI({ warn: vi.fn(), debug: vi.fn() });
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(api.warn).not.toHaveBeenCalled();
  });

  it("'fantasy_dropped' calls api.warn with index and a truncated quoted line", async () => {
    const longLine = '.deop ' + 'x'.repeat(200);
    respondMock.mockResolvedValue({
      status: 'fantasy_dropped',
      line: longLine,
      index: 2,
    });
    const warn = vi.fn();
    const api = createMockPluginAPI({ warn });
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('line 2');
    // Truncated to 80 chars then JSON-quoted.
    expect(msg).toContain('.deop');
    // Must NOT contain the entire 200-x line.
    expect(msg).not.toContain('x'.repeat(100));
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("'prompt_leaked' logs a warn with overlap size + preview and does not reply", async () => {
    respondMock.mockResolvedValue({
      status: 'prompt_leaked',
      overlap: 95,
      preview: 'You are a regular channel user, not an operator.',
    });
    const warn = vi.fn();
    const api = createMockPluginAPI({ warn });
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('prompt_leaked');
    expect(msg).toContain('overlap=95');
    expect(msg).toContain('regular channel user');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('small-tier strips fabricated speaker prefixes before storing the bot reply in context', async () => {
    respondMock.mockResolvedValue({
      status: 'ok',
      lines: ['alice: here is my response'],
      tokensIn: 10,
      tokensOut: 5,
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const addMessage = vi.spyOn(deps.contextManager as ContextManager, 'addMessage');
    // Small tier: stored reply is just styled[0] with speaker prefix stripped.
    const smallCfg = { ...BASE_CONFIG, modelClass: 'small' as const };
    await runPipeline(api, smallCfg, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    // Last addMessage call is the bot reply; text should have lost 'alice: '.
    const botCall = addMessage.mock.calls.find((c) => c[3] === true);
    expect(botCall).toBeDefined();
    expect(botCall![2]).toBe('here is my response');
  });

  it('strips angle-bracket speaker prefixes from stored bot reply on medium tier', async () => {
    respondMock.mockResolvedValue({
      status: 'ok',
      lines: ['<bob> something'],
      tokensIn: 10,
      tokensOut: 5,
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const addMessage = vi.spyOn(deps.contextManager as ContextManager, 'addMessage');
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    const botCall = addMessage.mock.calls.find((c) => c[3] === true);
    expect(botCall).toBeDefined();
    expect(botCall![2]).toBe('something');
  });

  it("'ok' applies character style, records context, engagement, social, and sends gated lines", async () => {
    respondMock.mockResolvedValue({
      status: 'ok',
      lines: ['Line One', 'Line Two'],
      tokensIn: 5,
      tokensOut: 3,
    });
    const lowercaseChar: Character = {
      ...BASE_CHARACTER,
      style: { ...BASE_CHARACTER.style, casing: 'lowercase' },
    };
    const log = vi.fn();
    const api = createMockPluginAPI({ log });
    const ctx = makeCtx();
    const deps = makeDeps({
      activeCharacter: vi.fn().mockReturnValue({ character: lowercaseChar, language: 'English' }),
    });
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');

    // Sender produced lowercased lines (style applied).
    const replySends = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replySends).toEqual(['line one', 'line two']);

    // Context was recorded with the joined styled output, marked as bot.
    expect(deps.contextManager!.addMessage).toHaveBeenCalledWith(
      '#c',
      'hexbot',
      'line one line two',
      true,
    );
    // Engagement recorded for the channel.
    expect(deps.engagementTracker!.onBotReply).toHaveBeenCalledWith('#c', 'alice');
    // Social tracker bot interaction recorded.
    expect(deps.socialTracker!.recordBotInteraction).toHaveBeenCalledWith('alice');
    // Operator log line emitted.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('response sent');
    expect(log.mock.calls[0][0]).toContain('lines=2');
    expect(log.mock.calls[0][0]).toContain('in=5 out=3');
  });

  it("'ok' on rolled source records the ambient tick exactly once after success", async () => {
    respondMock.mockResolvedValue({
      status: 'ok',
      lines: ['ok'],
      tokensIn: 1,
      tokensOut: 1,
    });
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const recordSpy = vi.spyOn(deps.rateLimiter!, 'recordAmbient');
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'rolled');
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it("'ok' founder post-gate trips → returns BEFORE sending any line", async () => {
    respondMock.mockResolvedValue({
      status: 'ok',
      lines: ['hello'],
      tokensIn: 1,
      tokensOut: 1,
    });
    // Wire the ChanServ access readback to 'founder' and enable the gate.
    const getString = vi.fn().mockReturnValue('founder');
    const api = createMockPluginAPI({
      channelSettings: {
        ...createMockPluginAPI().channelSettings,
        getString,
      },
      warn: vi.fn(),
    });
    const cfg = {
      ...BASE_CONFIG,
      security: { ...BASE_CONFIG.security, disableWhenFounder: true },
    };
    const ctx = makeCtx();
    const deps = makeDeps();
    await runPipeline(api, cfg, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(ctx.reply).not.toHaveBeenCalled();
    // Bookkeeping that runs AFTER the gate must not have happened.
    expect(deps.contextManager!.addMessage).not.toHaveBeenCalled();
    expect(deps.engagementTracker!.onBotReply).not.toHaveBeenCalled();
    expect(deps.socialTracker!.recordBotInteraction).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// runPipeline — mood verbosity multiplier
// -----------------------------------------------------------------------------

describe('runPipeline mood verbosity multiplier', () => {
  it('multiplies cfg.output.maxLines by the mood multiplier when invoking respond()', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const moodEngine = {
      onInteraction: vi.fn(),
      // 0.5 verbosity multiplier → maxLines goes from 4 to 2.
      getVerbosityMultiplier: vi.fn().mockReturnValue(0.5),
      renderMoodLine: vi.fn().mockReturnValue(''),
    } as unknown as MoodEngine;
    const deps = makeDeps({ moodEngine });
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    expect(respondMock).toHaveBeenCalledTimes(1);
    const callArgs = respondMock.mock.calls[0];
    const respondDeps = callArgs[1] as { config: { maxLines: number } };
    expect(respondDeps.config.maxLines).toBe(2);
  });

  it('floors the multiplied maxLines at 1 so a near-zero mood does not zero the cap', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const moodEngine = {
      onInteraction: vi.fn(),
      getVerbosityMultiplier: vi.fn().mockReturnValue(0.01),
      renderMoodLine: vi.fn().mockReturnValue(''),
    } as unknown as MoodEngine;
    const deps = makeDeps({ moodEngine });
    await runPipeline(api, BASE_CONFIG, deps, ctx, 'hi', 'hexbot', 'irc.test', 'address');
    const respondDeps = respondMock.mock.calls[0][1] as { config: { maxLines: number } };
    expect(respondDeps.config.maxLines).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// runSessionPipeline
// -----------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    userKey: 'alice',
    channel: '#c',
    type: '20q',
    systemPrompt: 'You host 20 questions.',
    context: [],
    startedAt: 0,
    lastActivityAt: 0,
    identity: { account: null, identHost: 'u@h' },
    ...overrides,
  };
}

describe('runSessionPipeline bail-outs', () => {
  // Same teardown-race rationale as runPipeline above. One parameterized
  // test pins the contract for every nullable dep.
  it.each([
    ['rateLimiter', { rateLimiter: null }],
    ['tokenTracker', { tokenTracker: null }],
    ['sessionManager', { sessionManager: null }],
    ['provider', { provider: null }],
  ] as const)('returns silently when %s is missing', async (_name, override) => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps(override);
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('returns silently when there is no active session for nick/channel', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps({
      sessionManager: {
        getSession: vi.fn().mockReturnValue(null),
        addMessage: vi.fn(),
      } as unknown as SessionManager,
    });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.reply).not.toHaveBeenCalled();
    // Provider must not have been called.
    expect((deps.provider as AIProvider).complete).not.toHaveBeenCalled();
  });

  it('rejects oversized session text with a private notice and does not call the provider', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const deps = makeDeps();
    const oversized = 'a'.repeat(BASE_CONFIG.input.maxPromptChars + 1);
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, oversized, 'hexbot', 'irc.test');
    expect(ctx.replyPrivate).toHaveBeenCalledTimes(1);
    const msg = (ctx.replyPrivate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('Message too long');
    expect((deps.provider as AIProvider).complete).not.toHaveBeenCalled();
  });
});

describe('runSessionPipeline gating', () => {
  it('emits a private rate-limit notice when global RPM is exhausted', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const rateLimiter = new RateLimiter({
      userBurst: 0,
      userRefillSeconds: 12,
      // RPM=1, then we record one call to fill it, so checkGlobal returns blocked.
      globalRpm: 1,
      globalRpd: 100,
      rpmBackpressurePct: 80,
    });
    rateLimiter.record('seed');
    const deps = makeDeps({
      rateLimiter,
      sessionManager: {
        getSession: vi.fn().mockReturnValue(session),
        addMessage: vi.fn(),
      } as unknown as SessionManager,
    });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.replyPrivate).toHaveBeenCalledTimes(1);
    const msg = (ctx.replyPrivate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/^Rate limited \(rpm\) — try again in \d+s\.$/);
    expect((deps.provider as AIProvider).complete).not.toHaveBeenCalled();
  });

  it('emits the budget-exceeded private notice when canSpend rejects (non-admin)', async () => {
    const api = createMockPluginAPI({
      permissions: {
        findByHostmask: vi.fn().mockReturnValue(null),
        // Non-admin.
        checkFlags: vi.fn().mockReturnValue(false),
      },
    });
    const ctx = makeCtx();
    const session = makeSession();
    const tokenTracker = {
      canSpend: vi.fn().mockReturnValue(false),
      canSpendGlobal: vi.fn().mockReturnValue(true),
      recordUsage: vi.fn(),
    } as unknown as TokenTracker;
    const deps = makeDeps({
      tokenTracker,
      sessionManager: {
        getSession: vi.fn().mockReturnValue(session),
        addMessage: vi.fn(),
      } as unknown as SessionManager,
    });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.replyPrivate).toHaveBeenCalledWith(
      'Daily token budget exceeded — try again tomorrow.',
    );
    expect((deps.provider as AIProvider).complete).not.toHaveBeenCalled();
    // Per-user check was used (non-admin path).
    expect(tokenTracker.canSpend).toHaveBeenCalled();
    expect(tokenTracker.canSpendGlobal).not.toHaveBeenCalled();
  });

  it('admin bypasses the per-user budget — uses canSpendGlobal instead', async () => {
    const api = createMockPluginAPI({
      permissions: {
        findByHostmask: vi.fn().mockReturnValue(null),
        // Admin.
        checkFlags: vi.fn().mockReturnValue(true),
      },
    });
    const ctx = makeCtx();
    const session = makeSession();
    const tokenTracker = {
      canSpend: vi.fn().mockReturnValue(false),
      canSpendGlobal: vi.fn().mockReturnValue(true),
      recordUsage: vi.fn(),
    } as unknown as TokenTracker;
    const deps = makeDeps({
      tokenTracker,
      sessionManager: {
        getSession: vi.fn().mockReturnValue(session),
        addMessage: vi.fn(),
      } as unknown as SessionManager,
    });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    // Admin path consulted canSpendGlobal, NOT per-user canSpend.
    expect(tokenTracker.canSpendGlobal).toHaveBeenCalled();
    expect(tokenTracker.canSpend).not.toHaveBeenCalled();
    // Provider was called (budget check passed).
    expect((deps.provider as AIProvider).complete).toHaveBeenCalled();
  });
});

describe('runSessionPipeline success', () => {
  it('calls the provider, records usage, appends both turns to the session, and sends gated lines', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession({
      context: [{ role: 'assistant', content: 'previous turn' }],
    });
    const provider = makeProvider({
      complete: vi.fn(async () => ({
        text: 'your turn',
        usage: { input: 4, output: 2 },
        model: 'm',
      })),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const tokenTracker = {
      canSpend: vi.fn().mockReturnValue(true),
      canSpendGlobal: vi.fn().mockReturnValue(true),
      recordUsage: vi.fn(),
    } as unknown as TokenTracker;
    const deps = makeDeps({ provider, sessionManager, tokenTracker });

    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'guess?', 'hexbot', 'irc.test');

    // Provider received: system prompt, history + user turn with bracket-tag attribution.
    const completeCall = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = completeCall[1] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'previous turn' });
    expect(messages[1].role).toBe('user');
    // Bracket-tag attribution on the user turn — distinguishing feature of the
    // session path vs. the regular pipeline (per the NOTE in pipeline.ts).
    expect(messages[1].content).toContain('[alice] guess?');

    // Token usage recorded.
    expect(tokenTracker.recordUsage).toHaveBeenCalledWith('alice', { input: 4, output: 2 });
    // Iter stats recorded.
    expect(deps.iterStats!.record).toHaveBeenCalledWith({ input: 4, output: 2 });

    // Both user message and assistant reply added to the session.
    expect(sessionManager.addMessage).toHaveBeenCalledTimes(2);
    expect(sessionManager.addMessage).toHaveBeenNthCalledWith(1, session, messages[1]);
    expect(sessionManager.addMessage).toHaveBeenNthCalledWith(2, session, {
      role: 'assistant',
      content: 'your turn',
    });

    // Gated send used the channel reply.
    expect(ctx.reply).toHaveBeenCalledWith('your turn');
  });

  it('returns silently when the formatter produces zero lines (empty model output)', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => ({
        text: '   ',
        usage: { input: 1, output: 1 },
        model: 'm',
      })),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });

  it('founder post-gate trips → no send, but session messages are still committed', async () => {
    // Note: in pipeline.ts the founder gate fires AFTER addMessage(...) calls
    // — by design the session bookkeeping happens before the post-gate, only
    // the IRC send is suppressed. This test pins that ordering so a refactor
    // doesn't accidentally swap the two without the design discussion.
    const getString = vi.fn().mockReturnValue('founder');
    const api = createMockPluginAPI({
      channelSettings: { ...createMockPluginAPI().channelSettings, getString },
      warn: vi.fn(),
    });
    const cfg = {
      ...BASE_CONFIG,
      security: { ...BASE_CONFIG.security, disableWhenFounder: true },
    };
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => ({
        text: 'reply',
        usage: { input: 1, output: 1 },
        model: 'm',
      })),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, cfg, deps, ctx, 'go', 'hexbot', 'irc.test');
    // Send dropped.
    expect(ctx.reply).not.toHaveBeenCalled();
    // But session bookkeeping ran (this is the current observed behavior).
    expect(sessionManager.addMessage).toHaveBeenCalledTimes(2);
  });
});

describe('runSessionPipeline provider errors', () => {
  it("AIProviderError kind 'rate_limit' notices ops privately", async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => {
        throw new AIProviderError('upstream 429', 'rate_limit');
      }),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(deps.noticeOpsRateLimited).toHaveBeenCalledWith('#c', 'upstream 429');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('other provider throws → ctx.reply with the canned unavailable message', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => {
        throw new AIProviderError('5xx', 'network');
      }),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.reply).toHaveBeenCalledWith('AI is temporarily unavailable.');
    expect(deps.noticeOpsRateLimited).not.toHaveBeenCalled();
  });

  it('logs a warn and returns silently when the session response contains a fantasy-prefix line', async () => {
    // The session pipeline runs its own formatResponse pass with an inline
    // fantasy-drop callback (different code path from the regular pipeline,
    // which uses respond()'s fantasy_dropped status). A leading "." trips
    // the IRC-services fantasy-command guard.
    const warn = vi.fn();
    const api = createMockPluginAPI({ warn });
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => ({
        text: '.deop admin',
        usage: { input: 1, output: 1 },
        model: 'm',
      })),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'session: dropped response containing fantasy-prefix line',
    );
    expect(ctx.reply).not.toHaveBeenCalled();
    // Session bookkeeping must not run for a dropped response.
    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });

  it('non-AIProviderError throw is treated as kind "other" and sends the unavailable reply', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.reply).toHaveBeenCalledWith('AI is temporarily unavailable.');
  });

  it('non-Error throw is coerced via String(err) for the api.error log', async () => {
    // Covers the `err instanceof Error ? err.message : String(err)` branch on
    // the catch path. Throwing a plain string mirrors what some upstream
    // bindings can do.
    const error = vi.fn();
    const api = createMockPluginAPI({ error });
    const ctx = makeCtx();
    const session = makeSession();
    const provider = makeProvider({
      complete: vi.fn(async () => {
        throw 'just a string';
      }),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(error).toHaveBeenCalledTimes(1);
    expect((error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('just a string');
    expect(ctx.reply).toHaveBeenCalledWith('AI is temporarily unavailable.');
  });
});

describe('runSessionPipeline edge cases', () => {
  it('falls back to "rpm"/0s wording when checkGlobal returns no limitedBy/retryAfterMs', async () => {
    // Defensive default-string path — exercises the `?? 'rpm'` and
    // `?? 0` fallbacks where a future RateLimiter shape might omit the
    // optional fields on a block.
    const api = createMockPluginAPI();
    const ctx = makeCtx();
    const session = makeSession();
    const rateLimiter = {
      checkGlobal: vi.fn().mockReturnValue({ allowed: false }),
      check: vi.fn(),
      record: vi.fn(),
      recordAmbient: vi.fn(),
      checkAmbient: vi.fn().mockReturnValue(true),
    } as unknown as PipelineDeps['rateLimiter'];
    const deps = makeDeps({
      rateLimiter,
      sessionManager: {
        getSession: vi.fn().mockReturnValue(session),
        addMessage: vi.fn(),
      } as unknown as SessionManager,
    });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'go', 'hexbot', 'irc.test');
    expect(ctx.replyPrivate).toHaveBeenCalledWith('Rate limited (rpm) — try again in 1s.');
  });

  it('handles a PM session (channel = null) — bracket-tag attribution still applied, no founder gate', async () => {
    const api = createMockPluginAPI();
    const ctx = makeCtx({ channel: null });
    const session = makeSession({ channel: null });
    const provider = makeProvider({
      complete: vi.fn(async () => ({
        text: 'pm reply',
        usage: { input: 1, output: 1 },
        model: 'm',
      })),
    });
    const sessionManager = {
      getSession: vi.fn().mockReturnValue(session),
      addMessage: vi.fn(),
    } as unknown as SessionManager;
    const deps = makeDeps({ provider, sessionManager });
    await runSessionPipeline(api, BASE_CONFIG, deps, ctx, 'pm text', 'hexbot', 'irc.test');
    expect(ctx.reply).toHaveBeenCalledWith('pm reply');
    // Bracket-tag attribution still present even without a channel.
    const completeCall = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = completeCall[1] as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1].content).toContain('[alice] pm text');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
