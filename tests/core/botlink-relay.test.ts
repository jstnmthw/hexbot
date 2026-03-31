import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import type { CommandContext } from '../../src/command-handler';
import { BotLinkHub, BotLinkLeaf, hashPassword } from '../../src/core/botlink';
import type { LinkFrame } from '../../src/core/botlink';
import { Permissions } from '../../src/core/permissions';
import { BotEventBus } from '../../src/event-bus';
import type { BotlinkConfig } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const PASSWORD = 'relay-test-secret';
const HASH = hashPassword(PASSWORD);

function hubConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'hub',
    botname: 'hub',
    listen: { host: '0.0.0.0', port: 5051 },
    password: PASSWORD,
    ping_interval_ms: 600_000,
    link_timeout_ms: 600_000,
  };
}

function leafConfig(): BotlinkConfig {
  return {
    enabled: true,
    role: 'leaf',
    botname: 'leaf1',
    hub: { host: '127.0.0.1', port: 5051 },
    password: PASSWORD,
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
  hubSocket: Socket & { written: string[] };
  leafSocket: Socket & { written: string[] };
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
  const hubSocket = createMockSocket();
  hub.addConnection(hubSocket);
  pushFrame(hubSocket, { type: 'HELLO', botname: 'leaf1', password: HASH, version: '1.0' });
  await tick();

  const leafSocket = createMockSocket();
  leaf.connectWithSocket(leafSocket);
  pushFrame(leafSocket, { type: 'WELCOME', botname: 'hub', version: '1.0' });
  await tick();

  // Clear handshake frames
  hubSocket.written.length = 0;
  leafSocket.written.length = 0;

  return {
    hub,
    leaf,
    hubSocket,
    leafSocket,
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
      pushFrame(leafSocket, {
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
      pushFrame(hubSocket, {
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

    it('rejects CMD from unknown user handle', async () => {
      const { hub, hubSocket } = await setupLinkedPair();

      pushFrame(hubSocket, {
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
      expect(result!.output).toContain('Permission denied.');

      hub.close();
    });

    it('rejects CMD when user lacks required flags', async () => {
      const { hub, hubSocket, hubPerms } = await setupLinkedPair();

      // Add a user with only 'v' flag (insufficient for .adduser which needs +n)
      hubPerms.addUser('viewer', '*!v@host', 'v');

      pushFrame(hubSocket, {
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
