// ai-chat — AI-powered chat plugin.
// Feeds channel messages into a sliding context window and responds via an
// AI provider adapter (currently Gemini).
import type { HandlerContext, PluginAPI } from '../../src/types';
import { AmbientEngine } from './ambient';
import { type AssistantConfig, type PromptContext, respond } from './assistant';
import { getCharacter, loadCharacters, resolveCharactersDir } from './character-loader';
import type { Character } from './characters/types';
import { ProviderSemaphore } from './concurrency';
import { type AiChatConfig, buildProviderConfig, parseConfig } from './config';
import { ContextManager } from './context-manager';
import { EngagementTracker } from './engagement-tracker';
import { listGames, loadGamePrompt, resolveGamesDir } from './games-loader';
import { IterStats } from './iter-stats';
import { type CoalescedMessage, MessageCoalescer } from './message-coalescer';
import { MoodEngine } from './mood';
import { applyCharacterStyle, formatResponse } from './output-formatter';
import {
  getBotChannelModes,
  getBotChanservAccess,
  isFounderPostGate,
  postGateFor,
  shouldRespond,
  shouldRespondReason,
  traceLine,
} from './permission-gates';
import {
  type PipelineDeps,
  hasRecentBotInteraction,
  renderChannelProfile,
  runPipeline,
  runSessionPipeline,
} from './pipeline';
import { createResilientProvider } from './providers';
import type { AIProvider, SamplingOptions } from './providers/types';
import { RateLimiter } from './rate-limiter';
import { type SocialSnapshot, decideReply } from './reply-policy';
import { sendLinesGated } from './sender';
import { type SessionIdentity, SessionManager } from './session-manager';
import { SocialTracker } from './social-tracker';
import { TokenTracker } from './token-tracker';
import { detectTrigger, isIgnored, isLikelyBot } from './triggers';

// Re-export parseConfig so the index.ts public surface is unchanged after the
// config extraction. Callers that pre-extraction imported it from index.ts
// (none in-tree, but external plugin harnesses might) continue to work.
export { parseConfig } from './config';

// Re-exports preserve the pre-split index.ts public surface (tests import
// `shouldRespond` and `shouldBlockOnFounder` from the plugin entry).
export { shouldBlockOnFounder, shouldRespond } from './permission-gates';

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
  iterStats?: IterStats;
  semaphore?: ProviderSemaphore | null;
  sessionManager?: SessionManager | null;
  socialTracker?: SocialTracker;
  moodEngine?: MoodEngine;
  ambientEngine?: AmbientEngine | null;
  engagementTracker?: EngagementTracker;
  coalescer?: MessageCoalescer | null;
  state?: PluginState;
}

let contextManager: ContextManager | null = null;
let rateLimiter: RateLimiter | null = null;
let tokenTracker: TokenTracker | null = null;
let semaphore: ProviderSemaphore | null = null;
let iterStats: IterStats | null = null;
let sessionManager: SessionManager | null = null;
let provider: AIProvider | null = null;
let socialTracker: SocialTracker | null = null;
let ambientEngine: AmbientEngine | null = null;
let moodEngine: MoodEngine | null = null;
let engagementTracker: EngagementTracker | null = null;
let coalescer: MessageCoalescer | null = null;
let state: PluginState | null = null;
/** Periodic timer that expires idle game sessions. */
let sessionExpiryInterval: ReturnType<typeof setInterval> | null = null;
/**
 * Aborted in {@link teardown} to cut short every drip-fed sendLines chain
 * and the ambient sender closure at its await boundaries. Without this, a
 * reload during a 5-line response with a 500ms inter-line gap would hold
 * the captured `ctx.reply` / `api.say` closures (and the IRC client behind
 * them) alive for up to 2s after the plugin was unloaded.
 */
let teardownController: AbortController | null = null;
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
  return text.length > MAX_ENTRY_BYTES ? text.slice(0, MAX_ENTRY_BYTES) + '...' : text;
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

/**
 * Translate a character's generation block into SamplingOptions for the
 * ambient-path respond() call. Mirrors `buildSamplingOptions` in
 * pipeline.ts — kept local to avoid a cross-module import for a two-line
 * helper, and because ambient may diverge later (e.g. override temperature
 * down for unprompted turns).
 */
