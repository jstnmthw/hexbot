import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import type { CommandContext } from '../../src/command-handler';
import { BotLinkHub, BotLinkLeaf } from '../../src/core/botlink';
import { Permissions } from '../../src/core/permissions';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';
import {
  TEST_LINK_SALT,
  answerHelloChallenge,
  createMockSocket,
  parseWritten,
  pushFrame,
  testLinkKey,
} from '../helpers/mock-socket';

// Memoize deriveLinkKey across the file. scryptSync (~50ms) runs on every
// BotLinkHub/Leaf construction; a single (password, salt) pair is reused
// across tests, so caching collapses repeated KDF cost. vi.mock is hoisted
// before any production import.
vi.mock('../../src/core/botlink/protocol', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/botlink/protocol')>(
    '../../src/core/botlink/protocol',
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

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const PASSWORD = 'relay-test-secret';
const TEST_LINK_KEY = testLinkKey(PASSWORD);

function hubConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'hub',
    listen: { host: '127.0.0.1', port: 15051 },
    password: PASSWORD,
    link_salt: TEST_LINK_SALT,
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
  };
}

function leafConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'leaf',
    botname: 'leaf1',
    hub: { host: '127.0.0.1', port: 15051 },
    password: PASSWORD,
    link_salt: TEST_LINK_SALT,
    reconnect_delay_ms: 100,
    reconnect_max_delay_ms: 1000,
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
  };
}

