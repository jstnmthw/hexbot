import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../../src/command-handler';
import type { CommandContext } from '../../../src/command-handler';
import { BotLinkHub, BotLinkLeaf, type LinkFrame } from '../../../src/core/botlink';
import { registerBotlinkCommands } from '../../../src/core/commands/botlink-commands';
import type { BotlinkDCCView } from '../../../src/core/dcc';
import { BotDatabase } from '../../../src/database';
import type { BotlinkConfig } from '../../../src/types';
import {
  TEST_LINK_SALT,
  answerHelloChallenge,
  createMockSocket,
  parseWritten,
  pushFrame,
  testLinkKey,
} from '../../helpers/mock-socket';

// Memoize deriveLinkKey across the file. scryptSync (~50ms) runs on every
// BotLinkHub/Leaf/AuthManager construction; a single (password, salt) pair
// is reused across tests, so caching collapses repeated KDF cost. vi.mock
// is hoisted before any production import.
vi.mock('../../../src/core/botlink/protocol', async () => {
  const actual = await vi.importActual<typeof import('../../../src/core/botlink/protocol')>(
    '../../../src/core/botlink/protocol',
  );
  const cache = new Map<string, Buffer>();
  return {
    ...actual,
    deriveLinkKey(password: string, linkSaltHex: string): Buffer {
      const cacheKey = `${password}\0${linkSaltHex}`;
      let key = cache.get(cacheKey);
      if (!key) {
        key = actual.deriveLinkKey(password, linkSaltHex);
        cache.set(cacheKey, key);
      }
      return Buffer.from(key);
    },
  };
});

// Derive once at module load — the HMAC key depends only on the shared
// test password + link salt, so reusing it across tests trims per-test
// scrypt cost to a single call.
const SECRET_LINK_KEY = testLinkKey('secret');

// Track hubs so afterEach can close() them — otherwise BotLinkAuthManager's
// 5-minute sweepTimer leaks across the test run (unref'd so process still exits).
const _createdHubs: BotLinkHub[] = [];
function makeHub(...args: ConstructorParameters<typeof BotLinkHub>): BotLinkHub {
  const h = new BotLinkHub(...args);
  _createdHubs.push(h);
  return h;
}
afterEach(() => {
  while (_createdHubs.length) _createdHubs.pop()?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(replies: string[], overrides?: Partial<CommandContext>): CommandContext {
  return {
    source: 'repl',
    nick: 'admin',
    channel: null,
    reply: (msg) => replies.push(msg),
    ...overrides,
  };
}

function hubConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'myhub',
    listen: { host: '127.0.0.1', port: 15051 },
    password: 'secret',
    link_salt: TEST_LINK_SALT,
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
  };
}

function leafConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'leaf',
    botname: 'myleaf',
    hub: { host: '127.0.0.1', port: 15051 },
    password: 'secret',
    link_salt: TEST_LINK_SALT,
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
    reconnect_delay_ms: 600_000,
  };
}

/**
 * Yield once via `setImmediate` so the botlink state machine can drain
 * pending microtasks (frame parser, HMAC verify, fanout) between scripted
 * pushes. Without this, assertions can race ahead of the side effect they
 * are checking.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Connect a leaf to a mock socket and complete the handshake.
 * Returns the connected leaf and the socket.
 */
