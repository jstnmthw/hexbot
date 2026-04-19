// ai-chat — config parsing and provider-config construction.
//
// Split out of index.ts so the 1700-line god file isn't the home for the
// (pure, load-time-only) shape and parsing of the plugin's config blob.
// Everything here is self-contained: no module-scope state, no IRC/DB
// dependencies beyond the `warn(msg)` callback the plugin API supplies.
import type { AIProviderConfig } from './providers/types';
import type { TriggerConfig } from './triggers';

/**
 * Fully-resolved ai-chat config. Every field has a default — `parseConfig({})`
 * returns a populated object — so downstream code can read fields without
 * defensive `?? defaults`. Keys are camelCase; the raw config uses snake_case
 * and is translated here.
 */
export interface AiChatConfig {
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
  engagement: {
    softTimeoutMs: number;
    hardCeilingMs: number;
  };
  context: {
    maxMessages: number;
    maxTokens: number;
    ttlMs: number;
    pruneStrategy: 'bulk' | 'sliding';
  };
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
    /** Ollama `keep_alive` — empty string means "use Ollama's default". */
    keepAlive: string;
    /** Pinned context window. `0` leaves it unset (daemon default). */
    numCtx: number;
    /**
     * Allow `base_url` to point at loopback/link-local/private addresses.
     * Defaults to `false`; operators running Ollama on localhost must opt
     * in explicitly. See SSRF guard in `providers/ollama.ts`.
     */
    allowPrivateUrl: boolean;
  };
}

/**
 * Parse a raw `ai-chat` config object (from plugins.json / config.json)
 * into the strongly-typed internal shape. Every field has a default — an
 * empty `{}` input yields a fully-populated config. `warn` is invoked with
 * a human message for removed-key migrations (pre-0.5.0 `engagement_seconds`
 * / `triggers.command`); callers wire it to the plugin API warn log so
 * operators see the message without a bot restart.
 */
export function parseConfig(
  raw: Record<string, unknown>,
  warn: (msg: string) => void = () => {},
): AiChatConfig {
  const triggers = asRecord(raw.triggers);
  const context = asRecord(raw.context);
  const rl = asRecord(raw.rate_limits);
  const tb = asRecord(raw.token_budgets);
  const perm = asRecord(raw.permissions);
  const output = asRecord(raw.output);
  const channelCharacters = asRecord(raw.channel_characters);

  // Legacy config migration warnings. Retained values are ignored; the
  // replacement keys (`engagement.*`, always-on `!ai` console) are used.
  if ('engagement_seconds' in triggers) {
    warn(
      'triggers.engagement_seconds is removed — replace with ' +
        'engagement.soft_timeout_minutes / engagement.hard_ceiling_minutes ' +
        '(see CHANGELOG 0.5.0).',
    );
  }
  if ('command' in triggers) {
    warn(
      'triggers.command is removed — the !ai subcommand console is always ' +
        'enabled. Remove this key from your config.',
    );
  }

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
      commandPrefix: asString(triggers.command_prefix, '!ai'),
      keywords: asStringArr(triggers.keywords, []),
      randomChance: asNum(triggers.random_chance, 0),
    },
    engagement: (() => {
      const e = asRecord(raw.engagement);
      return {
        softTimeoutMs: asNum(e.soft_timeout_minutes, 10) * 60_000,
        hardCeilingMs: asNum(e.hard_ceiling_minutes, 30) * 60_000,
      };
    })(),
    context: {
      maxMessages: asNum(context.max_messages, 50),
      maxTokens: asNum(context.max_tokens, 4000),
      ttlMs: asNum(context.ttl_minutes, 60) * 60_000,
      pruneStrategy: asString(context.prune_strategy, 'bulk') === 'sliding' ? 'sliding' : 'bulk',
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
        keepAlive: asString(o.keep_alive, '30m'),
        numCtx: asNum(o.num_ctx, 4096),
        allowPrivateUrl: asBool(o.allow_private_url, false),
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
export function buildProviderConfig(
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
        // Empty keep_alive string → leave it out of the request so Ollama
        // uses its own default (5m). Any non-empty string is passed through.
        keepAlive: cfg.ollama.keepAlive || undefined,
        numCtx: cfg.ollama.numCtx,
        allowPrivateUrl: cfg.ollama.allowPrivateUrl,
      };
    }
    default:
      warn(`Unknown ai-chat provider "${cfg.provider}" — plugin is in degraded mode.`);
      return null;
  }
}
