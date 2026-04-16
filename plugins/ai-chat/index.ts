// ai-chat — AI-powered chat plugin.
// Feeds channel messages into a sliding context window and responds via an
// AI provider adapter (currently Gemini).
import type { HandlerContext, PluginAPI } from '../../src/types';
import {
  type AssistantConfig,
  type PromptContext,
  renderSystemPrompt,
  respond,
  sendLines,
} from './assistant';
import { ContextManager } from './context-manager';
import { listGames, loadGamePrompt, resolveGamesDir } from './games-loader';
import { formatResponse } from './output-formatter';
import { createProvider } from './providers';
import { ResilientProvider } from './providers/resilient';
import type { AIMessage, AIProvider, AIProviderError } from './providers/types';
import { RateLimiter } from './rate-limiter';
import { SessionManager } from './session-manager';
import { TokenTracker } from './token-tracker';
import { type TriggerConfig, detectTrigger, isIgnored, isLikelyBot } from './triggers';

export const name = 'ai-chat';
export const version = '1.0.0';
export const description = 'AI-powered chat with pluggable LLM providers';

// ---------------------------------------------------------------------------
// Module state (reset on each init/teardown)
// ---------------------------------------------------------------------------

let contextManager: ContextManager | null = null;
let rateLimiter: RateLimiter | null = null;
let tokenTracker: TokenTracker | null = null;
let sessionManager: SessionManager | null = null;
let provider: AIProvider | null = null;
let gamesDir: string = '';

/**
 * Test-only hook: inject a mock provider factory before init runs.
 * Stored on globalThis so it crosses the plugin-loader cache-bust boundary.
 */
const TEST_HOOK_KEY = '__aichat_test_provider_factory__';
export function __setProviderOverrideForTesting(factory: (() => AIProvider) | null): void {
  (globalThis as Record<string, unknown>)[TEST_HOOK_KEY] = factory ?? undefined;
}
function readTestOverride(): (() => AIProvider) | null {
  const v = (globalThis as Record<string, unknown>)[TEST_HOOK_KEY];
  return typeof v === 'function' ? (v as () => AIProvider) : null;
}

// ---------------------------------------------------------------------------
// Typed config accessors
// ---------------------------------------------------------------------------

interface AiChatConfig {
  provider: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  personality: string;
  personalities: Record<string, string>;
  channelPersonalities: Record<string, string | { personality?: string; language?: string }>;
  triggers: TriggerConfig;
  context: { maxMessages: number; maxTokens: number; ttlMs: number };
  rateLimits: {
    userCooldownSeconds: number;
    channelCooldownSeconds: number;
    globalRpm: number;
    globalRpd: number;
  };
  tokenBudgets: { perUserDaily: number; globalDaily: number };
  permissions: {
    requiredFlag: string;
    adminFlag: string;
    ignoreList: string[];
    ignoreBots: boolean;
    botNickPatterns: string[];
  };
  output: { maxLines: number; maxLineLength: number; interLineDelayMs: number; stripUrls: boolean };
  security: {
    privilegeGating: boolean;
    privilegedModeThreshold: string;
    privilegedRequiredFlag: string;
    disableWhenPrivileged: boolean;
  };
  sessions: { enabled: boolean; inactivityMs: number; gamesDir: string };
}

