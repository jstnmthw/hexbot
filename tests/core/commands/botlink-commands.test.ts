import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../../src/command-handler';
import type { CommandContext } from '../../../src/command-handler';
import { BotLinkHub, BotLinkLeaf, hashPassword } from '../../../src/core/botlink';
import type { LinkFrame } from '../../../src/core/botlink';
import { registerBotlinkCommands } from '../../../src/core/commands/botlink-commands';
import type { BotlinkConfig } from '../../../src/types';

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
    listen: { host: '0.0.0.0', port: 5051 },
    password: 'secret',
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
  };
}

function leafConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'leaf',
    botname: 'myleaf',
    hub: { host: '127.0.0.1', port: 5051 },
    password: 'secret',
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
    reconnect_delay_ms: 600_000,
  };
}

function createMockSocket(): Socket & { written: string[] } {
  const written: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  (socket as unknown as { written: string[] }).written = written;
  return socket as unknown as Socket & { written: string[] };
}

function pushFrame(socket: Socket, frame: LinkFrame): void {
  (socket as unknown as Duplex).push(JSON.stringify(frame) + '\r\n');
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function parseWritten(written: string[]): LinkFrame[] {
  const frames: LinkFrame[] = [];
  for (const chunk of written) {
    for (const line of chunk.split('\r\n')) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return frames;
}

/**
 * Connect a leaf to a mock socket and complete the handshake.
 * Returns the connected leaf and the socket.
 */
async function connectLeaf(
  cfg?: BotlinkConfig,
): Promise<{ leaf: BotLinkLeaf; socket: Socket & { written: string[] } }> {
  const leaf = new BotLinkLeaf(cfg ?? leafConfig(), '1.0.0');
  const socket = createMockSocket();
  leaf.connectWithSocket(socket);
  pushFrame(socket, { type: 'WELCOME', botname: 'thehub', version: '1.0' });
  await tick();
  return { leaf, socket };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('botlink commands', () => {
  describe('when botlink is disabled', () => {
    it('.botlink status says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, null, null);
      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('.bots says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, null, null);
      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('.bottree says disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, null, null);
      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));
      expect(replies[0]).toBe('Bot link is not enabled.');
    });
  });

  describe('hub mode', () => {
    it('.botlink status shows hub info with no leaves', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('hub');
      expect(replies[0]).toContain('myhub');
      expect(replies[1]).toBe('No leaves connected.');

      hub.close();
    });

    it('.bots lists the hub bot', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('myhub (hub, this bot)');

      hub.close();
    });

    it('.bottree shows the hub as root', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toBe('myhub (hub)');

      hub.close();
    });

    it('.botlink disconnect requires a botname', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      await handler.execute('.botlink disconnect', makeCtx(replies));

      expect(replies[0]).toContain('Usage');

      hub.close();
    });

    it('.botlink reconnect is hub-only error', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

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
      leafSocket: Socket & { written: string[] };
    }> {
      hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      // Simulate a leaf connecting through the hub
      const leafSocket = createMockSocket();
      hub.addConnection(leafSocket);
      pushFrame(leafSocket, {
        type: 'HELLO',
        botname: 'leaf1',
        password: (await import('../../../src/core/botlink')).hashPassword('secret'),
        version: '1.0',
      });
      await tick();

      return { hub, handler, leafSocket };
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

    it('.botlink disconnect with valid leaf sends ERROR frame', async () => {
      const { handler, leafSocket } = await hubWithLeaf();
      const replies: string[] = [];
      await handler.execute('.botlink disconnect leaf1', makeCtx(replies));

      expect(replies[0]).toBe('Disconnecting "leaf1".');
      // Verify an ERROR frame was sent to the leaf
      const sent = leafSocket.written.join('');
      expect(sent).toContain('CLOSING');
      expect(sent).toContain('Disconnected by admin');
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
      registerBotlinkCommands(handler, null, leaf, cfg);

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
      registerBotlinkCommands(handler, null, leaf, cfg);

      const replies: string[] = [];
      await handler.execute('.botlink reconnect', makeCtx(replies));

      expect(replies[0]).toBe('Reconnecting to hub...');

      leaf.disconnect();
    });

    it('.botlink disconnect says hub-only on leaf', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, leaf, leafConfig());

      const replies: string[] = [];
      await handler.execute('.botlink disconnect leaf1', makeCtx(replies));

      expect(replies[0]).toBe('Only available on hub bots.');

      leaf.disconnect();
    });

    it('.bots on connected leaf shows hub and self', async () => {
      const { leaf } = await connectLeaf();
      const handler = new CommandHandler();
      const cfg = leafConfig();
      registerBotlinkCommands(handler, null, leaf, cfg);

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
      registerBotlinkCommands(handler, null, leaf, cfg);

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
      registerBotlinkCommands(handler, null, leaf, leafConfig());

      const replies: string[] = [];
      await handler.execute('.botlink status', makeCtx(replies));

      expect(replies[0]).toContain('leaf');
      expect(replies[0]).toContain('myleaf');
      expect(replies[1]).toContain('disconnected');
    });

    it('.bots on disconnected leaf shows self as disconnected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, leaf, leafConfig());

      const replies: string[] = [];
      await handler.execute('.bots', makeCtx(replies));

      expect(replies[0]).toContain('myleaf (leaf, disconnected)');
    });

    it('.bottree on disconnected leaf shows self as disconnected', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, leaf, leafConfig());

      const replies: string[] = [];
      await handler.execute('.bottree', makeCtx(replies));

      expect(replies[0]).toContain('myleaf (leaf, disconnected)');
    });
  });

  describe('.relay command', () => {
    it('says not enabled when botlink is disabled', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, null, null);
      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies));

      expect(replies[0]).toBe('Bot link is not enabled.');
    });

    it('shows usage when no target is given', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      await handler.execute('.relay', makeCtx(replies));

      expect(replies[0]).toBe('Usage: .relay <botname>');

      hub.close();
    });

    it('rejects from non-DCC source (repl)', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

      const replies: string[] = [];
      // repl source bypasses permission check, but then the handler checks ctx.source !== 'dcc'
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'repl' }));

      expect(replies[0]).toBe('.relay is only available from DCC sessions.');

      hub.close();
    });

    it('says DCC not enabled when dccManager is null (from DCC source)', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      // Provide a permissive permissions provider so the DCC source passes the flag check
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      registerBotlinkCommands(handler, hub, null, hubConfig(), null);

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toBe('DCC is not enabled.');

      hub.close();
    });
  });

  describe('.relay DCC integration', () => {
    it('session not found returns error', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => undefined,
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, hub, null, hubConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Could not find your DCC session.');
      hub.close();
    });

    it('already relaying returns error', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockSession = { handle: 'admin', isRelaying: true, enterRelay: vi.fn() };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, hub, null, hubConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Already relaying. Use .relay end first.');
      hub.close();
    });

    it('hub mode: target bot not connected returns error', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: vi.fn() };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, hub, null, hubConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay nobot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Bot "nobot" is not connected.');
      hub.close();
    });

    it('hub mode: sends relay request and enters relay mode', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      // Connect a leaf so it's a valid target
      const leafSocket = createMockSocket();
      hub.addConnection(leafSocket);
      pushFrame(leafSocket, {
        type: 'HELLO',
        botname: 'leaf1',
        password: hashPassword('secret'),
        version: '1',
      });
      await tick();
      leafSocket.written.length = 0;

      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const enterRelayFn = vi.fn();
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: enterRelayFn };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, hub, null, hubConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay leaf1', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toContain('Relaying to leaf1');
      expect(enterRelayFn).toHaveBeenCalledWith('leaf1', expect.any(Function));
      hub.close();
    });

    it('leaf mode: sends relay request via leaf', async () => {
      const { leaf, socket } = await connectLeaf();
      socket.written.length = 0;

      const allowAll = { checkFlags: () => true };
      const handler = new CommandHandler(allowAll);
      const enterRelayFn = vi.fn();
      const mockSession = { handle: 'admin', isRelaying: false, enterRelay: enterRelayFn };
      const mockDcc = {
        getSessionList: () => [],
        getSession: () => mockSession,
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, null, leaf, leafConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));

      expect(replies[0]).toContain('Relaying to somebot');
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
      } as unknown as import('../../../src/core/dcc').DCCManager;
      registerBotlinkCommands(handler, null, null, hubConfig(), mockDcc);

      const replies: string[] = [];
      await handler.execute('.relay somebot', makeCtx(replies, { source: 'dcc' }));
      expect(replies[0]).toBe('Not connected to any bot link.');
    });
  });

  describe('.whom command — leaf with hub', () => {
    it('leaf requests whom from hub when connected', async () => {
      const { leaf, socket } = await connectLeaf();
      socket.written.length = 0;

      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, leaf, leafConfig());

      const promise = handler.execute('.whom', makeCtx([]));
      await tick();

      // Leaf should have sent PARTY_WHOM
      const sent = parseWritten(socket.written);
      const whom = sent.find((f: LinkFrame) => f.type === 'PARTY_WHOM');
      expect(whom).toBeDefined();

      // Respond with a user
      pushFrame(socket, {
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
    it('reports no users when DCC is not available and no link', async () => {
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, null, { ...hubConfig(), enabled: true });

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');
    });

    it('reports no users when hub has no remote party users and no DCC', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig(), null);

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');

      hub.close();
    });

    it('reports no users when leaf is disconnected and no DCC', async () => {
      const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, null, leaf, leafConfig(), null);

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toBe('No users on the console.');
    });

    it('lists local DCC users via mock dccManager', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      const mockDcc = {
        getSessionList: () => [
          { handle: 'alice', nick: 'Alice', connectedAt: Date.now() - 10_000 },
        ],
        getSession: () => undefined,
      };
      registerBotlinkCommands(
        handler,
        hub,
        null,
        hubConfig(),
        mockDcc as unknown as import('../../../src/core/dcc').DCCManager,
      );

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
      registerBotlinkCommands(
        handler,
        null,
        null,
        hubConfig(),
        mockDcc as unknown as import('../../../src/core/dcc').DCCManager,
      );

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
      registerBotlinkCommands(
        handler,
        null,
        null,
        hubConfig(),
        mockDcc as unknown as import('../../../src/core/dcc').DCCManager,
      );

      const replies: string[] = [];
      await handler.execute('.whom', makeCtx(replies));

      expect(replies[0]).toContain('Console (2 users):');
    });
  });

  describe('unknown subcommand', () => {
    it('.botlink foo shows usage', async () => {
      const hub = new BotLinkHub(hubConfig(), '1.0.0');
      const handler = new CommandHandler();
      registerBotlinkCommands(handler, hub, null, hubConfig());

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
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const handler = new CommandHandler();
    registerBotlinkCommands(handler, hub, null, hubConfig());

    const replies: string[] = [];
    await handler.execute('.botlink', makeCtx(replies));
    expect(replies[0]).toContain('hub');
    hub.close();
  });

  it('.bottree with multiple leaves shows ├─ and └─ prefixes', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    const s1 = createMockSocket();
    hub.addConnection(s1);
    pushFrame(s1, {
      type: 'HELLO',
      botname: 'leaf1',
      password: hashPassword('secret'),
      version: '1',
    });
    await tick();
    const s2 = createMockSocket();
    hub.addConnection(s2);
    pushFrame(s2, {
      type: 'HELLO',
      botname: 'leaf2',
      password: hashPassword('secret'),
      version: '1',
    });
    await tick();

    const handler = new CommandHandler();
    registerBotlinkCommands(handler, hub, null, hubConfig());
    const replies: string[] = [];
    await handler.execute('.bottree', makeCtx(replies));
    expect(replies[0]).toContain('├─ leaf1');
    expect(replies[0]).toContain('└─ leaf2');
    hub.close();
  });

  it('.whom shows idle time when idle > 0', async () => {
    const hub = new BotLinkHub(hubConfig(), '1.0.0');
    // Inject a remote party user with idle time
    const socket = createMockSocket();
    hub.addConnection(socket);
    pushFrame(socket, {
      type: 'HELLO',
      botname: 'leaf1',
      password: hashPassword('secret'),
      version: '1',
    });
    await tick();
    pushFrame(socket, { type: 'PARTY_JOIN', handle: 'idler', nick: 'Idler', fromBot: 'leaf1' });
    await tick();

    // Manually set idle on the remote user (hack for testing)
    const remoteUsers = hub.getRemotePartyUsers();
    if (remoteUsers.length > 0) remoteUsers[0].idle = 120;

    const handler = new CommandHandler();
    registerBotlinkCommands(handler, hub, null, hubConfig());
    const replies: string[] = [];
    await handler.execute('.whom', makeCtx(replies));
    expect(replies[0]).toContain('idle 120s');
    hub.close();
  });
});