/** Connect a hub and leaf via mock sockets, complete handshake. */
async function setupLinkedPair(): Promise<{
  hub: BotLinkHub;
  leaf: BotLinkLeaf;
  hubSocket: { written: string[]; duplex: Duplex };
  leafSocket: { written: string[]; duplex: Duplex };
  hubPerms: Permissions;
  leafPerms: Permissions;
  hubHandler: CommandHandler;
  leafHandler: CommandHandler;
  eventBus: BotEventBus;
}> {
  const eventBus = new BotEventBus();
  const hubPerms = new Permissions(null, null, eventBus);
  const leafPerms = new Permissions();
  const hubHandler = new CommandHandler(hubPerms);
  const leafHandler = new CommandHandler(leafPerms);

  // Register a test command with relayToHub
  const registerTestCmd = (handler: CommandHandler, perms: Permissions) => {
    handler.registerCommand(
      'adduser',
      {
        flags: '+n',
        description: 'Add user',
        usage: '.adduser <handle> <hostmask> <flags>',
        category: 'test',
        relayToHub: true,
      },
      (args, ctx) => {
        const [handle, hostmask, flags] = args.split(/\s+/);
        perms.addUser(handle, hostmask, flags, ctx.nick);
        ctx.reply(`User "${handle}" added`);
      },
    );

    handler.registerCommand(
      'localcmd',
      { flags: '-', description: 'Local only', usage: '.localcmd', category: 'test' },
      (_args, ctx) => {
        ctx.reply('local executed');
      },
    );
  };

  registerTestCmd(hubHandler, hubPerms);
  registerTestCmd(leafHandler, leafPerms);

  // Add owner user to both
  hubPerms.addUser('admin', '*!admin@host.com', 'nmov');
  leafPerms.addUser('admin', '*!admin@host.com', 'nmov');

  const hub = new BotLinkHub(hubConfig(), '1.0.0');
  const leaf = new BotLinkLeaf(leafConfig(), '1.0.0');

  // Wire command relay
  hub.setCommandRelay(hubHandler, hubPerms, eventBus);
  leaf.setCommandRelay(leafHandler, leafPerms);

  // Connect via mock sockets
  const { socket: hubSock, written: hubWritten, duplex: hubDuplex } = createMockSocket();
  hub.addConnection(hubSock);
  // Hub has already written HELLO_CHALLENGE synchronously; leaf answers.
  answerHelloChallenge(hubWritten, hubDuplex, TEST_LINK_KEY, 'leaf1');
  await tick();

  const { socket: leafSock, written: leafWritten, duplex: leafDuplex } = createMockSocket();
  leaf.connectWithSocket(leafSock);
  // Leaf waits for HELLO_CHALLENGE from hub before it will send HELLO.
  // The mock doesn't validate the HMAC on the leaf's write — we just need
  // a syntactically valid nonce so leaf.ts computes and sends HELLO.
  pushFrame(leafDuplex, {
    type: 'HELLO_CHALLENGE',
    nonce: 'a'.repeat(64),
    hubBotname: 'hub',
  });
  await tick();
  pushFrame(leafDuplex, { type: 'WELCOME', botname: 'hub', version: '1.0' });
  await tick();

  // Register admin's party line session on the hub (required for CMD session verification)
  pushFrame(hubDuplex, { type: 'PARTY_JOIN', handle: 'admin', fromBot: 'leaf1' });
  await tick();

  // Clear handshake frames
  hubWritten.length = 0;
  leafWritten.length = 0;

  return {
    hub,
    leaf,
    hubSocket: { written: hubWritten, duplex: hubDuplex },
    leafSocket: { written: leafWritten, duplex: leafDuplex },
    hubPerms,
    leafPerms,
    hubHandler,
    leafHandler,
    eventBus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Command relay', () => {
  describe('pre-execute hook', () => {
    it('relayToHub commands are intercepted when leaf is connected', async () => {
      const { leaf, leafSocket, hub } = await setupLinkedPair();
      const replies: string[] = [];

      // Execute .adduser on the leaf (via DCC-like context)
      const leafPromise = leafHandler_execute(leaf, '.adduser newuser *!n@h o', replies);

      // The leaf should have sent a CMD frame to the hub
      await tick();
      const leafSent = parseWritten(leafSocket.written);
      const cmdFrame = leafSent.find((f) => f.type === 'CMD');
      expect(cmdFrame).toBeDefined();
      expect(cmdFrame!.command).toBe('adduser');
      expect(cmdFrame!.args).toBe('newuser *!n@h o');
      expect(cmdFrame!.fromHandle).toBe('admin');

      // Simulate hub processing: push CMD_RESULT back to leaf
      pushFrame(leafSocket.duplex, {
        type: 'CMD_RESULT',
        ref: String(cmdFrame!.ref),
        output: ['User "newuser" added'],
      });
      await tick();

      await leafPromise;
      expect(replies).toEqual(['User "newuser" added']);

      hub.close();
      leaf.disconnect();
    });

    it('non-relayToHub commands execute locally', async () => {
      const { leafHandler, hub, leaf } = await setupLinkedPair();
      const replies: string[] = [];

      const ctx: CommandContext = {
        source: 'dcc',
        nick: 'admin',
        ident: 'admin',
        hostname: 'host.com',
        channel: null,
        reply: (msg) => replies.push(msg),
      };

      await leafHandler.execute('.localcmd', ctx);
      expect(replies).toEqual(['local executed']);

      hub.close();
      leaf.disconnect();
    });
  });

  describe('hub CMD handling', () => {
    it('executes relayed command and sends CMD_RESULT', async () => {
      const { hub, hubSocket, hubPerms } = await setupLinkedPair();

      // Send a CMD frame as if from leaf
      pushFrame(hubSocket.duplex, {
        type: 'CMD',
        command: 'adduser',
        args: 'newuser *!new@host.com o',
        fromHandle: 'admin',
        fromBot: 'leaf1',
        channel: null,
        ref: 'test-ref-1',
      });
      await tick();
      // Give the async handler time to complete
      await tick();

      // Hub should send CMD_RESULT back
      const hubSent = parseWritten(hubSocket.written);
      const result = hubSent.find((f) => f.type === 'CMD_RESULT');
      expect(result).toBeDefined();
      expect(result!.ref).toBe('test-ref-1');
      expect(result!.output).toContain('User "newuser" added');

      // User should exist on the hub
      expect(hubPerms.getUser('newuser')).not.toBeNull();

      hub.close();
    });

    it('rejects CMD from handle without active session', async () => {
      const { hub, hubSocket } = await setupLinkedPair();

      pushFrame(hubSocket.duplex, {
        type: 'CMD',
        command: 'adduser',
        args: 'someone *!s@h o',
        fromHandle: 'nonexistent',
        fromBot: 'leaf1',
        channel: null,
        ref: 'ref-deny',
      });
      await tick();
      await tick();

      const result = parseWritten(hubSocket.written).find((f) => f.type === 'CMD_RESULT');
      expect(result).toBeDefined();
      expect((result!.output as string[])[0]).toMatch(/No active session/);

      hub.close();
    });

    it('rejects CMD when user lacks required flags', async () => {
      const { hub, hubSocket, hubPerms } = await setupLinkedPair();

      // Add a user with only 'v' flag (insufficient for .adduser which needs +n)
      hubPerms.addUser('viewer', '*!v@host', 'v');
      // Register their party line session
      pushFrame(hubSocket.duplex, { type: 'PARTY_JOIN', handle: 'viewer', fromBot: 'leaf1' });
      await tick();
      hubSocket.written.length = 0;

      pushFrame(hubSocket.duplex, {
        type: 'CMD',
        command: 'adduser',
        args: 'someone *!s@h o',
        fromHandle: 'viewer',
        fromBot: 'leaf1',
        channel: null,
        ref: 'ref-noflags',
      });
      await tick();
      await tick();

      const result = parseWritten(hubSocket.written).find((f) => f.type === 'CMD_RESULT');
      expect(result!.output).toContain('Permission denied.');

      hub.close();
    });
  });

  describe('permission event broadcasting', () => {
    it('broadcasts DELUSER when a user is removed on the hub', async () => {
      const { hub, hubSocket, hubPerms } = await setupLinkedPair();
      hubPerms.addUser('temp', '*!t@h', 'v');
      hubSocket.written.length = 0;

      hubPerms.removeUser('temp', 'admin');
      await tick();

      const frames = parseWritten(hubSocket.written);
      const delFrame = frames.find((f) => f.type === 'DELUSER');
      expect(delFrame).toBeDefined();
      expect(delFrame!.handle).toBe('temp');

      hub.close();
    });

    it('broadcasts SETFLAGS when flags change on the hub', async () => {
      const { hub, hubSocket, hubPerms } = await setupLinkedPair();
      hubSocket.written.length = 0;

      hubPerms.setGlobalFlags('admin', 'nm', 'admin');
      await tick();

      const frames = parseWritten(hubSocket.written);
      const flagsFrame = frames.find((f) => f.type === 'SETFLAGS');
      expect(flagsFrame).toBeDefined();
      expect(flagsFrame!.handle).toBe('admin');
      expect(flagsFrame!.globalFlags).toBe('nm');

      hub.close();
    });
  });
});

// Helper to execute a command on the leaf through its handler
async function leafHandler_execute(
  leaf: BotLinkLeaf,
  cmd: string,
  replies: string[],
): Promise<void> {
  // We need to get the command handler from the leaf. Since we can't access it directly,
  // let's create a fresh one and wire it up.
  const perms = new Permissions();
  perms.addUser('admin', '*!admin@host.com', 'nmov');

  const handler = new CommandHandler(perms);
  handler.registerCommand(
    'adduser',
    {
      flags: '+n',
      description: 'Add user',
      usage: '.adduser <handle> <hostmask> <flags>',
      category: 'test',
      relayToHub: true,
    },
    (_args, ctx) => {
      ctx.reply('should not execute locally');
    },
  );
  leaf.setCommandRelay(handler, perms);

  const ctx: CommandContext = {
    source: 'dcc',
    nick: 'admin',
    ident: 'admin',
    hostname: 'host.com',
    channel: null,
    reply: (msg) => replies.push(msg),
  };

  await handler.execute(cmd, ctx);
}