export function parseConfig(raw: Record<string, unknown>): AiChatConfig {
  const triggers = asRecord(raw.triggers);
  const context = asRecord(raw.context);
  const rl = asRecord(raw.rate_limits);
  const tb = asRecord(raw.token_budgets);
  const perm = asRecord(raw.permissions);
  const output = asRecord(raw.output);
  const personalities = asRecord(raw.personalities);
  const channelPersonalities = asRecord(raw.channel_personalities);

  return {
    provider: asString(raw.provider, 'gemini'),
    model: asString(raw.model, 'gemini-2.5-flash-lite'),
    temperature: asNum(raw.temperature, 0.9),
    maxOutputTokens: asNum(raw.max_output_tokens, 256),
    personality: asString(raw.personality, 'friendly'),
    personalities: Object.fromEntries(
      Object.entries(personalities).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    channelPersonalities: channelPersonalities as AiChatConfig['channelPersonalities'],
    triggers: {
      directAddress: asBool(triggers.direct_address, true),
      command: asBool(triggers.command, true),
      commandPrefix: asString(triggers.command_prefix, '!ai'),
      keywords: asStringArr(triggers.keywords, []),
      randomChance: asNum(triggers.random_chance, 0),
    },
    context: {
      maxMessages: asNum(context.max_messages, 50),
      maxTokens: asNum(context.max_tokens, 4000),
      ttlMs: asNum(context.ttl_minutes, 60) * 60_000,
    },
    rateLimits: {
      userCooldownSeconds: asNum(rl.user_cooldown_seconds, 30),
      channelCooldownSeconds: asNum(rl.channel_cooldown_seconds, 10),
      globalRpm: asNum(rl.global_rpm, 10),
      globalRpd: asNum(rl.global_rpd, 800),
    },
    tokenBudgets: {
      perUserDaily: asNum(tb.per_user_daily, 50_000),
      globalDaily: asNum(tb.global_daily, 200_000),
    },
    permissions: {
      requiredFlag: asString(perm.required_flag, '-'),
      adminFlag: asString(perm.admin_flag, 'm'),
      ignoreList: asStringArr(perm.ignore_list, []),
      ignoreBots: asBool(perm.ignore_bots, true),
      botNickPatterns: asStringArr(perm.bot_nick_patterns, ['*bot', '*Bot', '*BOT']),
    },
    output: {
      maxLines: asNum(output.max_lines, 4),
      maxLineLength: asNum(output.max_line_length, 440),
      interLineDelayMs: asNum(output.inter_line_delay_ms, 500),
      stripUrls: asBool(output.strip_urls, false),
    },
    security: {
      privilegeGating: asBool(asRecord(raw.security).privilege_gating, false),
      privilegedModeThreshold: asString(asRecord(raw.security).privileged_mode_threshold, 'h'),
      privilegedRequiredFlag: asString(asRecord(raw.security).privileged_required_flag, 'm'),
      disableWhenPrivileged: asBool(asRecord(raw.security).disable_when_privileged, false),
    },
    sessions: {
      enabled: asBool(asRecord(raw.sessions).enabled, true),
      inactivityMs: asNum(asRecord(raw.sessions).inactivity_timeout_minutes, 10) * 60_000,
      gamesDir: asString(asRecord(raw.sessions).games_dir, 'games'),
    },
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}
function asNum(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function asString(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}
function asStringArr(v: unknown, dflt: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : dflt;
}

// ---------------------------------------------------------------------------
// shouldRespond — permission, ignore, bot-nick, and self-talk gating.
// ---------------------------------------------------------------------------

export interface ShouldRespondCtx {
  nick: string;
  ident: string;
  hostname: string;
  channel: string | null;
  botNick: string;
  hasRequiredFlag: boolean;
  /** Does the user have the privilege-gating flag (e.g. +m)? */
  hasPrivilegedFlag: boolean;
  /** Bot's channel modes (e.g. 'o', 'ov') or undefined if unknown. */
  botChannelModes: string | undefined;
  config: AiChatConfig;
  /** Dynamic ignore list (from DB) merged with config.permissions.ignoreList. */
  dynamicIgnoreList: string[];
}

/**
 * Check whether the bot's privilege level in the channel restricts AI responses.
 *
 * When `security.privilege_gating` is enabled and the bot has elevated channel
 * modes (half-op or above), either:
 * - `disable_when_privileged`: block all responses
 * - Otherwise: require the user to have the configured bot flag (default +m)
 */
function isPrivilegeRestricted(ctx: ShouldRespondCtx): boolean {
  const sec = ctx.config.security;
  if (!sec.privilegeGating || !ctx.channel) return false;

  const botModes = ctx.botChannelModes;
  if (!botModes) return false;

  // Check if bot has any elevated mode at or above threshold
  const elevated = ['q', 'a', 'o', 'h']; // founder, admin, op, halfop
  const threshIdx = elevated.indexOf(sec.privilegedModeThreshold);
  if (threshIdx === -1) return false;
  const eligibleModes = elevated.slice(0, threshIdx + 1);
  if (!eligibleModes.some((m) => botModes.includes(m))) return false;

  // Bot is privileged. Disable entirely or gate by flag.
  if (sec.disableWhenPrivileged) return true;
  return !ctx.hasPrivilegedFlag;
}

export function shouldRespond(ctx: ShouldRespondCtx): boolean {
  const nick = ctx.nick;
  if (nick.toLowerCase() === ctx.botNick.toLowerCase()) return false;
  if (
    isLikelyBot(nick, ctx.config.permissions.botNickPatterns, ctx.config.permissions.ignoreBots)
  ) {
    return false;
  }
  const hostmask = `${nick}!${ctx.ident}@${ctx.hostname}`;
  const fullIgnore = [...ctx.config.permissions.ignoreList, ...ctx.dynamicIgnoreList];
  if (isIgnored(nick, hostmask, fullIgnore)) return false;
  if (ctx.config.permissions.requiredFlag !== '-' && !ctx.hasRequiredFlag) return false;
  if (isPrivilegeRestricted(ctx)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers: build ShouldRespondCtx with privilege info
// ---------------------------------------------------------------------------

function getBotChannelModes(api: PluginAPI, channel: string | null): string | undefined {
  if (!channel) return undefined;
  const ch = api.getChannel(channel);
  if (!ch) return undefined;
  for (const u of ch.users.values()) {
    if (api.isBotNick(u.nick)) return u.modes;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ignore list (persisted in DB under ignore:<entry>)
// ---------------------------------------------------------------------------

const IGNORE_PREFIX = 'ignore:';

function getDynamicIgnoreList(api: PluginAPI): string[] {
  return api.db.list(IGNORE_PREFIX).map((row) => row.key.substring(IGNORE_PREFIX.length));
}

// ---------------------------------------------------------------------------
// Personality lookup
// ---------------------------------------------------------------------------

const PERSONALITY_PREFIX = 'personality:';

function activePersonality(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
): { name: string; prompt: string; language: string | undefined } {
  let name = cfg.personality;
  let language: string | undefined;

  if (channel) {
    // Dynamic override (DB) first, then config.channel_personalities
    const dynamic = api.db.get(`${PERSONALITY_PREFIX}${channel.toLowerCase()}`);
    if (dynamic) {
      name = dynamic;
    } else {
      const entry =
        cfg.channelPersonalities[channel] ?? cfg.channelPersonalities[channel.toLowerCase()];
      if (typeof entry === 'string') name = entry;
      else if (entry && typeof entry === 'object') {
        if (typeof entry.personality === 'string') name = entry.personality;
        if (typeof entry.language === 'string') language = entry.language;
      }
    }
  }

  const prompt = cfg.personalities[name] ?? cfg.personalities[cfg.personality] ?? '';
  return { name, prompt, language };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export async function init(api: PluginAPI): Promise<void> {
  const cfg = parseConfig(api.config);

  rateLimiter = new RateLimiter(cfg.rateLimits);
  tokenTracker = new TokenTracker(api.db, cfg.tokenBudgets);
  contextManager = new ContextManager({
    maxMessages: cfg.context.maxMessages,
    maxTokens: cfg.context.maxTokens,
    ttlMs: cfg.context.ttlMs,
  });
  sessionManager = cfg.sessions.enabled ? new SessionManager(cfg.sessions.inactivityMs) : null;
  gamesDir = resolveGamesDir(cfg.sessions.gamesDir);

  // Initialize provider
  provider = null;
  const override = readTestOverride();
  if (override) {
    provider = override();
    api.log(`Using injected provider for testing: ${provider.name}`);
  } else {
    const apiKey =
      process.env.HEX_GEMINI_API_KEY ??
      process.env.GEMINI_API_KEY ??
      process.env.AI_CHAT_API_KEY ??
      '';
    if (!apiKey) {
      api.warn(
        'No API key found in HEX_GEMINI_API_KEY — ai-chat plugin is in degraded mode (no LLM calls).',
      );
    } else {
      try {
        const p = createProvider(cfg.provider);
        await p.initialize({
          apiKey,
          model: cfg.model,
          maxOutputTokens: cfg.maxOutputTokens,
          temperature: cfg.temperature,
        });
        provider = new ResilientProvider(p);
        api.log(`Initialized ${cfg.provider} provider with model ${cfg.model}`);
      } catch (err) {
        api.error(`Failed to initialize provider: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const botNick = (): string => api.botConfig.irc.nick;
  const network = (): string => api.botConfig.irc.host;

  api.registerHelp([
    {
      command: cfg.triggers.commandPrefix,
      flags: cfg.permissions.requiredFlag,
      usage: `${cfg.triggers.commandPrefix} <message>`,
      description: 'Ask the AI chat bot a question',
      detail: [
        `Subcommands (admin): stats, reset <nick>, ignore <nick>, unignore <nick>, clear, personality [name]`,
        `Subcommands (anyone): personalities, model`,
      ],
      category: 'ai',
    },
  ]);

  api.log(
    `Loaded ai-chat v${version} provider=${cfg.provider} model=${cfg.model} ` +
      `(triggers direct:${cfg.triggers.directAddress} cmd:${cfg.triggers.command})`,
  );

  // -----------------------------------------------------------------------
  // pubm * — context feed + non-command trigger detection
  // -----------------------------------------------------------------------
  api.bind('pubm', '-', '*', async (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    // Feed every non-bot channel message into the context buffer.
    if (ctx.nick.toLowerCase() !== botNick().toLowerCase()) {
      contextManager!.addMessage(ctx.channel, ctx.nick, ctx.text, false);
    }

    // Let the pub `!ai` handler own the command trigger.
    const cmdPrefix = cfg.triggers.commandPrefix.toLowerCase();
    const lowerText = ctx.text.trim().toLowerCase();
    if (
      cfg.triggers.command &&
      (lowerText === cmdPrefix || lowerText.startsWith(cmdPrefix + ' '))
    ) {
      return;
    }

    // If user is in a session in this channel, route message as a game move.
    if (
      sessionManager &&
      ctx.nick.toLowerCase() !== botNick().toLowerCase() &&
      sessionManager.isInSession(ctx.nick, ctx.channel)
    ) {
      if (
        !shouldRespond({
          nick: ctx.nick,
          ident: ctx.ident,
          hostname: ctx.hostname,
          channel: ctx.channel,
          botNick: botNick(),
          hasRequiredFlag: api.permissions.checkFlags(cfg.permissions.requiredFlag, ctx),
          hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
          botChannelModes: getBotChannelModes(api, ctx.channel),
          config: cfg,
          dynamicIgnoreList: getDynamicIgnoreList(api),
        })
      ) {
        return;
      }
      await runSessionPipeline(api, cfg, ctx, ctx.text, botNick(), network());
      return;
    }

    const match = detectTrigger(ctx.text, botNick(), cfg.triggers);
    if (!match) return;
    if (match.kind === 'command') return;

    if (
      !shouldRespond({
        nick: ctx.nick,
        ident: ctx.ident,
        hostname: ctx.hostname,
        channel: ctx.channel,
        botNick: botNick(),
        hasRequiredFlag: api.permissions.checkFlags(cfg.permissions.requiredFlag, ctx),
        hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
        botChannelModes: getBotChannelModes(api, ctx.channel),
        config: cfg,
        dynamicIgnoreList: getDynamicIgnoreList(api),
      })
    ) {
      return;
    }

    await runPipeline(api, cfg, ctx, match.prompt, botNick(), network(), false);
  });

  // -----------------------------------------------------------------------
  // pub !ai — command trigger + admin subcommands
  // -----------------------------------------------------------------------
  if (cfg.triggers.command) {
    api.bind(
      'pub',
      cfg.permissions.requiredFlag,
      cfg.triggers.commandPrefix,
      async (ctx: HandlerContext) => {
        if (!ctx.channel) return;
        contextManager!.addMessage(ctx.channel, ctx.nick, ctx.text, false);

        const args = ctx.args.trim();

        // Admin + info subcommands
        if (await handleSubcommand(api, cfg, ctx, args)) return;

        const prompt = args;
        if (!prompt) {
          ctx.reply(`Usage: ${cfg.triggers.commandPrefix} <message>`);
          return;
        }
        if (
          !shouldRespond({
            nick: ctx.nick,
            ident: ctx.ident,
            hostname: ctx.hostname,
            channel: ctx.channel,
            botNick: botNick(),
            hasRequiredFlag: true,
            hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
            botChannelModes: getBotChannelModes(api, ctx.channel),
            config: cfg,
            dynamicIgnoreList: getDynamicIgnoreList(api),
          })
        ) {
          return;
        }
        await runPipeline(api, cfg, ctx, prompt, botNick(), network(), true);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Pipeline: call Assistant, format output, send with inter-line delay.
// ---------------------------------------------------------------------------

async function runPipeline(
  api: PluginAPI,
  cfg: AiChatConfig,
  ctx: HandlerContext,
  prompt: string,
  botNick: string,
  network: string,
  noticeOnBlock: boolean,
): Promise<void> {
  if (!rateLimiter || !tokenTracker || !contextManager) return;

  const personality = activePersonality(api, cfg, ctx.channel);
  if (!personality.prompt) {
    api.warn(`Personality "${personality.name}" has no system prompt; skipping response.`);
    return;
  }

  // No provider? Degraded placeholder mode.
  if (!provider) {
    ctx.reply('AI chat is currently unavailable.');
    return;
  }

  const assistantCfg: AssistantConfig = {
    maxLines: cfg.output.maxLines,
    maxLineLength: cfg.output.maxLineLength,
    interLineDelayMs: cfg.output.interLineDelayMs,
    maxOutputTokens: cfg.maxOutputTokens,
  };

  const promptCtx: PromptContext = {
    botNick,
    channel: ctx.channel,
    network,
    users: ctx.channel ? api.getUsers(ctx.channel).map((u) => u.nick) : undefined,
    language: personality.language,
  };

  const result = await respond(
    {
      nick: ctx.nick,
      channel: ctx.channel,
      prompt,
      systemPrompt: personality.prompt,
      promptContext: promptCtx,
    },
    { provider, rateLimiter, tokenTracker, contextManager, config: assistantCfg },
  );

  switch (result.status) {
    case 'rate_limited': {
      if (noticeOnBlock) {
        const secs = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        ctx.replyPrivate(`Rate limited (${result.limitedBy}) — try again in ${secs}s.`);
      }
      api.debug(`blocked=${result.limitedBy} nick=${ctx.nick}`);
      return;
    }
    case 'budget_exceeded':
      if (noticeOnBlock) ctx.replyPrivate('Daily token budget exceeded — try again tomorrow.');
      return;
    case 'provider_error': {
      api.error(`provider error (${result.kind}): ${result.message}`);
      if (result.kind === 'safety') {
        ctx.reply("Sorry — I can't help with that.");
      } else {
        ctx.reply('AI is temporarily unavailable.');
      }
      return;
    }
    case 'empty':
      api.debug('empty LLM response — nothing to send');
      return;
    case 'ok': {
      contextManager.addMessage(ctx.channel, botNick, result.lines.join(' '), true);
      api.log(
        `response sent channel=${ctx.channel ?? '(unknown)'} nick=${ctx.nick} ` +
          `lines=${result.lines.length} in=${result.tokensIn} out=${result.tokensOut}`,
      );
      await sendLines(result.lines, (line) => ctx.reply(line), cfg.output.interLineDelayMs);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Session pipeline — route a message as a move inside an active game session.
// ---------------------------------------------------------------------------

async function runSessionPipeline(
  api: PluginAPI,
  cfg: AiChatConfig,
  ctx: HandlerContext,
  text: string,
  botNickValue: string,
  networkName: string,
): Promise<void> {
  if (!rateLimiter || !tokenTracker || !sessionManager) return;
  const session = sessionManager.getSession(ctx.nick, ctx.channel);
  if (!session) return;

  const userKey = ctx.nick.toLowerCase();
  const channelKey = ctx.channel?.toLowerCase() ?? null;
  // Sessions bypass per-user/per-channel cooldowns — only enforce global RPM/RPD.
  const rl = rateLimiter.checkGlobal();
  if (!rl.allowed) {
    api.debug(`session rate-limited nick=${ctx.nick}`);
    return;
  }
  const estimate = Math.ceil(text.length / 4) + 64;
  if (!tokenTracker.canSpend(ctx.nick, estimate)) {
    ctx.replyPrivate('Daily token budget exceeded — try again tomorrow.');
    return;
  }
  if (!provider) {
    ctx.reply('AI chat is currently unavailable.');
    return;
  }

  const userMsg: AIMessage = { role: 'user', content: `[${ctx.nick}] ${text}` };
  const systemPrompt = renderSystemPrompt(session.systemPrompt, {
    botNick: botNickValue,
    channel: ctx.channel,
    network: networkName,
  });

  try {
    const res = await provider.complete(
      systemPrompt,
      [...session.context, userMsg],
      cfg.maxOutputTokens,
    );
    tokenTracker.recordUsage(ctx.nick, res.usage);
    rateLimiter.record(userKey, channelKey);

    const lines = formatResponse(res.text, cfg.output.maxLines, cfg.output.maxLineLength);
    if (lines.length === 0) return;

    sessionManager.addMessage(session, userMsg);
    sessionManager.addMessage(session, { role: 'assistant', content: lines.join(' ') });

    await sendLines(lines, (line) => ctx.reply(line), cfg.output.interLineDelayMs);
  } catch (err) {
    const provErr = err as AIProviderError;
    api.error(`session provider error (${provErr.kind ?? 'other'}): ${provErr.message ?? err}`);
    ctx.reply('AI is temporarily unavailable.');
  }
}

// ---------------------------------------------------------------------------
// Admin + info subcommands (return true if handled).
// ---------------------------------------------------------------------------

async function handleSubcommand(
  api: PluginAPI,
  cfg: AiChatConfig,
  ctx: HandlerContext,
  args: string,
): Promise<boolean> {
  if (!args) return false;
  const [sub, ...rest] = args.split(/\s+/);
  const subLower = sub.toLowerCase();
  const adminFlag = cfg.permissions.adminFlag;
  const hasAdmin = api.permissions.checkFlags(adminFlag, ctx);
  const hasOwner = api.permissions.checkFlags('n', ctx);
  const subArgs = rest.join(' ').trim();

  switch (subLower) {
    case 'stats': {
      if (!hasAdmin) return true; // silently ignore
      const total = tokenTracker!.getDailyTotal();
      ctx.reply(
        `Today: ${total.requests} requests, ${total.input + total.output} tokens ` +
          `(in:${total.input} out:${total.output})`,
      );
      return true;
    }
    case 'reset': {
      if (!hasOwner) return true;
      const target = subArgs;
      if (!target) {
        ctx.reply('Usage: !ai reset <nick>');
        return true;
      }
      tokenTracker!.resetUser(target);
      ctx.reply(`Reset token usage for ${target}.`);
      return true;
    }
    case 'ignore': {
      if (!hasAdmin) return true;
      const target = subArgs;
      if (!target) {
        ctx.reply('Usage: !ai ignore <nick|hostmask>');
        return true;
      }
      api.db.set(`${IGNORE_PREFIX}${target}`, '1');
      ctx.reply(`Now ignoring "${target}".`);
      return true;
    }
    case 'unignore': {
      if (!hasAdmin) return true;
      const target = subArgs;
      if (!target) {
        ctx.reply('Usage: !ai unignore <nick|hostmask>');
        return true;
      }
      api.db.del(`${IGNORE_PREFIX}${target}`);
      ctx.reply(`No longer ignoring "${target}".`);
      return true;
    }
    case 'clear': {
      if (!hasAdmin) return true;
      if (ctx.channel) contextManager!.clearContext(ctx.channel);
      ctx.reply('Channel context cleared.');
      return true;
    }
    case 'personality': {
      if (!subArgs) {
        const active = activePersonality(api, cfg, ctx.channel);
        ctx.reply(`Personality: ${active.name}${active.language ? ` (${active.language})` : ''}`);
        return true;
      }
      if (!hasAdmin) return true;
      const name = subArgs;
      if (!(name in cfg.personalities)) {
        ctx.reply(
          `Unknown personality: ${name}. Available: ${Object.keys(cfg.personalities).join(', ')}`,
        );
        return true;
      }
      if (ctx.channel) {
        api.db.set(`${PERSONALITY_PREFIX}${ctx.channel.toLowerCase()}`, name);
        ctx.reply(`Personality set to ${name} for ${ctx.channel}.`);
      }
      return true;
    }
    case 'personalities': {
      ctx.reply(`Available: ${Object.keys(cfg.personalities).join(', ')}`);
      return true;
    }
    case 'model': {
      const modelName = provider?.getModelName() ?? '(not initialized)';
      ctx.reply(`Provider: ${cfg.provider}, model: ${modelName}`);
      return true;
    }
    case 'games': {
      if (!sessionManager) {
        ctx.reply('Sessions are disabled.');
        return true;
      }
      const available = listGames(gamesDir);
      if (available.length === 0) ctx.reply('No games available.');
      else ctx.reply(`Games: ${available.join(', ')}`);
      return true;
    }
    case 'play': {
      if (!sessionManager) {
        ctx.reply('Sessions are disabled.');
        return true;
      }
      const game = subArgs;
      if (!game) {
        ctx.reply(`Usage: ${cfg.triggers.commandPrefix} play <game>`);
        return true;
      }
      const prompt = loadGamePrompt(gamesDir, game);
      if (!prompt) {
        ctx.reply(`Unknown game: ${game}. Available: ${listGames(gamesDir).join(', ')}`);
        return true;
      }
      sessionManager.createSession(ctx.nick, ctx.channel, game, prompt);
      ctx.reply(`Starting ${game}! Type \`${cfg.triggers.commandPrefix} endgame\` to quit.`);
      // Kick off the session with an empty move so the game sends its opening line.
      await runSessionPipeline(
        api,
        cfg,
        ctx,
        '(game start)',
        api.botConfig.irc.nick,
        api.botConfig.irc.host,
      );
      return true;
    }
    case 'endgame': {
      if (!sessionManager) {
        ctx.reply('Sessions are disabled.');
        return true;
      }
      const ended = sessionManager.endSession(ctx.nick, ctx.channel);
      ctx.reply(ended ? 'Session ended.' : 'No active session.');
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  rateLimiter?.reset();
  sessionManager?.clear();
  rateLimiter = null;
  tokenTracker = null;
  contextManager = null;
  sessionManager = null;
  provider = null;
}

// Re-export so Phase 6 tests can still access the formatter.
export { formatResponse };