async function connectLeaf(
  cfg?: BotlinkConfig,
): Promise<{ leaf: BotLinkLeaf; socket: Socket; written: string[]; duplex: Duplex }> {
  const leaf = new BotLinkLeaf(cfg ?? leafConfig(), '1.0.0');
  const { socket, written, duplex } = createMockSocket();
  leaf.connectWithSocket(socket);
  // Leaf blocks on HELLO_CHALLENGE before it will accept WELCOME.
  pushFrame(duplex, { type: 'HELLO_CHALLENGE', nonce: 'a'.repeat(64), hubBotname: 'thehub' });
  await tick();
  pushFrame(duplex, { type: 'WELCOME', botname: 'thehub', version: '1.0' });
  await tick();
  return { leaf, socket, written, duplex };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('botlink commands', () => {
  describe('when botlink is disabled', () => {
    it('.botlink status says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf: null, config: null, db: null });
      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('.bots says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf: null, config: null, db: null });
      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('.bottree says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf: null, config: null, db: null });
      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });
  });

  describe('hub mode', () => {
    it('.botlink status shows hub info with no leaves', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('hub');
      expect(replies[0]).toContain('myhub');
      expect(replies[1]).toBe('No leaves connected.');

      hub.close();
    });

    it('.bots lists the hub bot', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('myhub (hub, this bot)');

      hub.close();
    });

    it('.bottree shows the hub as root', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toBe('myhub (hub)');

      hub.close();
    });

    it('.botlink disconnect requires a botname', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink disconnect', makeCtx(replies));

      expect(replies[0]).toContain('Usage');

      hub.close();
    });

    it('.botlink reconnect is hub-only error', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink reconnect', makeCtx(replies));

      expect(replies[0]).toContain('Only available on leaf');

      hub.close();
    });
  });

  describe('hub mode with connected leaves', () => {
    let hub: BotLinkHub;

    afterEach(() => hub?.close());

    async function hubWithLeaf(): Promise<{
      hub: BotLinkHub;
      handler: CommandHandler;
      leafWritten: string[];
    }> {
      hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      // Simulate a leaf connecting through the hub
      const { socket: leafSocket, written: leafWritten, duplex: leafDuplex } = createMockSocket();
      hub.addConnection(leafSocket);
      answerHelloChallenge(leafWritten, leafDuplex, SECRET_LINK_KEY, 'leaf1');
      await tick();

      return { hub, handler, leafWritten };
    }

    it('.botlink status shows connected leaves', async () => {
      const { handler } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('hub');
      expect(replies[0]).toContain('myhub');
      expect(replies[1]).toContain('Connected leaves (1)');
      expect(replies[1]).toContain('leaf1');
    });

    it('.botlink disconnect with valid leaf closes connection and removes leaf', async () => {
      const { hub, handler, leafWritten } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.botlink disconnect leaf1', makeCtx(replies));

      expect(replies[0]).toBe('Disconnected "leaf1".');
      // Verify an ERROR frame was sent to the leaf
      const sent = leafWritten.join('');
      expect(sent).toContain('CLOSING');
      expect(sent).toContain('Disconnected by admin');
      // Leaf should actually be removed from the hub
      expect(hub.getLeaves()).toEqual([]);
    });

    it('.botlink disconnect with unknown leaf says not found', async () => {
      const { handler } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.botlink disconnect nosuchbot', makeCtx(replies));

      expect(replies[0]).toBe('Leaf "nosuchbot" not found.');
    });

    it('.bots lists hub and connected leaves', async () => {
      const { handler } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('Linked bots (2)');
      expect(replies[0]).toContain('myhub (hub, this bot)');
      expect(replies[0]).toContain('leaf1 (leaf');
    });

    it('.bottree shows tree with leaves', async () => {
      const { handler } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toContain('myhub (hub)');
      expect(replies[0]).toContain('leaf1 (leaf)');
      // Single leaf uses the last-item prefix
      expect(replies[0]).toContain('└─');
    });
  });

  describe('leaf mode — connected', () => {
    it('.botlink status shows connected leaf info', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      const cfg = leafConfig();
      registerBotlinkCommands({ handler, hub: null, leaf, config: cfg, db: null });

      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('leaf');
      expect(replies[0]).toContain('myleaf');
      expect(replies[1]).toContain('Connected to hub "thehub"');

      leaf.disconnect();
    });

    it('.botlink reconnect triggers reconnect on leaf', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      const cfg = leafConfig();
      registerBotlinkCommands({ handler, hub: null, leaf, config: cfg, db: null });

      const replies: string[] = [];
      await handler.execute('.botlink reconnect', makeCtx(replies));

      expect(replies[0]).toBe('Reconnecting to hub...');

      leaf.disconnect();
    });

    it('.botlink disconnect says hub-only on leaf', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink disconnect leaf1', makeCtx(replies));

      expect(replies[0]).toBe('Only available on hub bots.');

      leaf.disconnect();
    });

    it('.bots on connected leaf shows hub and self', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      const cfg = leafConfig();
      registerBotlinkCommands({ handler, hub: null, leaf, config: cfg, db: null });

      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('Linked bots (2)');
      expect(replies[0]).toContain('thehub (hub)');
      expect(replies[0]).toContain('myleaf (leaf, this bot)');

      leaf.disconnect();
    });

    it('.bottree on connected leaf shows hub with leaf underneath', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      const cfg = leafConfig();
      registerBotlinkCommands({ handler, hub: null, leaf, config: cfg, db: null });

      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toContain('thehub (hub)');
      expect(replies[0]).toContain('myleaf (leaf, this bot)');
      expect(replies[0]).toContain('└─');

      leaf.disconnect();
    });
  });

  describe('leaf mode — disconnected', () => {
    it('.botlink status shows disconnected state', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('leaf');
      expect(replies[0]).toContain('myleaf');
      expect(replies[1]).toContain('disconnected');
    });

    it('.bots on disconnected leaf shows self as disconnected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('myleaf (leaf, disconnected)');
    });

    it('.bottree on disconnected leaf shows self as disconnected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toContain('myleaf (leaf, disconnected)');
    });
  });

  describe('.relay command', () => {
    it('says not enabled when botlink is disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf: null, config: null, db: null });
      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies));

      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('shows usage when no target is given', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.relay', makeCtx(replies));

      expect(replies[0]).toBe('Usage: .relay <botname>');

      hub.close();
    });

    it('rejects from non-DCC source (repl)', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      // repl source bypasses permission check, but then the handler checks ctx.source !== 'dcc'
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'repl' }));

      expect(replies[0]).toBe('.relay is only available from DCC sessions.');

      hub.close();
    });

    it('says DCC not enabled when dccManager is null (from DCC source)', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      // Provide a permissive permissions provider so the DCC source passes the flag check
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toBe('DCC is not enabled.');

      hub.close();
    });
  });

  describe('.relay DCC integration', () => {
    it('session not found returns error', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => undefined,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Could not find your DCC session.');
      hub.close();
    });

    it('already relaying returns error', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockSession = { handle: 'admin', isRelaying: true, enterRelay: vi.fn() };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Already relaying. Use .relay end first.');
      hub.close();
    });

    it('hub mode: target bot not connected returns error', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: vi.fn() };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay nobot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Bot "nobot" is not connected.');
      hub.close();
    });

    it('hub mode: sends relay request and enters relay mode', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      // Connect a leaf so it's a valid target
      const { socket: leafSocket, written: leafWritten, duplex: leafDuplex } = createMockSocket();
      hub.addConnection(leafSocket);
      answerHelloChallenge(leafWritten, leafDuplex, SECRET_LINK_KEY, 'leaf1');
      await tick();
      leafWritten.length = 0;

      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const enterRelayFn = vi.fn();
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: enterRelayFn };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay leaf1', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toContain('Requesting relay to leaf1');
      expect(enterRelayFn).toHaveBeenCalledWith(
        'leaf1',
        expect.any(Function),
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      hub.close();
    });

    it('leaf mode: sends relay request via leaf', async () => {
      const { leaf, written } = await connectLeaf();
      written.length = 0;

      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const enterRelayFn = vi.fn();
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: enterRelayFn };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf,
        config: leafConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toContain('Requesting relay to somebot');
      expect(enterRelayFn).toHaveBeenCalled();
      leaf.disconnect();
    });

    it('no hub or leaf returns not connected error', async () => {
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: vi.fn() };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } satisfies BotlinkDCCView;
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Not connected to any bot link.');
    });
  });

  describe('.whom command — leaf with hub', () => {
    it('leaf requests whom from hub when connected', async () => {
      const { leaf, written, duplex } = await connectLeaf();
      written.length = 0;

      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const promise = handler.execute('.whom', makeCtx([]));
      await tick();

      // Leaf should have sent PARTY_WHOM
      const sent = parseWritten(written);
      const whom = sent.find((f: LinkFrame) => f.type === 'PARTY_WHOM');
      expect(whom).toBeDefined();

      // Respond with a user
      pushFrame(duplex, {
        type: 'PARTY_WHOM_REPLY',
        ref: whom!.ref,
        users: [{ handle: 'remote', nick: 'R', botname: 'hub', connectedAt: Date.now(), idle: 0 }],
      });
      await tick();
      await promise;

      leaf.disconnect();
    });
  });

  describe('.whom command', () => {
    it('does not crash when config is null but DCC is enabled', async () => {
      const handler = new CommandHandler();
      const mockDcc = {
        getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: Date.now() - 5_000 }],
        getSession: () => undefined,
      };
      // config=null simulates DCC enabled without botlink configured
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf: null,
        config: null,
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toContain('Console (1 user)');
      expect(replies[0]).toContain('alice');
      expect(replies[0]).toContain('unknown'); // fallback botname
    });

    it('reports no users when DCC is not available and no link', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf: null,
        config: { ...hubConfig(), enabled: true },
        db: null,
      });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');
    });

    it('reports no users when hub has no remote party users and no DCC', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');

      hub.close();
    });

    it('reports no users when leaf is disconnected and no DCC', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');
    });

    it('lists local DCC users via mock dccManager', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      const mockDcc = {
        getSessionList: () => [
          { handle: 'alice', nick: 'Alice', connectedAt: Date.now() - 10_000 },
        ],
        getSession: () => undefined,
      };
      registerBotlinkCommands({
        handler,
        hub,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toContain('Console (1 user)');
      expect(replies[0]).toContain('alice');
      expect(replies[0]).toContain('Alice');
      expect(replies[0]).toContain('myhub');

      hub.close();
    });

    it('uses singular "user" for exactly one user', async () => {
      const handler = new CommandHandler();
      const mockDcc = {
        getSessionList: () => [{ handle: 'solo', nick: 'Solo', connectedAt: Date.now() - 5_000 }],
        getSession: () => undefined,
      };
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toContain('Console (1 user):');
      // No 's' after 'user'
      expect(replies[0]).not.toContain('users');
    });

    it('uses plural "users" for more than one user', async () => {
      const handler = new CommandHandler();
      const mockDcc = {
        getSessionList: () => [
          { handle: 'alice', nick: 'Alice', connectedAt: Date.now() - 5_000 },
          { handle: 'bob', nick: 'Bob', connectedAt: Date.now() - 3_000 },
        ],
        getSession: () => undefined,
      };
      registerBotlinkCommands({
        handler,
        hub: null,
        leaf: null,
        config: hubConfig(),
        db: null,
        dccManager: mockDcc,
      });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toContain('Console (2 users):');
    });
  });

  describe('unknown subcommand', () => {
    it('.botlink foo shows usage', async () => {
      const hub = makeHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

      const replies: string[] = [];
      await handler.execute('.botlink foo', makeCtx(replies));

      expect(replies[0]).toContain('Usage');

      hub.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: edge cases
// ---------------------------------------------------------------------------

describe('branch coverage edge cases', () => {
  it('.botlink with empty string defaults to status', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });

    const replies: string[] = [];
    await handler.execute('.botlink', makeCtx(replies));
    expect(replies[0]).toContain('hub');
    hub.close();
  });

  it('.bottree with multiple leaves shows ├─ and └─ prefixes', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket: s1, written: w1, duplex: d1 } = createMockSocket();
    hub.addConnection(s1);
    answerHelloChallenge(w1, d1, SECRET_LINK_KEY, 'leaf1');
    await tick();
    const { socket: s2, written: w2, duplex: d2 } = createMockSocket();
    hub.addConnection(s2);
    answerHelloChallenge(w2, d2, SECRET_LINK_KEY, 'leaf2');
    await tick();

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bottree', makeCtx(replies));
    expect(replies[0]).toContain('├─ leaf1');
    expect(replies[0]).toContain('└─ leaf2');
    hub.close();
  });

  it('.whom shows idle time when idle > 0', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    // Inject a remote party user with idle time
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    pushFrame(duplex, { type: 'PARTY_JOIN', handle: 'idler', nick: 'Idler', fromBot: 'leaf1' });
    await tick();

    // Manually set idle on the remote user (hack for testing)
    const remoteUsers = hub.getRemotePartyUsers();
    if (remoteUsers.length > 0) remoteUsers[0].idle = 120;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.whom', makeCtx(replies));
    expect(replies[0]).toContain('idle 120s');
    hub.close();
  });
});

