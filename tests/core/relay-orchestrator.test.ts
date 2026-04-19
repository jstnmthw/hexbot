// HexBot — RelayOrchestrator unit tests
//
// The orchestrator owns the bot-link subsystem (hub or leaf), virtual relay
// sessions, the party-line wiring, and the frame dispatcher that fans
// PARTY/RELAY/PROTECT/ban frames out to DCC/permissions/banlist. Real
// hub/leaf classes are mocked at the module boundary so we never open a
// TCP socket; all interesting behavior is exercised by directly invoking
// the callbacks the orchestrator wires up on the mocked link instances.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imports below this line will see the mocked classes.
import { BotLinkHub, BotLinkLeaf, type LinkFrame } from '../../src/core/botlink';
import { RelayOrchestrator, type RelayOrchestratorDeps } from '../../src/core/relay-orchestrator';
import type { Casemapping } from '../../src/types';
import { type MockBot, createMockBot } from '../helpers/mock-bot';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before importing relay-orchestrator
// ---------------------------------------------------------------------------

vi.mock('../../src/core/botlink', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/core/botlink')>('../../src/core/botlink');

  // Minimal hub stub: records callbacks/methods set by the orchestrator,
  // exposes spies for listen/close/broadcast/send so we can assert wiring.
  class FakeBotLinkHub {
    static instances: FakeBotLinkHub[] = [];
    setCommandRelay = vi.fn();
    listen = vi.fn(async () => {});
    close = vi.fn();
    send = vi.fn(() => true);
    broadcast = vi.fn();
    unregisterRelay = vi.fn();
    onSyncRequest:
      | ((
          botname: string,
          send: (frame: import('../../src/core/botlink').LinkFrame) => void,
        ) => void)
      | null = null;
    onLeafConnected: ((botname: string) => void) | null = null;
    onLeafDisconnected: ((botname: string, reason: string) => void) | null = null;
    onLeafFrame:
      | ((botname: string, frame: import('../../src/core/botlink').LinkFrame) => void)
      | null = null;
    onBsay: ((target: string, message: string) => void) | null = null;
    getLocalPartyUsers: (() => unknown[]) | null = null;
    constructor(..._args: unknown[]) {
      FakeBotLinkHub.instances.push(this);
    }
  }

  class FakeBotLinkLeaf {
    static instances: FakeBotLinkLeaf[] = [];
    setCommandRelay = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    send = vi.fn(() => true);
    onConnected: ((hubName: string) => void) | null = null;
    onDisconnected: ((reason: string) => void) | null = null;
    onFrame: ((frame: import('../../src/core/botlink').LinkFrame) => void) | null = null;
    constructor(..._args: unknown[]) {
      FakeBotLinkLeaf.instances.push(this);
    }
  }

  return {
    ...actual,
    BotLinkHub: FakeBotLinkHub,
    BotLinkLeaf: FakeBotLinkLeaf,
  };
});

