// ai-chat — AI-powered chat plugin.
// Feeds channel messages into a sliding context window and responds via an
// AI provider adapter (currently Gemini).
import type { HandlerContext, PluginAPI } from '../../src/types';
import { AmbientEngine } from './ambient';
import {
  type AssistantConfig,
  type PromptContext,
  renderSystemPrompt,
  respond,
  sendLines,
} from './assistant';
import { getCharacter, loadCharacters, resolveCharactersDir } from './character-loader';
import type { Character } from './characters/types';
import { ContextManager } from './context-manager';
import { listGames, loadGamePrompt, resolveGamesDir } from './games-loader';
import { MoodEngine } from './mood';
import { applyCharacterStyle, formatResponse } from './output-formatter';
import { createResilientProvider } from './providers';
import {
  type AIMessage,
  type AIProvider,
  type AIProviderConfig,
  isAIProviderError,
} from './providers/types';
import { RateLimiter } from './rate-limiter';
import { type SessionIdentity, SessionManager } from './session-manager';
import { SocialTracker } from './social-tracker';
import { TokenTracker } from './token-tracker';
import { type TriggerConfig, detectTrigger, isIgnored, isLikelyBot } from './triggers';

export const name = 'ai-chat';
export const version = '1.0.0';
export const description = 'AI-powered chat with pluggable LLM providers';

// ---------------------------------------------------------------------------
// Module state (reset on each init/teardown)
// ---------------------------------------------------------------------------

/**
 * Named bag of per-init mutable collections. Folds what used to be two
 * module-level `let`s (characters) + `const` (engagementMap) so they can be
 * injected as a single unit via AIChatDeps for tests that want per-case
 * isolation without a full teardown/init cycle.
 */
export interface PluginState {
  /** Tracks per-channel per-nick engagement timestamps (when bot last responded). */
  engagement: Map<string, number>;
  /** Loaded character definitions, keyed by character name. */
  characters: Map<string, Character>;
}

/**
 * Optional dependencies a caller can inject at init() time. Every field is
 * optional; anything absent is instantiated with its production default. Used
 * by tests that want to pass a spy/fake for one or more collaborators without
 * touching the rest, and by the test-deps hatch below.
 */
export interface AIChatDeps {
  provider?: AIProvider | null;
  contextManager?: ContextManager;
  rateLimiter?: RateLimiter;
  tokenTracker?: TokenTracker;
  sessionManager?: SessionManager | null;
  socialTracker?: SocialTracker;
  moodEngine?: MoodEngine;
  ambientEngine?: AmbientEngine | null;
  state?: PluginState;
}

let contextManager: ContextManager | null = null;
let rateLimiter: RateLimiter | null = null;
let tokenTracker: TokenTracker | null = null;
let sessionManager: SessionManager | null = null;
let provider: AIProvider | null = null;
let socialTracker: SocialTracker | null = null;
let ambientEngine: AmbientEngine | null = null;
let moodEngine: MoodEngine | null = null;
let state: PluginState | null = null;
/** Periodic timer that expires idle game sessions. */
let sessionExpiryInterval: ReturnType<typeof setInterval> | null = null;
let gamesDir: string = '';
/**
 * Per-channel timestamp of the last "API rate-limited" op-notice we sent.
 * Debounces the notice so a flood of triggered messages during an outage
 * doesn't spam every op once per attempt. Cleared on teardown.
 */
const lastRateLimitOpNoticeAt = new Map<string, number>();
const RATE_LIMIT_OP_NOTICE_COOLDOWN_MS = 5 * 60_000;

/**
 * Max bytes of channel text allowed into in-memory buffers (context, social
 * tracker, session). Caps nick-rotation / multiline-capable-server floods
 * from bloating unbounded state; response output is capped separately by
 * `output.maxLines * output.maxLineLength`.
 */
const MAX_ENTRY_BYTES = 2048;
function truncateForBuffer(text: string): string {
  return text.length > MAX_ENTRY_BYTES ? text.slice(0, MAX_ENTRY_BYTES) + '…' : text;
}

// ---------------------------------------------------------------------------
// Typed config accessors
// ---------------------------------------------------------------------------