function buildAmbientSampling(character: Character): SamplingOptions | undefined {
  const gen = character.generation;
  if (!gen) return undefined;
  const out: SamplingOptions = {};
  if (typeof gen.temperature === 'number') out.temperature = gen.temperature;
  if (typeof gen.topP === 'number') out.topP = gen.topP;
  if (typeof gen.repeatPenalty === 'number') out.repeatPenalty = gen.repeatPenalty;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build a SessionIdentity from a handler context for session identity gating. */
function makeSessionIdentity(ctx: HandlerContext): SessionIdentity {
  return {
    account: ctx.account ?? null,
    identHost: `${ctx.ident}@${ctx.hostname}`,
  };
}

/**
 * Snapshot the current module-scope refs into a `PipelineDeps` bundle so
 * pipeline.ts doesn't need direct access to this file's `let` state. Built
 * fresh per call — cheap (one object allocation) and avoids the hazard of
 * a cached bundle holding stale refs across teardown/init cycles.
 */
function buildPipelineDeps(api: PluginAPI, cfg: AiChatConfig): PipelineDeps {
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
    semaphore,
    activeCharacter: (channel) => activeCharacter(api, cfg, channel),
    makeSessionIdentity,
    noticeOpsRateLimited: (channel, detail) => noticeOpsRateLimited(api, channel, detail),
    teardownSignal: () => teardownController?.signal,
  };
}

// ---------------------------------------------------------------------------
// Ignore list (persisted in DB under ignore:<entry>)
// ---------------------------------------------------------------------------

/** DB key prefix for the persisted ignore list. Each entry is `ignore:<nick-or-hostmask>`
 *  with value `'1'` (presence is the signal; value is unused). */
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

/** DB key prefix for per-channel character overrides set via `!ai character <name>`.
 *  Looked up before falling back to `config.channelCharacters`, so admin overrides
 *  win over operator config without a reload. Migrated lazily from the legacy
 *  `personality:<channel>` key on first read. */