// ---------------------------------------------------------------------------
// Edge case: config enabled but both hub and leaf are null
// ---------------------------------------------------------------------------

describe('botlink commands with neither hub nor leaf', () => {
  it('.botlink status produces no output when hub and leaf are both null', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink status', makeCtx(replies));
    expect(replies).toEqual([]);
  });

  it('.bots produces no output when hub and leaf are both null', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bots', makeCtx(replies));
    expect(replies).toEqual([]);
  });

  it('.bottree produces no output when hub and leaf are both null', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bottree', makeCtx(replies));
    expect(replies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// .bot command
// ---------------------------------------------------------------------------

describe('.bot command', () => {
  it('replies disabled when botlink is not enabled', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: { ...hubConfig(), enabled: false },
      db: null,
    });
    const replies: string[] = [];
    await handler.execute('.bot leaf1 status', makeCtx(replies));
    expect(replies[0]).toBe('Bot link is not enabled.');
  });

  it('shows usage with no args', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot', makeCtx(replies));
    expect(replies[0]).toContain('Usage');
  });

  it('shows usage with only botname and no command', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot leaf1', makeCtx(replies));
    expect(replies[0]).toContain('Usage');
  });

  it('executes locally when target is self', async () => {
    const allowAll = { checkFlags: () => true };
    const handler = new CommandHandler(allowAll);
    handler.registerCommand(
      'status',
      { flags: '-', description: 'test', usage: '.status', category: 'test' },
      (_a, c) => {
        c.reply('I am alive');
      },
    );
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot myhub status', makeCtx(replies));
    expect(replies[0]).toBe('I am alive');
  });

  it('strips leading dot from command', async () => {
    const allowAll = { checkFlags: () => true };
    const handler = new CommandHandler(allowAll);
    handler.registerCommand(
      'status',
      { flags: '-', description: 'test', usage: '.status', category: 'test' },
      (_a, c) => {
        c.reply('alive');
      },
    );
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot myhub .status', makeCtx(replies));
    expect(replies[0]).toBe('alive');
  });

  it('hub sends command to connected leaf', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];

    const promise = handler.execute('.bot leaf1 status', makeCtx(replies));
    await tick();

    // Respond with CMD_RESULT
    const frames = parseWritten(written);
    const cmd = frames.find((f) => f.type === 'CMD');
    expect(cmd).toBeDefined();
    pushFrame(duplex, { type: 'CMD_RESULT', ref: cmd!.ref, output: ['OK'] });
    await tick();
    await promise;

    expect(replies).toContain('OK');
    hub.close();
  });

  it('hub returns error for unknown leaf', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot nobot status', makeCtx(replies));
    expect(replies[0]).toContain('not connected');
    hub.close();
  });

  it('leaf relays command to hub', async () => {
    const { leaf, written, duplex } = await connectLeaf();
    written.length = 0;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });
    const replies: string[] = [];

    const promise = handler.execute('.bot myhub status', makeCtx(replies));
    await tick();

    const frames = parseWritten(written);
    const cmd = frames.find((f) => f.type === 'CMD');
    expect(cmd).toBeDefined();
    pushFrame(duplex, { type: 'CMD_RESULT', ref: cmd!.ref, output: ['hub OK'] });
    await tick();
    await promise;

    expect(replies).toContain('hub OK');
    leaf.disconnect();
  });

  it('returns not connected when no hub or leaf', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bot remote status', makeCtx(replies));
    expect(replies[0]).toBe('Not connected to any bot link.');
  });
});

