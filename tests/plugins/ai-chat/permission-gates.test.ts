// Unit tests for the post-time founder gate plus the small PluginAPI-backed
// helpers in permission-gates.ts. Trigger-time `shouldRespond` /
// `shouldBlockOnFounder` are already covered in ai-chat-plugin.test.ts; this
// file fills the gap for getBotChannelModes / getBotChanservAccess /
// isFounderPostGate / postGateFor / traceLine, and a few
// isPrivilegeRestricted edge cases that the high-level tests miss.
import { describe, expect, it, vi } from 'vitest';

import type { AiChatConfig } from '../../../plugins/ai-chat/config';
import {
  getBotChannelModes,
  getBotChanservAccess,
  isFounderPostGate,
  postGateFor,
  shouldRespond,
  traceLine,
} from '../../../plugins/ai-chat/permission-gates';
import type { ChannelState, ChannelUser, HandlerContext } from '../../../src/types';
import { createMockPluginAPI } from '../../helpers/mock-plugin-api';

function makeUser(overrides: Partial<ChannelUser>): ChannelUser {
  return {
    nick: 'someone',
    ident: 'u',
    hostname: 'h',
    modes: '',
    joinedAt: 0,
    ...overrides,
  };
}

function makeChannel(users: ChannelUser[]): ChannelState {
  const userMap = new Map<string, ChannelUser>();
  for (const u of users) userMap.set(u.nick.toLowerCase(), u);
  return {
    name: '#c',
    topic: '',
    modes: '',
    key: '',
    limit: 0,
    users: userMap,
  };
}