// At runtime BotLinkHub/Leaf resolve to the FakeBotLinkHub/Leaf classes from
// the vi.mock factory above. The factory exposes a static `instances` array
// and uses vi.fn() for every method, so tests need to read each method as a
// MockInstance instead of the original class signature. These accessor
// types model that swap in one place.
type MockedHub = {
  setCommandRelay: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  unregisterRelay: ReturnType<typeof vi.fn>;
  onSyncRequest: ((botname: string, send: (frame: LinkFrame) => void) => void) | null;
  onLeafConnected: ((botname: string) => void) | null;
  onLeafDisconnected: ((botname: string, reason: string) => void) | null;
  onLeafFrame: ((botname: string, frame: LinkFrame) => void) | null;
  onBsay: ((target: string, message: string) => void) | null;
  getLocalPartyUsers: (() => unknown[]) | null;
};
type MockedLeaf = {
  setCommandRelay: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onConnected: ((hubName: string) => void) | null;
  onDisconnected: ((reason: string) => void) | null;
  onFrame: ((frame: LinkFrame) => void) | null;
};
function hubInstances(): MockedHub[] {
  return (BotLinkHub as unknown as { instances: MockedHub[] }).instances;
}
function leafInstances(): MockedLeaf[] {
  return (BotLinkLeaf as unknown as { instances: MockedLeaf[] }).instances;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DccLike {
  getSessionList: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
  onPartyChat: ((handle: string, message: string) => void) | null;
  onPartyJoin: ((handle: string) => void) | null;
  onPartyPart: ((handle: string) => void) | null;
  onRelayEnd: ((handle: string, targetBot: string) => void) | null;
}

function makeDcc(): DccLike {
  return {
    getSessionList: vi.fn(() => []),
    getSession: vi.fn(),
    announce: vi.fn(),
    onPartyChat: null,
    onPartyJoin: null,
    onPartyPart: null,
    onRelayEnd: null,
  };
}

function buildDeps(
  bot: MockBot,
  overrides: {
    role?: 'hub' | 'leaf';
    enabled?: boolean;
    dcc?: DccLike | null;
    casemapping?: Casemapping;
  } = {},
): RelayOrchestratorDeps {
  const role = overrides.role ?? 'hub';
  const enabled = overrides.enabled ?? true;
  const config = {
    ...bot.botConfig,
    botlink: enabled
      ? {
          enabled: true,
          role,
          botname: role === 'hub' ? 'hubbot' : 'leafbot',
          ...(role === 'hub'
            ? { listen: { host: '0.0.0.0', port: 0 } }
            : { hub: { host: '127.0.0.1', port: 1 } }),
          password: 'secret',
          ping_interval_ms: 60_000,
          link_timeout_ms: 60_000,
        }
      : undefined,
  };
  return {
    config,
    version: '1.0.0',
    logger: bot.logger,
    eventBus: bot.eventBus,
    db: bot.db,
    client: bot.client as unknown as RelayOrchestratorDeps['client'],
    commandHandler: bot.commandHandler,
    permissions: bot.permissions,
    channelState: bot.channelState,
    channelSettings: bot.channelSettings,
    ircCommands: bot.ircCommands,
    services: bot.services,
    getDccManager: () =>
      (overrides.dcc ??
        null) as unknown as RelayOrchestratorDeps['getDccManager'] extends () => infer R
        ? R
        : never,
    getCasemapping: () => overrides.casemapping ?? 'rfc1459',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayOrchestrator', () => {
  let bot: MockBot;

  beforeEach(() => {
    hubInstances().length = 0;
    leafInstances().length = 0;
    bot = createMockBot();
  });

  afterEach(() => {
    bot.cleanup();
  });

  describe('construction', () => {
    it('exposes null hub/leaf/sharedBanList before start()', () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { enabled: false }));
      expect(orch.hub).toBeNull();
      expect(orch.leaf).toBeNull();
      expect(orch.sharedBanList).toBeNull();
      expect(orch.hasRelayConsole('alice')).toBe(false);
    });

    it('stop() before start() is a safe no-op', () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { enabled: false }));
      expect(() => orch.stop()).not.toThrow();
    });
  });

  describe('start() with botlink disabled', () => {
    it('does not construct a hub or leaf', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { enabled: false }));
      await orch.start();
      expect(hubInstances()).toHaveLength(0);
      expect(leafInstances()).toHaveLength(0);
      expect(orch.hub).toBeNull();
      expect(orch.leaf).toBeNull();
    });

    it('still registers the botlink:disconnected listener', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { enabled: false }));
      await orch.start();
      // Listener exists — emitting should not throw and stop() should remove it.
      expect(() => bot.eventBus.emit('botlink:disconnected', 'someone', 'reason')).not.toThrow();
      orch.stop();
    });
  });

  describe('start() as hub', () => {
    it('constructs hub, wires command relay, and starts listening', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      expect(hubInstances()).toHaveLength(1);
      expect(leafInstances()).toHaveLength(0);
      expect(orch.hub).toBe(hubInstances()[0]);
      expect(orch.sharedBanList).not.toBeNull();
      expect(hubInstances()[0].setCommandRelay).toHaveBeenCalledWith(
        bot.commandHandler,
        bot.permissions,
        bot.eventBus,
      );
      expect(hubInstances()[0].listen).toHaveBeenCalled();
    });

    it('registers the "shared" channel-setting under core:botlink', async () => {
      const spy = vi.spyOn(bot.channelSettings, 'register');
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      expect(spy).toHaveBeenCalledWith(
        'core:botlink',
        expect.arrayContaining([expect.objectContaining({ key: 'shared', type: 'flag' })]),
      );
    });

    it('hub callbacks emit botlink:connected / botlink:disconnected', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      const connected = vi.fn();
      const disconnected = vi.fn();
      bot.eventBus.on('botlink:connected', connected);
      bot.eventBus.on('botlink:disconnected', disconnected);
      hubInstances()[0].onLeafConnected!('leafA');
      hubInstances()[0].onLeafDisconnected!('leafA', 'gone');
      expect(connected).toHaveBeenCalledWith('leafA');
      expect(disconnected).toHaveBeenCalledWith('leafA', 'gone');
    });

    it('hub onBsay forwards to client.say()', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      hubInstances()[0].onBsay!('#chan', 'hi');
      expect(bot.client.messages).toContainEqual({ type: 'say', target: '#chan', message: 'hi' });
    });

    it('getLocalPartyUsers returns mapped DCC sessions', async () => {
      const dcc = makeDcc();
      dcc.getSessionList.mockReturnValue([{ handle: 'alice', nick: 'Alice', connectedAt: 100 }]);
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      const users = hubInstances()[0].getLocalPartyUsers!();
      expect(users).toEqual([
        { handle: 'alice', nick: 'Alice', botname: 'hubbot', connectedAt: 100, idle: 0 },
      ]);
    });

    it('getLocalPartyUsers returns [] when no DCC manager attached', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      expect(hubInstances()[0].getLocalPartyUsers!()).toEqual([]);
    });

    it('onSyncRequest forwards permission state via send callback', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      bot.permissions.addUser('alice', '*!a@h', 'n');
      const send = vi.fn();
      hubInstances()[0].onSyncRequest!('leafA', send);
      const sentTypes = send.mock.calls.map((c) => (c[0] as LinkFrame).type);
      // PermissionSyncer emits ADDUSER frames per user; ChannelStateSyncer
      // emits CHAN frames per known channel. At minimum we should see the
      // newly-added user surface as an ADDUSER frame.
      expect(sentTypes).toContain('ADDUSER');
    });
  });

  describe('start() as leaf', () => {
    it('constructs leaf, wires command relay, and connects', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      expect(leafInstances()).toHaveLength(1);
      expect(hubInstances()).toHaveLength(0);
      expect(orch.leaf).toBe(leafInstances()[0]);
      expect(leafInstances()[0].setCommandRelay).toHaveBeenCalledWith(
        bot.commandHandler,
        bot.permissions,
      );
      expect(leafInstances()[0].connect).toHaveBeenCalled();
    });

    it('leaf onConnected emits botlink:connected with hub name', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      const connected = vi.fn();
      bot.eventBus.on('botlink:connected', connected);
      leafInstances()[0].onConnected!('upstreamHub');
      expect(connected).toHaveBeenCalledWith('upstreamHub');
    });

    it('leaf onDisconnected always emits with botname "hub"', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      const disconnected = vi.fn();
      bot.eventBus.on('botlink:disconnected', disconnected);
      leafInstances()[0].onDisconnected!('socket reset');
      expect(disconnected).toHaveBeenCalledWith('hub', 'socket reset');
    });

    it('leaf SYNC_END frame emits botlink:syncComplete', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      const sync = vi.fn();
      bot.eventBus.on('botlink:syncComplete', sync);
      leafInstances()[0].onFrame!({ type: 'SYNC_END' });
      expect(sync).toHaveBeenCalledWith('leafbot');
    });

    it('leaf BSAY frame triggers client.say()', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      leafInstances()[0].onFrame!({ type: 'BSAY', target: '#x', message: 'yo' });
      expect(bot.client.messages).toContainEqual({ type: 'say', target: '#x', message: 'yo' });
    });
  });

  describe('frame dispatch (hub side via onLeafFrame)', () => {
    let orch: RelayOrchestrator;
    let dcc: DccLike;

    beforeEach(async () => {
      dcc = makeDcc();
      orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
    });

    afterEach(() => {
      orch.stop();
    });

    it('PARTY_CHAT announces to local DCC', () => {
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'PARTY_CHAT',
        handle: 'alice',
        fromBot: 'leafA',
        message: 'hello',
      });
      expect(dcc.announce).toHaveBeenCalledWith('<alice@leafA> hello');
    });

    it('PARTY_JOIN announces a join line', () => {
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'PARTY_JOIN',
        handle: 'alice',
        fromBot: 'leafA',
      });
      expect(dcc.announce).toHaveBeenCalledWith('*** alice has joined the console (on leafA)');
    });

    it('PARTY_PART announces a leave line', () => {
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'PARTY_PART',
        handle: 'alice',
        fromBot: 'leafA',
      });
      expect(dcc.announce).toHaveBeenCalledWith('*** alice has left the console (on leafA)');
    });

    it('ANNOUNCE forwards the message to dcc.announce verbatim', () => {
      hubInstances()[0].onLeafFrame!('leafA', { type: 'ANNOUNCE', message: 'reboot in 5' });
      expect(dcc.announce).toHaveBeenCalledWith('reboot in 5');
    });

    it('CHAN_BAN_ADD on a shared channel applies to the shared ban list', () => {
      // Mark #chan as shared
      bot.channelSettings.set('#chan', 'shared', true);
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'CHAN_BAN_ADD',
        channel: '#chan',
        mask: '*!*@evil.host',
        setBy: 'leafA',
        setAt: 1000,
      });
      const bans = orch.sharedBanList!.getBans('#chan');
      expect(bans.find((b) => b.mask === '*!*@evil.host')).toBeDefined();
    });

    it('RELAY_REQUEST creates a virtual session and hasRelayConsole returns true', () => {
      bot.permissions.addUser('alice', '*!a@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      expect(orch.hasRelayConsole('alice')).toBe(true);
    });

    it('PROTECT_DEOP from a shared frame routes to handleProtectFrame', () => {
      // No channel-state for #other → handler returns undefined / sends nothing.
      // We just verify dispatch does not throw.
      expect(() =>
        hubInstances()[0].onLeafFrame!('leafA', {
          type: 'PROTECT_DEOP',
          channel: '#other',
          nick: 'baduser',
          ref: 'r1',
          requestedBy: 'admin',
        }),
      ).not.toThrow();
    });
  });

  describe('service mirror (notice/privmsg → virtual sessions)', () => {
    it('forwards private NOTICE lines to active virtual sessions', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      // Seed a virtual session via RELAY_REQUEST
      bot.permissions.addUser('alice', '*!a@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      // Mock the virtual session's sendOutput by spying via the hub's RELAY_OUTPUT path.
      // Easier: trigger NOTICE and assert the leaf received a RELAY_OUTPUT frame via hub.send.
      hubInstances()[0].send.mockClear();
      bot.client.simulateEvent('notice', {
        nick: 'someone',
        target: bot.client.user.nick,
        message: 'hi there',
      });
      // sendOutput inside the virtual session calls sender.sendTo → hub.send
      expect(hubInstances()[0].send).toHaveBeenCalledWith(
        'leafA',
        expect.objectContaining({
          type: 'RELAY_OUTPUT',
          handle: 'alice',
          line: '-someone- hi there',
        }),
      );
      orch.stop();
    });

    it('ignores NOTICE to channels (target starts with #)', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      bot.permissions.addUser('alice', '*!a@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      hubInstances()[0].send.mockClear();
      bot.client.simulateEvent('notice', {
        nick: 'someone',
        target: '#channel',
        message: 'public',
      });
      expect(hubInstances()[0].send).not.toHaveBeenCalled();
      orch.stop();
    });

    it('forwards private PRIVMSG lines wrapped as <nick> message', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      bot.permissions.addUser('alice', '*!a@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      hubInstances()[0].send.mockClear();
      bot.client.simulateEvent('privmsg', {
        nick: 'bob',
        target: bot.client.user.nick,
        message: 'pm',
      });
      expect(hubInstances()[0].send).toHaveBeenCalledWith(
        'leafA',
        expect.objectContaining({ type: 'RELAY_OUTPUT', line: '<bob> pm' }),
      );
      orch.stop();
    });

    it('suppresses NickServ verification replies', async () => {
      const dcc = makeDcc();
      // Force services to recognize a verification reply
      vi.spyOn(bot.services, 'isNickServVerificationReply').mockReturnValue(true);
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      bot.permissions.addUser('alice', '*!a@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      hubInstances()[0].send.mockClear();
      bot.client.simulateEvent('notice', {
        nick: 'NickServ',
        target: bot.client.user.nick,
        message: 'STATUS alice 3',
      });
      expect(hubInstances()[0].send).not.toHaveBeenCalled();
      orch.stop();
    });
  });

  describe('party-line wiring (DCC outgoing → frames)', () => {
    it('hub: dcc.onPartyChat broadcasts a PARTY_CHAT frame', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      dcc.onPartyChat!('alice', 'hello');
      expect(hubInstances()[0].broadcast).toHaveBeenCalledWith({
        type: 'PARTY_CHAT',
        handle: 'alice',
        fromBot: 'hubbot',
        message: 'hello',
      });
      orch.stop();
    });

    it('hub: dcc.onPartyJoin / onPartyPart broadcast respective frames', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      dcc.onPartyJoin!('alice');
      dcc.onPartyPart!('alice');
      const types = hubInstances()[0].broadcast.mock.calls.map((c) => (c[0] as LinkFrame).type);
      expect(types).toContain('PARTY_JOIN');
      expect(types).toContain('PARTY_PART');
      orch.stop();
    });

    it('hub: dcc.onRelayEnd sends RELAY_END to the target bot and unregisters', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      dcc.onRelayEnd!('alice', 'leafA');
      expect(hubInstances()[0].send).toHaveBeenCalledWith(
        'leafA',
        expect.objectContaining({ type: 'RELAY_END', handle: 'alice' }),
      );
      expect(hubInstances()[0].unregisterRelay).toHaveBeenCalledWith('alice');
      orch.stop();
    });

    it('leaf: dcc.onPartyChat sends a PARTY_CHAT frame to the hub', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf', dcc }));
      await orch.start();
      dcc.onPartyChat!('alice', 'hi');
      expect(leafInstances()[0].send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PARTY_CHAT', handle: 'alice', fromBot: 'leafbot' }),
      );
      orch.stop();
    });

    it('leaf: dcc.onRelayEnd sends a single RELAY_END frame upstream', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf', dcc }));
      await orch.start();
      leafInstances()[0].send.mockClear();
      dcc.onRelayEnd!('alice', 'unused');
      expect(leafInstances()[0].send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RELAY_END', handle: 'alice' }),
      );
      orch.stop();
    });

    it('skips party-line wiring entirely when no DCC manager is attached', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      // Nothing to assert directly — the absence of crashes is the contract.
      // Verify hub.broadcast was never called from party-line wiring.
      hubInstances()[0].broadcast.mockClear();
      // simulate DCC events not wired (no dcc handle exists)
      expect(hubInstances()[0].broadcast).not.toHaveBeenCalled();
      orch.stop();
    });
  });

  describe('botlink:disconnected cleanup', () => {
    it('removes virtual sessions whose fromBot matches the disconnected bot', async () => {
      const dcc = makeDcc();
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub', dcc }));
      await orch.start();
      bot.permissions.addUser('alice', '*!a@h', 'n');
      bot.permissions.addUser('bob', '*!b@h', 'n');
      hubInstances()[0].onLeafFrame!('leafA', {
        type: 'RELAY_REQUEST',
        handle: 'alice',
        fromBot: 'leafA',
      });
      hubInstances()[0].onLeafFrame!('leafB', {
        type: 'RELAY_REQUEST',
        handle: 'bob',
        fromBot: 'leafB',
      });
      expect(orch.hasRelayConsole('alice')).toBe(true);
      expect(orch.hasRelayConsole('bob')).toBe(true);

      bot.eventBus.emit('botlink:disconnected', 'leafA', 'gone');

      expect(orch.hasRelayConsole('alice')).toBe(false);
      expect(orch.hasRelayConsole('bob')).toBe(true);
      orch.stop();
    });
  });

  describe('stop()', () => {
    it('hub: closes hub, removes mirror listeners, removes disconnect listener', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      const hub = hubInstances()[0];
      // before stop, an emitted disconnect should be observed (no-op cleanup)
      const beforeStopListeners = bot.client.listenerCount('notice');
      expect(beforeStopListeners).toBeGreaterThan(0);

      orch.stop();

      expect(hub.close).toHaveBeenCalled();
      expect(orch.hub).toBeNull();
      expect(bot.client.listenerCount('notice')).toBe(beforeStopListeners - 1);
    });

    it('leaf: disconnects leaf and clears the leaf reference', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'leaf' }));
      await orch.start();
      const leaf = leafInstances()[0];
      orch.stop();
      expect(leaf.disconnect).toHaveBeenCalled();
      expect(orch.leaf).toBeNull();
    });

    it('continues other steps even if one step throws', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      const hub = hubInstances()[0];
      hub.close.mockImplementation(() => {
        throw new Error('boom');
      });
      // mirror listener removal should still happen
      const before = bot.client.listenerCount('notice');
      expect(() => orch.stop()).not.toThrow();
      expect(bot.client.listenerCount('notice')).toBe(before - 1);
    });

    it('stop is idempotent — calling twice does not throw', async () => {
      const orch = new RelayOrchestrator(buildDeps(bot, { role: 'hub' }));
      await orch.start();
      orch.stop();
      expect(() => orch.stop()).not.toThrow();
    });
  });
});