// ---------------------------------------------------------------------------
// .bsay command
// ---------------------------------------------------------------------------

describe('.bsay command', () => {
  it('replies disabled when botlink is not enabled', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: { ...hubConfig(), enabled: false },
      db: null,
    });
    const replies: string[] = [];
    await handler.execute('.bsay hub #test hello', makeCtx(replies));
    expect(replies[0]).toBe('Bot link is not enabled.');
  });

  it('shows usage with missing args', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bsay', makeCtx(replies));
    expect(replies[0]).toContain('Usage');
  });

  it('sends locally when target is self', async () => {
    const handler = new CommandHandler();
    const ircSay = vi.fn();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: hubConfig(),
      db: null,
      dccManager: null,
      ircSay,
    });
    const replies: string[] = [];
    await handler.execute('.bsay myhub #test hello world', makeCtx(replies));
    expect(ircSay).toHaveBeenCalledWith('#test', 'hello world');
    expect(replies[0]).toContain('local');
  });

  it('sanitizes target and message in local send path', async () => {
    const handler = new CommandHandler();
    const ircSay = vi.fn();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: hubConfig(),
      db: null,
      dccManager: null,
      ircSay,
    });
    const replies: string[] = [];
    // Inject \0 into target and message (these survive regex and trim)
    await handler.execute('.bsay myhub #test\0bad hello\0world', makeCtx(replies));
    // sanitize should strip \0
    expect(ircSay).toHaveBeenCalledTimes(1);
    const [calledTarget, calledMessage] = ircSay.mock.calls[0];
    expect(calledTarget).toBe('#testbad');
    expect(calledMessage).toBe('helloworld');
  });

  it('sends locally and reports no IRC client when ircSay is null', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: hubConfig(),
      db: null,
      dccManager: null,
      ircSay: null,
    });
    const replies: string[] = [];
    await handler.execute('.bsay myhub #test hello', makeCtx(replies));
    expect(replies[0]).toContain('IRC client not available');
  });

  it('broadcasts to all bots when target is *', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    const ircSay = vi.fn();
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub,
      leaf: null,
      config: hubConfig(),
      db: null,
      dccManager: null,
      ircSay,
    });
    const replies: string[] = [];
    await handler.execute('.bsay * #test broadcast msg', makeCtx(replies));

    expect(ircSay).toHaveBeenCalledWith('#test', 'broadcast msg');
    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'BSAY')).toBe(true);
    expect(replies[0]).toContain('all linked bots');
    hub.close();
  });

  it('leaf broadcasts to all bots via hub when target is *', async () => {
    const { leaf, written } = await connectLeaf();
    written.length = 0;

    const ircSay = vi.fn();
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf,
      config: leafConfig(),
      db: null,
      dccManager: null,
      ircSay,
    });
    const replies: string[] = [];
    await handler.execute('.bsay * #test hi', makeCtx(replies));

    expect(ircSay).toHaveBeenCalledWith('#test', 'hi');
    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'BSAY')).toBe(true);
    expect(replies[0]).toContain('all linked bots');
    leaf.disconnect();
  });

  it('hub sends to specific remote bot', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bsay leaf1 #test remote msg', makeCtx(replies));

    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'BSAY' && f.message === 'remote msg')).toBe(true);
    expect(replies[0]).toContain('via leaf1');
    hub.close();
  });

  it('hub returns error for unknown bot', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bsay nobot #test msg', makeCtx(replies));
    expect(replies[0]).toContain('not connected');
    hub.close();
  });

  it('leaf sends to specific remote bot via hub', async () => {
    const { leaf, written } = await connectLeaf();
    written.length = 0;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bsay somehub #test msg', makeCtx(replies));

    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'BSAY')).toBe(true);
    expect(replies[0]).toContain('via somehub');
    leaf.disconnect();
  });

  it('returns not connected when no hub or leaf', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bsay remotebot #test msg', makeCtx(replies));
    expect(replies[0]).toBe('Not connected to any bot link.');
  });
});

