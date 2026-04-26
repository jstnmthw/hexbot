import { vi } from 'vitest';

import type { PluginAPI } from '../../src/types';

/**
 * Create a mock PluginAPI with sensible defaults for every member of the
 * plugin-facing surface in `src/types.ts`. Mutating methods are vi.fn()
 * stubs (assertable), read methods return inert defaults
 * (`undefined` / `null` / empty arrays / `false`). `ircLower`,
 * `buildHostmask`, and `isBotNick` use real implementations because the
 * tests almost always need their actual behavior. Pass `overrides` to
 * tweak any field; common pattern is to override `db.get` so a test can
 * seed plugin state without standing up a real `BotDatabase`.
 */
export function createMockPluginAPI(overrides: Partial<PluginAPI> = {}): PluginAPI {
  const noop = vi.fn();
  return {
    pluginId: 'test-plugin',
    bind: noop,
    unbind: noop,
    say: noop,
    action: noop,
    notice: noop,
    ctcpResponse: noop,
    join: noop,
    part: noop,
    op: noop,
    deop: noop,
    voice: noop,
    devoice: noop,
    halfop: noop,
    dehalfop: noop,
    kick: noop,
    ban: noop,
    mode: noop,
    requestChannelModes: noop,
    topic: noop,
    invite: noop,
    changeNick: noop,
    onModesReady: noop,
    offModesReady: noop,
    onPermissionsChanged: noop,
    offPermissionsChanged: noop,
    onUserIdentified: noop,
    offUserIdentified: noop,
    onUserDeidentified: noop,
    offUserDeidentified: noop,
    onBotIdentified: noop,
    offBotIdentified: noop,
    getChannel: vi.fn().mockReturnValue(undefined),
    getUsers: vi.fn().mockReturnValue([]),
    getUserHostmask: vi.fn().mockReturnValue(undefined),
    getJoinedChannels: vi.fn().mockReturnValue([]),
    permissions: {
      findByHostmask: vi.fn().mockReturnValue(null),
      checkFlags: vi.fn().mockReturnValue(false),
    },
    services: {
      verifyUser: vi.fn().mockResolvedValue({ verified: false, account: null }),
      isAvailable: vi.fn().mockReturnValue(false),
      isNickServVerificationReply: vi.fn().mockReturnValue(false),
      isBotIdentified: vi.fn().mockReturnValue(false),
    },
    db: {
      get: vi.fn().mockReturnValue(undefined),
      set: noop,
      del: noop,
      list: vi.fn().mockReturnValue([]),
    },
    banStore: {
      storeBan: noop,
      removeBan: noop,
      getBan: vi.fn().mockReturnValue(null),
      getChannelBans: vi.fn().mockReturnValue([]),
      getAllBans: vi.fn().mockReturnValue([]),
      setSticky: vi.fn().mockReturnValue(false),
      liftExpiredBans: vi.fn().mockReturnValue(0),
      migrateFromPluginNamespace: vi.fn().mockReturnValue(0),
    },
    botConfig: {
      irc: {
        nick: 'hexbot',
        host: 'irc.test',
        port: 6667,
        tls: false,
        username: 'hexbot',
        realname: 'HexBot',
        channels: [],
      },
      identity: { method: 'hostmask' as const, require_acc_for: [] },
      services: { type: 'none' as const, nickserv: 'NickServ', sasl: false },
      logging: { level: 'info' as const, mod_actions: false },
    },
    getServerSupports: vi.fn().mockReturnValue({}),
    ircLower: (s: string) => s.toLowerCase(),
    buildHostmask: (source: { nick: string; ident: string; hostname: string }) =>
      `${source.nick}!${source.ident}@${source.hostname}`,
    isBotNick: (nick: string) => nick.toLowerCase() === 'hexbot',
    channelSettings: {
      register: noop,
      get: vi.fn().mockReturnValue(false),
      getFlag: vi.fn().mockReturnValue(false),
      getString: vi.fn().mockReturnValue(''),
      getInt: vi.fn().mockReturnValue(0),
      set: noop,
      isSet: vi.fn().mockReturnValue(false),
      onChange: noop,
    },
    coreSettings: {
      get: vi.fn().mockReturnValue(''),
      getFlag: vi.fn().mockReturnValue(false),
      getString: vi.fn().mockReturnValue(''),
      getInt: vi.fn().mockReturnValue(0),
      isSet: vi.fn().mockReturnValue(false),
      onChange: noop,
      offChange: noop,
    },
    settings: {
      register: noop,
      get: vi.fn().mockReturnValue(''),
      getFlag: vi.fn().mockReturnValue(false),
      getString: vi.fn().mockReturnValue(''),
      getInt: vi.fn().mockReturnValue(0),
      set: noop,
      unset: noop,
      isSet: vi.fn().mockReturnValue(false),
      onChange: noop,
      offChange: noop,
      bootConfig: Object.freeze({}),
    },
    registerHelp: noop,
    getHelpEntries: vi.fn().mockReturnValue([]),
    stripFormatting: (s: string) => s,
    getChannelKey: vi.fn().mockReturnValue(undefined),
    util: {
      matchWildcard: vi.fn().mockReturnValue(false),
      patternSpecificity: vi.fn().mockReturnValue(0),
      createSlidingWindowCounter: vi.fn().mockReturnValue({
        check: vi.fn().mockReturnValue(false),
        peek: vi.fn().mockReturnValue(0),
        clear: noop,
        reset: noop,
        sweep: noop,
        size: 0,
      }),
    },
    log: noop,
    error: noop,
    warn: noop,
    debug: noop,
    audit: {
      log: noop,
    },
    auditActor: (ctx) => ({ by: ctx.nick, source: 'plugin', plugin: 'test-plugin' }),
    ...overrides,
  };
}