const CHARACTER_PREFIX = 'character:';

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
        // Try the channel name as-given first, then lowercase, so an operator
        // who wrote `"#Foo": "bar"` in JSON still matches when irc-framework
        // hands us the channel as `#foo`. The DB keys above are lowercased
        // unconditionally; only the JSON config tolerates mixed case.
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
  const cfg = parseConfig(api.settings.bootConfig, (msg) => api.warn(msg));
  // `deps` is typed as unknown at the plugin-loader boundary (the loader
  // forwards whatever the caller passed without inspecting it). Cast to the
  // narrow AIChatDeps here — the loader is the only caller that supplies a
  // value, and production callers pass nothing.
  const merged: AIChatDeps = (deps as AIChatDeps | undefined) ?? {};

  teardownController = new AbortController();
  rateLimiter = merged.rateLimiter ?? new RateLimiter(cfg.rateLimits);
  tokenTracker = merged.tokenTracker ?? new TokenTracker(api.db, cfg.tokenBudgets);
  semaphore = merged.semaphore ?? new ProviderSemaphore(cfg.input.maxInflight);
  iterStats = merged.iterStats ?? new IterStats();
  contextManager =
    merged.contextManager ??
    new ContextManager({
      maxMessages: cfg.context.maxMessages,
      maxTokens: cfg.context.maxTokens,
      ttlMs: cfg.context.ttlMs,
      pruneStrategy: cfg.context.pruneStrategy,
      maxMessageChars: cfg.context.maxMessageChars,
    });
  sessionManager =
    merged.sessionManager !== undefined
      ? merged.sessionManager
      : cfg.sessions.enabled
        ? new SessionManager(cfg.sessions.inactivityMs)
        : null;
  gamesDir = resolveGamesDir(cfg.sessions.gamesDir);

  // 60s tick: matches the granularity of the inactivity timeout (operator
  // configures it in minutes), so worst-case lag between expiry-deserved and
  // expiry-applied is one tick.
  // Periodic sweep: expire game sessions past the inactivity timeout. Without
  // this, sessions only expire lazily on the user's next message, so a user
  // who starts sessions in many channels and goes silent pins all that state
  // until plugin teardown. Wrap in try/catch so a SessionManager regression
  // (e.g. a persistence write that throws) can't bring down the plugin's
  // interval loop silently — the next tick will still fire.
  if (sessionManager) {
    sessionExpiryInterval = setInterval(() => {
      try {
        sessionManager?.expireInactive();
      } catch (err) {
        api.error('Session expiry sweep threw:', err);
      }
      // Drop empty TTL'd buffers from the context manager on the same
      // tick — without this, an idle channel's empty buffer survives
      // until the next addMessage to that channel.
      try {
        contextManager?.pruneAll();
      } catch (err) {
        api.error('Context manager pruneAll threw:', err);
      }
    }, 60_000);
  }

  // Plugin state: loaded characters. When a test injects state, we honor it
  // as-is (including an empty characters map); when not injected, build a
  // fresh state and populate characters from disk.
  if (merged.state) {
    state = merged.state;
  } else {
    const charsDir = resolveCharactersDir(cfg.charactersDir);
    state = {
      characters: loadCharacters(charsDir, (msg) => api.warn(msg)),
    };
  }
  api.log(
    `Loaded ${state.characters.size} character(s): ${[...state.characters.keys()].join(', ')}`,
  );

  // Engagement tracker — replaces the old timer-based engagement map.
  engagementTracker =
    merged.engagementTracker ??
    new EngagementTracker({
      softTimeoutMs: cfg.engagement.softTimeoutMs,
      hardCeilingMs: cfg.engagement.hardCeilingMs,
    });

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
    const providerConfig = buildProviderConfig(cfg, (msg) => api.warn(msg), {
      debug: (...args) => api.debug(...args),
      info: (...args) => api.log(...args),
      warn: (...args) => api.warn(...args),
      error: (...args) => api.error(...args),
    });
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
      usage: `${cfg.triggers.commandPrefix} <subcommand>`,
      description: `AI chat admin + game console (talk to the bot by nick to chat)`,
      detail: [
        `Anyone: help, character, characters, model, games`,
        `Admin:  stats, iter, ignore, unignore, clear, character <name>, play, endgame`,
        `Owner:  reset <nick>`,
      ],
      category: 'ai',
    },
  ]);

  api.log(
    `Loaded ai-chat v${version} provider=${cfg.provider} model=${cfg.model} ` +
      `(direct:${cfg.triggers.directAddress} roll:${cfg.triggers.randomChance} ` +
      `engagement=${cfg.engagement.softTimeoutMs / 60_000}m/${cfg.engagement.hardCeilingMs / 60_000}m)`,
  );

  // -----------------------------------------------------------------------
  // Ambient participation engine
  // -----------------------------------------------------------------------
  if (merged.ambientEngine !== undefined) {
    ambientEngine = merged.ambientEngine;
  } else if (cfg.ambient.enabled) {
    // Small models tend to ramble, echo the prompt, fabricate speakers, and
    // parrot catchphrase lists when speaking unprompted — every small-tier
    // pathology is amplified on an unprompted utterance. Warn loudly so the
    // operator knows the risk, but honor the explicit config.
    if (cfg.modelClass === 'small') {
      api.warn(
        `ambient.enabled=true on modelClass=small (model=${cfg.model}). Small ` +
          `models tend to ramble, echo prompts, and fabricate speakers when ` +
          `speaking unprompted. Upgrade to a 7B+ model (e.g. ` +
          `llama3.1:8b-instruct-q4_K_M) if ambient output looks off. ` +
          `Proceeding per explicit config.`,
      );
    }
    ambientEngine = new AmbientEngine(cfg.ambient, socialTracker, Date.now, (msg) => api.warn(msg));
  }
  if (ambientEngine && cfg.ambient.enabled) {
    ambientEngine.start(async (channel, kind, prompt) => {
      // Bail early if teardown already fired — the captured module refs may
      // be nullified after the next microtask and the sender holds them by
      // closure. Checked again after each await to catch a mid-flight reload.
      if (teardownController?.signal.aborted) return;
      if (!rateLimiter || !rateLimiter.checkAmbient(channel)) return;
      const { character, language } = activeCharacter(api, cfg, channel);
      if (!provider || !contextManager || !tokenTracker) return;

      const maxOutputTokens = Math.min(
        character.generation?.maxOutputTokens ?? cfg.maxOutputTokens,
        // 128-token ceiling for ambient: an unprompted utterance shouldn't
        // monologue. Caps both per-call cost and on-channel verbosity for
        // idle/unanswered/join-wb/topic emissions.
        128,
      );

      const assistantCfg: AssistantConfig = {
        maxLines: cfg.output.maxLines,
        maxLineLength: cfg.output.maxLineLength,
        interLineDelayMs: cfg.output.interLineDelayMs,
        maxOutputTokens,
        promptLeakThreshold: cfg.output.promptLeakThreshold,
      };

      const promptCtx: PromptContext = {
        botNick: botNick(),
        channel,
        network: network(),
        language,
        channelProfile: renderChannelProfile(cfg, channel),
        mood: moodEngine?.renderMoodLine(),
        persona: character.persona,
        styleNotes: character.style.notes,
        avoids: character.avoids,
      };

      const result = await respond(
        {
          nick: botNick(),
          channel,
          prompt,
          promptContext: promptCtx,
          maxContextMessages: character.generation?.maxContextMessages,
          sampling: buildAmbientSampling(character),
        },
        {
          provider,
          rateLimiter,
          tokenTracker,
          contextManager,
          config: assistantCfg,
          iterStats,
          semaphore,
        },
      );

      if (teardownController?.signal.aborted) return;
      if (!rateLimiter || !contextManager) return;

      if (result.status === 'fantasy_dropped') {
        api.warn(
          `ambient ${kind}: dropped response containing fantasy-prefix line ${result.index}: ` +
            JSON.stringify(result.line.slice(0, 80)),
        );
      } else if (result.status === 'prompt_leaked') {
        api.warn(
          `ambient ${kind} prompt_leaked channel=${channel} overlap=${result.overlap} ` +
            `preview=${JSON.stringify(result.preview.slice(0, 80))}`,
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
        await sendLinesGated(
          styled,
          postGateFor(api, cfg, channel),
          `ambient ${kind}`,
          (line) => api.say(channel, line),
          cfg.output.interLineDelayMs,
          teardownController?.signal,
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
  // tracker and context buffers accumulate dead channels forever. Non-bot
  // part/kick branches forget per-user residue (engagement, session, social
  // activeUsers) immediately instead of waiting on each tracker's TTL/cap
  // eviction.
  const onUserLeave = (channel: string, nick: string): void => {
    socialTracker?.forgetUser(channel, nick);
    engagementTracker?.endEngagement(channel, nick);
    sessionManager?.endSession(nick, channel);
    rateLimiter?.forgetUser(nick);
  };
  api.bind('part', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (api.isBotNick(ctx.nick)) {
      socialTracker?.dropChannel(ctx.channel);
      contextManager?.clearContext(ctx.channel);
      engagementTracker?.dropChannel(ctx.channel);
      rateLimiter?.forgetChannel(ctx.channel);
      lastRateLimitOpNoticeAt.delete(ctx.channel);
      return;
    }
    onUserLeave(ctx.channel, ctx.nick);
  });
  api.bind('kick', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (api.isBotNick(ctx.nick)) {
      socialTracker?.dropChannel(ctx.channel);
      contextManager?.clearContext(ctx.channel);
      engagementTracker?.dropChannel(ctx.channel);
      rateLimiter?.forgetChannel(ctx.channel);
      lastRateLimitOpNoticeAt.delete(ctx.channel);
      return;
    }
    onUserLeave(ctx.channel, ctx.nick);
  });
  // QUIT carries no channel — fan out to every channel the bot is in. The
  // forget* APIs are no-ops for channels the user wasn't tracked in, so
  // worst case is O(joinedChannels) Map.delete calls per QUIT. Without
  // this the per-nick stats sit until activity-window or LRU eviction.
  api.bind('quit', '-', '*', (ctx: HandlerContext) => {
    if (api.isBotNick(ctx.nick)) return;
    for (const channel of api.getJoinedChannels()) {
      onUserLeave(channel, ctx.nick);
    }
  });

  // -----------------------------------------------------------------------
  // pubm * — context feed, engagement updates, unified reply decision
  // -----------------------------------------------------------------------
  //
  // The handler splits into an eager prologue (cheap, idempotent things that
  // must fire per-fragment for liveness signaling) and a deferred body
  // (everything that touches context, trackers, or the AI pipeline). The
  // deferred body runs once per coalesced burst — see message-coalescer.ts
  // for the wire-fragment problem this solves.
  if (merged.coalescer !== undefined) {
    coalescer = merged.coalescer;
  } else if (!coalescer && cfg.input.coalesceWindowMs > 0) {
    // Byte cap aligned to `input.maxPromptChars` (bytes-aware worst case:
    // UTF-8 is up to 4 B/codepoint). Keeping the coalescer cap at or above
    // the pipeline's prompt cap ensures a burst that merges into a
    // still-accepted prompt isn't silently truncated inside the coalescer
    // before the pipeline cap ever gets a chance to run.
    const coalesceBytes = Math.max(1024, cfg.input.maxPromptChars * 4);
    coalescer = new MessageCoalescer(cfg.input.coalesceWindowMs, coalesceBytes);
  }

  /**
   * Per-message body — runs once per coalesced burst (or once per raw
   * message when coalescing is disabled). All the per-burst trackers and
   * the AI pipeline live here so a fragmented message produces one set of
   * side effects, not N.
   */
  const processIncomingMessage = async (
    ctx: HandlerContext,
    text: string,
    fragmentCount: number,
  ): Promise<void> => {
    if (!ctx.channel) return;

    // Feed the merged user message into the context buffer as one entry.
    contextManager?.addMessage(ctx.channel, ctx.nick, text, false);

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

    if (allowed) {
      socialTracker?.onMessage(ctx.channel, ctx.nick, text, false);
    }

    // Feed the engagement tracker on allowed channel messages. Engagement
    // state is IRC-floor semantics — done before the session and reply-
    // policy branches so a 3rd-party speaking always ends other users'
    // engagement even if we're about to skip this message for other reasons.
    const channelNicks = api.getUsers(ctx.channel).map((u) => u.nick);
    if (allowed && engagementTracker) {
      engagementTracker.onHumanMessage(ctx.channel, ctx.nick, text, channelNicks);
    }

    // If user is in a session in this channel, route message as a game move.
    const identity = makeSessionIdentity(ctx);
    if (sessionManager && sessionManager.isInSession(ctx.nick, ctx.channel, identity)) {
      if (!allowed) {
        api.debug(traceLine(ctx, text, { trigger: 'session', reason, action: 'skip' }));
        return;
      }
      api.debug(traceLine(ctx, text, { trigger: 'session', reason, action: 'session' }));
      await runSessionPipeline(
        api,
        cfg,
        buildPipelineDeps(api, cfg),
        ctx,
        text,
        botNick(),
        network(),
      );
      return;
    }

    if (!allowed) {
      api.debug(traceLine(ctx, text, { trigger: 'none', reason, action: 'skip' }));
      return;
    }

    // Unified reply decision.
    const { character } = activeCharacter(api, cfg, ctx.channel);
    // Merge the active character's topic triggers into the effective keyword
    // list. Plugin config keywords apply to every character; character-level
    // triggers are the topics *this* persona chimes in on.
    const effectiveTriggers: typeof cfg.triggers = {
      ...cfg.triggers,
      keywords: [...cfg.triggers.keywords, ...character.triggers],
    };
    const trigger = detectTrigger(text, botNick(), effectiveTriggers);
    const engaged = engagementTracker?.isEngaged(ctx.channel, ctx.nick) ?? false;
    const social: SocialSnapshot = {
      activity: socialTracker?.getActivity(ctx.channel) ?? 'slow',
      lastWasBot: socialTracker?.isLastMessageFromBot(ctx.channel) ?? false,
      recentBotInteraction: hasRecentBotInteraction(socialTracker, ctx.nick),
    };

    const decision = decideReply({
      text,
      trigger,
      engaged,
      social,
      characterChattiness: character.chattiness,
      randomChance: cfg.triggers.randomChance,
    });

    if (decision === 'skip') {
      api.debug(traceLine(ctx, text, { trigger: trigger?.kind ?? 'none', reason, action: 'skip' }));
      return;
    }

    const prompt = trigger?.prompt ?? text.trim();
    const fragNote = fragmentCount > 1 ? ` coalesced=${fragmentCount}` : '';
    api.debug(
      traceLine(ctx, text, {
        trigger: trigger?.kind ?? decision,
        reason,
        action: `pipeline:${decision}${fragNote}`,
      }),
    );
    const hasAdmin = api.permissions.checkFlags(cfg.permissions.adminFlag, ctx);
    await runPipeline(
      api,
      cfg,
      buildPipelineDeps(api, cfg),
      ctx,
      prompt,
      botNick(),
      network(),
      decision,
      hasAdmin,
    );
  };

  api.bind('pubm', '-', '*', async (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    // Cap message bytes before any in-memory buffer sees them.
    const text = truncateForBuffer(ctx.text);

    // Eager: ambient channel-liveness ping. Idempotent and cheap — fine to
    // fire per-fragment so the ambient engine sees the channel as alive
    // during the coalesce window.
    ambientEngine?.onChannelActivity(ctx.channel);

    // Bot-originated messages bypass the coalescer entirely. They need to
    // land in context immediately so the next user prompt sees the latest
    // bot reply, and they have no AI-pipeline path to debounce.
    const isBotMsg = ctx.nick.toLowerCase() === botNick().toLowerCase();
    if (isBotMsg) {
      contextManager?.addMessage(ctx.channel, ctx.nick, text, false);
      socialTracker?.onMessage(ctx.channel, ctx.nick, text, true);
      return;
    }

    // Eager: defer to pub `!ai` handler for subcommands. The pub bind fires
    // independently for the same wire event, so returning here just stops
    // the pubm path from racing it. Matches the prefix exactly or as a
    // space-prefixed command; bare prefix-as-word falls through.
    const cmdPrefix = cfg.triggers.commandPrefix.toLowerCase();
    const lowerText = text.trim().toLowerCase();
    if (lowerText === cmdPrefix || lowerText.startsWith(cmdPrefix + ' ')) {
      api.debug(
        traceLine(ctx, text, { trigger: 'command', reason: 'allowed', action: 'defer-to-pub' }),
      );
      return;
    }

    // Coalesce same-(channel, nick) wire fragments into one logical message
    // before running the per-message body. Disabled (window=0) → process
    // each fragment independently.
    if (coalescer) {
      coalescer.submit(ctx.channel, ctx.nick, text, ctx, (msg: CoalescedMessage) => {
        // Defense in depth: between coalescer.submit and the timer firing,
        // teardown() can null `coalescer` and the dependent state. The
        // pipeline downstream uses optional chaining everywhere so this
        // is safe today, but bail early to avoid a wasted processing pass
        // against torn-down state.
        if (!coalescer || !state) return;
        void processIncomingMessage(msg.ctx, msg.text, msg.fragmentCount);
      });
    } else {
      await processIncomingMessage(ctx, text, 1);
    }
  });

  // -----------------------------------------------------------------------
  // pub !ai — subcommand console (help / admin / games).
  // No freeform chat path — talk to the bot by nick instead.
  // -----------------------------------------------------------------------
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
      // Ignored users can't invoke the console either — otherwise a spammer
      // placed on ignore could still trigger per-reply chatter ("Unknown
      // subcommand 'x'") by flooding `!ai <garbage>`.
      const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
      const fullIgnore = [...cfg.permissions.ignoreList, ...getDynamicIgnoreList(api)];
      if (isIgnored(ctx.nick, hostmask, fullIgnore)) return;

      const text = truncateForBuffer(ctx.text);
      contextManager?.addMessage(ctx.channel, ctx.nick, text, false);

      const args = truncateForBuffer(ctx.args).trim();
      await handleSubcommand(api, cfg, ctx, args);
    },
  );
}

// ---------------------------------------------------------------------------
// Admin + info subcommands (return true if handled).
// ---------------------------------------------------------------------------

function formatIterDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

/**
 * Short usage hint shown for bare `!ai` / unknown subcommands. Points the
 * user at conversational addressing (`<botnick>: hi`) as the chat entry
 * point and at `!ai help` for the full subcommand listing.
 */
function subcommandUsageHint(cfg: AiChatConfig, botNick: string): string {
  return (
    `${cfg.triggers.commandPrefix} is a subcommand console — talk to the bot by nick ` +
    `("${botNick}: hello"). Try "${cfg.triggers.commandPrefix} help" for subcommands.`
  );
}

/**
 * Context passed to each subcommand handler. Carries the parsed `subArgs`
 * plus the two permission flags every gated handler needs, so individual
 * handlers don't re-derive them.
 */
interface SubHandlerCtx {
  api: PluginAPI;
  cfg: AiChatConfig;
  ctx: HandlerContext;
  subArgs: string;
  hasAdmin: boolean;
  hasOwner: boolean;
}

type SubHandler = (c: SubHandlerCtx) => void | Promise<void>;

/**
 * Subcommand dispatch table. Each entry replaces one `case` in the
 * former 225-line `switch`. Gated subcommands do their own
 * `hasAdmin`/`hasOwner` check and silently return when the caller
 * lacks the required flag — that's the existing behavior preserved
 * verbatim. Unknown subcommands are handled by `handleSubcommand` via
 * the default-path branch below so the table stays flat.
 */
const SUB_HANDLERS: Record<string, SubHandler> = {
  help: ({ api, ctx }) => {
    const anyone = 'help, character, characters, model, games';
    const admin = 'stats, iter, ignore, unignore, clear, character <name>, play, endgame';
    const owner = 'reset <nick>';
    const botNickValue = api.botConfig.irc.nick;
    ctx.reply(`Subcommands — anyone: ${anyone}`);
    ctx.reply(`[admin]: ${admin}`);
    ctx.reply(`[owner]: ${owner}`);
    ctx.reply(`Talk to the bot by nick ("${botNickValue}: hello") to chat.`);
  },
  stats: ({ ctx, hasAdmin }) => {
    if (!hasAdmin) return;
    if (!tokenTracker) return;
    const total = tokenTracker.getDailyTotal();
    ctx.reply(
      `Today: ${total.requests} requests, ${total.input + total.output} tokens ` +
        `(in:${total.input} out:${total.output})`,
    );
  },
  iter: ({ ctx, subArgs, hasAdmin }) => {
    if (!hasAdmin) return;
    if (!iterStats) return;
    if (subArgs === 'reset') {
      iterStats.reset();
      ctx.reply('Iteration stats reset.');
      return;
    }
    if (subArgs !== '') {
      ctx.reply('Usage: !ai iter [reset]');
      return;
    }
    const s = iterStats.snapshot();
    ctx.reply(
      `Since reset (${formatIterDuration(s.sinceMs)}): ${s.requests} requests, ` +
        `${s.input + s.output} tokens (in:${s.input} out:${s.output})`,
    );
  },
  reset: ({ api, ctx, subArgs, hasOwner }) => {
    if (!hasOwner) return;
    if (!tokenTracker) return;
    const target = subArgs;
    if (!target) {
      ctx.reply('Usage: !ai reset <nick>');
      return;
    }
    tokenTracker.resetUser(target);
    ctx.reply(`Reset token usage for ${api.stripFormatting(target)}.`);
  },
  ignore: ({ api, ctx, subArgs, hasAdmin }) => {
    if (!hasAdmin) return;
    const target = subArgs;
    if (!target) {
      ctx.reply('Usage: !ai ignore <nick|hostmask>');
      return;
    }
    // Shape + length validation: the target becomes a DB key that every
    // subsequent channel message scans via isIgnored(). An unvalidated
    // insert path is a slow-loris on the check loop (and a key-space
    // fill attack).
    // Accept: an optional channel/services sigil ($/#/&) followed by characters
    // valid in IRC nicks/hostmasks plus glob metacharacters (* ?). Rejects
    // whitespace, control bytes, NUL, and anything that could smuggle a
    // newline into the DB key. 128-char cap is a hygiene bound — real
    // hostmasks fit comfortably under it.
    if (target.length > 128 || !/^[$#&]?[\w[\]\\`^{}*?@!.-]+$/.test(target)) {
      ctx.reply('Invalid ignore target.');
      return;
    }
    // Only count toward the cap if this is a new entry — re-ignoring an
    // existing target is a no-op and shouldn't be refused.
    const existing = api.db.get(`${IGNORE_PREFIX}${target}`);
    if (existing === undefined && ignoreListSize(api) >= IGNORE_LIST_MAX) {
      ctx.reply(
        `Ignore list is full (${IGNORE_LIST_MAX} entries). Remove entries with "!ai unignore".`,
      );
      return;
    }
    api.db.set(`${IGNORE_PREFIX}${target}`, '1');
    ctx.reply(`Now ignoring "${api.stripFormatting(target)}".`);
  },
  unignore: ({ api, ctx, subArgs, hasAdmin }) => {
    if (!hasAdmin) return;
    const target = subArgs;
    if (!target) {
      ctx.reply('Usage: !ai unignore <nick|hostmask>');
      return;
    }
    // Mirror the shape validation that `ignore` enforces. Without it,
    // `unignore` becomes a no-op delete on any malformed string —
    // confusing for operators (the reply suggests success) and a slow
    // path through `db.del` on garbage input.
    if (target.length > 128 || !/^[$#&]?[\w[\]\\`^{}*?@!.-]+$/.test(target)) {
      ctx.reply('Invalid ignore target.');
      return;
    }
    api.db.del(`${IGNORE_PREFIX}${target}`);
    ctx.reply(`No longer ignoring "${api.stripFormatting(target)}".`);
  },
  clear: ({ ctx, hasAdmin }) => {
    if (!hasAdmin) return;
    if (ctx.channel) contextManager?.clearContext(ctx.channel);
    ctx.reply('Channel context cleared.');
  },
  character: ({ api, cfg, ctx, subArgs, hasAdmin }) => {
    if (!subArgs) {
      const active = activeCharacter(api, cfg, ctx.channel);
      ctx.reply(
        `Character: ${active.character.name}${active.language ? ` (${active.language})` : ''}`,
      );
      return;
    }
    if (!hasAdmin) return;
    const name = subArgs.toLowerCase();
    const charMap = state?.characters ?? new Map();
    if (!charMap.has(name)) {
      ctx.reply(
        `Unknown character: ${api.stripFormatting(subArgs)}. ` +
          `Available: ${[...charMap.keys()].join(', ')}`,
      );
      return;
    }
    if (ctx.channel) {
      api.db.set(`${CHARACTER_PREFIX}${ctx.channel.toLowerCase()}`, name);
      ctx.reply(`Character set to ${api.stripFormatting(name)} for ${ctx.channel}.`);
    }
  },
  characters: ({ ctx }) => {
    const charMap = state?.characters ?? new Map();
    ctx.reply(`Available: ${[...charMap.keys()].join(', ')}`);
  },
  // SECURITY: keep this subcommand strictly READ-ONLY. Do not add a setter
  // path here (e.g. `!ai model <name>`). Ollama's `/api/chat` endpoint will
  // implicitly pull an unknown model on first invocation, so making the model
  // name user-mutable from IRC turns the bot into an arbitrary-model puller
  // for anyone who can speak in-channel — including pulling huge or hostile
  // GGUF blobs. Model selection must stay operator-only via config. See
  // docs/SECURITY.md and the matching guard in providers/ollama.ts.
  model: ({ cfg, ctx }) => {
    const modelName = provider?.getModelName() ?? '(not initialized)';
    ctx.reply(`Provider: ${cfg.provider}, model: ${modelName}`);
  },
  games: ({ ctx }) => {
    if (!sessionManager) {
      ctx.reply('Sessions are disabled.');
      return;
    }
    const available = listGames(gamesDir);
    if (available.length === 0) ctx.reply('No games available.');
    else ctx.reply(`Games: ${available.join(', ')}`);
  },
  play: async ({ api, cfg, ctx, subArgs }) => {
    if (!sessionManager) {
      ctx.reply('Sessions are disabled.');
      return;
    }
    const game = subArgs;
    if (!game) {
      ctx.reply(`Usage: ${cfg.triggers.commandPrefix} play <game>`);
      return;
    }
    const prompt = loadGamePrompt(gamesDir, game);
    if (!prompt) {
      ctx.reply(`Unknown game: ${game}. Available: ${listGames(gamesDir).join(', ')}`);
      return;
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
      return;
    }
    sessionManager.createSession(ctx.nick, ctx.channel, game, prompt, makeSessionIdentity(ctx));
    ctx.reply(`Starting ${game}! Type \`${cfg.triggers.commandPrefix} endgame\` to quit.`);
    // Kick off the session with an empty move so the game sends its opening line.
    await runSessionPipeline(
      api,
      cfg,
      buildPipelineDeps(api, cfg),
      ctx,
      '(game start)',
      api.botConfig.irc.nick,
      api.botConfig.irc.host,
    );
  },
  endgame: ({ ctx }) => {
    if (!sessionManager) {
      ctx.reply('Sessions are disabled.');
      return;
    }
    const ended = sessionManager.endSession(ctx.nick, ctx.channel);
    ctx.reply(ended ? 'Session ended.' : 'No active session.');
  },
};

async function handleSubcommand(
  api: PluginAPI,
  cfg: AiChatConfig,
  ctx: HandlerContext,
  args: string,
): Promise<boolean> {
  const botNickValue = api.botConfig.irc.nick;
  if (!args) {
    ctx.reply(subcommandUsageHint(cfg, botNickValue));
    return true;
  }
  const [sub, ...rest] = args.split(/\s+/);
  const subLower = sub.toLowerCase();
  const handler = SUB_HANDLERS[subLower];
  if (!handler) {
    ctx.reply(
      `Unknown subcommand "${api.stripFormatting(sub)}". Try "${cfg.triggers.commandPrefix} help".`,
    );
    return true;
  }
  const adminFlag = cfg.permissions.adminFlag;
  await handler({
    api,
    cfg,
    ctx,
    subArgs: rest.join(' ').trim(),
    hasAdmin: api.permissions.checkFlags(adminFlag, ctx),
    // `n` = owner flag in the hexbot permission system (see
    // src/core/permissions.ts). Used here for `!ai reset <nick>` because
    // wiping another user's daily quota is a footgun in admin hands.
    hasOwner: api.permissions.checkFlags('n', ctx),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  if (sessionExpiryInterval) {
    clearInterval(sessionExpiryInterval);
    sessionExpiryInterval = null;
  }
  // Cancel in-flight provider calls FIRST, before nulling the state refs
  // awaiters might touch on resolution. Without this, a 60s Ollama fetch
  // (or a 30s Gemini withTimeout) outlives the reload and, when it
  // resolves against the old closure, touches torn-down tokenTracker /
  // rateLimiter / semaphore instances.
  provider?.abort?.();
  // Same rationale for the drip-send path and ambient sender closure:
  // abort cuts the setTimeout chain in sendLines and short-circuits the
  // ambient closure at its await boundaries.
  teardownController?.abort();
  teardownController = null;
  rateLimiter?.reset();
  sessionManager?.clear();
  ambientEngine?.stop();
  socialTracker?.clear();
  engagementTracker?.clear();
  coalescer?.teardown();
  rateLimiter = null;
  tokenTracker = null;
  semaphore = null;
  iterStats = null;
  contextManager = null;
  sessionManager = null;
  provider = null;
  socialTracker = null;
  ambientEngine = null;
  moodEngine = null;
  engagementTracker = null;
  coalescer = null;
  state = null;
  gamesDir = '';
  lastRateLimitOpNoticeAt.clear();
}

// Re-export so Phase 6 tests can still access the formatter.
export { formatResponse };