// ---------------------------------------------------------------------------
// .bannounce command
// ---------------------------------------------------------------------------

describe('.bannounce command', () => {
  it('replies disabled when botlink is not enabled', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub: null,
      leaf: null,
      config: { ...hubConfig(), enabled: false },
      db: null,
    });
    const replies: string[] = [];
    await handler.execute('.bannounce test', makeCtx(replies));
    expect(replies[0]).toBe('Bot link is not enabled.');
  });

  it('shows usage with empty message', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bannounce', makeCtx(replies));
    expect(replies[0]).toContain('Usage');
  });

  it('announces to local DCC and hub leaves', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    written.length = 0;

    const mockDcc = { announce: vi.fn(), getSessionList: () => [], getSession: () => undefined };
    const handler = new CommandHandler();
    registerBotlinkCommands({
      handler,
      hub,
      leaf: null,
      config: hubConfig(),
      db: null,
      dccManager: mockDcc,
    });
    const replies: string[] = [];
    await handler.execute('.bannounce hello everyone', makeCtx(replies));

    expect(mockDcc.announce).toHaveBeenCalledWith('*** hello everyone');
    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'ANNOUNCE')).toBe(true);
    expect(replies[0]).toContain('Announcement sent');
    hub.close();
  });

  it('leaf sends announce frame to hub', async () => {
    const { leaf, written } = await connectLeaf();
    written.length = 0;

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bannounce test msg', makeCtx(replies));

    const frames = parseWritten(written);
    expect(frames.some((f) => f.type === 'ANNOUNCE')).toBe(true);
    expect(replies[0]).toContain('Announcement sent');
    leaf.disconnect();
  });

  it('works with no hub, leaf, or DCC (local only)', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.bannounce solo message', makeCtx(replies));
    expect(replies[0]).toContain('Announcement sent');
  });
});