// Minimal config — only the fields the gates read are meaningful. Reused via
// spread in each test.
const BASE_CONFIG: AiChatConfig = {
  provider: 'gemini',
  apiKey: '',
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
    disableWhenFounder: true,
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

const BASE_CTX = {
  nick: 'alice',
  ident: 'u',
  hostname: 'h',
  channel: '#c' as string | null,
  botNick: 'hexbot',
  hasRequiredFlag: true,
  hasPrivilegedFlag: false,
  botChannelModes: undefined as string | undefined,
  botChanservAccess: undefined as string | undefined,
  dynamicIgnoreList: [] as string[],
  config: BASE_CONFIG,
};

describe('isPrivilegeRestricted edge cases (via shouldRespond)', () => {
  it('does not gate when bot mode threshold is unknown', () => {
    // 'X' is not in the elevated list — gate falls through (defensive
    // behavior: misconfigured threshold should not block all users).
    expect(
      shouldRespond({
        ...BASE_CTX,
        botChannelModes: 'o',
        config: {
          ...BASE_CONFIG,
          security: {
            ...BASE_CONFIG.security,
            privilegeGating: true,
            privilegedModeThreshold: 'X',
          },
        },
      }),
    ).toBe(true);
  });

  it('does not gate when bot has no channel modes recorded', () => {
    expect(
      shouldRespond({
        ...BASE_CTX,
        botChannelModes: undefined,
        config: {
          ...BASE_CONFIG,
          security: { ...BASE_CONFIG.security, privilegeGating: true },
        },
      }),
    ).toBe(true);
  });

  it('does not gate when bot has only +v with threshold +h', () => {
    // Voice is not in the elevated list → no privilege restriction even with
    // gating on. Same effective outcome as "below threshold" but exercises
    // the eligibleModes.some() === false branch.
    expect(
      shouldRespond({
        ...BASE_CTX,
        botChannelModes: 'v',
        config: {
          ...BASE_CONFIG,
          security: { ...BASE_CONFIG.security, privilegeGating: true },
        },
      }),
    ).toBe(true);
  });

  it('blocks when disable_when_privileged is set (privileged user with flag still blocked)', () => {
    // Even a flagged user is blocked once the bot is privileged and
    // disableWhenPrivileged is on — covers the "return true" line that
    // bypasses the flag check.
    expect(
      shouldRespond({
        ...BASE_CTX,
        botChannelModes: 'q',
        hasPrivilegedFlag: true,
        config: {
          ...BASE_CONFIG,
          security: {
            ...BASE_CONFIG.security,
            privilegeGating: true,
            disableWhenPrivileged: true,
          },
        },
      }),
    ).toBe(false);
  });
});

describe('getBotChannelModes', () => {
  it('returns undefined for a null channel (PMs etc.)', () => {
    const api = createMockPluginAPI();
    expect(getBotChannelModes(api, null)).toBeUndefined();
  });

  it('returns undefined when the channel is unknown to the bot', () => {
    const api = createMockPluginAPI({ getChannel: vi.fn().mockReturnValue(undefined) });
    expect(getBotChannelModes(api, '#absent')).toBeUndefined();
  });

  it("returns the bot user's mode string when present in the channel", () => {
    const channel = makeChannel([
      makeUser({ nick: 'alice', modes: 'v' }),
      makeUser({ nick: 'hexbot', modes: 'o' }),
    ]);
    const api = createMockPluginAPI({
      getChannel: vi.fn().mockReturnValue(channel),
      // isBotNick — match on lowercase 'hexbot' (the default in the helper).
    });
    expect(getBotChannelModes(api, '#c')).toBe('o');
  });

  it('returns undefined when no user in the channel matches the bot nick', () => {
    const channel = makeChannel([makeUser({ nick: 'alice', modes: 'v' })]);
    const api = createMockPluginAPI({
      getChannel: vi.fn().mockReturnValue(channel),
    });
    expect(getBotChannelModes(api, '#c')).toBeUndefined();
  });

  it('returns the empty string when the bot is in-channel with no modes', () => {
    // Distinct from "unknown" (undefined): empty string means we KNOW the bot
    // has no modes. The privilege gate uses `botModes.includes(...)` which
    // works on empty strings, so the helper should return '' not undefined.
    const channel = makeChannel([makeUser({ nick: 'hexbot', modes: '' })]);
    const api = createMockPluginAPI({
      getChannel: vi.fn().mockReturnValue(channel),
    });
    expect(getBotChannelModes(api, '#c')).toBe('');
  });
});

describe('getBotChanservAccess', () => {
  it('returns undefined for a null channel', () => {
    const api = createMockPluginAPI();
    expect(getBotChanservAccess(api, null)).toBeUndefined();
  });

  it('reads the chanserv_access channel setting', () => {
    const getString = vi.fn().mockReturnValue('founder');
    const api = createMockPluginAPI({
      channelSettings: {
        ...createMockPluginAPI().channelSettings,
        getString,
      },
    });
    expect(getBotChanservAccess(api, '#c')).toBe('founder');
    expect(getString).toHaveBeenCalledWith('#c', 'chanserv_access');
  });
});

describe('isFounderPostGate', () => {
  function withChanservAccess(value: string): ReturnType<typeof createMockPluginAPI> {
    return createMockPluginAPI({
      channelSettings: {
        ...createMockPluginAPI().channelSettings,
        getString: vi.fn().mockReturnValue(value),
      },
      warn: vi.fn(),
    });
  }

  it('returns false when disableWhenFounder is off', () => {
    const api = withChanservAccess('founder');
    const cfg = {
      ...BASE_CONFIG,
      security: { ...BASE_CONFIG.security, disableWhenFounder: false },
    };
    expect(isFounderPostGate(api, cfg, '#c', 'rolled')).toBe(false);
    expect(api.warn).not.toHaveBeenCalled();
  });

  it('returns false for a null channel (PM context)', () => {
    const api = withChanservAccess('founder');
    expect(isFounderPostGate(api, BASE_CONFIG, null, 'direct')).toBe(false);
    expect(api.warn).not.toHaveBeenCalled();
  });

  it('returns false when ChanServ access is not founder', () => {
    const api = withChanservAccess('op');
    expect(isFounderPostGate(api, BASE_CONFIG, '#c', 'direct')).toBe(false);
    expect(api.warn).not.toHaveBeenCalled();
  });

  it('returns true and warns when ChanServ access is founder', () => {
    const api = withChanservAccess('founder');
    expect(isFounderPostGate(api, BASE_CONFIG, '#c', 'rolled')).toBe(true);
    expect(api.warn).toHaveBeenCalledTimes(1);
    const msg = (api.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg).toContain('post-gate');
    expect(msg).toContain('rolled');
    expect(msg).toContain('#c');
    expect(msg).toContain('disable_when_founder');
  });

  it('treats "Founder" / "FOUNDER" / whitespace-padded values as founder', () => {
    for (const value of ['Founder', 'FOUNDER', ' founder ', 'founder\t']) {
      const api = withChanservAccess(value);
      expect(isFounderPostGate(api, BASE_CONFIG, '#c', 'r')).toBe(true);
    }
  });

  it('does not block on undefined/empty/none/superop values', () => {
    for (const value of ['', 'none', 'op', 'superop']) {
      const api = withChanservAccess(value);
      expect(isFounderPostGate(api, BASE_CONFIG, '#c', 'r')).toBe(false);
      expect(api.warn).not.toHaveBeenCalled();
    }
  });
});

describe('postGateFor', () => {
  it('returns a thunk that closes over api/cfg/channel and forwards the reason', () => {
    const getString = vi.fn().mockReturnValue('founder');
    const warn = vi.fn();
    const api = createMockPluginAPI({
      channelSettings: { ...createMockPluginAPI().channelSettings, getString },
      warn,
    });
    const gate = postGateFor(api, BASE_CONFIG, '#c');
    expect(gate('direct')).toBe(true);
    expect(getString).toHaveBeenCalledWith('#c', 'chanserv_access');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('direct');
  });

  it('produced thunk returns false in non-founder channels', () => {
    const api = createMockPluginAPI({
      channelSettings: {
        ...createMockPluginAPI().channelSettings,
        getString: vi.fn().mockReturnValue('op'),
      },
    });
    const gate = postGateFor(api, BASE_CONFIG, '#c');
    expect(gate('rolled')).toBe(false);
  });
});

describe('traceLine', () => {
  function makeHandlerCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
    return {
      nick: 'alice',
      ident: 'u',
      hostname: 'h',
      channel: '#c',
      text: '',
      command: '',
      args: '',
      reply: vi.fn(),
      replyPrivate: vi.fn(),
      ...overrides,
    } as HandlerContext;
  }

  it('formats channel/nick/trigger/gate/action and JSON-quotes the text', () => {
    const ctx = makeHandlerCtx({ nick: 'bob', channel: '#dev' });
    const line = traceLine(ctx, 'hello there', {
      trigger: 'direct',
      reason: 'allowed',
      action: 'reply',
    });
    expect(line).toContain('ch=#dev');
    expect(line).toContain('nick=bob');
    expect(line).toContain('trigger=direct');
    expect(line).toContain('gate=allowed');
    expect(line).toContain('→ reply');
    // JSON-quoted snippet for safe logging.
    expect(line).toContain('text="hello there"');
  });

  it('renders a null channel as "(none)" — covers PM context', () => {
    const ctx = makeHandlerCtx({ channel: null });
    const line = traceLine(ctx, 'hi', { trigger: 'direct', reason: 'allowed', action: 'reply' });
    expect(line).toContain('ch=(none)');
  });

  it('truncates long text to 60 chars + ellipsis before quoting', () => {
    const ctx = makeHandlerCtx();
    const longText = 'x'.repeat(120);
    const line = traceLine(ctx, longText, {
      trigger: 'keyword',
      reason: 'allowed',
      action: 'reply',
    });
    // 60 x's + ellipsis = 61 chars, JSON-quoted.
    expect(line).toContain(`text="${'x'.repeat(60)}…"`);
    expect(line).not.toContain('x'.repeat(61));
  });

  it('JSON-escapes embedded quotes and control bytes so log lines stay single-line', () => {
    const ctx = makeHandlerCtx();
    const line = traceLine(ctx, 'hi "world"\nnewline', {
      trigger: 'direct',
      reason: 'allowed',
      action: 'reply',
    });
    // Quotes and newlines must be escaped in the JSON-stringified snippet.
    expect(line).toContain('\\"world\\"');
    expect(line).toContain('\\n');
    // No literal newline anywhere in the trace line.
    expect(line.includes('\n')).toBe(false);
  });
});
