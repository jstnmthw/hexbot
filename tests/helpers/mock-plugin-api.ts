import { vi } from 'vitest';

import type { PluginAPI } from '../../src/types';

/**
 * Create a mock PluginAPI with sensible defaults for all members.
 * Override only the properties your test cares about.
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
    getChannel: vi.fn().mockReturnValue(undefined),
    getUsers: vi.fn().mockReturnValue([]),
    getUserHostmask: vi.fn().mockReturnValue(undefined),
    permissions: {
      findByHostmask: vi.fn().mockReturnValue(null),
      checkFlags: vi.fn().mockReturnValue(false),
    },
    services: {
      verifyUser: vi.fn().mockResolvedValue({ verified: false, account: null }),
      isAvailable: vi.fn().mockReturnValue(false),
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
      owner: { handle: 'owner', hostmask: '*!*@owner.host' },
      identity: { method: 'hostmask' as const, require_acc_for: [] },
      services: { type: 'none' as const, nickserv: 'NickServ', sasl: false },
      logging: { level: 'info' as const, mod_actions: false },
    },
    config: {},
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
    registerHelp: noop,
    getHelpEntries: vi.fn().mockReturnValue([]),
    stripFormatting: (s: string) => s,
    getChannelKey: vi.fn().mockReturnValue(undefined),
    log: noop,
    error: noop,
    warn: noop,
    debug: noop,
    ...overrides,
  };
}