// ---------------------------------------------------------------------------
// .botlink bans / ban / unban subcommands
// ---------------------------------------------------------------------------

describe('.botlink ban subcommands', () => {
  it('.botlink bans shows active link bans', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');
    hub.manualBan('10.0.0.1', 0, 'test', 'admin');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink bans', makeCtx(replies));

    expect(replies[0]).toContain('Link bans');
    expect(replies[0]).toContain('10.0.0.1');
    hub.close();
  });

  it('.botlink bans shows "No active link bans" when empty', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink bans', makeCtx(replies));

    expect(replies[0]).toContain('No active link bans');
    hub.close();
  });

  it('.botlink ban adds a manual ban', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink ban 10.0.0.1 5m test reason', makeCtx(replies));

    expect(replies[0]).toContain('Banned 10.0.0.1');
    expect(hub.getAuthBans().find((b) => b.ip === '10.0.0.1')).toBeDefined();
    hub.close();
  });

  it('.botlink ban rejects invalid IP', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink ban not-an-ip', makeCtx(replies));

    expect(replies[0]).toContain('Invalid');
    hub.close();
  });

  it('.botlink ban shows usage when no args', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink ban', makeCtx(replies));

    expect(replies[0]).toContain('Usage');
    hub.close();
  });

  it('.botlink unban removes a ban', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');
    hub.manualBan('10.0.0.1', 0, 'test', 'admin');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink unban 10.0.0.1', makeCtx(replies));

    expect(replies[0]).toContain('Unbanned');
    expect(hub.getAuthBans()).toHaveLength(0);
    hub.close();
  });

  it('.botlink unban shows usage when no args', async () => {
    const hub = makeHub(hubConfig(), '1.0.0');
    await hub.listen(0, '127.0.0.1');

    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink unban', makeCtx(replies));

    expect(replies[0]).toContain('Usage');
    hub.close();
  });

  it('.botlink bans replies "Only available on hub" for leaf', async () => {
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db: null });
    const replies: string[] = [];
    await handler.execute('.botlink bans', makeCtx(replies));
    expect(replies[0]).toContain('Only available on hub');
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — audit coverage for botlink commands
// ---------------------------------------------------------------------------

