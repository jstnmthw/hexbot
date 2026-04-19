// Unit tests for the ai-chat config parser and provider-config builder.
// Pure helpers — no IRC or DB dependencies. Verifies defaults, snake_case →
// camelCase translation, legacy migration warnings, type-coercion fallbacks
// for malformed inputs, and the gemini/ollama/unknown branches of
// buildProviderConfig (including the degraded-mode warn paths).
import { describe, expect, it, vi } from 'vitest';

import { buildProviderConfig, parseConfig } from '../../plugins/ai-chat/config';

describe('parseConfig', () => {
  it('returns a fully-populated config from an empty input', () => {
    const cfg = parseConfig({});
    // Top-level defaults
    expect(cfg.provider).toBe('gemini');
    expect(cfg.apiKey).toBe('');
    expect(cfg.model).toBe('gemini-2.5-flash-lite');
    expect(cfg.temperature).toBe(0.9);
    expect(cfg.maxOutputTokens).toBe(256);
    expect(cfg.character).toBe('friendly');
    expect(cfg.charactersDir).toBe('characters');
    expect(cfg.channelCharacters).toEqual({});
    expect(cfg.channelProfiles).toEqual({});
  });

  it('populates trigger defaults', () => {
    const cfg = parseConfig({});
    expect(cfg.triggers).toEqual({
      directAddress: true,
      commandPrefix: '!ai',
      keywords: [],
      randomChance: 0,
    });
  });

  it('converts engagement minutes to ms', () => {
    const cfg = parseConfig({
      engagement: { soft_timeout_minutes: 5, hard_ceiling_minutes: 12 },
    });
    expect(cfg.engagement.softTimeoutMs).toBe(5 * 60_000);
    expect(cfg.engagement.hardCeilingMs).toBe(12 * 60_000);
  });

  it('uses engagement defaults (10/30 minutes) when keys missing', () => {
    const cfg = parseConfig({});
    expect(cfg.engagement.softTimeoutMs).toBe(10 * 60_000);
    expect(cfg.engagement.hardCeilingMs).toBe(30 * 60_000);
  });

  it('converts context.ttl_minutes to ms and validates pruneStrategy', () => {
    const cfg = parseConfig({
      context: { max_messages: 25, max_tokens: 2000, ttl_minutes: 15, prune_strategy: 'sliding' },
    });
    expect(cfg.context.maxMessages).toBe(25);
    expect(cfg.context.maxTokens).toBe(2000);
    expect(cfg.context.ttlMs).toBe(15 * 60_000);
    expect(cfg.context.pruneStrategy).toBe('sliding');
  });

  it('falls back to "bulk" pruneStrategy for unrecognised values', () => {
    const cfg = parseConfig({ context: { prune_strategy: 'lru' } });
    expect(cfg.context.pruneStrategy).toBe('bulk');
  });

  it('parses rate_limits into camelCase', () => {
    const cfg = parseConfig({
      rate_limits: {
        user_burst: 7,
        user_refill_seconds: 20,
        global_rpm: 30,
        global_rpd: 1000,
        rpm_backpressure_pct: 50,
        ambient_per_channel_per_hour: 2,
        ambient_global_per_hour: 8,
      },
    });
    expect(cfg.rateLimits).toEqual({
      userBurst: 7,
      userRefillSeconds: 20,
      globalRpm: 30,
      globalRpd: 1000,
      rpmBackpressurePct: 50,
      ambientPerChannelPerHour: 2,
      ambientGlobalPerHour: 8,
    });
  });

  it('parses token_budgets', () => {
    const cfg = parseConfig({ token_budgets: { per_user_daily: 1, global_daily: 2 } });
    expect(cfg.tokenBudgets).toEqual({ perUserDaily: 1, globalDaily: 2 });
  });

  it('parses permissions including ignore_list and bot_nick_patterns', () => {
    const cfg = parseConfig({
      permissions: {
        required_flag: 'a',
        admin_flag: 'A',
        ignore_list: ['Spammer', 'bad!*@*'],
        ignore_bots: false,
        bot_nick_patterns: ['*Bot', 'ChanServ'],
      },
    });
    expect(cfg.permissions).toEqual({
      requiredFlag: 'a',
      adminFlag: 'A',
      ignoreList: ['Spammer', 'bad!*@*'],
      ignoreBots: false,
      botNickPatterns: ['*Bot', 'ChanServ'],
    });
  });

  it('uses default bot_nick_patterns when omitted', () => {
    const cfg = parseConfig({});
    expect(cfg.permissions.botNickPatterns).toEqual(['*bot', '*Bot', '*BOT']);
  });

  it('parses output settings', () => {
    const cfg = parseConfig({
      output: {
        max_lines: 6,
        max_line_length: 320,
        inter_line_delay_ms: 1000,
        strip_urls: true,
      },
    });
    expect(cfg.output).toEqual({
      maxLines: 6,
      maxLineLength: 320,
      interLineDelayMs: 1000,
      stripUrls: true,
    });
  });

  it('parses ambient block including nested idle/event_reactions', () => {
    const cfg = parseConfig({
      ambient: {
        enabled: true,
        idle: { after_minutes: 20, chance: 0.5, min_users: 3 },
        unanswered_questions: { enabled: false, waitSeconds: 60 },
        chattiness: 0.2,
        interests: ['linux', 'irc'],
        event_reactions: { join_wb: true, topic_change: true },
      },
    });
    expect(cfg.ambient.enabled).toBe(true);
    expect(cfg.ambient.idle).toEqual({ afterMinutes: 20, chance: 0.5, minUsers: 3 });
    // The snake_case key is `wait_seconds`; the camelCase typo above must
    // therefore *not* be respected. Default of 90 should hold.
    expect(cfg.ambient.unansweredQuestions).toEqual({ enabled: false, waitSeconds: 90 });
    expect(cfg.ambient.chattiness).toBe(0.2);
    expect(cfg.ambient.interests).toEqual(['linux', 'irc']);
    expect(cfg.ambient.eventReactions).toEqual({ joinWb: true, topicChange: true });
  });

  it('uses ambient defaults when omitted', () => {
    const cfg = parseConfig({});
    expect(cfg.ambient.enabled).toBe(false);
    expect(cfg.ambient.idle.afterMinutes).toBe(15);
    expect(cfg.ambient.unansweredQuestions.enabled).toBe(true);
    expect(cfg.ambient.unansweredQuestions.waitSeconds).toBe(90);
    expect(cfg.ambient.eventReactions).toEqual({ joinWb: false, topicChange: false });
  });

  it('parses security defaults — disable_when_founder defaults to true', () => {
    const cfg = parseConfig({});
    expect(cfg.security).toEqual({
      privilegeGating: false,
      privilegedModeThreshold: 'h',
      privilegedRequiredFlag: 'm',
      disableWhenPrivileged: false,
      disableWhenFounder: true,
    });
  });

  it('parses security overrides', () => {
    const cfg = parseConfig({
      security: {
        privilege_gating: true,
        privileged_mode_threshold: 'o',
        privileged_required_flag: 'a',
        disable_when_privileged: true,
        disable_when_founder: false,
      },
    });
    expect(cfg.security.privilegeGating).toBe(true);
    expect(cfg.security.privilegedModeThreshold).toBe('o');
    expect(cfg.security.privilegedRequiredFlag).toBe('a');
    expect(cfg.security.disableWhenPrivileged).toBe(true);
    expect(cfg.security.disableWhenFounder).toBe(false);
  });

  it('parses sessions block (inactivity in minutes → ms)', () => {
    const cfg = parseConfig({
      sessions: { enabled: false, inactivity_timeout_minutes: 5, games_dir: 'mygames' },
    });
    expect(cfg.sessions).toEqual({
      enabled: false,
      inactivityMs: 5 * 60_000,
      gamesDir: 'mygames',
    });
  });

  it('uses sessions defaults', () => {
    const cfg = parseConfig({});
    expect(cfg.sessions).toEqual({
      enabled: true,
      inactivityMs: 10 * 60_000,
      gamesDir: 'games',
    });
  });

  it('parses ollama block', () => {
    const cfg = parseConfig({
      ollama: {
        base_url: 'http://10.0.0.1:11434',
        request_timeout_ms: 30_000,
        use_server_tokenizer: true,
        keep_alive: '1h',
        num_ctx: 8192,
      },
    });
    expect(cfg.ollama).toEqual({
      baseUrl: 'http://10.0.0.1:11434',
      requestTimeoutMs: 30_000,
      useServerTokenizer: true,
      keepAlive: '1h',
      numCtx: 8192,
      allowPrivateUrl: false,
    });
  });

  it('uses ollama defaults', () => {
    const cfg = parseConfig({});
    expect(cfg.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(cfg.ollama.requestTimeoutMs).toBe(60_000);
    expect(cfg.ollama.useServerTokenizer).toBe(false);
    expect(cfg.ollama.keepAlive).toBe('30m');
    expect(cfg.ollama.numCtx).toBe(4096);
    // Defaults to false — SSRF guard is secure-by-default.
    expect(cfg.ollama.allowPrivateUrl).toBe(false);
  });

  it('reads allow_private_url from config', () => {
    const cfg = parseConfig({ ollama: { allow_private_url: true } });
    expect(cfg.ollama.allowPrivateUrl).toBe(true);
  });

  it('parses channel_characters as a record', () => {
    const cfg = parseConfig({
      channel_characters: {
        '#chan1': 'pirate',
        '#chan2': { character: 'wizard', language: 'en' },
      },
    });
    expect(cfg.channelCharacters).toEqual({
      '#chan1': 'pirate',
      '#chan2': { character: 'wizard', language: 'en' },
    });
  });

  it('parses channel_profiles as a record', () => {
    const cfg = parseConfig({
      channel_profiles: {
        '#dev': { topic: 'coding', culture: 'casual', role: 'mentor', depth: 'expert' },
      },
    });
    expect(cfg.channelProfiles).toEqual({
      '#dev': { topic: 'coding', culture: 'casual', role: 'mentor', depth: 'expert' },
    });
  });

  it('coerces non-record nested objects to {}', () => {
    // Passing strings/arrays for nested object keys should fall back to {} —
    // not crash and not pollute the result.
    const cfg = parseConfig({
      triggers: 'not-an-object',
      context: ['arrays', 'too'],
      ambient: 42,
    });
    expect(cfg.triggers.commandPrefix).toBe('!ai');
    expect(cfg.context.maxMessages).toBe(50);
    expect(cfg.ambient.enabled).toBe(false);
  });

  it('rejects non-finite numbers and falls back to defaults', () => {
    const cfg = parseConfig({
      temperature: Number.NaN,
      max_output_tokens: Number.POSITIVE_INFINITY,
    });
    expect(cfg.temperature).toBe(0.9);
    expect(cfg.maxOutputTokens).toBe(256);
  });

  it('rejects non-string values and falls back to defaults', () => {
    const cfg = parseConfig({ provider: 123, model: null, character: false });
    expect(cfg.provider).toBe('gemini');
    expect(cfg.model).toBe('gemini-2.5-flash-lite');
    expect(cfg.character).toBe('friendly');
  });

  it('filters non-string entries out of string arrays', () => {
    const cfg = parseConfig({
      permissions: { ignore_list: ['ok', 42, null, 'fine'] },
    });
    expect(cfg.permissions.ignoreList).toEqual(['ok', 'fine']);
  });

  it('falls back to default array when value is not an array', () => {
    const cfg = parseConfig({ permissions: { bot_nick_patterns: 'not-an-array' } });
    expect(cfg.permissions.botNickPatterns).toEqual(['*bot', '*Bot', '*BOT']);
  });

  it('warns when legacy triggers.engagement_seconds is present', () => {
    const warn = vi.fn();
    parseConfig({ triggers: { engagement_seconds: 60 } }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('triggers.engagement_seconds');
    expect(warn.mock.calls[0][0]).toContain('engagement.soft_timeout_minutes');
  });

  it('warns when legacy triggers.command is present', () => {
    const warn = vi.fn();
    parseConfig({ triggers: { command: 'yo' } }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('triggers.command');
  });

  it('emits both legacy warnings when both keys are present', () => {
    const warn = vi.fn();
    parseConfig({ triggers: { engagement_seconds: 30, command: 'x' } }, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn when no legacy keys are present', () => {
    const warn = vi.fn();
    parseConfig({ triggers: { command_prefix: '!ai', keywords: ['k'] } }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses a no-op warn when caller omits the second argument', () => {
    // Should not throw when legacy keys are present without a warn fn.
    expect(() => parseConfig({ triggers: { command: 'x' } })).not.toThrow();
  });
});

describe('buildProviderConfig', () => {
  it('returns a Gemini config when provider=gemini and apiKey is set', () => {
    const cfg = parseConfig({ provider: 'gemini' });
    cfg.apiKey = 'test-key';
    const warn = vi.fn();
    const out = buildProviderConfig(cfg, warn);
    expect(out).toEqual({
      model: cfg.model,
      maxOutputTokens: cfg.maxOutputTokens,
      temperature: cfg.temperature,
      apiKey: 'test-key',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns null for gemini without an API key', () => {
    const cfg = parseConfig({ provider: 'gemini' });
    const warn = vi.fn();
    expect(buildProviderConfig(cfg, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('No Gemini API key');
    expect(warn.mock.calls[0][0]).toContain('degraded mode');
  });

  it('returns an Ollama config including keep_alive when set', () => {
    const cfg = parseConfig({ provider: 'ollama', ollama: { keep_alive: '2h', num_ctx: 2048 } });
    const warn = vi.fn();
    const out = buildProviderConfig(cfg, warn);
    expect(out).toMatchObject({
      model: cfg.model,
      maxOutputTokens: cfg.maxOutputTokens,
      temperature: cfg.temperature,
      baseUrl: 'http://127.0.0.1:11434',
      requestTimeoutMs: 60_000,
      useServerTokenizer: false,
      keepAlive: '2h',
      numCtx: 2048,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('omits keepAlive (sets undefined) when keep_alive is empty string', () => {
    const cfg = parseConfig({ provider: 'ollama', ollama: { keep_alive: '' } });
    const warn = vi.fn();
    const out = buildProviderConfig(cfg, warn) as unknown as Record<string, unknown>;
    expect(out.keepAlive).toBeUndefined();
  });

  it('warns and returns null for ollama with no base_url', () => {
    const cfg = parseConfig({ provider: 'ollama' });
    // Force baseUrl empty (defaults supply a value, so override after parse).
    cfg.ollama.baseUrl = '';
    const warn = vi.fn();
    expect(buildProviderConfig(cfg, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Ollama provider requires ollama.base_url');
  });

  it('warns and returns null for an unknown provider', () => {
    const cfg = parseConfig({ provider: 'cohere' });
    const warn = vi.fn();
    expect(buildProviderConfig(cfg, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Unknown ai-chat provider "cohere"');
  });
});