interface AiChatConfig {
  provider: string;
  /** Resolved from `api_key_env` by the plugin loader. Empty string → degraded mode. */
  apiKey: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  character: string;
  charactersDir: string;
  channelCharacters: Record<string, string | { character?: string; language?: string }>;
  triggers: TriggerConfig;
  context: { maxMessages: number; maxTokens: number; ttlMs: number };
  rateLimits: {
    userBurst: number;
    userRefillSeconds: number;
    globalRpm: number;
    globalRpd: number;
    rpmBackpressurePct: number;
    ambientPerChannelPerHour: number;
    ambientGlobalPerHour: number;
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
  channelProfiles: Record<
    string,
    { topic?: string; culture?: string; role?: string; depth?: string }
  >;
  ambient: {
    enabled: boolean;
    idle: { afterMinutes: number; chance: number; minUsers: number };
    unansweredQuestions: { enabled: boolean; waitSeconds: number };
    chattiness: number;
    interests: string[];
    eventReactions: { joinWb: boolean; topicChange: boolean };
  };
  security: {
    privilegeGating: boolean;
    privilegedModeThreshold: string;
    privilegedRequiredFlag: string;
    disableWhenPrivileged: boolean;
    /**
     * Refuse to respond in any channel where the bot holds ChanServ founder
     * access. Enforced by reading the `chanserv_access` chanset (written by
     * chanmod auto-detect or manual override). Checked at both trigger time
     * and post time so a probe that resolves between the two still blocks.
     */
    disableWhenFounder: boolean;
  };
  sessions: { enabled: boolean; inactivityMs: number; gamesDir: string };
  ollama: {
    baseUrl: string;
    requestTimeoutMs: number;
    useServerTokenizer: boolean;
  };
}

export function parseConfig(raw: Record<string, unknown>): AiChatConfig {
  const triggers = asRecord(raw.triggers);
  const context = asRecord(raw.context);
  const rl = asRecord(raw.rate_limits);
  const tb = asRecord(raw.token_budgets);
  const perm = asRecord(raw.permissions);
  const output = asRecord(raw.output);
  const channelCharacters = asRecord(raw.channel_characters);

  return {
    provider: asString(raw.provider, 'gemini'),
    apiKey: asString(raw.api_key, ''),
    model: asString(raw.model, 'gemini-2.5-flash-lite'),
    temperature: asNum(raw.temperature, 0.9),
    maxOutputTokens: asNum(raw.max_output_tokens, 256),
    character: asString(raw.character, 'friendly'),
    charactersDir: asString(raw.characters_dir, 'characters'),
    channelCharacters: channelCharacters as AiChatConfig['channelCharacters'],
    channelProfiles: asRecord(raw.channel_profiles) as AiChatConfig['channelProfiles'],
    triggers: {
      directAddress: asBool(triggers.direct_address, true),
      command: asBool(triggers.command, true),
      commandPrefix: asString(triggers.command_prefix, '!ai'),
      keywords: asStringArr(triggers.keywords, []),
      randomChance: asNum(triggers.random_chance, 0),
      engagementSeconds: asNum(triggers.engagement_seconds, 60),
    },
    context: {
      maxMessages: asNum(context.max_messages, 50),
      maxTokens: asNum(context.max_tokens, 4000),
      ttlMs: asNum(context.ttl_minutes, 60) * 60_000,
    },
    rateLimits: {
      userBurst: asNum(rl.user_burst, 3),
      userRefillSeconds: asNum(rl.user_refill_seconds, 12),
      globalRpm: asNum(rl.global_rpm, 10),
      globalRpd: asNum(rl.global_rpd, 800),
      rpmBackpressurePct: asNum(rl.rpm_backpressure_pct, 80),
      ambientPerChannelPerHour: asNum(rl.ambient_per_channel_per_hour, 5),
      ambientGlobalPerHour: asNum(rl.ambient_global_per_hour, 20),
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
    ambient: (() => {
      const a = asRecord(raw.ambient);
      const idle = asRecord(a.idle);
      const uq = asRecord(a.unanswered_questions);
      const er = asRecord(a.event_reactions);
      return {
        enabled: asBool(a.enabled, false),
        idle: {
          afterMinutes: asNum(idle.after_minutes, 15),
          chance: asNum(idle.chance, 0.3),
          minUsers: asNum(idle.min_users, 2),
        },
        unansweredQuestions: {
          enabled: asBool(uq.enabled, true),
          waitSeconds: asNum(uq.wait_seconds, 90),
        },
        chattiness: asNum(a.chattiness, 0.08),
        interests: asStringArr(a.interests, []),
        eventReactions: {
          joinWb: asBool(er.join_wb, false),
          topicChange: asBool(er.topic_change, false),
        },
      };
    })(),
    security: (() => {
      const sec = asRecord(raw.security);
      return {
        privilegeGating: asBool(sec.privilege_gating, false),
        privilegedModeThreshold: asString(sec.privileged_mode_threshold, 'h'),
        privilegedRequiredFlag: asString(sec.privileged_required_flag, 'm'),
        disableWhenPrivileged: asBool(sec.disable_when_privileged, false),
        disableWhenFounder: asBool(sec.disable_when_founder, true),
      };
    })(),
    sessions: {
      enabled: asBool(asRecord(raw.sessions).enabled, true),
      inactivityMs: asNum(asRecord(raw.sessions).inactivity_timeout_minutes, 10) * 60_000,
      gamesDir: asString(asRecord(raw.sessions).games_dir, 'games'),
    },
    ollama: (() => {
      const o = asRecord(raw.ollama);
      return {
        baseUrl: asString(o.base_url, 'http://127.0.0.1:11434'),
        requestTimeoutMs: asNum(o.request_timeout_ms, 60_000),
        useServerTokenizer: asBool(o.use_server_tokenizer, false),
      };
    })(),
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

/**
 * Build an AIProviderConfig for the configured provider, or return null to
 * signal degraded mode (provider couldn't be initialized). Each provider
 * branch pulls only the fields it understands — Gemini needs `apiKey`,
 * Ollama needs `baseUrl`. A missing required field logs a clear warning and
 * drops the provider instead of throwing, mirroring the prior behaviour
 * where a missing API key put the plugin in degraded mode.
 */
function buildProviderConfig(
  cfg: AiChatConfig,
  warn: (msg: string) => void,
): AIProviderConfig | null {
  const base = {
    model: cfg.model,
    maxOutputTokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
  };
  switch (cfg.provider) {
    case 'gemini': {
      if (!cfg.apiKey) {
        warn(
          'No Gemini API key found (set api_key_env → HEX_GEMINI_API_KEY) — ' +
            'ai-chat plugin is in degraded mode (no LLM calls).',
        );
        return null;
      }
      return { ...base, apiKey: cfg.apiKey };
    }
    case 'ollama': {
      if (!cfg.ollama.baseUrl) {
        warn(
          'Ollama provider requires ollama.base_url — ai-chat plugin is in ' +
            'degraded mode (no LLM calls).',
        );
        return null;
      }
      return {
        ...base,
        baseUrl: cfg.ollama.baseUrl,
        requestTimeoutMs: cfg.ollama.requestTimeoutMs,
        useServerTokenizer: cfg.ollama.useServerTokenizer,
      };
    }
    default:
      warn(`Unknown ai-chat provider "${cfg.provider}" — plugin is in degraded mode.`);
      return null;
  }
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
  /**
   * Bot's resolved ChanServ access tier for this channel (from the
   * `chanserv_access` chanset). `undefined` when no channel context is
   * available (PM etc.). Used by the founder-disable gate.
   */
  botChanservAccess: string | undefined;
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

/**
 * Pure rule for the founder-disable gate. Exported for testing. A compromised
 * or prompt-injected response at founder tier can DROP the channel, transfer
 * founder to an attacker, or wipe the access list — none recoverable without
 * services-staff intervention — so we refuse to respond when the bot's
 * ChanServ tier for the channel reads `'founder'`. Only the affirmative
 * string matches; `undefined` / `'none'` / `'op'` / `'superop'` all permit.
 */
export function shouldBlockOnFounder(
  disableWhenFounder: boolean,
  channel: string | null,
  chanservAccess: string | undefined,
): boolean {
  if (!disableWhenFounder) return false;
  if (!channel) return false;
  // Normalise: defend against casing/whitespace drift if a non-chanmod path
  // ever writes chanserv_access without going through the allowedValues enum.
  return chanservAccess?.trim().toLowerCase() === 'founder';
}

function isFounderRestricted(ctx: ShouldRespondCtx): boolean {
  return shouldBlockOnFounder(
    ctx.config.security.disableWhenFounder,
    ctx.channel,
    ctx.botChanservAccess,
  );
}

/**
 * Reason a message was rejected. `'allowed'` means it passed every gate. The
 * other values name the specific gate that fired so the pubm-level debug log
 * can attribute drops without re-running each predicate.
 */
export type ShouldRespondReason =
  | 'allowed'
  | 'self'
  | 'bot_nick'
  | 'ignored'
  | 'no_flag'
  | 'privilege_restricted'
  | 'founder_restricted';

export function shouldRespondReason(ctx: ShouldRespondCtx): ShouldRespondReason {
  const nick = ctx.nick;
  if (nick.toLowerCase() === ctx.botNick.toLowerCase()) return 'self';
  if (
    isLikelyBot(nick, ctx.config.permissions.botNickPatterns, ctx.config.permissions.ignoreBots)
  ) {
    return 'bot_nick';
  }
  const hostmask = `${nick}!${ctx.ident}@${ctx.hostname}`;
  const fullIgnore = [...ctx.config.permissions.ignoreList, ...ctx.dynamicIgnoreList];
  if (isIgnored(nick, hostmask, fullIgnore)) return 'ignored';
  if (ctx.config.permissions.requiredFlag !== '-' && !ctx.hasRequiredFlag) return 'no_flag';
  if (isPrivilegeRestricted(ctx)) return 'privilege_restricted';
  if (isFounderRestricted(ctx)) return 'founder_restricted';
  return 'allowed';
}

export function shouldRespond(ctx: ShouldRespondCtx): boolean {
  return shouldRespondReason(ctx) === 'allowed';
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

/**
 * Read the bot's ChanServ access tier for a channel from the chanset written
 * by chanmod. Returns undefined for PMs and for channels chanmod has never
 * touched. Used by the founder-disable gate at both trigger and post time.
 */
function getBotChanservAccess(api: PluginAPI, channel: string | null): string | undefined {
  if (!channel) return undefined;
  return api.channelSettings.getString(channel, 'chanserv_access');
}

/**
 * Post-time fail-closed gate. Re-checks the founder condition right before we
 * publish to IRC, closing the race where the ChanServ probe resolves between
 * the trigger-time `shouldRespond` decision and the LLM round-trip completing.
 * Returns true when the response must be discarded. Logs the drop.
 */
function isFounderPostGate(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
  reason: string,
): boolean {
  const block = shouldBlockOnFounder(
    cfg.security.disableWhenFounder,
    channel,
    getBotChanservAccess(api, channel),
  );
  if (!block) return false;
  api.warn(
    `post-gate: dropped ${reason} response — bot is ChanServ founder in ${channel} ` +
      `(disable_when_founder is on; grant op/AOP instead, or disable this gate explicitly)`,
  );
  return true;
}

/**
 * Wrap a line-sender so every line is re-checked against `isFounderPostGate`
 * immediately before going to IRC. `sendLines()` uses setTimeout between
 * lines, so the chanserv-access state can flip mid-send even after the gate
 * passed at pipeline start — the point of the gate is to fail closed, and
 * this is the last line of defence. The warn fires at most once per send.
 */
function gatedSender(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
  reason: string,
  send: (line: string) => void,
): (line: string) => void {
  let dropped = false;
  return (line) => {
    if (dropped) return;
    if (isFounderPostGate(api, cfg, channel, reason)) {
      dropped = true;
      return;
    }
    send(line);
  };
}

// ---------------------------------------------------------------------------
// Engagement tracking — conversation stickiness
// ---------------------------------------------------------------------------

function isEngaged(channel: string, nick: string, windowMs: number): boolean {
  if (windowMs <= 0 || !state) return false;
  const key = `${channel.toLowerCase()}:${nick.toLowerCase()}`;
  const lastAt = state.engagement.get(key);
  if (lastAt === undefined) return false;
  return Date.now() - lastAt < windowMs;
}

const ENGAGEMENT_MAP_CAP = 1000;

function recordEngagement(channel: string, nick: string, engagementWindowMs: number): void {
  if (!state) return;
  const now = Date.now();
  const map = state.engagement;
  map.set(`${channel.toLowerCase()}:${nick.toLowerCase()}`, now);
  // TTL tied to the configured engagement window — entries older than that
  // are no longer functionally meaningful (isEngaged() would reject them).
  // Floor at 60s so a misconfigured 0 doesn't churn the map every insert.
  if (map.size >= ENGAGEMENT_MAP_CAP) {
    const ttlMs = Math.max(60_000, engagementWindowMs);
    const cutoff = now - ttlMs;
    for (const [k, t] of map) {
      if (t < cutoff) map.delete(k);
    }
  }
}

/**
 * One-line debug summary of a pubm decision. Lets `api.debug` show why a
 * given message was skipped or routed without dumping full context. Text is
 * truncated and quoted so newlines / control bytes can't smear log lines.
 */
function traceLine(
  ctx: HandlerContext,
  text: string,
  fields: { trigger: string; reason: ShouldRespondReason; action: string },
): string {
  const snippet = text.length > 60 ? text.slice(0, 60) + '…' : text;
  const safe = JSON.stringify(snippet);
  return (
    `pubm ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
    `trigger=${fields.trigger} gate=${fields.reason} → ${fields.action} text=${safe}`
  );
}

/**
 * Notice every +o user in `channel` (PM target ignored) that the AI provider
 * is rate-limited. Debounced per channel by `RATE_LIMIT_OP_NOTICE_COOLDOWN_MS`
 * so the bot doesn't flood ops with one notice per dropped message during an
 * outage. No-op when the channel has no current ops — better silent than
 * leaking the outage to non-ops by falling back to a public reply.
 */
function noticeOpsRateLimited(api: PluginAPI, channel: string | null, detail: string): void {
  if (!channel) return;
  const now = Date.now();
  const last = lastRateLimitOpNoticeAt.get(channel) ?? 0;
  if (now - last < RATE_LIMIT_OP_NOTICE_COOLDOWN_MS) return;

  const ops = api.getUsers(channel).filter((u) => u.modes.includes('o'));
  if (ops.length === 0) return;

  lastRateLimitOpNoticeAt.set(channel, now);
  const message = `[ai-chat] AI provider rate-limited in ${channel}: ${detail}`;
  for (const op of ops) {
    api.notice(op.nick, message);
  }
  api.debug(
    `op-notice rate_limit ch=${channel} ops=${ops.length} (${ops.map((u) => u.nick).join(',')})`,
  );
}

/** Build a SessionIdentity from a handler context for session identity gating. */
function makeSessionIdentity(ctx: HandlerContext): SessionIdentity {
  return {
    account: ctx.account ?? null,
    identHost: `${ctx.ident}@${ctx.hostname}`,
  };
}

// ---------------------------------------------------------------------------
// Ignore list (persisted in DB under ignore:<entry>)
// ---------------------------------------------------------------------------

const IGNORE_PREFIX = 'ignore:';
/** Soft cap on the persisted ignore list — cheap insurance against a script
 *  looping `.ai ignore`. Admin-gated so this is not a threat, just hygiene. */
const IGNORE_LIST_MAX = 1000;

function getDynamicIgnoreList(api: PluginAPI): string[] {
  return api.db.list(IGNORE_PREFIX).map((row) => row.key.substring(IGNORE_PREFIX.length));
}

function ignoreListSize(api: PluginAPI): number {
  return api.db.list(IGNORE_PREFIX).length;
}

// ---------------------------------------------------------------------------
// Character lookup
// ---------------------------------------------------------------------------

const CHARACTER_PREFIX = 'character:';

/** Render a channel profile string for prompt injection, or undefined if none configured. */
function renderChannelProfile(cfg: AiChatConfig, channel: string | null): string | undefined {
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

function activeCharacter(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
): { character: Character; language: string | undefined } {
  let name = cfg.character;
  let language: string | undefined;

  if (channel) {
    // Dynamic override (DB) first, then config.channel_characters
    // Also check for legacy personality:<channel> keys and migrate them
    const dynamic = api.db.get(`${CHARACTER_PREFIX}${channel.toLowerCase()}`);
    if (dynamic) {
      name = dynamic;
    } else {
      const legacy = api.db.get(`personality:${channel.toLowerCase()}`);
      if (legacy) {
        // One-time migration: move personality: → character:
        api.db.set(`${CHARACTER_PREFIX}${channel.toLowerCase()}`, legacy);
        api.db.del(`personality:${channel.toLowerCase()}`);
        name = legacy;
      } else {
        const entry =
          cfg.channelCharacters[channel] ?? cfg.channelCharacters[channel.toLowerCase()];
        if (typeof entry === 'string') name = entry;
        else if (entry && typeof entry === 'object') {
          if (typeof entry.character === 'string') name = entry.character;
          if (typeof entry.language === 'string') language = entry.language;
        }
      }
    }
  }

  return { character: getCharacter(state?.characters ?? new Map(), name), language };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export async function init(api: PluginAPI, deps: unknown = {}): Promise<void> {
  const cfg = parseConfig(api.config);
  // `deps` is typed as unknown at the plugin-loader boundary (the loader
  // forwards whatever the caller passed without inspecting it). Cast to the
  // narrow AIChatDeps here — the loader is the only caller that supplies a
  // value, and production callers pass nothing.
  const merged: AIChatDeps = (deps as AIChatDeps | undefined) ?? {};

  rateLimiter = merged.rateLimiter ?? new RateLimiter(cfg.rateLimits);
  tokenTracker = merged.tokenTracker ?? new TokenTracker(api.db, cfg.tokenBudgets);
  contextManager =
    merged.contextManager ??
    new ContextManager({
      maxMessages: cfg.context.maxMessages,
      maxTokens: cfg.context.maxTokens,
      ttlMs: cfg.context.ttlMs,
    });
  sessionManager =
    merged.sessionManager !== undefined
      ? merged.sessionManager
      : cfg.sessions.enabled
        ? new SessionManager(cfg.sessions.inactivityMs)
        : null;
  gamesDir = resolveGamesDir(cfg.sessions.gamesDir);

  // Periodic sweep: expire game sessions past the inactivity timeout. Without
  // this, sessions only expire lazily on the user's next message, so a user
  // who starts sessions in many channels and goes silent pins all that state
  // until plugin teardown.
  if (sessionManager) {
    sessionExpiryInterval = setInterval(() => {
      sessionManager?.expireInactive();
    }, 60_000);
  }

  // Plugin state: engagement map + loaded characters. When a test injects
  // state, we honour it as-is (including an empty characters map); when not
  // injected, build a fresh state and populate characters from disk.
  if (merged.state) {
    state = merged.state;
  } else {
    const charsDir = resolveCharactersDir(cfg.charactersDir);
    state = {
      engagement: new Map(),
      characters: loadCharacters(charsDir, (msg) => api.warn(msg)),
    };
  }
  api.log(
    `Loaded ${state.characters.size} character(s): ${[...state.characters.keys()].join(', ')}`,
  );

  // Social tracker for channel activity + per-user interaction stats
  socialTracker = merged.socialTracker ?? new SocialTracker(api.db);

  // Mood engine for temporal variety
  moodEngine = merged.moodEngine ?? new MoodEngine();

  // Initialize provider
  if (merged.provider !== undefined) {
    provider = merged.provider;
    if (provider) api.log(`Using injected provider: ${provider.name}`);
  } else {
    provider = null;
    const providerConfig = buildProviderConfig(cfg, (msg) => api.warn(msg));
    if (providerConfig) {
      try {
        provider = await createResilientProvider(cfg.provider, providerConfig);
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
        `Subcommands (admin): stats, reset <nick>, ignore <nick>, unignore <nick>, clear, character [name]`,
        `Subcommands (anyone): characters, model`,
      ],
      category: 'ai',
    },
  ]);

  api.log(
    `Loaded ai-chat v${version} provider=${cfg.provider} model=${cfg.model} ` +
      `(triggers direct:${cfg.triggers.directAddress} cmd:${cfg.triggers.command})`,
  );

  // -----------------------------------------------------------------------
  // Ambient participation engine
  // -----------------------------------------------------------------------
  if (merged.ambientEngine !== undefined) {
    ambientEngine = merged.ambientEngine;
  } else if (cfg.ambient.enabled) {
    ambientEngine = new AmbientEngine(cfg.ambient, socialTracker, Date.now, (msg) => api.warn(msg));
  }
  if (ambientEngine && cfg.ambient.enabled) {
    ambientEngine.start(async (channel, kind, prompt) => {
      if (!rateLimiter || !rateLimiter.checkAmbient(channel)) return;
      const { character, language } = activeCharacter(api, cfg, channel);
      if (!provider || !contextManager || !tokenTracker) return;

      const maxOutputTokens = Math.min(
        character.generation?.maxOutputTokens ?? cfg.maxOutputTokens,
        128, // ambient messages use shorter output
      );

      const assistantCfg: AssistantConfig = {
        maxLines: cfg.output.maxLines,
        maxLineLength: cfg.output.maxLineLength,
        interLineDelayMs: cfg.output.interLineDelayMs,
        maxOutputTokens,
      };

      const promptCtx: PromptContext = {
        botNick: botNick(),
        channel,
        network: network(),
        users: api.getUsers(channel).map((u) => u.nick),
        language,
        channelProfile: renderChannelProfile(cfg, channel),
        mood: moodEngine?.renderMoodLine(),
      };

      const result = await respond(
        {
          nick: botNick(),
          channel,
          prompt,
          systemPrompt: character.prompt,
          promptContext: promptCtx,
          maxContextMessages: character.generation?.maxContextMessages,
        },
        { provider, rateLimiter, tokenTracker, contextManager, config: assistantCfg },
      );

      if (result.status === 'fantasy_dropped') {
        api.warn(
          `ambient ${kind}: dropped response containing fantasy-prefix line ${result.index}: ` +
            JSON.stringify(result.line.slice(0, 80)),
        );
      } else if (result.status === 'ok') {
        const styled = applyCharacterStyle(result.lines, {
          casing: character.style.casing,
          verbosity: character.style.verbosity,
        });
        if (isFounderPostGate(api, cfg, channel, `ambient ${kind}`)) return;
        rateLimiter.recordAmbient(channel);
        contextManager.addMessage(channel, botNick(), styled.join(' '), true);
        socialTracker?.onMessage(channel, botNick(), styled.join(' '), true);
        api.log(
          `ambient ${kind} channel=${channel} character=${character.name} lines=${styled.length}`,
        );
        await sendLines(
          styled,
          gatedSender(api, cfg, channel, `ambient ${kind}`, (line) => api.say(channel, line)),
          cfg.output.interLineDelayMs,
        );
      }
    });

    // Register join/topic binds for event reactions
    // (part/kick cleanup is registered unconditionally below.)
    if (cfg.ambient.eventReactions.joinWb) {
      api.bind('join', '-', '*', (ctx: HandlerContext) => {
        if (!ctx.channel) return;
        if (ctx.nick.toLowerCase() === botNick().toLowerCase()) return;
        ambientEngine?.onJoin(ctx.channel, ctx.nick);
      });
    }
    if (cfg.ambient.eventReactions.topicChange) {
      api.bind('topic', '-', '*', (ctx: HandlerContext) => {
        if (!ctx.channel) return;
        // Skip bot-initiated topic changes — otherwise a .topic from REPL or
        // chanmod topic-recovery would trigger an ambient reaction to the
        // bot's own edit.
        if (ctx.nick.toLowerCase() === botNick().toLowerCase()) return;
        ambientEngine?.onTopic(ctx.channel, ctx.nick, ctx.text);
      });
    }

    api.log(`Ambient participation enabled (chattiness=${cfg.ambient.chattiness})`);
  }

  // Drop per-channel state when the bot itself leaves — otherwise social
  // tracker and context buffers accumulate dead channels forever.
  api.bind('part', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!api.isBotNick(ctx.nick)) return;
    socialTracker?.dropChannel(ctx.channel);
    contextManager?.clearContext(ctx.channel);
  });
  api.bind('kick', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!api.isBotNick(ctx.nick)) return;
    socialTracker?.dropChannel(ctx.channel);
    contextManager?.clearContext(ctx.channel);
  });

  // -----------------------------------------------------------------------
  // pubm * — context feed + non-command trigger detection
  // -----------------------------------------------------------------------
  api.bind('pubm', '-', '*', async (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    // Cap message bytes before any in-memory buffer sees them.
    const text = truncateForBuffer(ctx.text);

    // Feed every non-bot channel message into the context buffer.
    const isBotMsg = ctx.nick.toLowerCase() === botNick().toLowerCase();
    if (!isBotMsg) {
      contextManager!.addMessage(ctx.channel, ctx.nick, text, false);
    }

    // Compute the shouldRespond gate once — we use it both to decide whether
    // to run the pipeline AND to gate social tracking. Gating social tracking
    // closes the bypass where an ignored user's question would otherwise land
    // in `pendingQuestions` and be amplified by the ambient LLM path.
    const baseShouldRespondCtx = {
      nick: ctx.nick,
      ident: ctx.ident,
      hostname: ctx.hostname,
      channel: ctx.channel,
      botNick: botNick(),
      hasRequiredFlag: api.permissions.checkFlags(cfg.permissions.requiredFlag, ctx),
      hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
      botChannelModes: getBotChannelModes(api, ctx.channel),
      botChanservAccess: getBotChanservAccess(api, ctx.channel),
      config: cfg,
      dynamicIgnoreList: getDynamicIgnoreList(api),
    };
    const reason = shouldRespondReason(baseShouldRespondCtx);
    const allowed = reason === 'allowed';

    // Ambient engine tracks every channel it sees activity in, so that
    // join/topic reactions know the channel exists. Social-tracker state
    // (activity level, pending questions, user stats), on the other hand,
    // only counts senders we'd respond to — ignored users don't feed the
    // unanswered-question amplification path.
    ambientEngine?.onChannelActivity(ctx.channel);
    if (isBotMsg || allowed) {
      socialTracker?.onMessage(ctx.channel, ctx.nick, text, isBotMsg);
    }

    // Let the pub `!ai` handler own the command trigger.
    const cmdPrefix = cfg.triggers.commandPrefix.toLowerCase();
    const lowerText = text.trim().toLowerCase();
    if (
      cfg.triggers.command &&
      (lowerText === cmdPrefix || lowerText.startsWith(cmdPrefix + ' '))
    ) {
      api.debug(traceLine(ctx, text, { trigger: 'command', reason, action: 'defer-to-pub' }));
      return;
    }

    // If user is in a session in this channel, route message as a game move.
    const identity = makeSessionIdentity(ctx);
    if (
      sessionManager &&
      !isBotMsg &&
      sessionManager.isInSession(ctx.nick, ctx.channel, identity)
    ) {
      if (!allowed) {
        api.debug(traceLine(ctx, text, { trigger: 'session', reason, action: 'skip' }));
        return;
      }
      api.debug(traceLine(ctx, text, { trigger: 'session', reason, action: 'session' }));
      await runSessionPipeline(api, cfg, ctx, text, botNick(), network());
      return;
    }

    let match = detectTrigger(text, botNick(), cfg.triggers);
    // Engagement fallback: if no trigger matched but the user recently talked
    // to the bot, treat this as a conversation continuation.
    if (
      !match &&
      ctx.channel &&
      isEngaged(ctx.channel, ctx.nick, cfg.triggers.engagementSeconds * 1_000)
    ) {
      match = { kind: 'engaged', prompt: text.trim() };
    }
    if (!match) {
      if (!isBotMsg) {
        api.debug(traceLine(ctx, text, { trigger: 'none', reason, action: 'skip' }));
      }
      return;
    }
    if (match.kind === 'command') return;

    if (!allowed) {
      api.debug(traceLine(ctx, text, { trigger: match.kind, reason, action: 'skip' }));
      return;
    }

    api.debug(traceLine(ctx, text, { trigger: match.kind, reason, action: 'pipeline' }));
    const hasAdmin = api.permissions.checkFlags(cfg.permissions.adminFlag, ctx);
    await runPipeline(api, cfg, ctx, match.prompt, botNick(), network(), false, hasAdmin);
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
        // Self-talk / bot-loop guard: the pubm bind has these checks, but a
        // relayed event or test-harness replay could feed the bot's own nick
        // into the pub handler. Admin subcommands run in here, so a match
        // between the bot's own hostmask and the admin flag would let the
        // bot execute its own ignore/reset/character commands.
        if (ctx.nick.toLowerCase() === botNick().toLowerCase()) return;
        if (isLikelyBot(ctx.nick, cfg.permissions.botNickPatterns, cfg.permissions.ignoreBots)) {
          return;
        }
        const text = truncateForBuffer(ctx.text);
        contextManager!.addMessage(ctx.channel, ctx.nick, text, false);

        const args = truncateForBuffer(ctx.args).trim();

        // Admin + info subcommands
        if (await handleSubcommand(api, cfg, ctx, args)) return;

        const prompt = args;
        if (!prompt) {
          ctx.reply(`Usage: ${cfg.triggers.commandPrefix} <message>`);
          return;
        }
        const cmdReason = shouldRespondReason({
          nick: ctx.nick,
          ident: ctx.ident,
          hostname: ctx.hostname,
          channel: ctx.channel,
          botNick: botNick(),
          hasRequiredFlag: true,
          hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
          botChannelModes: getBotChannelModes(api, ctx.channel),
          botChanservAccess: getBotChanservAccess(api, ctx.channel),
          config: cfg,
          dynamicIgnoreList: getDynamicIgnoreList(api),
        });
        if (cmdReason !== 'allowed') {
          api.debug(
            traceLine(ctx, text, { trigger: 'command', reason: cmdReason, action: 'skip' }),
          );
          return;
        }
        api.debug(
          traceLine(ctx, text, { trigger: 'command', reason: cmdReason, action: 'pipeline' }),
        );
        const cmdAdmin = api.permissions.checkFlags(cfg.permissions.adminFlag, ctx);
        await runPipeline(api, cfg, ctx, prompt, botNick(), network(), true, cmdAdmin);
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
  isAdmin = false,
): Promise<void> {
  if (!rateLimiter || !tokenTracker || !contextManager) return;

  const { character, language } = activeCharacter(api, cfg, ctx.channel);

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
    users: ctx.channel ? api.getUsers(ctx.channel).map((u) => u.nick) : undefined,
    language,
    channelProfile: renderChannelProfile(cfg, ctx.channel),
    mood: moodEngine?.renderMoodLine(),
  };

  // Use per-character context window if specified
  const maxContextMessages = character.generation?.maxContextMessages;
  const result = await respond(
    {
      nick: ctx.nick,
      channel: ctx.channel,
      prompt,
      systemPrompt: character.prompt,
      promptContext: promptCtx,
      maxContextMessages,
      isAdmin,
    },
    { provider, rateLimiter, tokenTracker, contextManager, config: assistantCfg },
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
        noticeOpsRateLimited(api, ctx.channel, result.message);
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
      // Apply character style (casing, verbosity enforcement)
      const styled = applyCharacterStyle(result.lines, {
        casing: character.style.casing,
        verbosity: character.style.verbosity,
      });
      contextManager.addMessage(ctx.channel, botNick, styled.join(' '), true);
      // Record engagement so the user's next messages are treated as continuations
      if (ctx.channel) {
        recordEngagement(ctx.channel, ctx.nick, cfg.triggers.engagementSeconds * 1000);
      }
      socialTracker?.recordBotInteraction(ctx.nick);
      api.log(
        `response sent channel=${ctx.channel ?? '(unknown)'} nick=${ctx.nick} ` +
          `character=${character.name} lines=${styled.length} in=${result.tokensIn} out=${result.tokensOut}`,
      );
      await sendLines(
        styled,
        gatedSender(api, cfg, ctx.channel, 'pipeline', (line) => ctx.reply(line)),
        cfg.output.interLineDelayMs,
      );
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
  if (!rateLimiter || !tokenTracker || !sessionManager || !provider) return;
  const session = sessionManager.getSession(ctx.nick, ctx.channel, makeSessionIdentity(ctx));
  if (!session) return;

  const userKey = ctx.nick.toLowerCase();
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
  if (!tokenTracker.canSpend(ctx.nick, estimate)) {
    ctx.replyPrivate('Daily token budget exceeded — try again tomorrow.');
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
    await sendLines(
      lines,
      gatedSender(api, cfg, ctx.channel, 'session', (line) => ctx.reply(line)),
      cfg.output.interLineDelayMs,
    );
  } catch (err) {
    const kind = isAIProviderError(err) ? err.kind : 'other';
    const message = err instanceof Error ? err.message : String(err);
    api.error(`session provider error (${kind}): ${message}`);
    if (kind === 'rate_limit') {
      noticeOpsRateLimited(api, ctx.channel, message);
    } else {
      ctx.reply('AI is temporarily unavailable.');
    }
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
      ctx.reply(`Reset token usage for ${api.stripFormatting(target)}.`);
      return true;
    }
    case 'ignore': {
      if (!hasAdmin) return true;
      const target = subArgs;
      if (!target) {
        ctx.reply('Usage: !ai ignore <nick|hostmask>');
        return true;
      }
      // Shape + length validation: the target becomes a DB key that every
      // subsequent channel message scans via isIgnored(). An unvalidated
      // insert path is a slow-loris on the check loop (and a key-space
      // fill attack).
      if (target.length > 128 || !/^[$#&]?[\w[\]\\`^{}*?@!.-]+$/.test(target)) {
        ctx.reply('Invalid ignore target.');
        return true;
      }
      // Only count toward the cap if this is a new entry — re-ignoring an
      // existing target is a no-op and shouldn't be refused.
      const existing = api.db.get(`${IGNORE_PREFIX}${target}`);
      if (existing === undefined && ignoreListSize(api) >= IGNORE_LIST_MAX) {
        ctx.reply(
          `Ignore list is full (${IGNORE_LIST_MAX} entries). Remove entries with "!ai unignore".`,
        );
        return true;
      }
      api.db.set(`${IGNORE_PREFIX}${target}`, '1');
      ctx.reply(`Now ignoring "${api.stripFormatting(target)}".`);
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
      ctx.reply(`No longer ignoring "${api.stripFormatting(target)}".`);
      return true;
    }
    case 'clear': {
      if (!hasAdmin) return true;
      if (ctx.channel) contextManager!.clearContext(ctx.channel);
      ctx.reply('Channel context cleared.');
      return true;
    }
    case 'character': {
      if (!subArgs) {
        const active = activeCharacter(api, cfg, ctx.channel);
        ctx.reply(
          `Character: ${active.character.name}${active.language ? ` (${active.language})` : ''}`,
        );
        return true;
      }
      if (!hasAdmin) return true;
      const name = subArgs.toLowerCase();
      const charMap = state?.characters ?? new Map();
      if (!charMap.has(name)) {
        ctx.reply(
          `Unknown character: ${api.stripFormatting(subArgs)}. ` +
            `Available: ${[...charMap.keys()].join(', ')}`,
        );
        return true;
      }
      if (ctx.channel) {
        api.db.set(`${CHARACTER_PREFIX}${ctx.channel.toLowerCase()}`, name);
        ctx.reply(`Character set to ${api.stripFormatting(name)} for ${ctx.channel}.`);
      }
      return true;
    }
    case 'characters': {
      const charMap = state?.characters ?? new Map();
      ctx.reply(`Available: ${[...charMap.keys()].join(', ')}`);
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
      // Gate session creation on the same rules as the normal response path.
      // Without this check, an ignored or founder-blocked user could spin up
      // partial session state and trigger post-time-gate noise on every turn.
      const allowed = shouldRespond({
        nick: ctx.nick,
        ident: ctx.ident,
        hostname: ctx.hostname,
        channel: ctx.channel,
        botNick: api.botConfig.irc.nick,
        hasRequiredFlag: api.permissions.checkFlags(cfg.permissions.requiredFlag, ctx),
        hasPrivilegedFlag: api.permissions.checkFlags(cfg.security.privilegedRequiredFlag, ctx),
        botChannelModes: getBotChannelModes(api, ctx.channel),
        botChanservAccess: getBotChanservAccess(api, ctx.channel),
        config: cfg,
        dynamicIgnoreList: getDynamicIgnoreList(api),
      });
      if (!allowed) {
        ctx.reply('AI chat is disabled here.');
        return true;
      }
      sessionManager.createSession(ctx.nick, ctx.channel, game, prompt, makeSessionIdentity(ctx));
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
  if (sessionExpiryInterval) {
    clearInterval(sessionExpiryInterval);
    sessionExpiryInterval = null;
  }
  rateLimiter?.reset();
  sessionManager?.clear();
  ambientEngine?.stop();
  socialTracker?.clear();
  rateLimiter = null;
  tokenTracker = null;
  contextManager = null;
  sessionManager = null;
  provider = null;
  socialTracker = null;
  ambientEngine = null;
  moodEngine = null;
  state = null;
  gamesDir = '';
  lastRateLimitOpNoticeAt.clear();
}

// Re-export so Phase 6 tests can still access the formatter.
export { formatResponse };