describe('botlink commands — audit coverage', () => {
  function setup(): { db: BotDatabase; close: () => void } {
    const db = new BotDatabase(':memory:');
    db.open();
    return { db, close: () => db.close() };
  }

  it('.botlink disconnect writes a row on success', async () => {
    const { db, close } = setup();
    const hub = makeHub(hubConfig(), '1.0.0');
    const { socket, written, duplex } = createMockSocket();
    hub.addConnection(socket);
    answerHelloChallenge(written, duplex, SECRET_LINK_KEY, 'leaf1');
    await tick();
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db });
    await handler.execute('.botlink disconnect leaf1', makeCtx([]));

    const [row] = db.getModLog({ action: 'botlink-disconnect' });
    expect(row).toBeDefined();
    expect(row.target).toBe('leaf1');
    expect(row.outcome).toBe('success');
    hub.close();
    close();
  });

  it('.botlink disconnect writes a failure row when the leaf is unknown', async () => {
    const { db, close } = setup();
    const hub = makeHub(hubConfig(), '1.0.0');
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub, leaf: null, config: hubConfig(), db });
    await handler.execute('.botlink disconnect ghost', makeCtx([]));
    const [row] = db.getModLog({ action: 'botlink-disconnect' });
    expect(row.outcome).toBe('failure');
    expect(row.reason).toBe('leaf not found');
    hub.close();
    close();
  });

  it('.botlink reconnect writes a row', async () => {
    const { db, close } = setup();
    const { leaf } = await connectLeaf();
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf, config: leafConfig(), db });
    await handler.execute('.botlink reconnect', makeCtx([]));
    const [row] = db.getModLog({ action: 'botlink-reconnect' });
    expect(row).toBeDefined();
    leaf.disconnect();
    close();
  });

  it('.bot remote dispatch writes a row before handing off', async () => {
    const { db, close } = setup();
    const handler = new CommandHandler();
    // Self-target dispatches locally — we just want the audit row.
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db });
    await handler.execute('.bot myhub status', makeCtx([]));
    const [row] = db.getModLog({ action: 'bot-remote' });
    expect(row).toBeDefined();
    expect(row.target).toBe('myhub');
    expect(row.reason).toBe('.status');
    close();
  });

  it('.bsay writes a row carrying target + message metadata', async () => {
    const { db, close } = setup();
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db });
    await handler.execute('.bsay myhub #test hello', makeCtx([]));
    const [row] = db.getModLog({ action: 'bsay' });
    expect(row).toBeDefined();
    expect(row.target).toBe('#test');
    expect(row.metadata).toMatchObject({ botname: 'myhub', message: 'hello' });
    close();
  });

  it('.bannounce writes a row with the message in metadata', async () => {
    const { db, close } = setup();
    const handler = new CommandHandler();
    registerBotlinkCommands({ handler, hub: null, leaf: null, config: hubConfig(), db });
    await handler.execute('.bannounce hello everyone', makeCtx([]));
    const [row] = db.getModLog({ action: 'bannounce' });
    expect(row).toBeDefined();
    expect(row.metadata).toEqual({ message: 'hello everyone' });
    close();
  });
});
